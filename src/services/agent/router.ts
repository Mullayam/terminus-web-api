import { aiService, type ToolCapableProvider } from "../ai";

export type TaskComplexity = "simple" | "hard";
export type ThinkingMode = "auto" | "fast" | "thinking";
export type ModelTier = "fast" | "thinking";

export interface Classification {
  complexity: TaskComplexity;
  score: number;
  signals: string[];
}

/**
 * Signals that a request needs multi-step reasoning. Deliberately keyword-based:
 * routing must not cost an extra model round trip.
 */
const REASONING_SIGNALS: Array<{ re: RegExp; weight: number; label: string }> = [
  { re: /\bwhy\b/i, weight: 3, label: "causal-question" },
  { re: /\b(debug|troubleshoot|diagnose|investigate)\b/i, weight: 4, label: "debugging" },
  { re: /\b(analyz|analys)e?\b/i, weight: 3, label: "analysis" },
  { re: /\b(architect|architecture|design)\b/i, weight: 3, label: "architecture" },
  { re: /\b(migrat|refactor)/i, weight: 4, label: "migration" },
  { re: /\bfix\b/i, weight: 3, label: "repair" },
  { re: /\bplan\b/i, weight: 3, label: "planning" },
  { re: /\b(root cause|not working|broken|failing|crash|500|502|503|timeout)\b/i, weight: 4, label: "failure" },
  { re: /\b(step by step|multiple steps|then|after that|and then)\b/i, weight: 2, label: "multi-step" },
  { re: /\b(compare|trade-?off|should i|best way)\b/i, weight: 2, label: "evaluation" },
  { re: /\b(optimi[sz]e|performance|bottleneck|leak)\b/i, weight: 3, label: "performance" },
];

const TRIVIAL_SIGNALS: Array<{ re: RegExp; weight: number; label: string }> = [
  { re: /^\s*(hi|hey|hello|thanks|thank you|ok|okay|yes|no)\b/i, weight: -5, label: "greeting" },
  { re: /^\s*(what is|what's|show me|list|display|print|cat|ls)\b/i, weight: -2, label: "lookup" },
];

const HARD_THRESHOLD = 7;

export function classify(input: string): Classification {
  let score = 0;
  const signals: string[] = [];

  for (const { re, weight, label } of [...REASONING_SIGNALS, ...TRIVIAL_SIGNALS]) {
    if (re.test(input)) {
      score += weight;
      signals.push(label);
    }
  }

  const words = input.trim().split(/\s+/).length;
  if (words > 120) {
    score += 3;
    signals.push("long-request");
  } else if (words > 40) {
    score += 1;
    signals.push("medium-request");
  }

  return { complexity: score >= HARD_THRESHOLD ? "hard" : "simple", score, signals };
}

// ─── Model catalog ────────────────────────────────────────────────────────────

export interface ModelChoice {
  provider: ToolCapableProvider;
  model: string;
}

/**
 * Ordered preference per tier, measured by real tool-calling latency rather
 * than parameter count. Groq is first because it answered a tool-calling turn
 * in ~0.6s where NVIDIA took 2.5-28s for the same weights.
 */
const FAST_CHAIN: ModelChoice[] = [
  { provider: "groq", model: "openai/gpt-oss-20b" },
  { provider: "groq", model: "openai/gpt-oss-120b" },
  { provider: "openrouter", model: "liquid/lfm-2.5-2.6b:free" },
  { provider: "openrouter", model: "nvidia/nemotron-3.5-lightning:free" },
  { provider: "nvidia", model: "openai/gpt-oss-20b" },
];

const THINKING_CHAIN: ModelChoice[] = [
  { provider: "groq", model: "openai/gpt-oss-120b" },
  { provider: "groq", model: "qwen/qwen3.8-27b" },
  { provider: "openrouter", model: "z-ai/glm-5.2:free" },
  { provider: "openrouter", model: "minimax/minimax-m3:free" },
  { provider: "openrouter", model: "nvidia/nemotron-3-ultra-550b-a55b:free" },
  { provider: "nvidia", model: "openai/gpt-oss-20b" },
];

/** Code-oriented work prefers code-tuned weights, still fast-first. */
const CODING_CHAIN: ModelChoice[] = [
  { provider: "groq", model: "openai/gpt-oss-120b" },
  { provider: "groq", model: "qwen/qwen3.8-27b" },
  { provider: "openrouter", model: "cohere/north-mini-code:free" },
  { provider: "openrouter", model: "z-ai/glm-5.2:free" },
];

/** `AGENT_FAST_MODEL=groq/openai/gpt-oss-20b` style override. */
function envOverride(name: string): ModelChoice | undefined {
  const raw = process.env[name];
  if (!raw) return undefined;
  const [provider, ...rest] = raw.split("/");
  if (!rest.length) return undefined;
  return { provider: provider as ToolCapableProvider, model: rest.join("/") };
}

export interface RouteDecision extends ModelChoice {
  tier: ModelTier;
  /** Remaining candidates, in order, to try if the chosen one fails */
  fallbacks: ModelChoice[];
}

export type AgentPhase = "planning" | "tool-selection" | "observation" | "final";

export interface RouterConfig {
  /** Force a provider; ignored when that provider is unconfigured */
  provider?: ToolCapableProvider;
  /** Force a tier, bypassing classification */
  mode?: ThinkingMode;
  /** Prefer the coding-tuned chain */
  coding?: boolean;
}

/**
 * Pick a model for a phase. In `auto` mode only genuinely hard work during
 * planning or observation gets the thinking tier; everything else stays fast.
 */
export function selectModel(
  phase: AgentPhase,
  classification: Classification,
  cfg: RouterConfig = {},
): RouteDecision {
  const available = new Set(aiService.toolCapableProviders());
  if (available.size === 0) throw new Error("No tool-capable AI provider is configured.");

  let tier: ModelTier;
  if (cfg.mode === "fast") tier = "fast";
  else if (cfg.mode === "thinking") tier = "thinking";
  else
    tier =
      classification.complexity === "hard" && (phase === "planning" || phase === "observation")
        ? "thinking"
        : "fast";

  const base = cfg.coding ? CODING_CHAIN : tier === "thinking" ? THINKING_CHAIN : FAST_CHAIN;
  const override = envOverride(tier === "thinking" ? "AGENT_THINKING_MODEL" : "AGENT_FAST_MODEL");

  let chain = base.filter((c) => available.has(c.provider));

  if (cfg.provider && available.has(cfg.provider)) {
    const preferred = chain.filter((c) => c.provider === cfg.provider);
    if (preferred.length) {
      chain = preferred.concat(chain.filter((c) => c.provider !== cfg.provider));
    }
  }
  if (override && available.has(override.provider)) {
    chain = [override, ...chain.filter((c) => c.model !== override.model)];
  }

  if (!chain.length) {
    const provider = [...available][0];
    return { provider, model: aiService.defaultToolModel(provider), tier, fallbacks: [] };
  }

  const [chosen, ...fallbacks] = chain;
  return { ...chosen, tier, fallbacks };
}
