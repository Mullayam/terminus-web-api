import { z } from "zod";
import { AgentSessionRegistry } from "../session-registry";
import { AgentEventKind } from "../protocol";
import { classifyCommand } from "./danger";
import { execCapture, sftpReadFile, sftpWriteFile, sftpList } from "../utils/ssh-ops";
import { ok, fail, type ToolDefinition } from "./context";

const listSessions: ToolDefinition = {
  name: "list_sessions",
  description:
    "List the ids of all active terminal (SSH) sessions the agent can operate on. Call this first when no session is given.",
  inputSchema: {},
  async execute() {
    const ids = AgentSessionRegistry.list();
    return ok(ids.length ? ids.join("\n") : "No active sessions.", ids);
  },
};

const getSessionInfo: ToolDefinition = {
  name: "get_session_info",
  description: "Get metadata about a specific terminal session by its id.",
  inputSchema: {
    sessionId: z.string().describe("The terminal session id."),
  },
  async execute(args) {
    const session = AgentSessionRegistry.get(args.sessionId);
    if (!session) return fail(`No active terminal session: ${args.sessionId}`);
    return ok(
      JSON.stringify({ sessionId: session.sessionId, readyAt: session.readyAt }),
      { sessionId: session.sessionId, readyAt: session.readyAt },
    );
  },
};

const runCommand: ToolDefinition = {
  name: "run_command",
  description:
    "Run a shell command inside the user's live interactive terminal session. The command is written into the PTY so it is visible to everyone in the session, inheriting the shell's working directory and environment. Dangerous commands require the user's confirmation before running.",
  inputSchema: {
    sessionId: z.string().describe("The terminal session id to run the command in."),
    command: z.string().describe("The exact shell command to execute."),
    timeoutMs: z.number().int().positive().optional().describe("Max time to wait for output in ms."),
  },
  async execute(args, ctx) {
    const { sessionId, command } = args;
    if (!AgentSessionRegistry.has(sessionId)) return fail(`No active terminal session: ${sessionId}`);

    const verdict = classifyCommand(command);
    if (verdict.level !== "safe") {
      const level = verdict.level;
      const needsConfirm = level === "blocked" || !ctx.autoMode;
      if (needsConfirm) {
        ctx.emit(AgentEventKind.DANGEROUS, { sessionId, command, reason: verdict.reason, level });
        const approved = await ctx.confirm({ command, reason: verdict.reason, level });
        if (!approved) {
          return fail(`User denied the ${level} command (${verdict.reason}): ${command}`);
        }
      }
    }

    ctx.emit(AgentEventKind.COMMAND, { sessionId, command });
    const result = await AgentSessionRegistry.runInPty(sessionId, command, args.timeoutMs);
    ctx.emit(AgentEventKind.OUTPUT, {
      sessionId,
      command,
      output: result.output,
      exitCode: result.exitCode,
      timedOut: result.timedOut,
    });

    const header = result.timedOut ? "(timed out waiting for completion) " : "";
    return ok(`${header}exit=${result.exitCode}\n${result.output}`, result);
  },
};

const readFile: ToolDefinition = {
  name: "read_file",
  description: "Read the contents of a file on the remote host of a terminal session.",
  inputSchema: {
    sessionId: z.string().describe("The terminal session id."),
    path: z.string().describe("Absolute or relative path of the file to read."),
  },
  async execute(args) {
    const session = AgentSessionRegistry.get(args.sessionId);
    if (!session) return fail(`No active terminal session: ${args.sessionId}`);
    try {
      const content = await sftpReadFile(session.client, args.path);
      return ok(content, { path: args.path });
    } catch (err: any) {
      return fail(`Failed to read ${args.path}: ${err.message}`);
    }
  },
};

const writeFile: ToolDefinition = {
  name: "write_file",
  description: "Write (create or overwrite) a file on the remote host of a terminal session.",
  inputSchema: {
    sessionId: z.string().describe("The terminal session id."),
    path: z.string().describe("Absolute or relative path of the file to write."),
    content: z.string().describe("The full contents to write to the file."),
  },
  async execute(args, ctx) {
    const session = AgentSessionRegistry.get(args.sessionId);
    if (!session) return fail(`No active terminal session: ${args.sessionId}`);
    ctx.emit(AgentEventKind.EXECUTE_TASK, { sessionId: args.sessionId, task: `write ${args.path}` });
    try {
      await sftpWriteFile(session.client, args.path, args.content);
      return ok(`Wrote ${args.content.length} bytes to ${args.path}`, { path: args.path });
    } catch (err: any) {
      return fail(`Failed to write ${args.path}: ${err.message}`);
    }
  },
};

const listDir: ToolDefinition = {
  name: "list_dir",
  description: "List the entries of a directory on the remote host of a terminal session.",
  inputSchema: {
    sessionId: z.string().describe("The terminal session id."),
    path: z.string().describe("Directory path to list."),
  },
  async execute(args) {
    const session = AgentSessionRegistry.get(args.sessionId);
    if (!session) return fail(`No active terminal session: ${args.sessionId}`);
    try {
      const entries = await sftpList(session.client, args.path);
      return ok(entries.join("\n"), entries);
    } catch (err: any) {
      return fail(`Failed to list ${args.path}: ${err.message}`);
    }
  },
};

const statPath: ToolDefinition = {
  name: "stat_path",
  description: "Check whether a path exists on the remote host and show its stat details.",
  inputSchema: {
    sessionId: z.string().describe("The terminal session id."),
    path: z.string().describe("Path to stat."),
  },
  async execute(args) {
    const session = AgentSessionRegistry.get(args.sessionId);
    if (!session) return fail(`No active terminal session: ${args.sessionId}`);
    const result = await execCapture(session.client, `stat -- "${args.path}" 2>&1 || echo "NOT_FOUND"`);
    return ok(result.stdout.trim(), { code: result.code });
  },
};

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  listSessions,
  getSessionInfo,
  runCommand,
  readFile,
  writeFile,
  listDir,
  statPath,
];
