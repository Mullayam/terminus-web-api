import { GoogleGenerativeAI, GenerativeModel } from "@google/generative-ai";
import { Mistral } from "@mistralai/mistralai";
import Groq from "groq-sdk";
import { OpenRouter } from "@openrouter/sdk";
import { Logging } from "@enjoys/express-utils/logger";

export type AiProvider = "gemini" | "mistral" | "groq" | "openrouter";

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
  /**
   * Override the default model for the chosen provider.
   * When not set, the service uses its built-in default per provider.
   */
  model?: string;
  /**
   * Response format hint:
   *  - `"text"` (default) — free-form text
   *  - `"json_object"` — model must return valid JSON
   *  - `"json_schema"` — model must conform to `responseSchema`
   */
  responseFormat?: "text" | "json_object" | "json_schema";
  /**
   * JSON-Schema definition for structured output.
   * Used when `responseFormat` is `"json_schema"`.
   */
  responseSchema?: {
    name: string;
    description?: string;
    schema: Record<string, any>;
    strict?: boolean;
  };
}

export interface ChatModel {
  id: string;
  name: string;
  /** Max context tokens */
  maxTokens?: number;
}

export interface ChatProvider {
  /** Unique provider ID (e.g. "groq", "mistral", "gemini") */
  id: string;
  /** Human-readable name */
  name: string;
  /** Optional icon URL or icon key */
  icon?: string;
  /** Available models for this provider */
  models: ChatModel[];
  /** Whether this provider is currently available / healthy */
  available: boolean;
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
 * Unified AI service wrapping Google Gemini, Mistral AI, Groq, and OpenRouter.
 *
 * **Automatic context-switching fallback** (default behaviour):
 *   When `options.provider` is NOT set, the service tries providers in order:
 *     1. Mistral    → `mistral-large-latest`
 *     2. OpenRouter → `openai/gpt-4o`
 *     3. Groq       → `llama-3.3-70b-versatile`
 *     4. Gemini     → `gemini-2.0-flash`
 *   On ANY error from a provider it immediately switches to the next one,
 *   carrying the full conversation context with it. The `fallbackChain`
 *   field in the response documents which switches happened and why.
 *
 * Environment variables required in `.env`:
 *   GEMINI_API_KEY, MISTRAL_API_KEY, GROQ_API_KEY, OPEN_ROUTER_KEY
 */
export class AiService {
  private static _instance: AiService;

  private gemini: GoogleGenerativeAI | null = null;
  private mistral: Mistral | null = null;
  private groq: Groq | null = null;
  private openrouter: OpenRouter | null = null;

  private readonly GEMINI_MODEL = "gemini-2.5-flash";
  private readonly MISTRAL_MODEL = "mistral-small-latest";
  private readonly GROQ_MODEL = "llama-3.3-70b-versatile";
  private readonly OPENROUTER_MODEL = "qwen/qwen3-coder:free";

  /** Default provider order */
  private readonly SEQUENCE: AiProvider[] = ["mistral", "openrouter", "groq", "gemini"];

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
    const ork = process.env.OPEN_ROUTER_KEY;

    if (gk) {
      this.gemini = new GoogleGenerativeAI(gk);
      Logging.dev("[AI] Gemini      ✓");
    } else Logging.dev("[AI] Gemini      ✗  (GEMINI_API_KEY missing)", "notice");

    if (mk) {
      this.mistral = new Mistral({ apiKey: mk });
      Logging.dev("[AI] Mistral     ✓");
    } else Logging.dev("[AI] Mistral     ✗  (MISTRAL_API_KEY missing)", "notice");

    if (qk) {
      this.groq = new Groq({ apiKey: qk });
      Logging.dev("[AI] Groq        ✓");
    } else Logging.dev("[AI] Groq        ✗  (GROQ_API_KEY missing)", "notice");

    if (ork) {
      this.openrouter = new OpenRouter({
        apiKey: ork,
      });
      Logging.dev("[AI] OpenRouter  ✓");
    } else Logging.dev("[AI] OpenRouter  ✗  (OPEN_ROUTER_KEY missing)", "notice");
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
        Logging.dev(`[AI:stream] Trying provider: ${provider}`);

        let innerGen: AsyncGenerator<string, AiResponse, unknown>;

