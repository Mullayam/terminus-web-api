import { aiService, type ToolCapableProvider } from "../ai";

export type ModelTier = "fast" | "thinking";

/** What a model is good at. Drives automatic selection. */
export type Capability =
  | "general"
  | "linux"
  | "coding"
  | "reasoning"
  | "planning"
  | "long-context";

export interface ModelEntry {
  provider: ToolCapableProvider;
  /** Provider-native model id, sent verbatim on the wire */
  model: string;
  label: string;
  /** Plain-English guidance on when to pick this model */
  description: string;
  bestFor: Capability[];
  /** Tiers this model may serve */
  tiers: ModelTier[];
  /** Measured latency of one tool-calling turn, in ms. Lower sorts first. */
  latencyMs: number;
  contextWindow: number;
  free: boolean;
  /** Known-broken models are kept documented so they are not re-added by mistake */
  broken?: string;
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
    bestFor: ["general", "linux"],
    tiers: ["fast"],
    latencyMs: 569,
    contextWindow: 131072,
    free: false,
  },
  {
    provider: "groq",
    model: "openai/gpt-oss-120b",
    label: "GPT-OSS 120B (Groq)",
    description:
      "Large model at near-fast latency. The default for planning, diagnosis, and multi-step reasoning — it is only ~40ms slower than the 20B but substantially stronger.",
    bestFor: ["reasoning", "planning", "linux", "coding", "general"],
    tiers: ["fast", "thinking"],
    latencyMs: 605,
    contextWindow: 131072,
    free: false,
  },
  {
    provider: "groq",
    model: "qwen/qwen3.8-27b",
    label: "Qwen 3.8 27B (Groq)",
    description:
      "Strong code comprehension and reliable multi-tool batching. Use for repository work, refactors, and test debugging.",
    bestFor: ["coding", "reasoning"],
    tiers: ["fast", "thinking"],
    latencyMs: 572,
    contextWindow: 131072,
    free: false,
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
    latencyMs: 1166,
    contextWindow: 65536,
    free: true,
  },
  {
    provider: "openrouter",
    model: "nvidia/nemotron-3.5-lightning:free",
    label: "Nemotron 3.5 Lightning (free)",
    description:
      "Fast with a 1M context window. Use when a large terminal buffer or long log needs to stay in context.",
    bestFor: ["general", "linux", "long-context"],
    tiers: ["fast"],
    latencyMs: 1615,
    contextWindow: 1000000,
    free: true,
  },
  {
    provider: "openrouter",
    model: "cohere/north-mini-code:free",
    label: "North Mini Code (free)",
    description: "Code-tuned and free. Fallback for repository work when Groq is unavailable.",
    bestFor: ["coding"],
    tiers: ["fast", "thinking"],
    latencyMs: 2002,
    contextWindow: 256000,
    free: true,
  },
  {
    provider: "openrouter",
    model: "minimax/minimax-m3:free",
    label: "MiniMax M3 (free)",
    description:
      "Good multi-step planner with a 1M context window. Use for deep investigations over large evidence sets.",
    bestFor: ["reasoning", "planning", "long-context"],
    tiers: ["thinking"],
    latencyMs: 2617,
    contextWindow: 1048576,
    free: true,
  },
  {
    provider: "openrouter",
    model: "z-ai/glm-5.2:free",
    label: "GLM-5.2 (free)",
    description:
      "Balanced free reasoning model that batches tool calls well. Solid thinking-tier fallback.",
    bestFor: ["reasoning", "coding", "planning"],
    tiers: ["thinking"],
    latencyMs: 2971,
    contextWindow: 256000,
    free: true,
  },
  {
    provider: "openrouter",
    model: "nvidia/nemotron-3-ultra-550b-a55b:free",
    label: "Nemotron 3 Ultra 550B (free)",
    description:
      "Largest free reasoning model, 1M context. Use for the hardest analysis when latency is acceptable.",
    bestFor: ["reasoning", "planning", "long-context"],
    tiers: ["thinking"],
    latencyMs: 3920,
    contextWindow: 1000000,
    free: true,
  },
  {
    provider: "openrouter",
    model: "nvidia/nemotron-3-super-120b-a12b:free",
    label: "Nemotron 3 Super 120B (free)",
    description: "Free mid-large reasoning model. Slowest of the working free options.",
    bestFor: ["reasoning"],
    tiers: ["thinking"],
    latencyMs: 5400,
    contextWindow: 262144,
    free: true,
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
    latencyMs: 2467,
    contextWindow: 131072,
    free: false,
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

/** Catalog entries whose provider currently has credentials configured. */
export function availableModels(): ModelEntry[] {
  const configured = new Set(aiService.toolCapableProviders());
  return MODEL_CATALOG.filter((m) => configured.has(m.provider));
}

export function findModel(provider: string, model: string): ModelEntry | undefined {
  return MODEL_CATALOG.find((m) => m.provider === provider && m.model === model);
}

/**
 * Rank candidates for a tier and capability, fastest first.
 * Entries matching the capability outrank generalists at the same tier.
 */
export function rankModels(tier: ModelTier, capability: Capability = "general"): ModelEntry[] {
  const pool = availableModels().filter((m) => m.tiers.includes(tier));
  const matches = pool.filter((m) => m.bestFor.includes(capability));
  const rest = pool.filter((m) => !m.bestFor.includes(capability));
  const byLatency = (a: ModelEntry, b: ModelEntry) => a.latencyMs - b.latencyMs;
  return [...matches.sort(byLatency), ...rest.sort(byLatency)];
}
