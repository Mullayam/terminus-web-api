import { Server, Socket } from "socket.io";
import { RedisClientType } from "redis";
import type { ClientChannel } from "ssh2";
import type { SocketPermission } from "./types";
import { SocketEventConstants } from "./events";
import type {
    LockState,
    CollaborativeSession,
    JoinTerminalPayload,
    AdminLockPayload,
    ChangePermissionPayload,
    KickUserPayload,
    BlockUserPayload,
    UnblockIPPayload,
    RoomStatePayload,
    PTYLockedPayload,
    InputRejectedPayload,
} from "./collaborative-types";

const E = SocketEventConstants;

const AUTO_LOCK_TTL = 4_000; // ms

/**
 * Collaborative terminal handler — testing-only, standalone class.
 *
 * Owns:
 *  - Per-session lock (auto + admin)
 *  - Permission enforcement on input
 *  - Room join / leave / kick / block lifecycle
 *  - PTY write gating
 *
 * Does NOT own:
 *  - SSH connection lifecycle (passed in)
 *  - Session creation / teardown (caller's job)
 *  - Redis pub/sub for terminal output (caller publishes — we subscribe + relay)
 */
export class CollaborativeTerminal {
    /** sessionId → lock state */
    private lockMap = new Map<string, LockState>();
    /** sessionId → collaborative session metadata */
    private sessionMap = new Map<string, CollaborativeSession>();
    /** sessionId → PTY stream (caller binds after SSH shell opens) */
    private streams = new Map<string, ClientChannel>();

    constructor(
        private readonly io: Server,
        private readonly pubClient: RedisClientType,
        private readonly subClient: RedisClientType,
    ) {
        this.subClient.pSubscribe("terminal:*", this.onTerminalOutput);
    }

    /* ════════════════════════════════════════════════════════════════════════
     *  Public API — called by the parent (SocketListener or test harness)
     * ══════════════════════════════════════════════════════════════════════ */

    /** Create a collaborative session. Call once when the SSH shell is ready. */
    createSession(sessionId: string, adminSocketId: string) {
        this.sessionMap.set(sessionId, {
            adminSocketId,
            permissions: new Map([[adminSocketId, "777"]]),
            connectedSockets: new Set([adminSocketId]),
            blockedIPs: new Set(),
            socketIPs: new Map(),
        });

        // Admin must join the collab room to receive lock/unlock/user broadcasts
        const adminSocket = this.io.sockets.sockets.get(adminSocketId);
        adminSocket?.join(this.room(sessionId));
    }

    /** Bind the PTY stream for a session so we can gate writes. */
    bindStream(sessionId: string, stream: ClientChannel) {
        this.streams.set(sessionId, stream);
    }

    /** Remove all state for a session (SSH ended). */
    destroySession(sessionId: string) {
        const lock = this.lockMap.get(sessionId);
        if (lock?.timer) clearTimeout(lock.timer);
        this.lockMap.delete(sessionId);
        this.sessionMap.delete(sessionId);
        this.streams.delete(sessionId);
    }

    /** Register all collaborative events on a socket. */
    register(socket: Socket, sessionId: string) {
        this.onJoinTerminal(socket, sessionId);
        this.onInput(socket, sessionId);
        this.onAdminLock(socket, sessionId);
        this.onChangePermission(socket, sessionId);
        this.onKickUser(socket, sessionId);
        this.onBlockUser(socket, sessionId);
        this.onUnblockIP(socket, sessionId);
        this.onDisconnect(socket, sessionId);
    }

    /* ════════════════════════════════════════════════════════════════════════
     *  Room join
     * ══════════════════════════════════════════════════════════════════════ */

