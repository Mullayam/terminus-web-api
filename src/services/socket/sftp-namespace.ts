import SFTPClient from "ssh2-sftp-client";
import { Socket } from "socket.io";
import { RedisClientType } from "redis";
import fs from "fs";
import { join } from "path";
import AdmZip from "adm-zip";
import { Logging } from "@enjoys/express-utils/logger";
import { SocketEventConstants } from "./events";
import { Sftp_Service } from "../sftp";
import { FileOperationPayload, EditFilePayload } from "../../types/file-upload";
import { parseSSHConfig } from "./parse-ssh-config";

const E = SocketEventConstants;

/**
 * SFTP Socket Namespace  –  /sftp
 *
 * Every socket that connects to this namespace gets its **own** SFTPClient
 * instance, so a user can open multiple SFTP panels to the same or different
 * hosts simultaneously.
 *
 * Handshake query params:
 *   sessionId      : the main terminal/SSH session id (used to look up saved creds in Redis)
 *   sftpSessionId  : a client-generated UUID that uniquely identifies this SFTP panel
 *
 * ─── Client → Server ──────────────────────────────────────────────────────
 *   @@SFTP_CONNECT              { host, port?, username, authMethod, password?, privateKeyText? }
 *   @@SFTP_GET_FILE             { dirPath? }
 *   @@SFTP_RENAME_FILE          { oldPath, newPath }
 *   @@SFTP_MOVE_FILE            { oldPath, newPath }
 *   @@SFTP_COPY_FILE            { currentPath, destinationPath }
 *   @@SFTP_DELETE_FILE           { path }
 *   @@SFTP_DELETE_DIR            { path }
 *   @@SFTP_CREATE_FILE           { filePath }
 *   @@SFTP_CREATE_DIR            { folderPath }
 *   @@SFTP_EXISTS               { dirPath }
 *   @@SFTP_FILE_STATS           { path }
 *   @@SFTP_FILE_DOWNLOAD        { path }
 *   @@SFTP_ZIP_EXTRACT          { dirPath }
 *   @@SFTP_EDIT_FILE_REQUEST    { path }
 *   @@SFTP_EDIT_FILE_DONE       { path, content }
 *   @@SFTP_GET_DIR_TREE         { dirPath?, depth? }   (default depth = 2, each expand adds +2)
 *
 * ─── Server → Client ──────────────────────────────────────────────────────
 *   @@SFTP_READY                true
 *   @@SFTP_CURRENT_PATH         string
 *   @@SFTP_FILES_LIST           { files, currentDir }
 *   @@SFTP_DIR_TREE             { root, dirPath, depth }
 *   @@SFTP_EMIT_ERROR           string
 *   @@SFTP_ENDED                string
 *   @@SFTP_EDIT_FILE_REQUEST_RESPONSE  string
 *   @@SFTP_FILE_STATS           stats object
 *   @@FILE_UPLOADED             string
 *   @@SUCCESS                   string
 *   @@ERROR                     string
 */
export class SFTPNamespace {
    private sftp!: SFTPClient;
    private sessionId: string;
    private currentPath = "/";

    constructor(
        private readonly socket: Socket,
        private readonly redisClient: RedisClientType,
    ) {
        this.sessionId = (socket.handshake.query.sessionId as string) ?? "";

        if (!this.sessionId) {
            Logging.dev(`[SFTP:ns] WARNING: no sessionId in handshake for ${socket.id}`);
        }

        this.registerEvents();
    }

    /* ─── helpers ──────────────────────────────────────────────────────── */

    private getSftp(): SFTPClient {
        if (!this.sftp) throw new Error("SFTP not connected");
        return this.sftp;
    }

    /* ─── event registration ──────────────────────────────────────────── */

