import { randomUUID } from "crypto";
import { Logging } from "@enjoys/express-utils/logger";
import { aiService, type AiChatMessage, type ToolCapableProvider } from "../ai";
import { AgentContext } from "./context";
import { classify, selectModel, type Classification, type ThinkingMode } from "./router";
import { resolveCall, toolDefinitions, type ResolvedCall } from "./tools";
import type { PolicyOptions, RiskAssessment } from "./security";
import { PROFILES, inferProfile, type ProfileId } from "./profiles";

// ─── Events ───────────────────────────────────────────────────────────────────

export interface AgentEventBase {
  /** Which agent emitted this, for multi-agent runs */
  agent: string;
}

export type AgentEvent = AgentEventBase &
  (
    | { type: "status"; message: string }
    | { type: "routing"; provider: string; model: string; tier: string; profile: ProfileId; complexity: string; signals: string[] }
    | { type: "plan"; steps: string[] }
    | { type: "chunk"; text: string }
    | {
        type: "tool_call";
        callId: string;
        name: string;
        command?: string;
        purpose?: string;
        risk?: RiskAssessment["risk"];
        requiresApproval?: boolean;
        reason?: string;
        /** Milliseconds the backend will wait for the client to post a result */
        timeoutMs: number;
      }
    | { type: "tool_result"; callId: string; name: string; ok: boolean; declined?: boolean; output: string }
    | { type: "final"; text: string }
    | { type: "error"; message: string }
    | { type: "done" }
  );

// ─── Client execution channel ─────────────────────────────────────────────────

export interface ClientToolResult {
  output: string;
  exitCode?: number;
  /** The user refused to run the command */
  declined?: boolean;
}

interface PendingCall {
  resolve: (r: ClientToolResult) => void;
  timer: NodeJS.Timeout;
}

const pendingCalls = new Map<string, PendingCall>();

/** Default wait for the UI to execute a command and post the output back. */
export const DEFAULT_TOOL_TIMEOUT_MS = 15_000;

/** Called by the HTTP layer when the UI posts a tool result. */
export function submitToolResult(callId: string, result: ClientToolResult): boolean {
  const pending = pendingCalls.get(callId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  pendingCalls.delete(callId);
  pending.resolve(result);
  return true;
}

function awaitClientResult(callId: string, timeoutMs: number): Promise<ClientToolResult> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pendingCalls.delete(callId);
      resolve({ output: `No result received from the client within ${timeoutMs}ms.`, declined: true });
    }, timeoutMs);
    pendingCalls.set(callId, { resolve, timer });
  });
}

function cancelPending(callIds: string[]) {
  for (const id of callIds) {
    const pending = pendingCalls.get(id);
    if (pending) {
      clearTimeout(pending.timer);
      pendingCalls.delete(id);
    }
  }
}

// ─── Run options ──────────────────────────────────────────────────────────────

export interface AgentRunOptions {
  input: string;
  /** Label used in events; defaults to the profile id */
  name?: string;
  profile?: ProfileId;
  mode?: ThinkingMode;
  history?: Array<{ role: string; content: string }>;
  provider?: ToolCapableProvider;
  policy?: PolicyOptions;
  maxSteps?: number;
  toolTimeoutMs?: number;
  /** Extra context from the client, e.g. current terminal buffer */
  context?: string;
  signal?: AbortSignal;
}

const PLANNER_PROMPT = `Break the request into a short ordered investigation plan.
Reply with 2-5 numbered steps, one line each. No prose before or after.
Each step must be a concrete thing to check or do.`;

const MAX_TOOL_TIMEOUT_MS = 20_000;

async function buildPlan(
  input: string,
  classification: Classification,
  cfg: { provider?: ToolCapableProvider; mode?: ThinkingMode; coding?: boolean },
): Promise<string[]> {
  const route = selectModel("planning", classification, cfg);
  const gen = aiService.streamWithTools({
    provider: route.provider,
    model: route.model,
    temperature: 0.2,
    maxTokens: 400,
    messages: [
      { role: "system", content: PLANNER_PROMPT },
      { role: "user", content: input },
    ],
  });

  let r = await gen.next();
  while (!r.done) r = await gen.next();

  return r.value.text
    .split("\n")
    .map((l) => l.replace(/^\s*\d+[.)]\s*/, "").trim())
    .filter(Boolean)
    .slice(0, 6);
}