    private onJoinTerminal(socket: Socket, sessionId: string) {
        socket.on(E.COLLAB_JOIN_TERMINAL, async (_payload: JoinTerminalPayload) => {
            const session = this.sessionMap.get(sessionId);
            if (!session) {
                socket.emit(E.COLLAB_JOIN_REJECTED, {
                    reason: "session-not-found",
                    message: "This terminal session doesn't exist or has already ended.",
                });
                return;
            }

            // ── Block check (IP-based, this session only) ───────────────
            const ip = this.resolveIP(socket);
            if (session.blockedIPs.has(ip)) {
                socket.emit(E.COLLAB_JOIN_REJECTED, {
                    reason: "blocked",
                    message: "You've been blocked from this session by the admin. Contact them if you think this is a mistake.",
                });
                return;
            }

            // ── Join room ───────────────────────────────────────────────
            const room = this.room(sessionId);
            socket.join(room);
            session.connectedSockets.add(socket.id);
            session.socketIPs.set(socket.id, ip);

            // Default permission for new joiners: read-only.
            // Admin is already set to "777" in createSession.
            if (!session.permissions.has(socket.id)) {
                session.permissions.set(socket.id, "400");
            }

            const userCount = session.connectedSockets.size;
            const lock = this.lockMap.get(sessionId);

            // ── Send current state to the joiner ────────────────────────
            const state: RoomStatePayload = {
                lockedBy: lock?.holder ?? null,
                lockType: lock?.type ?? null,
                isLocked: !!lock,
                permission: session.permissions.get(socket.id) ?? "400",
                userCount,
                isAdmin: socket.id === session.adminSocketId,
            };
            socket.emit(E.COLLAB_ROOM_STATE, state);

            // ── Notify rest of room (exclude admin — they get a dedicated event with IP) ──
            if (session.adminSocketId) {
                socket.to(room).except(session.adminSocketId).emit(E.COLLAB_USER_JOINED, {
                    socketId: socket.id,
                    userCount,
                });
            } else {
                socket.to(room).emit(E.COLLAB_USER_JOINED, {
                    socketId: socket.id,
                    userCount,
                });
            }

            // ── Notify admin (includes IP) ──────────────────────────────
            if (session.adminSocketId && session.adminSocketId !== socket.id) {
                this.io.to(session.adminSocketId).emit(E.COLLAB_USER_JOINED, {
                    socketId: socket.id,
                    ip,
                    userCount,
                });
            }
        });
    }

    /* ════════════════════════════════════════════════════════════════════════
     *  Input (keystroke) handling — the hot path
     * ══════════════════════════════════════════════════════════════════════ */

    private onInput(socket: Socket, sessionId: string) {
        socket.on(E.COLLAB_INPUT, (input: string) => {
            const session = this.sessionMap.get(sessionId);
            if (!session) return;

            const perm = this.getPermission(session, socket.id);
            const stream = this.streams.get(sessionId);
            if (!stream) return;

            // ── 1. Read-only? Always reject. ────────────────────────────
            if (perm === "400") {
                socket.emit(E.COLLAB_INPUT_REJECTED, {
                    reason: "read-only",
                    message: "You're in read-only mode. Ask the admin to grant you write access.",
                } satisfies InputRejectedPayload);
                return;
            }

            const lock = this.lockMap.get(sessionId);

            // ── 2. Admin lock active? Only "777" passes. ────────────────
            if (lock?.type === "admin" && perm !== "777") {
                socket.emit(E.COLLAB_INPUT_REJECTED, {
                    reason: "locked-admin",
                    message: "The admin has locked the terminal. Only the admin can type right now.",
                } satisfies InputRejectedPayload);
                return;
            }

            // ── 3. Auto-lock held by another "700" user? ───────────────
            if (
                lock?.type === "auto" &&
                lock.holder !== socket.id &&
                perm !== "777"
            ) {
                socket.emit(E.COLLAB_INPUT_REJECTED, {
                    reason: "locked-auto",
                    message: "Someone else is typing. You'll be able to type once they're done.",
                } satisfies InputRejectedPayload);
                return;
            }

            // ── 4. All clear — write to PTY immediately ────────────────
            stream.write(input);

            // ── 5. "700" users trigger / reset auto-lock ────────────────
            if (perm === "700") {
                this.acquireOrResetAutoLock(sessionId, socket.id);
            }
            // "777" (admin) typing does NOT create a lock.
        });
    }

    /* ════════════════════════════════════════════════════════════════════════
     *  Auto-lock — 4s debounced, per-session, in-memory
     * ══════════════════════════════════════════════════════════════════════ */

    private acquireOrResetAutoLock(sessionId: string, socketId: string) {
        const existing = this.lockMap.get(sessionId);

        // If there's an admin lock, don't touch it.
        if (existing?.type === "admin") return;

        const isNewLock = !existing || existing.holder !== socketId;

        // Clear previous auto-lock timer (could be ours or expired remnant)
        if (existing?.timer) clearTimeout(existing.timer);

        const timer = setTimeout(() => {
            const current = this.lockMap.get(sessionId);
            if (current?.holder === socketId && current.type === "auto") {
                this.lockMap.delete(sessionId);
                this.io.to(this.room(sessionId)).emit(E.COLLAB_PTY_UNLOCKED, {});
            }
        }, AUTO_LOCK_TTL);

        this.lockMap.set(sessionId, {
            holder: socketId,
            type: "auto",
            timer,
        });

        // Broadcast LOCKED only on first keystroke (new acquisition)
        if (isNewLock) {
            const payload: PTYLockedPayload = {
                lockedBy: socketId,
                type: "auto",
                expiresIn: AUTO_LOCK_TTL,
            };
            this.io.to(this.room(sessionId)).emit(E.COLLAB_PTY_LOCKED, payload);
        }
    }

