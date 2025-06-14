import fs from 'fs';
import { join } from 'path';
import AdmZip from 'adm-zip';

import { Server } from "socket.io";

import { Client, ParsedKey } from 'ssh2';

import { Socket } from "socket.io";

import { SSH_CONFIG_DATA, SSH_HANDSHAKE } from '../../types/ssh.interface';
import { SocketEventConstants } from './events';
import { Logging } from '@enjoys/express-utils/logger';
import { FileOperationPayload } from '../../types/file-upload';

import { RedisClientType } from 'redis';
import { SftpInstance } from '../sftp/sftp-instance';
import { Sftp_Service } from '../sftp/index';
import { ABORT_CONTROLLER_MAP } from '@/handlers/controllers/sftp.controller';



let TerminalSize = {
    width: 0,
    height: 0,
    cols: 150,
    rows: 40
}
const sftp = Sftp_Service.getSftpInstance()
export const sftp_sessions = new Map<string, SftpInstance>()

type SocketPermission = '400' | '700' | '777';

interface SessionInfo {
    adminSocketId: string;
    socketPermissions: Map<string, SocketPermission>;
    connectedSockets: Set<string>,

}



export class SocketListener {
    private currentPath = '/';
    private sessions: Map<string, Client> = new Map();
    private sharedTerminalSessions: Map<string, string[]> = new Map();
    private sessionInfo: Record<string, Partial<SessionInfo>> = {}
    constructor(
        private redisClient: RedisClientType,
        private pubClient: RedisClientType,
        private subClient: RedisClientType,
        private readonly io: Server
    ) { }
    public onConnection(socket: Socket) {
        const sessionId = socket.handshake.query.sessionId as string;
        sessionId ? Logging.dev(`🔌 Admin connected: ${sessionId} + ${socket.id}`) :
            Logging.dev(`🔌 Client connected: ${socket.id}`);

        // Listen for SFTP  connections
        this.connectSFTP(socket);
        // Listen for SSH  connections
        this.sshOperation(socket);
        // Listen for file operations
        this.sftpOperation(socket);
        // Listen for Multiple session of Terminal Live Sharing operations
        this.terminalSharingSession(socket);

        socket.on('disconnecting', (reason) => {
            for (const [sessionId, info] of Object.entries(this.sessionInfo)) {
                info.adminSocketId && this.io.to(info.adminSocketId)?.emit(SocketEventConstants.SSH_DISCONNECTED, socket.id);
                this.io.to(socket.id)?.emit(SocketEventConstants.SSH_DISCONNECTED, "Session is Terminated by Admin");
            }

            Logging.dev(`SOCKET DISCONNECTING: ${reason}`);
        });

        socket.on('disconnect', () => {
            Logging.dev(`Client disconnected: ${socket.id}`);
            sftp.end().then(() => Logging.dev(`SFTP Connection Closed`)).catch(err => Logging.dev(`SFTP Connection Error: ${err}`, "error"))
            for (const [sessionId, info] of Object.entries(this.sessionInfo)) {

                sftp_sessions.delete(sessionId)
                this.sharedTerminalSessions.delete(sessionId)

                // If admin left or everyone disconnected
                if (socket.id === info.adminSocketId) {
                    const ssh = this.sessions.get(sessionId);
                    if (ssh) ssh.end();
                    this.sessions.delete(sessionId);
                    delete this.sessionInfo[sessionId];
                    this.redisClient.del(`terminal:history:${sessionId}`);
                    socket.leave(`terminal:${sessionId}`);
                    Logging.dev(`Admin Disconnected: ${sessionId}`);
                } else {
                    info?.socketPermissions?.delete(socket.id)
                    info?.connectedSockets?.delete(socket.id)

                }
            }
        });

    }

    private terminalSharingSession(socket: Socket) {
        socket.on(SocketEventConstants.CreateTerminal, (session_id: string) => {
            if (!this.sessions.has(session_id)) {
                return this.io.to(socket.id).emit(SocketEventConstants.session_not_found, "Session not found");
            }
            const info = this.sessionInfo[session_id];
            socket.join(`terminal:${session_id}`);
            info?.socketPermissions?.set(socket.id, '400')
            info?.connectedSockets?.add(socket.id)


            const existingSocketIds = this.sharedTerminalSessions.get(session_id) || [];

            if (!existingSocketIds.includes(socket.id)) {
                existingSocketIds.push(socket.id);
                this.sharedTerminalSessions.set(session_id, existingSocketIds);
                info?.adminSocketId && this.io.to(info?.adminSocketId).emit(SocketEventConstants.session_info, { socketId: socket.id, socketIds: Array.from(info?.connectedSockets || []) });
            }
        });
        this.subClient.pSubscribe(`terminal:*`, this.subscribeToSession)
    }

