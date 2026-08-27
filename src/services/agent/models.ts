import { aiService, type AiProvider, type ToolCapableProvider } from "../ai";

export type ModelTier = "fast" | "thinking";

/** What a model is good at. Drives automatic selection. */
export type Capability =
  | "general"
  | "linux"
  | "coding"
  | "debugging"
  | "security"
  | "reasoning"
  | "planning"
  | "summarization"
  | "explanation"
  | "long-context";

/**
 * How demanding a task a model stays reliable on. Ranked, not a set: a model
 * with a `hard` ceiling also serves `moderate` and `simple` work.
 */
export type ComplexityCeiling = "simple" | "moderate" | "hard";

const COMPLEXITY_RANK: Record<ComplexityCeiling, number> = {
  simple: 0,
  moderate: 1,
  hard: 2,
};

/** UI-facing text for each capability, so the picker does not hardcode strings. */
export const CAPABILITY_META: Record<Capability, { label: string; description: string }> = {
  general: {
    label: "General",
    description: "Everyday questions, short answers, and routine tool selection.",
  },
  linux: {
    label: "Linux Ops",
    description: "Services, containers, networking, permissions, and resource faults on a host.",
  },
  coding: {
    label: "Coding",
    description: "Reading, writing, and refactoring source in a repository.",
  },
  debugging: {
    label: "Debugging",
    description: "Tracing a failure to its root cause across logs, stack traces, and code.",
  },
  security: {
    label: "Security",
    description: "Permissions, secrets, exposed ports, and hardening review.",
  },
  reasoning: {
    label: "Reasoning",
    description: "Weighing evidence and trade-offs where the answer is not a lookup.",
  },
  planning: {
    label: "Planning",
    description: "Decomposing a goal into ordered, verifiable steps before acting.",
  },
  summarization: {
    label: "Summarization",
    description: "Condensing long output, logs, or diffs without losing the decisive detail.",
  },
  explanation: {
    label: "Explanation",
    description: "Teaching what code or a command does, in prose, for a human reader.",
  },
  "long-context": {
    label: "Long Context",
    description: "Keeping a very large buffer, log, or evidence set in a single turn.",
  },
};

export interface ModelEntry {
  provider: AiProvider;
  /** Provider-native model id, sent verbatim on the wire */
  model: string;
  label: string;
  /** Plain-English guidance on when to pick this model */
  description: string;
  bestFor: Capability[];
  /** Tiers this model may serve */
  tiers: ModelTier[];
  /** Hardest task this model stays reliable on. */
  complexity: ComplexityCeiling;
  /** Measured latency of one turn, in ms. Lower sorts first. */
  latencyMs: number;
  contextWindow: number;
  free: boolean;
  /**
   * Whether the model accepts the OpenAI `tools` wire format. Agent runs need
   * this; completions, hover, and chat do not.
   */
  supportsTools: boolean;
}

/**
 * Catalog of tool-capable models.
 *
 * `latencyMs` is measured, not estimated: each entry was timed issuing the same
 * tool-calling turn. Selection sorts by it, which is why Groq leads every tier —
 * it served the same weights 4-45x faster than NVIDIA.
 *
 * `free` reflects the quota the configured key actually gets. Groq's free tier
 * bills nothing and meters per model (1000 req/day, 8000 tok/min each), so it is
 * both the fastest and the largest free budget here. OpenRouter's `:free` slugs
 * share one 50 req/day account-wide cap until $10 of credits is purchased, which
 * raises it to 1000/day — so adding more `:free` slugs buys no extra capacity.
 */