    /* ════════════════════════════════════════════════════════════════════════
     *  Admin lock — manual, no TTL
     * ══════════════════════════════════════════════════════════════════════ */

    private onAdminLock(socket: Socket, sessionId: string) {
        socket.on(E.COLLAB_ADMIN_LOCK, (payload: AdminLockPayload) => {
            const session = this.sessionMap.get(sessionId);
            if (!session || socket.id !== session.adminSocketId) return;

            if (payload.lock) {
                // Clear any existing auto-lock timer
                const existing = this.lockMap.get(sessionId);
                if (existing?.timer) clearTimeout(existing.timer);

                this.lockMap.set(sessionId, {
                    holder: socket.id,
                    type: "admin",
                });

                const locked: PTYLockedPayload = {
                    lockedBy: socket.id,
                    type: "admin",
                };
                this.io.to(this.room(sessionId)).emit(E.COLLAB_PTY_LOCKED, locked);
            } else {
                // Unlock
                const existing = this.lockMap.get(sessionId);
                if (existing?.timer) clearTimeout(existing.timer);
                this.lockMap.delete(sessionId);
                this.io.to(this.room(sessionId)).emit(E.COLLAB_PTY_UNLOCKED, {});
            }
        });
    }

    /* ════════════════════════════════════════════════════════════════════════
     *  Permission change — immediate effect
     * ══════════════════════════════════════════════════════════════════════ */

    private onChangePermission(socket: Socket, sessionId: string) {
        socket.on(E.COLLAB_CHANGE_PERMISSION, (payload: ChangePermissionPayload) => {
            const session = this.sessionMap.get(sessionId);
            if (!session || socket.id !== session.adminSocketId) return;

            const { targetSocketId, permission } = payload;

            // Don't allow changing admin's own permission
            if (targetSocketId === session.adminSocketId) return;

            // Don't allow promoting to "777" (only one admin)
            if (permission === "777") return;

            const oldPerm = session.permissions.get(targetSocketId);
            session.permissions.set(targetSocketId, permission);

            // Notify the target immediately
            this.io.to(targetSocketId).emit(E.COLLAB_PERMISSION_CHANGED, {
                permission,
            });

            // If downgraded to "400" and they held the auto-lock → revoke
            if (
                permission === "400" &&
                oldPerm === "700"
            ) {
                const lock = this.lockMap.get(sessionId);
                if (lock?.type === "auto" && lock.holder === targetSocketId) {
                    if (lock.timer) clearTimeout(lock.timer);
                    this.lockMap.delete(sessionId);
                    this.io
                        .to(this.room(sessionId))
                        .emit(E.COLLAB_PTY_UNLOCKED, {});
                }
            }
        });
    }

    /* ════════════════════════════════════════════════════════════════════════
     *  Kick — remove from session, they can rejoin
     * ══════════════════════════════════════════════════════════════════════ */

    private onKickUser(socket: Socket, sessionId: string) {
        socket.on(E.COLLAB_KICK_USER, (payload: KickUserPayload) => {
            const session = this.sessionMap.get(sessionId);
            if (!session || socket.id !== session.adminSocketId) return;

            const { targetSocketId, message } = payload;
            if (targetSocketId === session.adminSocketId) return; // can't kick yourself

            this.removeSocket(sessionId, targetSocketId);

            // Notify the kicked user
            this.io.to(targetSocketId).emit(E.COLLAB_USER_KICKED, {
                message: message ?? "The admin removed you from this session. You can rejoin if you'd like.",
            });

            // Force leave the room (socket stays connected to Socket.IO)
            const targetSocket = this.io.sockets.sockets.get(targetSocketId);
            targetSocket?.leave(this.room(sessionId));

            // Broadcast updated count
            const userCount = session.connectedSockets.size;
            this.io.to(this.room(sessionId)).emit(E.COLLAB_USER_LEFT, {
                socketId: targetSocketId,
                userCount,
            });
        });
    }

    /* ════════════════════════════════════════════════════════════════════════
     *  Block — kick + ban IP for this session
     * ══════════════════════════════════════════════════════════════════════ */

