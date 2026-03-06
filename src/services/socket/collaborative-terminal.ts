import { Server, Socket } from "socket.io";
import { RedisClientType } from "redis";
import type { ClientChannel } from "ssh2";
import { Logging } from "@enjoys/express-utils/logger";
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
const ADMIN_RECONNECT_GRACE = 15_000; // ms — grace period before destroying session on admin disconnect

/**
 * Collaborative terminal handler.
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
 *
 * ALL event handlers read sessionId from their payload at runtime.
 * registerAll(socket) is called for EVERY connecting socket — no sessionId
 * is required at registration time.
 */
export class CollaborativeTerminal {
    /** sessionId → lock state */
    private lockMap = new Map<string, LockState>();
    /** sessionId → collaborative session metadata */
    private sessionMap = new Map<string, CollaborativeSession>();
    /** sessionId → PTY stream (caller binds after SSH shell opens) */
    private streams = new Map<string, ClientChannel>();
    /** socketId → set of sessionIds they've joined (for disconnect cleanup) */
    private socketSessions = new Map<string, Set<string>>();
    /** sessionId → pending destruction timer (admin disconnect grace period) */
    private pendingDestroy = new Map<string, ReturnType<typeof setTimeout>>();
    /** Sessions where the admin is in the process of reconnecting */
    private reconnecting = new Set<string>();

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
        if (this.sessionMap.has(sessionId)) {
            // Session survived a reconnection — update the admin socket
            this.reconnectAdmin(sessionId, adminSocketId);
            return;
        }

        this.sessionMap.set(sessionId, {
            adminSocketId,
            permissions: new Map([[adminSocketId, "777"]]),
            connectedSockets: new Set([adminSocketId]),
            blockedIPs: new Set(),
            socketIPs: new Map(),
        });

        this.trackSocket(adminSocketId, sessionId);

