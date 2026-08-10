import { basename, dirname, isAbsolute, join, posix, relative, resolve } from "path";
import type { Response, Request } from "express";
import { UploadedFile as ExpressUploadedFile } from "express-fileupload";
import { Sftp_Service } from "@services/sftp";
import { getSocketIo } from "@/services/socket";
import { SocketEventConstants } from "@/services/socket/events";
import { createReadStream, createWriteStream, existsSync, mkdirSync, promises as fsp } from "fs";
import { pipeline } from "stream/promises";
import { createGunzip } from "zlib";
import os from "os";
import AdmZip from "adm-zip";
import * as tar from "tar";
import archiver from "archiver";
import progress from "progress-stream";
import utils from "@/utils";
import type SFTPClient from "ssh2-sftp-client";
import type { Socket } from "socket.io";

/** Emit to the panel's own /sftp socket when available, else broadcast. */
type Emit = (event: string, payload: unknown) => void;
const makeEmit = (socket?: Socket): Emit =>
    (event, payload) => (socket ? socket.emit(event, payload) : getSocketIo().emit(event, payload));


/**
 * Resolve the SFTPClient for a given session.
 * Looks for `sftpSessionId` first, falls back to `sessionId`.
 */
const getSftp = (req: Request) => {
    const id = (req.body?.sftpSessionId ?? req.query?.sftpSessionId ??
        req.body?.sessionId ?? req.query?.sessionId) as string | undefined;
    if (!id) throw new Error("sftpSessionId or sessionId is required");
    const client = Sftp_Service.getSession(id);
    if (!client) throw new Error(`No SFTP session found for id: ${id}`);
    return client;
};
const getSftpSocket = (req: Request) => {
    const id = (req.body?.sftpSessionId ?? req.query?.sftpSessionId ??
        req.body?.sessionId ?? req.query?.sessionId) as string | undefined;
    if (!id) throw new Error("sftpSessionId or sessionId is required");
    const socket = Sftp_Service.getSftpSocket(id);
    if (!socket) return undefined;
    return socket;
};
const uploadPath = join(process.cwd(), "storage");
export const ABORT_CONTROLLER_MAP = new Map<string, AbortController>();

const EXCLUDED_NAMES = [".git", "node_modules", "build", "dist"];

/**
 * Recursively walk a remote directory and return all *file* entries
 * with their path relative to `baseDir`.
 */
async function walkRemoteDir(
    sftp: SFTPClient,
    dir: string,
    baseDir: string,
    signal?: AbortSignal,
): Promise<{ remotePath: string; relativePath: string; size: number }[]> {
    const results: { remotePath: string; relativePath: string; size: number }[] = [];
    const entries = await sftp.list(dir, (info) =>
        !EXCLUDED_NAMES.some((ex) => info.name === ex),
    );
    for (const entry of entries) {
        if (signal?.aborted) break;
        const fullPath = posix.join(dir, entry.name);
        const relPath = posix.relative(baseDir, fullPath);
        if (entry.type === "d") {
            const nested = await walkRemoteDir(sftp, fullPath, baseDir, signal);
            results.push(...nested);
        } else if (entry.type === "-" || entry.type === "l") {
            results.push({ remotePath: fullPath, relativePath: relPath, size: entry.size });
        }
    }
    return results;
}

/** Supported server-side extractable archives. */
const ARCHIVE_RE = /\.(zip|tar\.gz|tgz|gz)$/i;
const isArchive = (name: string) => ARCHIVE_RE.test(name);

/** Normalise a client-supplied relative path and strip any traversal. */
function sanitizeRelativePath(input: string): string {
    const segments = input
        .replace(/\\/g, "/")
        .split("/")
        .filter((s) => s && s !== "." && s !== "..");
    return segments.join("/") || "file";
}

/** True when `child` resolves to a location inside `parent` (blocks zip-slip). */
function isPathInside(parent: string, child: string): boolean {
    const rel = relative(resolve(parent), resolve(child));
    return !!rel && !rel.startsWith("..") && !isAbsolute(rel);
}

/**
 * Collect uploaded files into a flat list, pairing each with its relative
 * path. Folder uploads send a `paths` JSON array (same order as the files);
 * loose uploads fall back to the file name.
 */
