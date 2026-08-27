import type { AiToolDefinition } from "../ai";
import { assessCommand, type PolicyOptions, type RiskAssessment } from "./security";

/**
 * Tool declarations only.
 *
 * The backend never executes anything: it resolves a tool call into a concrete
 * command, annotates it with a risk verdict, and hands it to the UI. The UI
 * runs it over its own terminal session and posts the output back.
 */

export type ToolKind = "command" | "file" | "container" | "code";

export interface ToolSpec {
  definition: AiToolDefinition;
  kind: ToolKind;
  /** Resolves call arguments into the shell command the UI should run. */
  toCommand: (args: Record<string, any>) => string;
}

function q(value: unknown): string {
  return `'${String(value ?? "").replace(/'/g, `'\\''`)}'`;
}

const SPECS: ToolSpec[] = [
  {
    kind: "command",
    toCommand: (a) => String(a.command ?? ""),
    definition: {
      name: "run_command",
      description:
        "Run a shell command on the user's terminal session and return its output. " +
        "Prefer read-only inspection. Destructive commands are surfaced to the user for approval and may be declined.",
      parameters: {
        type: "object",
        properties: {
          command: { type: "string", description: "The exact shell command to execute" },
          purpose: { type: "string", description: "One short sentence on why this is needed" },
        },
        required: ["command"],
      },
    },
  },
  {
    kind: "file",
    toCommand: (a) =>
      a.max_lines ? `tail -n ${Number(a.max_lines)} ${q(a.path)}` : `cat ${q(a.path)}`,
    definition: {
      name: "read_file",
      description: "Read a file on the host. Use max_lines for large logs.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path" },
          max_lines: { type: "number", description: "Read only the last N lines" },
        },
        required: ["path"],
      },
    },
  },
  {
    kind: "file",
    toCommand: (a) => `ls -la ${q(a.path)}`,
    definition: {
      name: "list_dir",
      description: "List the contents of a directory.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "Absolute directory path" } },
        required: ["path"],
      },
    },
  },
  {
    kind: "file",
    toCommand: (a) =>
      `grep -rn --color=never ${q(a.pattern)} ${q(a.path ?? ".")} | head -n ${Number(a.limit ?? 60)}`,
    definition: {
      name: "search_files",
      description: "Recursively search file contents for a pattern.",
      parameters: {
        type: "object",
        properties: {
          pattern: { type: "string", description: "Text or regex to search for" },
          path: { type: "string", description: "Directory to search (default current)" },
          limit: { type: "number", description: "Max matching lines (default 60)" },
        },
        required: ["pattern"],
      },
    },
  },
  {
    kind: "command",
    toCommand: (a) => `systemctl status ${q(a.name)} --no-pager`,
    definition: {
      name: "service_status",
      description: "Check the status of a systemd service.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Service name, e.g. nginx" } },
        required: ["name"],
      },
    },
  },
  {
    kind: "command",
    toCommand: (a) =>
      `journalctl -u ${q(a.unit)} -n ${Number(a.lines ?? 100)} --no-pager`,
    definition: {
      name: "service_logs",
      description: "Read recent journald logs for a systemd unit.",
      parameters: {
        type: "object",
        properties: {
          unit: { type: "string", description: "Unit name, e.g. nginx" },
          lines: { type: "number", description: "Trailing lines (default 100)" },
        },
        required: ["unit"],
      },
    },
  },
  {
    kind: "container",
    toCommand: (a) => `docker ps${a.all ? " -a" : ""}`,
    definition: {
      name: "docker_ps",
      description: "List Docker containers.",
      parameters: {
        type: "object",
        properties: { all: { type: "boolean", description: "Include stopped containers" } },
      },
    },
  },
  {
    kind: "container",
    toCommand: (a) => `docker logs --tail ${Number(a.tail ?? 100)} ${q(a.container)}`,
    definition: {
      name: "docker_logs",
      description: "Fetch recent logs for a Docker container.",
      parameters: {
        type: "object",
        properties: {
          container: { type: "string", description: "Container name or ID" },
          tail: { type: "number", description: "Trailing lines (default 100)" },
        },
        required: ["container"],
      },
    },
  },
  {
    kind: "command",
    toCommand: () => `ps aux --sort=-%cpu | head -n 20`,
    definition: {
      name: "top_processes",
      description: "Show the processes consuming the most CPU.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    kind: "command",
    toCommand: () => `df -h; echo '---'; free -h`,
    definition: {
      name: "resource_usage",
      description: "Show disk and memory usage.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    kind: "code",
    toCommand: (a) =>
      `cat > ${q(a.path)} <<'TERMINUS_EOF'\n${String(a.content ?? "")}\nTERMINUS_EOF`,
    definition: {
      name: "write_file",
      description:
        "Write or overwrite a file with the given content. Always read the file first if it already exists.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "Absolute path" },
          content: { type: "string", description: "Full new file content" },
        },
        required: ["path", "content"],
      },
    },
  },
];

export const TOOLS: Record<string, ToolSpec> = Object.fromEntries(
  SPECS.map((s) => [s.definition.name, s]),
);

export function toolDefinitions(names?: string[]): AiToolDefinition[] {
  const specs = names ? names.map((n) => TOOLS[n]).filter(Boolean) : SPECS;
  return specs.map((s) => s.definition);
}

export interface ResolvedCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
  command?: string;
  assessment?: RiskAssessment;
  purpose?: string;
  error?: string;
}

/** Turn a model tool call into a concrete, risk-annotated command for the UI. */
export function resolveCall(
  call: { id: string; name: string; arguments: Record<string, any> },
  policy: PolicyOptions = {},
): ResolvedCall {
  const spec = TOOLS[call.name];
  if (!spec) {
    return { ...call, error: `Unknown tool "${call.name}".` };
  }
  try {
    const command = spec.toCommand(call.arguments);
    return {
      ...call,
      command,
      assessment: assessCommand(command, policy),
      purpose: typeof call.arguments.purpose === "string" ? call.arguments.purpose : undefined,
    };
  } catch (err: any) {
    return { ...call, error: `Could not build command: ${err?.message ?? String(err)}` };
  }
}
