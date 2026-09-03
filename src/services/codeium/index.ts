import { Logging } from "@enjoys/express-utils/logger";
import { __CONFIG__ } from "../../utils/constant";
import { LanguageServerManager } from "./manager";
import { toCodeiumLanguage } from "./languages";
import {
  splitLines,
  monacoCursorToCodeium,
  codeiumRangeToMonaco,
} from "./coordinates";
import { heartbeatApiKey } from "./auth";
import type {
  ClientDocument,
  ClientOtherDocument,
  CodeiumDocument,
  CodeiumMetadata,
  CompanionState,
  CompletionResult,
  GetCompletionsRequest,
  GetCompletionsResponse,
} from "./types";

/** RPC method names — fixed constants, never forwarded from the browser (§10). */
const METHOD = {
  GetCompletions: "GetCompletions",
  AcceptCompletion: "AcceptCompletion",
  CancelRequest: "CancelRequest",
} as const;

/** §5.1 metadata. `request_id` is added only to GetCompletions. */
function buildMetadata(apiKey: string, requestId?: number): CodeiumMetadata {
  const metadata: CodeiumMetadata = {
    api_key: apiKey,
    ide_name: "web",
    ide_version: "1.0.0",
    extension_name: "terminus",
    extension_version: __CONFIG__.CODEIUM.VERSION,
  };
  if (requestId !== undefined) metadata.request_id = requestId;
  return metadata;
}

const manager = new LanguageServerManager({
  buildMetadata: async () => {
    const key = await heartbeatApiKey();
    return key ? buildMetadata(key) : null;
  },
});

export interface GetCompletionsParams {
  apiKey: string;
  /** Identifies a browser session so a new request can cancel the previous one. */
  sessionKey: string;
  document: ClientDocument;
  otherDocuments?: ClientOtherDocument[];
  editorOptions?: { tabSize: number; insertSpaces: boolean };
}

interface Metrics {
  requested: number;
  returned: number;
  accepted: number;
  cancels: number;
  errors: number;
}

/**
 * High-level Codeium proxy. Composes the manager transport with coordinate
 * conversion, per-session cancellation, a monotonic request_id, a per-user
 * concurrency gate, and metrics (spec §5, §8).
 */
class CodeiumService {
  /** Server-side monotonic id, distinct from the browser's per-tab requestId. */
  private requestCounter = 0;
  private lastRequestBySession = new Map<string, number>();
  private inFlight = new Map<string, number>();
  private latencies: number[] = [];
  private metrics: Metrics = {
    requested: 0,
    returned: 0,
    accepted: 0,
    cancels: 0,
    errors: 0,
  };

  /** Exposed so heartbeat/status and callers share one metadata shape. */
  readonly metadata = buildMetadata;

  async init(): Promise<void> {
    if (!__CONFIG__.CODEIUM.ENABLED) {
      Logging.dev("[codeium] Disabled (CODEIUM_ENABLED != true)", "notice");
      return;
    }
    await manager.start();
  }

  async shutdown(): Promise<void> {
    await manager.stop();
  }

  isReady(): boolean {
    return manager.isReady();
  }

  getState(): CompanionState {
    return manager.getState();
  }

  // ─── Concurrency gate (§8 step 2) ───────────────────────────────────────────

  acquireSlot(user: string): boolean {
    const n = this.inFlight.get(user) ?? 0;
    if (n >= __CONFIG__.CODEIUM.MAX_CONCURRENT_PER_USER) return false;
    this.inFlight.set(user, n + 1);
    return true;
  }

  releaseSlot(user: string): void {
    const n = this.inFlight.get(user) ?? 0;
    if (n <= 1) this.inFlight.delete(user);
    else this.inFlight.set(user, n - 1);
  }

  // ─── Completions (§5.3 / §5.4) ──────────────────────────────────────────────

