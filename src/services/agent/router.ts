import { aiService, type ToolCapableProvider } from "../ai";
import {
  findModel,
  rankModels,
  type Capability,
  type ModelEntry,
  type ModelTier,
} from "./models";

export type TaskComplexity = "simple" | "hard";
export type ThinkingMode = "auto" | "fast" | "thinking";
/** `auto` hands provider choice to the classifier; anything else pins it. */
export type ProviderSelection = ToolCapableProvider | "auto";

export type { ModelTier, Capability };

export interface Classification {
  complexity: TaskComplexity;
  score: number;
  signals: string[];
  capability: Capability;
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

const CAPABILITY_SIGNALS: Array<{ re: RegExp; capability: Capability }> = [
  { re: /\b(code|function|class|refactor|test|compile|build|lint|typescript|python|import|syntax)\b/i, capability: "coding" },
  { re: /\b(nginx|systemd|systemctl|docker|kubernetes|k8s|disk|memory|cpu|port|firewall|service|daemon)\b/i, capability: "linux" },
  { re: /\b(explain|compare|trade-?off|architecture|design|strategy)\b/i, capability: "reasoning" },
];

const HARD_THRESHOLD = 7;
/** Beyond this much input, prefer a model with a large context window. */
const LONG_CONTEXT_CHARS = 40_000;

export function classify(input: string, contextChars = 0): Classification {
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

  let capability: Capability = "general";
  for (const { re, capability: cap } of CAPABILITY_SIGNALS) {
    if (re.test(input)) {
      capability = cap;
      signals.push(`domain:${cap}`);
      break;
    }
  }
  if (contextChars > LONG_CONTEXT_CHARS) {
    capability = "long-context";
    signals.push("long-context");
  }

  return {
    complexity: score >= HARD_THRESHOLD ? "hard" : "simple",
    score,
    signals,
    capability,
  };
}

// ─── Routing ──────────────────────────────────────────────────────────────────

export type AgentPhase = "planning" | "tool-selection" | "observation" | "final";

export interface RouterConfig {
  /** `auto` (or omitted) lets the classifier choose; a provider id pins it. */
  provider?: ProviderSelection;
  /** Explicit model id from the UI. Requires a pinned provider to be unambiguous. */
  model?: string;
  mode?: ThinkingMode;
  /** Capability hint from the agent profile, overriding the classifier's guess. */
  capability?: Capability;
}

export interface RouteDecision {
  provider: ToolCapableProvider;
  model: string;
  tier: ModelTier;
  /** The capability actually used for ranking */
  capability: Capability;
  /** Why this model was chosen, surfaced to the UI */
  reason: string;
  /** Ordered alternatives if the chosen model errors */
  fallbacks: Array<{ provider: ToolCapableProvider; model: string }>;
}

/** `AGENT_FAST_MODEL=groq/openai/gpt-oss-20b` style override. */
function envOverride(tier: ModelTier) {
  const raw = process.env[tier === "thinking" ? "AGENT_THINKING_MODEL" : "AGENT_FAST_MODEL"];
  if (!raw) return undefined;
  const [provider, ...rest] = raw.split("/");
  if (!rest.length) return undefined;
  return { provider: provider as ToolCapableProvider, model: rest.join("/") };
}

function toChoice(m: ModelEntry | { provider: ToolCapableProvider; model: string }) {
  return { provider: m.provider, model: m.model };
}

/**
 * Resolve the model for a phase.
 *
 * Precedence: explicit UI model → env override → catalog ranking driven by the
 * classifier. Fallbacks are always the remaining ranked catalog entries.
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

  // A context payload too large for a small window outranks the profile hint.
  const capability: Capability =
    classification.capability === "long-context"
      ? "long-context"
      : cfg.capability ?? classification.capability;
  const ranked = rankModels(tier, capability);
  const pinned = cfg.provider && cfg.provider !== "auto" ? cfg.provider : undefined;

  // 1. Explicit model from the UI.
  if (cfg.model) {
    const resolvedProvider =
      pinned ??
      (["groq", "openrouter", "nvidia"] as ToolCapableProvider[]).find((p) =>
        findModel(p, cfg.model!),
      );

    if (!resolvedProvider) {
      throw new Error(
        `Model "${cfg.model}" is not in the catalog. Pass providerId to use an uncatalogued model.`,
      );
    }
    if (!available.has(resolvedProvider)) {
      throw new Error(`Provider "${resolvedProvider}" is not configured.`);
    }
    return {
      provider: resolvedProvider,
      model: cfg.model,
      tier,
      capability,
      reason: "Explicitly selected by the client",
      fallbacks: ranked.filter((m) => m.model !== cfg.model).map(toChoice),
    };
  }

  // 2. Provider pinned but model left to us.
  if (pinned) {
    if (!available.has(pinned)) throw new Error(`Provider "${pinned}" is not configured.`);
    const preferred = ranked.filter((m) => m.provider === pinned);
    const chosen = preferred[0];
    if (chosen) {
      return {
        ...toChoice(chosen),
        tier,
        capability,
        reason: `Fastest ${tier} model for "${capability}" on ${pinned}`,
        fallbacks: [...preferred.slice(1), ...ranked.filter((m) => m.provider !== pinned)].map(toChoice),
      };
    }
    return {
      provider: pinned,
      model: aiService.defaultToolModel(pinned),
      tier,
      capability,
      reason: `Provider default for ${pinned}`,
      fallbacks: ranked.map(toChoice),
    };
  }

  // 3. Fully automatic.
  const override = envOverride(tier);
  if (override && available.has(override.provider)) {
    return {
      ...override,
      tier,
      capability,
      reason: `Environment override for the ${tier} tier`,
      fallbacks: ranked.filter((m) => m.model !== override.model).map(toChoice),
    };
  }

  const [chosen, ...rest] = ranked;
  if (!chosen) {
    const provider = [...available][0];
    return {
      provider,
      model: aiService.defaultToolModel(provider),
      tier,
      capability,
      reason: "No catalog entry matched; using the provider default",
      fallbacks: [],
    };
  }

  return {
    ...toChoice(chosen),
    tier,
    capability,
    reason: `Auto: fastest ${tier}-tier model for "${capability}" (${chosen.latencyMs}ms measured)`,
    fallbacks: rest.map(toChoice),
  };
}
