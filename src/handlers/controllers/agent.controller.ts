import { Request, Response } from "express";
import {
  runAgent,
  runAgentsParallel,
  submitToolResult,
  toSSE,
  DEFAULT_TOOL_TIMEOUT_MS,
  type AgentEvent,
  type MultiAgentTask,
} from "../../services/agent/agent";
import { PROFILES, type ProfileId } from "../../services/agent/profiles";
import type { ThinkingMode } from "../../services/agent/router";
import type { ToolCapableProvider } from "../../services/ai";

interface RunBody {
  input?: string;
  profile?: ProfileId;
  mode?: ThinkingMode;
  providerId?: string;
  history?: Array<{ role: string; content: string }>;
  context?: string;
  maxSteps?: number;
  toolTimeoutMs?: number;
  autoApproveMedium?: boolean;
  denyDangerous?: boolean;
  /** Run several agents concurrently over the same input */
  agents?: Array<{ name?: string; profile: ProfileId; input?: string; mode?: ThinkingMode }>;
}

const VALID_MODES: ThinkingMode[] = ["auto", "fast", "thinking"];

function sseHeaders(res: Response) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();
}

class AgentController {
  /**
   * POST /api/agent/run
   *
   * Streams the agent loop as SSE. The backend never executes commands: it emits
   * `tool_call` events and waits for the client to POST results to /api/agent/result.
   *
   * Events: status | routing | plan | chunk | tool_call | tool_result | final | error | done
   */
  async run(req: Request, res: Response) {
    const body = (req.body ?? {}) as RunBody;

    if (!body.input || typeof body.input !== "string") {
      res.status(400).json({ success: false, message: "input is required." });
      return;
    }
    if (body.profile && !PROFILES[body.profile]) {
      res.status(400).json({
        success: false,
        message: `Unknown profile "${body.profile}". Valid: ${Object.keys(PROFILES).join(", ")}`,
      });
      return;
    }
    if (body.mode && !VALID_MODES.includes(body.mode)) {
      res.status(400).json({
        success: false,
        message: `Unknown mode "${body.mode}". Valid: ${VALID_MODES.join(", ")}`,
      });
      return;
    }
    const badAgent = body.agents?.find((a) => !PROFILES[a.profile]);
    if (badAgent) {
      res.status(400).json({
        success: false,
        message: `Unknown profile "${badAgent.profile}" in agents[].`,
      });
      return;
    }

    const shared = {
      history: body.history,
      context: body.context,
      provider: body.providerId as ToolCapableProvider | undefined,
      maxSteps: body.maxSteps,
      toolTimeoutMs: body.toolTimeoutMs,
      policy: {
        autoApproveMedium: body.autoApproveMedium ?? false,
        denyDangerous: body.denyDangerous ?? false,
      },
    };

    sseHeaders(res);
    const abort = new AbortController();
    // `req` emits "close" as soon as body-parser drains it, so only `res` is a
    // reliable signal that the client actually went away.
    res.on("close", () => abort.abort());

    const stream: AsyncGenerator<AgentEvent, void, unknown> = body.agents?.length
      ? runAgentsParallel(
          body.agents.map<MultiAgentTask>((a) => ({
            ...shared,
            name: a.name ?? a.profile,
            profile: a.profile,
            mode: a.mode ?? body.mode,
            input: a.input ?? body.input!,
          })),
          abort.signal,
        )
      : runAgent({
          ...shared,
          input: body.input,
          profile: body.profile,
          mode: body.mode,
          signal: abort.signal,
        });

    try {
      for await (const event of stream) {
        if (abort.signal.aborted) break;
        res.write(toSSE(event));
      }
      if (!abort.signal.aborted) res.write(toSSE({ agent: "system", type: "done" }));
    } catch (err: any) {
      res.write(
        toSSE({ agent: "system", type: "error", message: err?.message ?? "Agent run failed." }),
      );
    } finally {
      res.end();
    }
  }

  /**
   * POST /api/agent/result
   * Body: { callId, output, exitCode?, declined? }
   *
   * The client posts back the output of a command it ran for a `tool_call` event.
   */
  result(req: Request, res: Response) {
    const { callId, output, exitCode, declined } = (req.body ?? {}) as {
      callId?: string;
      output?: string;
      exitCode?: number;
      declined?: boolean;
    };

    if (!callId || typeof callId !== "string") {
      res.status(400).json({ success: false, message: "callId is required." });
      return;
    }
    if (typeof output !== "string" && !declined) {
      res.status(400).json({ success: false, message: "output must be a string." });
      return;
    }

    const accepted = submitToolResult(callId, {
      output: output ?? "User declined to run this command.",
      exitCode,
      declined,
    });

    if (!accepted) {
      res.status(404).json({
        success: false,
        message: "Unknown callId, or the agent already timed out waiting for it.",
      });
      return;
    }

    res.status(200).json({ success: true });
  }

  /** GET /api/agent/profiles — available profiles, modes, and timeout contract. */
  profiles(_req: Request, res: Response) {
    res.status(200).json({
      success: true,
      data: {
        profiles: Object.values(PROFILES).map((p) => ({
          id: p.id,
          label: p.label,
          tools: p.tools,
        })),
        modes: VALID_MODES,
        defaultToolTimeoutMs: DEFAULT_TOOL_TIMEOUT_MS,
      },
    });
  }
}

export default new AgentController();
