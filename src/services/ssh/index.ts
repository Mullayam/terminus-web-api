import { NodeSSH, SSHExecCommandResponse, Config as SSHConfig } from 'node-ssh';
import { Logging } from '@enjoys/express-utils/logger';

export interface SSHConnectionOptions {
    host: string;
    port?: number;
    username: string;
    password?: string;
    privateKey?: string;
    privateKeyPath?: string;
}

export class SSH_Service {
    private sessions = new Map<string, NodeSSH>();

    /** Get an existing SSH session by ID */
    getSession(sessionId: string): NodeSSH | undefined {
        return this.sessions.get(sessionId);
    }

    /** Check if a session exists and is connected */
    isConnected(sessionId: string): boolean {
        const ssh = this.sessions.get(sessionId);
        return !!ssh && ssh.isConnected();
    }

    /** Connect to a remote host via SSH */
    async connect(sessionId: string, options: SSHConnectionOptions): Promise<NodeSSH> {
        // Dispose stale session if exists
        if (this.sessions.has(sessionId)) {
            await this.disconnect(sessionId);
        }

        const ssh = new NodeSSH();

        const config: SSHConfig = {
            host: options.host,
            port: options.port ?? 22,
            username: options.username,
        };

        if (options.password) {
            config.password = options.password;
        } else if (options.privateKey) {
            config.privateKey = options.privateKey;
        } else if (options.privateKeyPath) {
            config.privateKeyPath = options.privateKeyPath;
        }

        try {
            await ssh.connect(config);
            this.sessions.set(sessionId, ssh);
            Logging.dev(`SSH connected: session=${sessionId} host=${options.host}`);
            return ssh;
        } catch (err: any) {
            Logging.dev(`SSH connect error [${sessionId}]: ${err.message}`, 'error');
            throw err;
        }
    }

    /** Execute a command on the remote host */
    async exec(sessionId: string, command: string, cwd?: string): Promise<SSHExecCommandResponse> {
        const ssh = this.requireSession(sessionId);
        return ssh.execCommand(command, { cwd });
    }

    /** List directory contents */
    async listDir(sessionId: string, dirPath: string): Promise<string[]> {
        const ssh = this.requireSession(sessionId);
        const result = await ssh.execCommand(`ls -la "${dirPath}"`);
        if (result.stderr) throw new Error(result.stderr);
        return result.stdout.split('\n').filter(Boolean);
    }

    /** Read file content from remote */
    async readFile(sessionId: string, remotePath: string): Promise<string> {
        const ssh = this.requireSession(sessionId);
        const result = await ssh.execCommand(`cat "${remotePath}"`);
        if (result.stderr) throw new Error(result.stderr);
        return result.stdout;
    }

    /** Write content to a remote file */
    async writeFile(sessionId: string, remotePath: string, content: string): Promise<void> {
        const ssh = this.requireSession(sessionId);
        // Use heredoc to avoid escaping issues
        const result = await ssh.execCommand(`cat > "${remotePath}" << 'NODEssh_EOF'\n${content}\nNODESSH_EOF`);
        if (result.stderr && result.code !== 0) throw new Error(result.stderr);
    }

    /** Upload a file from local to remote */
    async putFile(sessionId: string, localPath: string, remotePath: string): Promise<void> {
        const ssh = this.requireSession(sessionId);
        await ssh.putFile(localPath, remotePath);
    }

    /** Download a file from remote to local */
    async getFile(sessionId: string, localPath: string, remotePath: string): Promise<void> {
        const ssh = this.requireSession(sessionId);
        await ssh.getFile(localPath, remotePath);
    }

    /** Upload a directory from local to remote */
    async putDirectory(sessionId: string, localDir: string, remoteDir: string): Promise<void> {
        const ssh = this.requireSession(sessionId);
        const failed: string[] = [];
        await ssh.putDirectory(localDir, remoteDir, {
            recursive: true,
            concurrency: 5,
            tick: (localPath, _remotePath, error) => {
                if (error) {
                    failed.push(localPath);
                    Logging.dev(`Upload failed: ${localPath} → ${error.message}`, 'error');
                }
            },
        });
        if (failed.length) {
            throw new Error(`Failed to upload ${failed.length} file(s): ${failed.join(', ')}`);
        }
    }

    /** Create a directory on the remote host */
    async mkdir(sessionId: string, dirPath: string): Promise<void> {
        const ssh = this.requireSession(sessionId);
        const result = await ssh.execCommand(`mkdir -p "${dirPath}"`);
        if (result.stderr && result.code !== 0) throw new Error(result.stderr);
    }

    /** Delete a file on the remote host */
    async deleteFile(sessionId: string, remotePath: string): Promise<void> {
        const ssh = this.requireSession(sessionId);
        const result = await ssh.execCommand(`rm -f "${remotePath}"`);
        if (result.stderr && result.code !== 0) throw new Error(result.stderr);
    }

    /** Delete a directory on the remote host */
    async deleteDir(sessionId: string, dirPath: string): Promise<void> {
        const ssh = this.requireSession(sessionId);
        const result = await ssh.execCommand(`rm -rf "${dirPath}"`);
        if (result.stderr && result.code !== 0) throw new Error(result.stderr);
    }

    /** Rename/move a file or directory */
    async rename(sessionId: string, oldPath: string, newPath: string): Promise<void> {
        const ssh = this.requireSession(sessionId);
        const result = await ssh.execCommand(`mv "${oldPath}" "${newPath}"`);
        if (result.stderr && result.code !== 0) throw new Error(result.stderr);
    }

    /** Check if a path exists */
    async exists(sessionId: string, remotePath: string): Promise<boolean> {
        const ssh = this.requireSession(sessionId);
        const result = await ssh.execCommand(`test -e "${remotePath}" && echo "exists" || echo "not_found"`);
        return result.stdout.trim() === 'exists';
    }

    /** Get file/dir stats */
    async stat(sessionId: string, remotePath: string): Promise<string> {
        const ssh = this.requireSession(sessionId);
        const result = await ssh.execCommand(`stat "${remotePath}"`);
        if (result.stderr && result.code !== 0) throw new Error(result.stderr);
        return result.stdout;
    }

    /** Get current working directory */
    async cwd(sessionId: string): Promise<string> {
        const ssh = this.requireSession(sessionId);
        const result = await ssh.execCommand('pwd');
        return result.stdout.trim();
    }

    /** Disconnect a session */
    async disconnect(sessionId: string): Promise<void> {
        const ssh = this.sessions.get(sessionId);
        if (ssh) {
            ssh.dispose();
            this.sessions.delete(sessionId);
            Logging.dev(`SSH disconnected: session=${sessionId}`);
        }
    }

    /** Disconnect all sessions */
    async disconnectAll(): Promise<void> {
        for (const [id] of this.sessions) {
            await this.disconnect(id);
        }
    }

    /** Get session or throw */
    private requireSession(sessionId: string): NodeSSH {
        const ssh = this.sessions.get(sessionId);
        if (!ssh || !ssh.isConnected()) {
            throw new Error(`SSH session "${sessionId}" is not connected`);
        }
        return ssh;
    }
}

export const sshService = new SSH_Service();
