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
import { Readable } from 'stream';
import Busboy from 'busboy';

const uploadPath = join(process.cwd(), 'storage');
export const ABORT_CONTROLLER_MAP = new Map<string, AbortController>()
class SFTPController {
    constructor() {
        if (!existsSync(uploadPath)) {
            mkdirSync(uploadPath, { recursive: true });
        }


    }


    // async handleStreamUpload(req: Request, res: Response) {
    //     // const signal = req.signal as AbortSignal;
    //     const busboy = Busboy({ headers: req.headers });
    //     let uploadedFileCount = 0;

    //     let uploadPath = '';

    //     busboy.on('field', (fieldname, val) => {
    //         if (fieldname === 'path') {
    //             uploadPath = val;
    //         }
    //     });

    //     busboy.on('file', async (fieldname, file, filename, encoding, mimetype) => {
    //         const remotePath = join(uploadPath, filename);
    //         let totalSize = 0;

    //         file.on('data', (chunk) => totalSize += chunk.length);

    //         const progressStream = progress({ time: 500 });
    //         const wrappedStream = file.pipe(progressStream);

    //         progressStream.on('progress', (prog) => {
    //             getSocketIo().emit(SocketEventConstants.FILE_UPLOADED_PROGRESS, {
    //                 name: filename,
    //                 percentage: prog.percentage.toFixed(2),
    //                 transferred: utils.convertBytes(prog.transferred),
    //                 speed: utils.convertSpeed(prog.speed),
    //                 eta: prog.eta,
    //                 remaining: utils.convertBytes(prog.remaining),
    //                 status: 'uploading',
    //             });
    //         });

    //         signal.addEventListener('abort', () => {
    //             file.unpipe(progressStream);
    //             file.destroy();
    //             getSocketIo().emit(SocketEventConstants.FILE_UPLOADED_PROGRESS, {
    //                 name: filename,
    //                 percentage: '0.00',
    //                 status: 'aborted',
    //             });
    //             res.status(499).end('Upload aborted by client');
    //         });

    //         try {
    //             await sftp.put(wrappedStream, remotePath);
    //             uploadedFileCount++;

    //             getSocketIo().emit(SocketEventConstants.FILE_UPLOADED, remotePath);
    //         } catch (err) {
    //             console.error(`Upload failed for ${filename}`, err);
    //             res.status(500).json({ status: false, message: `Failed to upload ${filename}` });
    //             return;
    //         }
    //     });

    //     busboy.on('finish', () => {
    //         res.json({
    //             status: true,
    //             message: `${uploadedFileCount} file(s) uploaded successfully.`,
    //             result: uploadPath,
    //         });
    //     });

    //     req.pipe(busboy);
    // }

