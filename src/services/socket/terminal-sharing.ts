import { Server, Socket } from "socket.io";
import { RedisClientType } from "redis";
import { SocketEventConstants } from "./events";
import type { SessionInfo } from "./types";

const E = SocketEventConstants;

/**
 * Handles live terminal sharing — multiple sockets watching / interacting
 * with a single SSH session.
 */
export class TerminalSharingHandler {
    constructor(
        private readonly io: Server,
        private readonly subClient: RedisClientType,
        private sharedTerminalSessions: Map<string, string[]>,
        private sessions: Map<string, any>,
        private sessionInfo: Record<string, Partial<SessionInfo>>,
    ) {
        this.subClient.pSubscribe("terminal:*", this.onRedisMessage);
    }

    /** Wire socket events for terminal sharing */
    register(socket: Socket) {
        socket.on(E.CreateTerminal, (sessionId: string) => {
            if (!this.sessions.has(sessionId)) {
                this.io
                    .to(socket.id)
                    .emit(E.session_not_found, "Session not found");
                return;
            }

            const info = this.sessionInfo[sessionId];
            socket.join(`terminal:${sessionId}`);
            info?.socketPermissions?.set(socket.id, "400");
            info?.connectedSockets?.add(socket.id);

            const socketIds = this.sharedTerminalSessions.get(sessionId) ?? [];

            if (!socketIds.includes(socket.id)) {
                socketIds.push(socket.id);
                this.sharedTerminalSessions.set(sessionId, socketIds);

                if (info?.adminSocketId) {
                    this.io.to(info.adminSocketId).emit(E.session_info, {
                        socketId: socket.id,
                        socketIds: Array.from(info.connectedSockets ?? []),
                    });
                }
            }
        });
    }

    /** Redis pub/sub → broadcast to all watchers of the session */
    private onRedisMessage = (message: string, channel: string) => {
        const sessionId = channel.split(":")[1];
        const socketIds = this.sharedTerminalSessions.get(sessionId) ?? [];

        for (const sockId of socketIds) {
            this.io.sockets.sockets
                .get(sockId)
                ?.emit(E.terminal_output, message);
        }
    };
}
