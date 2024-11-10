import { CacheServiceInstance } from '@/services/cache';
import { Client } from 'ssh2';
const redisClient = CacheServiceInstance.cache
interface SshSession {
    client: Client;
    write: (input: string) => void;
}

class TerminalService {
    private sessions: Map<string, SshSession> = new Map();

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
                            await redisClient.publish(`terminal:${sessionId}`, data.toString());
                        });

                        resolve(sshSession);
                    });
                })
                .connect(sshConfig);
        });
    }

    getSession(sessionId: string): SshSession | undefined {
        return this.sessions.get(sessionId);
    }

    handleInput(sessionId: string, input: string) {
        const session = this.getSession(sessionId);
        session?.write(input);
    }

    subscribeToSession(sessionId: string, callback: (message: string) => void) {
        redisClient.pSubscribe(`terminal:${sessionId}`, callback);
    }
}

export default new TerminalService();
