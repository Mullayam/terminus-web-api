import { basename, join, } from 'path';
import type { Response, Request } from 'express'
import { UploadedFile as ExpressUploadedFile } from 'express-fileupload';
import { Sftp_Service } from '@services/sftp';
import { getSocketIo } from '@/services/socket';
import { SocketEventConstants } from '@/services/socket/events';
import { createReadStream, existsSync, mkdirSync, rm, } from 'fs'
import archiver from 'archiver';
const sftp = Sftp_Service.getSftpInstance()
import progress from 'progress-stream'
import utils from '@/utils';

const uploadPath = join(process.cwd(), 'storage');
export const ABORT_CONTROLLER_MAP = new Map<string, AbortController>()
class SFTPController {
    constructor() {
        if (!existsSync(uploadPath)) {
            mkdirSync(uploadPath, { recursive: true });
        }


    }
    async handleUpload(req: Request, res: Response) {
        if (!req.files) {
            res.status(400).send('No file uploaded');
            return;
        }
        const path = req.body.path

        if (Object.keys(req.files).length > 1) {
            const dirPath = join(uploadPath);

            if (!existsSync(dirPath)) {
                mkdirSync(dirPath, { recursive: true });
            }

            for (const key in req.files) {
                const file = req.files[key] as ExpressUploadedFile;
                file.mv(dirPath + "/" + file.name, (err) => {
                    if (err) {
                        throw err
                    }
                });
            }

            await sftp.uploadDir(dirPath, path, {
                filter: (filePath: string) => {
                    if (filePath.includes('.git') || filePath.includes('node_modules')) {
                        return false
                    }
                    if (basename(filePath).includes('.git') || filePath.includes('node_modules')) {
                        return false
                    }
                    return true;
                }
            });
            res.json({ status: true, message: 'File uploaded successfully', result: path })

            rm(uploadPath, { recursive: true, force: true }, (err) => {
                if (err) {
                    getSocketIo().emit(SocketEventConstants.ERROR, err.message);
                }
            });


            getSocketIo().emit(SocketEventConstants.FILE_UPLOADED, path);
            res.end()
            return
        }
        const file = req.files.file as ExpressUploadedFile;
        const remotePath = `${path}/${file.name}`;

        try {

            const progressStream = progress({
                length: file.size,
                time: 100,
            });
            const readStream = createReadStream(file.tempFilePath);
            const streamWithProgress = readStream.pipe(progressStream);
            // Listen for progress events
            progressStream.on('progress', (progress) => {

                getSocketIo().emit(SocketEventConstants.FILE_UPLOADED_PROGRESS, {
                    percentage: `${progress.percentage.toFixed(2)}%`,
                    transferred: utils.convertBytes(progress.transferred),
                    length: utils.convertBytes(progress.length),
                    remaining: utils.convertBytes(progress.remaining),
                    eta: progress.eta,
                    runtime: progress.runtime,
                    delta: progress.delta,
                    speed: utils.convertSpeed(progress.speed)
                });

            });

            await sftp.put(streamWithProgress, remotePath);
            getSocketIo().emit(SocketEventConstants.FILE_UPLOADED, remotePath);
            res.json({ status: true, message: 'File uploaded successfully', result: remotePath })

            res.end()
            return
        } catch (err) {
            console.error('Upload Error:', err);
            res.json({ status: false, message: 'Something went wrong', result: remotePath })
            res.end()
        }
    }
    async handleDownload(req: Request, res: Response) {
        try {
            if (!Sftp_Service.is_connected) {
                throw new Error("Error in Downloading Content")
            }
            const body = req.body as {
                remotePath: string,
                type: "dir" | "file"
                name: string
            }
            if (!body.type || !body.name || !body.remotePath) {
                throw new Error("Error in Downloading Content")
            }
            const remotePath = body.remotePath
            const localPath = join(process.cwd(), 'storage', basename(remotePath))
            const abortController = new AbortController();
            ABORT_CONTROLLER_MAP.set(body.name, abortController);
            const signal = abortController.signal

            const stats = await sftp.stat(remotePath)

            if (body.type === "file") {

                const totalSize = stats.size;

                const stream = sftp.createReadStream(remotePath);

                const str = progress({
                    length: totalSize,
                    time: 1000, // emit progress every 1 second
                });

                signal.addEventListener('abort', () => {
                    str.destroy();
                    stream.destroy();
                    getSocketIo().emit(SocketEventConstants.DOWNLOAD_PROGRESS, {
                        name: body.name,
                        downloaded: str?.progress().transferred || 0,
                        totalSize,
                        percent: str?.progress().percentage.toFixed(2) || 100,
                        speed: 0,
                        eta: 0,
                        status: 'error',
                        remaining: utils.convertBytes(str?.progress()?.remaining || 0)

                    });
                    ABORT_CONTROLLER_MAP.delete(body.name);
                    try {
                        res.status(499).end('Request aborted by client.');
                    } catch (_) { }
                });

                str.on('progress', (progressData) => {
                    if (signal.aborted) return;
                    getSocketIo().emit(SocketEventConstants.DOWNLOAD_PROGRESS, {
                        name: body.name,
                        downloaded: progressData.transferred,
                        totalSize,
                        percent: Math.round(progressData.percentage),
                        speed: `${Math.round(progressData.speed / 1024)} KB/s`,
                        eta: progressData.eta,
                        status: 'downloading',
                        remaining: utils.convertBytes(progressData.remaining || 0),
                    });
                });

                str.on('end', () => {
                    if (!signal.aborted) {
                        getSocketIo().emit(SocketEventConstants.DOWNLOAD_PROGRESS, {
                            name: body.name,
                            downloaded: utils.convertBytes(str?.progress()?.transferred || totalSize),
                            totalSize,
                            percent: str?.progress().percentage.toFixed(2) || 100,
                            speed: 0,
                            eta: 0,
                            status: 'completed',
                            remaining: utils.convertBytes(str?.progress()?.remaining || 0)
                        });
                    }
                });


                stream.pipe(str).pipe(res);
                return;
            }

            else {
                let downloadedBytes = 0;
                const fileList = await sftp.list(remotePath, undefined);
                const filteredFiles = fileList.filter(
                    (file) =>
                        !file.name.includes('.git') &&
                        !file.name.includes('node_modules') &&
                        !file.name.includes('build') &&
                        !file.name.includes('dist')
                );

                const totalSize = filteredFiles.reduce((sum, file) => sum + file.size, 0);

                signal.addEventListener('abort', () => {
                    getSocketIo().emit(SocketEventConstants.DOWNLOAD_PROGRESS, {
                        name: body.name,
                        percent: 100,
                        downloaded: downloadedBytes,
                        totalSize,
                        status: 'error'
                    });
                    ABORT_CONTROLLER_MAP.delete(body.name);
                    try {
                        res.status(499).end('Request aborted by client.');
                    } catch (_) { }
                });
                res.setHeader('Content-Type', 'application/zip');
                res.setHeader('Content-Disposition', `attachment; filename="${body.name}.zip"`);

                const archive = archiver('zip', { zlib: { level: 9 } });
                archive.pipe(res);
                for await (const file of filteredFiles) {

                    const remoteFilePath = `${remotePath}/${file.name}`;
                    const fileStream = sftp.createReadStream(remoteFilePath);

                    const chunks: Buffer[] = [];

                    await new Promise<void>((resolve, reject) => {
                        fileStream.on('data', (chunk: Buffer) => {
                            if (signal.aborted) {
                                fileStream.destroy();
                                reject(new Error("Aborted"));
                                return;
                            }
                            chunks.push(chunk);
                            downloadedBytes += chunk.length;

                            const percent = Math.round((downloadedBytes / totalSize) * 100);
                            getSocketIo().emit(SocketEventConstants.DOWNLOAD_PROGRESS, {
                                name: file.name,
                                downloaded: downloadedBytes,
                                totalSize,
                                percent,
                                status: 'downloading'
                            });
                        });

                        fileStream.on('end', resolve);
                        fileStream.on('error', reject);
                    });

                    const fileBuffer = Buffer.concat(chunks);
                    archive.append(fileBuffer, { name: file.name });
                }
                archive.on('progress', (progress) => {
                    if (!signal.aborted) {
                        getSocketIo().emit(SocketEventConstants.COMPRESSING, {
                            entries: progress.entries,
                            fs: progress.fs,
                        });
                    }
                });

                archive.finalize();

                archive.on('end', () => {

                    if (!signal.aborted) {
                        getSocketIo().emit(SocketEventConstants.DOWNLOAD_PROGRESS, {
                            name: body.name,
                            downloaded: downloadedBytes,
                            totalSize,
                            percent: 100,
                            status: 'completed'
                        });
                        res.end();
                    }

                });
            }

            getSocketIo().emit(SocketEventConstants.SUCCESS, `${body.name}.zip Downloaded Successfully`);
            return
        } catch (err: any) {
            res.json({ status: false, message: err.message, result: null })
            getSocketIo().emit(SocketEventConstants.ERROR, "Error in Downloading");

        }
    }
}
export default new SFTPController()