import type { Request, Response } from "express";
import { Logging } from "@enjoys/express-utils/logger";
import { __CONFIG__ } from "../../utils/constant";
import {
  codeiumService,
  registerUser,
  storeKey,
  storeSharedKey,
  resolveApiKey,
  hasApiKey,
  authorizationUrl,
} from "../../services/codeium";
import type {
  AcceptRequestBody,
  AuthRequestBody,
  CompleteRequestBody,
  CompletionResult,
} from "../../services/codeium/types";

/**
 * Decodes the optional `?user=base64(hostId)` query param (same convention as
 * /api/chat). Identifies the caller for per-user keys and session cancellation.
 */
function resolveUser(req: Request): string {
  const raw = req.query.user;
  if (typeof raw === "string" && raw) {
    try {
      const decoded = Buffer.from(raw, "base64").toString("utf8");
      if (decoded) return decoded;
    } catch {
      /* fall through to the raw value */
    }
    return raw;
  }
  return "";
}

/** A stable key per browser session, used to supersede in-flight requests (§5.5). */
function sessionKey(req: Request, user: string): string {
  return `${user}::${req.ip ?? "unknown"}`;
}

/** Opt-in SSE: streaming is used only when the client explicitly asks for it. */
function wantsSSE(req: Request): boolean {
  const accept = req.headers.accept ?? "";
  return (
    accept.includes("text/event-stream") ||
    req.query.stream === "true" ||
    req.query.stream === "1"
  );
}

/**
 * Streams completions as SSE: one `completion` event per item, then `done`.
 *   event: completion  data: { id, text, range? }
 *   event: done        data: { count }
 * Module-scoped because Express calls handlers detached from the instance.
 */
function emitCompletions(res: Response, completions: CompletionResult[]) {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  // Disable proxy buffering so events are not held back (§9).
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  for (const completion of completions) {
    res.write(`event: completion\ndata: ${JSON.stringify(completion)}\n\n`);
  }
  res.write(`event: done\ndata: ${JSON.stringify({ count: completions.length })}\n\n`);
  res.end();
}

function isValidDocument(document: any): boolean {
  return (
    document &&
    typeof document.text === "string" &&
    typeof document.filePath === "string" &&
    document.cursorPosition &&
    typeof document.cursorPosition.lineNumber === "number" &&
    typeof document.cursorPosition.column === "number"
  );
}

class CodeiumController {
  /**
   * POST /api/codeium/complete
   * Ghost-text completions. Content-negotiated: streams Server-Sent Events when
   * the client sends `Accept: text/event-stream` (or `?stream=1`), otherwise
   * returns plain JSON `{ completions: [] }` (§2.1, §8).
   */
  async complete(req: Request, res: Response) {
    const user = resolveUser(req);
    const gateKey = user || (req.ip ?? "unknown");
    const stream = wantsSSE(req);
    let slotHeld = false;

    try {
      const body = req.body as CompleteRequestBody;

      if (!isValidDocument(body?.document)) {
        res.status(400).json({ completions: [], error: "document is required." });
        return;
      }

      // Disabled or degraded companion looks like "no suggestion", not an error,
      // so the default-off state produces no console errors (§2.1, §9, §12).
      if (!codeiumService.isReady()) {
        if (stream) emitCompletions(res, []);
        else res.status(200).json({ completions: [] });
        return;
      }

      // 1. Resolve user → api_key. 403 if none (§8 step 1).
      const apiKey = await resolveApiKey(user);
      if (!apiKey) {
        res.status(403).json({ completions: [], error: "No Codeium API key configured." });
        return;
      }

      // 2. Concurrency gate. 429 if exceeded (§8 step 2).
      if (!codeiumService.acquireSlot(gateKey)) {
        res.status(429).json({ completions: [], error: "Too many concurrent completions." });
        return;
      }
      slotHeld = true;

      // 3. Reject oversized payloads. 413 if over cap (§8 step 3).
      if (body.document.text.length > __CONFIG__.CODEIUM.MAX_DOCUMENT_CHARS) {
        res.status(413).json({ completions: [], error: "Document too large." });
        return;
      }

      const key = sessionKey(req, user);

      // Client aborts on every keystroke; forward the cancel so work and quota
      // are not wasted server-side (§5.5).
      let finished = false;
      res.on("finish", () => (finished = true));
      req.on("close", () => {
        if (!finished) void codeiumService.cancelSession(key);
      });

      const completions = await codeiumService.getCompletions({
        apiKey,
        sessionKey: key,
        document: body.document,
        otherDocuments: body.otherDocuments,
        editorOptions: body.editorOptions,
      });

      // Codeium returns the whole set at once, so each item is emitted as one
      // SSE event; there is no token-by-token stream to forward.
      if (stream) emitCompletions(res, completions);
      else res.status(200).json({ completions });
    } catch (err) {
      Logging.dev(`[codeium] complete failed: ${(err as Error).message}`, "error");
      // Once SSE is open, an error can only be in-band; before that, degrade to empty.
      if (stream && res.headersSent) {
        res.write(`event: error\ndata: ${JSON.stringify({ message: (err as Error).message })}\n\n`);
        res.end();
      } else if (!res.headersSent) {
        res.status(200).json({ completions: [] });
      }
    } finally {
      if (slotHeld) codeiumService.releaseSlot(gateKey);
    }
  }

