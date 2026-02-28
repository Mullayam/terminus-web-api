import { Socket } from "socket.io";
import { Logging } from "@enjoys/express-utils/logger";
import { LSPManager } from "../lsp/LSPManager";
import { LSPConnection } from "../lsp/LSPConnection";
import { SocketEventConstants } from "./events";

const E = SocketEventConstants;

/**
 * LSP Socket Namespace  –  /lsp
 *
 * Handshake query params:
 *   languageId  : "typescript" | "python"   (required)
 *   sessionId   : unique session key         (required)
 *   rootUri     : workspace root URI         (optional)
 *
 * ─── Client → Server ────────────────────────────────────────────────────────
 *   @@LSP_OPEN      { uri, content }
 *   @@LSP_CHANGE    { uri, version, content }
 *   @@LSP_COMPLETE  { uri, position: { line, character } }
 *   @@LSP_HOVER     { uri, position: { line, character } }
 *   @@LSP_CLOSE     { uri }
 *
 * ─── Server → Client ────────────────────────────────────────────────────────
 *   @@LSP_READY            { sessionId, languageId }
 *   @@LSP_COMPLETE_RESULT  completion items[]
 *   @@LSP_HOVER_RESULT     hover result
 *   @@LSP_ERROR            { message }
 */

const lspManager = new LSPManager();

export class LSPNamespace {
  private connection: LSPConnection | null = null;
  private readonly sessionId: string;
  private readonly languageId: string;
  private readonly rootUri: string | null;

  constructor(private readonly socket: Socket) {
    const query = socket.handshake.query;

    this.sessionId = (query.sessionId as string) ?? socket.id;
    this.languageId = (query.languageId as string) ?? "";
    this.rootUri = (query.rootUri as string) ?? null;

    this.init().catch((err) => {
      Logging.dev(
        `[LSP] Unhandled error in init for "${this.languageId}": ${err?.message ?? err}`,
        "error",
      );
      this.socket.emit(E.LSP_ERROR, {
        message: `LSP init failed: ${err?.message ?? "Unknown error"}`,
      });
      this.socket.disconnect(true);
    });
  }

  // ── Lifecycle ─────────────────────────────────────────────────────────────

  private async init() {
    if (!this.languageId) {
      this.socket.emit(E.LSP_ERROR, {
        message: "languageId is required in handshake query.",
      });
      this.socket.disconnect(true);
      return;
    }

    Logging.dev(
      `[LSP] Socket ${this.socket.id} → language="${this.languageId}" session="${this.sessionId}"`,
    );

    try {
      this.connection = await lspManager.createSession(
        this.sessionId,
        this.languageId,
      );
      this.socket.emit(E.LSP_READY, {
        sessionId: this.sessionId,
        languageId: this.languageId,
      });
      Logging.dev(
        `[LSP] Session ready: ${this.sessionId} (${this.languageId})`,
      );
    } catch (err: any) {
      Logging.dev(
        `[LSP] Failed to start LSP for "${this.languageId}": ${err.message}`,
        "error",
      );
      this.socket.emit(E.LSP_ERROR, {
        message: `Cannot start LSP server for "${this.languageId}": ${err.message}`,
      });
      this.socket.emit(E.EDITOR_NOTIFICATION, {
        type: "error",
        title: "LSP Server Error",
        message: `Failed to start LSP for "${this.languageId}": ${err.message}`,
      });
      this.socket.disconnect(true);
      return;
    }

    this.registerEvents();
  }

  // ── Event wiring ──────────────────────────────────────────────────────────

  private registerEvents() {
    const { socket } = this;

    // ── Open a document ──────────────────────────────────────────────────
    socket.on(E.LSP_OPEN, async (data: { uri: string; content: string }) => {
      try {
        await this.connection!.openDocument(
          data.uri,
          this.languageId,
          data.content,
        );
      } catch (err: any) {
        socket.emit(E.LSP_ERROR, {
          message: `LSP_OPEN failed – ${err.message}`,
        });
      }
    });

    // ── Document changed ─────────────────────────────────────────────────
    socket.on(
      E.LSP_CHANGE,
      (data: { uri: string; version: number; content: string }) => {
        try {
          this.connection!.changeDocument(data.uri, data.version, data.content);
        } catch (err: any) {
          socket.emit(E.LSP_ERROR, {
            message: `LSP_CHANGE failed – ${err.message}`,
          });
        }
      },
    );

    // ── Completion request ───────────────────────────────────────────────
    socket.on(
      E.LSP_COMPLETE,
      async (data: {
        uri: string;
        position: { line: number; character: number };
      }) => {
        try {
          const result = await this.connection!.completion(
            data.uri,
            data.position,
          );
          socket.emit(E.LSP_COMPLETE_RESULT, result ?? []);
        } catch (err: any) {
          socket.emit(E.LSP_ERROR, {
            message: `LSP_COMPLETE failed – ${err.message}`,
          });
        }
      },
    );

    // ── Hover request ────────────────────────────────────────────────────
    socket.on(
      E.LSP_HOVER,
      async (data: {
        uri: string;
        position: { line: number; character: number };
      }) => {
        try {
          const result = await this.connection!.hover(data.uri, data.position);
          socket.emit(E.LSP_HOVER_RESULT, result ?? null);
        } catch (err: any) {
          socket.emit(E.LSP_ERROR, {
            message: `LSP_HOVER failed – ${err.message}`,
          });
        }
      },
    );

    // ── Close a document ─────────────────────────────────────────────────
    socket.on(E.LSP_CLOSE, (data: { uri: string }) => {
      try {
        this.connection!.closeDocument(data.uri);
      } catch {
        // Ignore – connection may already be closing
      }
    });

    // ── Disconnect ───────────────────────────────────────────────────────
    socket.on("disconnect", (reason) => {
      Logging.dev(`[LSP] Disconnect: ${this.socket.id} (${reason})`);
      this.dispose();
    });
  }

  // ── Cleanup ───────────────────────────────────────────────────────────────

  private dispose() {
    lspManager.dispose(this.sessionId);
    this.connection = null;
    Logging.dev(`[LSP] Session disposed: ${this.sessionId}`);
  }
}
