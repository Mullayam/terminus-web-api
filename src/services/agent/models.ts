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
 */
export const MODEL_CATALOG: ModelEntry[] = [
  // ── Groq ──────────────────────────────────────────────────────────────────
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
    free: false,
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
    free: false,
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
    free: false,
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

  // ── Chat-only providers ───────────────────────────────────────────────────
  // No OpenAI-format tool calling, so these never serve agent runs. They are
  // valid for completions, hover, and chat.
  {
    provider: "mistral",
    model: "mistral-small-latest",
    label: "Mistral Small",
    description:
      "Quick general-purpose chat and completion model. Good default for inline completions and hover text.",
    bestFor: ["general", "coding", "explanation"],
    tiers: ["fast"],
    complexity: "simple",
    latencyMs: 740,
    contextWindow: 32768,
    free: false,
    supportsTools: false,
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
    contextWindow: 8192,
    free: false,
    supportsTools: false,
  },
];

/**
 * Models that were tested and rejected. Kept so the catalog documents why they
 * are absent rather than silently omitting them.
 */
export const REJECTED_MODELS: Array<{ provider: string; model: string; reason: string }> = [
  { provider: "groq", model: "llama-3.3-70b-versatile", reason: "404 — retired from Groq" },
  { provider: "groq", model: "groq/compound", reason: "Does not support tool calling" },
  { provider: "openrouter", model: "qwen/qwen3-coder:free", reason: "Retired; paid slug only" },
  { provider: "openrouter", model: "google/gemma-4-31b-it:free", reason: "429 — upstream rate limited" },
  { provider: "openrouter", model: "poolside/laguna-xs-2.1:free", reason: "429 — upstream rate limited" },
  { provider: "openrouter", model: "thinkingmachines/inkling-small:free", reason: "403 — account gated" },
  { provider: "nvidia", model: "openai/gpt-oss-120b", reason: "28s latency and intermittent 502s" },
  { provider: "nvidia", model: "deepseek-ai/deepseek-v4-flash", reason: "410 Gone — use -0731 suffix" },
  { provider: "nvidia", model: "zai/glm-5.2", reason: "Not present in the NVIDIA catalog" },
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
  const wantsAuto = !providerId || providerId === "auto";

  if (!wantsAuto && INLINE_EXCLUDED_PROVIDERS.has(providerId as AiProvider)) {
    throw new Error(
      `Provider "${providerId}" is not supported for inline completion; it is too slow. Use one of: ${[
        ...new Set(inlineModels().map((m) => m.provider)),
      ].join(", ")}.`,
    );
  }

  if (wantsAuto && !modelId) {
    const fastest = inlineModels()[0];
    if (!fastest) throw new Error("No provider suitable for inline completion is configured.");
    return { provider: fastest.provider, model: fastest.model };
  }

  const resolved = resolveChatModel(providerId, modelId);
  if (resolved && INLINE_EXCLUDED_PROVIDERS.has(resolved.provider)) {
    throw new Error(
      `Model "${modelId}" runs on "${resolved.provider}", which is not supported for inline completion.`,
    );
  }
  return resolved ?? { provider: inlineModels()[0].provider, model: inlineModels()[0].model };
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