  /**
   * POST /api/codeium/accept
   * Fire-and-forget from the browser. Always 204 so the client never logs a
   * failure; the forward to AcceptCompletion is best-effort (§2.2).
   */
  async accept(req: Request, res: Response) {
    try {
      const user = resolveUser(req);
      const body = req.body as AcceptRequestBody;
      const apiKey = await resolveApiKey(user);

      if (body?.completionId && apiKey) {
        void codeiumService.acceptCompletion(body.completionId, apiKey);
      }
    } catch (err) {
      Logging.dev(`[codeium] accept failed: ${(err as Error).message}`, "notice");
    }
    res.status(204).end();
  }

  /**
   * GET /api/codeium/auth/url
   * Returns the page the user opens to obtain a token for /api/codeium/auth (§4.1).
   */
  authUrl(_req: Request, res: Response) {
    res.status(200).json({ url: authorizationUrl() });
  }

  /**
   * GET /api/codeium/auth/status
   * Lets the UI decide whether to prompt for auth without ever seeing the key.
   */
  async authStatus(req: Request, res: Response) {
    const user = resolveUser(req);
    const authenticated = await hasApiKey(user);
    res.status(200).json({
      enabled: __CONFIG__.CODEIUM.ENABLED,
      perUser: __CONFIG__.CODEIUM.PER_USER_KEYS,
      authenticated,
      // Completions cannot run until a key is resolvable for this caller.
      required: !authenticated,
    });
  }

  /**
   * POST /api/codeium/auth
   * Exchanges the token from Codeium's profile page for an api_key and stores it
   * encrypted server-side. The key never reaches the browser (§4, §10).
   */
  async auth(req: Request, res: Response) {
    try {
      const body = req.body as AuthRequestBody;
      if (!body?.token || typeof body.token !== "string") {
        res.status(400).json({ success: false, message: "token is required." });
        return;
      }

      const apiKey = await registerUser(body.token);

      if (__CONFIG__.CODEIUM.PER_USER_KEYS) {
        const user = resolveUser(req) || body.user;
        if (!user) {
          res.status(400).json({ success: false, message: "user is required for per-user keys." });
          return;
        }
        await storeKey(user, apiKey);
      } else {
        await storeSharedKey(apiKey);
      }

      // Never echo the key back to the browser.
      res.status(200).json({ success: true });
    } catch (err) {
      res.status(502).json({
        success: false,
        message: err instanceof Error ? err.message : "Codeium registration failed.",
      });
    }
  }
}

export default new CodeiumController();
