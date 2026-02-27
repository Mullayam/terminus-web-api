import type { Request, Response } from "express";
import { aiService } from "../../services/ai";

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

class AiController {
  /**
   * POST /api/ai/generate
   * Body: { question: string, language: string }
   */
  async generate(req: Request, res: Response) {
    try {
      const { question, language } = req.body;

      if (!question || typeof question !== "string") {
        res
          .status(400)
          .json({ success: false, message: "question is required." });
        return;
      }
      if (!language || typeof language !== "string") {
        res.status(400).json({
          success: false,
          message: 'language is required (e.g. "typescript", "python").',
        });
        return;
      }

      const result = await aiService.generate({
        prompt: question,
        system: buildSystemPrompt(language),
      });

      res.status(200).json({ success: true, data: result });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        message: err instanceof Error ? err.message : "AI generation failed.",
      });
    }
  }

  /**
   * POST /api/ai/stream
   * Body: { question: string, language: string }
   * Returns Server-Sent Events.
   *
   * Events:
   *   event: chunk  data: { text }
   *   event: done   data: AiResponse
   *   event: error  data: { message }
   */
  async stream(req: Request, res: Response) {
    try {
      const { question, language } = req.body;

      if (!question || typeof question !== "string") {
        res
          .status(400)
          .json({ success: false, message: "question is required." });
        return;
      }
      if (!language || typeof language !== "string") {
        res
          .status(400)
          .json({ success: false, message: "language is required." });
        return;
      }

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.flushHeaders();

      const gen = aiService.stream({
        prompt: question,
        system: buildSystemPrompt(language),
      });

      let iterResult = await gen.next();
      while (!iterResult.done) {
        res.write(
          `event: chunk\ndata: ${JSON.stringify({ text: iterResult.value })}\n\n`,
        );
        iterResult = await gen.next();
      }

      res.write(`event: done\ndata: ${JSON.stringify(iterResult.value)}\n\n`);
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
        data: { providers: aiService.availableProviders() },
      });
    } catch (err: any) {
      res.status(500).json({
        success: false,
        message: err instanceof Error ? err.message : "Failed.",
      });
    }
  }
}

export default new AiController();
