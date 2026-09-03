import * as fs from "fs";
import * as path from "path";
import { spawn, ChildProcess } from "child_process";
import { Logging } from "@enjoys/express-utils/logger";
import { __CONFIG__ } from "../../utils/constant";
import { ensureBinary } from "./binary";
import type { CodeiumMetadata, CompanionState } from "./types";

const RPC_SERVICE = "exa.language_server_pb.LanguageServerService";

/** How long a completion may wait on the RPC before we give up (§2.1: 10s client). */
const RPC_TIMEOUT_MS = 10_000;
const HEARTBEAT_INTERVAL_MS = 5_000;
const PORT_POLL_INTERVAL_MS = 500;
const PORT_DISCOVERY_TIMEOUT_MS = 30_000;
/** A port file is only trusted if written recently (§3.3). */
const PORT_FILE_MAX_AGE_MS = 5_000;
const RESTART_BACKOFF_MIN_MS = 1_000;
const RESTART_BACKOFF_MAX_MS = 30_000;

export interface ManagerOptions {
  /** Builds metadata for heartbeat/status. May return null before any key exists. */
  buildMetadata: () => Promise<CodeiumMetadata | null>;
}

/**
 * Owns the native language-server child process: acquisition, launch, port
 * discovery, heartbeat, supervision, and the localhost RPC transport (spec §3).
 *
 * One instance serves every user; the api_key is passed per request in
 * metadata, never at launch (§3.5).
 */
export class LanguageServerManager {
  private state: CompanionState = { phase: "disabled" };
  private child: ChildProcess | null = null;
  private port: number | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private restartTimer: NodeJS.Timeout | null = null;
  private backoffMs = RESTART_BACKOFF_MIN_MS;
  private stopping = false;
  private restartCount = 0;

  constructor(private readonly options: ManagerOptions) {}

  getState(): CompanionState {
    return this.state;
  }

  getPort(): number | null {
    return this.port;
  }

  isReady(): boolean {
    return this.state.phase === "ready" && this.port !== null;
  }

  get restarts(): number {
    return this.restartCount;
  }

  /**
   * Acquires the binary, launches it, discovers the RPC port, and starts
   * supervision. Failures land in a `failed` state rather than throwing into
   * the request path, so completions degrade to empty instead of hanging (§3.3).
   */
  async start(): Promise<void> {
    if (!__CONFIG__.CODEIUM.ENABLED) {
      this.state = { phase: "disabled" };
      return;
    }
    this.stopping = false;

    try {
      this.state = { phase: "downloading" };
      const binaryPath = await ensureBinary();

      this.state = { phase: "starting" };
      await this.launch(binaryPath);
    } catch (err) {
      const reason = err instanceof Error ? err.message : "unknown";
      this.state = { phase: "failed", reason };
      Logging.dev(`[codeium] Failed to start language server: ${reason}`, "error");
    }
  }

  private async launch(binaryPath: string): Promise<void> {
    const managerDir = __CONFIG__.CODEIUM.MANAGER_DIR;
    fs.mkdirSync(managerDir, { recursive: true });
    // A stale port file from a previous run must not be mistaken for this one.
    this.clearManagerDir(managerDir);

    // No indexing / chat flags: our files are remote over SFTP, so local
    // indexing burns CPU for nothing and chat opens extra listeners (§3.2).
    const args = [
      "--api_server_url",
      __CONFIG__.CODEIUM.API_SERVER_URL,
      "--manager_dir",
      managerDir,
    ];

    Logging.dev(`[codeium] Spawning ${binaryPath} ${args.join(" ")}`, "notice");
    const child = spawn(binaryPath, args, { stdio: ["ignore", "pipe", "pipe"] });
    this.child = child;

    // Auth and quota failures surface on stderr, not in HTTP status (§9).
    child.stdout?.on("data", (d) => Logging.dev(`[codeium:ls] ${String(d).trim()}`));
    child.stderr?.on("data", (d) => Logging.dev(`[codeium:ls] ${String(d).trim()}`));
    child.on("exit", (code, signal) => this.onExit(code, signal));
    child.on("error", (err) =>
      Logging.dev(`[codeium] Child process error: ${err.message}`, "error"),
    );

    const port = await this.discoverPort(managerDir);
    this.port = port;
    this.state = { phase: "ready", port };
    this.backoffMs = RESTART_BACKOFF_MIN_MS;
    Logging.dev(`[codeium] Language server ready on 127.0.0.1:${port}`, "notice");

    void this.reportStatus();
    this.startHeartbeat();
  }

