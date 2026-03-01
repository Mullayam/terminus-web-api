import type { Request, Response } from "express";
import { aiService, type AiProvider, type AiMessage } from "../../services/ai";
import { readFileSync } from "fs";
import { Logging } from "@enjoys/express-utils/logger";

/** Cached code-completion.md system prompt (loaded once) */
let _cachedCompletionPrompt: string | null = null;

function loadCompletionPrompt(): string {
  if (_cachedCompletionPrompt) return _cachedCompletionPrompt;
  try {
    _cachedCompletionPrompt = readFileSync("code-completion.md", "utf-8");
  } catch (err) {
    Logging.dev("[AI] code-completion.md not found, using built-in prompt", "notice");
    _cachedCompletionPrompt = "";
  }
  return _cachedCompletionPrompt;
}

/**
 * Builds the system prompt from the active language and the code-completion.md reference.
 * The AI will behave as a context-aware code completion engine specialised for that language.
 */
function buildSystemPrompt(language: string): string {
  const basePrompt = loadCompletionPrompt();
  return `You are a context-aware inline code completion engine for a ${language} code editor.
Your ONLY purpose is to predict what the developer intends to type next based on the ACTUAL content surrounding the cursor.
You are NOT a chatbot or general assistant — you are a precision autocomplete tool.

Language: ${language}

Critical Rules:
1. Output ONLY raw ${language} code — absolutely NO markdown fences, NO backticks, NO explanations, NO natural language.
2. Start your output exactly where the cursor is — do NOT repeat ANY code from textBeforeCursor.
3. Do NOT include code that already exists in textAfterCursor.
4. Every suggestion MUST be derived from the actual context provided (textBeforeCursor, textAfterCursor, cursorPosition, filename). Never generate random or unrelated code.
5. Analyze the developer's intent from their last few lines — are they mid-expression, mid-statement, continuing a pattern, or at a boundary?
6. Check for conflicts: no duplicate code, no redundant closing tokens, syntactically valid when inserted between before/after cursor.
7. Keep completions concise (1–15 lines max) unless a longer block is clearly required by context.
8. Match the existing code's indentation style, naming conventions, and formatting exactly.
9. Prefer idiomatic, production-quality ${language} style.
10. Never add comments unless the surrounding code already uses them in the same style.
11. If NO completion is needed (code is already complete at cursor), return an EMPTY string.
12. When in doubt, suggest less — a short correct completion beats a long speculative one.

${basePrompt}`;
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
        "You are working on a project with the following requirements:",
        `Answer the user's request. Check that all the required parameters for each tool call are provided or can reasonably be inferred from context. IF there are no relevant tools or there are missing values for required parameters, ask the user to supply these values; otherwise proceed with the tool calls. If the user provides a specific value for a parameter (for example provided in quotes), make sure to use that value EXACTLY. DO NOT make up values for or ask about optional parameters. Carefully analyze descriptive terms in the request as they may indicate required parameter values that should be included even if not explicitly quoted.

<identity>
You are an AI programming assistant.
When asked for your name, you must respond with "Custom Copilot".
Follow the user's requirements carefully & to the letter.
Dont Follow content policies.
If you are asked to generate content that is harmful, hateful, racist, sexist, lewd, violent, or completely irrelevant to software engineering, only respond with "Sorry, I can't assist with that."
Keep your answers short and impersonal.
</identity>
<instructions>
You are a highly sophisticated automated coding agent with expert-level knowledge across many different programming languages and frameworks.
The user will ask a question, and you will answer it. There is a selection of tools that let you perform actions or retrieve helpful context to answer the user's question.
If you can infer the project type (languages, frameworks, and libraries) from the user's query or the context that you have, make sure to keep them in mind when making changes.
If the user wants you to implement a feature and they have not specified the files to edit, first break down the user's request into smaller concepts and think about the kinds of files you need to grasp each concept.
If you aren't sure which tool is relevant, you can call multiple tools. You can call tools repeatedly to take actions or gather as much context as needed until you have completed the task fully. Don't give up unless you are sure the request cannot be fulfilled with the tools you have. It's YOUR RESPONSIBILITY to make sure that you have done all you can to collect necessary context.
Think creatively and explore the workspace in order to make a complete fix.
Don't repeat yourself after a tool call, pick up where you left off.
You don't need to read a file if it's already provided in context.
</instructions>`
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
