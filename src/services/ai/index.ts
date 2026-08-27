import { GoogleGenerativeAI, GenerativeModel } from "@google/generative-ai";
import { Mistral } from "@mistralai/mistralai";
import Groq from "groq-sdk";
import { OpenRouter } from "@openrouter/sdk";
import { Logging } from "@enjoys/express-utils/logger";
import { quota, QuotaTracker } from "./quota";

export type AiProvider = "gemini" | "mistral" | "groq" | "openrouter" | "nvidia";

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
   * Ordered alternates tried when the primary choice errors or is rate
   * limited. Without this a pinned provider has no escape from a 429.
   */
  fallbacks?: Array<{ provider: AiProvider; model?: string }>;
  /**
   * Called when a switch happens after chunks were already streamed. The
   * replacement model restarts the answer from scratch, so whatever reached
   * the client must be discarded or the two answers render concatenated.
   */
  onSwitch?: (info: { from: string; to: string; reason: string }) => void;
  /**
   * Summarise older history when the request would not fit the per-minute
   * token budget. `false` disables it; omitted uses the model's own budget.
   */
  compact?: false | { budgetTokens?: number; keepRecent?: number };
  /** Reports what compaction dropped, so the client can show it. */
  onCompact?: (info: CompactionInfo) => void;
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

export interface CompactionInfo {
  /** History messages replaced by the summary. */
  messagesSummarised: number;
  messagesKept: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  budgetTokens: number;
  summary: string;
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
  /** Remaining budget on the model that served this response. */
  quota?: ReturnType<typeof quota.usageFor>;
  /** Present when history was summarised to fit the budget. */
  compaction?: CompactionInfo;
}

// ─── Tool calling ─────────────────────────────────────────────────────────────

/** Providers exposing an OpenAI-compatible `tools` / `tool_calls` wire format. */
export type ToolCapableProvider = "nvidia" | "groq" | "openrouter" | "mistral";

export interface AiToolDefinition {
  name: string;
  description: string;
  /** JSON Schema for the tool arguments */
  parameters: Record<string, any>;
}

export interface AiToolCall {
  id: string;
  name: string;
  arguments: Record<string, any>;
  /** Raw argument string, kept so unparseable output can be surfaced */
  rawArguments?: string;
}

export interface AiChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: Array<{
    id: string;
    type: "function";
    function: { name: string; arguments: string };
  }>;
  tool_call_id?: string;
}

export interface ToolChatOptions {
  messages: AiChatMessage[];
  tools?: AiToolDefinition[];
  toolChoice?: "auto" | "none" | "required";
  provider?: ToolCapableProvider;
  model?: string;
  maxTokens?: number;
  temperature?: number;
}

export interface ToolChatResult {
  text: string;
  toolCalls: AiToolCall[];
  provider: ToolCapableProvider;
  model: string;
  finishReason?: string;
}

// ─── Singleton AI Service ─────────────────────────────────────────────────────

/**
 * Unified AI service wrapping Google Gemini, Mistral AI, Groq, and OpenRouter.
 *
 * **Automatic context-switching fallback** (default behaviour):
 *   When `options.provider` is NOT set, the service tries providers in order:
 *     1. NVIDIA NIM → `openai/gpt-oss-120b`
 *     2. Mistral    → `mistral-small-latest`
 *     3. Groq       → `llama-3.3-70b-versatile`
 *     4. OpenRouter → `qwen/qwen3-coder:free`
 *     5. Gemini     → `gemini-2.5-flash`
 *   On ANY error from a provider it immediately switches to the next one,
 *   carrying the full conversation context with it. The `fallbackChain`
 *   field in the response documents which switches happened and why.
 *
 * Environment variables required in `.env`:
 *   NVIDIA_API_KEY, GEMINI_API_KEY, MISTRAL_API_KEY, GROQ_API_KEY, OPEN_ROUTER_KEY
 */
export class AiService {
  private static _instance: AiService;

  private gemini: GoogleGenerativeAI | null = null;
  private mistral: Mistral | null = null;
  private groq: Groq | null = null;
  private openrouter: OpenRouter | null = null;
  /** NVIDIA NIM is OpenAI-compatible REST — no SDK, only the key is held. */
  private nvidiaKey: string | null = null;