export const MODEL_CATALOG: ModelEntry[] = [
  // ── Groq ──────────────────────────────────────────────────────────────────
  {
    provider: "groq",
    model: "openai/gpt-oss-safeguard-20b",
    label: "GPT-OSS Safeguard 20B (Groq)",
    description:
      "Policy-tuned sibling of the 20B and the fastest model measured. Prefer it for permission, secret, and hardening review, where the answer is a judgement against a rule.",
    bestFor: ["security", "linux"],
    tiers: ["fast"],
    complexity: "simple",
    latencyMs: 213,
    contextWindow: 131072,
    free: true,
    supportsTools: true,
  },
  {
    provider: "groq",
    model: "openai/gpt-oss-20b",
    label: "GPT-OSS 20B (Groq)",
    description:
      "Fastest tool-caller available. Use for routine tool selection, short answers, and simple lookups where latency matters more than depth.",
    bestFor: ["general", "linux", "summarization"],
    tiers: ["fast"],
    complexity: "simple",
    latencyMs: 569,
    contextWindow: 131072,
    free: true,
    supportsTools: true,
  },
  {
    provider: "groq",
    model: "openai/gpt-oss-120b",
    label: "GPT-OSS 120B (Groq)",
    description:
      "Large model at near-fast latency. The default for planning, diagnosis, and multi-step reasoning — it is only ~40ms slower than the 20B but substantially stronger.",
    bestFor: [
      "reasoning",
      "planning",
      "linux",
      "coding",
      "debugging",
      "security",
      "explanation",
      "general",
    ],
    tiers: ["fast", "thinking"],
    complexity: "hard",
    latencyMs: 605,
    contextWindow: 131072,
    free: true,
    supportsTools: true,
  },
  {
    provider: "groq",
    model: "qwen/qwen3.8-27b",
    label: "Qwen 3.8 27B (Groq)",
    description:
      "Strong code comprehension and reliable multi-tool batching. Use for repository work, refactors, and test debugging.",
    bestFor: ["coding", "debugging", "reasoning", "explanation"],
    tiers: ["fast", "thinking"],
    complexity: "hard",
    latencyMs: 572,
    contextWindow: 131072,
    free: true,
    supportsTools: true,
  },

  // ── OpenRouter (free tier) ────────────────────────────────────────────────
  {
    provider: "openrouter",
    model: "liquid/lfm-2.5-2.6b:free",
    label: "LFM 2.5 2.6B (free)",
    description:
      "Very small and quick, free. Use as a fallback for trivial tool selection when Groq is rate-limited. Weak at reasoning.",
    bestFor: ["general"],
    tiers: ["fast"],
    complexity: "simple",
    latencyMs: 1166,
    contextWindow: 65536,
    free: true,
    supportsTools: true,
  },
  {
    provider: "openrouter",
    model: "nvidia/nemotron-3.5-lightning:free",
    label: "Nemotron 3.5 Lightning (free)",
    description:
      "Fast with a 1M context window. Use when a large terminal buffer or long log needs to stay in context.",
    bestFor: ["general", "linux", "long-context", "summarization"],
    tiers: ["fast"],
    complexity: "moderate",
    latencyMs: 1615,
    contextWindow: 1000000,
    free: true,
    supportsTools: true,
  },
  {
    provider: "openrouter",
    model: "dots-studio/dots-3-note-preview:free",
    label: "Dots 3 Note Preview (free)",
    description:
      "Fastest free tool-caller, with a 512K window. OpenRouter lists it as going away 2026-09-30, so treat it as temporary capacity.",
    bestFor: ["general", "linux", "summarization", "long-context"],
    tiers: ["fast"],
    complexity: "moderate",
    latencyMs: 1586,
    contextWindow: 512000,
    free: true,
    supportsTools: true,
  },
  {
    provider: "openrouter",
    model: "cohere/north-mini-code:free",
    label: "North Mini Code (free)",
    description: "Code-tuned and free. Fallback for repository work when Groq is unavailable.",
    bestFor: ["coding", "debugging"],
    tiers: ["fast", "thinking"],
    complexity: "moderate",
    latencyMs: 2002,
    contextWindow: 256000,
    free: true,
    supportsTools: true,
  },
  {
    provider: "openrouter",
    model: "minimax/minimax-m3:free",
    label: "MiniMax M3 (free)",
    description:
      "Good multi-step planner with a 1M context window. Use for deep investigations over large evidence sets.",
    bestFor: ["reasoning", "planning", "debugging", "long-context", "summarization"],
    tiers: ["thinking"],
    complexity: "hard",
    latencyMs: 2617,
    contextWindow: 1048576,
    free: true,
    supportsTools: true,
  },
  {
    provider: "openrouter",
    model: "z-ai/glm-5.2:free",
    label: "GLM-5.2 (free)",
    description:
      "Balanced free reasoning model that batches tool calls well. Solid thinking-tier fallback.",
    bestFor: ["reasoning", "coding", "planning", "debugging"],
    tiers: ["thinking"],
    complexity: "hard",
    latencyMs: 2971,
    contextWindow: 256000,
    free: true,
    supportsTools: true,
  },
  {
    provider: "openrouter",
    model: "nvidia/nemotron-3-ultra-550b-a55b:free",
    label: "Nemotron 3 Ultra 550B (free)",
    description:
      "Largest free reasoning model, 1M context. Use for the hardest analysis when latency is acceptable.",
    bestFor: ["reasoning", "planning", "security", "long-context"],
    tiers: ["thinking"],
    complexity: "hard",
    latencyMs: 3920,
    contextWindow: 1000000,
    free: true,
    supportsTools: true,
  },
  {
    provider: "openrouter",
    model: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
    label: "Nemotron 3 Nano Omni 30B Reasoning (free)",
    description:
      "Small free reasoning model with a 256K window. Slow for its size, so reserve it for thinking-tier work the faster free models get wrong.",
    bestFor: ["reasoning", "debugging"],
    tiers: ["thinking"],
    complexity: "moderate",
    latencyMs: 4961,
    contextWindow: 256000,
    free: true,
    supportsTools: true,
  },
  {
    provider: "openrouter",
    model: "nvidia/nemotron-3-super-120b-a12b:free",
    label: "Nemotron 3 Super 120B (free)",
    description: "Free mid-large reasoning model. Slowest of the working free options.",
    bestFor: ["reasoning", "explanation"],
    tiers: ["thinking"],
    complexity: "moderate",
    latencyMs: 5400,
    contextWindow: 262144,
    free: true,
    supportsTools: true,
  },

  // ── NVIDIA NIM ────────────────────────────────────────────────────────────
  {
    provider: "nvidia",
    model: "openai/gpt-oss-20b",
    label: "GPT-OSS 20B (NVIDIA)",
    description:
      "Same weights as the Groq entry but ~4x slower. Last-resort fallback when both Groq and OpenRouter fail.",
    bestFor: ["general"],
    tiers: ["fast"],
    complexity: "simple",
    latencyMs: 2467,
    contextWindow: 131072,
    free: false,
    supportsTools: true,
  },

  // ── Chat-only models ──────────────────────────────────────────────────────
  // These specific models answer in prose instead of emitting tool calls, so
  // they never serve agent runs. They are valid for completions, hover, and
  // chat. This is per-model, not per-provider.
  {    provider: "groq",
    model: "groq/compound-mini",
    label: "Compound Mini (Groq)",
    description:
      "Groq's agentic system with built-in web search, wrapped as a chat model. Fast, and useful when an answer needs facts newer than the model weights.",
    bestFor: ["general", "linux", "explanation"],
    tiers: ["fast"],
    complexity: "simple",
    latencyMs: 1058,
    contextWindow: 131072,
    free: true,
    supportsTools: false,
  },
  {
    provider: "nvidia",
    model: "nvidia/nemotron-3-nano-30b-a3b",
    label: "Nemotron 3 Nano 30B (NVIDIA)",
    description:
      "Answers in prose rather than calling tools, but keeps a 1M window and stays terse. Use for chat over very large pasted logs.",
    bestFor: ["general", "linux", "long-context", "summarization"],
    tiers: ["fast"],
    complexity: "simple",
    latencyMs: 1535,
    contextWindow: 1000000,
    free: false,
    supportsTools: false,
  },
  {
    provider: "groq",
    model: "groq/compound",
    label: "Compound (Groq)",
    description:
      "Larger sibling of Compound Mini, same built-in search. Use when the question needs more depth than the mini gives.",
    bestFor: ["general", "linux", "reasoning", "explanation"],
    tiers: ["fast"],
    complexity: "moderate",
    latencyMs: 2065,
    contextWindow: 131072,
    free: true,
    supportsTools: false,
  },
  {    provider: "mistral",
    model: "mistral-small-latest",
    label: "Mistral Small",
    description:
      "Quick general-purpose chat and completion model. Good default for inline completions and hover text.",
    bestFor: ["general", "coding", "explanation"],
    tiers: ["fast"],
    complexity: "simple",
    latencyMs: 740,
    contextWindow: 262144,
    free: false,
    supportsTools: true,
  },

  // ── Mistral ───────────────────────────────────────────────────────────────
  // Measured on the live API: all four continued a cursor completion, answered
  // a hover question, and emitted a correct `run_command` tool call.
  {
    provider: "mistral",
    model: "codestral-latest",
    label: "Codestral",
    description:
      "Code-tuned and the fastest Mistral entry. Continues from the cursor without markdown fences, which makes it the best fit for inline completion.",
    bestFor: ["coding", "debugging", "explanation"],
    tiers: ["fast", "thinking"],
    complexity: "moderate",
    latencyMs: 583,
    contextWindow: 256000,
    free: false,
    supportsTools: true,
  },
  {
    provider: "mistral",
    model: "mistral-code-fim-latest",
    label: "Mistral Code FIM",
    description:
      "Fill-in-middle variant. Same clean cursor continuation as Codestral and the only catalog model built for insertion between existing code.",
    bestFor: ["coding"],
    tiers: ["fast"],
    complexity: "moderate",
    latencyMs: 740,
    contextWindow: 256000,
    free: false,
    supportsTools: true,
  },
  {
    provider: "mistral",
    model: "ministral-3b-latest",
    label: "Ministral 3B",
    description:
      "Smallest and quickest Mistral model. Wraps output in markdown fences and was inaccurate on a hover question, so prefer it for cheap chat rather than completion or hover.",
    bestFor: ["general"],
    tiers: ["fast"],
    complexity: "simple",
    latencyMs: 519,
    contextWindow: 131072,
    free: false,
    supportsTools: true,
  },
  {
    provider: "mistral",
    model: "magistral-small-latest",
    label: "Magistral Small",
    description:
      "Reasoning-tuned with a 262k window. Rewrites a whole function instead of continuing from the cursor, so use it for chat and analysis, not completion.",
    bestFor: ["reasoning", "planning", "explanation", "long-context"],
    tiers: ["fast", "thinking"],
    complexity: "hard",
    latencyMs: 709,
    contextWindow: 262144,
    free: false,
    supportsTools: true,
  },
  {
    provider: "gemini",
    model: "gemini-2.5-flash",
    label: "Gemini 2.5 Flash",
    description:
      "Google's fast model. Strong at explaining code, useful for hover documentation.",
    bestFor: ["general", "reasoning", "explanation", "summarization"],
    tiers: ["fast"],
    complexity: "moderate",
    latencyMs: 1431,
    contextWindow: 1048576,
    free: true,
    supportsTools: false,
  },
];