    async handleUpload(req: Request, res: Response) {
        const signal = new AbortController().signal

        if (!req.files) {
            res.status(400).send('No file uploaded');
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
                await sftp.uploadDir(dirPath, path, {
                    filter: (filePath: string) => {
                        const name = basename(filePath);
                        return !filePath.includes('.git') && !filePath.includes('node_modules') && !name.startsWith('.');
                    }
                });

                // Notify completion
                getSocketIo().emit(SocketEventConstants.FILE_UPLOADED, path);

                res.json({
                    status: true,
                    message: 'Files uploaded successfully',
                    result: path
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
            signal.addEventListener('abort', () => {
                readStream.destroy();
                getSocketIo().emit(SocketEventConstants.FILE_UPLOADED_PROGRESS, {
                    name: file.name,
                    percent: progressStream.progress().percentage.toFixed(2) || 100,
                    transferred: progressStream.progress().transferred || 0,
                    remaining: utils.convertBytes(progressStream.progress().remaining || file.size || 0),
                    totalSize: file.size,
                    eta: 0,
                    speed: utils.convertSpeed(progressStream.progress().speed || 0),
                    status: 'error',
                });
                res.status(499).end('Upload aborted by client');
            });

            progressStream.on('progress', (progress) => {
                getSocketIo().emit(SocketEventConstants.FILE_UPLOADED_PROGRESS, {
                    percent: progress.percentage.toFixed(2),
                    transferred: progress.transferred || 0,
                    totalSize: file.size,
                    remaining: utils.convertBytes(progress.remaining || file.size || 0),
                    eta: progress.eta,
                    speed: utils.convertSpeed(progress.speed),
                    status: 'uploading',
                    name: file.name,
                });
            });

            await sftp.put(streamWithProgress, remotePath);
            getSocketIo().emit(SocketEventConstants.FILE_UPLOADED_PROGRESS, {
                percent: 100,
                transferred: progressStream.progress().transferred || 0,
                totalSize: file.size,
                remaining: utils.convertBytes(progressStream.progress().remaining || file.size || 0),
                eta: 0,
                speed: utils.convertSpeed(progressStream.progress().speed || 0),
                status: 'completed',
                name: file.name,
            });
            getSocketIo().emit(SocketEventConstants.FILE_UPLOADED, remotePath);

            res.json({
                status: true,
                message: 'File uploaded successfully',
                result: remotePath
            });

        } catch (err: any) {
            console.error('Upload Error:', err);
            res.status(500).json({
                status: false,
                message: 'Something went wrong',
                result: null,
                error: err.message
            });
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
            await sftp.realPath(remotePath);

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
                    console.log("triggered")
                    str.destroy();
                    stream.destroy();
                    getSocketIo().emit(SocketEventConstants.DOWNLOAD_PROGRESS, {
                        name: body.name,
                        transferred: str?.progress().transferred || 0,
                        totalSize,
                        percent: str?.progress().percentage.toFixed(2) || 100,
                        speed: utils.convertSpeed(str?.progress().speed || 0),
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
                        transferred: progressData.transferred,
                        totalSize,
                        percent: progressData.percentage.toFixed(2),
                        speed: utils.convertSpeed(progressData.speed),
                        eta: progressData.eta,
                        status: 'downloading',
                        remaining: utils.convertBytes(progressData.remaining || 0),
                    });
                });

                str.on('end', () => {
                    if (!signal.aborted) {
                        getSocketIo().emit(SocketEventConstants.DOWNLOAD_PROGRESS, {
                            name: body.name,
                            transferred: str?.progress()?.transferred || totalSize,
                            totalSize,
                            percent: str?.progress().percentage.toFixed(2) || 100,
                            speed: utils.convertSpeed(str?.progress().speed || 0),
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
                const fileList = await sftp.list(remotePath, (fileInfo) => {
                    return !fileInfo.name.includes('.git') &&
                        !fileInfo.name.includes('node_modules') &&
                        !fileInfo.name.includes('build') &&
                        !fileInfo.name.includes('dist');
                });

                const totalSize = fileList.reduce((sum, file) => sum + file.size, 0);

                // setup headers
                res.setHeader('Content-Type', 'application/zip');
                res.setHeader('Content-Disposition', `attachment; filename="${body.name}.zip"`);

                // setup archiver
                const archive = archiver('zip', { zlib: { level: 9 } });
                archive.pipe(res);

                let downloaded = 0;

                signal.addEventListener('abort', () => {
                    getSocketIo().emit(SocketEventConstants.DOWNLOAD_PROGRESS, {
                        name: body.name,
                        transferred: downloaded,
                        totalSize,
                        percent: ((downloaded / totalSize) * 100).toFixed(2),
                        speed: utils.convertBytes(totalSize - downloaded) || 0,
                        eta: 0,
                        remaining: utils.convertBytes(totalSize - downloaded),
                        status: 'error',
                    });

                    ABORT_CONTROLLER_MAP.delete(body.name);

                    try {
                        res.status(499).end('Request aborted by client.');
                    } catch (_) { }
                    archive.abort();
                });

                // Append all files to archive with individual progress-stream
                for await (const file of fileList) {
                    if (signal.aborted) break;

                    const remoteFilePath = `${remotePath}/${file.name}`;
                    const readStream = sftp.createReadStream(remoteFilePath);

                    const fileProgress = progress({
                        length: file.size,
                        time: 1000,
                    });

                    fileProgress.on('progress', (p) => {
                        downloaded += p.delta;

                        getSocketIo().emit(SocketEventConstants.DOWNLOAD_PROGRESS, {
                            name: body.name,
                            transferred: downloaded,
                            totalSize,
                            percent: p.percentage.toFixed(2),
                            speed: utils.convertSpeed(p.speed),
                            eta: p.eta,
                            remaining: utils.convertBytes(p.remaining || 0),
                            status: 'downloading',
                        });
                    });

                    archive.append(readStream.pipe(fileProgress), { name: file.name });
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
                            transferred: downloaded,
                            totalSize,
                            percent: 100,
                            status: 'completed',
                            speed: 0,
                            eta: 0,
                            remaining: utils.convertBytes(totalSize - downloaded),

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