import { EventEmitter } from "events";
import { Server, Socket } from "socket.io";
import { Client, ClientChannel, ParsedKey } from "ssh2";
import { RedisClientType } from "redis";
import { Logging } from "@enjoys/express-utils/logger";
import { SocketEventConstants } from "./events";
import { parseSSHConfig } from "./parse-ssh-config";
import { TerminalSharingHandler } from "./terminal-sharing";
import type { SessionInfo, SocketPermission } from "./types";

const E = SocketEventConstants;
const ADMIN_RECONNECT_GRACE = 15_000; // ms — wait before killing SSH on admin disconnect

/**
 * Main `/` namespace listener.
 *
 * Responsibilities:
 *  - Session lifecycle (connect / reconnect / disconnect)
 *  - SSH terminal (start, resume, shell I/O, resize)
 *  - Session management (permissions, pause, kick)
 *  - Delegates terminal sharing to `TerminalSharingHandler`
 */
export class SocketListener extends EventEmitter {
    private sessions = new Map<string, Client>();
    private sharedTerminalSessions = new Map<string, string[]>();
    private sessionInfo: Record<string, Partial<SessionInfo>> = {};
    private sharing: TerminalSharingHandler;

    constructor(
        private readonly redisClient: RedisClientType,
        private readonly pubClient: RedisClientType,
        subClient: RedisClientType,
        private readonly io: Server,
    ) {
        super();
        this.sharing = new TerminalSharingHandler(
            io,
            subClient,
            this.sharedTerminalSessions,
            this.sessions,
            this.sessionInfo,
        );
    }

    /* ════════════════════════════════════════════════════════════════════════
     *  Connection lifecycle
     * ══════════════════════════════════════════════════════════════════════ */

    public onConnection(socket: Socket) {
        const sessionId = socket.handshake.query.sessionId as string;
        const role = (socket.handshake.query.role as string) ?? "admin";

        if (sessionId) {
            if (role === "collab") {
                this.handleCollabConnect(socket, sessionId);
            } else {
                this.handleSessionConnect(socket, sessionId);
            }
        } else {
            Logging.dev(`🔌 Client connected: ${socket.id}`);
        }

        this.registerSSHEvents(socket, sessionId);
        this.sharing.register(socket);
        this.registerDisconnectEvents(socket, sessionId);
    }

    /** A collab participant joined — never touch adminSocketId */
    private handleCollabConnect(socket: Socket, sessionId: string) {
        const existing = this.sessionInfo[sessionId];
        if (!existing) {
            Logging.dev(`⚠️ Collab join for unknown session: ${sessionId}`);
            return;
        }

        existing.connectedSockets?.add(socket.id);
        socket.join(`terminal:${sessionId}`);
        Logging.dev(`👤 Participant joined session: ${sessionId} + ${socket.id}`);
    }

    /** Handle new or returning admin sessions */
    private handleSessionConnect(socket: Socket, sessionId: string) {
        const existing = this.sessionInfo[sessionId];

        if (existing) {
            const oldId = existing.adminSocketId;

            if (oldId && oldId !== socket.id) {
                // Admin reconnection (e.g. page refresh)
                if (existing.adminReconnectTimer) {
                    clearTimeout(existing.adminReconnectTimer);
                    delete existing.adminReconnectTimer;
                }

                existing.connectedSockets?.delete(oldId);
                existing.socketPermissions?.delete(oldId);
                Logging.dev(`♻️ Session ${sessionId} reconnected: ${oldId} → ${socket.id}`);
            }

            existing.adminSocketId = socket.id;
            existing.connectedSockets?.add(socket.id);
            socket.join(`terminal:${sessionId}`);
        } else {
            this.sessionInfo[sessionId] = {
                adminSocketId: socket.id,
                socketPermissions: new Map(),
                connectedSockets: new Set([socket.id]),
                terminalSize: { width: 0, height: 0, cols: 150, rows: 40 },
            };
        }

        Logging.dev(`🔌 Admin connected: ${sessionId} + ${socket.id}`);
    }

    /** Wire disconnecting + disconnect cleanup */
    private registerDisconnectEvents(socket: Socket, sessionId: string) {
        socket.on("disconnecting", (reason) => {
            const info = this.sessionInfo[socket.id];
            if (!info) return;

            if (info.adminSocketId) {
                this.io.to(info.adminSocketId).emit(E.SSH_DISCONNECTED, socket.id);
            }
            socket.emit(E.SSH_DISCONNECTED, "Session is Terminated by Admin");
            Logging.dev(`SOCKET DISCONNECTING: ${reason}`);
        });

        socket.on("disconnect", () => {
            Logging.dev(`Client disconnected: ${socket.id}`);

            for (const [sid, info] of Object.entries(this.sessionInfo)) {
                if (socket.id === info.adminSocketId) {
                    // Grace period: admin may be refreshing — don't kill SSH immediately
                    Logging.dev(`⏳ Admin disconnect grace period started: ${sid}`);
                    info.adminReconnectTimer = setTimeout(() => {
                        delete info.adminReconnectTimer;
                        // Re-check: if adminSocketId changed, someone reconnected — abort
                        if (info.adminSocketId !== socket.id) {
                            Logging.dev(`♻️ Admin reconnected during grace period: ${sid}`);
                            return;
                        }

                        this.io.to(`terminal:${sid}`).emit(E.SESSIONN_END, "Session ended — the admin has disconnected.");
                        this.sessions.get(sid)?.end();
                        this.sessions.delete(sid);
                        delete this.sessionInfo[sid];
                        this.redisClient.del(`terminal:history:${sid}`);
                        this.redisClient.del(`sftp:${sid}`);
                        this.sharedTerminalSessions.delete(sid);
                        Logging.dev(`❌ Admin Disconnected (grace expired): ${sid}`);
                    }, ADMIN_RECONNECT_GRACE);
                } else {
                    info.socketPermissions?.delete(socket.id);
                    info.connectedSockets?.delete(socket.id);
                }
            }
        });
    }

