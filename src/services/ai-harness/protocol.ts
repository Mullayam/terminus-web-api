export enum AgentEventKind {
  MESSAGE = "MESSAGE",
  COMMAND = "COMMAND",
  EXECUTE_TASK = "EXECUTE_TASK",
  DANGEROUS = "DANGEROUS",
  OUTPUT = "OUTPUT",
  TOOL = "TOOL",
  ERROR = "ERROR",
  DONE = "DONE",
}

export enum AgentSocketEvent {
  PROMPT = "@@AI_AGENT_PROMPT",
  ABORT = "@@AI_AGENT_ABORT",
  CONFIRM_REPLY = "@@AI_AGENT_CONFIRM_REPLY",
  EVENT = "@@AI_AGENT_EVENT",
  CONFIRM_REQUEST = "@@AI_AGENT_CONFIRM_REQUEST",
}

export interface AgentEvent {
  kind: AgentEventKind;
  tag: string;
  sessionId?: string;
  payload: Record<string, unknown>;
  ts: number;
}

export interface ConfirmRequest {
  confirmId: string;
  sessionId: string;
  command: string;
  reason: string;
  level: "confirm" | "blocked";
}

export interface ConfirmReply {
  confirmId: string;
  approved: boolean;
}

export function tagOf(kind: AgentEventKind): string {
  return `[${kind}]`;
}

export function buildEvent(
  kind: AgentEventKind,
  payload: Record<string, unknown>,
  sessionId?: string,
): AgentEvent {
  return { kind, tag: tagOf(kind), sessionId, payload, ts: Date.now() };
}