/**
 * Models that were tested and rejected. Kept so the catalog documents why they
 * are absent rather than silently omitting them.
 *
 * A 429 on an OpenRouter `:free` slug is usually the account-wide daily cap
 * (`limit_source: openrouter_free_tier_daily`), not a verdict on the model —
 * check `GET /api/v1/key` before adding one here.
 */
export const REJECTED_MODELS: Array<{ provider: string; model: string; reason: string }> = [
  { provider: "groq", model: "llama-3.3-70b-versatile", reason: "404 — retired from Groq" },
  {
    provider: "groq",
    model: "qwen/qwen3.6-27b",
    reason: "Dumps chain-of-thought into `content` (8/8 prompts); never populates `reasoning`",
  },
  { provider: "openrouter", model: "qwen/qwen3-coder:free", reason: "Retired; paid slug only" },
  {
    provider: "openrouter",
    model: "openrouter/free",
    reason: "Auto-router; reached nemotron-3.5-content-safety, which answered 'User Safety: safe'",
  },
  { provider: "openrouter", model: "google/gemma-4-31b-it:free", reason: "Untested — 429 was the account-wide free-tier daily cap, not the model" },
  { provider: "openrouter", model: "google/gemma-4-26b-a4b-it:free", reason: "Untested — 429 was the account-wide free-tier daily cap, not the model" },
  { provider: "openrouter", model: "minimax/minimax-m2.7:free", reason: "Untested — 429 was the account-wide free-tier daily cap, not the model" },
  { provider: "openrouter", model: "poolside/laguna-xs-2.1:free", reason: "Untested — 429 was the account-wide free-tier daily cap, not the model" },
  { provider: "openrouter", model: "poolside/laguna-s-2.1:free", reason: "Works, but 8s per turn — slower than the 550B" },
  { provider: "openrouter", model: "thinkingmachines/inkling-small:free", reason: "403 — account gated" },
  { provider: "openrouter", model: "thinkingmachines/inkling:free", reason: "403 — account gated" },
  { provider: "nvidia", model: "openai/gpt-oss-120b", reason: "28s latency and intermittent 502s" },
  { provider: "nvidia", model: "moonshotai/kimi-k3", reason: "502 — upstream request failed" },
  { provider: "nvidia", model: "deepseek-ai/deepseek-v4-flash", reason: "410 Gone — use -0731 suffix" },
  { provider: "nvidia", model: "zai/glm-5.2", reason: "Not present in the NVIDIA catalog" },
  { provider: "nvidia", model: "google/gemma-4-31b-it", reason: "No response within 20s" },
];

