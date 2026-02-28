// LSPManager.ts
import { LSPProcess } from "./LSPProcess";
import { LSPConnection } from "./LSPConnection";

export class LSPManager {
  private sessions = new Map<string, LSPConnection>();

  async createSession(sessionId: string, language: string) {
    const { cmd, args } = this.getLanguageCommand(language);

    const lspProcess = new LSPProcess(cmd, args);

    try {
      await lspProcess.start();
      await lspProcess.initialize(null);
    } catch (err) {
      // Clean up the failed process so it doesn't leak
      lspProcess.dispose();
      throw err;
    }

    const connection = new LSPConnection(lspProcess);

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

  private getLanguageCommand(language: string): { cmd: string; args: string[] } {
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
}