        if (provider === "gemini") {
          innerGen = this._streamGemini(options, fallbackChain);
        } else if (provider === "groq") {
          innerGen = this._streamGroq(options, fallbackChain);
        } else if (provider === "openrouter") {
          innerGen = this._streamOpenRouter(options, fallbackChain);
        } else {
          innerGen = this._streamMistral(options, fallbackChain);
        }

        // Manually iterate so errors are reliably caught in this try/catch
        let result: IteratorResult<string, AiResponse>;
        while (true) {
          result = await innerGen.next();
          if (result.done) {
            const finalResponse = result.value as AiResponse;
            finalResponse.fallbackChain = fallbackChain.length
              ? fallbackChain
              : undefined;
            return finalResponse;
          }
          yield result.value;
        }
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        Logging.dev(
          `[AI:stream] ${provider} failed (${msg}), switching to next provider…`,
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

  /** Returns detailed provider info including models and availability */
  getProviderDetails(): ChatProvider[] {
    return [
      {
        id: "mistral",
        name: "Mistral AI",
        icon: "mistral",
        available: !!this.mistral,
        models: [
          { id: this.MISTRAL_MODEL, name: "Mistral Large", maxTokens: 32768 },
        ],
      },
      {
        id: "openrouter",
        name: "OpenRouter",
        icon: "openrouter",
        available: !!this.openrouter,
        models: [
          { id: "openai/gpt-4o", name: "GPT-4o", maxTokens: 128000 },
          { id: "openai/gpt-4o-mini", name: "GPT-4o Mini", maxTokens: 128000 },
          { id: "anthropic/claude-sonnet-4", name: "Claude Sonnet 4", maxTokens: 200000 },
          { id: "anthropic/claude-3.5-sonnet", name: "Claude 3.5 Sonnet", maxTokens: 200000 },
          { id: "google/gemini-2.0-flash-001", name: "Gemini 2.0 Flash", maxTokens: 1048576 },
          { id: "meta-llama/llama-3.3-70b-instruct", name: "Llama 3.3 70B", maxTokens: 131072 },
          { id: "deepseek/deepseek-chat-v3-0324", name: "DeepSeek V3", maxTokens: 131072 },
          { id: "qwen/qwen-2.5-coder-32b-instruct", name: "Qwen 2.5 Coder 32B", maxTokens: 32768 },
        ],
      },
      {
        id: "groq",
        name: "Groq",
        icon: "groq",
        available: !!this.groq,
        models: [
          { id: this.GROQ_MODEL, name: "Llama 3.3 70B", maxTokens: 32768 },
        ],
      },
      {
        id: "gemini",
        name: "Google Gemini",
        icon: "gemini",
        available: !!this.gemini,
        models: [
          { id: this.GEMINI_MODEL, name: "Gemini 2.0 Flash", maxTokens: 8192 },
        ],
      },
    ];
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
      case "openrouter":
        return this._callOpenRouter(opts);
      default:
        throw new Error(`Unknown provider: ${provider}`);
    }
  }

  private _isAvailable(p: AiProvider): boolean {
    switch (p) {
      case "gemini":     return !!this.gemini;
      case "mistral":    return !!this.mistral;
      case "groq":       return !!this.groq;
      case "openrouter": return !!this.openrouter;
      default:           return false;
    }
  }