/** A catalog entry known to be tool-capable, narrowed for the agent router. */
export type ToolModelEntry = ModelEntry & { provider: ToolCapableProvider };

function isToolEntry(m: ModelEntry): m is ToolModelEntry {
  return m.supportsTools;
}

/** Tool-capable catalog entries whose provider has credentials configured. */
export function availableModels(): ToolModelEntry[] {
  const configured = new Set<string>(aiService.toolCapableProviders());
  return MODEL_CATALOG.filter(isToolEntry).filter((m) => configured.has(m.provider));
}

/** Every catalog entry usable for plain chat/completion, tools or not. */
export function availableChatModels(): ModelEntry[] {
  const configured = new Set<string>(aiService.availableProviders());
  return MODEL_CATALOG.filter((m) => configured.has(m.provider));
}

/**
 * Alternates for a chat request, fastest first, excluding the primary choice.
 *
 * Free-tier limits are per model, not per provider, so a Groq TPM overrun must
 * be able to land on another Groq model before leaving the provider.
 */
export function chatFallbacks(
  primary?: { provider: AiProvider; model?: string },
): Array<{ provider: AiProvider; model: string }> {
  return availableChatModels()
    .filter((m) => !(primary && m.provider === primary.provider && m.model === primary.model))
    .sort((a, b) => a.latencyMs - b.latencyMs)
    .map((m) => ({ provider: m.provider, model: m.model }));
}

