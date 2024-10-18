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
const sftp = Sftp_Service.getSftpInstance()
const localStore = new Map<string, any>();
export class SocketListener {

    public onConnection(socket: Socket) {

        console.log("Client connected: " + socket.id);

        let conn: Client = new Client();
        socket.on(SocketEventConstants.SSH_CONNECT, function (data) {
            const host = data.host;
            const username = data.username;
            const sshOptions = data.authMethod === 'password' ? { password: data.password } : { privateKey: data.privateKeyText };
            conn.on('ready', function () {
                localStore.set(socket.id, { host, username, sshOptions });
                socket.emit(SocketEventConstants.SSH_READY, 'Connected to SSH server\n');
                Sftp_Service.connectSFTP({ host, username, ...sshOptions })
                // const { term, cols, rows } = socket.request.session.ssh;
                conn.shell({ cols: 80, rows: 24, term: 'xterm-256color' }, function (err, stream) {
                    if (err) {
                        socket.emit(SocketEventConstants.SSH_EMIT_ERROR, 'Error opening shell: ' + err.message);
                        return;
                    }

                    // Stream SSH output to the client
                    stream.on('data', function (data: any) {
                        socket.emit(SocketEventConstants.SSH_EMIT_DATA, data.toString('utf-8'));
                    });
                    socket.on('resize', (data) => {
                        // stream.setWindow(data.rows, data.cols);
                        Logging.dev(`SOCKET RESIZE: ${JSON.stringify([data.rows, data.cols])}`);
                    });
                    // Listen for terminal input from client
                    socket.on(SocketEventConstants.SSH_EMIT_INPUT, function (input) {
                        stream.write(input);
                    });
                    stream.on('close', function () {
                        socket.emit(SocketEventConstants.SSH_EMIT_DATA, 'SSH session closed');
                        socket.disconnect(true);
                        conn.end();
                    });
                    stream.stderr.on('data', (data) => {
                        Logging.dev(`STDERR: ${data}`, "error");
                    });
                });
            })

                .on('error', function (err) {

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
            });
            conn.on("tcp connection", (details, accept, reject) => {
                console.log("TCP connection request received", details);
                const channel = accept(); // Accept the connection and return a Channel object
                if (channel) {
                    channel.on("data", (data: any) => {
                        console.log("Received TCP data: ", data.toString());
                    });
                }
                socket.emit(SocketEventConstants.SSH_TCP_CONNECTION, details)
            })
            // conn.on('end', (err:any) => {
            //     if (err) Logging.dev('CONN END BY HOST', "error");             
            //     socket.disconnect(true);
            // });

            conn.on("change password", (message, done) => {
                console.log("Password change required: ", message);
                done("new-password"); // Provide the new password here
            })
            conn.on('keyboard-interactive', (_name, _instructions, _instructionsLang, _prompts, finish) => {
                console.log(_name, _instructions, _instructionsLang, _prompts,)
                // finish([socket.request.session.userpassword]);
            });
            conn.on("hostkeys", (keys: ParsedKey[]) => {
                console.log("Received host keys", keys);
                socket.emit(SocketEventConstants.SSH_HOST_KEYS, keys);
            })
            conn.on('handshake', (data: SSH_HANDSHAKE) => {

                // socket.emit('setTerminalOpts', socket.request.session.ssh.terminal);
                // socket.emit('menu');
                // socket.emit('allowreauth', socket.request.session.ssh.allowreauth);
                // socket.emit('title', `ssh://${socket.request.session.ssh.host}`);
                // if (socket.request.session.ssh.header.background)
                //     socket.emit('headerBackground', socket.request.session.ssh.header.background);
                // if (socket.request.session.ssh.header.name)
                //     socket.emit('header', socket.request.session.ssh.header.name);
                // socket.emit(
                //     'footer',
                //     `ssh://${socket.request.session.username}@${socket.request.session.ssh.host}:${socket.request.session.ssh.port}`
                // );
            });
        });
        socket.once('disconnecting', (reason) => {
            Logging.dev(`SOCKET DISCONNECTING: ${reason}`);
            // if (login === true) {
            //     auditLog(
            //         socket,
            //         `LOGOUT user=${socket.request.session.username} from=${socket.handshake.address} host=${socket.request.session.ssh.host}:${socket.request.session.ssh.port}`
            //     );
            //     login = false;
            // }
        });
        socket.on('disconnect', () => {
            socket.emit(SocketEventConstants.SSH_DISCONNECTED);
            console.log('Client disconnected');
        });
        // socket.on('geometry', (cols:any, rows:any) => {
        //   // TODO need to rework how we pass settings to ssh2, this is less than ideal
        //   socket.request.session.ssh.cols = cols;
        //   socket.request.session.ssh.rows = rows;
        //   Logging.dev(`SOCKET GEOMETRY: termCols = ${cols}, termRows = ${rows}`);
        // });
    }
    sftpOperation(socket: Socket) {
        // Get files
        socket.on(SocketEventConstants.SFTP_GET_FILE, async (payload: FileOperationPayload): Promise<any> => {
            const { dirPath } = payload;
            if (!dirPath) return socket.emit(SocketEventConstants.ERROR, 'Invalid directory path');

            try {
                const files = await sftp.list(dirPath);
                socket.emit(SocketEventConstants.SFTP_FILES_LIST, files);
            } catch (err) {
                socket.emit(SocketEventConstants.ERROR, 'Error fetching files');
                console.error(err);
            }
        });

        // Rename a file
        socket.on(SocketEventConstants.SFTP_RENAME_FILE, async (payload: FileOperationPayload): Promise<any> => {
            const { oldPath, newPath } = payload;
            if (!oldPath || !newPath) return socket.emit('error', 'Invalid file paths');

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
            if (!oldPath || !newPath) return socket.emit('error', 'Invalid file paths');

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
            if (!filePath) return socket.emit('error', 'Invalid file path');

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

        // Delete file or folder
        socket.on(SocketEventConstants.SFTP_DELETE_FILE_OR_DIR, async (payload: FileOperationPayload): Promise<any> => {
            const { path } = payload;
            if (!path) return socket.emit(SocketEventConstants.ERROR, 'Invalid path');

            try {
                await sftp.delete(path);
                socket.emit(SocketEventConstants.SUCCESS, 'Deleted successfully');
            } catch (err) {
                socket.emit(SocketEventConstants.ERROR, 'Error deleting file/folder');
                console.error(err);
            }
        });
    }
    // async checkSubnet(socket: Socket) {
    //     let ipaddress = socket.request.session.ssh.host;
    //     if (!validator.isIP(`${ipaddress}`)) {
    //         try {
    //             const result = await dnsPromises.lookup(socket.request.session.ssh.host);
    //             ipaddress = result.address;
    //         } catch (err: any) {
    //             Logging.dev(` CHECK SUBNET ${err.code}: ${err.hostname} user=${socket.request.session.username} from=${socket.handshake.address}`, "error");
    //             socket.emit('ssherror', '404 HOST IP NOT FOUND');
    //             socket.disconnect(true);
    //             return;
    //         }
    //     }

    //     const matcher = new CIDRMatcher(socket.request.session.ssh.allowedSubnets);
    //     if (!matcher.contains(ipaddress)) {
    //         Logging.dev(`CHECK SUBNET Requested host ${ipaddress} outside configured subnets / REJECTED user=${socket.request.session.username} from=${socket.handshake.address}`
    //         );
    //         socket.emit('ssherror', '401 UNAUTHORIZED');
    //         socket.disconnect(true);
    //     }
    // }
    // connError(socket: Socket, err: any) {
    //     let msg = util.inspect(err);
    //     const { session } = socket.request;
    //     if (err?.level === 'client-authentication') {
    //         msg = `Authentication failure user=${session.username} from=${socket.handshake.address}`;
    //         socket.emit('allowreauth', session.ssh.allowreauth);
    //         socket.emit('reauth');
    //     }
    //     if (err?.code === 'ENOTFOUND') {
    //         msg = `Host not found: ${err.hostname}`;
    //     }
    //     if (err?.level === 'client-timeout') {
    //         msg = `Connection Timeout: ${session.ssh.host}`;
    //     }
    //     Logging.dev('CONN ERROR ' + msg, "error");
    // }
    // main(socket: Socket) {
    //     let login = false;
    //     const _this = this

    //     socket.once('disconnecting', (reason) => {
    //         webssh2debug(socket, `SOCKET DISCONNECTING: ${reason}`);
    //         if (login === true) {
    //             auditLog(
    //                 socket,
    //                 `LOGOUT user=${socket.request.session.username} from=${socket.handshake.address} host=${socket.request.session.ssh.host}:${socket.request.session.ssh.port}`
    //             );
    //             login = false;
    //         }
    //     });

    //     async function setupConnection() {
    //         // if websocket connection arrives without an express session, kill it
    //         if (!socket.request.session) {
    //             socket.emit('401 UNAUTHORIZED');
    //             webssh2debug(socket, 'SOCKET: No Express Session / REJECTED');
    //             socket.disconnect(true);
    //             return;
    //         }

    //         // If configured, check that requsted host is in a permitted subnet
    //         if (socket.request.session?.ssh?.allowedSubnets?.length > 0) {
    //             _this.checkSubnet(socket);
    //         }

    //         const conn = new SSH();

    //         conn.on('banner', (data) => {
    //             // need to convert to cr/lf for proper formatting
    //             socket.emit('data', data.replace(/\r?\n/g, '\r\n').toString('utf-8'));
    //         });

    //         conn.on('handshake', () => {
    //             socket.emit('setTerminalOpts', socket.request.session.ssh.terminal);
    //             socket.emit('menu');
    //             socket.emit('allowreauth', socket.request.session.ssh.allowreauth);
    //             socket.emit('title', `ssh://${socket.request.session.ssh.host}`);
    //             if (socket.request.session.ssh.header.background)
    //                 socket.emit('headerBackground', socket.request.session.ssh.header.background);
    //             if (socket.request.session.ssh.header.name)
    //                 socket.emit('header', socket.request.session.ssh.header.name);
    //             socket.emit(
    //                 'footer',
    //                 `ssh://${socket.request.session.username}@${socket.request.session.ssh.host}:${socket.request.session.ssh.port}`
    //             );
    //         });

    //         conn.on('ready', () => {
    //             webssh2debug(
    //                 socket,
    //                 `CONN READY: LOGIN: user=${socket.request.session.username} from=${socket.handshake.address} host=${socket.request.session.ssh.host} port=${socket.request.session.ssh.port} allowreplay=${socket.request.session.ssh.allowreplay} term=${socket.request.session.ssh.term}`
    //             );
    //             auditLog(
    //                 socket,
    //                 `LOGIN user=${socket.request.session.username} from=${socket.handshake.address} host=${socket.request.session.ssh.host}:${socket.request.session.ssh.port}`
    //             );
    //             login = true;
    //             socket.emit('status', 'SSH CONNECTION ESTABLISHED');
    //             socket.emit('statusBackground', 'green');
    //             socket.emit('allowreplay', socket.request.session.ssh.allowreplay);
    //             const { term, cols, rows } = socket.request.session.ssh;
    //             conn.shell({ term, cols, rows }, (err, stream) => {
    //                 if (err) {
    //                     logError(socket, `EXEC ERROR`, err);
    //                     conn.end();
    //                     socket.disconnect(true);
    //                     return;
    //                 }
    //                 socket.once('disconnect', (reason) => {
    //                     webssh2debug(socket, `CLIENT SOCKET DISCONNECT: ${util.inspect(reason)}`);
    //                     conn.end();
    //                     socket.request.session.destroy();
    //                 });
    //                 socket.on('error', (errMsg) => {
    //                     webssh2debug(socket, `SOCKET ERROR: ${errMsg}`);
    //                     logError(socket, 'SOCKET ERROR', errMsg);
    //                     conn.end();
    //                     socket.disconnect(true);
    //                 });
    //                 socket.on('control', (controlData) => {
    //                     if (controlData === 'replayCredentials' && socket.request.session.ssh.allowreplay) {
    //                         stream.write(`${socket.request.session.userpassword}\n`);
    //                     }
    //                     if (controlData === 'reauth' && socket.request.session.username && login === true) {
    //                         auditLog(
    //                             socket,
    //                             `LOGOUT user=${socket.request.session.username} from=${socket.handshake.address} host=${socket.request.session.ssh.host}:${socket.request.session.ssh.port}`
    //                         );
    //                         login = false;
    //                         conn.end();
    //                         socket.disconnect(true);
    //                     }
    //                     webssh2debug(socket, `SOCKET CONTROL: ${controlData}`);
    //                 });
    //                 socket.on('resize', (data) => {
    //                     stream.setWindow(data.rows, data.cols);
    //                     webssh2debug(socket, `SOCKET RESIZE: ${JSON.stringify([data.rows, data.cols])}`);
    //                 });
    //                 socket.on('data', (data) => {
    //                     stream.write(data);
    //                 });
    //                 stream.on('data', (data) => {
    //                     socket.emit('data', data.toString('utf-8'));
    //                 });
    //                 stream.on('close', (code, signal) => {
    //                     webssh2debug(socket, `STREAM CLOSE: ${util.inspect([code, signal])}`);
    //                     if (socket.request.session?.username && login === true) {
    //                         auditLog(
    //                             socket,
    //                             `LOGOUT user=${socket.request.session.username} from=${socket.handshake.address} host=${socket.request.session.ssh.host}:${socket.request.session.ssh.port}`
    //                         );
    //                         login = false;
    //                     }
    //                     if (code !== 0 && typeof code !== 'undefined')
    //                         logError(socket, 'STREAM CLOSE', util.inspect({ message: [code, signal] }));
    //                     socket.disconnect(true);
    //                     conn.end();
    //                 });
    //                 stream.stderr.on('data', (data) => {
    //                     console.error(`STDERR: ${data}`);
    //                 });
    //             });
    //         });

    //         conn.on('end', (err) => {
    //             if (err) logError(socket, 'CONN END BY HOST', err);
    //             webssh2debug(socket, 'CONN END BY HOST');
    //             socket.disconnect(true);
    //         });
    //         conn.on('close', (err) => {
    //             if (err) logError(socket, 'CONN CLOSE', err);
    //             webssh2debug(socket, 'CONN CLOSE');
    //             socket.disconnect(true);
    //         });
    //         conn.on('error', (err) => connError(socket, err));

    //         conn.on('keyboard-interactive', (_name, _instructions, _instructionsLang, _prompts, finish) => {
    //             webssh2debug(socket, 'CONN keyboard-interactive');
    //             finish([socket.request.session.userpassword]);
    //         });
    //         if (
    //             socket.request.session.username &&
    //             (socket.request.session.userpassword || socket.request.session.privatekey) &&
    //             socket.request.session.ssh
    //         ) {
    //             // console.log('hostkeys: ' + hostkeys[0].[0])
    //             const { ssh } = socket.request.session;
    //             ssh.username = socket.request.session.username;
    //             ssh.password = socket.request.session.userpassword;
    //             ssh.tryKeyboard = true;
    //             ssh.debug = debug('ssh2');
    //             conn.connect(ssh);
    //         } else {
    //             webssh2debug(
    //                 socket,
    //                 `CONN CONNECT: Attempt to connect without session.username/password or session varialbles defined, potentially previously abandoned client session. disconnecting websocket client.\r\nHandshake information: \r\n  ${util.inspect(
    //                     socket.handshake
    //                 )}`
    //             );
    //             socket.emit('ssherror', 'WEBSOCKET ERROR - Refresh the browser and try again');
    //             socket.request.session.destroy();
    //             socket.disconnect(true);
    //         }
    //     }
    //     setupConnection();
    // }
}