/** Run one turn, walking the model fallback chain if a provider errors. */
async function* turnWithFallback(
  route: ReturnType<typeof selectModel>,
  messages: AiChatMessage[],
  tools: ReturnType<typeof toolDefinitions>,
) {
  const candidates = [{ provider: route.provider, model: route.model }, ...route.fallbacks];
  let lastError: string | undefined;

  for (const candidate of candidates) {
    try {
      const gen = aiService.streamWithTools({
        provider: candidate.provider,
        model: candidate.model,
        messages,
        tools: tools.length ? tools : undefined,
      });
      let r = await gen.next();
      // Once tokens are flowing, a mid-stream failure cannot be retried elsewhere.
      while (!r.done) {
        yield { kind: "chunk" as const, text: r.value };
        r = await gen.next();
      }
      yield { kind: "done" as const, turn: r.value };
      return;
    } catch (err: any) {
      lastError = err?.message ?? String(err);
      Logging.dev(
        `[agent] ${candidate.provider}/${candidate.model} failed (${lastError}), trying next`,
        "notice",
      );
    }
  }
  throw new Error(lastError ?? "All candidate models failed.");
}

// ─── Agent loop ───────────────────────────────────────────────────────────────

export async function* runAgent(opts: AgentRunOptions): AsyncGenerator<AgentEvent, void, unknown> {
  const profileId = opts.profile ?? inferProfile(opts.input);
  const profile = PROFILES[profileId];
  const agent = opts.name ?? profileId;
  const maxSteps = Math.min(opts.maxSteps ?? 12, 25);
  const toolTimeoutMs = Math.min(opts.toolTimeoutMs ?? DEFAULT_TOOL_TIMEOUT_MS, MAX_TOOL_TIMEOUT_MS);
  const policy = opts.policy ?? {};
  const routerCfg = { provider: opts.provider, mode: opts.mode, coding: profile.coding };

  const classification = classify(opts.input);
  yield { agent, type: "status", message: "Analyzing request" };

  const route = selectModel("tool-selection", classification, routerCfg);
  yield {
    agent,
    type: "routing",
    provider: route.provider,
    model: route.model,
    tier: route.tier,
    profile: profileId,
    complexity: classification.complexity,
    signals: classification.signals,
  };

  const context = new AgentContext(profile.system);
  if (opts.context) {
    context.remember(`Client-supplied context:\n${opts.context.slice(0, 4000)}`);
  }
  for (const m of opts.history ?? []) {
    if ((m.role === "user" || m.role === "assistant") && m.content) {
      context.push({ role: m.role, content: m.content });
    }
  }

  const wantsPlan =
    profile.tools.length > 0 &&
    (opts.mode === "thinking" || (opts.mode !== "fast" && classification.complexity === "hard"));

  if (wantsPlan) {
    yield { agent, type: "status", message: "Planning investigation" };
    try {
      const steps = await buildPlan(opts.input, classification, routerCfg);
      if (steps.length) {
        yield { agent, type: "plan", steps };
        context.remember(`Plan: ${steps.join(" → ")}`);
      }
    } catch (err: any) {
      Logging.dev(`[agent] Planning failed: ${err?.message}`, "notice");
    }
  }

  context.push({ role: "user", content: opts.input });
  const tools = toolDefinitions(profile.tools);

  for (let step = 0; step < maxSteps; step++) {
    if (opts.signal?.aborted) return;

    const phase = step === 0 ? "tool-selection" : "observation";
    const stepRoute = selectModel(phase, classification, routerCfg);

    let turn;
    try {
      for await (const ev of turnWithFallback(stepRoute, context.build(), tools)) {
        if (ev.kind === "chunk") yield { agent, type: "chunk", text: ev.text };
        else turn = ev.turn;
      }
    } catch (err: any) {
      yield { agent, type: "error", message: err?.message ?? String(err) };
      return;
    }

    if (!turn || !turn.toolCalls.length) {
      yield { agent, type: "final", text: turn?.text ?? "" };
      return;
    }

    const resolved: ResolvedCall[] = turn.toolCalls.map((c) => resolveCall(c, policy));

    context.push({
      role: "assistant",
      content: turn.text,
      tool_calls: turn.toolCalls.map((c) => ({
        id: c.id,
        type: "function" as const,
        function: { name: c.name, arguments: JSON.stringify(c.arguments) },
      })),
    });

    // Hand every call to the client at once so it can run them in parallel.
    const waiting: Array<{ call: ResolvedCall; promise: Promise<ClientToolResult> }> = [];

    for (const call of resolved) {
      if (call.error || !call.command) {
        yield {
          agent,
          type: "tool_result",
          callId: call.id,
          name: call.name,
          ok: false,
          output: call.error ?? "Tool produced no command.",
        };
        context.push({ role: "tool", tool_call_id: call.id, content: call.error ?? "No command." });
        continue;
      }

      if (call.assessment?.risk === "blocked") {
        const msg = `Blocked by policy: ${call.assessment.reason}`;
        yield { agent, type: "tool_result", callId: call.id, name: call.name, ok: false, declined: true, output: msg };
        context.push({ role: "tool", tool_call_id: call.id, content: msg });
        continue;
      }

      yield {
        agent,
        type: "tool_call",
        callId: call.id,
        name: call.name,
        command: call.command,
        purpose: call.purpose,
        risk: call.assessment?.risk,
        requiresApproval: call.assessment?.requiresApproval,
        reason: call.assessment?.reason,
        timeoutMs: toolTimeoutMs,
      };

      waiting.push({ call, promise: awaitClientResult(call.id, toolTimeoutMs) });
    }

    if (opts.signal?.aborted) {
      cancelPending(waiting.map((w) => w.call.id));
      return;
    }

    const settled = await Promise.all(waiting.map((w) => w.promise));

    // Context is appended in call order first, then the same order goes on the wire.
    const resultEvents: AgentEvent[] = settled.map((result, i) => {
      const { call } = waiting[i];
      const ok = !result.declined && (result.exitCode === undefined || result.exitCode === 0);
      const output = result.output?.trim() || "(no output)";
      context.push({ role: "tool", tool_call_id: call.id, content: output.slice(0, 12_000) });
      return {
        agent,
        type: "tool_result",
        callId: call.id,
        name: call.name,
        ok,
        declined: result.declined,
        output,
      };
    });

    for (const ev of resultEvents) yield ev;
  }

  yield {
    agent,
    type: "error",
    message: `Maximum agent steps (${maxSteps}) reached without a final answer.`,
  };
}