  /** Removes any numeric port files left behind by a prior process. */
  private clearManagerDir(managerDir: string): void {
    try {
      for (const entry of fs.readdirSync(managerDir)) {
        if (/^\d+$/.test(entry)) {
          fs.rmSync(path.join(managerDir, entry), { force: true });
        }
      }
    } catch {
      /* directory just created or unreadable — nothing to clear */
    }
  }

  /**
   * The server writes a file into manager_dir whose name is the RPC port (§3.3).
   * Polls until a fresh one appears, then hard-fails after the timeout so a
   * broken launch does not hang every request.
   */
  private discoverPort(managerDir: string): Promise<number> {
    return new Promise((resolve, reject) => {
      const deadline = Date.now() + PORT_DISCOVERY_TIMEOUT_MS;

      const poll = () => {
        if (this.stopping) return reject(new Error("stopped during port discovery"));

        try {
          for (const entry of fs.readdirSync(managerDir)) {
            if (!/^\d+$/.test(entry)) continue;
            const full = path.join(managerDir, entry);
            const stat = fs.statSync(full);
            if (stat.isFile() && Date.now() - stat.mtimeMs <= PORT_FILE_MAX_AGE_MS) {
              return resolve(parseInt(entry, 10));
            }
          }
        } catch {
          /* transient readdir error while the server writes — keep polling */
        }

        if (Date.now() >= deadline) {
          this.killChild();
          return reject(new Error("port discovery timed out after 30s"));
        }
        setTimeout(poll, PORT_POLL_INTERVAL_MS);
      };

      poll();
    });
  }

  /**
   * Connect-style RPC: protobuf-as-JSON over localhost. Never proxy arbitrary
   * method names from the browser (§10) — callers pass a fixed method constant.
   */
  async rpc<T>(method: string, body: unknown, timeoutMs = RPC_TIMEOUT_MS): Promise<T> {
    if (this.port === null) throw new Error("language server not ready");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(
        `http://127.0.0.1:${this.port}/${RPC_SERVICE}/${method}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: controller.signal,
        },
      );
      // Error responses can carry a `code` body even on non-2xx; return the JSON
      // so callers can inspect it (§5.4) rather than throwing on status alone.
      const text = await res.text();
      return (text ? JSON.parse(text) : {}) as T;
    } finally {
      clearTimeout(timer);
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      void this.sendHeartbeat();
    }, HEARTBEAT_INTERVAL_MS);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  private async sendHeartbeat(): Promise<void> {
    if (!this.isReady()) return;
    try {
      const metadata = await this.options.buildMetadata();
      if (!metadata) return; // no key yet; the server tolerates gaps briefly
      await this.rpc("Heartbeat", { metadata }, 5_000);
    } catch (err) {
      Logging.dev(`[codeium] Heartbeat failed: ${(err as Error).message}`, "notice");
    }
  }

  /** One-shot GetStatus after port discovery; logs the plain-text status (§3.4). */
  private async reportStatus(): Promise<void> {
    try {
      const metadata = await this.options.buildMetadata();
      if (!metadata) return;
      const status = await this.rpc<{ status?: { message?: string } }>(
        "GetStatus",
        { metadata },
        5_000,
      );
      if (status?.status?.message) {
        Logging.dev(`[codeium] GetStatus: ${status.status.message}`, "notice");
      }
    } catch (err) {
      Logging.dev(`[codeium] GetStatus failed: ${(err as Error).message}`, "notice");
    }
  }

  private onExit(code: number | null, signal: NodeJS.Signals | null): void {
    this.stopHeartbeat();
    this.child = null;
    this.port = null; // never cache a port across process lifetimes (§3.4)

    if (this.stopping) return;

    Logging.dev(
      `[codeium] Language server exited (code=${code} signal=${signal}); restarting in ${this.backoffMs}ms`,
      "error",
    );
    this.state = { phase: "starting" };
    this.scheduleRestart();
  }

  private scheduleRestart(): void {
    if (this.restartTimer) return;
    const delay = this.backoffMs;
    this.backoffMs = Math.min(this.backoffMs * 2, RESTART_BACKOFF_MAX_MS);

    this.restartTimer = setTimeout(() => {
      this.restartTimer = null;
      if (this.stopping) return;
      this.restartCount++;
      void this.start();
    }, delay);
  }

  private killChild(): void {
    if (this.child && !this.child.killed) {
      this.child.kill("SIGTERM");
    }
  }

  /** Graceful shutdown — kill the child so we don't leak a ~170 MB process (§3.4). */
  async stop(): Promise<void> {
    this.stopping = true;
    this.stopHeartbeat();
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.killChild();
    this.child = null;
    this.port = null;
    this.state = { phase: "disabled" };
  }
}
