import fs from 'fs';
import path, { join } from 'path';
import AdmZip from 'adm-zip';
import util from 'util'
import SSH, { Client, ParsedKey } from 'ssh2';
import validator from 'validator';
import { Socket } from "socket.io";
import dnsPromises from 'dns/promises'
import CIDRMatcher from 'cidr-matcher';
import { SSH_HANDSHAKE } from '../../types/ssh.interface';
import { SocketEventConstants } from './events';
import { Logging } from '@enjoys/express-utils/logger';
import { FileOperationPayload } from '../../types/file-upload';
import { Sftp_Service } from '../sftp';
import utils from '@/utils';
import terminalService from '@/handlers/providers/terminalService';
import { publisher, subscriber } from '../cache';

const sftp = Sftp_Service.getSftpInstance()

interface SshSession {
    client: Client;
    write: (input: string) => void;
}

interface SSHInstance {
    sshClient: Client;
    sessionId: string;
}
const sessions: {
    [key: string]: {
        uid: string,
        sessionId: string,
    }
} = {};
const sshInstances: Record<string, SSHInstance> = {};
let TerminalSize = {
    width: 0,
    height: 0,
    cols: 150,
    rows: 40
}
export class SocketListener {
    private currentPath = '';
    private sessions: Map<string, SshSession> = new Map();
    private sessionCommands: Map<string, string> = new Map();

    public onConnection(socket: Socket) {
        console.log("User connected: " + socket.id);
        // Listen for SFTP  connections
        this.connectSFTP(socket);
        // Listen for SSH  connections
        this.sshOperation(socket);
        // Listen for file operations
        this.sftpOperation(socket);
        // Listen for Multiple session of Terminal Live Sharing operations
        this.hanndleMultipleSession(socket)

        socket.on('disconnecting', (reason) => { Logging.dev(`SOCKET DISCONNECTING: ${reason}`); });
        socket.on('disconnect', () => {
            socket.emit(SocketEventConstants.SSH_DISCONNECTED);
            sftp.end();
            console.log('User disconnected');
        });
    }
  
