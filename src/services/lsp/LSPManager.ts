// LSPManager.ts
import { LSPProcess } from "./lspProcess";
import { LSPConnection } from "./LSPConnection";

export class LSPManager {
  private sessions = new Map<string, LSPConnection>();

  async createSession(sessionId: string, language: string) {
    const { cmd, args } = this.getLanguageCommand(language);

    const process = new LSPProcess(cmd, args);
    await process.start();
    await process.initialize(null);

    const connection = new LSPConnection(process);

    this.sessions.set(sessionId, connection);

    return connection;
  }

  getSession(sessionId: string) {
    return this.sessions.get(sessionId);
  }

  dispose(sessionId: string) {
    const session = this.sessions.get(sessionId);
    if (session) {
      session["lsp"].dispose();
      this.sessions.delete(sessionId);
    }
  }

  private getLanguageCommand(language: string) {
    switch (language) {
      case "typescript":
        return {
          cmd: "typescript-language-server",
          args: ["--stdio"]
        };
      case "python":
        return {
          cmd: "pyright-langserver",
          args: ["--stdio"]
        };
      default:
        throw new Error("Unsupported language");
    }
  }
}


// socket.on("lsp-open", async (data) => {
//   const session = await lspManager.createSession(
//     data.sessionId,
//     data.language
//   );

//   await session.openDocument(
//     data.uri,
//     data.language,
//     data.content
//   );
// });

// socket.on("lsp-change", (data) => {
//   const session = lspManager.getSession(data.sessionId);
//   session?.changeDocument(data.uri, data.version, data.content);
// });

// socket.on("lsp-complete", async (data) => {
//   const session = lspManager.getSession(data.sessionId);
//   const result = await session?.completion(data.uri, data.position);
//   socket.emit("lsp-complete-result", result);
// });