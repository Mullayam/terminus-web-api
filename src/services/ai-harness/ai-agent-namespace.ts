import type { Socket } from "socket.io";
import { Logging } from "@enjoys/express-utils/logger";
import { AgentBus } from "./agent-bus";
import { AgentHarness } from "./opencode/harness";
import { AgentEventKind, AgentSocketEvent, type ConfirmReply } from "./protocol";

interface PromptPayload {
  sessionId: string;
  prompt: string;
  model?: string;
}

export class AiAgentNamespace {
  constructor(private readonly socket: Socket) {
    this.register();
  }

  private register(): void {
    this.socket.on(AgentSocketEvent.PROMPT, (payload: PromptPayload) => this.onPrompt(payload));
    this.socket.on(AgentSocketEvent.CONFIRM_REPLY, (payload: ConfirmReply) => this.onConfirmReply(payload));
    this.socket.on(AgentSocketEvent.ABORT, (payload: { sessionId: string }) => this.onAbort(payload));
    this.socket.on("disconnect", () => AgentBus.detachAll(this.socket));
  }

  private async onPrompt(payload: PromptPayload): Promise<void> {
    if (!payload?.sessionId || !payload?.prompt) {
      AgentBus.emit(payload?.sessionId, AgentEventKind.ERROR, { error: "sessionId and prompt are required" });
      return;
    }

    AgentBus.attach(payload.sessionId, this.socket);
    try {
      await AgentHarness.prompt(payload.sessionId, payload.prompt, payload.model);
    } catch (err: any) {
      Logging.dev(`AI agent prompt error: ${err.message}`, "error");
      AgentBus.emit(payload.sessionId, AgentEventKind.ERROR, { error: err.message });
    }
  }

  private onConfirmReply(payload: ConfirmReply): void {
    if (!payload?.confirmId) return;
    AgentBus.reply(payload.confirmId, !!payload.approved);
  }

  private async onAbort(payload: { sessionId: string }): Promise<void> {
    if (!payload?.sessionId) return;
    try {
      await AgentHarness.abort(payload.sessionId);
    } catch (err: any) {
      Logging.dev(`AI agent abort error: ${err.message}`, "error");
    }
  }
}
