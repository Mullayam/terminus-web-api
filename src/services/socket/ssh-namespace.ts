import { Socket } from "socket.io";
import { RedisClientType } from "redis";
import { Logging } from "@enjoys/express-utils/logger";
import { SocketEventConstants } from "./events";
import { sshService, SSHConnectionOptions } from "../ssh";

const E = SocketEventConstants;

interface FileOperationPayload {
    dirPath?: string;
    path?: string;
    filePath?: string;
    folderPath?: string;
    oldPath?: string;
    newPath?: string;
    content?: string;
    command?: string;
    cwd?: string;
    localPath?: string;
    remotePath?: string;
}

/**
 * SSH Socket Namespace  –  /ssh
 *
 * Uses `node-ssh` to provide file operations and command execution over SSH.
 * Mirrors the SFTP namespace pattern but uses SSH exec commands under the hood.
 *
 * Handshake query params:
 *   sessionId  : unique session key (required)
 *
 * ─── Client → Server ────────────────────────────────────────────────────────
 *   @@SSH_NS_CONNECT       { host, port?, username, password?, privateKey? }
 *   @@SSH_NS_EXEC          { command, cwd? }
 *   @@SSH_NS_LIST_DIR      { dirPath }
 *   @@SSH_NS_READ_FILE     { path }
 *   @@SSH_NS_WRITE_FILE    { path, content }
 *   @@SSH_NS_MKDIR         { folderPath }
 *   @@SSH_NS_DELETE_FILE   { path }
 *   @@SSH_NS_DELETE_DIR    { path }
 *   @@SSH_NS_RENAME        { oldPath, newPath }
 *   @@SSH_NS_EXISTS        { path }
 *   @@SSH_NS_STAT          { path }
 *   @@SSH_NS_CWD           (no payload)
 *   @@SSH_NS_PUT_FILE      { localPath, remotePath }
 *   @@SSH_NS_GET_FILE      { localPath, remotePath }
 *   @@SSH_NS_DISCONNECT    (no payload)
 *
 * ─── Server → Client ────────────────────────────────────────────────────────
 *   @@SSH_NS_READY         true
 *   @@SSH_NS_ERROR         string
 *   @@SSH_NS_EXEC_RESULT   { stdout, stderr, code }
 *   @@SSH_NS_LIST_RESULT   string[]
 *   @@SSH_NS_FILE_CONTENT  string
 *   @@SSH_NS_STAT_RESULT   string
 *   @@SSH_NS_CWD_RESULT    string
 *   @@SSH_NS_EXISTS_RESULT boolean
 *   @@SUCCESS              string
 *   @@ERROR                string
 */
export class SSHNamespace {
    private sessionId: string;

    constructor(
        private readonly socket: Socket,
        private readonly redisClient: RedisClientType,
    ) {
        this.sessionId = (socket.handshake.query.sessionId as string) ?? socket.id;
        Logging.dev(`[SSH:ns] Client connected: ${socket.id} session=${this.sessionId}`);
        this.registerEvents();
    }