    private hanndleMultipleSession(socket: Socket) {
        let sessionId = '';
        // Generate a unique user ID for each connection
        let uid = Math.random().toString(36).slice(2);
        socket.on(SocketEventConstants.CreateTerminal, async (data: {
            config: {
                password: any;
                privateKey?: undefined;
                host: any;
                username: any;
            } | {
                privateKey: any;
                password?: undefined;
                host: any;
                username: any;
            }
            permissions: { read: boolean, write: boolean }
        }) => {
            try {
                data = typeof data === 'string' ? (data = JSON.parse(data)) : data;
                // Generate a unique Session ID for each connection
                sessionId = utils.uuid_v4();
                // Get the SSH configuration from Current Login Session User
                const sshConfig = data.config
                sessions[socket.id] = { uid, sessionId };
                // Store the SSH configuration in a map
                // Create a new SSH session
                await terminalService.createSshSession(sessionId, sshConfig);
                // Set permissions for the user                
                terminalService.setPermissions(sessionId, uid, data.permissions);
                // Emit the session ID to the client for sharing
                socket.emit(SocketEventConstants.TerminalUrl, { uid, sessionId });
                // Emit the permissions to the client
                socket.emit(SocketEventConstants.SSH_PERMISSIONS, data.permissions);
                // Subscribe to the session
                terminalService.subscribeToSession(sessionId, (data: string) => {
                    socket.emit(SocketEventConstants.terminal_output, data);
                });
            } catch (error) {
                socket.emit(SocketEventConstants.Error, error);
                Logging.dev('Failed to create SSH session:' + error, "error");
            }
        });
        socket.on(SocketEventConstants.SSH_PERMISSIONS, ({ uid, permissions, sessionId }) => {
            terminalService.setPermissions(sessionId, uid, permissions);
            socket.emit("updatedPermissions", permissions);

        });
        socket.on(SocketEventConstants.terminal_input, async (input: string) => {
            terminalService.handleInput(sessionId, input);
        });

        socket.on(SocketEventConstants.join_terminal, (joinSessionId: string) => {
            sessionId = joinSessionId;
            terminalService.subscribeToSession(sessionId, (data: string) => {
                socket.emit(SocketEventConstants.terminal_output, data);
            });
        });
        socket.on('disconnecting', () => {
            socket.emit(SocketEventConstants.SESSIONN_END);
        });
        socket.on('disconnect', async () => {
            const session = await this.getSessionStore(socket.id)
            if (session) {
                terminalService.unSubscribeToSession(session.sessionId, (data: string) => {
                    socket.emit(SocketEventConstants.SUCCESS, "Session Disconnected");
                })
                delete sessions[socket.id]
            }
            console.log('Client disconnected');
        });
    }
    private async getSessionStore(uid: string) {
        return sessions[uid];
    }
    private sshOperation2(socket: Socket) {
        let conn: Client = new Client({ captureRejections: true });
        const _this = this;
        socket.on(SocketEventConstants.SSH_CONNECT, function (data) {
            const userData = { uid: Math.random().toString(36).slice(2), sessionId: utils.uuid_v4() }

            const { host, username, ...sshOptions } = _this.sshConfig(data);
            conn.on('ready', function () {
                socket.emit(SocketEventConstants.SSH_READY, userData);
                Sftp_Service.connectSFTP({ host, username, ...sshOptions }).then(() => {
                    socket.emit(SocketEventConstants.SFTP_READY, true);
                })

                conn.shell({ cols: TerminalSize.cols, rows: TerminalSize.rows, term: 'xterm-256color' }, function (err, stream) {
                    if (err) {

                        socket.emit(SocketEventConstants.SSH_EMIT_ERROR, 'Error opening shell: ' + err.message);
                        return;
                    }

                    // Stream SSH output to the client
                    stream.on('data', function (data: any) {
                        socket.emit(SocketEventConstants.SSH_EMIT_DATA, data.toString('utf-8'));
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
                });
            })
                .on('error', function (err) {
                    console.log(err)
                    socket.emit(SocketEventConstants.SSH_EMIT_ERROR, 'SSH connection error: ' + err.message);
                })
                .connect({
                    host: host,
                    port: 22,
                    username: username,
                    ...sshOptions,
                    debug: (info) => socket.emit(SocketEventConstants.SSH_EMIT_LOGS, { uid: userData.uid, info })

                });
            conn.on('banner', (data) => {
                // need to convert to cr/lf for proper formatting
                socket.emit(SocketEventConstants.SSH_BANNER, data.replace(/\r?\n/g, '\r\n').toString());
            })
                .on("tcp connection", (details, accept, reject) => {
                    console.log("TCP connection request received", details);
                    const channel = accept(); // Accept the connection and return a Channel object
                    if (channel) {
                        channel.on("data", (data: any) => {
                            socket.emit(SocketEventConstants.SSH_TCP_CONNECTION, data.toString())
                        });
                    }
                    socket.emit(SocketEventConstants.SSH_TCP_CONNECTION, details)
                })
                .on("change password", (message, done) => {
                    console.log("Password change required: ", message);
                    done("new-password");
                })
                .on('keyboard-interactive', (_name, _instructions, _instructionsLang, _prompts, finish) => {
                    // console.log(_name, _instructions, _instructionsLang, _prompts,)
                    // finish([socket.request.session.userpassword]);
                })
                .on("hostkeys", (keys: ParsedKey[]) => {
                    socket.emit(SocketEventConstants.SSH_HOST_KEYS, keys);
                })
                .on('handshake', (data: SSH_HANDSHAKE) => {
                    socket.emit(SocketEventConstants.SSH_EMIT_LOGS, data)
                })
            socket.on('disconnect', () => {
                conn.end();
            });
        });
    }
    private sshOperation(socket: Socket) {
        let conn: Client = new Client({
            captureRejections: true
        });
        const _this = this;
        socket.on(SocketEventConstants.SSH_CONNECT, function (data) {
            const userData = { uid: Math.random().toString(36).slice(2), sessionId: utils.uuid_v4() }

            const { host, username, ...sshOptions } = _this.sshConfig(data);
            conn.on('ready', function () {
                socket.emit(SocketEventConstants.SSH_READY, userData);
                Sftp_Service.connectSFTP({ host, username, ...sshOptions }).then(() => {
                    socket.emit(SocketEventConstants.SFTP_READY, true);
                })

                conn.shell({ cols: TerminalSize.cols, rows: TerminalSize.rows, term: 'xterm-256color' }, function (err, stream) {
                    if (err) {

                        socket.emit(SocketEventConstants.SSH_EMIT_ERROR, 'Error opening shell: ' + err.message);
                        return;
                    }

                    // Stream SSH output to the client
                    stream.on('data', function (data: any) {
                        socket.emit(SocketEventConstants.SSH_EMIT_DATA, data.toString('utf-8'));
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
                });
            })
                .on('error', function (err) {
                    console.log(err)
                    socket.emit(SocketEventConstants.SSH_EMIT_ERROR, 'SSH connection error: ' + err.message);
                })
                .connect({
                    host: host,
                    port: 22,
                    username: username,
                    ...sshOptions,
                    debug: (info) => socket.emit(SocketEventConstants.SSH_EMIT_LOGS, { uid: userData.uid, info })

                });
            conn.on('banner', (data) => {
                // need to convert to cr/lf for proper formatting
                socket.emit(SocketEventConstants.SSH_BANNER, data.replace(/\r?\n/g, '\r\n').toString());
            })
                .on("tcp connection", (details, accept, reject) => {
                    console.log("TCP connection request received", details);
                    const channel = accept(); // Accept the connection and return a Channel object
                    if (channel) {
                        channel.on("data", (data: any) => {
                            socket.emit(SocketEventConstants.SSH_TCP_CONNECTION, data.toString())
                        });
                    }
                    socket.emit(SocketEventConstants.SSH_TCP_CONNECTION, details)
                })
                .on("change password", (message, done) => {
                    console.log("Password change required: ", message);
                    done("new-password");
                })
                .on('keyboard-interactive', (_name, _instructions, _instructionsLang, _prompts, finish) => {
                    // console.log(_name, _instructions, _instructionsLang, _prompts,)
                    // finish([socket.request.session.userpassword]);
                })
                .on("hostkeys", (keys: ParsedKey[]) => {
                    socket.emit(SocketEventConstants.SSH_HOST_KEYS, keys);
                })
                .on('handshake', (data: SSH_HANDSHAKE) => {
                    socket.emit(SocketEventConstants.SSH_EMIT_LOGS, data)
                })
            socket.on('disconnect', () => {
                conn.end();
            });
        });
    }
    sftpOperation(socket: Socket) {
        // Get files
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
    private connectSFTP(socket: Socket) {
        socket.on(SocketEventConstants.SFTP_CONNECT, (data: any) => {
            const { host, username, ...sshOptions } = this.sshConfig(data);
            Sftp_Service.connectSFTP({ host, username, ...sshOptions })
        })
    }
    private sshConfig(data: any) {
        if (typeof data === 'string') {
            data = JSON.parse(data);
            const sshOptions = data.authMethod === 'password' ? { password: data.password } : { privateKey: data.privateKeyText }

            return {
                host: data.host,
                username: data.username,
                ...sshOptions
            }
        }
        const sshOptions = data.authMethod === 'password' ? { password: data.password } : { privateKey: data.privateKeyText }

        return {
            host: data.host,
            username: data.username,
            ...sshOptions
        }
    }
}