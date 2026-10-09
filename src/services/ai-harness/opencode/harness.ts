import type { OpencodeClient } from "@opencode-ai/sdk";
import { Logging } from "@enjoys/express-utils/logger";
import { getOpencodeClient } from "./server";
import { AgentBus } from "../agent-bus";
import { AgentSessionRegistry } from "../session-registry";
import { AgentSettingsStore } from "../agent-settings";
import { AgentEventKind } from "../protocol";

interface OpencodeStreamEvent {
  type: string;
  properties?: {
    sessionID?: string;
    info?: { sessionID?: string };
    part?: { type?: string; text?: string; sessionID?: string };
    error?: unknown;
  };
}

interface ModelRef {
  providerID: string;
  modelID: string;
}

function buildSessionContext(terminalSessionId: string): string {
  return `Active terminal session id: "${terminalSessionId}". Pass this exact value as the "sessionId" argument to every terminus tool.`;
}

function parseModelRef(model?: string): ModelRef | undefined {
  if (!model) return undefined;
  const [providerID, ...rest] = model.split("/");
  if (!providerID || rest.length === 0) return undefined;
  return { providerID, modelID: rest.join("/") };
}

class Harness {
  private mcpUrl = "";
  private subscribed = false;
  private terminalByOpencode = new Map<string, string>();
  private opencodeByTerminal = new Map<string, string>();

  configure(mcpUrl: string): void {
    this.mcpUrl = mcpUrl;
  }

  private async ensureSubscribed(client: OpencodeClient): Promise<void> {
    if (this.subscribed) return;
    this.subscribed = true;

    const events = await client.event.subscribe();
    const stream = events.stream as AsyncIterable<OpencodeStreamEvent>;
    void this.consume(stream);
  }

  private async consume(stream: AsyncIterable<OpencodeStreamEvent>): Promise<void> {
    try {
      for await (const event of stream) {
        this.route(event);
      }
    } catch (err) {
      Logging.dev(`opencode event stream error: ${(err as Error).message}`, "error");
      this.subscribed = false;
    }
  }

  private route(event: OpencodeStreamEvent): void {
    const props = event.properties ?? {};
    const ocSession = props.sessionID ?? props.info?.sessionID ?? props.part?.sessionID;
    if (!ocSession) return;

    const terminalId = this.terminalByOpencode.get(ocSession);
    if (!terminalId) return;

    if (event.type === "message.part.updated" && props.part?.type === "text" && props.part.text) {
      AgentBus.emit(terminalId, AgentEventKind.MESSAGE, { text: props.part.text });
      return;
    }
    if (event.type === "session.idle") {
      AgentBus.emit(terminalId, AgentEventKind.DONE, {});
      return;
    }
    if (event.type === "session.error") {
      AgentBus.emit(terminalId, AgentEventKind.ERROR, { error: props.error ?? null });
    }
  }

  private async ensureSession(client: OpencodeClient, terminalSessionId: string): Promise<string> {
    const existing = this.opencodeByTerminal.get(terminalSessionId);
    if (existing) return existing;

    const created = await client.session.create({ body: { title: `terminal:${terminalSessionId}` } });
    const id = created.data?.id;
    if (!id) throw new Error("opencode did not return a session id");

    this.opencodeByTerminal.set(terminalSessionId, id);
    this.terminalByOpencode.set(id, terminalSessionId);
    return id;
  }

  async prompt(terminalSessionId: string, text: string, model?: string): Promise<void> {
    const client = await getOpencodeClient(this.mcpUrl);
    await this.ensureSubscribed(client);
    const sessionId = await this.ensureSession(client, terminalSessionId);

    const parts = [
      { type: "text" as const, text: buildSessionContext(terminalSessionId) },
      { type: "text" as const, text },
    ];

    const modelRef = parseModelRef(model ?? AgentSettingsStore.get(terminalSessionId).model);

    await client.session.promptAsync({
      path: { id: sessionId },
      body: modelRef ? { parts, model: modelRef } : { parts },
    });
  }

  async abort(terminalSessionId: string): Promise<void> {
    AgentSessionRegistry.interrupt(terminalSessionId);
    AgentBus.cancelPending(terminalSessionId);

    const sessionId = this.opencodeByTerminal.get(terminalSessionId);
    if (sessionId) {
      const client = await getOpencodeClient(this.mcpUrl);
      await client.session.abort({ path: { id: sessionId } }).catch(() => undefined);
    }

    AgentBus.emit(terminalSessionId, AgentEventKind.DONE, { stopped: true });
  }

  release(terminalSessionId: string): void {
    const sessionId = this.opencodeByTerminal.get(terminalSessionId);
    if (sessionId) this.terminalByOpencode.delete(sessionId);
    this.opencodeByTerminal.delete(terminalSessionId);
  }
}

export const AgentHarness = new Harness();
