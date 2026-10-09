import type { z } from "zod";
import type { AgentEventKind } from "../protocol";

export interface DangerPrompt {
  command: string;
  reason: string;
  level: "confirm" | "blocked";
}

export interface ToolContext {
  sessionId?: string;
  autoMode: boolean;
  emit(kind: AgentEventKind, payload: Record<string, unknown>): void;
  confirm(prompt: DangerPrompt): Promise<boolean>;
}

export interface ToolResult {
  ok: boolean;
  content: string;
  data?: unknown;
}

export interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodRawShape;
  execute(args: Record<string, any>, ctx: ToolContext): Promise<ToolResult>;
}

export function ok(content: string, data?: unknown): ToolResult {
  return { ok: true, content, data };
}

export function fail(content: string): ToolResult {
  return { ok: false, content };
}
