// LSPProcess.ts
import { spawn, ChildProcess } from "child_process";
import * as rpc from "vscode-jsonrpc/node";

export class LSPProcess {
    private process: ChildProcess | null = null;
    private connection: rpc.MessageConnection | null = null;
    private _disposed = false;

    constructor(private command: string, private args: string[]) {}

    get isRunning(): boolean {
        return this.process !== null && !this._disposed;
    }

    async start(): Promise<void> {
        if (this._disposed) {
            throw new Error("Cannot start a disposed LSP process");
        }

        this.process = spawn(this.command, this.args, {
            stdio: ["pipe", "pipe", "pipe"],
        });

        if (!this.process.stdout || !this.process.stdin) {
            this.process.kill();
            throw new Error("Failed to attach stdio streams to LSP process");
        }

        const reader = new rpc.StreamMessageReader(this.process.stdout);
        const writer = new rpc.StreamMessageWriter(this.process.stdin);

        this.connection = rpc.createMessageConnection(reader, writer);

        this.connection.onError(([error, message, code]) => {
            console.error(`LSP connection error [${code}]:`, error.message, message);
        });

        this.connection.onClose(() => {
            console.warn("LSP connection closed");
        });

        this.connection.listen();

        this.process.stderr?.on("data", (data: Buffer) => {
            console.error(`LSP stderr: ${data.toString()}`);
        });

        this.process.on("error", (err) => {
            console.error("LSP process error:", err.message);
        });

        this.process.on("exit", (code, signal) => {
            console.warn(`LSP process exited (code=${code}, signal=${signal})`);
            this.process = null;
        });
    }

    async initialize(rootUri: string | null): Promise<any> {
        this.ensureConnection();

        const result = await this.connection!.sendRequest("initialize", {
            processId: process.pid,
            rootUri,
            capabilities: {},
        });

        // LSP spec requires an 'initialized' notification after the initialize response
        this.connection!.sendNotification("initialized", {});

        return result;
    }

    sendNotification(method: string, params: any): void {
        this.ensureConnection();
        this.connection!.sendNotification(method, params);
    }

    sendRequest(method: string, params: any): Promise<any> {
        this.ensureConnection();
        return this.connection!.sendRequest(method, params);
    }

    dispose(): void {
        if (this._disposed) return;
        this._disposed = true;

        try {
            this.connection?.sendNotification("shutdown");
            this.connection?.sendNotification("exit");
        } catch {
            // Ignore errors during shutdown—process may already be dead
        }

        this.connection?.dispose();
        this.connection = null;

        if (this.process) {
            this.process.kill();
            this.process = null;
        }
    }

    private ensureConnection(): void {
        if (!this.connection || this._disposed) {
            throw new Error("LSP connection is not available. Call start() first or the process has been disposed.");
        }
    }
}