    /* ════════════════════════════════════════════════════════════════════════
     *  SSH terminal operations
     * ══════════════════════════════════════════════════════════════════════ */

    private registerSSHEvents(socket: Socket, sessionId: string) {
        this.registerSessionManagement(socket, sessionId);
        this.registerSSHResume(socket, sessionId);
        this.registerSSHStart(socket, sessionId);
        this.registerSilentExec(socket, sessionId);
    }

    /** Session management: pause / kick / permissions */
    private registerSessionManagement(socket: Socket, sessionId: string) {
        socket.on(E.SSH_SESSION, (input: string) => {
            let data: { socketId: string; sessionId: string; type: "pause" | "resume" | "kick" };
            try { data = JSON.parse(input); }
            catch { return socket.emit(E.SSH_EMIT_ERROR, "Invalid JSON input"); }

            const info = this.sessionInfo[sessionId];
            if (!info) return;

            const target = this.io.sockets.sockets.get(data.socketId);
            if (!target) return;

            switch (data.type) {
                case "pause":
                    target.emit(E.session_info, `Your session has been paused by an admin, click "Resume" to continue`);
                    target.disconnect();
                    break;
                case "kick":
                    target.emit(E.SESSIONN_END, "Your session has been terminated by an admin");
                    info.connectedSockets?.delete(data.socketId);
                    target.disconnect();
                    break;
            }
        });

        socket.on(E.SSH_PERMISSIONS, (input: string) => {
            let data: { socketId: string; permissions: SocketPermission; sessionId: string };
            try { data = JSON.parse(input); }
            catch { return socket.emit(E.SSH_EMIT_ERROR, "Invalid JSON input"); }

            const info = this.sessionInfo[data.sessionId];
            if (!info) return;

            info.socketPermissions?.set(data.socketId, data.permissions);
            this.io.sockets.sockets.get(data.socketId)?.emit(E.SSH_PERMISSIONS, input);

            if (info.adminSocketId) {
                this.io.sockets.sockets.get(info.adminSocketId)?.emit(E.SSH_PERMISSIONS, input);
            }

            // Sync permission into the collaborative terminal session
            // so that COLLAB_INPUT respects it.
            this.emit("permission-changed", {
                sessionId: data.sessionId,
                targetSocketId: data.socketId,
                permission: data.permissions,
            });
        });
    }

    /** Resume an existing SSH session from Redis metadata */
    private registerSSHResume(socket: Socket, sessionId: string) {
        socket.on(E.SSH_RESUME, async () => {
            const metaJson = await this.redisClient.get(`session:${sessionId}`);
            if (!metaJson) {
                socket.emit(E.SSH_EMIT_ERROR, "No session to resume");
                return;
            }

            const config = parseSSHConfig(JSON.parse(metaJson));
            Logging.dev(`♻️ Resuming session ${sessionId} → ${config.host}`);

            const ssh = new Client();
            ssh.on("ready", () => {
                Logging.dev(`✅ SSH Ready (Resumed): ${sessionId}`);
                socket.emit(E.SSH_READY, "Ready");
            });
            ssh.on("error", (err) => {
                socket.emit(E.SSH_EMIT_ERROR, "SSH connection error: " + err.message);
            });
            ssh.connect(config);
            this.sessions.set(sessionId, ssh);
        });
    }