  // Defaults used only when a caller pins a provider without a model. Each must
  // stay in MODEL_CATALOG; the previous Groq and OpenRouter slugs were retired
  // upstream and 404'd.
  private readonly GEMINI_MODEL = "gemini-2.5-flash";
  private readonly MISTRAL_MODEL = "mistral-small-latest";
  private readonly GROQ_MODEL = "openai/gpt-oss-120b";
  private readonly OPENROUTER_MODEL = "cohere/north-mini-code:free";
  private readonly NVIDIA_MODEL = "openai/gpt-oss-20b";
  private readonly NVIDIA_BASE_URL =
    process.env.NVIDIA_BASE_URL ?? "https://integrate.api.nvidia.com/v1";

  /** Default provider order */
  private readonly SEQUENCE: AiProvider[] = ["nvidia", "mistral", "groq", "openrouter", "gemini"];

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
    const nvk = process.env.NVIDIA_API_KEY;

    if (nvk) {
      this.nvidiaKey = nvk;
      Logging.dev("[AI] NVIDIA NIM  ✓");
    } else Logging.dev("[AI] NVIDIA NIM  ✗  (NVIDIA_API_KEY missing)", "notice");

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
    const compacted = await this._maybeCompact(options);
    options = compacted.options;

    const candidates = this._candidates(options);

    if (candidates.length === 0)
      throw new Error("No AI providers are configured.");

    const fallbackChain: AiResponse["fallbackChain"] = [];
    const est = this._estimateTokens(options);

