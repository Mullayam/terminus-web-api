import { IncomingMessage } from "http";
import { Server as HttpServer } from "http";
import { URL } from "url";
import { WebSocketServer, WebSocket } from "ws";
import {
  IWebSocket,
  WebSocketMessageReader,
  WebSocketMessageWriter,
  toSocket,
} from "vscode-ws-jsonrpc";
import {
  createConnection,
  createServerProcess,
  forward,
} from "vscode-ws-jsonrpc/server";
import { Logging } from "@enjoys/express-utils/logger";

/**
 * Maps a languageId to the LSP server command + args.
 * Extend this as you add more language servers.
 */
function getLanguageCommand(language: string): { cmd: string; args: string[] } {
  switch (language) {
    // ── Web core ──────────────────────────────────────────────
    case "typescript":
    case "javascript":
      return { cmd: "typescript-language-server", args: ["--stdio"] };
    case "python":
      return { cmd: "pyright-langserver", args: ["--stdio"] };
    case "json":
    case "jsonc":
      return { cmd: "vscode-json-languageserver", args: ["--stdio"] };
    case "css":
    case "scss":
    case "less":
      return { cmd: "css-languageserver", args: ["--stdio"] };
    case "html":
      return { cmd: "html-languageserver", args: ["--stdio"] };

    // ── Shell ─────────────────────────────────────────────────
    case "shellscript":
    case "bash":
    case "sh":
    case "zsh":
    case "fish":
      return { cmd: "bash-language-server", args: ["start"] };
    case "bat":
    case "powershell":
      return { cmd: "powershell-editor-services", args: ["--stdio"] };

    // ── Docker ────────────────────────────────────────────────
    case "dockerfile":
    case "docker":
      return { cmd: "docker-langserver", args: ["--stdio"] };
    case "dockercompose":
      return { cmd: "docker-compose-langserver", args: ["--stdio"] };

    // ── Config / Data ─────────────────────────────────────────
    case "yaml":
    case "yml":
      return { cmd: "yaml-language-server", args: ["--stdio"] };
    case "toml":
      return { cmd: "taplo", args: ["lsp", "stdio"] };
    case "xml":
      return { cmd: "lemminx", args: ["--stdio"] };
    case "ini":
      return { cmd: "ini-language-server", args: ["--stdio"] };
    case "nginx":
      return { cmd: "nginx-language-server", args: ["--stdio"] };

    // ── Infrastructure ────────────────────────────────────────
    case "terraform":
    case "hcl":
      return { cmd: "terraform-ls", args: ["serve"] };
    case "bicep":
      return { cmd: "bicep-langserver", args: ["--stdio"] };
    case "ansible":
      return { cmd: "ansible-language-server", args: ["--stdio"] };
    case "puppet":
      return { cmd: "puppet-languageserver", args: ["--stdio"] };
    case "nix":
      return { cmd: "nil", args: [] };

    // ── Database / Query ──────────────────────────────────────
    case "sql":
    case "mysql":
    case "pgsql":
      return { cmd: "sql-language-server", args: ["up", "--method", "stdio"] };
    case "graphql":
      return { cmd: "graphql-lsp", args: ["server", "--method", "stream"] };
    case "prisma":
      return { cmd: "prisma-language-server", args: ["--stdio"] };

    // ── Web frameworks ────────────────────────────────────────
    case "vue":
      return { cmd: "vue-language-server", args: ["--stdio"] };
    case "svelte":
      return { cmd: "svelteserver", args: ["--stdio"] };
    case "astro":
      return { cmd: "astro-ls", args: ["--stdio"] };

    // ── Scripting ─────────────────────────────────────────────
    case "lua":
      return { cmd: "lua-language-server", args: ["--stdio"] };
    case "perl":
      return { cmd: "perl-language-server", args: ["--stdio"] };
    case "r":
      return { cmd: "r-languageserver", args: ["--stdio"] };
    case "julia":
      return { cmd: "julia-language-server", args: ["--stdio"] };
    case "elixir":
      return { cmd: "elixir-ls", args: ["--stdio"] };
    case "erlang":
      return { cmd: "erlang_ls", args: ["--stdio"] };
    case "dart":
      return { cmd: "dart", args: ["language-server", "--protocol=lsp"] };

    // ── Functional ────────────────────────────────────────────
    case "haskell":
      return { cmd: "haskell-language-server-wrapper", args: ["--lsp"] };
    case "ocaml":
      return { cmd: "ocamllsp", args: [] };
    case "clojure":
      return { cmd: "clojure-lsp", args: ["listen"] };

    // ── .NET ──────────────────────────────────────────────────
    case "fsharp":
      return { cmd: "fsautocomplete", args: ["--adaptive-lsp-server-enabled"] };
    case "vb":
      return { cmd: "omnisharp", args: ["-lsp", "--stdio"] };

    // ── JVM ───────────────────────────────────────────────────
    case "scala":
      return { cmd: "metals", args: [] };
    case "groovy":
      return { cmd: "groovy-language-server", args: ["--stdio"] };

    // ── Modern / Systems ──────────────────────────────────────
    case "zig":
      return { cmd: "zls", args: [] };
    case "nim":
      return { cmd: "nimlangserver", args: [] };
    case "v":
      return { cmd: "v-analyzer", args: ["--stdio"] };

    // ── Docs / Markup ─────────────────────────────────────────
    case "markdown":
      return { cmd: "marksman", args: ["server"] };
    case "latex":
    case "tex":
      return { cmd: "texlab", args: [] };
    case "restructuredtext":
      return { cmd: "esbonio", args: [] };

    // ── Other ─────────────────────────────────────────────────
    case "cmake":
      return { cmd: "cmake-language-server", args: [] };
    case "makefile":
      return { cmd: "make-language-server", args: ["--stdio"] };
    case "proto3":
      return { cmd: "buf", args: ["beta", "lsp"] };
    case "solidity":
      return { cmd: "solidity-ls", args: ["--stdio"] };
    case "wgsl":
      return { cmd: "wgsl_analyzer", args: [] };
    case "glsl":
      return { cmd: "glsl_analyzer", args: [] };

    default:
      throw new Error(`Unsupported language: ${language}`);
  }
}

