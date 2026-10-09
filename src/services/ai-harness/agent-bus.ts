import type { Socket } from "socket.io";
import { randomUUID } from "crypto";
import {
  AgentEventKind,
  AgentSocketEvent,
  buildEvent,
  type ConfirmRequest,
} from "./protocol";
import type { ToolContext, DangerPrompt } from "./tools/context";
import { AgentSettingsStore } from "./agent-settings";

interface Pending {
  sessionId: string;
  resolve(approved: boolean): void;
  timer: ReturnType<typeof setTimeout>;
}

const CONFIRM_TIMEOUT_MS = 120_000;

class Bus {
  private sockets = new Map<string, Set<Socket>>();
  private socketSessions = new Map<Socket, Set<string>>();
  private pending = new Map<string, Pending>();

  attach(sessionId: string, socket: Socket): void {
    let set = this.sockets.get(sessionId);
    if (!set) {
      set = new Set();
      this.sockets.set(sessionId, set);
    }
    set.add(socket);

    let owned = this.socketSessions.get(socket);
    if (!owned) {
      owned = new Set();
      this.socketSessions.set(socket, owned);
    }
    owned.add(sessionId);
  }

  detach(sessionId: string, socket: Socket): void {
    this.sockets.get(sessionId)?.delete(socket);
    if (this.sockets.get(sessionId)?.size === 0) this.sockets.delete(sessionId);
    this.socketSessions.get(socket)?.delete(sessionId);
  }

  detachAll(socket: Socket): void {
    const owned = this.socketSessions.get(socket);
    if (!owned) return;
    for (const sessionId of owned) {
      this.sockets.get(sessionId)?.delete(socket);
      if (this.sockets.get(sessionId)?.size === 0) this.sockets.delete(sessionId);
    }
    this.socketSessions.delete(socket);
  }

  emit(sessionId: string | undefined, kind: AgentEventKind, payload: Record<string, unknown>): void {
    if (!sessionId) return;
    const targets = this.sockets.get(sessionId);
    if (!targets) return;
    const event = buildEvent(kind, payload, sessionId);
    for (const socket of targets) socket.emit(AgentSocketEvent.EVENT, event);
  }

  confirm(sessionId: string, prompt: DangerPrompt): Promise<boolean> {
    const targets = this.sockets.get(sessionId);
    if (!targets || targets.size === 0) return Promise.resolve(false);

    const confirmId = randomUUID();
    const request: ConfirmRequest = {
      confirmId,
      sessionId,
      command: prompt.command,
      reason: prompt.reason,
      level: prompt.level,
    };

    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(confirmId);
        resolve(false);
      }, CONFIRM_TIMEOUT_MS);

      this.pending.set(confirmId, { sessionId, resolve, timer });
      for (const socket of targets) socket.emit(AgentSocketEvent.CONFIRM_REQUEST, request);
    });
  }

  reply(confirmId: string, approved: boolean): void {
    const pending = this.pending.get(confirmId);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(confirmId);
    pending.resolve(approved);
  }

  cancelPending(sessionId: string): void {
    for (const [confirmId, pending] of this.pending) {
      if (pending.sessionId !== sessionId) continue;
      clearTimeout(pending.timer);
      this.pending.delete(confirmId);
      pending.resolve(false);
    }
  }

  contextFor(sessionId?: string): ToolContext {
    const autoMode = sessionId ? AgentSettingsStore.get(sessionId).autoMode : false;
    return {
      sessionId,
      autoMode,
      emit: (kind, payload) => this.emit(sessionId, kind, payload),
      confirm: (prompt) => (sessionId ? this.confirm(sessionId, prompt) : Promise.resolve(false)),
    };
  }
}

export const AgentBus = new Bus();
