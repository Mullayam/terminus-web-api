import { GoogleGenerativeAI, GenerativeModel } from "@google/generative-ai";
import { Mistral } from "@mistralai/mistralai";
import Groq from "groq-sdk";
import { Logging } from "@enjoys/express-utils/logger";

export type AiProvider = "gemini" | "mistral" | "groq";

export interface AiMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface AiRequestOptions {
  /** The user prompt */
  prompt: string;
  /** System instruction / context injected before all messages */
  system?: string;
  /** Conversation history for multi-turn chats */
  history?: AiMessage[];
  /** Max tokens to generate (default 2048) */
  maxTokens?: number;
  /** Temperature 0-1 (default 0.7) */
  temperature?: number;
  /**
   * Force a specific provider. When not set the service tries all
   * providers in sequence (Gemini → Mistral → Groq) and automatically
   * switches to the next one on any error.
   */
  provider?: AiProvider;
}

export interface AiResponse {
  text: string;
  /** Which provider ultimately produced the response */
  provider: AiProvider;
  model: string;
  /** Whether a fallback occurred and which providers were skipped */
  fallbackChain?: Array<{ provider: AiProvider; error: string }>;
  usage?: {
    promptTokens?: number;
    completionTokens?: number;
    totalTokens?: number;
  };
}

// ─── Singleton AI Service ─────────────────────────────────────────────────────

/**
 * Unified AI service wrapping Google Gemini, Mistral AI, and Groq.
 *
 * **Automatic context-switching fallback** (default behaviour):
 *   When `options.provider` is NOT set, the service tries providers in order:
 *     1. Gemini  → `gemini-2.0-flash`
 *     2. Mistral → `mistral-large-latest`
 *     3. Groq    → `llama3-70b-8192`
 *   On ANY error from a provider it immediately switches to the next one,
 *   carrying the full conversation context with it. The `fallbackChain`
 *   field in the response documents which switches happened and why.
 *
 * Environment variables required in `.env`:
 *   GEMINI_API_KEY, MISTRAL_API_KEY, GROQ_API_KEY
 */
export class AiService {
  private static _instance: AiService;

  private gemini: GoogleGenerativeAI | null = null;
  private mistral: Mistral | null = null;
  private groq: Groq | null = null;

  private readonly GEMINI_MODEL = "gemini-2.0-flash";
  private readonly MISTRAL_MODEL = "mistral-large-latest";
  private readonly GROQ_MODEL = "llama3-70b-8192";

  /** Default provider order */
  private readonly SEQUENCE: AiProvider[] = ["groq", "mistral", "gemini"];

  private constructor() {
    this._initClients();
  }

  static getInstance(): AiService {
    if (!AiService._instance) AiService._instance = new AiService();
    return AiService._instance;
  }

  // ── Init ─────────────────────────────────────────────────────────────────

  private _initClients() {
    const gk = process.env.GEMINI_API_KEY;
    const mk = process.env.MISTRAL_API_KEY;
    const qk = process.env.GROQ_API_KEY;

    if (gk) {
      this.gemini = new GoogleGenerativeAI(gk);
      Logging.dev("[AI] Gemini  ✓");
    } else Logging.dev("[AI] Gemini  ✗  (GEMINI_API_KEY missing)", "notice");

    if (mk) {
      this.mistral = new Mistral({ apiKey: mk });
      Logging.dev("[AI] Mistral ✓");
    } else Logging.dev("[AI] Mistral ✗  (MISTRAL_API_KEY missing)", "notice");

    if (qk) {
      this.groq = new Groq({ apiKey: qk });
      Logging.dev("[AI] Groq    ✓");
    } else Logging.dev("[AI] Groq    ✗  (GROQ_API_KEY missing)", "notice");
  }

  // ── Public API ────────────────────────────────────────────────────────────

  /**
   * Generate a complete AI response.
   *
   * If `options.provider` is set → only that provider is used.
   * Otherwise → tries providers in sequence, falling back automatically on
   * any error while preserving the full conversation context.
   */
  async generate(options: AiRequestOptions): Promise<AiResponse> {
    if (options.provider) {
      if (!this._isAvailable(options.provider)) {
        throw new Error(`Provider "${options.provider}" is not configured.`);
      }
      return this._callProvider(options.provider, options);
    }
    return this._generateWithFallback(options);
  }

