import SFTPClient from 'ssh2-sftp-client';
import { Logging } from '@enjoys/express-utils/logger';
import { SocketEventConstants } from '../socket/events';
import { Socket } from 'socket.io';

/**
 * Multi-session SFTP manager.
 *
 * Each session gets its OWN `SFTPClient` instance, so multiple SFTP panels
 * (same host or different hosts) can run concurrently.
 *
 * Sessions are keyed by `sftpSessionId` — a client-generated UUID sent via
 * the `/sftp` namespace handshake query, so every SFTP panel is independent.
 */
class SFTP_Service {
    /** Map of sftpSessionId → SFTPClient */
    sessions = new Map<string, SFTPClient>();
    sockets = new Map<string, Socket>();

    /** Check whether a particular session is connected */
    isConnected(sftpSessionId: string): boolean {
        return this.sessions.has(sftpSessionId);
    }

    /** Bind lifecycle events on a session's client so the socket is notified */
    emitSftpEvent(sftpSessionId: string, socket: Socket) {
        const client = this.sessions.get(sftpSessionId);
        if (!client) return;

        client.on('end', () => {
            Logging.dev(`SFTP connection ended [${sftpSessionId}]`, 'notice');
            socket.emit(SocketEventConstants.SFTP_ENDED, 'SFTP connection ended');
            this.sessions.delete(sftpSessionId);
            this.sockets.delete(sftpSessionId);
        });
        client.on('close', () => {
            Logging.dev(`SFTP connection closed [${sftpSessionId}]`, 'notice');
            socket.emit(SocketEventConstants.SFTP_EMIT_ERROR, 'SFTP connection closed');
            this.sessions.delete(sftpSessionId);
            this.sockets.delete(sftpSessionId);
        });
        client.on('error', (err) => {
            Logging.dev(`SFTP error [${sftpSessionId}]: ${err.message}`, 'error');
            socket.emit(SocketEventConstants.SFTP_EMIT_ERROR, 'SFTP error: ' + err.message);
            this.sessions.delete(sftpSessionId);
            this.sockets.delete(sftpSessionId);
        });
    }

    /** Create a new SFTP connection and store it under `sftpSessionId` */
    async connectSFTP(
        options: SFTPClient.ConnectOptions,
        sftpSessionId: string,
        socket: Socket
    ): Promise<SFTPClient> {
        // Dispose a stale session if one exists with this id
        await this.disconnect(sftpSessionId);

        const client = new SFTPClient();
        try {
            await client.connect(options);
            this.sessions.set(sftpSessionId, client);
            this.sockets.set(sftpSessionId, socket);

            Logging.dev(`[SFTP:ns] Client connected: ${sftpSessionId}`);
            return client;
        } catch (err: any) {
            Logging.dev(`SFTP Connection Error [${sftpSessionId}]: ${err.message}`, 'error');
            throw err;
        }
    }

    /** Get the SFTPClient for a specific session (or undefined) */
    getSession(sftpSessionId: string): SFTPClient | undefined {
        return this.sessions.get(sftpSessionId);
    }
    getSftpSocket(sftpSessionId: string): Socket | undefined {
        return this.sockets.get(sftpSessionId);
    }
    /** Disconnect & remove a single session */
    async disconnect(sftpSessionId: string): Promise<void> {
        const client = this.sessions.get(sftpSessionId);
        if (client) {
            await client.end().catch(() => { });
            this.sessions.delete(sftpSessionId);
            Logging.dev(`SFTP disconnected [${sftpSessionId}]`);
        }
    }

    /** Disconnect all sessions (graceful shutdown) */
    async disconnectAll(): Promise<void> {
        for (const [id] of this.sessions) {
            await this.disconnect(id);
        }
    }
}

export const Sftp_Service = new SFTP_Service();