function collectUploadFiles(
    req: Request,
): { file: ExpressUploadedFile; relativePath: string }[] {
    const files: ExpressUploadedFile[] = [];
    for (const key of Object.keys(req.files ?? {})) {
        const val = (req.files as Record<string, ExpressUploadedFile | ExpressUploadedFile[]>)[key];
        if (Array.isArray(val)) files.push(...val);
        else files.push(val);
    }

    let paths: string[] = [];
    const rawPaths = req.body?.paths;
    if (rawPaths) {
        try {
            const parsed = typeof rawPaths === "string" ? JSON.parse(rawPaths) : rawPaths;
            if (Array.isArray(parsed)) paths = parsed.map((p) => String(p));
        } catch {
            paths = [];
        }
    }

    return files.map((file, i) => ({
        file,
        relativePath: sanitizeRelativePath(paths[i] ?? file.name),
    }));
}

/**
 * Extract a supported archive (`.zip`, `.tar.gz`, `.tgz`, `.gz`) into
 * `destDir`, guarding against path-traversal (zip-slip) entries.
 */
async function extractArchive(file: ExpressUploadedFile, destDir: string): Promise<void> {
    const name = file.name.toLowerCase();
    await fsp.mkdir(destDir, { recursive: true });

    if (name.endsWith(".zip")) {
        const zip = new AdmZip(file.tempFilePath);
        for (const entry of zip.getEntries()) {
            const target = join(destDir, entry.entryName);
            if (!isPathInside(destDir, target)) {
                throw new Error(`Unsafe path in archive: ${entry.entryName}`);
            }
            if (entry.isDirectory) {
                await fsp.mkdir(target, { recursive: true });
            } else {
                await fsp.mkdir(dirname(target), { recursive: true });
                await fsp.writeFile(target, entry.getData());
            }
        }
        return;
    }

    if (name.endsWith(".tar.gz") || name.endsWith(".tgz")) {
        // `tar` strips absolute paths and `..` entries by default.
        await tar.x({ file: file.tempFilePath, cwd: destDir });
        return;
    }

    if (name.endsWith(".gz")) {
        // Plain single-file gzip → strip the `.gz` suffix.
        const outName = basename(file.name).replace(/\.gz$/i, "") || "file";
        await pipeline(
            createReadStream(file.tempFilePath),
            createGunzip(),
            createWriteStream(join(destDir, outName)),
        );
        return;
    }

    throw new Error(`Unsupported archive type: ${file.name}`);
}

/** Recursively list files under `dir`, with paths relative to `baseDir`. */
async function walkLocalDir(
    dir: string,
    baseDir: string,
): Promise<{ localPath: string; relativePath: string; size: number }[]> {
    const out: { localPath: string; relativePath: string; size: number }[] = [];
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
            out.push(...(await walkLocalDir(full, baseDir)));
        } else if (entry.isFile()) {
            const st = await fsp.stat(full);
            out.push({
                localPath: full,
                relativePath: relative(baseDir, full).replace(/\\/g, "/"),
                size: st.size,
            });
        }
    }
    return out;
}

/**
 * Upload a set of local files to `remoteBase`, recreating their directory
 * structure remotely and emitting aggregate progress under `label`.
 */