        // Admin must join the collab room to receive lock/unlock/user broadcasts
        const adminSocket = this.io.sockets.sockets.get(adminSocketId);
        adminSocket?.join(this.room(sessionId));
    }

    /** Bind the PTY stream for a session so we can gate writes. */
    bindStream(sessionId: string, stream: ClientChannel) {
        this.streams.set(sessionId, stream);
    }

    /**
     * Sync a permission change from the legacy SSH_PERMISSIONS path
     * into the collab session so that COLLAB_INPUT respects it.
     */
    syncPermission(sessionId: string, targetSocketId: string, permission: SocketPermission) {
        const session = this.sessionMap.get(sessionId);
        if (!session) return;
        if (targetSocketId === session.adminSocketId) return; // admin is always 777
        if (permission === "777") return; // don't allow escalation via this path
        session.permissions.set(targetSocketId, permission);
    }

    /**
     * Reconnect the admin after a page refresh / socket reconnection.
     * Cancels any pending grace-period destruction and updates internal state.
     */
    reconnectAdmin(sessionId: string, newSocketId: string) {
        // Cancel pending destruction
        this.reconnecting.delete(sessionId);
        const timer = this.pendingDestroy.get(sessionId);
        if (timer) {
            clearTimeout(timer);
            this.pendingDestroy.delete(sessionId);
        }

        const session = this.sessionMap.get(sessionId);
        if (!session) return;

        const oldAdminId = session.adminSocketId;

        // Update admin identity
        session.adminSocketId = newSocketId;
        session.permissions.set(newSocketId, "777");
        session.connectedSockets.add(newSocketId);

        // Clean up old admin references
        session.connectedSockets.delete(oldAdminId);
        session.permissions.delete(oldAdminId);
        session.socketIPs.delete(oldAdminId);

        const oldSet = this.socketSessions.get(oldAdminId);
        if (oldSet) {
            oldSet.delete(sessionId);
            if (oldSet.size === 0) this.socketSessions.delete(oldAdminId);
        }

        // Track new socket
        this.trackSocket(newSocketId, sessionId);

        // Join new socket to the collab room
        const newSocket = this.io.sockets.sockets.get(newSocketId);
        newSocket?.join(this.room(sessionId));

        // Unbind old stream — caller will rebind via bindStream()
        this.streams.delete(sessionId);

        // Notify collaborators that the admin is back
        this.io.to(this.room(sessionId)).emit(E.COLLAB_ADMIN_RECONNECTED, {
            sessionId,
            message: "The admin has reconnected. You're back in the session.",
        });

        Logging.dev(`♻️ Collab admin reconnected: ${sessionId} (${oldAdminId} → ${newSocketId})`);
    }

    /** Remove all state for a session (SSH ended). */
    destroySession(sessionId: string) {
        // If admin is reconnecting (grace period active), skip destruction
        if (this.reconnecting.has(sessionId)) return;

        const pendingTimer = this.pendingDestroy.get(sessionId);
        if (pendingTimer) {
            clearTimeout(pendingTimer);
            this.pendingDestroy.delete(sessionId);
        }

        const lock = this.lockMap.get(sessionId);
        if (lock?.timer) clearTimeout(lock.timer);
        this.lockMap.delete(sessionId);
        this.sessionMap.delete(sessionId);
        this.streams.delete(sessionId);
    }

    /**
     * Register ALL collaborative event listeners on a socket.
     * Call for EVERY connecting socket — no sessionId required.
     * Each handler reads sessionId from its payload at runtime.
     */
    registerAll(socket: Socket) {
        this.onCheckRoom(socket);
        this.onJoinTerminal(socket);
        this.onInput(socket);
        this.onAdminLock(socket);
        this.onChangePermission(socket);
        this.onKickUser(socket);
        this.onBlockUser(socket);
        this.onUnblockIP(socket);
        this.onDisconnect(socket);
    }

    /* ════════════════════════════════════════════════════════════════════════
     *  Room check — lightweight probe before joining
     * ══════════════════════════════════════════════════════════════════════ */

    private onCheckRoom(socket: Socket) {
        socket.on(E.COLLAB_CHECK_ROOM, (payload?: { sessionId?: string }) => {
            const sid = payload?.sessionId ?? (socket.handshake.query.sessionId as string);
            Logging.dev(`��� CHECK_ROOM from ${socket.id} | sid=${sid}`);

            if (!sid) {
                socket.emit(E.COLLAB_ROOM_STATUS, { exists: false, blocked: false, userCount: 0 });
                return;
            }

            const session = this.sessionMap.get(sid);
            const exists = !!session;
            const ip = this.resolveIP(socket);
            const blocked = exists ? session.blockedIPs.has(ip) : false;

            Logging.dev(`��� CHECK_ROOM → exists=${exists} blocked=${blocked} sessions=[${[...this.sessionMap.keys()].join(", ")}]`);

            socket.emit(E.COLLAB_ROOM_STATUS, {
                exists,
                blocked,
                userCount: exists ? session.connectedSockets.size : 0,
            });
        });
    }

    /* ════════════════════════════════════════════════════════════════════════
     *  Room join — sessionId comes from the payload
     * ══════════════════════════════════════════════════════════════════════ */

    private onJoinTerminal(socket: Socket) {
        socket.on(E.COLLAB_JOIN_TERMINAL, async (payload: JoinTerminalPayload) => {
            const sessionId = payload?.sessionId;
            if (!sessionId) {
                socket.emit(E.COLLAB_JOIN_REJECTED, {
                    reason: "session-not-found",
                    message: "No session ID provided.",
                });
                return;
            }

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
            this.trackSocket(socket.id, sessionId);

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
     *  sessionId resolved from socketSessions (set during join)
     * ══════════════════════════════════════════════════════════════════════ */

    private onInput(socket: Socket) {
        socket.on(E.COLLAB_INPUT, (input: string) => {
            const sessionId = this.findSessionForSocket(socket.id);
            if (!sessionId) return;

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
            if (input != null) stream.write(input);

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

    private onAdminLock(socket: Socket) {
        socket.on(E.COLLAB_ADMIN_LOCK, (payload: AdminLockPayload) => {
            const { sessionId, lock } = payload;
            const session = this.sessionMap.get(sessionId);
            if (!session || socket.id !== session.adminSocketId) return;

            if (lock) {
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

    private onChangePermission(socket: Socket) {
        socket.on(E.COLLAB_CHANGE_PERMISSION, (payload: ChangePermissionPayload) => {
            const { sessionId, targetSocketId, permission } = payload;
            const session = this.sessionMap.get(sessionId);
            if (!session || socket.id !== session.adminSocketId) return;

            if (targetSocketId === session.adminSocketId) return;
            if (permission === "777") return;

            const oldPerm = session.permissions.get(targetSocketId);
            session.permissions.set(targetSocketId, permission);

            this.io.to(targetSocketId).emit(E.COLLAB_PERMISSION_CHANGED, {
                permission,
            });

            if (permission === "400" && oldPerm === "700") {
                const lock = this.lockMap.get(sessionId);
                if (lock?.type === "auto" && lock.holder === targetSocketId) {
                    if (lock.timer) clearTimeout(lock.timer);
                    this.lockMap.delete(sessionId);
                    this.io.to(this.room(sessionId)).emit(E.COLLAB_PTY_UNLOCKED, {});
                }
            }
        });
    }

    /* ════════════════════════════════════════════════════════════════════════
     *  Kick — remove from session, they can rejoin
     * ══════════════════════════════════════════════════════════════════════ */

    private onKickUser(socket: Socket) {
        socket.on(E.COLLAB_KICK_USER, (payload: KickUserPayload) => {
            const { sessionId, targetSocketId, message } = payload;
            const session = this.sessionMap.get(sessionId);
            if (!session || socket.id !== session.adminSocketId) return;
            if (targetSocketId === session.adminSocketId) return;

            this.removeSocket(sessionId, targetSocketId);

            this.io.to(targetSocketId).emit(E.COLLAB_USER_KICKED, {
                message: message ?? "The admin removed you from this session. You can rejoin if you'd like.",
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
     *  Block — kick + ban IP for this session
     * ══════════════════════════════════════════════════════════════════════ */

    private onBlockUser(socket: Socket) {
        socket.on(E.COLLAB_BLOCK_USER, (payload: BlockUserPayload) => {
            const { sessionId, targetSocketId, message } = payload;
            const session = this.sessionMap.get(sessionId);
            if (!session || socket.id !== session.adminSocketId) return;
            if (targetSocketId === session.adminSocketId) return;

            const ip = session.socketIPs.get(targetSocketId);
            if (ip) session.blockedIPs.add(ip);

            this.removeSocket(sessionId, targetSocketId);

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

    private onUnblockIP(socket: Socket) {
        socket.on(E.COLLAB_UNBLOCK_IP, (payload: UnblockIPPayload) => {
            const { sessionId, ip } = payload;
            const session = this.sessionMap.get(sessionId);
            if (!session || socket.id !== session.adminSocketId) return;
            session.blockedIPs.delete(ip);
        });
    }

    /* ════════════════════════════════════════════════════════════════════════
     *  Disconnect cleanup — iterates all sessions this socket joined
     * ══════════════════════════════════════════════════════════════════════ */

    private onDisconnect(socket: Socket) {
        socket.on("disconnect", () => {
            const sessions = this.socketSessions.get(socket.id);
            if (!sessions) return;

            for (const sessionId of sessions) {
                const session = this.sessionMap.get(sessionId);
                if (!session) continue;

                const isAdmin = socket.id === session.adminSocketId;
                this.removeSocket(sessionId, socket.id);

                if (isAdmin) {
                    // Notify collaborators immediately that the admin has disconnected
                    this.io.to(this.room(sessionId)).emit(E.COLLAB_ADMIN_DISCONNECTED, {
                        sessionId,
                        message: "The admin has disconnected. Please wait — if they reconnect, we'll reconnect you automatically.",
                        gracePeriod: ADMIN_RECONNECT_GRACE,
                    });

                    // Don't destroy immediately — admin may be refreshing the page.
                    // Start a grace period; if they reconnect in time the session survives.
                    this.reconnecting.add(sessionId);
                    const timer = setTimeout(() => {
                        this.reconnecting.delete(sessionId);
                        this.pendingDestroy.delete(sessionId);

                        const stillExists = this.sessionMap.get(sessionId);
                        if (stillExists) {
                            this.io.to(this.room(sessionId)).emit(E.COLLAB_SESSION_ENDED, {
                                sessionId,
                                reason: "admin-disconnected",
                                message: "Session ended — the admin did not reconnect in time.",
                            });
                            this.destroySession(sessionId);
                        }
                    }, ADMIN_RECONNECT_GRACE);
                    this.pendingDestroy.set(sessionId, timer);
                } else {
                    const userCount = session.connectedSockets.size;
                    this.io.to(this.room(sessionId)).emit(E.COLLAB_USER_LEFT, {
                        socketId: socket.id,
                        userCount,
                    });
                }
            }

            this.socketSessions.delete(socket.id);
        });
    }

    /* ════════════════════════════════════════════════════════════════════════
     *  Redis pub/sub → relay PTY output to room
     * ══════════════════════════════════════════════════════════════════════ */

    private onTerminalOutput = (message: string, channel: string) => {
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

    private resolveIP(socket: Socket): string {
        const forwarded = socket.handshake.headers["x-forwarded-for"];
        if (typeof forwarded === "string") {
            return forwarded.split(",")[0].trim();
        }
        return socket.handshake.address;
    }

    private getPermission(session: CollaborativeSession, socketId: string): SocketPermission {
        if (socketId === session.adminSocketId) return "777";
        return session.permissions.get(socketId) ?? "400";
    }

    /** Track that a socket is part of a session (for disconnect cleanup). */
    private trackSocket(socketId: string, sessionId: string) {
        let set = this.socketSessions.get(socketId);
        if (!set) {
            set = new Set();
            this.socketSessions.set(socketId, set);
        }
        set.add(sessionId);
    }

    /** Find the first session this socket belongs to (for input routing). */
    private findSessionForSocket(socketId: string): string | undefined {
        const set = this.socketSessions.get(socketId);
        if (!set || set.size === 0) return undefined;
        return set.values().next().value;
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

        // Remove from socketSessions tracking
        const set = this.socketSessions.get(socketId);
        if (set) {
            set.delete(sessionId);
            if (set.size === 0) this.socketSessions.delete(socketId);
        }

        // If this socket held the auto-lock, release it
        const lock = this.lockMap.get(sessionId);
        if (lock?.type === "auto" && lock.holder === socketId) {
            if (lock.timer) clearTimeout(lock.timer);
            this.lockMap.delete(sessionId);
            this.io.to(this.room(sessionId)).emit(E.COLLAB_PTY_UNLOCKED, {});
        }
    }
}