    private registerEvents() {
        const { socket, sessionId } = this;

        // ── Connect ──────────────────────────────────────────────────────────
        socket.on(E.SSH_NS_CONNECT, async (data: SSHConnectionOptions) => {
            try {
                if (!data?.host || !data?.username) {
                    socket.emit(E.SSH_NS_ERROR, "host and username are required");
                    return;
                }

                // Also try to load credentials from Redis if nothing explicit was given
                if (!data.password && !data.privateKey && !data.privateKeyPath) {
                    const raw = await this.redisClient.get(`sftp:${sessionId}`);
                    if (raw) {
                        const saved = JSON.parse(raw);
                        if (saved.authMethod === "password") {
                            data.password = saved.password;
                        } else if (saved.privateKeyText) {
                            data.privateKey = saved.privateKeyText;
                        }
                        data.host = data.host || saved.host;
                        data.username = data.username || saved.username;
                        data.port = data.port || +saved.port || 22;
                    }
                }

                await sshService.connect(sessionId, data);
                socket.emit(E.SSH_NS_READY, true);
            } catch (err: any) {
                Logging.dev(`[SSH:ns] connect error: ${err.message}`, "error");
                socket.emit(E.SSH_NS_ERROR, `Connection failed: ${err.message}`);
            }
        });

        // ── Execute command ──────────────────────────────────────────────────
        socket.on(E.SSH_NS_EXEC, async (payload: FileOperationPayload) => {
            try {
                const { command, cwd } = payload;
                if (!command) {
                    socket.emit(E.ERROR, "command is required");
                    return;
                }
                const result = await sshService.exec(sessionId, command, cwd);
                socket.emit(E.SSH_NS_EXEC_RESULT, {
                    stdout: result.stdout,
                    stderr: result.stderr,
                    code: result.code,
                });
            } catch (err: any) {
                socket.emit(E.ERROR, err.message);
            }
        });

        // ── List directory ───────────────────────────────────────────────────
        socket.on(E.SSH_NS_LIST_DIR, async (payload: FileOperationPayload) => {
            try {
                const dirPath = payload?.dirPath || "/";
                const files = await sshService.listDir(sessionId, dirPath);
                socket.emit(E.SSH_NS_LIST_RESULT, { files, currentDir: dirPath });
            } catch (err: any) {
                socket.emit(E.ERROR, `Error listing directory: ${err.message}`);
            }
        });

        // ── Read file ────────────────────────────────────────────────────────
        socket.on(E.SSH_NS_READ_FILE, async (payload: FileOperationPayload) => {
            try {
                const { path } = payload;
                if (!path) {
                    socket.emit(E.ERROR, "path is required");
                    return;
                }
                const content = await sshService.readFile(sessionId, path);
                socket.emit(E.SSH_NS_FILE_CONTENT, { path, content });
            } catch (err: any) {
                socket.emit(E.ERROR, `Error reading file: ${err.message}`);
            }
        });

        // ── Write file ───────────────────────────────────────────────────────
        socket.on(E.SSH_NS_WRITE_FILE, async (payload: FileOperationPayload) => {
            try {
                const { path, content } = payload;
                if (!path || content === undefined) {
                    socket.emit(E.ERROR, "path and content are required");
                    return;
                }
                await sshService.writeFile(sessionId, path, content);
                socket.emit(E.SUCCESS, "File written successfully");
            } catch (err: any) {
                socket.emit(E.ERROR, `Error writing file: ${err.message}`);
            }
        });

        // ── Create directory ─────────────────────────────────────────────────
        socket.on(E.SSH_NS_MKDIR, async (payload: FileOperationPayload) => {
            try {
                const folderPath = payload?.folderPath;
                if (!folderPath) {
                    socket.emit(E.ERROR, "folderPath is required");
                    return;
                }
                await sshService.mkdir(sessionId, folderPath);
                socket.emit(E.SUCCESS, "Directory created successfully");
            } catch (err: any) {
                socket.emit(E.ERROR, `Error creating directory: ${err.message}`);
            }
        });

        // ── Delete file ──────────────────────────────────────────────────────
        socket.on(E.SSH_NS_DELETE_FILE, async (payload: FileOperationPayload) => {
            try {
                const { path } = payload;
                if (!path) {
                    socket.emit(E.ERROR, "path is required");
                    return;
                }
                await sshService.deleteFile(sessionId, path);
                socket.emit(E.SUCCESS, "File deleted successfully");
            } catch (err: any) {
                socket.emit(E.ERROR, `Error deleting file: ${err.message}`);
            }
        });

        // ── Delete directory ─────────────────────────────────────────────────
        socket.on(E.SSH_NS_DELETE_DIR, async (payload: FileOperationPayload) => {
            try {
                const { path } = payload;
                if (!path) {
                    socket.emit(E.ERROR, "path is required");
                    return;
                }
                await sshService.deleteDir(sessionId, path);
                socket.emit(E.SUCCESS, "Directory deleted successfully");
            } catch (err: any) {
                socket.emit(E.ERROR, `Error deleting directory: ${err.message}`);
            }
        });

        // ── Rename / move ────────────────────────────────────────────────────
        socket.on(E.SSH_NS_RENAME, async (payload: FileOperationPayload) => {
            try {
                const { oldPath, newPath } = payload;
                if (!oldPath || !newPath) {
                    socket.emit(E.ERROR, "oldPath and newPath are required");
                    return;
                }
                await sshService.rename(sessionId, oldPath, newPath);
                socket.emit(E.SUCCESS, "Renamed successfully");
            } catch (err: any) {
                socket.emit(E.ERROR, `Error renaming: ${err.message}`);
            }
        });

        // ── Exists ───────────────────────────────────────────────────────────
        socket.on(E.SSH_NS_EXISTS, async (payload: FileOperationPayload) => {
            try {
                const { path } = payload;
                if (!path) {
                    socket.emit(E.ERROR, "path is required");
                    return;
                }
                const exists = await sshService.exists(sessionId, path);
                socket.emit(E.SSH_NS_EXISTS_RESULT, exists);
            } catch (err: any) {
                socket.emit(E.ERROR, `Error checking existence: ${err.message}`);
            }
        });

        // ── Stat ─────────────────────────────────────────────────────────────
        socket.on(E.SSH_NS_STAT, async (payload: FileOperationPayload) => {
            try {
                const { path } = payload;
                if (!path) {
                    socket.emit(E.ERROR, "path is required");
                    return;
                }
                const stats = await sshService.stat(sessionId, path);
                socket.emit(E.SSH_NS_STAT_RESULT, stats);
            } catch (err: any) {
                socket.emit(E.ERROR, `Error getting stats: ${err.message}`);
            }
        });

        // ── CWD ──────────────────────────────────────────────────────────────
        socket.on(E.SSH_NS_CWD, async () => {
            try {
                const cwd = await sshService.cwd(sessionId);
                socket.emit(E.SSH_NS_CWD_RESULT, cwd);
            } catch (err: any) {
                socket.emit(E.ERROR, `Error getting cwd: ${err.message}`);
            }
        });

        // ── Put file (upload) ────────────────────────────────────────────────
        socket.on(E.SSH_NS_PUT_FILE, async (payload: FileOperationPayload) => {
            try {
                const { localPath, remotePath } = payload;
                if (!localPath || !remotePath) {
                    socket.emit(E.ERROR, "localPath and remotePath are required");
                    return;
                }
                await sshService.putFile(sessionId, localPath, remotePath);
                socket.emit(E.SUCCESS, "File uploaded successfully");
            } catch (err: any) {
                socket.emit(E.ERROR, `Error uploading file: ${err.message}`);
            }
        });

        // ── Get file (download) ──────────────────────────────────────────────
        socket.on(E.SSH_NS_GET_FILE, async (payload: FileOperationPayload) => {
            try {
                const { localPath, remotePath } = payload;
                if (!localPath || !remotePath) {
                    socket.emit(E.ERROR, "localPath and remotePath are required");
                    return;
                }
                await sshService.getFile(sessionId, localPath, remotePath);
                socket.emit(E.SUCCESS, "File downloaded successfully");
            } catch (err: any) {
                socket.emit(E.ERROR, `Error downloading file: ${err.message}`);
            }
        });

        // ── Disconnect ───────────────────────────────────────────────────────
        socket.on(E.SSH_NS_DISCONNECT, async () => {
            await sshService.disconnect(sessionId);
            socket.emit(E.SUCCESS, "SSH disconnected");
        });

        // ── Socket disconnect → cleanup ──────────────────────────────────────
        socket.on("disconnect", async () => {
            Logging.dev(`[SSH:ns] Client disconnected: ${socket.id}`);
            await sshService.disconnect(sessionId);
        });
    }
}