async function uploadFileTree(
    sftp: SFTPClient,
    items: { localPath: string; relativePath: string; size: number }[],
    remoteBase: string,
    label: string,
    signal: AbortSignal,
    emit: Emit,
): Promise<void> {
    const totalSize = items.reduce((s, f) => s + f.size, 0);
    const start = Date.now();
    const createdDirs = new Set<string>();
    let uploaded = 0;

    for (const item of items) {
        if (signal.aborted) throw new Error("Upload aborted by client");

        const remotePath = posix.join(remoteBase, item.relativePath);
        const remoteDir = posix.dirname(remotePath);
        if (remoteDir && !createdDirs.has(remoteDir)) {
            await sftp.mkdir(remoteDir, true).catch(() => { });
            createdDirs.add(remoteDir);
        }

        const ps = progress({ length: item.size, time: 500 });
        ps.on("progress", (p) => {
            const transferred = uploaded + p.transferred;
            const elapsed = (Date.now() - start) / 1000;
            const speed = elapsed > 0 ? transferred / elapsed : 0;
            emit(SocketEventConstants.FILE_UPLOADED_PROGRESS, {
                name: label,
                file: item.relativePath,
                percent: totalSize ? ((transferred / totalSize) * 100).toFixed(2) : "100.00",
                transferred,
                totalSize,
                remaining: utils.convertBytes(Math.max(totalSize - transferred, 0)),
                eta: speed > 0 ? Math.round((totalSize - transferred) / speed) : 0,
                speed: utils.convertSpeed(speed),
                status: "uploading",
            });
        });

        await sftp.put(createReadStream(item.localPath).pipe(ps), remotePath);
        uploaded += item.size;
    }

    emit(SocketEventConstants.FILE_UPLOADED_PROGRESS, {
        name: label,
        percent: "100.00",
        transferred: totalSize,
        totalSize,
        remaining: utils.convertBytes(0),
        eta: 0,
        speed: utils.convertSpeed(0),
        status: "completed",
    });
}

class SFTPController {
    constructor() {
        if (!existsSync(uploadPath)) {
            mkdirSync(uploadPath, { recursive: true });
        }
    }

    async handleFileWrite(req: Request, res: Response) {
        try {
            const body = req.body as {
                sessionId: string;
                sftpSessionId?: string;
                path: string;
                content: string;
            };
            const id = body.sftpSessionId ?? body.sessionId;
            const client = Sftp_Service.getSession(id);
            if (!client) {
                res.status(404).json({ status: false, message: `No SFTP session: ${id}`, result: null });
                return;
            }
            await client.put(Buffer.from(body.content), body.path);
            res.json({ status: true, message: "File written successfully", result: null });
        } catch (error: any) {
            res.status(500).json({ status: false, message: error.message || "Error writing file", result: null });
        }
    }
    async handleFileRead(req: Request, res: Response) {
        try {
            const body = req.body as {
                path: string;
                sessionId: string;
                sftpSessionId?: string;
            };
            const id = body.sftpSessionId ?? body.sessionId;
            const client = Sftp_Service.getSession(id);
            if (!client) {
                res.status(404).json({ status: false, message: `No SFTP session: ${id}`, result: null });
                return;
            }
            const data = await client.get(body.path);
            res.json({ status: true, message: "File read successfully", result: data.toString() });
        } catch (error: any) {
            res.status(500).json({ status: false, message: error.message || "Error reading file", result: null });
        }
    }

