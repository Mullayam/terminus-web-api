// LSPConnection.ts
import { LSPProcess } from "./LSPProcess";

export class LSPConnection {
  constructor(private lsp: LSPProcess) {}

  async openDocument(uri: string, language: string, content: string) {
    this.lsp.sendNotification("textDocument/didOpen", {
      textDocument: {
        uri,
        languageId: language,
        version: 1,
        text: content
      }
    });
  }

  changeDocument(uri: string, version: number, content: string) {
    this.lsp.sendNotification("textDocument/didChange", {
      textDocument: { uri, version },
      contentChanges: [{ text: content }]
    });
  }

  async completion(uri: string, position: any) {
    return this.lsp.sendRequest("textDocument/completion", {
      textDocument: { uri },
      position
    });
  }

  async hover(uri: string, position: any) {
    return this.lsp.sendRequest("textDocument/hover", {
      textDocument: { uri },
      position
    });
  }
}