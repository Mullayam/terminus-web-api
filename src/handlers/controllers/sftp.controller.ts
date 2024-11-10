import { basename, join } from 'path';
import type { Response, Request } from 'express'
import { UploadedFile as ExpressUploadedFile } from 'express-fileupload';
import { Sftp_Service } from '@services/sftp';
import { getSocketIo } from '@/services/socket';
import { SocketEventConstants } from '@/services/socket/events';
import { rmSync, unlinkSync } from 'fs';
import archiver from 'archiver';
const sftp = Sftp_Service.getSftpInstance()
class SFTPController {
    async handleUpload(req: Request, res: Response) {
        if (!req.files || !req.files.file) {
            res.status(400).send('No file uploaded');
            return;
        }
        const file = req.files.file as ExpressUploadedFile;
        const path = req.body.path
        const remotePath = `${path}/${file.name}`;
        try {
            await sftp.put(file.data, remotePath);
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