  async getCompletions(params: GetCompletionsParams): Promise<CompletionResult[]> {
    this.metrics.requested++;

    if (!manager.isReady()) {
      // Degraded mode: a dead server must look like "no suggestion", not an error.
      return [];
    }

    const { apiKey, sessionKey, document, otherDocuments, editorOptions } = params;
    const lines = splitLines(document.text, document.lineEnding);
    const cursor = monacoCursorToCodeium(lines, document.cursorPosition);
    const lang = toCodeiumLanguage(document.languageId);

    const codeiumDocument: CodeiumDocument = {
      text: document.text,
      editor_language: lang.editorLanguage,
      language: lang.language,
      cursor_position: cursor,
      absolute_path_migrate_me_to_uri: document.filePath,
      line_ending: document.lineEnding,
    };

    const others: CodeiumDocument[] = (otherDocuments ?? [])
      .slice(0, 3)
      .map((d) => {
        const l = toCodeiumLanguage(d.languageId);
        return {
          text: d.text,
          editor_language: l.editorLanguage,
          language: l.language,
          cursor_position: { row: 0, col: 0 },
          absolute_path_migrate_me_to_uri: d.filePath,
        };
      });

    // A new request supersedes the session's previous in-flight one (§5.5).
    const requestId = ++this.requestCounter;
    await this.cancelSession(sessionKey);
    this.lastRequestBySession.set(sessionKey, requestId);

    const requestBody: GetCompletionsRequest = {
      metadata: buildMetadata(apiKey, requestId),
      document: codeiumDocument,
      other_documents: others,
    };
    if (editorOptions) {
      requestBody.editor_options = {
        tab_size: editorOptions.tabSize,
        insert_spaces: editorOptions.insertSpaces,
      };
    }

    const startedAt = Date.now();
    let response: GetCompletionsResponse;
    try {
      response = await manager.rpc<GetCompletionsResponse>(
        METHOD.GetCompletions,
        requestBody,
      );
    } catch (err) {
      this.metrics.errors++;
      Logging.dev(`[codeium] GetCompletions failed: ${(err as Error).message}`, "notice");
      return [];
    } finally {
      this.recordLatency(Date.now() - startedAt);
    }

    // A top-level `code` marks an error regardless of HTTP status (§5.4).
    if (response.code) {
      this.metrics.errors++;
      Logging.dev(
        `[codeium] GetCompletions error: ${response.code} ${response.message ?? ""}`,
        "notice",
      );
      return [];
    }

    const cursorLine = lines[document.cursorPosition.lineNumber - 1] ?? "";
    const results = this.mapCompletionItems(response, cursorLine, document.cursorPosition.lineNumber);
    this.metrics.returned += results.length;
    return results;
  }

  private mapCompletionItems(
    response: GetCompletionsResponse,
    cursorLine: string,
    lineNumber: number,
  ): CompletionResult[] {
    const results: CompletionResult[] = [];

    for (const item of response.completionItems ?? []) {
      const id = item.completion?.completionId;
      if (!id) continue;

      // text ← completion.text + suffix.text; deltaCursorOffset is dropped (§6.3).
      const text = (item.completion?.text ?? "") + (item.suffix?.text ?? "");

      const result: CompletionResult = { id, text };

      // Byte-offset range conversion is gated until verified on real traffic (§6.2).
      if (__CONFIG__.CODEIUM.ENABLE_RANGE_CONVERSION && item.range) {
        const startOffset = Number(item.range.startOffset ?? 0);
        const endOffset = Number(item.range.endOffset ?? 0);
        if (endOffset - startOffset > 0) {
          Logging.dev(
            `[codeium] Replace-type suggestion (deleteBytes=${endOffset - startOffset}); range conversion is unverified.`,
            "notice",
          );
        }
        const range = codeiumRangeToMonaco(cursorLine, startOffset, endOffset, lineNumber);
        if (range) result.range = range;
      }

      results.push(result);
    }

    return results;
  }

  // ─── Accept (§5.2) ──────────────────────────────────────────────────────────

  async acceptCompletion(completionId: string, apiKey: string): Promise<void> {
    this.metrics.accepted++;
    if (!manager.isReady()) return;
    try {
      await manager.rpc(
        METHOD.AcceptCompletion,
        { metadata: buildMetadata(apiKey), completion_id: completionId },
        5_000,
      );
    } catch (err) {
      Logging.dev(`[codeium] AcceptCompletion failed: ${(err as Error).message}`, "notice");
    }
  }

  // ─── Cancellation (§5.5) ────────────────────────────────────────────────────

  /** Cancels a session's last in-flight request (new request arrived or client aborted). */
  async cancelSession(sessionKey: string): Promise<void> {
    const previous = this.lastRequestBySession.get(sessionKey);
    if (previous === undefined) return;
    this.lastRequestBySession.delete(sessionKey);
    await this.cancelRequest(previous);
  }

  private async cancelRequest(requestId: number): Promise<void> {
    if (!manager.isReady()) return;
    this.metrics.cancels++;
    try {
      // §5.2: CancelRequest body is { request_id } — no metadata.
      await manager.rpc(METHOD.CancelRequest, { request_id: requestId }, 3_000);
    } catch {
      /* best-effort; the server drops it on its own timeout anyway */
    }
  }

  // ─── Metrics / health (§9) ──────────────────────────────────────────────────

  private recordLatency(ms: number): void {
    this.latencies.push(ms);
    if (this.latencies.length > 1_000) this.latencies.shift();
  }

  private percentile(p: number): number {
    if (this.latencies.length === 0) return 0;
    const sorted = [...this.latencies].sort((a, b) => a - b);
    const index = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
    return sorted[index];
  }

  health() {
    return {
      state: manager.getState(),
      restarts: manager.restarts,
      metrics: {
        ...this.metrics,
        latencyP50: this.percentile(50),
        latencyP95: this.percentile(95),
      },
    };
  }
}

export const codeiumService = new CodeiumService();
export {
  registerUser,
  storeSharedKey,
  storeKey,
  resolveApiKey,
  hasApiKey,
  authorizationUrl,
} from "./auth";