  /**
   * Stream a response as an async generator that yields text chunks.
   *
   * The generator **returns** the final `AiResponse` value (accessible via
   * `await gen.return()` or the loop's done value). Automatic fallback to
   * the next provider occurs if the active provider errors during streaming.
   */
  async *stream(
    options: AiRequestOptions,
  ): AsyncGenerator<string, AiResponse, unknown> {
    const providers = options.provider
      ? [options.provider]
      : this.SEQUENCE.filter((p) => this._isAvailable(p));

    if (providers.length === 0)
      throw new Error("No AI providers are configured.");

    const fallbackChain: AiResponse["fallbackChain"] = [];

    for (const provider of providers) {
      try {
        if (provider === "gemini")
          return yield* this._streamGemini(options, fallbackChain);
        if (provider === "groq")
          return yield* this._streamGroq(options, fallbackChain);
        // Mistral: no streaming SDK method – emit full response as single chunk
        const result = await this._callMistral(options);
        result.fallbackChain = fallbackChain.length ? fallbackChain : undefined;
        yield result.text;
        return result;
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        Logging.dev(
          `[AI:stream] ${provider} failed (${msg}), switching context…`,
          "notice",
        );
        fallbackChain.push({ provider, error: msg });
      }
    }
    throw new Error(
      `All AI providers failed during streaming. Chain: ${JSON.stringify(fallbackChain)}`,
    );
  }

  /** Returns which providers are currently configured */
  availableProviders(): AiProvider[] {
    return this.SEQUENCE.filter((p) => this._isAvailable(p));
  }

  // ── Internal: sequential fallback with context ────────────────────────────

  private async _generateWithFallback(
    options: AiRequestOptions,
  ): Promise<AiResponse> {
    const candidates = this.SEQUENCE.filter((p) => this._isAvailable(p));
    if (candidates.length === 0)
      throw new Error("No AI providers are configured.");

    const fallbackChain: AiResponse["fallbackChain"] = [];

    for (const provider of candidates) {
      try {
        Logging.dev(`[AI] Trying provider: ${provider}`);
        const result = await this._callProvider(provider, options);
        // Attach fallback info if we had to switch
        if (fallbackChain.length) result.fallbackChain = fallbackChain;
        return result;
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        Logging.dev(
          `[AI] ${provider} failed (${msg}), switching context to next provider…`,
          "notice",
        );
        fallbackChain.push({ provider, error: msg });
      }
    }

    throw new Error(
      `All AI providers failed.\n` +
        fallbackChain.map((f) => `  • ${f.provider}: ${f.error}`).join("\n"),
    );
  }

  // ── Dispatch ──────────────────────────────────────────────────────────────

