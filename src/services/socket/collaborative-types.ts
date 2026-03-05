import type { SocketPermission } from "./types";

/* ═══════════════════════════════════════════════════════════════════════════
 *  Collaborative Terminal Sharing — Types & Client Contract
 * ═══════════════════════════════════════════════════════════════════════════
 *
 *  PERMISSION LEVELS
 *  ─────────────────
 *    "400"  →  Read-only. Can see output, cannot type. Never subject to lock.
 *    "700"  →  Write. Can see output and type. Subject to auto-lock by others.
 *    "777"  →  Admin / Owner. Full access. Immune to all locks.
 *
 *  LOCK TYPES
 *  ──────────
 *    "auto"   →  Set automatically when a "700" user types. 4s TTL (resets on
 *                each keystroke). Blocks other "700" users. Does NOT block "777".
 *    "admin"  →  Set manually by admin. No TTL. Blocks everyone except "777".
 *                Overrides any active auto-lock.
 *
 * ═══════════════════════════════════════════════════════════════════════════ */

/* ─── Lock ────────────────────────────────────────────────────────────────── */

export type LockType = "auto" | "admin";

export interface LockState {
    /** socket.id of whoever holds the lock */
    holder: string;
    /** "auto" = typing-based, "admin" = manual */
    type: LockType;
    /** Reference to the auto-release timer (auto-lock only) */
    timer?: ReturnType<typeof setTimeout>;
}

/* ─── Per-session collaborative state ─────────────────────────────────────── */

export interface CollaborativeSession {
    /** The admin/owner socket.id */
    adminSocketId: string;
    /** socketId → permission. Admin is always implicitly "777". */
    permissions: Map<string, SocketPermission>;
    /** All connected socket ids */
    connectedSockets: Set<string>;
    /** IPs blocked from rejoining this session */
    blockedIPs: Set<string>;
    /** socketId → IP address (for block enforcement) */
    socketIPs: Map<string, string>;
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  CLIENT → SERVER  payloads  (what the frontend must send)
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Client sends when joining a shared terminal */
export interface JoinTerminalPayload {
    sessionId: string;
}

/** Client sends on every keystroke (only if they believe they can type) */
export interface TerminalInputPayload {
    input: string;
}

/** Admin sends to toggle manual lock on/off */
export interface AdminLockPayload {
    sessionId: string;
    lock: boolean;
}

/** Admin sends to change a user's permission */
export interface ChangePermissionPayload {
    sessionId: string;
    targetSocketId: string;
    permission: SocketPermission;
}

/** Admin sends to kick a user (they can rejoin) */
export interface KickUserPayload {
    sessionId: string;
    targetSocketId: string;
    message?: string;
}

/** Admin sends to block a user's IP for this session (cannot rejoin) */
export interface BlockUserPayload {
    sessionId: string;
    targetSocketId: string;
    message?: string;
}

/** Admin sends to unblock a previously blocked IP */
export interface UnblockIPPayload {
    sessionId: string;
    ip: string;
}

/* ═══════════════════════════════════════════════════════════════════════════
 *  SERVER → CLIENT  payloads  (what the frontend will receive)
 * ═══════════════════════════════════════════════════════════════════════════ */

/** Sent to the joiner immediately after joining */
export interface RoomStatePayload {
    /** Who holds the lock (null = unlocked) */
    lockedBy: string | null;
    /** Lock type if locked */
    lockType: LockType | null;
    isLocked: boolean;
    /** This socket's permission level */
    permission: SocketPermission;
    /** How many users are in the room */
    userCount: number;
    /** Is the joiner the admin? */
    isAdmin: boolean;
}

/** Broadcast to room when a new user joins */
export interface UserJoinedPayload {
    socketId: string;
    userCount: number;
}

/** Broadcast to room when a user leaves */
export interface UserLeftPayload {
    socketId: string;
    userCount: number;
}

/** Broadcast to room when PTY is locked */
export interface PTYLockedPayload {
    lockedBy: string;
    type: LockType;
    /** Remaining ms for auto-lock; undefined for admin lock */
    expiresIn?: number;
}

/** Broadcast to room when PTY is unlocked */
export interface PTYUnlockedPayload {}

/** Sent to a specific socket when their permission changes */
export interface PermissionChangedPayload {
    permission: SocketPermission;
}

/** Sent to a socket when their input is rejected */
export interface InputRejectedPayload {
    reason: "read-only" | "locked-auto" | "locked-admin";
    message: string;
}

/** Sent to a socket when they are kicked */
export interface UserKickedPayload {
    message: string;
}

/** Sent to a socket when they are blocked */
export interface UserBlockedPayload {
    message: string;
}

/** Sent to a socket when they try to join but are blocked */
export interface JoinRejectedPayload {
    reason: "blocked" | "session-not-found";
    message: string;
}


