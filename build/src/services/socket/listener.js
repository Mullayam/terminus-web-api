"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SocketListener = void 0;
const ssh2_1 = require("ssh2");
const events_1 = require("./events");
const logger_1 = require("@enjoys/express-utils/logger");
const sftp_1 = require("../sftp");
const sftp = sftp_1.Sftp_Service.getSftpInstance();
const localStore = new Map();
class SocketListener {
    onConnection(socket) {
        console.log("Client connected: " + socket.id);
        let conn = new ssh2_1.Client();
        socket.on(events_1.SocketEventConstants.SSH_CONNECT, function (data) {
            const host = data.host;
            const username = data.username;
            const sshOptions = data.authMethod === 'password' ? { password: data.password } : { privateKey: data.privateKeyText };
            conn.on('ready', function () {
                localStore.set(socket.id, { host, username, sshOptions });
                socket.emit(events_1.SocketEventConstants.SSH_READY, 'Connected to SSH server\n');
                sftp_1.Sftp_Service.connectSFTP(Object.assign({ host, username }, sshOptions));
                // const { term, cols, rows } = socket.request.session.ssh;
                conn.shell({ cols: 80, rows: 24, term: 'xterm-256color' }, function (err, stream) {
                    if (err) {
                        socket.emit(events_1.SocketEventConstants.SSH_EMIT_ERROR, 'Error opening shell: ' + err.message);
                        return;
                    }
                    // Stream SSH output to the client
                    stream.on('data', function (data) {
                        socket.emit(events_1.SocketEventConstants.SSH_EMIT_DATA, data.toString('utf-8'));
                    });
                    socket.on('resize', (data) => {
                        // stream.setWindow(data.rows, data.cols);
                        logger_1.Logging.dev(`SOCKET RESIZE: ${JSON.stringify([data.rows, data.cols])}`);
                    });
                    // Listen for terminal input from client
                    socket.on(events_1.SocketEventConstants.SSH_EMIT_INPUT, function (input) {
                        stream.write(input);
                    });
                    stream.on('close', function () {
                        socket.emit(events_1.SocketEventConstants.SSH_EMIT_DATA, 'SSH session closed');
                        socket.disconnect(true);
                        conn.end();
                    });
                    stream.stderr.on('data', (data) => {
                        logger_1.Logging.dev(`STDERR: ${data}`, "error");
                    });
                });
            })
                .on('error', function (err) {
                socket.emit(events_1.SocketEventConstants.SSH_EMIT_ERROR, 'SSH connection error: ' + err.message);
            })
                .connect(Object.assign({ host: host, port: 22, username: username }, sshOptions));
            conn.on('banner', (data) => {
                // need to convert to cr/lf for proper formatting
                socket.emit(events_1.SocketEventConstants.SSH_BANNER, data.replace(/\r?\n/g, '\r\n').toString());
            });
            conn.on("tcp connection", (details, accept, reject) => {
                console.log("TCP connection request received", details);
                const channel = accept(); // Accept the connection and return a Channel object
                if (channel) {
                    channel.on("data", (data) => {
                        console.log("Received TCP data: ", data.toString());
                    });
                }
                socket.emit(events_1.SocketEventConstants.SSH_TCP_CONNECTION, details);
            });
            // conn.on('end', (err:any) => {
            //     if (err) Logging.dev('CONN END BY HOST', "error");             
            //     socket.disconnect(true);
            // });
            conn.on("change password", (message, done) => {
                console.log("Password change required: ", message);
                done("new-password"); // Provide the new password here
            });
            conn.on('keyboard-interactive', (_name, _instructions, _instructionsLang, _prompts, finish) => {
                console.log(_name, _instructions, _instructionsLang, _prompts);
                // finish([socket.request.session.userpassword]);
            });
            conn.on("hostkeys", (keys) => {
                console.log("Received host keys", keys);
                socket.emit(events_1.SocketEventConstants.SSH_HOST_KEYS, keys);
            });
            conn.on('handshake', (data) => {
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
            logger_1.Logging.dev(`SOCKET DISCONNECTING: ${reason}`);
            // if (login === true) {
            //     auditLog(
            //         socket,
            //         `LOGOUT user=${socket.request.session.username} from=${socket.handshake.address} host=${socket.request.session.ssh.host}:${socket.request.session.ssh.port}`
            //     );
            //     login = false;
            // }
        });
        socket.on('disconnect', () => {
            socket.emit(events_1.SocketEventConstants.SSH_DISCONNECTED);
            console.log('Client disconnected');
        });
        // socket.on('geometry', (cols:any, rows:any) => {
        //   // TODO need to rework how we pass settings to ssh2, this is less than ideal
        //   socket.request.session.ssh.cols = cols;
        //   socket.request.session.ssh.rows = rows;
        //   Logging.dev(`SOCKET GEOMETRY: termCols = ${cols}, termRows = ${rows}`);
        // });
    }
    sftpOperation(socket) {
        // Get files
        socket.on(events_1.SocketEventConstants.SFTP_GET_FILE, async (payload) => {
            const { dirPath } = payload;
            if (!dirPath)
                return socket.emit(events_1.SocketEventConstants.ERROR, 'Invalid directory path');
            try {
                const files = await sftp.list(dirPath);
                socket.emit(events_1.SocketEventConstants.SFTP_FILES_LIST, files);
            }
            catch (err) {
                socket.emit(events_1.SocketEventConstants.ERROR, 'Error fetching files');
                console.error(err);
            }
        });
        // Rename a file
        socket.on(events_1.SocketEventConstants.SFTP_RENAME_FILE, async (payload) => {
            const { oldPath, newPath } = payload;
            if (!oldPath || !newPath)
                return socket.emit('error', 'Invalid file paths');
            try {
                await sftp.rename(oldPath, newPath);
                socket.emit(events_1.SocketEventConstants.SUCCESS, 'File renamed successfully');
            }
            catch (err) {
                socket.emit(events_1.SocketEventConstants.ERROR, 'Error renaming file');
                console.error(err);
            }
        });
        // Move a file (SFTP does not have a direct move, so we use rename)
        socket.on(events_1.SocketEventConstants.SFTP_MOVE_FILE, async (payload) => {
            const { oldPath, newPath } = payload;
            if (!oldPath || !newPath)
                return socket.emit('error', 'Invalid file paths');
            try {
                await sftp.rename(oldPath, newPath);
                socket.emit(events_1.SocketEventConstants.SUCCESS, 'File moved successfully');
            }
            catch (err) {
                socket.emit(events_1.SocketEventConstants.ERROR, 'Error moving file');
                console.error(err);
            }
        });
        // Create new file
        socket.on(events_1.SocketEventConstants.SFTP_CREATE_FILE, async (payload) => {
            const { filePath } = payload;
            if (!filePath)
                return socket.emit('error', 'Invalid file path');
            try {
                await sftp.put(Buffer.from(''), filePath); // Create an empty file
                socket.emit(events_1.SocketEventConstants.SUCCESS, 'File created successfully');
            }
            catch (err) {
                socket.emit(events_1.SocketEventConstants.ERROR, 'Error creating file');
                console.error(err);
            }
        });
        // Create new folder
        socket.on(events_1.SocketEventConstants.SFTP_CREATE_DIR, async (payload) => {
            const { folderPath } = payload;
            if (!folderPath)
                return socket.emit(events_1.SocketEventConstants.ERROR, 'Invalid folder path');
            try {
                await sftp.mkdir(folderPath, true);
                socket.emit(events_1.SocketEventConstants.SUCCESS, 'Folder created successfully');
            }
            catch (err) {
                socket.emit(events_1.SocketEventConstants.ERROR, 'Error creating folder');
                console.error(err);
            }
        });
        // Delete file or folder
        socket.on(events_1.SocketEventConstants.SFTP_DELETE_FILE_OR_DIR, async (payload) => {
            const { path } = payload;
            if (!path)
                return socket.emit(events_1.SocketEventConstants.ERROR, 'Invalid path');
            try {
                await sftp.delete(path);
                socket.emit(events_1.SocketEventConstants.SUCCESS, 'Deleted successfully');
            }
            catch (err) {
                socket.emit(events_1.SocketEventConstants.ERROR, 'Error deleting file/folder');
                console.error(err);
            }
        });
    }
}
exports.SocketListener = SocketListener;