  private _callProvider(
    provider: AiProvider,
    opts: AiRequestOptions,
  ): Promise<AiResponse> {
    switch (provider) {
      case "gemini":
        return this._callGemini(opts);
      case "mistral":
        return this._callMistral(opts);
      case "groq":
        return this._callGroq(opts);
      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
  }

  private _isAvailable(p: AiProvider): boolean {
    return p === "gemini"
      ? !!this.gemini
      : p === "mistral"
        ? !!this.mistral
        : !!this.groq;
  }

  private _modelFor(p: AiProvider): string {
    return p === "gemini"
      ? this.GEMINI_MODEL
      : p === "mistral"
        ? this.MISTRAL_MODEL
        : this.GROQ_MODEL;
  }

  // ── Gemini ────────────────────────────────────────────────────────────────

  private async _callGemini(opts: AiRequestOptions): Promise<AiResponse> {
    if (!this.gemini) throw new Error("Gemini client not initialised.");
    const {
      prompt,
      system,
      history = [],
      maxTokens = 2048,
      temperature = 0.7,
    } = opts;

    const model: GenerativeModel = this.gemini.getGenerativeModel({
      model: this.GEMINI_MODEL,
      systemInstruction: system,
      generationConfig: { maxOutputTokens: maxTokens, temperature },
    });

    const chatHistory = history.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const chat = model.startChat({ history: chatHistory });
    const result = await chat.sendMessage(prompt);
    const resp = result.response;

    return {
      text: resp.text(),
      provider: "gemini",
      model: this.GEMINI_MODEL,
      usage: {
        promptTokens: resp.usageMetadata?.promptTokenCount,
        completionTokens: resp.usageMetadata?.candidatesTokenCount,
        totalTokens: resp.usageMetadata?.totalTokenCount,
      },
    };
  }

  private async *_streamGemini(
    opts: AiRequestOptions,
    fallbackChain: AiResponse["fallbackChain"] = [],
  ): AsyncGenerator<string, AiResponse, unknown> {
    if (!this.gemini) throw new Error("Gemini client not initialised.");
    const {
      prompt,
      system,
      history = [],
      maxTokens = 2048,
      temperature = 0.7,
    } = opts;

    const model = this.gemini.getGenerativeModel({
      model: this.GEMINI_MODEL,
      systemInstruction: system,
      generationConfig: { maxOutputTokens: maxTokens, temperature },
    });

    const chatHistory = history.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

    const chat = model.startChat({ history: chatHistory });
    const stream = await chat.sendMessageStream(prompt);

    let fullText = "";
    for await (const chunk of stream.stream) {
      const delta = chunk.text();
      fullText += delta;
      yield delta;
    }

    const finalResp = await stream.response;
    return {
      text: fullText,
      provider: "gemini",
      model: this.GEMINI_MODEL,
      fallbackChain: fallbackChain.length ? fallbackChain : undefined,
      usage: { totalTokens: finalResp.usageMetadata?.totalTokenCount },
    };
  }

  // ── Mistral ───────────────────────────────────────────────────────────────

  private async _callMistral(opts: AiRequestOptions): Promise<AiResponse> {
    if (!this.mistral) throw new Error("Mistral client not initialised.");
    const {
      prompt,
      system,
      history = [],
      maxTokens = 2048,
      temperature = 0.7,
    } = opts;

    type Msg = { role: "system" | "user" | "assistant"; content: string };
    const messages: Msg[] = [];
    if (system) messages.push({ role: "system", content: system });
    for (const m of history)
      messages.push({
        role: m.role as "user" | "assistant",
        content: m.content,
      });
    messages.push({ role: "user", content: prompt });

    const response = await this.mistral.chat.complete({
      model: this.MISTRAL_MODEL,
      messages,
      maxTokens,
      temperature,
    });

    const choice = response.choices?.[0];
    const raw = choice?.message?.content ?? "";
    const text =
      typeof raw === "string"
        ? raw
        : (raw as any[]).map((c: any) => c.text ?? "").join("");

    return {
      text,
      provider: "mistral",
      model: this.MISTRAL_MODEL,
      usage: {
        promptTokens: response.usage?.promptTokens,
        completionTokens: response.usage?.completionTokens,
        totalTokens: response.usage?.totalTokens,
      },
    };
  }

  // ── Groq ──────────────────────────────────────────────────────────────────

  private async _callGroq(opts: AiRequestOptions): Promise<AiResponse> {
    if (!this.groq) throw new Error("Groq client not initialised.");
    const {
      prompt,
      system,
      history = [],
      maxTokens = 2048,
      temperature = 0.7,
    } = opts;

    type Msg = { role: "system" | "user" | "assistant"; content: string };
    const messages: Msg[] = [];
    if (system) messages.push({ role: "system", content: system });
    for (const m of history)
      messages.push({
        role: m.role as "user" | "assistant",
        content: m.content,
      });
    messages.push({ role: "user", content: prompt });

    const completion = await this.groq.chat.completions.create({
      model: this.GROQ_MODEL,
      messages,
      max_tokens: maxTokens,
      temperature,
    });

    const choice = completion.choices[0];
    return {
      text: choice.message.content ?? "",
      provider: "groq",
      model: this.GROQ_MODEL,
      usage: {
        promptTokens: completion.usage?.prompt_tokens,
        completionTokens: completion.usage?.completion_tokens,
        totalTokens: completion.usage?.total_tokens,
      },
    };
  }

  private async *_streamGroq(
    opts: AiRequestOptions,
    fallbackChain: AiResponse["fallbackChain"] = [],
  ): AsyncGenerator<string, AiResponse, unknown> {
    if (!this.groq) throw new Error("Groq client not initialised.");
    const {
      prompt,
      system,
      history = [],
      maxTokens = 2048,
      temperature = 0.7,
    } = opts;

    type Msg = { role: "system" | "user" | "assistant"; content: string };
    const messages: Msg[] = [];
    if (system) messages.push({ role: "system", content: system });
    for (const m of history)
      messages.push({
        role: m.role as "user" | "assistant",
        content: m.content,
      });
    messages.push({ role: "user", content: prompt });

    const streamResp = await this.groq.chat.completions.create({
      model: this.GROQ_MODEL,
      messages,
      max_tokens: maxTokens,
      temperature,
      stream: true,
    });

    let fullText = "";
    for await (const chunk of streamResp) {
      const delta = chunk.choices[0]?.delta?.content ?? "";
      fullText += delta;
      if (delta) yield delta;
    }

    return {
      text: fullText,
      provider: "groq",
      model: this.GROQ_MODEL,
      fallbackChain: fallbackChain.length ? fallbackChain : undefined,
    };
  }
}

/** Convenience singleton */
export const aiService = AiService.getInstance();
