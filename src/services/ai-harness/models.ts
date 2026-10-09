export type AiProviderId = "groq" | "openrouter" | "nvidia" | "mistral" | "gemini";

export type ModelComplexity = "simple" | "moderate" | "hard";

export type ModelCapability =
  | "general"
  | "linux"
  | "security"
  | "coding"
  | "debugging"
  | "reasoning"
  | "planning"
  | "explanation"
  | "summarization"
  | "long-context";

export interface CatalogModel {
  id: string;
  name: string;
  description: string;
  bestFor: ModelCapability[];
  complexity: ModelComplexity;
  maxTokens: number;
  latencyMs: number;
  free: boolean;
  supportsTools: boolean;
  supportsInline: boolean;
  supportsHover: boolean;
}

export interface CatalogProvider {
  id: AiProviderId;
  name: string;
  icon: string;
  available: boolean;
  supportsTools: boolean;
  supportsInline: boolean;
  supportsHover: boolean;
  models: CatalogModel[];
}

export const MODEL_CATALOG: CatalogProvider[] = [
  {
    id: "groq",
    name: "Groq",
    icon: "groq",
    available: true,
    supportsTools: true,
    supportsInline: true,
    supportsHover: true,
    models: [
      {
        id: "openai/gpt-oss-safeguard-20b",
        name: "GPT-OSS Safeguard 20B (Groq)",
        description:
          "Policy-tuned sibling of the 20B and the fastest model measured. Prefer it for permission, secret, and hardening review, where the answer is a judgement against a rule.",
        bestFor: ["security", "linux"],
        complexity: "simple",
        maxTokens: 131072,
        latencyMs: 213,
        free: true,
        supportsTools: true,
        supportsInline: true,
        supportsHover: false,
      },
      {
        id: "openai/gpt-oss-20b",
        name: "GPT-OSS 20B (Groq)",
        description:
          "Fastest tool-caller available. Use for routine tool selection, short answers, and simple lookups where latency matters more than depth.",
        bestFor: ["general", "linux", "summarization"],
        complexity: "simple",
        maxTokens: 131072,
        latencyMs: 569,
        free: true,
        supportsTools: true,
        supportsInline: true,
        supportsHover: false,
      },
      {
        id: "openai/gpt-oss-120b",
        name: "GPT-OSS 120B (Groq)",
        description:
          "Large model at near-fast latency. The default for planning, diagnosis, and multi-step reasoning.",
        bestFor: ["reasoning", "planning", "linux", "coding", "debugging", "security", "explanation", "general"],
        complexity: "hard",
        maxTokens: 131072,
        latencyMs: 605,
        free: true,
        supportsTools: true,
        supportsInline: true,
        supportsHover: true,
      },
      {
        id: "qwen/qwen3.8-27b",
        name: "Qwen 3.8 27B (Groq)",
        description: "Strong code comprehension and reliable multi-tool batching. Use for repository work, refactors, and test debugging.",
        bestFor: ["coding", "debugging", "reasoning", "explanation"],
        complexity: "hard",
        maxTokens: 131072,
        latencyMs: 572,
        free: true,
        supportsTools: true,
        supportsInline: true,
        supportsHover: true,
      },
      {
        id: "groq/compound-mini",
        name: "Compound Mini (Groq)",
        description: "Groq's agentic system with built-in web search, wrapped as a chat model.",
        bestFor: ["general", "linux", "explanation"],
        complexity: "simple",
        maxTokens: 131072,
        latencyMs: 1058,
        free: true,
        supportsTools: false,
        supportsInline: true,
        supportsHover: true,
      },
      {
        id: "groq/compound",
        name: "Compound (Groq)",
        description: "Larger sibling of Compound Mini, same built-in search.",
        bestFor: ["general", "linux", "reasoning", "explanation"],
        complexity: "moderate",
        maxTokens: 131072,
        latencyMs: 2065,
        free: true,
        supportsTools: false,
        supportsInline: true,
        supportsHover: true,
      },
    ],
  },
  {
    id: "openrouter",
    name: "OpenRouter",
    icon: "openrouter",
    available: true,
    supportsTools: true,
    supportsInline: true,
    supportsHover: true,
    models: [
      {
        id: "liquid/lfm-2.5-2.6b:free",
        name: "LFM 2.5 2.6B (free)",
        description: "Very small and quick, free. Use as a fallback for trivial tool selection when Groq is rate-limited.",
        bestFor: ["general"],
        complexity: "simple",
        maxTokens: 65536,
        latencyMs: 1166,
        free: true,
        supportsTools: true,
        supportsInline: true,
        supportsHover: false,
      },
      {
        id: "nvidia/nemotron-3.5-lightning:free",
        name: "Nemotron 3.5 Lightning (free)",
        description: "Fast with a 1M context window. Use when a large terminal buffer or long log needs to stay in context.",
        bestFor: ["general", "linux", "long-context", "summarization"],
        complexity: "moderate",
        maxTokens: 1000000,
        latencyMs: 1615,
        free: true,
        supportsTools: true,
        supportsInline: true,
        supportsHover: false,
      },
      {
        id: "dots-studio/dots-3-note-preview:free",
        name: "Dots 3 Note Preview (free)",
        description: "Fastest free tool-caller, with a 512K window.",
        bestFor: ["general", "linux", "summarization", "long-context"],
        complexity: "moderate",
        maxTokens: 512000,
        latencyMs: 1586,
        free: true,
        supportsTools: true,
        supportsInline: true,
        supportsHover: false,
      },
      {
        id: "cohere/north-mini-code:free",
        name: "North Mini Code (free)",
        description: "Code-tuned and free. Fallback for repository work when Groq is unavailable.",
        bestFor: ["coding", "debugging"],
        complexity: "moderate",
        maxTokens: 256000,
        latencyMs: 2002,
        free: true,
        supportsTools: true,
        supportsInline: true,
        supportsHover: true,
      },
      {
        id: "minimax/minimax-m3:free",
        name: "MiniMax M3 (free)",
        description: "Good multi-step planner with a 1M context window. Use for deep investigations over large evidence sets.",
        bestFor: ["reasoning", "planning", "debugging", "long-context", "summarization"],
        complexity: "hard",
        maxTokens: 1048576,
        latencyMs: 2617,
        free: true,
        supportsTools: true,
        supportsInline: true,
        supportsHover: false,
      },
      {
        id: "z-ai/glm-5.2:free",
        name: "GLM-5.2 (free)",
        description: "Balanced free reasoning model that batches tool calls well.",
        bestFor: ["reasoning", "coding", "planning", "debugging"],
        complexity: "hard",
        maxTokens: 256000,
        latencyMs: 2971,
        free: true,
        supportsTools: true,
        supportsInline: true,
        supportsHover: false,
      },
      {
        id: "nvidia/nemotron-3-ultra-550b-a55b:free",
        name: "Nemotron 3 Ultra 550B (free)",
        description: "Largest free reasoning model, 1M context. Use for the hardest analysis when latency is acceptable.",
        bestFor: ["reasoning", "planning", "security", "long-context"],
        complexity: "hard",
        maxTokens: 1000000,
        latencyMs: 3920,
        free: true,
        supportsTools: true,
        supportsInline: true,
        supportsHover: false,
      },
      {
        id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free",
        name: "Nemotron 3 Nano Omni 30B Reasoning (free)",
        description: "Small free reasoning model with a 256K window.",
        bestFor: ["reasoning", "debugging"],
        complexity: "moderate",
        maxTokens: 256000,
        latencyMs: 4961,
        free: true,
        supportsTools: true,
        supportsInline: true,
        supportsHover: false,
      },
      {
        id: "nvidia/nemotron-3-super-120b-a12b:free",
        name: "Nemotron 3 Super 120B (free)",
        description: "Free mid-large reasoning model.",
        bestFor: ["reasoning", "explanation"],
        complexity: "moderate",
        maxTokens: 262144,
        latencyMs: 5400,
        free: true,
        supportsTools: true,
        supportsInline: true,
        supportsHover: false,
      },
    ],
  },
  {
    id: "nvidia",
    name: "NVIDIA NIM",
    icon: "nvidia",
    available: true,
    supportsTools: true,
    supportsInline: false,
    supportsHover: false,
    models: [
      {
        id: "openai/gpt-oss-20b",
        name: "GPT-OSS 20B (NVIDIA)",
        description: "Same weights as the Groq entry but ~4x slower. Last-resort fallback when both Groq and OpenRouter fail.",
        bestFor: ["general"],
        complexity: "simple",
        maxTokens: 131072,
        latencyMs: 2467,
        free: false,
        supportsTools: true,
        supportsInline: false,
        supportsHover: false,
      },
      {
        id: "nvidia/nemotron-3-nano-30b-a3b",
        name: "Nemotron 3 Nano 30B (NVIDIA)",
        description: "Answers in prose rather than calling tools, but keeps a 1M window and stays terse.",
        bestFor: ["general", "linux", "long-context", "summarization"],
        complexity: "simple",
        maxTokens: 1000000,
        latencyMs: 1535,
        free: false,
        supportsTools: false,
        supportsInline: false,
        supportsHover: false,
      },
    ],
  },
  {
    id: "mistral",
    name: "Mistral AI",
    icon: "mistral",
    available: true,
    supportsTools: true,
    supportsInline: true,
    supportsHover: true,
    models: [
      {
        id: "mistral-small-latest",
        name: "Mistral Small",
        description: "Quick general-purpose chat and completion model.",
        bestFor: ["general", "coding", "explanation"],
        complexity: "simple",
        maxTokens: 262144,
        latencyMs: 740,
        free: false,
        supportsTools: true,
        supportsInline: true,
        supportsHover: true,
      },
      {
        id: "codestral-latest",
        name: "Codestral",
        description: "Code-tuned and the fastest Mistral entry.",
        bestFor: ["coding", "debugging", "explanation"],
        complexity: "moderate",
        maxTokens: 256000,
        latencyMs: 583,
        free: false,
        supportsTools: true,
        supportsInline: true,
        supportsHover: true,
      },
      {
        id: "mistral-code-fim-latest",
        name: "Mistral Code FIM",
        description: "Fill-in-middle variant for insertion between existing code.",
        bestFor: ["coding"],
        complexity: "moderate",
        maxTokens: 256000,
        latencyMs: 740,
        free: false,
        supportsTools: true,
        supportsInline: true,
        supportsHover: true,
      },
      {
        id: "ministral-3b-latest",
        name: "Ministral 3B",
        description: "Smallest and quickest Mistral model.",
        bestFor: ["general"],
        complexity: "simple",
        maxTokens: 131072,
        latencyMs: 519,
        free: false,
        supportsTools: true,
        supportsInline: true,
        supportsHover: false,
      },
      {
        id: "magistral-small-latest",
        name: "Magistral Small",
        description: "Reasoning-tuned with a 262k window.",
        bestFor: ["reasoning", "planning", "explanation", "long-context"],
        complexity: "hard",
        maxTokens: 262144,
        latencyMs: 709,
        free: false,
        supportsTools: true,
        supportsInline: true,
        supportsHover: true,
      },
    ],
  },
  {
    id: "gemini",
    name: "Google Gemini",
    icon: "gemini",
    available: true,
    supportsTools: false,
    supportsInline: true,
    supportsHover: true,
    models: [
      {
        id: "gemini-2.5-flash",
        name: "Gemini 2.5 Flash",
        description: "Google's fast model. Strong at explaining code, useful for hover documentation.",
        bestFor: ["general", "reasoning", "explanation", "summarization"],
        complexity: "moderate",
        maxTokens: 1048576,
        latencyMs: 1431,
        free: true,
        supportsTools: false,
        supportsInline: true,
        supportsHover: true,
      },
    ],
  },
];

export function getCatalogProvider(id: AiProviderId): CatalogProvider | undefined {
  return MODEL_CATALOG.find((p) => p.id === id);
}
