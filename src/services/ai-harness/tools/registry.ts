import { TOOL_DEFINITIONS } from "./definitions";
import type { ToolDefinition } from "./context";

const byName = new Map<string, ToolDefinition>(TOOL_DEFINITIONS.map((t) => [t.name, t]));

export function listTools(): ToolDefinition[] {
  return TOOL_DEFINITIONS;
}

export function getTool(name: string): ToolDefinition | undefined {
  return byName.get(name);
}
