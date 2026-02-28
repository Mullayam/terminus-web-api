import { Socket } from "socket.io";
import { Client, ClientChannel } from "ssh2";
import { RedisClientType } from "redis";
import { Logging } from "@enjoys/express-utils/logger";
import { parseSSHConfig } from "./parse-ssh-config";

export interface TerminalEvents {
    /** User input → backend (default `@@SSH_EMIT_INPUT`) */
    input?: string;
    /** Backend output → terminal (default `@@SSH_EMIT_DATA`) */
    data?: string;
    /** Terminal resize → backend (default `@@SSH_EMIT_RESIZE`) */
    resize?: string;
    /** Emitted when SSH connection is ready and shell is spawned (default `@@SSH_READY`) */
    ready?: string;
}

const DEFAULT_EVENTS: Required<TerminalEvents> = {
    input: "@@SSH_EMIT_INPUT",
    data: "@@SSH_EMIT_DATA",
    resize: "@@SSH_EMIT_RESIZE",
    ready: "@@SSH_READY",
};

export class DedicatedTerminal {
    private ssh: Client | null = null;
    private stream: ClientChannel | null = null;
    private readonly events: Required<TerminalEvents>;

    constructor(
        private readonly socket: Socket,
        private readonly redisClient: RedisClientType,
        events?: TerminalEvents,
    ) {
        this.events = { ...DEFAULT_EVENTS, ...events };
        this.init();
    }

    /** Bootstrap: fetch creds from Redis → open SSH → wire socket events */
    private async init() {
        const sessionId = this.socket.handshake.query.sessionId as string;

        if (!sessionId) {
            this.socket.emit("error", "Missing sessionId in handshake");
            return;
        }

        try {
            const raw = await this.redisClient.get(`sftp:${sessionId}`);

            if (!raw) {
                this.socket.emit("error", "Session not found");
                Logging.dev(`No Redis entry for sftp:${sessionId}`, "error");
                return;
            }

            const config = parseSSHConfig(JSON.parse(raw));
            this.connect(config);
        } catch (err: any) {
            Logging.dev(`DedicatedTerminal init error: ${err.message}`, "error");
            this.socket.emit("error", `Init failed: ${err.message}`);
        }
    }



    /** Open SSH connection and spawn a shell */
    private connect(config: ReturnType<typeof parseSSHConfig>) {
        const ssh = new Client();
        this.ssh = ssh;

        ssh.on("ready", () => {
            Logging.dev(`SSH ready for ${this.socket.id}`);

            ssh.shell(
                { cols: 150, rows: 40, term: "xterm-256color" },
                (err, stream) => {
                    if (err) {
                        this.socket.emit("error", `Shell error: ${err.message}`);
                        return;
                    }

                    this.stream = stream;
                    this.bindSocketEvents(stream);

                    // cd into cwd from query before handing control to the user
                    const cwd = this.socket.handshake.query.cwd as string | undefined;
                    if (cwd) {
                        stream.write(`cd ${cwd} && clear\n`);
                        this.socket.emit(this.events.ready, true);
                    }

                    // SSH stdout → socket
                    stream.on("data", (chunk: Buffer) => {
                        this.socket.emit(this.events.data, chunk.toString("utf-8"));
                    });

                    stream.stderr.on("data", (chunk: Buffer) => {
                        Logging.dev(`STDERR: ${chunk}`, "error");
                    });

                    stream.on("close", () => {
                        this.dispose();
                    });
                },
            );
        });

        ssh.on("error", (err) => {
            Logging.dev(`SSH error: ${err.message}`, "error");
            this.socket.emit("error", `SSH error: ${err.message}`);
        });

        ssh.on("banner", (banner) => {
            this.socket.emit(this.events.data, banner.replace(/\r?\n/g, "\r\n"));
        });

        ssh.connect(config);
    }

    /** Wire socket input / resize / disconnect to the SSH stream */
    private bindSocketEvents(stream: ClientChannel) {
        this.socket.on(this.events.input, (input: string) => {
            stream.write(input);
        });

        this.socket.on(this.events.resize, (size: { cols: number; rows: number }) => {
            stream.setWindow(size.rows, size.cols, 1280, 720);
        });

        this.socket.on("disconnect", () => {
            this.dispose();
        });
    }

    /** Tear down SSH connection and stream */
    public dispose() {
        if (this.stream) {
            this.stream.close();
            this.stream = null;
        }
        if (this.ssh) {
            this.ssh.end();
            this.ssh = null;
        }
        Logging.dev(`DedicatedTerminal disposed for ${this.socket.id}`);
    }
}
