import SFTPClient from 'ssh2-sftp-client';
import { Logging } from '@enjoys/express-utils/logger';
import { SocketEventConstants } from '../socket/events';
const sftp = new SFTPClient();

class SFTP_Service {
    is_connected = false
    sessions = new Map<string, SFTPClient>();

    constructor() {
        // Reset is_connected when the SFTP connection drops

    }
    emitSftpEvent = (socket: any) => {
        sftp.on('end', () => {
            this.is_connected = false;
            Logging.dev('SFTP connection ended', 'notice');
            socket.emit(SocketEventConstants.SFTP_ENDED, 'SFTP connection ended');
        });
        sftp.on('close', () => {
            this.is_connected = false;
            Logging.dev('SFTP connection closed', 'notice');
            socket.emit(SocketEventConstants.SFTP_EMIT_ERROR, 'SFTP connection ended');

        });
        sftp.on('error', (err) => {
            this.is_connected = false;
            Logging.dev('SFTP error: ' + err.message, 'error');
            socket.emit(SocketEventConstants.SFTP_EMIT_ERROR, 'SFTP connection ended');

        });
    }
    connectSFTP = async (options: SFTPClient.ConnectOptions, sessionId: string): Promise<void> => {
        try {
            // If there's a stale connection, end it first
            if (this.is_connected) {
                await sftp.end().catch(() => { });
                this.is_connected = false;
            }
            await sftp.connect(options);
            this.is_connected = true;
            this.sessions.set(sessionId, sftp);
            Logging.dev('Connected to SFTP server');
        } catch (err) {
            this.is_connected = false;
            Logging.dev('SFTP Connection Error:' + err, 'error');
        }
    };
    getSftpInstance = (): SFTPClient => sftp;

}
export const Sftp_Service = new SFTP_Service()
