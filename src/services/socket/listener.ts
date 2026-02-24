import fs from 'fs';
import { join, posix } from 'path';
import AdmZip from 'adm-zip';

import { Server } from "socket.io";

import { Client, ParsedKey } from 'ssh2';

import { Socket } from "socket.io";

import { SSH_CONFIG_DATA, SSH_HANDSHAKE } from '../../types/ssh.interface';
import { SocketEventConstants } from './events';
import { Logging } from '@enjoys/express-utils/logger';
import { FileOperationPayload, EditFilePayload } from '../../types/file-upload';

import { RedisClientType } from 'redis';
import { SftpInstance } from '../sftp/sftp-instance';
import { Sftp_Service } from '../sftp/index';
import { ABORT_CONTROLLER_MAP } from '@/handlers/controllers/sftp.controller';



const sftp = Sftp_Service.getSftpInstance()
export const sftp_sessions = new Map<string, SftpInstance>()

type SocketPermission = '400' | '700' | '777';

interface SessionInfo {
    adminSocketId: string;
    socketPermissions: Map<string, SocketPermission>;
    connectedSockets: Set<string>,
    terminalSize: { width: number; height: number; cols: number; rows: number };
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
    ) {
        // Register SFTP client listeners once to avoid MaxListeners leak
        sftp.on('debug', console.log);
        sftp.on('upload', (info) => this.io.emit(SocketEventConstants.FILE_UPLOADED, info.destination));
        sftp.on('download', (info) => console.log(info));
    }
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
            const info = this.sessionInfo[socket.id];

            if (!info) return;

            if (info.adminSocketId) {
                this.io.to(info.adminSocketId).emit(
                    SocketEventConstants.SSH_DISCONNECTED,
                    socket.id
                );
            }

            socket.emit(
                SocketEventConstants.SSH_DISCONNECTED,
                "Session is Terminated by Admin",

            );

            Logging.dev(`SOCKET DISCONNECTING: ${reason}`);
        });

        socket.on('disconnect', () => {
            Logging.dev(`Client disconnected: ${socket.id}`);
            for (const [sessionId, info] of Object.entries(this.sessionInfo)) {
                // Clean up per-session SFTP instance if exists
                const sftpSession = sftp_sessions.get(sessionId);
                if (sftpSession && socket.id === info.adminSocketId) {
                    sftpSession.getSftpInstance().end().catch(err => Logging.dev(`SFTP Connection Error: ${err}`, "error"));
                    sftp_sessions.delete(sessionId);
                }

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

            });

            ssh.on('error', (err) => {
                socket.emit(SocketEventConstants.SSH_EMIT_ERROR, 'SSH connection error: ' + err.message);
            });
            ssh.connect(meta);
            this.sessions.set(sessionId, ssh);
            return true;
        };


        socket.on(SocketEventConstants.SSH_SESSION, async (input: string) => {
            let data: { socketId: string; sessionId: string; type: "pause" | "resume" | "kick" };
            try {
                data = JSON.parse(input);
            } catch {
                socket.emit(SocketEventConstants.SSH_EMIT_ERROR, 'Invalid JSON input');
                return;
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
            let data: { socketId: string; permissions: SocketPermission; sessionId: string };
            try {
                data = JSON.parse(input);
            } catch {
                socket.emit(SocketEventConstants.SSH_EMIT_ERROR, 'Invalid JSON input');
                return;
            }
            const info = this.sessionInfo[data.sessionId];
            if (info) {
                info.socketPermissions?.set(socket.id, data.permissions);
                this.io.sockets.sockets.get(data.socketId)?.emit(SocketEventConstants.SSH_PERMISSIONS, input);
                info.adminSocketId && this.io.sockets.sockets.get(info.adminSocketId)?.emit(SocketEventConstants.SSH_PERMISSIONS, input);
            }
        })
        socket.on(SocketEventConstants.SSH_RESUME, async (sessionId: string) => {
            const success = await resume();
            if (!success) {
                socket.emit(SocketEventConstants.SSH_EMIT_ERROR, 'No session to resume');
                return;
            }
        })
        socket.on(SocketEventConstants.SSH_START_SESSION, async (input: string) => {

            let parsed: any;
            try {
                parsed = JSON.parse(input);
            } catch {
                socket.emit(SocketEventConstants.SSH_EMIT_ERROR, 'Invalid JSON input');
                return;
            }
            const data = this.sshConfig(parsed);

            Logging.dev(`✨ Starting new session: ${sessionId}`);
            this.sessionInfo[sessionId] = { adminSocketId: socket.id, socketPermissions: new Map(), connectedSockets: new Set(), terminalSize: { width: 0, height: 0, cols: 150, rows: 40 } }
            let conn: Client = this.sessions.get(sessionId) || new Client({ captureRejections: true });

            conn.on('ready', function () {
                socket.emit(SocketEventConstants.SSH_READY, "Ready");
                Logging.dev(`✅ SSH Ready: ${sessionId}`);


                conn.shell({ cols: (_this.sessionInfo[sessionId]?.terminalSize?.cols || 150), rows: (_this.sessionInfo[sessionId]?.terminalSize?.rows || 40), term: 'xterm-256color' }, function (err, stream) {
                    if (err) {
                        Logging.dev("Error opening shell: " + err.message, "error");
                        socket.emit(SocketEventConstants.SSH_EMIT_ERROR, 'Error opening shell: ' + err.message);
                        return;
                    }

                    // Stream SSH output to the client
                    stream.on('data', function (data: any) {

                        const text = data.toString('utf-8')
                        socket.emit(SocketEventConstants.SSH_EMIT_DATA, text);
                        _this.sessionInfo[sessionId]?.adminSocketId && socket.to(_this.sessionInfo[sessionId].adminSocketId).emit(SocketEventConstants.terminal_output, text);
                        _this.pubClient.publish(`terminal:${sessionId}`, text);


                    });
                    socket.on(SocketEventConstants.SSH_EMIT_RESIZE, (data) => {
                        const info = _this.sessionInfo[sessionId];
                        if (info?.terminalSize) {
                            info.terminalSize.cols = data.cols;
                            info.terminalSize.rows = data.rows;
                        }
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

                    socket.on('disconnect', () => {

                        conn.end()
                    });

                });
            })
            conn.on('error', function (err) {
                console.log(err)
                socket.emit(SocketEventConstants.SSH_EMIT_ERROR, 'SSH connection error: ' + err.message);
            }).on('greeting', (msg) => {
                socket.emit(SocketEventConstants.SSH_EMIT_LOGS, msg)
            }).on('handshake', (msg) => {
                socket.emit(SocketEventConstants.SSH_EMIT_LOGS, msg)
            })

            conn.connect(data)
            conn.on('banner', (data) => {

                socket.emit(SocketEventConstants.SSH_BANNER, data.replace(/\r?\n/g, '\r\n').toString());
            })

            conn.on("hostkeys", (keys: ParsedKey[]) => {
                socket.emit(SocketEventConstants.SSH_HOST_KEYS, keys);
            })


            _this.sessions.set(sessionId, conn);

        })



    }
    sftpOperation(socket: Socket) {
        // sftp client listeners are registered once in the constructor
        const progressCancelHandler = async (name: string) => {
            const controller = ABORT_CONTROLLER_MAP.get(name)
            if (controller) {
                controller.abort("Cancelled by user")
                ABORT_CONTROLLER_MAP.delete(name)
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
                    const remoteFilePath = posix.join(dirPath, file);

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
                const localDownloadPath = join(process.cwd(), 'storage', 'downloads');
                if (!fs.existsSync(localDownloadPath)) {
                    fs.mkdirSync(localDownloadPath, { recursive: true });
                }
                await sftp.downloadDir(path, localDownloadPath);
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

        socket.on(SocketEventConstants.SFTP_EDIT_FILE_REQUEST, async (payload: { path: string }): Promise<any> => {
            const { path } = payload;
            if (!path) return socket.emit(SocketEventConstants.ERROR, 'Invalid path');
            let data = await sftp.get(path);
            let content = data.toString();
            socket.emit(SocketEventConstants.SFTP_EDIT_FILE_REQUEST_RESPONSE, content);

        });
        // Edit file content
        socket.on(SocketEventConstants.SFTP_EDIT_FILE_DONE, async (payload: EditFilePayload): Promise<any> => {
            const { path, content } = payload;
            await sftp.put(Buffer.from(content), path);
            socket.emit(SocketEventConstants.SUCCESS, 'File edited successfully');

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