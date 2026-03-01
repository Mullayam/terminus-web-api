import { Server, Socket } from "socket.io";
import { Client, ClientChannel, ParsedKey } from "ssh2";
import { RedisClientType } from "redis";
import { Logging } from "@enjoys/express-utils/logger";
import { SocketEventConstants } from "./events";
import { parseSSHConfig } from "./parse-ssh-config";
import { TerminalSharingHandler } from "./terminal-sharing";
import type { SessionInfo, SocketPermission } from "./types";

const E = SocketEventConstants;

/**
 * Main `/` namespace listener.
 *
 * Responsibilities:
 *  - Session lifecycle (connect / reconnect / disconnect)
 *  - SSH terminal (start, resume, shell I/O, resize)
 *  - Session management (permissions, pause, kick)
 *  - Delegates terminal sharing to `TerminalSharingHandler`
 */
export class SocketListener {
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

        if (sessionId) {
            this.handleSessionConnect(socket, sessionId);
        } else {
            Logging.dev(`🔌 Client connected: ${socket.id}`);
        }

        this.registerSSHEvents(socket, sessionId);
        this.sharing.register(socket);
        this.registerDisconnectEvents(socket, sessionId);
    }

    /** Handle new or returning admin sessions */
    private handleSessionConnect(socket: Socket, sessionId: string) {
        const existing = this.sessionInfo[sessionId];

        if (existing) {
            const oldId = existing.adminSocketId;
            if (oldId && oldId !== socket.id) {
                existing.connectedSockets?.delete(oldId);
                existing.socketPermissions?.delete(oldId);

                // Do NOT disconnect or notify the old socket.
                //
                // Previously we called stale.disconnect() or emitted SESSIONN_END.
                // Both cause the frontend to tear down all sockets on the shared
                // Manager/transport — including /sftp sockets for other panels.
                //
                // The old socket will clean up naturally via heartbeat timeout.
                // We've already removed it from connectedSockets/permissions above
                // and overwritten adminSocketId below, so it's effectively inert.
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
                this.redisClient.del(`sftp:${sessionId}`);
                this.sharedTerminalSessions.delete(sid);

                if (socket.id === info.adminSocketId) {
                    this.sessions.get(sid)?.end();
                    this.sessions.delete(sid);
                    delete this.sessionInfo[sid];
                    this.redisClient.del(`terminal:history:${sid}`);
                    socket.leave(`terminal:${sid}`);
                    Logging.dev(`Admin Disconnected: ${sid}`);
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

            info.socketPermissions?.set(socket.id, data.permissions);
            this.io.sockets.sockets.get(data.socketId)?.emit(E.SSH_PERMISSIONS, input);

            if (info.adminSocketId) {
                this.io.sockets.sockets.get(info.adminSocketId)?.emit(E.SSH_PERMISSIONS, input);
            }
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

        socket.on(E.SSH_EMIT_INPUT, (input: string) => stream.write(input));

        socket.on(E.SSH_EMIT_RESIZE, (size: { cols: number; rows: number }) => {
            const info = this.sessionInfo[sessionId];
            if (info?.terminalSize) {
                info.terminalSize.cols = size.cols;
                info.terminalSize.rows = size.rows;
            }
            stream.setWindow(size.rows, size.cols, 1280, 720);
        });

        socket.on("disconnect", () => conn.end());
    }
}