    async handleUpload(req: Request, res: Response) {
        const abortController = new AbortController();
        const uploadId = Date.now().toString();
        const signal = abortController.signal;

        if (!req.files || Object.keys(req.files).length === 0) {
            res.status(400).json({ status: false, message: "No file uploaded", result: null });
            return;
        }

        const path = req.body.path;
        if (!path) {
            res.status(400).json({ status: false, message: "Destination path is required", result: null });
            return;
        }

        const items = collectUploadFiles(req);
        // Cancellable via CANCEL_UPLOADING using this name.
        const cancelKey = (req.body.name as string) || items[0]?.file.name || uploadId;
        ABORT_CONTROLLER_MAP.set(cancelKey, abortController);

        // A single archive file → extract on the server, then upload contents.
        const isSingleArchive = items.length === 1 && isArchive(items[0].file.name);
        // A folder / multi-file upload where structure must be preserved.
        const isStructured =
            items.length > 1 || items.some((it) => it.relativePath.includes("/"));

        try {
            const sftp = getSftp(req);
            const socket = getSftpSocket(req);
            const emit = makeEmit(socket);

            // ── Archive upload → extract on server, preserving folders ──────
            if (isSingleArchive) {
                const file = items[0].file;
                const tmpDir = join(os.tmpdir(), `sftp-extract-${uploadId}`);
                emit(SocketEventConstants.EXTRACTING, {
                    name: file.name,
                    status: "extracting",
                    percent: "0.00",
                    transferred: 0,
                    totalSize: file.size,
                    remaining: utils.convertBytes(file.size),
                    eta: 0,
                    speed: utils.convertSpeed(0),
                });
                try {
                    await extractArchive(file, tmpDir);
                    const tree = await walkLocalDir(tmpDir, tmpDir);
                    await uploadFileTree(sftp, tree, path, file.name, signal, emit);
                    emit(SocketEventConstants.FILE_UPLOADED, path);
                    res.json({
                        status: true,
                        message: "Archive extracted & uploaded successfully",
                        result: path,
                    });
                } finally {
                    await fsp.rm(tmpDir, { recursive: true, force: true }).catch(() => { });
                }
                return;
            }

            // ── Folder / multi-file upload (directory structure preserved) ──
            if (isStructured) {
                const tree = items.map((it) => ({
                    localPath: it.file.tempFilePath,
                    relativePath: it.relativePath,
                    size: it.file.size,
                }));
                await uploadFileTree(sftp, tree, path, (req.body.name as string) || "folder", signal, emit);
                emit(SocketEventConstants.FILE_UPLOADED, path);
                res.json({
                    status: true,
                    message: "Files uploaded successfully",
                    result: path,
                });
                return;
            }

            const file = items[0].file;
            const remotePath = posix.join(path, file.name);

            const progressStream = progress({
                length: file.size,
                time: 500,
            });

            const readStream = createReadStream(file.tempFilePath);
            const streamWithProgress = readStream.pipe(progressStream);

            // Abort handling
            signal.addEventListener("abort", () => {
                readStream.destroy();
                emit(SocketEventConstants.FILE_UPLOADED_PROGRESS, {
                    name: file.name,
                    percent: progressStream.progress().percentage.toFixed(2) || 100,
                    transferred: progressStream.progress().transferred || 0,
                    remaining: utils.convertBytes(
                        progressStream.progress().remaining || file.size || 0,
                    ),
                    totalSize: file.size,
                    eta: 0,
                    speed: utils.convertSpeed(progressStream.progress().speed || 0),
                    status: "error",
                });
                res.status(499).end("Upload aborted by client");
            });

            progressStream.on("progress", (progress) => {
                emit(SocketEventConstants.FILE_UPLOADED_PROGRESS, {
                    percent: progress.percentage.toFixed(2),
                    transferred: progress.transferred || 0,
                    totalSize: file.size,
                    remaining: utils.convertBytes(progress.remaining || file.size || 0),
                    eta: progress.eta,
                    speed: utils.convertSpeed(progress.speed),
                    status: "uploading",
                    name: file.name,
                });
            });

            await getSftp(req).put(streamWithProgress, remotePath);
            emit(SocketEventConstants.FILE_UPLOADED_PROGRESS, {
                percent: 100,
                transferred: progressStream.progress().transferred || 0,
                totalSize: file.size,
                remaining: utils.convertBytes(
                    progressStream.progress().remaining || file.size || 0,
                ),
                eta: 0,
                speed: utils.convertSpeed(progressStream.progress().speed || 0),
                status: "completed",
                name: file.name,
            });
            emit(SocketEventConstants.FILE_UPLOADED, remotePath);

            res.json({
                status: true,
                message: "File uploaded successfully",
                result: remotePath,
            });
        } catch (err: any) {
            console.error("Upload Error:", err);
            if (!res.headersSent) {
                res.status(500).json({
                    status: false,
                    message: "Something went wrong",
                    result: null,
                    error: err.message,
                });
            }
        } finally {
            ABORT_CONTROLLER_MAP.delete(cancelKey);
        }
    }