export function findModel(provider: string, model: string): ModelEntry | undefined {
  return MODEL_CATALOG.find((m) => m.provider === provider && m.model === model);
}

/**
 * Resolve a client model selection for the non-agent endpoints.
 *
 * Returns `undefined` for "auto" or an empty selection, which lets the AI
 * service run its own provider fallback chain. Throws on an unknown or
 * unconfigured selection so the caller can answer 400 rather than silently
 * falling back to a different model than the user asked for.
 */
export function resolveChatModel(
  providerId?: string,
  modelId?: string,
): { provider: AiProvider; model?: string } | undefined {
  const wantsAuto = !providerId || providerId === "auto";
  if (wantsAuto && !modelId) return undefined;

  const configured = new Set<string>(aiService.availableProviders());

  if (wantsAuto && modelId) {
    const entry = MODEL_CATALOG.find((m) => m.model === modelId && configured.has(m.provider));
    if (!entry) throw new Error(`Model "${modelId}" is not available. See GET /api/ai/providers.`);
    return { provider: entry.provider, model: entry.model };
  }

  const provider = providerId as AiProvider;
  if (!configured.has(provider)) {
    throw new Error(`Provider "${providerId}" is not configured.`);
  }
  if (modelId && !findModel(provider, modelId)) {
    throw new Error(
      `Model "${modelId}" is not in the catalog for provider "${providerId}". See GET /api/ai/providers.`,
    );
  }
  return { provider, model: modelId };
}

/**
 * Providers excluded from inline completion and ghost text.
 *
 * NVIDIA NIM is far too slow for keystroke-latency work: it measured 2.5s for a
 * tool turn and 28s for a one-word reply, and intermittently 502s. Ghost text
 * that arrives after the user has moved on is worse than no ghost text.
 */
const INLINE_EXCLUDED_PROVIDERS = new Set<AiProvider>(["nvidia"]);

/** Catalog entries fast enough to serve inline completion. */
export function inlineModels(): ModelEntry[] {
  const configured = new Set<string>(aiService.availableProviders());
  return MODEL_CATALOG.filter(
    (m) => !INLINE_EXCLUDED_PROVIDERS.has(m.provider) && configured.has(m.provider),
  ).sort((a, b) => a.latencyMs - b.latencyMs);
}