    private onBlockUser(socket: Socket, sessionId: string) {
        socket.on(E.COLLAB_BLOCK_USER, (payload: BlockUserPayload) => {
            const session = this.sessionMap.get(sessionId);
            if (!session || socket.id !== session.adminSocketId) return;

            const { targetSocketId, message } = payload;
            if (targetSocketId === session.adminSocketId) return;

            // Record the IP before removing the socket
            const ip = session.socketIPs.get(targetSocketId);
            if (ip) {
                session.blockedIPs.add(ip);
            }

            this.removeSocket(sessionId, targetSocketId);

            // Notify then force leave
            this.io.to(targetSocketId).emit(E.COLLAB_USER_BLOCKED, {
                message: message ?? "The admin has blocked you from this session. You won't be able to rejoin.",
            });

            const targetSocket = this.io.sockets.sockets.get(targetSocketId);
            targetSocket?.leave(this.room(sessionId));

            const userCount = session.connectedSockets.size;
            this.io.to(this.room(sessionId)).emit(E.COLLAB_USER_LEFT, {
                socketId: targetSocketId,
                userCount,
            });
        });
    }

    /* ════════════════════════════════════════════════════════════════════════
     *  Unblock — remove IP from session block list
     * ══════════════════════════════════════════════════════════════════════ */

    private onUnblockIP(socket: Socket, sessionId: string) {
        socket.on(E.COLLAB_UNBLOCK_IP, (payload: UnblockIPPayload) => {
            const session = this.sessionMap.get(sessionId);
            if (!session || socket.id !== session.adminSocketId) return;
            session.blockedIPs.delete(payload.ip);
        });
    }

    /* ════════════════════════════════════════════════════════════════════════
     *  Disconnect cleanup
     * ══════════════════════════════════════════════════════════════════════ */

    private onDisconnect(socket: Socket, sessionId: string) {
        socket.on("disconnect", () => {
            const session = this.sessionMap.get(sessionId);
            if (!session) return;

            // ── Remove from session (also releases auto-lock if held) ───
            this.removeSocket(sessionId, socket.id);

            const userCount = session.connectedSockets.size;
            this.io.to(this.room(sessionId)).emit(E.COLLAB_USER_LEFT, {
                socketId: socket.id,
                userCount,
            });
        });
    }

    /* ════════════════════════════════════════════════════════════════════════
     *  Redis pub/sub → relay PTY output to room
     * ══════════════════════════════════════════════════════════════════════ */

    private onTerminalOutput = (message: string, channel: string) => {
        // channel = "terminal:{sessionId}"
        const sessionId = channel.split(":")[1];
        const session = this.sessionMap.get(sessionId);
        if (!session) return;

        this.io.to(this.room(sessionId)).emit(E.COLLAB_TERMINAL_OUTPUT, message);
    };

    /* ════════════════════════════════════════════════════════════════════════
     *  Helpers
     * ══════════════════════════════════════════════════════════════════════ */

    private room(sessionId: string): string {
        return `collab:${sessionId}`;
    }

    /** Resolve IP from socket handshake (supports proxies via x-forwarded-for) */
    private resolveIP(socket: Socket): string {
        const forwarded = socket.handshake.headers["x-forwarded-for"];
        if (typeof forwarded === "string") {
            return forwarded.split(",")[0].trim();
        }
        return socket.handshake.address;
    }

    /** Get effective permission. Admin is always "777". */
    private getPermission(
        session: CollaborativeSession,
        socketId: string,
    ): SocketPermission {
        if (socketId === session.adminSocketId) return "777";
        return session.permissions.get(socketId) ?? "400";
    }

    /**
     * Remove a socket from a session's bookkeeping.
     * Does NOT leave the Socket.IO room (caller decides).
     * Cleans up auto-lock if this socket held it.
     */
    private removeSocket(sessionId: string, socketId: string) {
        const session = this.sessionMap.get(sessionId);
        if (!session) return;

        session.connectedSockets.delete(socketId);
        session.permissions.delete(socketId);
        session.socketIPs.delete(socketId);

        // If this socket held the auto-lock, release it
        const lock = this.lockMap.get(sessionId);
        if (lock?.type === "auto" && lock.holder === socketId) {
            if (lock.timer) clearTimeout(lock.timer);
            this.lockMap.delete(sessionId);
            this.io.to(this.room(sessionId)).emit(E.COLLAB_PTY_UNLOCKED, {});
        }
    }
}
