
import SFTPClient from 'ssh2-sftp-client';
import { SocketEventConstants } from '../socket/events';
import { Socket } from 'socket.io';
import fs from 'fs';
import { join } from 'path';
import AdmZip from 'adm-zip';






import { FileOperationPayload } from '../../types/file-upload';
import { Logging } from '@enjoys/express-utils/logger';
export class SftpInstance {
    private currentPath = ''

    private readonly sftp: SFTPClient
    constructor(private socket: Socket) {
        this.sftp = new SFTPClient()
    }
    connectSFTP(options: SFTPClient.ConnectOptions) {
        return this.sftp.connect(options).then(() => {
            this.sftpOperation()
            this.socket.emit(SocketEventConstants.SFTP_READY, true);
            Logging.dev('Connected to SFTP server');
        }).catch((err) => {
            Logging.dev("Error opening SFTP connection: " + err.message,"error");
            this.socket.emit(SocketEventConstants.SFTP_EMIT_ERROR, 'Error opening SFTP connection: ' + err.message);
            return;
        })
    }
    getSftpInstance() {
        return this.sftp
    }
    private sftpOperation() {
        // Get files
        const sftp = this.sftp
        const socket = this.socket
        sftp.on('debug', console.log);
        sftp.on('upload', (info) => socket.emit(SocketEventConstants.FILE_UPLOADED, info.destination));

        socket.on(SocketEventConstants.SFTP_ZIP_EXTRACT, async (payload: FileOperationPayload): Promise<any> => {
            try {
                let dirPath: string | undefined = payload?.dirPath
                if (!dirPath) {
                    throw new Error("Invalid directory path");
                }
                const localZipPath = join(process.cwd(), "storage");
                await sftp.get(dirPath, localZipPath);
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
                        await sftp.put(localFilePath, remoteFilePath);

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
        socket.on(SocketEventConstants.SFTP_GET_FILE, async (payload: FileOperationPayload): Promise<any> => {
            try {
                let dirPath: string | undefined = payload?.dirPath
                if (!payload || !payload?.dirPath) {
                    dirPath = await sftp.cwd() as string
                }
                this.currentPath = dirPath!
                const files = await sftp.list(dirPath!)
                socket.emit(SocketEventConstants.SFTP_FILES_LIST, {
                    files: JSON.stringify(files), currentDir: dirPath
                });
            } catch (err) {
                socket.emit(SocketEventConstants.ERROR, 'Error fetching files');
                console.error(err);
            }
        });
        // Append data to files

        // File Properties
        socket.on(SocketEventConstants.SFTP_EXISTS, async (payload: FileOperationPayload): Promise<any> => {
            const { dirPath } = payload;
            if (!dirPath) return socket.emit(SocketEventConstants.ERROR, 'Invalid directory path');

            try {
                const isExists = await sftp.exists(dirPath)

                if (!isExists) {
                    socket.emit(SocketEventConstants.ERROR, 'File not found');
                    return
                }
                socket.emit(SocketEventConstants.SFTP_FILES_LIST, isExists);
            } catch (err) {
                socket.emit(SocketEventConstants.ERROR, 'Error fetching files');
                console.error(err);
            }
        });
        // Rename a file
        socket.on(SocketEventConstants.SFTP_RENAME_FILE, async (payload: FileOperationPayload): Promise<any> => {
            const { oldPath, newPath } = payload;
            if (!oldPath || !newPath) return socket.emit(SocketEventConstants.ERROR, 'Invalid file paths');

            try {
                await sftp.rename(oldPath, newPath);
                socket.emit(SocketEventConstants.SUCCESS, 'File renamed successfully');
            } catch (err) {
                socket.emit(SocketEventConstants.ERROR, 'Error renaming file');
                console.error(err);
            }
        });

        // Move a file (SFTP does not have a direct move, so we use rename)
        socket.on(SocketEventConstants.SFTP_MOVE_FILE, async (payload: FileOperationPayload): Promise<any> => {
            const { oldPath, newPath } = payload;
            if (!oldPath || !newPath) return socket.emit(SocketEventConstants.ERROR, 'Invalid file paths');
            try {
                await sftp.rename(oldPath, newPath);
                socket.emit(SocketEventConstants.SUCCESS, 'File moved successfully');
            } catch (err) {
                socket.emit(SocketEventConstants.ERROR, 'Error moving file');
                console.error(err);
            }
        });

        // Create new file
        socket.on(SocketEventConstants.SFTP_CREATE_FILE, async (payload: FileOperationPayload): Promise<any> => {
            const { filePath } = payload;
            if (!filePath) return socket.emit(SocketEventConstants.ERROR, 'Invalid file path');

            try {
                await sftp.put(Buffer.from(''), filePath); // Create an empty file
                socket.emit(SocketEventConstants.SUCCESS, 'File created successfully');
            } catch (err) {
                socket.emit(SocketEventConstants.ERROR, 'Error creating file');
                console.error(err);
            }
        });

        // Create new folder
        socket.on(SocketEventConstants.SFTP_CREATE_DIR, async (payload: FileOperationPayload): Promise<any> => {
            const { folderPath } = payload;
            if (!folderPath) return socket.emit(SocketEventConstants.ERROR, 'Invalid folder path');

            try {

                await sftp.mkdir(folderPath, true);
                socket.emit(SocketEventConstants.SUCCESS, 'Folder created successfully');
            } catch (err) {
                socket.emit(SocketEventConstants.ERROR, 'Error creating folder');
                console.error(err);
            }
        });
        socket.on(SocketEventConstants.SFTP_FILE_DOWNLOAD, async (payload: FileOperationPayload): Promise<any> => {
            const { path } = payload;
            if (!path) return socket.emit(SocketEventConstants.ERROR, 'Invalid  path');

            try {

                await sftp.downloadDir(path, "",);
                socket.emit(SocketEventConstants.SUCCESS, 'Folder Downloaded successfully');
            } catch (err) {
                socket.emit(SocketEventConstants.ERROR, 'Error Downloading folder');
                console.error(err);
            }
        });
        socket.on(SocketEventConstants.SFTP_FILE_STATS, async (payload: FileOperationPayload): Promise<any> => {
            const { path } = payload;
            if (!path) return socket.emit(SocketEventConstants.ERROR, 'Invalid  path');
            try {

                const stats = await sftp.stat(path);
                socket.emit(SocketEventConstants.SFTP_FILE_STATS, stats);
            } catch (err) {
                socket.emit(SocketEventConstants.ERROR, 'Error creating folder');
                console.error(err);
            }
        });

        // Delete folder
        socket.on(SocketEventConstants.SFTP_DELETE_DIR, async (payload: FileOperationPayload): Promise<any> => {
            const { path } = payload;
            if (!path) return socket.emit(SocketEventConstants.ERROR, 'Invalid path');

            try {
                await sftp.rmdir(path);
                socket.emit(SocketEventConstants.SUCCESS, 'Deleted successfully');
            } catch (err) {
                socket.emit(SocketEventConstants.ERROR, 'Error deleting file');
                console.error(err);
            }
        });
        // Delete file o
        socket.on(SocketEventConstants.SFTP_DELETE_FILE, async (payload: FileOperationPayload): Promise<any> => {
            const { path } = payload;
            if (!path) return socket.emit(SocketEventConstants.ERROR, 'Invalid path');

            try {
                await sftp.delete(path);
                socket.emit(SocketEventConstants.SUCCESS, 'Deleted successfully');
            } catch (err) {
                socket.emit(SocketEventConstants.ERROR, 'Error deleting file');
                console.error(err);
            }
        });
    }
}