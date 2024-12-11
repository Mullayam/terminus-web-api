import { basename, join, } from 'path';
import type { Response, Request } from 'express'
import { UploadedFile as ExpressUploadedFile } from 'express-fileupload';
import { Sftp_Service } from '@services/sftp';
import { getSocketIo } from '@/services/socket';
import { SocketEventConstants } from '@/services/socket/events';
import { createReadStream, existsSync, mkdirSync, rm, rmSync, unlinkSync } from 'fs';
import archiver from 'archiver';
const sftp = Sftp_Service.getSftpInstance()
import progress from 'progress-stream'
import utils from '@/utils';

const uploadPath = join(process.cwd(), 'storage');
class SFTPController {

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

            if (body.type === "file") {
                await sftp.fastGet(remotePath, localPath);
                res.setHeader('Content-Disposition', `attachment; filename="${basename(localPath)}"`);
                res.setHeader('Content-Type', 'application/octet-stream');
                res.download(localPath, err => {
                    if (err) {
                        throw err
                    }
                    unlinkSync(localPath)
                    res.end()
                });
            } else {

                await sftp.downloadDir(remotePath, localPath, {
                    useFastget: true,
                    filter: (filePath: string, isDirectory: boolean) => {
                        if (filePath.includes('.git') || filePath.includes('node_modules') || filePath.includes('build') || filePath.includes('dist')) {
                            return false
                        }
                        if (basename(filePath).includes('.git') || filePath.includes('node_modules') || filePath.includes('build') || filePath.includes('dist')) {
                            return false
                        }
                        return true
                    }
                });
                res.setHeader('Content-Type', 'application/zip');
                res.setHeader('Content-Disposition', `attachment; filename=${body.name}.zip`);
                const archive = archiver('zip', {
                    zlib: { level: 9 },
                });
                archive.directory(localPath, false);
                archive.pipe(res);
                archive.finalize();
                archive.on('end', () => {
                    rmSync(localPath, { recursive: true, force: true });
                    res.end();
                });
            }

            getSocketIo().emit(SocketEventConstants.SUCCESS, `${body.name}.zip Downloaded Successfully`);
            return
        } catch (err) {
            res.json({ status: false, message: 'Error in downloading', result: null })
            getSocketIo().emit(SocketEventConstants.ERROR, "Error in Downloading");
            res.end()
        }
    }
}
export default new SFTPController()