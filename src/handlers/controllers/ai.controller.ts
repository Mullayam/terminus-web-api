import type { Request, Response } from "express";
import { aiService, type AiProvider, type AiMessage } from "../../services/ai";

/**
 * Builds the system prompt from the active language.
 * The AI will behave as a coding assistant specialised for that language.
 */
function buildSystemPrompt(language: string): string {
  return `You are an inline code completion engine for a ${language} code editor, similar to GitHub Copilot.
Your sole job is to predict and output the NEXT logical continuation of the code the user has written so far.

Strict rules:
- Output ONLY raw ${language} code — no markdown fences, no backticks, no explanations.
- Complete exactly from where the cursor is; do NOT repeat any code already written.
- If the user's code is a partial expression, statement, or function, complete it naturally.
- Keep completions concise (1–15 lines max) unless a longer block is clearly required.
- Prefer idiomatic, production-quality ${language} style.
- Never add comments unless the surrounding code already uses them.`;
}

/**
 * Payload shape sent by the editor frontend.
 */
interface CompletionPayload {
  filename?: string;
  language: string;
  textBeforeCursor: string;
  textAfterCursor: string;
  cursorPosition: { lineNumber: number; column: number };
}

/**
 * Payload shape sent by the chat panel.
 */
interface ChatPayload {
  question: string;
  language?: string;
  context?: string;
  filename?: string;
  providerId?: string;
  modelId?: string;
  history?: Array<{ role: string; content: string }>;
}

/**
 * Builds the user prompt from the editor context.
 */
function buildUserPrompt(body: CompletionPayload): string {
  const parts: string[] = [];

  if (body.filename) parts.push(`File: ${body.filename}`);
  parts.push(`Cursor is at line ${body.cursorPosition.lineNumber}, column ${body.cursorPosition.column}.`);

  if (body.textBeforeCursor) {
    parts.push(`Code before cursor:\n\`\`\`\n${body.textBeforeCursor}\n\`\`\``);
  }
  if (body.textAfterCursor) {
    parts.push(`Code after cursor:\n\`\`\`\n${body.textAfterCursor}\n\`\`\``);
  }

  parts.push("Continue from the cursor position.");

  return parts.join("\n\n");
}

/**
 * Validates the incoming body and returns an error message or null if valid.
 */
function validateBody(body: any): string | null {
  if (!body.language || typeof body.language !== "string") {
    return 'language is required (e.g. "typescript", "python").';
  }
  if (typeof body.textBeforeCursor !== "string") {
    return "textBeforeCursor is required.";
  }
  if (typeof body.textAfterCursor !== "string") {
    return "textAfterCursor is required.";
  }
  if (!body.cursorPosition || typeof body.cursorPosition.lineNumber !== "number" || typeof body.cursorPosition.column !== "number") {
    return "cursorPosition ({ lineNumber, column }) is required.";
  }
  return null;
}

class AiController {
  /**
   * POST /api/ai/generate
   * Body: CompletionPayload
   */
  async generate(req: Request, res: Response) {
    try {
      const body = req.body?.completionMetadata as CompletionPayload;
      
      const error = validateBody(body);
      if (error) {
        res.status(400).json({ success: false, message: error });
        return;
      }

      const result = await aiService.generate({
        prompt: buildUserPrompt(body),
        system: buildSystemPrompt(body.language),
      });

      res.setHeader("X-AI-Provider", result.provider);
      res.setHeader("X-AI-Model", result.model);
      if (result.fallbackChain?.length) {
        res.setHeader("X-AI-Fallback", JSON.stringify(result.fallbackChain));
      }
      res.status(200).json({ completion: result.text, error: "" });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        message: err instanceof Error ? err.message : "AI generation failed.",
      });
    }
  }

  /**
   * POST /api/ai/stream
   * Body: CompletionPayload
   * Returns Server-Sent Events.
   *
   * Events:
   *   event: chunk  data: { text }
   *   event: done   data: AiResponse
   *   event: error  data: { message }
   */
  async stream(req: Request, res: Response) {
    try {
      const body = req.body as CompletionPayload;
      const error = validateBody(body);
      if (error) {
        res.status(400).json({ success: false, message: error });
        return;
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      const gen = aiService.stream({
        prompt: buildUserPrompt(body),
        system: buildSystemPrompt(body.language),
      });

      let iterResult = await gen.next();
      while (!iterResult.done) {
        res.write(
          `event: chunk\ndata: ${JSON.stringify({ text: iterResult.value })}\n\n`,
        );
        iterResult = await gen.next();
      }

      // Final response — send provider metadata as an SSE event, body is text only
      const final = iterResult.value;
      res.write(`event: provider\ndata: ${JSON.stringify({ provider: final.provider, model: final.model, fallbackChain: final.fallbackChain })}\n\n`);
      res.write(`event: done\ndata: ${JSON.stringify({ text: final.text })}\n\n`);
      res.end();
    } catch (err: any) {
      const message =
        err instanceof Error ? err.message : "AI streaming failed.";
      try {
        res.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
        res.end();
      } catch {
        res.status(500).json({ success: false, message });
      }
    }
  }

  /**
   * GET /api/ai/providers
   */
  providers(_req: Request, res: Response) {
    try {
      res.status(200).json({
        success: true,
        data: aiService.getProviderDetails(),
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        message: err instanceof Error ? err.message : "Failed.",
      });
    }
  }

  /**
   * POST /api/chat
   * Body: ChatPayload
   *
   * Streams a chat response as Server-Sent Events.
   *
   * Events:
   *   event: chunk    data: { text }
   *   event: provider data: { provider, model, fallbackChain? }
   *   event: done     data: { text }
   *   event: error    data: { message }
   */
  async chat(req: Request, res: Response) {
    try {
      const body = req.body as ChatPayload;

      if (!body.question || typeof body.question !== "string") {
        res.status(400).json({ success: false, message: "question is required." });
        return;
      }

      const systemParts: string[] = [
        "You are an expert programming assistant embedded in a web-based terminal/code editor.",
        "You help users understand, debug, write, and improve code.",
        "Always answer concisely and accurately.",
      ];
      if (body.language) systemParts.push(`The user is working with ${body.language}.`);
      if (body.filename) systemParts.push(`Current file: ${body.filename}`);
      if (body.context) {
        systemParts.push("Here is the relevant code context the user is looking at:");
        systemParts.push("```\n" + body.context + "\n```");
      }

      const history: AiMessage[] = (body.history ?? []).map((m) => ({
        role: m.role as "user" | "assistant",
        content: m.content,
      }));

      // SSE headers
      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      const gen = aiService.stream({
        prompt: body.question,
        system: systemParts.join("\n"),
        history,
        provider: body.providerId as AiProvider | undefined,
        model: body.modelId,
      });

      let iterResult = await gen.next();
      while (!iterResult.done) {
        res.write(`event: chunk\ndata: ${JSON.stringify({ text: iterResult.value })}\n\n`);
        iterResult = await gen.next();
      }

      const final = iterResult.value;
      res.write(`event: provider\ndata: ${JSON.stringify({ provider: final.provider, model: final.model, fallbackChain: final.fallbackChain })}\n\n`);
      res.write(`event: done\ndata: ${JSON.stringify({ text: final.text })}\n\n`);
      res.end();
    } catch (err: any) {
      const message = err instanceof Error ? err.message : "Chat failed.";
      try {
        res.write(`event: error\ndata: ${JSON.stringify({ message })}\n\n`);
        res.end();
      } catch {
        res.status(500).json({ success: false, message });
      }
    }
  }
}

export default new AiController();