/**
 * Fast-tier models matching any of `capabilities`, fastest first.
 * Falls back to all fast models if nothing matches, so a niche capability
 * never leaves an endpoint with nothing to call.
 */
function fastModelsFor(capabilities: Capability[]): ModelEntry[] {
  const pool = inlineModels().filter((m) => m.tiers.includes("fast"));
  const matches = pool.filter((m) => capabilities.some((c) => m.bestFor.includes(c)));
  return matches.length ? matches : pool;
}

/**
 * Models for hover documentation: fast, and able to explain code.
 * Hover fires on mouse-over, so latency matters as much as it does inline.
 */
export function hoverModels(): ModelEntry[] {
  return fastModelsFor(["coding", "explanation"]);
}

/** Resolve a model selection for hover, preferring fast coding models. */
export function resolveHoverModel(
  providerId?: string,
  modelId?: string,
): { provider: AiProvider; model?: string } {
  return resolveLatencySensitive(hoverModels(), "hover", providerId, modelId);
}

/**
 * Shared resolution for latency-sensitive endpoints.
 *
 * "auto" pins an explicit model rather than returning `undefined`, because the
 * AI service's own fallback chain starts at NVIDIA — which would make every
 * automatic request multi-second.
 */
function resolveLatencySensitive(
  candidates: ModelEntry[],
  label: string,
  providerId?: string,
  modelId?: string,
): { provider: AiProvider; model?: string } {
  const wantsAuto = !providerId || providerId === "auto";

  if (!wantsAuto && INLINE_EXCLUDED_PROVIDERS.has(providerId as AiProvider)) {
    throw new Error(
      `Provider "${providerId}" is not supported for ${label}; it is too slow. Use one of: ${[
        ...new Set(inlineModels().map((m) => m.provider)),
      ].join(", ")}.`,
    );
  }

  if (wantsAuto && !modelId) {
    const fastest = candidates[0];
    if (!fastest) throw new Error(`No provider suitable for ${label} is configured.`);
    return { provider: fastest.provider, model: fastest.model };
  }

  const resolved = resolveChatModel(providerId, modelId);
  if (resolved && INLINE_EXCLUDED_PROVIDERS.has(resolved.provider)) {
    throw new Error(
      `Model "${modelId}" runs on "${resolved.provider}", which is not supported for ${label}.`,
    );
  }
  if (resolved) return resolved;

  const fastest = candidates[0];
  if (!fastest) throw new Error(`No provider suitable for ${label} is configured.`);
  return { provider: fastest.provider, model: fastest.model };
}

/**
 * Resolve a model selection for inline completion and ghost text.
 *
 * Unlike `resolveChatModel`, "auto" pins an explicit fast model rather than
 * returning `undefined`, because the AI service's own fallback chain starts at
 * NVIDIA — which would make every automatic completion multi-second.
 */
export function resolveInlineModel(
  providerId?: string,
  modelId?: string,
): { provider: AiProvider; model?: string } {
  return resolveLatencySensitive(
    fastModelsFor(["coding", "general"]),
    "inline completion",
    providerId,
    modelId,
  );
}

/**
 * Rank tool-capable candidates for a tier and capability, fastest first.
 * Entries matching the capability outrank generalists at the same tier.
 *
 * `minComplexity` drops models whose ceiling is below the task's demand, unless
 * that would leave nothing to route to — a slow answer beats no answer.
 */
export function rankModels(
  tier: ModelTier,
  capability: Capability = "general",
  minComplexity: ComplexityCeiling = "simple",
): ToolModelEntry[] {
  const tiered = availableModels().filter((m) => m.tiers.includes(tier));
  const floor = COMPLEXITY_RANK[minComplexity];
  const capable = tiered.filter((m) => COMPLEXITY_RANK[m.complexity] >= floor);
  const pool = capable.length ? capable : tiered;

  const matches = pool.filter((m) => m.bestFor.includes(capability));
  const rest = pool.filter((m) => !m.bestFor.includes(capability));
  const byLatency = (a: ModelEntry, b: ModelEntry) => a.latencyMs - b.latencyMs;
  return [...matches.sort(byLatency), ...rest.sort(byLatency)];
}