    subscribeToSession = (message: string, channel: string) => {
        const _this = this
        const session_id = channel.split(':')[1];
        const socketIds = _this.sharedTerminalSessions.get(session_id) || [];


        socketIds.forEach((sockId) => {
            const targetSocket = _this.io.sockets.sockets.get(sockId);

            if (targetSocket) {
                targetSocket.emit(SocketEventConstants.terminal_output, message);
            }
        });
    }
    private async sshOperation(socket: Socket) {
        const _this = this;
        const sessionId = socket.handshake.query.sessionId as string;
        const resume = async () => {

            const metaJson = await this.redisClient.get(`session:${sessionId}`);
            if (!metaJson) return false;

            const meta = JSON.parse(metaJson) as ReturnType<typeof this.sshConfig>;
            console.log(`♻️ Resuming session for ${sessionId} with`, meta.host);

            const ssh = new Client();

            ssh.on('ready', () => {
                console.log(`✅ SSH Ready (Resumed): ${sessionId}`);
                socket.emit(SocketEventConstants.SSH_READY, "Ready");

                // ssh.shell({ cols: TerminalSize.cols, rows: TerminalSize.rows, term: 'xterm-256color' }, (err, stream) => {
                //     if (err) {
                //         socket.emit(SocketEventConstants.SSH_EMIT_ERROR, 'Error opening shell: ' + err.message);
                //         return;
                //     }

                //     // Stream SSH output to the client
                //     stream.on('data', function (data: any) {
                //         socket.emit(SocketEventConstants.SSH_EMIT_DATA, data.toString('utf-8'));
                //     });
                //     socket.on(SocketEventConstants.SSH_EMIT_RESIZE, (data) => {
                //         TerminalSize.cols = data.cols
                //         TerminalSize.rows = data.rows
                //         stream.setWindow(data.rows, data.cols, 1280, 720);
                //     });
                //     // Listen for terminal input from client
                //     socket.on(SocketEventConstants.SSH_EMIT_INPUT, function (input) {
                //         stream.write(input);
                //     });
                //     stream.on('close', function () {
                //         ssh.end();
                //     });
                //     stream.stderr.on('data', (data) => {
                //         Logging.dev(`STDERR: ${data}`, "error");
                //     });
                //     socket.on('disconnect', () => ssh.end());
                // });
            });

            ssh.on('error', (err) => {
                socket.emit(SocketEventConstants.SSH_EMIT_ERROR, 'SSH connection error: ' + err.message);
            });
            ssh.connect(meta);
            this.sessions.set(sessionId, ssh);
            return true;
        };

        // const success = await resume();
        // if (!success) {
        //     console.log(`⚠️ No resumable session for: ${sessionId}`);
        //     socket.emit('needs-auth');
        // }
        socket.on(SocketEventConstants.SSH_SESSION, async (input: string) => {
            const data = JSON.parse(input) as {
                socketId: string,
                sessionId: string
                type: "pause" | "resume" | "kick"
            }
            const info = this.sessionInfo[sessionId];

            if (info) {
                const targetSocket = _this.io.sockets.sockets.get(data.socketId);
                if (targetSocket) {
                    switch (data.type) {
                        case "pause":
                            targetSocket.emit(SocketEventConstants.session_info, `Your session has been ${data.type} by an admin, click "Resume" to continue`);
                            targetSocket.disconnect();
                            break;
                        case "kick":
                            targetSocket.emit(SocketEventConstants.SESSIONN_END, `Your session has been terminated by an admin`);
                            info.connectedSockets?.delete(data.socketId);
                            targetSocket.disconnect();
                            break;
                        default:
                            break;
                    }
                }
            }
        })
        socket.on(SocketEventConstants.SSH_PERMISSIONS, async (input: string) => {
            const data = JSON.parse(input) as {
                socketId: string,
                permissions: SocketPermission,
                sessionId: string
            };
            const info = this.sessionInfo[data.sessionId];
            if (info) {
                info.socketPermissions?.set(socket.id, data.permissions);
                this.io.sockets.sockets.get(data.socketId)?.emit(SocketEventConstants.SSH_PERMISSIONS, input);
                info.adminSocketId && this.io.sockets.sockets.get(info.adminSocketId)?.emit(SocketEventConstants.SSH_PERMISSIONS, input);
            }
        })
        socket.on(SocketEventConstants.SSH_START_SESSION, async (input: string) => {

            const data = this.sshConfig(JSON.parse(input));

            Logging.dev(`✨ Starting new session: ${sessionId}`);
            this.sessionInfo[sessionId] = { adminSocketId: socket.id, socketPermissions: new Map(), connectedSockets: new Set() }
            let conn: Client = this.sessions.get(sessionId) || new Client({ captureRejections: true });

            conn.on('ready', function () {
                socket.emit(SocketEventConstants.SSH_READY, "Ready");
                Logging.dev(`✅ SSH Ready: ${sessionId}`);


                conn.shell({ cols: TerminalSize.cols, rows: TerminalSize.rows, term: 'xterm-256color' }, function (err, stream) {
                    if (err) {
                        Logging.dev("Error opening shell: " + err.message, "error");
                        socket.emit(SocketEventConstants.SSH_EMIT_ERROR, 'Error opening shell: ' + err.message);
                        return;
                    }

                    // Stream SSH output to the client
                    stream.on('data', function (data: any) {
                        const text = data.toString('utf-8')
                        socket.emit(SocketEventConstants.SSH_EMIT_DATA, text);
                        _this.pubClient.publish(`terminal:${sessionId}`, text);
                        // _this.redisClient.rPush(`terminal:history:${sessionId}`, text);

                    });
                    socket.on(SocketEventConstants.SSH_EMIT_RESIZE, (data) => {
                        TerminalSize.cols = data.cols
                        TerminalSize.rows = data.rows
                        stream.setWindow(data.rows, data.cols, 1280, 720);
                    });
                    // Listen for terminal input from client
                    socket.on(SocketEventConstants.SSH_EMIT_INPUT, function (input) {
                        stream.write(input);
                    });
                    stream.on('close', function () {
                        conn.end();
                    });
                    stream.stderr.on('data', (data) => {
                        Logging.dev(`STDERR: ${data}`, "error");
                    });
                    socket.on('disconnect', () => conn.end());

                });
            })
            conn.on('error', function (err) {
                console.log(err)
                socket.emit(SocketEventConstants.SSH_EMIT_ERROR, 'SSH connection error: ' + err.message);
            })
            conn.connect(data)
            conn.on('banner', (data) => {

                socket.emit(SocketEventConstants.SSH_BANNER, data.replace(/\r?\n/g, '\r\n').toString());
            })

            conn.on("hostkeys", (keys: ParsedKey[]) => {
                socket.emit(SocketEventConstants.SSH_HOST_KEYS, keys);
            })
            conn.on('handshake', (data: SSH_HANDSHAKE) => {
                socket.emit(SocketEventConstants.SSH_EMIT_LOGS, data)
            })
            // const sftpIns = new SftpInstance(socket)
            // sftpIns.connectSFTP(data)
            // sftp_sessions.set(sessionId, sftpIns)

            _this.sessions.set(sessionId, conn);
            // this.redisClient.set(`session:${sessionId}`, JSON.stringify(data), {  EX: 3600});
        })



    }
    sftpOperation(socket: Socket) {
        // Get files
        sftp.on('debug', console.log);
        sftp.on('upload', (info) => socket.emit(SocketEventConstants.FILE_UPLOADED, info.destination));
        sftp.on('download', (info) => console.log(info));
        const progressCancelHandler = async (name: string) => {
            ABORT_CONTROLLER_MAP.set(name, new AbortController())
            const controller = ABORT_CONTROLLER_MAP.get(name)
            if (controller) {
                controller.abort("Cancelled by user")
            }
        }
        socket.on(SocketEventConstants.CANCEL_UPLOADING, progressCancelHandler)
        socket.on(SocketEventConstants.CANCEL_DOWNLOADING, progressCancelHandler)

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
    private connectSFTP(socket: Socket) {
        socket.on(SocketEventConstants.SFTP_CONNECT, async (data: any) => {
            // const sftpIC = new SftpInstance(socket)
            // sftpIC.connectSFTP()
            !Sftp_Service.is_connected && await Sftp_Service.connectSFTP(this.sshConfig(data) as any)

            if (Sftp_Service.is_connected) {

                socket.emit(SocketEventConstants.SFTP_READY, true);
                const handler = async () => {
                    this.currentPath = await sftp.cwd();
                    const files = await sftp.list(this.currentPath!)
                    socket.emit(SocketEventConstants.SFTP_FILES_LIST, {
                        files: JSON.stringify(files), currentDir: this.currentPath
                    });
                    return this.currentPath
                }
                const p = await handler()
                socket.emit(SocketEventConstants.SFTP_CURRENT_PATH, p);
            }

        })
    }
    private sshConfig(data: any) {
        if (typeof data === 'string') {
            data = JSON.parse(data);
            const sshOptions = data.authMethod === 'password' ? { password: data.password } : { privateKey: data.privateKeyText }

            return {
                host: data.host,
                port: +data.port || 22,
                username: data.username,
                ...sshOptions
            }
        }
        const sshOptions = data.authMethod === 'password' ? { password: data.password } : { privateKey: data.privateKeyText }

        return {
            host: data.host,
            port: +data.port || 22,
            username: data.username,
            ...sshOptions
        }
    }
}