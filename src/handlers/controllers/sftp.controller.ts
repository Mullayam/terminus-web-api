import type { Response, Request } from 'express'
import { UploadedFile as ExpressUploadedFile } from 'express-fileupload';
import { Logging } from '@enjoys/express-utils/logger';
import { Sftp_Service } from '@services/sftp';
import { getSocketIo } from '@/services/socket';
import { SocketEventConstants } from '@/services/socket/events';

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
        if (!req.files || !req.files.file) {
            res.status(400).send('No file uploaded');
            return;
        }
        const file = req.files.file as ExpressUploadedFile;
        const remotePath = `/remote/path/${file.name}`;
        try {
            await sftp.put(file.data, remotePath);
            getSocketIo().emit('file-uploaded', remotePath);
            res.end()
            return
        } catch (err) {
            console.error('Upload Error:', err);
            res.status(500).send('Error uploading file');
            res.end()
        }
    }
}
export default new SFTPController()