    async handleDownload(req: Request, res: Response) {
        try {

            const body = req.body as {
                remotePath: string;
                type: "dir" | "file";
                name: string;
            };
            if (!body.type || !body.name || !body.remotePath) {
                throw new Error("Error in Downloading Content");
            }
            const remotePath = body.remotePath;
            const sftp = getSftp(req);
            if (!sftp) {
                throw new Error("SFTP client not available");
            }

            const socket = getSftpSocket(req);
             socket?.emit(SocketEventConstants.STARTING, {
                name: body.name,
                transferred: 0,
                totalSize:0,
                percent: 100,
                status: "preparing",
                speed: 0,
                eta: 0,
                remaining: utils.convertBytes(0),
            });
            const abortController = new AbortController();
            ABORT_CONTROLLER_MAP.set(body.name, abortController);

            const signal = abortController.signal;

            const stats = await sftp.stat(remotePath);
           
            if (body.type === "file") {
                const totalSize = stats.size;
                 socket?.emit(SocketEventConstants.PREPARING, {
                name: body.name,
                transferred: 0,
                totalSize,
                percent: 100,
                status: "preparing",
                speed: 0,
                eta: 0,
                remaining: utils.convertBytes(totalSize),
            }
            );
                const stream = sftp.createReadStream(remotePath, {
                    signal: signal,
                });

                res.setHeader("Content-Type", "application/octet-stream");
                res.setHeader(
                    "Content-Disposition",
                    `attachment; filename="${body.name}"`,
                );
                res.setHeader("Content-Length", totalSize);

                const str = progress({
                    length: totalSize,
                    time: 1000, // emit progress every 1 second
                });

                signal.addEventListener("abort", () => {
                    console.log("triggered");
                    str.destroy();
                    stream.destroy();
                    socket?.emit(SocketEventConstants.DOWNLOAD_PROGRESS, {
                        name: body.name,
                        transferred: str?.progress().transferred || 0,
                        totalSize,
                        percent: str?.progress().percentage.toFixed(2) || 100,
                        speed: utils.convertSpeed(str?.progress().speed || 0),
                        eta: 0,
                        status: "error",
                        remaining: utils.convertBytes(str?.progress()?.remaining || 0),
                    });
                    ABORT_CONTROLLER_MAP.delete(body.name);
                    try {
                        res.status(499).end("Request aborted by client.");
                    } catch (_) { }
                });

                str.on("progress", (progressData) => {
                    if (signal.aborted) return;
                    socket?.emit(SocketEventConstants.DOWNLOAD_PROGRESS, {
                        name: body.name,
                        transferred: progressData.transferred,
                        totalSize,
                        percent: progressData.percentage.toFixed(2),
                        speed: utils.convertSpeed(progressData.speed),
                        eta: progressData.eta,
                        status: "downloading",
                        remaining: utils.convertBytes(progressData.remaining || 0),
                    });
                });

                str.on("end", () => {
                    if (!signal.aborted) {
                        socket?.emit(SocketEventConstants.DOWNLOAD_PROGRESS, {
                            name: body.name,
                            transferred: str?.progress()?.transferred || totalSize,
                            totalSize,
                            percent: str?.progress().percentage.toFixed(2) || 100,
                            speed: utils.convertSpeed(str?.progress().speed || 0),
                            eta: 0,
                            status: "completed",
                            remaining: utils.convertBytes(str?.progress()?.remaining || 0),
                        });
                    }
                });

                stream.pipe(str).pipe(res);
                return;
            } else {

                // Recursively collect all files in the directory tree
                const fileList = await walkRemoteDir(sftp, remotePath, remotePath, signal);

                const totalSize = fileList.reduce((sum, f) => sum + f.size, 0);
                socket?.emit(SocketEventConstants.DOWNLOAD_PROGRESS, {
                    name: body.name,
                    transferred: 0,
                    totalSize,
                    percent: 0,
                    speed: 0,
                    eta: 0,
                    remaining: utils.convertBytes(totalSize - 0),
                    status: "starting",
                });
                // setup headers
                res.setHeader("Content-Type", "application/zip");
                res.setHeader(
                    "Content-Disposition",
                    `attachment; filename="${body.name}.zip"`,
                );

                // // setup archiver
                const archive = archiver("zip", { zlib: { level: 9 } });
                archive.pipe(res);

                let downloaded = 0;

                signal.addEventListener("abort", () => {
                    socket?.emit(SocketEventConstants.DOWNLOAD_PROGRESS, {
                        name: body.name,
                        transferred: downloaded,
                        totalSize,
                        percent: ((downloaded / totalSize) * 100).toFixed(2),
                        speed: utils.convertBytes(totalSize - downloaded) || 0,
                        eta: 0,
                        remaining: utils.convertBytes(totalSize - downloaded),
                        status: "error",
                    });

                    ABORT_CONTROLLER_MAP.delete(body.name);

                    try {
                        res.status(499).end("Request aborted by client.");
                    } catch (_) { }
                    archive.abort();
                });

                // // Append all files to archive with individual progress-stream
                for (const file of fileList) {
                    if (signal.aborted) break;
                    const fileProgress = progress({ length: file.size, time: 1000 });
                    const readStream = sftp.createReadStream(file.remotePath, {
                        autoClose: true,
                        autoDestroy: true,
                        signal: signal,
                    });
                    readStream.on("error", (err: any) => {
                        signal.dispatchEvent(new Event("abort"));
                        socket?.emit(SocketEventConstants.ERROR, `Error reading file ${file.remotePath}: ${err.message}`);

                    });
                    fileProgress.on("progress", (p) => {
                        downloaded += p.delta;
                        socket?.emit(SocketEventConstants.DOWNLOAD_PROGRESS, {
                            name: body.name,
                            transferred: downloaded,
                            totalSize,
                            percent: ((downloaded / totalSize) * 100).toFixed(2),
                            speed: utils.convertSpeed(p.speed),
                            eta: p.eta,
                            remaining: utils.convertBytes(totalSize - downloaded),
                            status: "downloading",
                        });
                    });

                    // Use relativePath to preserve directory structure inside the zip
                    archive.append(readStream.pipe(fileProgress), { name: file.relativePath });
                }

                archive.on("progress", (progress) => {
                    if (!signal.aborted) {
                        socket?.emit(SocketEventConstants.COMPRESSING, {
                            name: body.name,
                            transferred: downloaded,
                            totalSize,
                            percent: 100,
                            status: "compressing",
                            speed: 0,
                            eta: 0,
                            remaining: utils.convertBytes(totalSize - downloaded),
                        }
                        );
                    }
                });

                archive.finalize();

                archive.on("end", () => {
                    if (!signal.aborted) {
                        socket?.emit(SocketEventConstants.DOWNLOAD_PROGRESS, {
                            name: body.name,
                            transferred: downloaded,
                            totalSize,
                            percent: 100,
                            status: "completed",
                            speed: 0,
                            eta: 0,
                            remaining: utils.convertBytes(totalSize - downloaded),
                        });
                        socket?.emit(
                            SocketEventConstants.SUCCESS,
                            `${body.name}.zip Downloaded Successfully`,
                        );
                    }
                });

                return;
            }

            return;
        } catch (err: any) {
            if (!res.headersSent) {
                res.json({ status: false, message: err.message, result: null });
            }

        }
    }

