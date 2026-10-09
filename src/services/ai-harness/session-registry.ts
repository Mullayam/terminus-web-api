import type { Client, ClientChannel } from "ssh2";
import { Logging } from "@enjoys/express-utils/logger";
import { stripAnsi, stripSentinels } from "./utils/stripper";
import { buildSentinelMarks, buildPtyCommand } from "./utils/builder";
import { buildEndMatcher, sliceAfterStart, sliceBeforeEnd } from "./utils/parser";

export interface AgentSession {
  sessionId: string;
  client: Client;
  stream: ClientChannel;
  readyAt: number;
}

export interface PtyRunResult {
  output: string;
  exitCode: number | null;
  timedOut: boolean;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_PENDING_BUFFER = 8192;

class Registry {
  private sessions = new Map<string, AgentSession>();
  private activeRuns = new Map<string, () => void>();

  register(sessionId: string, client: Client, stream: ClientChannel): void {
    this.sessions.set(sessionId, { sessionId, client, stream, readyAt: Date.now() });
    Logging.dev(`Agent session registered: ${sessionId}`);
  }

  unregister(sessionId: string): void {
    if (this.sessions.delete(sessionId)) {
      Logging.dev(`Agent session unregistered: ${sessionId}`);
    }
  }

  has(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  get(sessionId: string): AgentSession | undefined {
    return this.sessions.get(sessionId);
  }

  list(): string[] {
    return [...this.sessions.keys()];
  }

  writeToPty(sessionId: string, data: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    session.stream.write(data);
    return true;
  }

  interrupt(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) session.stream.write("\x03");
    this.activeRuns.get(sessionId)?.();
  }

  runInPty(
    sessionId: string,
    command: string,
    timeoutMs: number = DEFAULT_TIMEOUT_MS,
  ): Promise<PtyRunResult> {
    return new Promise((resolve, reject) => {
      const session = this.sessions.get(sessionId);
      if (!session) {
        reject(new Error(`No active terminal session: ${sessionId}`));
        return;
      }

      const marks = buildSentinelMarks();
      const endRe = buildEndMatcher(marks.endMark);
      const stream = session.stream;

      let buffer = "";
      let capturing = false;
      let settled = false;

      const finish = (result: PtyRunResult) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.activeRuns.delete(sessionId);
        stream.removeListener("data", onData);
        resolve(result);
      };

      const onData = (chunk: Buffer) => {
        buffer += stripAnsi(chunk.toString("utf-8"));

        if (!capturing) {
          const { found, rest } = sliceAfterStart(buffer, marks.startMark);
          if (!found) {
            if (buffer.length > MAX_PENDING_BUFFER) buffer = buffer.slice(-MAX_PENDING_BUFFER / 2);
            return;
          }
          buffer = rest;
          capturing = true;
        }

        const match = buffer.match(endRe);
        if (match) {
          finish({
            output: stripSentinels(sliceBeforeEnd(buffer, marks.endMark), marks.token),
            exitCode: Number(match[1]),
            timedOut: false,
          });
        }
      };

      const timer = setTimeout(() => {
        finish({
          output: stripSentinels(buffer, marks.token),
          exitCode: null,
          timedOut: true,
        });
      }, timeoutMs);

      this.activeRuns.set(sessionId, () =>
        finish({ output: stripSentinels(buffer, marks.token), exitCode: null, timedOut: true }),
      );

      stream.on("data", onData);
      stream.write(buildPtyCommand(command, marks));
    });
  }
}

export const AgentSessionRegistry = new Registry();
