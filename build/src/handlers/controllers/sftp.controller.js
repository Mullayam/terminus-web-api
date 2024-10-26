"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const sftp_1 = require("@services/sftp");
const socket_1 = require("@/services/socket");
const sftp = sftp_1.Sftp_Service.getSftpInstance();
class SFTPController {
    async handleUpload(req, res) {
        if (!req.files || !req.files.file) {
            res.status(400).send('No file uploaded');
            return;
        }
        const file = req.files.file;
        const remotePath = `/remote/path/${file.name}`;
        try {
            await sftp.put(file.data, remotePath);
            (0, socket_1.getSocketIo)().emit('file-uploaded', remotePath);
            res.end();
            return;
        }
        catch (err) {
            console.error('Upload Error:', err);
            res.status(500).send('Error uploading file');
            res.end();
        }
    }
    async handleDownload(req, res) {
        if (!req.files || !req.files.file) {
            res.status(400).send('No file uploaded');
            return;
        }
        const file = req.files.file;
        const remotePath = `/remote/path/${file.name}`;
        try {
            await sftp.put(file.data, remotePath);
            (0, socket_1.getSocketIo)().emit('file-uploaded', remotePath);
            res.end();
            return;
        }
        catch (err) {
            console.error('Upload Error:', err);
            res.status(500).send('Error uploading file');
            res.end();
        }
    }
}
exports.default = new SFTPController();
