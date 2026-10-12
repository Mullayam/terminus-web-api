import type { Config, ProviderConfig } from "@opencode-ai/sdk";
import { __CONFIG__ } from "@/utils/constant";
import { MODEL_CATALOG, type AiProviderId, type CatalogProvider } from "../models";
import { ensureInstructionsFile } from "./system-prompt";

type ProviderRuntime = {
  getKey: () => string | undefined;
  npm?: string;
  baseURL?: string;
};

const PROVIDER_RUNTIME: Record<AiProviderId, ProviderRuntime> = {
  groq: { getKey: () => __CONFIG__.GROQ_API_KEY },
  openrouter: { getKey: () => __CONFIG__.OPENROUTER_API_KEY },
  nvidia: {
    getKey: () => __CONFIG__.NVIDIA_API_KEY,
    npm: "@ai-sdk/openai-compatible",
    baseURL: "https://integrate.api.nvidia.com/v1",
  },
  mistral: {
    getKey: () => __CONFIG__.MISTRAL_API_KEY,
    npm: "@ai-sdk/openai-compatible",
    baseURL: "https://api.mistral.ai/v1",
  },
  gemini: {
    getKey: () => __CONFIG__.GEMINI_API_KEY,
    npm: "@ai-sdk/openai-compatible",
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai",
  },
};

const DEFAULT_PREFERENCES: Array<{ provider: AiProviderId; modelId: string }> = [
  { provider: "openrouter", modelId: "z-ai/glm-5.2:free" },
  { provider: "groq", modelId: "openai/gpt-oss-120b" },
  { provider: "nvidia", modelId: "openai/gpt-oss-20b" },
  { provider: "mistral", modelId: "mistral-small-latest" },
  { provider: "gemini", modelId: "gemini-2.5-flash" },
];

type OpencodeModels = NonNullable<ProviderConfig["models"]>;
type OpencodeModel = OpencodeModels[string];

function buildModels(provider: CatalogProvider): OpencodeModels {
  const models: OpencodeModels = {};
  for (const model of provider.models) {
    const entry: OpencodeModel = {
      id: model.id,
      name: model.name,
      tool_call: model.supportsTools,
      limit: { context: model.maxTokens, output: Math.min(8192, model.maxTokens) },
    };
    models[model.id] = entry;
  }
  return models;
}

function buildProviders(): Record<string, ProviderConfig> {
  const providers: Record<string, ProviderConfig> = {};

  for (const provider of MODEL_CATALOG) {
    const runtime = PROVIDER_RUNTIME[provider.id];
    const apiKey = runtime.getKey();
    if (!apiKey) continue;

    const entry: ProviderConfig = {
      name: provider.name,
      options: { apiKey, ...(runtime.baseURL ? { baseURL: runtime.baseURL } : {}) },
      models: buildModels(provider),
    };
    if (runtime.npm) entry.npm = runtime.npm;

    providers[provider.id] = entry;
  }

  return providers;
}

export function configuredProviders(): AiProviderId[] {
  return MODEL_CATALOG.map((p) => p.id).filter((id) => !!PROVIDER_RUNTIME[id].getKey());
}

export function assertProvidersConfigured(): void {
  if (configuredProviders().length === 0) {
    throw new Error(
      "No AI provider API key configured. Set at least one of GROQ_API_KEY, OPENROUTER_API_KEY, NVIDIA_API_KEY, GEMINI_API_KEY, MISTRAL_API_KEY in .env",
    );
  }
}

function defaultModel(): string {
  if (__CONFIG__.OPENCODE_MODEL) return __CONFIG__.OPENCODE_MODEL;
  for (const pref of DEFAULT_PREFERENCES) {
    if (PROVIDER_RUNTIME[pref.provider].getKey()) {
      return `${pref.provider}/${pref.modelId}`;
    }
  }
  return "groq/openai/gpt-oss-120b";
}

export function buildOpencodeConfig(mcpUrl: string): Config {
  assertProvidersConfigured();
  return {
    model: defaultModel(),
    provider: buildProviders(),
    instructions: [ensureInstructionsFile()],
    mcp: {
      terminus: { type: "remote", url: mcpUrl, enabled: true },
    },
    permission: { bash: "deny", edit: "deny", webfetch: "deny" },
    tools: {
      bash: false,
      edit: false,
      write: false,
      read: false,
      patch: false,
      glob: false,
      grep: false,
      list: false,
      webfetch: false,
      "terminus_*": true,
    },
  };
}