/**
 * Attaches a WebSocket server at the given `path` to the HTTP server.
 *
 * Clients connect via:
 *   ws://host:port/lsp?languageId=typescript
 *
 * The server spawns the matching LSP process and creates a full JSON-RPC
 * bridge between the WebSocket and the stdio streams of the LSP.
 *
 * Frontend usage (vscode-ws-jsonrpc):
 * ```ts
 * import { toSocket, WebSocketMessageReader, WebSocketMessageWriter } from "vscode-ws-jsonrpc";
 * import { createMessageConnection } from "vscode-jsonrpc";
 *
 * const ws = new WebSocket("ws://localhost:3000/lsp?languageId=typescript");
 * ws.onopen = () => {
 *   const socket = toSocket(ws);
 *   const reader = new WebSocketMessageReader(socket);
 *   const writer = new WebSocketMessageWriter(socket);
 *   const connection = createMessageConnection(reader, writer);
 *   connection.listen();
 *   // now send initialize, textDocument/*, etc. via `connection`
 * };
 * ```
 */
export function attachLSPWebSocket(
  server: HttpServer,
  path: string = "/lsp",
): void {
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (request: IncomingMessage, socket, head) => {
    const requestUrl = new URL(request.url ?? "", `http://${request.headers.host}`);

    if (requestUrl.pathname !== path) {
      // Not our path – let other upgrade handlers (socket.io, etc.) deal with it
      return;
    }

    const languageId = requestUrl.searchParams.get("languageId");

    if (!languageId) {
      Logging.dev("[LSP-WS] Rejected connection: missing languageId query param", "error");
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }

    wss.handleUpgrade(request, socket as any, head, (ws) => {
      wss.emit("connection", ws, request, languageId);
    });
  });

  wss.on("connection", (ws: WebSocket, _request: IncomingMessage, languageId: string) => {
      /**
     * Send a raw JSON-RPC notification directly over the WebSocket.
     * This bypasses vscode-ws-jsonrpc's writer so it works even when
     * the MessageConnection / stream has been torn down.
     *
     * WebSocket framing handles message boundaries — no Content-Length
     * header needed (that's only for stdio transport).
     */
    const sendRawNotification = (method: string, params: unknown) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      try {
        ws.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
      } catch {
        // Socket may already be dead – swallow silently
      }
    };
    Logging.dev(`[LSP-WS] New connection — language="${languageId}"`);
    sendRawNotification("initialize", {
      type: "1", // Info
      message: `Starting LSP server for "${languageId}"...`,
    });
    let disposed = false;

  

    try {
      const { cmd, args } = getLanguageCommand(languageId);

      // Spawn the LSP server process BEFORE creating the JSON-RPC bridge
      const serverConnection = createServerProcess(languageId, cmd, args);

      if (!serverConnection) {
        throw new Error(`Failed to start LSP process: ${cmd} ${args.join(" ")}`);
      }

      // Only now create the JSON-RPC connection over the WebSocket
      const iSocket: IWebSocket = toSocket(ws as any);
      const reader = new WebSocketMessageReader(iSocket);
      const writer = new WebSocketMessageWriter(iSocket);

      const socketConnection = createConnection(reader, writer, () => {
        if (!disposed) {
          disposed = true;
          ws.close();
          Logging.dev(`[LSP-WS] Client disconnected (language="${languageId}")`);
        }
      });

      // Bridge: WebSocket ↔ LSP stdio
      forward(socketConnection, serverConnection, (message) => {
        return message;
      });

      Logging.dev(`[LSP-WS] LSP process started: ${cmd} ${args.join(" ")}`);
    } catch (err: any) {
      Logging.dev(`[LSP-WS] Error: ${err.message}`, "error");

      // Send notifications via raw WebSocket — safe even if streams are destroyed
      sendRawNotification("$/lspError", {
        languageId,
        error: err.message,
        severity: "error",
      });
      sendRawNotification("window/showMessage", {
        type: 1,
        message: `LSP server failed for "${languageId}": ${err.message}`,
      });

      // Give the client a moment to receive the notifications, then close
      setTimeout(() => {
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          ws.close(1011, err.message);
        }
      }, 200);
    }
  });

  Logging.dev(`[LSP-WS] WebSocket LSP server listening on upgrade path "${path}"`);
}
