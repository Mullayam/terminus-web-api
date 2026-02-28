import { Socket } from "socket.io";
import { Logging } from "@enjoys/express-utils/logger";
import { aiService } from "../ai";
import { SocketEventConstants } from "./events";

const E = SocketEventConstants;

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
 * AI Socket Namespace  –  /ai
 *
 * ─── Client → Server ──────────────────────────────────────────────────────
 *   @@AI_GENERATE  { question: string, language: string }
 *   @@AI_STREAM    { question: string, language: string }
 *
 * ─── Server → Client ──────────────────────────────────────────────────────
 *   @@AI_RESULT    AiResponse          (full generate response)
 *   @@AI_CHUNK     { text: string }    (streaming delta)
 *   @@AI_DONE      AiResponse          (end of stream + metadata)
 *   @@AI_ERROR     { message: string } (error)
 */
export class AiNamespace {
  constructor(private readonly socket: Socket) {
    Logging.dev(`[AI:ns] Client connected: ${socket.id}`);
    this.registerEvents();
  }

  private registerEvents() {
    const { socket } = this;

    // ── One-shot generate ────────────────────────────────────────────────
    socket.on(
      E.AI_GENERATE,
      async (data: { question: string; language: string }) => {
        if (!data?.question || !data?.language) {
          socket.emit(E.AI_ERROR, {
            message: "Both question and language are required.",
          });
          return;
        }
        try {
          const result = await aiService.generate({
            prompt: data.question,
            system: buildSystemPrompt(data.language),
          });
          socket.emit(E.AI_RESULT, result);
        } catch (err: any) {
          Logging.dev(`[AI:ns] generate error: ${err.message}`, "error");
          socket.emit(E.AI_ERROR, {
            message: err.message ?? "AI generation failed.",
          });
        }
      },
    );

    // ── Streaming generate ───────────────────────────────────────────────
    socket.on(
      E.AI_STREAM,
      async (data: { question: string; language: string }) => {
        if (!data?.question || !data?.language) {
          socket.emit(E.AI_ERROR, {
            message: "Both question and language are required.",
          });
          return;
        }
        try {
          const gen = aiService.stream({
            prompt: data.question,
            system: buildSystemPrompt(data.language),
          });

          let iterResult = await gen.next();
          while (!iterResult.done) {
            socket.emit(E.AI_CHUNK, { text: iterResult.value });
            iterResult = await gen.next();
          }
          socket.emit(E.AI_DONE, iterResult.value);
        } catch (err: any) {
          Logging.dev(`[AI:ns] stream error: ${err.message}`, "error");
          socket.emit(E.AI_ERROR, {
            message: err.message ?? "AI stream failed.",
          });
        }
      },
    );

    // ── Disconnect ───────────────────────────────────────────────────────
    socket.on("disconnect", (reason) => {
      Logging.dev(`[AI:ns] Client disconnected: ${socket.id} (${reason})`);
    });
  }
}
