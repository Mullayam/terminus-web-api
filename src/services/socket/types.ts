import { Server, Socket } from "socket.io";

/* ─── Permission levels for shared terminal sessions ──────────────────────── */

export type SocketPermission = "400" | "700" | "777";

/* ─── Per-session metadata stored in the main namespace ───────────────────── */

export interface SessionInfo {
    /** Socket id of the session owner / admin */
    adminSocketId: string;
    /** socketId → permission level */
    socketPermissions: Map<string, SocketPermission>;
    /** All currently connected socket ids for this session */
    connectedSockets: Set<string>;
    /** Current terminal dimensions */
    terminalSize: { width: number; height: number; cols: number; rows: number };
    /** Pending timer for admin disconnect grace period */
    adminReconnectTimer?: ReturnType<typeof setTimeout>;
}

/* ─── Convenience type aliases ────────────────────────────────────────────── */

export type SocketServer = Server;
export type SocketClient = Socket;