    for (let i = 0; i < candidates.length; i++) {
      const { provider, model } = candidates[i];
      // A blocked model is only reached once everything ready has failed, so
      // waiting it out beats returning an error to the user.
      const verdict = quota.check(provider, model, est);
      if (!verdict.ok) {
        if (verdict.retryAfterMs > 60_000) {
          fallbackChain.push({
            provider,
            error: `${verdict.reason}, free in ${Math.ceil(verdict.retryAfterMs / 1000)}s`,
          });
          continue;
        }
        Logging.dev(
          `[AI:stream] all models throttled, waiting ${Math.ceil(verdict.retryAfterMs / 1000)}s for ${this._key(provider, model)}`,
          "notice",
        );
        await new Promise((r) => setTimeout(r, verdict.retryAfterMs));
      }

      const attempt: AiRequestOptions = { ...options, provider, model };
      let emitted = 0;
      quota.record(provider, model, est);
      try {
        Logging.dev(`[AI:stream] Trying ${this._key(provider, model)}`);

        let innerGen: AsyncGenerator<string, AiResponse, unknown>;

        if (provider === "gemini") {
          innerGen = this._streamGemini(attempt, fallbackChain);
        } else if (provider === "groq") {
          innerGen = this._streamGroq(attempt, fallbackChain);
        } else if (provider === "openrouter") {
          innerGen = this._streamOpenRouter(attempt, fallbackChain);
        } else if (provider === "nvidia") {
          innerGen = this._streamNvidia(attempt, fallbackChain);
        } else {
          innerGen = this._streamMistral(attempt, fallbackChain);
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
            finalResponse.quota = quota.usageFor(provider, model);
            finalResponse.compaction = compacted.info;
            return finalResponse;
          }
          emitted++;
          yield result.value;
        }
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        this._noteRateLimit(provider, model, err);
        Logging.dev(
          `[AI:stream] ${this._key(provider, model)} failed (${msg}), switching…`,
          "notice",
        );
        fallbackChain.push({ provider, error: msg });

        // The next model answers from the top, so anything already delivered is
        // now orphaned text the caller has to drop.
        const next = candidates[i + 1];
        if (emitted > 0 && next) {
          options.onSwitch?.({
            from: this._key(provider, model),
            to: this._key(next.provider, next.model),
            reason: msg,
          });
        }
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

  // ── Rate-limit cooldowns ──────────────────────────────────────────────────

  private _key(provider: AiProvider, model?: string): string {
    return `${provider}/${model ?? "default"}`;
  }

  /** Milliseconds until this model is usable again, or 0 if it is usable now. */
  cooldownRemaining(provider: AiProvider, model?: string, estTokens = 0): number {
    return quota.check(provider, model, estTokens).retryAfterMs;
  }

  /** Every model currently blocked, with the wait left on each. */
  activeCooldowns(): Array<{ target: string; msRemaining: number; reason: string }> {
    return quota
      .snapshot()
      .filter((s) => s.blockedForMs > 0)
      .map((s) => ({ target: s.target, msRemaining: s.blockedForMs, reason: "rate limited" }))
      .sort((a, b) => a.msRemaining - b.msRemaining);
  }

  /** Per-model request and token usage against the known free-tier ceilings. */
  quotaUsage() {
    return quota.snapshot();
  }

  /** Prompt size plus the reserved completion, which is what providers meter. */
  private _estimateTokens(opts: AiRequestOptions): number {
    const chars =
      (opts.system?.length ?? 0) +
      opts.prompt.length +
      (opts.history ?? []).reduce((s, m) => s + m.content.length, 0);
    return QuotaTracker.estimate(chars, opts.maxTokens ?? 2048);
  }

  /**
   * Replaces older history with a summary when the turn would not fit the
   * budget. A 7k-token system prompt against Groq's 8000 TPM leaves almost
   * nothing for history, so without this every multi-turn chat 429s.
   *
   * Returns the original options when nothing needed dropping.
   */
  private async _maybeCompact(
    options: AiRequestOptions,
  ): Promise<{ options: AiRequestOptions; info?: CompactionInfo }> {
    if (options.compact === false) return { options };

    const keepRecent = options.compact?.keepRecent ?? 4;
    const history = options.history ?? [];
    if (history.length <= keepRecent) return { options };

    // Budget follows the requested model, not the first that happens to have
    // room: a pinned model should be made to fit rather than silently swapped.
    const target = options.provider
      ? { provider: options.provider, model: options.model }
      : this._candidates({ ...options, compact: false })[0];
    const budget =
      options.compact?.budgetTokens ??
      quota.limitsFor(target?.provider ?? "groq", target?.model).tokensPerMinute ??
      8000;

    const before = this._estimateTokens(options);
    if (before <= budget) return { options };

    const older = history.slice(0, -keepRecent);
    const kept = history.slice(-keepRecent);

    let summary: string;
    try {
      const res = await this.generate({
        prompt: older.map((m) => `${m.role}: ${m.content}`).join("\n\n"),
        system:
          "Summarise the conversation below for use as context in a terminal assistant. " +
          "Keep hostnames, paths, ports, commands run, errors seen, and decisions made. " +
          "Drop pleasantries. Output plain prose under 150 words, no preamble.",
        maxTokens: 300,
        temperature: 0.2,
        // Guards against a summarisation call recursing into another one.
        compact: false,
      });
      summary = res.text.trim();
    } catch {
      // Losing the old turns entirely still beats failing the request.
      summary = "(earlier conversation omitted: summarisation unavailable)";
    }

    const compacted: AiRequestOptions = {
      ...options,
      history: [
        { role: "user", content: `Summary of earlier conversation:\n${summary}` },
        ...kept,
      ],
    };

    const info: CompactionInfo = {
      messagesSummarised: older.length,
      messagesKept: kept.length,
      estimatedTokensBefore: before,
      estimatedTokensAfter: this._estimateTokens(compacted),
      budgetTokens: budget,
      summary,
    };

    Logging.dev(
      `[AI:compact] ${older.length} messages → summary, ${before} → ${info.estimatedTokensAfter} tokens (budget ${budget})`,
      "notice",
    );
    options.onCompact?.(info);
    return { options: compacted, info };
  }

  /**
   * Records a cooldown if `err` is a rate limit. Providers report the wait
   * differently, so this reads the `retry-after` header, then the "try again in
   * 35.8275s" text Groq embeds in the body, then falls back to 60s.
   */
  private _noteRateLimit(provider: AiProvider, model: string | undefined, err: any): boolean {
    const msg = String(err?.message ?? err ?? "");
    const status = err?.status ?? err?.statusCode ?? err?.response?.status;
    const isRateLimit =
      status === 429 || msg.includes("429") || /rate.?limit/i.test(msg);
    if (!isRateLimit) return false;

    const headerRetry = Number(
      err?.headers?.["retry-after"] ?? err?.response?.headers?.get?.("retry-after"),
    );
    const bodyRetry = Number(msg.match(/try again in ([\d.]+)\s*s/i)?.[1]);
    const seconds = Number.isFinite(headerRetry) && headerRetry > 0
      ? headerRetry
      : Number.isFinite(bodyRetry) && bodyRetry > 0
        ? bodyRetry
        : 60;

    // Small pad: retrying on the exact boundary tends to 429 again.
    quota.penalize(provider, model, Math.ceil(seconds * 1000) + 500);
    return true;
  }

  /**
   * Ordered attempts for a request: the caller's choice first, then its
   * fallbacks, then the default sequence. Models whose budget cannot cover this
   * request are moved to the back rather than dropped, so a fully throttled set
   * still tries the one that frees up soonest instead of failing outright.
   */
  private _candidates(
    options: AiRequestOptions,
  ): Array<{ provider: AiProvider; model?: string }> {
    const seen = new Set<string>();
    const ordered: Array<{ provider: AiProvider; model?: string }> = [];
    const push = (provider: AiProvider, model?: string) => {
      if (!this._isAvailable(provider)) return;
      const k = this._key(provider, model);
      if (seen.has(k)) return;
      seen.add(k);
      ordered.push({ provider, model });
    };

    if (options.provider) push(options.provider, options.model);
    for (const f of options.fallbacks ?? []) push(f.provider, f.model);
    if (!options.provider) for (const p of this.SEQUENCE) push(p, undefined);

    const est = this._estimateTokens(options);
    const verdicts = new Map(
      ordered.map((c) => [this._key(c.provider, c.model), quota.check(c.provider, c.model, est)]),
    );

    const ready = ordered.filter((c) => verdicts.get(this._key(c.provider, c.model))!.ok);
    const blocked = ordered
      .filter((c) => !verdicts.get(this._key(c.provider, c.model))!.ok)
      .sort(
        (a, b) =>
          verdicts.get(this._key(a.provider, a.model))!.retryAfterMs -
          verdicts.get(this._key(b.provider, b.model))!.retryAfterMs,
      );

    for (const c of blocked) {
      const v = verdicts.get(this._key(c.provider, c.model))!;
      Logging.dev(
        `[AI:quota] skipping ${this._key(c.provider, c.model)}: ${v.reason} (free in ${Math.ceil(v.retryAfterMs / 1000)}s)`,
      );
    }

    return [...ready, ...blocked];
  }

  // ── Internal: sequential fallback with context ────────────────────────────

  private async _generateWithFallback(
    options: AiRequestOptions,
  ): Promise<AiResponse> {
    const candidates = this._candidates(options);
    if (candidates.length === 0)
      throw new Error("No AI providers are configured.");

    const fallbackChain: AiResponse["fallbackChain"] = [];
    const est = this._estimateTokens(options);

    for (const { provider, model } of candidates) {
      const verdict = quota.check(provider, model, est);
      if (!verdict.ok) {
        if (verdict.retryAfterMs > 60_000) {
          fallbackChain.push({
            provider,
            error: `${verdict.reason}, free in ${Math.ceil(verdict.retryAfterMs / 1000)}s`,
          });
          continue;
        }
        Logging.dev(
          `[AI] all models throttled, waiting ${Math.ceil(verdict.retryAfterMs / 1000)}s for ${this._key(provider, model)}`,
          "notice",
        );
        await new Promise((r) => setTimeout(r, verdict.retryAfterMs));
      }

      quota.record(provider, model, est);
      try {
        Logging.dev(`[AI] Trying ${this._key(provider, model)}`);
        const result = await this._callProvider(provider, { ...options, provider, model });
        // Attach fallback info if we had to switch
        if (fallbackChain.length) result.fallbackChain = fallbackChain;
        return result;
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        this._noteRateLimit(provider, model, err);
        Logging.dev(
          `[AI] ${this._key(provider, model)} failed (${msg}), switching…`,
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
      case "nvidia":
        return this._callNvidia(opts);
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
      case "nvidia":     return !!this.nvidiaKey;
      default:           return false;
    }
  }

  private _modelFor(p: AiProvider): string {
    switch (p) {
      case "gemini":     return this.GEMINI_MODEL;
      case "mistral":    return this.MISTRAL_MODEL;
      case "groq":       return this.GROQ_MODEL;
      case "openrouter": return this.OPENROUTER_MODEL;
      case "nvidia":     return this.NVIDIA_MODEL;
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

  // ── NVIDIA NIM (OpenAI-compatible REST) ────────────────────────────────────

  private _nvidiaBody(opts: AiRequestOptions, stream: boolean): Record<string, any> {
    const {
      prompt,
      system,
      history = [],
      maxTokens = 2048,
      temperature = 0.7,
    } = opts;

    const messages: Array<{ role: string; content: string }> = [];
    if (system) messages.push({ role: "system", content: system });
    for (const m of history) messages.push({ role: m.role, content: m.content });
    messages.push({ role: "user", content: prompt });

    const body: Record<string, any> = {
      model: opts.model ?? this.NVIDIA_MODEL,
      messages,
      max_tokens: maxTokens,
      temperature,
      stream,
    };
    if (opts.responseFormat && opts.responseFormat !== "text") {
      body.response_format =
        opts.responseFormat === "json_schema" && opts.responseSchema
          ? {
              type: "json_schema",
              json_schema: {
                name: opts.responseSchema.name,
                description: opts.responseSchema.description,
                schema: opts.responseSchema.schema,
                strict: opts.responseSchema.strict ?? false,
              },
            }
          : { type: "json_object" };
    }
    return body;
  }

  private async _nvidiaFetch(body: Record<string, any>, stream: boolean): Promise<any> {
    if (!this.nvidiaKey) throw new Error("NVIDIA client not initialised.");

    const res: any = await fetch(`${this.NVIDIA_BASE_URL}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.nvidiaKey}`,
        "Content-Type": "application/json",
        Accept: stream ? "text/event-stream" : "application/json",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`NVIDIA NIM ${res.status}: ${String(detail).slice(0, 300)}`);
    }
    return res;
  }

  private async _callNvidia(opts: AiRequestOptions): Promise<AiResponse> {
    const body = this._nvidiaBody(opts, false);
    const res = await this._nvidiaFetch(body, false);
    const json: any = await res.json();

    const message = json.choices?.[0]?.message;
    // Reasoning models (gpt-oss, Nemotron) put chain-of-thought in reasoning_content.
    const text: string = message?.content ?? "";

    return {
      text,
      provider: "nvidia",
      model: body.model,
      usage: {
        promptTokens: json.usage?.prompt_tokens,
        completionTokens: json.usage?.completion_tokens,
        totalTokens: json.usage?.total_tokens,
      },
    };
  }

  private async *_streamNvidia(
    opts: AiRequestOptions,
    fallbackChain: AiResponse["fallbackChain"] = [],
  ): AsyncGenerator<string, AiResponse, unknown> {
    const body = this._nvidiaBody(opts, true);
    const res = await this._nvidiaFetch(body, true);
    if (!res.body) throw new Error("NVIDIA NIM returned an empty stream body.");

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;

          const payload = trimmed.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;

          let parsed: any;
          try {
            parsed = JSON.parse(payload);
          } catch {
            continue;
          }

          const delta = parsed.choices?.[0]?.delta?.content ?? "";
          if (delta) {
            fullText += delta;
            yield delta;
          }
        }
      }
    } finally {
      reader.releaseLock?.();
    }

    return {
      text: fullText,
      provider: "nvidia",
      model: body.model,
      fallbackChain: fallbackChain.length ? fallbackChain : undefined,
    };
  }

  // ── Tool calling (OpenAI-compatible providers only) ───────────────────────

  private _openAiTransport(p: ToolCapableProvider): { url: string; key: string } {
    switch (p) {
      case "nvidia":
        if (!this.nvidiaKey) throw new Error("NVIDIA client not initialised.");
        return { url: `${this.NVIDIA_BASE_URL}/chat/completions`, key: this.nvidiaKey };
      case "groq":
        if (!process.env.GROQ_API_KEY) throw new Error("Groq client not initialised.");
        return {
          url: "https://api.groq.com/openai/v1/chat/completions",
          key: process.env.GROQ_API_KEY,
        };
      case "openrouter":
        if (!process.env.OPEN_ROUTER_KEY) throw new Error("OpenRouter client not initialised.");
        return {
          url: "https://openrouter.ai/api/v1/chat/completions",
          key: process.env.OPEN_ROUTER_KEY,
        };
      case "mistral":
        if (!process.env.MISTRAL_API_KEY) throw new Error("Mistral client not initialised.");
        return {
          url: "https://api.mistral.ai/v1/chat/completions",
          key: process.env.MISTRAL_API_KEY,
        };
    }
  }

  /** Providers that support the OpenAI tool-calling wire format. */
  toolCapableProviders(): ToolCapableProvider[] {
    return (["nvidia", "groq", "openrouter", "mistral"] as ToolCapableProvider[]).filter((p) =>
      this._isAvailable(p),
    );
  }

  defaultToolModel(p: ToolCapableProvider): string {
    return this._modelFor(p);
  }

  /**
   * Stream a tool-calling turn. Yields assistant text deltas and returns the
   * accumulated text plus any tool calls the model requested.
   *
   * Unlike `stream()`, this does NOT fall back across providers: a partially
   * emitted tool call cannot be replayed against a different provider, so the
   * caller decides whether to retry the whole step.
   */
  async *streamWithTools(
    opts: ToolChatOptions,
  ): AsyncGenerator<string, ToolChatResult, unknown> {
    const provider = opts.provider ?? this.toolCapableProviders()[0];
    if (!provider) throw new Error("No tool-capable AI provider is configured.");

    const { url, key } = this._openAiTransport(provider);
    const model = opts.model ?? this._modelFor(provider);

    const body: Record<string, any> = {
      model,
      messages: opts.messages,
      max_tokens: opts.maxTokens ?? 2048,
      temperature: opts.temperature ?? 0.3,
      stream: true,
    };
    if (opts.tools?.length) {
      body.tools = opts.tools.map((t) => ({
        type: "function",
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));
      body.tool_choice = opts.toolChoice ?? "auto";
    }

    const res: any = await fetch(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key}`,
        "Content-Type": "application/json",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const detail = await res.text().catch(() => res.statusText);
      throw new Error(`${provider} ${res.status}: ${String(detail).slice(0, 300)}`);
    }
    if (!res.body) throw new Error(`${provider} returned an empty stream body.`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let fullText = "";
    let finishReason: string | undefined;
    // Tool-call fragments arrive spread across deltas, keyed by their index.
    const partials = new Map<number, { id: string; name: string; args: string }>();

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed.startsWith("data:")) continue;
          const payload = trimmed.slice(5).trim();
          if (!payload || payload === "[DONE]") continue;

          let parsed: any;
          try {
            parsed = JSON.parse(payload);
          } catch {
            continue;
          }

          const choice = parsed.choices?.[0];
          if (!choice) continue;
          if (choice.finish_reason) finishReason = choice.finish_reason;

          const textDelta = choice.delta?.content ?? "";
          if (textDelta) {
            fullText += textDelta;
            yield textDelta;
          }

          for (const tc of choice.delta?.tool_calls ?? []) {
            const idx = tc.index ?? 0;
            const acc = partials.get(idx) ?? { id: "", name: "", args: "" };
            if (tc.id) acc.id = tc.id;
            if (tc.function?.name) acc.name += tc.function.name;
            if (tc.function?.arguments) acc.args += tc.function.arguments;
            partials.set(idx, acc);
          }
        }
      }
    } finally {
      reader.releaseLock?.();
    }

    const toolCalls: AiToolCall[] = [...partials.entries()]
      .sort(([a], [b]) => a - b)
      .map(([idx, acc]) => {
        let args: Record<string, any> = {};
        try {
          args = acc.args ? JSON.parse(acc.args) : {};
        } catch {
          Logging.dev(
            `[AI:tools] Unparseable arguments for ${acc.name}: ${acc.args.slice(0, 200)}`,
            "notice",
          );
        }
        return {
          id: acc.id || `call_${idx}_${Date.now()}`,
          name: acc.name,
          arguments: args,
          rawArguments: acc.args,
        };
      })
      .filter((c) => !!c.name);

    return { text: fullText, toolCalls, provider, model, finishReason };
  }
}

/** Convenience singleton */
export const aiService = AiService.getInstance();
