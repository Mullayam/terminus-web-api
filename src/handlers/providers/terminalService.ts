import { publisher, subscriber } from '@/services/cache';
import { Client } from 'ssh2';

interface SshSession {
    client: Client;
    write: (input: string) => void;
}
interface SessionPermissions {
    read: boolean;
    write: boolean;
}
class TerminalService {
    private sessions: Map<string, SshSession> = new Map();
    private sessionPermissions: Map<string, Map<string, SessionPermissions>> = new Map();
    async createSshSession(sessionId: string, sshConfig: any): Promise<SshSession> {
        const client = new Client();
        return new Promise((resolve, reject) => {
            client
                .on('ready', () => {
                    client.shell({ cols: 130, rows: 30, term: 'xterm-256color' }, (err, stream) => {
                        if (err) {
                            reject(err);
                            return;
                        }
                        const sshSession: SshSession = {
                            client,
                            write: (input: string) => stream.write(input),
                        };

                        this.sessions.set(sessionId, sshSession);

                        stream.on('close', () => {
                            this.sessions.delete(sessionId);
                        })
                        stream.on('data', async (data: any) => {
                            await publisher.publish(`terminal:${sessionId}`, data.toString('utf-8'));
                        });

                        resolve(sshSession);
                    });
                })
                .connect(sshConfig);
        });
    }
   
    // Set permissions for users on a given session
    setPermissions(sessionId: string, userId: string, permissions: SessionPermissions) {
        if (!this.sessionPermissions.has(sessionId)) {
            this.sessionPermissions.set(sessionId, new Map());
        }
        const sessionPermissionMap = this.sessionPermissions.get(sessionId);
        if (sessionPermissionMap) {
            sessionPermissionMap.set(userId, permissions);
        }
    }
    // Get permissions for a user on a session
    getPermissions(sessionId: string, userId: string): SessionPermissions | undefined {
        return this.sessionPermissions.get(sessionId)?.get(userId);
    }

    getSession(sessionId: string): SshSession | undefined {
        return this.sessions.get(sessionId);
    }

    handleInput(sessionId: string, input: string) {
        const session = this.getSession(sessionId);
        session?.write(input);
    }
 
    subscribeToSession(sessionId: string, callback: (message: string) => void) {
        subscriber.subscribe(`terminal:${sessionId}`, callback);
    }
    unSubscribeToSession(sessionId: string, callback: (message: string) => void) {
        subscriber.unsubscribe(`terminal:${sessionId}`, callback);
    }
}

export default new TerminalService();