  private _modelFor(p: AiProvider): string {
    switch (p) {
      case "gemini":     return this.GEMINI_MODEL;
      case "mistral":    return this.MISTRAL_MODEL;
      case "groq":       return this.GROQ_MODEL;
      case "openrouter": return this.OPENROUTER_MODEL;
      default:           return this.OPENROUTER_MODEL;
    }
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

    const modelId = opts.model ?? this.GEMINI_MODEL;
    const genConfig: Record<string, any> = { maxOutputTokens: maxTokens, temperature };
    if (opts.responseFormat === "json_object" || opts.responseFormat === "json_schema") {
      genConfig.responseMimeType = "application/json";
      if (opts.responseSchema) genConfig.responseSchema = opts.responseSchema.schema;
    }
    const model: GenerativeModel = this.gemini.getGenerativeModel({
      model: modelId,
      systemInstruction: system,
      generationConfig: genConfig,
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
      model: modelId,
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

    const modelId = opts.model ?? this.GEMINI_MODEL;
    const genConfig: Record<string, any> = { maxOutputTokens: maxTokens, temperature };
    if (opts.responseFormat === "json_object" || opts.responseFormat === "json_schema") {
      genConfig.responseMimeType = "application/json";
      if (opts.responseSchema) genConfig.responseSchema = opts.responseSchema.schema;
    }
    const model = this.gemini.getGenerativeModel({
      model: modelId,
      systemInstruction: system,
      generationConfig: genConfig,
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
      model: modelId,
      fallbackChain: fallbackChain.length ? fallbackChain : undefined,
      usage: { totalTokens: finalResp.usageMetadata?.totalTokenCount },
    };
  }

  // ── Mistral ───────────────────────────────────────────────────────────────

  private async *_streamMistral(
    opts: AiRequestOptions,
    fallbackChain: AiResponse["fallbackChain"] = [],
  ): AsyncGenerator<string, AiResponse, unknown> {
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

    const modelId = opts.model ?? this.MISTRAL_MODEL;
    const streamParams: Record<string, any> = {
      model: modelId,
      messages,
      maxTokens,
      temperature,
    };
    if (opts.responseFormat && opts.responseFormat !== "text") {
      streamParams.responseFormat = opts.responseFormat === "json_schema" && opts.responseSchema
        ? { type: "json_schema", jsonSchema: { name: opts.responseSchema.name, description: opts.responseSchema.description, schemaDefinition: opts.responseSchema.schema, strict: opts.responseSchema.strict } }
        : { type: "json_object" };
    }
    const stream = await this.mistral.chat.stream(streamParams as any);

    let fullText = "";
    for await (const event of stream) {
      const raw = event.data?.choices?.[0]?.delta?.content ?? "";
      const delta = typeof raw === "string" ? raw : (raw as any[]).map((c: any) => c.text ?? "").join("");
      if (delta) {
        fullText += delta;
        yield delta;
      }
    }

    return {
      text: fullText,
      provider: "mistral",
      model: modelId,
      fallbackChain: fallbackChain.length ? fallbackChain : undefined,
    };
  }

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

    const modelId = opts.model ?? this.MISTRAL_MODEL;
    const completeParams: Record<string, any> = {
      model: modelId,
      messages,
      maxTokens,
      temperature,
    };
    if (opts.responseFormat && opts.responseFormat !== "text") {
      completeParams.responseFormat = opts.responseFormat === "json_schema" && opts.responseSchema
        ? { type: "json_schema", jsonSchema: { name: opts.responseSchema.name, description: opts.responseSchema.description, schemaDefinition: opts.responseSchema.schema, strict: opts.responseSchema.strict } }
        : { type: "json_object" };
    }
    const response = await this.mistral.chat.complete(completeParams as any);

    const choice = response.choices?.[0];
    const raw = choice?.message?.content ?? "";
    const text =
      typeof raw === "string"
        ? raw
        : (raw as any[]).map((c: any) => c.text ?? "").join("");

    return {
      text,
      provider: "mistral",
      model: modelId,
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

    const modelId = opts.model ?? this.GROQ_MODEL;
    const groqParams: Record<string, any> = {
      model: modelId,
      messages,
      max_tokens: maxTokens,
      temperature,
    };
    if (opts.responseFormat && opts.responseFormat !== "text") {
      groqParams.response_format = opts.responseFormat === "json_schema" && opts.responseSchema
        ? { type: "json_schema", json_schema: { name: opts.responseSchema.name, description: opts.responseSchema.description, schema: opts.responseSchema.schema, strict: opts.responseSchema.strict ?? false } }
        : { type: "json_object" };
    }
    const completion = await this.groq.chat.completions.create(groqParams as any);

    const choice = (completion as any).choices[0];
    return {
      text: choice.message.content ?? "",
      provider: "groq",
      model: modelId,
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

    const modelId = opts.model ?? this.GROQ_MODEL;
    const groqStreamParams: Record<string, any> = {
      model: modelId,
      messages,
      max_tokens: maxTokens,
      temperature,
      stream: true,
    };
    if (opts.responseFormat && opts.responseFormat !== "text") {
      groqStreamParams.response_format = opts.responseFormat === "json_schema" && opts.responseSchema
        ? { type: "json_schema", json_schema: { name: opts.responseSchema.name, description: opts.responseSchema.description, schema: opts.responseSchema.schema, strict: opts.responseSchema.strict ?? false } }
        : { type: "json_object" };
    }
    const streamResp = await this.groq.chat.completions.create(groqStreamParams as any) as any;

    let fullText = "";
    for await (const chunk of streamResp) {
      const delta = chunk.choices[0]?.delta?.content ?? "";
      fullText += delta;
      if (delta) yield delta;
    }

    return {
      text: fullText,
      provider: "groq",
      model: modelId,
      fallbackChain: fallbackChain.length ? fallbackChain : undefined,
    };
  }
  // ── OpenRouter ─────────────────────────────────────────────────────────────

  private async _callOpenRouter(opts: AiRequestOptions): Promise<AiResponse> {
    if (!this.openrouter) throw new Error("OpenRouter client not initialised.");
    const {
      prompt,
      system,
      history = [],
      maxTokens = 2048,
      temperature = 0.7,
    } = opts;

    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
    if (system) messages.push({ role: "system", content: system });
    for (const m of history)
      messages.push({
        role: m.role as "user" | "assistant",
        content: m.content,
      });
    messages.push({ role: "user", content: prompt });

    const modelId = opts.model ?? this.OPENROUTER_MODEL;
    const orParams: Record<string, any> = {
      model: modelId,
      messages,
      maxTokens,
      temperature,
    };
    if (opts.responseFormat && opts.responseFormat !== "text") {
      orParams.responseFormat = opts.responseFormat === "json_schema" && opts.responseSchema
        ? { type: "json_schema", jsonSchema: { name: opts.responseSchema.name, description: opts.responseSchema.description, schema: opts.responseSchema.schema, strict: opts.responseSchema.strict } }
        : { type: "json_object" };
    }
    const completion = await this.openrouter.chat.send({
      chatGenerationParams: orParams as any,
    });

    const choice = completion.choices?.[0];
    const raw = choice?.message?.content ?? "";
    const text = typeof raw === "string" ? raw : "";

    return {
      text,
      provider: "openrouter",
      model: modelId,
      usage: {
        promptTokens: completion.usage?.promptTokens,
        completionTokens: completion.usage?.completionTokens,
        totalTokens: completion.usage?.totalTokens,
      },
    };
  }

  private async *_streamOpenRouter(
    opts: AiRequestOptions,
    fallbackChain: AiResponse["fallbackChain"] = [],
  ): AsyncGenerator<string, AiResponse, unknown> {
    if (!this.openrouter) throw new Error("OpenRouter client not initialised.");
    const {
      prompt,
      system,
      history = [],
      maxTokens = 2048,
      temperature = 0.7,
    } = opts;

    const messages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];
    if (system) messages.push({ role: "system", content: system });
    for (const m of history)
      messages.push({
        role: m.role as "user" | "assistant",
        content: m.content,
      });
    messages.push({ role: "user", content: prompt });

    const modelId = opts.model ?? this.OPENROUTER_MODEL;
    const orStreamParams: Record<string, any> = {
      model: modelId,
      messages,
      maxTokens,
      temperature,
      stream: true,
    };
    if (opts.responseFormat && opts.responseFormat !== "text") {
      orStreamParams.responseFormat = opts.responseFormat === "json_schema" && opts.responseSchema
        ? { type: "json_schema", jsonSchema: { name: opts.responseSchema.name, description: opts.responseSchema.description, schema: opts.responseSchema.schema, strict: opts.responseSchema.strict } }
        : { type: "json_object" };
    }
    const streamResp: any = await this.openrouter.chat.send({
      chatGenerationParams: orStreamParams as any,
    });

    let fullText = "";
    for await (const chunk of streamResp) {
      const delta = (chunk as any).choices?.[0]?.delta?.content ?? "";
      fullText += delta;
      if (delta) yield delta;
    }

    return {
      text: fullText,
      provider: "openrouter",
      model: modelId,
      fallbackChain: fallbackChain.length ? fallbackChain : undefined,
    };
  }
}

/** Convenience singleton */
export const aiService = AiService.getInstance();