    private registerEvents() {
        const { socket } = this;

        // ── Connect ──────────────────────────────────────────────────────
        socket.on(E.SFTP_CONNECT, async (data: any) => {
            try {
                // Normalize: client may send a JSON string instead of an object
                if (typeof data === "string") {
                    try { data = JSON.parse(data); } catch { /* leave as-is */ }
                }

                let config: any;

                if (data && typeof data === "object" && data.host) {
                    // Explicit credentials from client
                    config = parseSSHConfig(data);
                } else {
                    // Fall back to Redis-stored creds from the main session
                    const raw = await this.redisClient.get(`sftp:${this.sessionId}`);
                    if (!raw) {
                        socket.emit(E.SFTP_EMIT_ERROR, "No stored credentials and no credentials provided");
                        return;
                    }
                    config = parseSSHConfig(raw);
                }

                const client = await Sftp_Service.connectSFTP(config, this.sessionId,socket);
                this.sftp = client;

                // Bind lifecycle events for this session
                Sftp_Service.emitSftpEvent(this.sessionId, socket);

                socket.emit(E.SFTP_READY, true);

                // Send initial listing
                this.currentPath = await client.cwd();
                const files = await client.list(this.currentPath);
                socket.emit(E.SFTP_FILES_LIST, {
                    files: JSON.stringify(files),
                    currentDir: this.currentPath,
                });
                socket.emit(E.SFTP_CURRENT_PATH, this.currentPath);

                // Store creds in Redis for reconnect / controller use
                if (data && data.host) {
                    await this.redisClient.set(
                        `sftp:${this.sessionId}`,
                        typeof data === "string" ? data : JSON.stringify(data),
                    );
                }
            } catch (err: any) {
                Logging.dev(`[SFTP:ns] connect error: ${err.message}`, "error");
                socket.emit(E.SFTP_EMIT_ERROR, "SFTP connection error: " + err.message);
            }
        });

        // ── List directory ───────────────────────────────────────────────
        socket.on(E.SFTP_GET_FILE, async (payload: FileOperationPayload): Promise<any> => {
            try {
                const sftp = this.getSftp();
                let dirPath = payload?.dirPath;
                if (!dirPath) {
                    dirPath = await sftp.cwd() as string;
                }
                this.currentPath = dirPath;
                const files = await sftp.list(dirPath);
                socket.emit(E.SFTP_FILES_LIST, {
                    files: JSON.stringify(files),
                    currentDir: dirPath,
                });
            } catch (err: any) {
                socket.emit(E.ERROR, "Error fetching files: " + err.message);
            }
        });

        // ── File exists ──────────────────────────────────────────────────
        socket.on(E.SFTP_EXISTS, async (payload: FileOperationPayload): Promise<any> => {
            try {
                const { dirPath } = payload;
                if (!dirPath) return socket.emit(E.ERROR, "Invalid directory path");
                const sftp = this.getSftp();
                const isExists = await sftp.exists(dirPath);
                if (!isExists) {
                    socket.emit(E.ERROR, "File not found");
                    return;
                }
                socket.emit(E.SFTP_FILES_LIST, isExists);
            } catch (err: any) {
                socket.emit(E.ERROR, "Error checking existence: " + err.message);
            }
        });

        // ── Copy file ────────────────────────────────────────────────────
        socket.on(E.SFTP_COPY_FILE, async (payload: { currentPath: string; destinationPath: string }): Promise<any> => {
            try {
                const { currentPath, destinationPath } = payload;
                if (!currentPath || !destinationPath) return socket.emit(E.ERROR, "Invalid path");
                const sftp = this.getSftp();
                await sftp.rcopy(currentPath, destinationPath);
                socket.emit(E.SUCCESS, "File copied successfully");
            } catch (err: any) {
                socket.emit(E.ERROR, "Error copying file: " + err.message);
            }
        });

        // ── Rename ───────────────────────────────────────────────────────
        socket.on(E.SFTP_RENAME_FILE, async (payload: FileOperationPayload): Promise<any> => {
            try {
                const { oldPath, newPath } = payload;
                if (!oldPath || !newPath) return socket.emit(E.ERROR, "Invalid file paths");
                await this.getSftp().rename(oldPath, newPath);
                socket.emit(E.SUCCESS, "File renamed successfully");
            } catch (err: any) {
                socket.emit(E.ERROR, "Error renaming file: " + err.message);
            }
        });

        // ── Move ─────────────────────────────────────────────────────────
        socket.on(E.SFTP_MOVE_FILE, async (payload: FileOperationPayload): Promise<any> => {
            try {
                const { oldPath, newPath } = payload;
                if (!oldPath || !newPath) return socket.emit(E.ERROR, "Invalid file paths");
                await this.getSftp().rename(oldPath, newPath);
                socket.emit(E.SUCCESS, "File moved successfully");
            } catch (err: any) {
                socket.emit(E.ERROR, "Error moving file: " + err.message);
            }
        });

        // ── Create file ──────────────────────────────────────────────────
        socket.on(E.SFTP_CREATE_FILE, async (payload: FileOperationPayload): Promise<any> => {
            try {
                const { filePath } = payload;
                if (!filePath) return socket.emit(E.ERROR, "Invalid file path");
                await this.getSftp().put(Buffer.from(""), filePath);
                socket.emit(E.SUCCESS, "File created successfully");
            } catch (err: any) {
                socket.emit(E.ERROR, "Error creating file: " + err.message);
            }
        });

        // ── Create directory ─────────────────────────────────────────────
        socket.on(E.SFTP_CREATE_DIR, async (payload: FileOperationPayload): Promise<any> => {
            try {
                const { folderPath } = payload;
                if (!folderPath) return socket.emit(E.ERROR, "Invalid folder path");
                await this.getSftp().mkdir(folderPath, true);
                socket.emit(E.SUCCESS, "Folder created successfully");
            } catch (err: any) {
                socket.emit(E.ERROR, "Error creating folder: " + err.message);
            }
        });

        // ── Download directory ───────────────────────────────────────────
        socket.on(E.SFTP_FILE_DOWNLOAD, async (payload: FileOperationPayload): Promise<any> => {
            try {
                const { path } = payload;
                if (!path) return socket.emit(E.ERROR, "Invalid path");
                const localDownloadPath = join(process.cwd(), "storage", "downloads");
                if (!fs.existsSync(localDownloadPath)) {
                    fs.mkdirSync(localDownloadPath, { recursive: true });
                }
                await this.getSftp().downloadDir(path, localDownloadPath);
                socket.emit(E.SUCCESS, "Folder Downloaded successfully");
            } catch (err: any) {
                socket.emit(E.ERROR, "Error Downloading folder: " + err.message);
            }
        });

        // ── File stats ───────────────────────────────────────────────────
        socket.on(E.SFTP_FILE_STATS, async (payload: FileOperationPayload): Promise<any> => {
            try {
                const { path } = payload;
                if (!path) return socket.emit(E.ERROR, "Invalid path");
                const stats = await this.getSftp().stat(path);
                socket.emit(E.SFTP_FILE_STATS, stats);
            } catch (err: any) {
                socket.emit(E.ERROR, "Error getting stats: " + err.message);
            }
        });

        // ── Delete directory ─────────────────────────────────────────────
        socket.on(E.SFTP_DELETE_DIR, async (payload: FileOperationPayload): Promise<any> => {
            try {
                const { path } = payload;
                if (!path) return socket.emit(E.ERROR, "Invalid path");
                await this.getSftp().rmdir(path);
                socket.emit(E.SUCCESS, "Deleted successfully");
            } catch (err: any) {
                socket.emit(E.ERROR, "Error deleting directory: " + err.message);
            }
        });

        // ── Delete file ──────────────────────────────────────────────────
        socket.on(E.SFTP_DELETE_FILE, async (payload: FileOperationPayload): Promise<any> => {
            try {
                const { path } = payload;
                if (!path) return socket.emit(E.ERROR, "Invalid path");
                await this.getSftp().delete(path);
                socket.emit(E.SUCCESS, "Deleted successfully");
            } catch (err: any) {
                socket.emit(E.ERROR, "Error deleting file: " + err.message);
            }
        });

      

        // ── Directory tree (dirs only, cascading depth) ──────────────────
        socket.on(E.SFTP_GET_DIR_TREE, async (payload: { dirPath?: string; depth?: number }): Promise<any> => {
            try {
                const sftp = this.getSftp();
                const dirPath = payload?.dirPath || this.currentPath || await sftp.cwd() as string;
                const depth = typeof payload?.depth === "number" && payload.depth > 0 ? payload.depth : 2;

                const tree = await this.buildDirTree(sftp, dirPath, depth);
                socket.emit(E.SFTP_DIR_TREE, { root: tree, dirPath, depth });
            } catch (err: any) {
                socket.emit(E.ERROR, "Error fetching directory tree: " + err.message);
            }
        });

        // ── Edit file — request content ──────────────────────────────────
        socket.on(E.SFTP_EDIT_FILE_REQUEST, async (payload: { path: string }): Promise<any> => {
            try {
                const { path } = payload;
                if (!path) return socket.emit(E.ERROR, "Invalid path");
                const data = await this.getSftp().get(path);
                socket.emit(E.SFTP_EDIT_FILE_REQUEST_RESPONSE, data.toString());
            } catch (err: any) {
                socket.emit(E.ERROR, err.message || "Error reading file");
            }
        });

        // ── Edit file — save content ─────────────────────────────────────
        socket.on(E.SFTP_EDIT_FILE_DONE, async (payload: EditFilePayload): Promise<any> => {
            try {
                const { path, content } = payload;
                await this.getSftp().put(Buffer.from(content), path);
                socket.emit(E.SUCCESS, "File edited successfully");
            } catch (err: any) {
                socket.emit(E.ERROR, err.message || "Error saving file");
            }
        });
          socket.on(SocketEventConstants.SFTP_ZIP_EXTRACT, async (payload: FileOperationPayload): Promise<any> => {
            try {
                let dirPath: string | undefined = payload?.dirPath
                if (!dirPath) {
                    throw new Error("Invalid directory path");
                }
                const localZipPath = join(process.cwd(), "storage");
                await this.getSftp().get(dirPath, localZipPath);
                // Step 2: Extract the ZIP file
                const zip = new AdmZip(localZipPath);
                const extractDir = join(localZipPath, 'extracted');

                zip.extractAllTo(extractDir, true);

                const extractedFiles = fs.readdirSync(extractDir);

                for (const file of extractedFiles) {
                    const localFilePath = join(extractDir, file);
                    const remoteFilePath = join(dirPath, file);

                    const fileStat = fs.statSync(localFilePath);
                    if (fileStat.isFile()) {
                        // Upload individual files
                        await this.getSftp().put(localFilePath, remoteFilePath);

                    } else if (fileStat.isDirectory()) {
                        // Handle directories if necessary (you may want to create a recursive upload function here)
                        // For simplicity, assume we skip directories in this example
                        console.log(`Skipping directory: ${file}`);
                    }
                }
                socket.emit(SocketEventConstants.FILE_UPLOADED, dirPath);

                fs.unlinkSync(localZipPath);
                fs.rmSync(extractDir, { recursive: true, force: true });


            } catch (err: any) {
                socket.emit(SocketEventConstants.ERROR, err.message);
                console.error(err);
            }
        });
        // ── Cancel upload / download ─────────────────────────────────────
        socket.on(E.CANCEL_UPLOADING, (name: string) => this.progressCancel(name));
        socket.on(E.CANCEL_DOWNLOADING, (name: string) => this.progressCancel(name));

        // ── Socket disconnect → immediate cleanup ───────────────────────
        socket.on("disconnect", async () => {
            Logging.dev(`[SFTP:ns] Client disconnected: ${socket.id}`);

            if (!this.sessionId || !this.sftp) {
                return;
            }

            await Sftp_Service.disconnect(this.sessionId);
            Logging.dev(`[SFTP:ns] SFTP torn down for ${this.sessionId}`);
        });
    }

