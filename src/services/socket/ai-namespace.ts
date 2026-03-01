import { Socket } from "socket.io";
import { Logging } from "@enjoys/express-utils/logger";
import { aiService } from "../ai";
import { SocketEventConstants } from "./events";

const E = SocketEventConstants;

function buildSystemPrompt(language: string): string {
  return `You are a context-aware inline code completion engine for a ${language} code editor.
Your ONLY purpose is to predict what the developer intends to type next based on the ACTUAL content surrounding the cursor.
You are NOT a chatbot or general assistant — you are a precision autocomplete tool.

Language: ${language}

Context Analysis (you MUST follow this order):
1. textBeforeCursor (HIGHEST PRIORITY): Read the last few lines carefully. Determine if the developer is mid-token, mid-expression, mid-statement, at a statement boundary, or at a structural boundary. Your completion MUST be a direct, natural continuation of this text.
2. textAfterCursor: Understand what code already exists below. NEVER duplicate or conflict with it. If closing tokens already exist, do NOT add redundant ones.
3. cursorPosition: Use line/column to understand indentation depth and current scope.
4. filename: Use file extension and name to infer framework conventions and idioms.

Critical Rules:
- Output ONLY raw ${language} code — absolutely NO markdown fences, NO backticks, NO explanations, NO natural language.
- Start output exactly where the cursor is — do NOT repeat ANY code from before the cursor.
- Do NOT include code that already exists after the cursor.
- Every suggestion MUST be derived from the actual context provided. Never generate random, generic, or unrelated code.
- Identify the developer's intent: Are they completing an expression, continuing a pattern, filling a function body, adding properties, finishing an import?
- Check for conflicts before generating: no duplicate code, no redundant closing tokens, result must be syntactically valid when inserted.
- Keep completions concise (1–15 lines) unless a longer block is unambiguously required by context.
- Match the existing indentation style, naming conventions, and formatting exactly.
- Prefer idiomatic, production-quality ${language} style.
- Never add comments unless the surrounding code already uses them.
- If NO completion is needed (code is complete at cursor), return an EMPTY string.
- When in doubt, suggest LESS — a short correct completion beats a long speculative one.`;
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