    /** Start a brand-new SSH terminal session */
    private registerSSHStart(socket: Socket, sessionId: string) {
        socket.on(E.SSH_START_SESSION, (input: string) => {
            let parsed: any;
            try { parsed = JSON.parse(input); }
            catch { return socket.emit(E.SSH_EMIT_ERROR, "Invalid JSON input"); }

            const config = parseSSHConfig(parsed);
            Logging.dev(`✨ Starting new session: ${sessionId}`);

            this.sessionInfo[sessionId] = {
                adminSocketId: socket.id,
                socketPermissions: new Map(),
                connectedSockets: new Set(),
                terminalSize: { width: 0, height: 0, cols: 150, rows: 40 },
            };

            const conn = this.sessions.get(sessionId) ?? new Client({ captureRejections: true });

            conn.on("ready", () => {
                socket.emit(E.SSH_READY, "Ready");
                Logging.dev(`✅ SSH Ready: ${sessionId}`);

                const termSize = this.sessionInfo[sessionId]?.terminalSize;
                conn.shell(
                    {
                        cols: termSize?.cols ?? 150,
                        rows: termSize?.rows ?? 40,
                        term: "xterm-256color",
                    },
                    (err, stream) => {
                        if (err) {
                            Logging.dev("Error opening shell: " + err.message, "error");
                            socket.emit(E.SSH_EMIT_ERROR, "Error opening shell: " + err.message);
                            return;
                        }
                        this.bindShellEvents(socket, sessionId, stream, conn);

                        // Auto-fetch history as soon as the shell is up
                        this.execSilent(conn, socket);
                    },
                );
            });

            conn.on("error", (err) => {
                socket.emit(E.SSH_EMIT_ERROR, "SSH connection error: " + err.message);
            });
            conn.on("greeting", (msg) => socket.emit(E.SSH_EMIT_LOGS, msg));
            conn.on("handshake", (msg) => socket.emit(E.SSH_EMIT_LOGS, msg));
            conn.on("banner", (data) => {
                socket.emit(E.SSH_BANNER, data.replace(/\r?\n/g, "\r\n"));
            });
            conn.on("hostkeys", (keys: ParsedKey[]) => {
                socket.emit(E.SSH_HOST_KEYS, keys);
            });

            conn.connect(config);
            this.sessions.set(sessionId, conn);
        });
    }

    /**
     * Silent exec – runs a command on a **separate** exec channel so
     * xterm never sees the output.  Used to fetch shell history, env vars,
     * aliases, etc. and return them as deduplicated suggestion arrays.
     *
     * Client emits:  SSH_EXEC_SILENT  { command?: string }
     * Server emits:  SSH_EXEC_SILENT_RESULT  string[]   (unique, trimmed)
     *
     * Also called automatically when the shell is first opened.
     */
    private registerSilentExec(socket: Socket, sessionId: string) {
        socket.on(E.SSH_EXEC_SILENT, (payload?: { command?: string }) => {
            const conn = this.sessions.get(sessionId);
            if (!conn) {
                socket.emit(E.SSH_EMIT_ERROR, "No active SSH session");
                return;
            }
            this.execSilent(conn, socket, payload?.command);
        });
    }

    /**
     * Core silent-exec logic. Opens a one-off exec channel, collects stdout,
     * deduplicates with a Set, and emits the result. Completely invisible to xterm.
     */
    private execSilent(conn: Client, socket: Socket, command?: string) {
        const cmd =
            command ||
            `cat ~/.bash_history 2>/dev/null || cat ~/.zsh_history 2>/dev/null || fc -ln 1 2>/dev/null`;

        conn.exec(cmd, (err, stream) => {
            if (err) {
                Logging.dev(`Silent exec error: ${err.message}`, "error");
                return; // silently fail — don't spam the client on auto-calls
            }

            let stdout = "";

            stream.on("data", (chunk: Buffer) => {
                stdout += chunk.toString("utf-8");
            });

            stream.stderr.on("data", () => {
                /* swallow stderr – not relevant for suggestions */
            });

            stream.on("close", () => {
                // Parse, trim, deduplicate using Set
                const lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
                // Strip zsh history timestamps (`: 1234567890:0;actual command`)
                const cleaned = lines.map((l) =>
                    l.replace(/^:\s*\d+:\d+;/, "").trim(),
                ).filter(Boolean);

                const unique = [...new Set(cleaned)];
                socket.emit(E.SSH_EXEC_SILENT_RESULT, unique);
            });
        });
    }

    /** Bind shell stream ↔ socket bi-directional I/O */
    private bindShellEvents(
        socket: Socket,
        sessionId: string,
        stream: ClientChannel,
        conn: Client,
    ) {
        stream.on("data", (chunk: Buffer) => {
            const text = chunk.toString("utf-8");
            socket.emit(E.SSH_EMIT_DATA, text);
            this.pubClient.publish(`terminal:${sessionId}`, text);
        });

        stream.stderr.on("data", (chunk: Buffer) => {
            Logging.dev(`STDERR: ${chunk}`, "error");
        });

        stream.on("close", () => conn.end());

        this.emit("shell-ready", { sessionId, stream, socket });

        socket.on(E.SSH_EMIT_INPUT, (input: string) => {
            if (input != null) stream.write(input);
        });

        socket.on(E.SSH_EMIT_RESIZE, (size: { cols: number; rows: number }) => {
            const info = this.sessionInfo[sessionId];
            if (info?.terminalSize) {
                info.terminalSize.cols = size.cols;
                info.terminalSize.rows = size.rows;
            }
            stream.setWindow(size.rows, size.cols, 1280, 720);
        });

        socket.on("disconnect", () => {
            // Do NOT kill SSH here. The grace-period timer in
            // registerDisconnectEvents handles admin disconnects.
            // Collab users must never tear down the connection.
            // If no grace period fires (i.e. admin truly left for good),
            // the timer callback will call conn.end().
        });
    }
}