    /**
     * Recursively list **directories only** up to `maxDepth` levels.
     *
     * Returns a tree like:
     * ```
     * { name: "src", path: "/home/user/src", children: [ … ] }
     * ```
     * Leaf nodes (at max depth) have `children: null` so the client knows
     * it can request deeper expansion via another `@@SFTP_GET_DIR_TREE`
     * call with `depth + 2`.
     */
    /** Directories to skip — heavy / non-useful folders that bloat the tree */
    private static readonly IGNORED_DIRS = new Set([
        "node_modules",
        ".git",
        ".hg",
        ".svn",
        "__pycache__",
        ".cache",
        ".npm",
        ".yarn",
        "bower_components",
        ".venv",
        "venv",
        "env",
        ".env",
        "dist",
        ".next",
        ".nuxt",
        ".turbo",
        ".parcel-cache",
        ".idea",
        ".vscode",
        "vendor",
        "coverage",
        ".tox",
        ".gradle",
        ".cargo",
        "target",
    ]);

    private async buildDirTree(
        sftp: SFTPClient,
        dirPath: string,
        maxDepth: number,
        currentDepth = 0,
    ): Promise<{ name: string; path: string; children: any[] | null }> {
        const name = dirPath.split("/").filter(Boolean).pop() || "/";
        const node: { name: string; path: string; children: any[] | null } = {
            name,
            path: dirPath,
            children: null,
        };

        if (currentDepth >= maxDepth) return node; // leaf — client can expand later

        try {
            const items = await sftp.list(dirPath);
            const dirs = items.filter(
                (i) => i.type === "d" && !SFTPNamespace.IGNORED_DIRS.has(i.name),
            );

            node.children = [];
            for (const dir of dirs) {
                const childPath = dirPath.replace(/\/$/, "") + "/" + dir.name;
                const child = await this.buildDirTree(sftp, childPath, maxDepth, currentDepth + 1);
                node.children.push(child);
            }
        } catch {
            // Permission denied or similar — treat as unexpandable leaf
            node.children = null;
        }

        return node;
    }

    private progressCancel(name: string) {
        // Re-use the global abort controller map from the SFTP controller
        try {
            const { ABORT_CONTROLLER_MAP } = require("@/handlers/controllers/sftp.controller");
            const controller = ABORT_CONTROLLER_MAP.get(name);
            if (controller) {
                controller.abort("Cancelled by user");
                ABORT_CONTROLLER_MAP.delete(name);
            }
        } catch { }
    }
}
