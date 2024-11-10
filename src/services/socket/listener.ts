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
const sftp = Sftp_Service.getSftpInstance()

const sessions: { [key: string]: Client } = {};
const hosts = new Map<string, any>();
const localStore = new Map<string, any>();
export class SocketListener {
    private currentPath = '';

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
            delete sessions[socket.id];
            localStore.delete(socket.id);
            sftp.end();
            console.log('User disconnected');
        });
    }
    private hanndleMultipleSession(socket: Socket) {
        let sessionId = '';
        socket.on(SocketEventConstants.CreateTerminal, async (data) => {
            try {
                sessionId = utils.uuid_v4();
                const sshConfig = localStore.get(socket.id) as ReturnType<typeof this.sshConfig>;
                hosts.set(sessionId, sshConfig);
                await terminalService.createSshSession(sessionId, sshConfig);

                socket.emit(SocketEventConstants.TerminalUrl, sessionId);

                terminalService.subscribeToSession(sessionId, (data: string) => {
                    socket.emit(SocketEventConstants.SSH_EMIT_DATA, data);
                });
            } catch (error) {
                socket.emit(SocketEventConstants.Error, error);
                Logging.dev('Failed to create SSH session:' + error, "error");
            }
        });

        socket.on(SocketEventConstants.SSH_EMIT_INPUT, (input: string) => {
            terminalService.handleInput(sessionId, input);
        });

        socket.on(SocketEventConstants.join_terminal, (joinSessionId: string) => {
            sessionId = joinSessionId;
            terminalService.subscribeToSession(sessionId, (data: string) => {
                socket.emit(SocketEventConstants.SSH_EMIT_DATA, data);
            });
        });
        socket.on('disconnecting', () => {
            socket.emit(SocketEventConstants.SESSIONN_END);
        });
        socket.on('disconnect', () => {
            delete sessions[socket.id]
            console.log('Client disconnected');
        });
    }
    private sshOperation(socket: Socket) {
        let conn: Client = new Client();
        const _this = this;
        socket.on(SocketEventConstants.SSH_CONNECT, function (data) {
            const { host, username, sshOptions } = _this.sshConfig(data);
            localStore.set(socket.id, { host, username, sshOptions });
            conn.on('ready', function () {
                socket.emit(SocketEventConstants.SSH_READY, 'Connected to SSH server\n');
                Sftp_Service.connectSFTP({ host, username, ...sshOptions })
                conn.shell({ cols: 130, rows: 30, term: 'xterm-256color' }, function (err, stream) {
                    if (err) {
                        socket.emit(SocketEventConstants.SSH_EMIT_ERROR, 'Error opening shell: ' + err.message);
                        return;
                    }
                    // Stream SSH output to the client
                    stream.on('data', function (data: any) {
                        socket.emit(SocketEventConstants.SSH_EMIT_DATA, data.toString('utf-8'));
                    });
                    socket.on(SocketEventConstants.SSH_EMIT_RESIZE, (data) => {
                        stream.setWindow(data.rows, data.cols, data.height, data.width);
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
                            console.log("Received TCP data: ", data.toString());
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
                    socket.emit('title', `ssh://`);
                })
            socket.on('disconnect', () => {
                conn.end();
            });
        });
    }
    sftpOperation(socket: Socket) {
        // Get files
        socket.on(SocketEventConstants.SFTP_GET_FILE, async (payload: FileOperationPayload): Promise<any> => {
            try {

                let dirPath: string | undefined = payload?.dirPath
                if (!payload || !payload?.dirPath) {
                    dirPath = await sftp.cwd() as string
                }
                this.currentPath = dirPath!
                const files = await sftp.list(dirPath!)
                socket.emit(SocketEventConstants.SFTP_FILES_LIST, {
                    files, currentDir: dirPath
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
            if (!data) {
                const { host, username, ...sshOptions } = this.sshConfig(localStore.get(socket.id));
                Sftp_Service.connectSFTP({ host, username, ...sshOptions })
                return
            }
            const { host, username, ...sshOptions } = this.sshConfig(data);
            Sftp_Service.connectSFTP({ host, username, ...sshOptions })
        })
    }
    private sshConfig(data: any) {
        if (typeof data === 'string') {
            data = JSON.parse(data);
            return {
                host: data.host,
                username: data.username,
                sshOptions: data.authMethod === 'password' ? { password: data.password } : { privateKey: data.privateKeyText }
            }
        }
        return {
            host: data.host,
            username: data.username,
            sshOptions: data.authMethod === 'password' ? { password: data.password } : { privateKey: data.privateKeyText }
        }
    }
}