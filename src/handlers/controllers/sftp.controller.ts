import { basename, join, posix } from "path";
import type { Response, Request } from "express";
import { UploadedFile as ExpressUploadedFile } from "express-fileupload";
import { Sftp_Service } from "@services/sftp";
import { getSocketIo } from "@/services/socket";
import { SocketEventConstants } from "@/services/socket/events";
import { createReadStream, existsSync, mkdirSync, rm } from "fs";
import archiver from "archiver";
import progress from "progress-stream";
import utils from "@/utils";
import type SFTPClient from "ssh2-sftp-client";


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
        ABORT_CONTROLLER_MAP.set(uploadId, abortController);
        const signal = abortController.signal;

        if (!req.files) {
            res.status(400).send("No file uploaded");
            return;
        }

        const path = req.body.path;
        const isMultiFile = Object.keys(req.files).length > 1;

        try {
            if (isMultiFile) {
                const dirPath = join(uploadPath);

                if (!existsSync(dirPath)) {
                    mkdirSync(dirPath, { recursive: true });
                }

                // Save all files temporarily
                for (const key in req.files) {
                    const file = req.files[key] as ExpressUploadedFile;
                    await new Promise((resolve, reject) => {
                        file.mv(`${dirPath}/${file.name}`, (err) => {
                            if (err) return reject(err);
                            resolve(null);
                        });
                    });
                }

                // Upload directory with filter
                await getSftp(req).uploadDir(dirPath, path, {
                    filter: (filePath: string) => {
                        const name = basename(filePath);
                        return (
                            !filePath.includes(".git") &&
                            !filePath.includes("node_modules") &&
                            !name.startsWith(".")
                        );
                    },
                });

                // Notify completion
                getSocketIo().emit(SocketEventConstants.FILE_UPLOADED, path);

                res.json({
                    status: true,
                    message: "Files uploaded successfully",
                    result: path,
                });

                // Cleanup
                rm(uploadPath, { recursive: true, force: true }, (err) => {
                    if (err) {
                        getSocketIo().emit(SocketEventConstants.ERROR, err.message);
                    }
                });

                return;
            }

            const file = req.files.file as ExpressUploadedFile;
            const remotePath = `${path}/${file.name}`;

            const progressStream = progress({
                length: file.size,
                time: 500,
            });

            const readStream = createReadStream(file.tempFilePath);
            const streamWithProgress = readStream.pipe(progressStream);

            // Abort handling
            signal.addEventListener("abort", () => {
                readStream.destroy();
                getSocketIo().emit(SocketEventConstants.FILE_UPLOADED_PROGRESS, {
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
                getSocketIo().emit(SocketEventConstants.FILE_UPLOADED_PROGRESS, {
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
            getSocketIo().emit(SocketEventConstants.FILE_UPLOADED_PROGRESS, {
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
            getSocketIo().emit(SocketEventConstants.FILE_UPLOADED, remotePath);

            res.json({
                status: true,
                message: "File uploaded successfully",
                result: remotePath,
            });
        } catch (err: any) {
            console.error("Upload Error:", err);
            res.status(500).json({
                status: false,
                message: "Something went wrong",
                result: null,
                error: err.message,
            });
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
}
export default new SFTPController();