// ─── Multi-agent ──────────────────────────────────────────────────────────────

export interface MultiAgentTask extends Omit<AgentRunOptions, "signal"> {
  name: string;
}

/**
 * Run several agents concurrently, interleaving their events as they arrive.
 * Each event carries its `agent` name so the UI can route it to the right pane.
 */
export async function* runAgentsParallel(
  tasks: MultiAgentTask[],
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent, void, unknown> {
  const queue: AgentEvent[] = [];
  let notify: (() => void) | null = null;
  let active = tasks.length;

  const wake = () => {
    notify?.();
    notify = null;
  };

  for (const task of tasks) {
    void (async () => {
      try {
        for await (const ev of runAgent({ ...task, signal })) {
          queue.push(ev);
          wake();
        }
      } catch (err: any) {
        queue.push({ agent: task.name, type: "error", message: err?.message ?? String(err) });
      } finally {
        queue.push({ agent: task.name, type: "done" });
        active--;
        wake();
      }
    })();
  }

  while (active > 0 || queue.length) {
    if (!queue.length) {
      await new Promise<void>((resolve) => {
        notify = resolve;
      });
      continue;
    }
    yield queue.shift()!;
  }
}

/** Serialise an agent event to the SSE wire format. */
export function toSSE(event: AgentEvent): string {
  const { type, ...data } = event;
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}
