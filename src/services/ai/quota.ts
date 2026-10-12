import { Logging } from "@enjoys/express-utils/logger";
import type { AiProvider } from "./index";

export interface ModelLimits {
  requestsPerMinute?: number;
  /** Counts prompt + reserved completion tokens, which is what providers bill. */
  tokensPerMinute?: number;
  requestsPerDay?: number;
}

/**
 * Free-tier ceilings per model, keyed `provider/model`.
 *
 * Only `groq/openai/gpt-oss-120b` is measured — its 429 body states "TPM: Limit
 * 8000". The rest are the published free-tier figures and are deliberately
 * conservative: undershooting costs a needless model switch, overshooting costs
 * a 429 and a wasted round trip. Tune as real limits are observed.
 */
export const MODEL_LIMITS: Record<string, ModelLimits> = {
  "groq/openai/gpt-oss-120b": { requestsPerMinute: 30, tokensPerMinute: 8000, requestsPerDay: 1000 },
  "groq/openai/gpt-oss-20b": { requestsPerMinute: 30, tokensPerMinute: 8000, requestsPerDay: 1000 },
  "groq/qwen/qwen3.8-27b": { requestsPerMinute: 30, tokensPerMinute: 8000, requestsPerDay: 1000 },
  "gemini/gemini-2.5-flash": { requestsPerMinute: 10, tokensPerMinute: 250_000, requestsPerDay: 250 },
  "mistral/mistral-small-latest": { requestsPerMinute: 60, tokensPerMinute: 500_000 },
  "nvidia/openai/gpt-oss-20b": { requestsPerMinute: 40 },
};

/** Applied when a model has no entry above. OpenRouter meters per account. */
export const PROVIDER_LIMITS: Partial<Record<AiProvider, ModelLimits>> = {
  openrouter: { requestsPerMinute: 20, requestsPerDay: 50 },
  groq: { requestsPerMinute: 30, tokensPerMinute: 8000, requestsPerDay: 1000 },
  nvidia: { requestsPerMinute: 40 },
  mistral: { requestsPerMinute: 60, tokensPerMinute: 500_000 },
  gemini: { requestsPerMinute: 10, requestsPerDay: 250 },
};

interface Hit {
  at: number;
  tokens: number;
}

interface Bucket {
  /** Rolling one-minute window. */
  recent: Hit[];
  dayCount: number;
  dayResetAt: number;
  /** Set from an observed 429; overrides the computed budget until it passes. */
  penaltyUntil: number;
}

const MINUTE = 60_000;
const DAY = 86_400_000;

export interface QuotaVerdict {
  ok: boolean;
  /** How long until this model can serve the request, 0 when ok. */
  retryAfterMs: number;
  reason?: string;
}

/**
 * Tracks usage per model so a request can be routed away from a model that is
 * about to be throttled, instead of discovering the limit through a 429.
 *
 * In-memory and per-process: the windows are seconds-to-minutes, so surviving a
 * restart is not worth a round trip to Redis. With several replicas each tracks
 * its own share and the 429 penalty still catches the overlap.
 */
class QuotaTracker {
  private readonly buckets = new Map<string, Bucket>();

  limitsFor(provider: AiProvider, model?: string): ModelLimits {
    return MODEL_LIMITS[`${provider}/${model}`] ?? PROVIDER_LIMITS[provider] ?? {};
  }

  private bucket(key: string): Bucket {
    let b = this.buckets.get(key);
    if (!b) {
      b = { recent: [], dayCount: 0, dayResetAt: Date.now() + DAY, penaltyUntil: 0 };
      this.buckets.set(key, b);
    }
    const now = Date.now();
    if (now >= b.dayResetAt) {
      b.dayCount = 0;
      b.dayResetAt = now + DAY;
    }
    b.recent = b.recent.filter((h) => now - h.at < MINUTE);
    return b;
  }

  /** Rough token count; providers bill prompt plus the reserved completion. */
  static estimate(chars: number, maxTokens: number): number {
    return Math.ceil(chars / 4) + maxTokens;
  }

