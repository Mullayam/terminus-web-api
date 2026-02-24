// LSPProcess.ts
import { spawn, ChildProcess } from "child_process";

import * as rpc from 'vscode-jsonrpc/node';
export class LSPProcess {
    private process!: ChildProcess;
    private connection!: rpc.MessageConnection;

    constructor(private command: string, private args: string[]) { }

    async start() {
        this.process = spawn(this.command, this.args);

        const reader = new rpc.StreamMessageReader(this.process.stdout);
        const writer = new rpc.StreamMessageWriter(this.process.stdin);

        this.connection = rpc.createMessageConnection(reader, writer);

        this.connection.listen();

        this.process.on("exit", (code) => {
            console.error("LSP exited:", code);
        });
    }

    async initialize(rootUri: string | null) {
        return this.connection.sendRequest("initialize", {
            processId: process.pid,
            rootUri,
            capabilities: {}
        });
    }

    sendNotification(method: string, params: any) {
        this.connection.sendNotification(method, params);
    }

    sendRequest(method: string, params: any) {
        return this.connection.sendRequest(method, params);
    }

    dispose() {
        this.connection.dispose();
        this.process.kill();
    }
}