    async handleLoadFilesAndDir(req: Request, res: Response) {
        try {
            const body = req.body as {
                path: string;
                sessionId: string;
                sftpSessionId?: string;
            };
            const sftp = getSftp(req);
            const dirPath = body.path || await sftp.cwd() as string;

            const IGNORED_NAMES = new Set([
                "node_modules", ".git", ".hg", ".svn",
                "__pycache__", ".cache", ".npm", ".yarn",
                "bower_components", ".venv", "venv", "env",
                ".env", "dist", "build", ".next", ".nuxt",
                ".turbo", ".parcel-cache", ".idea", ".vscode",
                "vendor", "coverage", ".tox", ".gradle",
                ".cargo", "target", ".DS_Store", "Thumbs.db",
                ".sass-cache", ".output", ".docusaurus",
            ]);

            const entries = await sftp.list(dirPath);

            const filtered = entries
                .filter((entry) => !IGNORED_NAMES.has(entry.name))
                .map((entry) => ({
                    name: entry.name,
                    type: entry.type,
                    size: entry.size,
                    modifyTime: entry.modifyTime,
                    accessTime: entry.accessTime,
                    rights: entry.rights,
                    owner: entry.owner,
                    group: entry.group,
                    path: posix.join(dirPath, entry.name),
                }));

            res.json({
                status: true,
                message: "Files loaded successfully",
                result: {
                    currentDir: dirPath,
                    files: filtered,
                },
            });
        } catch (err: any) {
            res.status(500).json({ status: false, message: err.message || "Error loading files", result: null });
        }
    }
}
export default new SFTPController();
