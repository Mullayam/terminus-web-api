/**
 * Wire types for the Codeium integration.
 *
 * Two boundaries live here:
 *  - The browser ↔ companion HTTP contract (§2).
 *  - The companion ↔ language-server Connect-RPC contract (§5). Requests are
 *    snake_case; responses come back camelCase.
 */

// ─── Browser ↔ companion (§2.1) ───────────────────────────────────────────────

export interface ClientDocument {
  filePath: string;
  languageId: string;
  text: string;
  cursorPosition: { lineNumber: number; column: number };
  lineEnding: "\n" | "\r\n";
}

export interface ClientOtherDocument {
  filePath: string;
  languageId: string;
  text: string;
}

export interface CompleteRequestBody {
  requestId: number;
  document: ClientDocument;
  otherDocuments?: ClientOtherDocument[];
  editorOptions?: { tabSize: number; insertSpaces: boolean };
}

export interface CompletionResult {
  id: string;
  text: string;
  range?: {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  };
}

export interface CompleteResponse {
  completions: CompletionResult[];
}

export interface AcceptRequestBody {
  completionId: string;
}

export interface AuthRequestBody {
  /** The token copied from Codeium's profile page (§4.1). */
  token: string;
  /** When per-user keys are enabled, the Terminus user this key belongs to. */
  user?: string;
}

// ─── Companion ↔ language server (§5) ─────────────────────────────────────────

export interface CodeiumMetadata {
  api_key: string;
  ide_name: string;
  ide_version: string;
  extension_name: string;
  extension_version: string;
  /** Added only to GetCompletions, and only to enable CancelRequest (§5.1). */
  request_id?: number;
}

export interface CodeiumDocument {
  text: string;
  /** Raw language id, or "unspecified" when unknown. */
  editor_language: string;
  /** Numeric language enum (§7). */
  language: number;
  /** 0-based row; col is a UTF-8 byte offset. */
  cursor_position: { row: number; col: number };
  absolute_path_migrate_me_to_uri: string;
  /** Omitted when unknown. */
  line_ending?: string;
}

export interface GetCompletionsRequest {
  metadata: CodeiumMetadata;
  document: CodeiumDocument;
  editor_options?: { tab_size: number; insert_spaces: boolean };
  other_documents: CodeiumDocument[];
}

/** int64 fields come back as strings in Connect JSON; coerce before use. */
type Int64 = number | string;

export interface CodeiumCompletionItem {
  completion?: { completionId?: string; text?: string };
  range?: { startOffset?: Int64; endOffset?: Int64 };
  suffix?: { text?: string; deltaCursorOffset?: Int64 };
  completionParts?: Array<{
    type?: string;
    prefix?: string;
    text?: string;
    line?: Int64;
  }>;
}

export interface GetCompletionsResponse {
  completionItems?: CodeiumCompletionItem[];
  /** A top-level `code` marks an error regardless of HTTP status (§5.4). */
  code?: string;
  message?: string;
}

export interface GetStatusResponse {
  status?: { message?: string };
  code?: string;
  message?: string;
}

/** Lifecycle state surfaced on the health endpoint (§9). */
export type CompanionState =
  | { phase: "disabled" }
  | { phase: "downloading" }
  | { phase: "starting" }
  | { phase: "ready"; port: number }
  | { phase: "failed"; reason: string };