  /** Whether this model can take a request of `estTokens` right now. */
  check(provider: AiProvider, model: string | undefined, estTokens: number): QuotaVerdict {
    const key = `${provider}/${model ?? "default"}`;
    const b = this.bucket(key);
    const now = Date.now();

    if (b.penaltyUntil > now) {
      return { ok: false, retryAfterMs: b.penaltyUntil - now, reason: "rate limited (429)" };
    }

    const limits = this.limitsFor(provider, model);

    if (limits.requestsPerDay !== undefined && b.dayCount >= limits.requestsPerDay) {
      return { ok: false, retryAfterMs: b.dayResetAt - now, reason: "daily request cap reached" };
    }

    if (limits.requestsPerMinute !== undefined && b.recent.length >= limits.requestsPerMinute) {
      const oldest = b.recent[0]!.at;
      return { ok: false, retryAfterMs: oldest + MINUTE - now, reason: "requests-per-minute cap" };
    }

    if (limits.tokensPerMinute !== undefined) {
      const used = b.recent.reduce((sum, h) => sum + h.tokens, 0);
      if (used + estTokens > limits.tokensPerMinute) {
        // Wait only until enough of the window ages out to fit this request.
        const needed = used + estTokens - limits.tokensPerMinute;
        let freed = 0;
        let readyAt = now;
        for (const h of b.recent) {
          freed += h.tokens;
          readyAt = h.at + MINUTE;
          if (freed >= needed) break;
        }
        return {
          ok: false,
          retryAfterMs: Math.max(0, readyAt - now),
          reason: `tokens-per-minute cap (${used}/${limits.tokensPerMinute} used, ${estTokens} requested)`,
        };
      }
    }

    return { ok: true, retryAfterMs: 0 };
  }

  /** Books usage against the window. Call once per attempted request. */
  record(provider: AiProvider, model: string | undefined, tokens: number): void {
    const b = this.bucket(`${provider}/${model ?? "default"}`);
    b.recent.push({ at: Date.now(), tokens });
    b.dayCount++;
  }

  /** Applies a provider-stated cooldown after an observed 429. */
  penalize(provider: AiProvider, model: string | undefined, ms: number): void {
    const key = `${provider}/${model ?? "default"}`;
    const b = this.bucket(key);
    b.penaltyUntil = Date.now() + ms;
    Logging.dev(`[AI:quota] ${key} penalised for ${Math.ceil(ms / 1000)}s`, "notice");
  }

  /** Window state for one model, shaped for reporting to the client. */
  usageFor(provider: AiProvider, model?: string) {
    const b = this.bucket(`${provider}/${model ?? "default"}`);
    const limits = this.limitsFor(provider, model);
    const tokensLastMinute = b.recent.reduce((s, h) => s + h.tokens, 0);
    const oldest = b.recent[0]?.at;
    return {
      target: `${provider}/${model ?? "default"}`,
      tokensLastMinute,
      tokenLimitPerMinute: limits.tokensPerMinute ?? null,
      tokensRemaining:
        limits.tokensPerMinute !== undefined
          ? Math.max(0, limits.tokensPerMinute - tokensLastMinute)
          : null,
      requestsLastMinute: b.recent.length,
      requestLimitPerMinute: limits.requestsPerMinute ?? null,
      requestsToday: b.dayCount,
      requestLimitPerDay: limits.requestsPerDay ?? null,
      /** When the oldest hit ages out and part of the budget returns. */
      windowResetsInMs: oldest ? Math.max(0, oldest + MINUTE - Date.now()) : 0,
      blockedForMs: Math.max(0, b.penaltyUntil - Date.now()),
    };
  }

  /** Current usage per model, for /metrics and debugging. */
  snapshot(): Array<{
    target: string;
    requestsLastMinute: number;
    tokensLastMinute: number;
    requestsToday: number;
    limits: ModelLimits;
    blockedForMs: number;
  }> {
    const now = Date.now();
    const out = [];
    for (const key of [...this.buckets.keys()]) {
      const b = this.bucket(key);
      const [provider, ...rest] = key.split("/");
      out.push({
        target: key,
        requestsLastMinute: b.recent.length,
        tokensLastMinute: b.recent.reduce((s, h) => s + h.tokens, 0),
        requestsToday: b.dayCount,
        limits: this.limitsFor(provider as AiProvider, rest.join("/")),
        blockedForMs: Math.max(0, b.penaltyUntil - now),
      });
    }
    return out;
  }
}

export const quota = new QuotaTracker();
export { QuotaTracker };
