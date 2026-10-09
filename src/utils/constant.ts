const optional = (value?: string): string | undefined => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
};

const asBool = (value?: string): boolean => value?.trim().toLowerCase() === "true";

const config = {
    NODE_ENV: String(process.env.NODE_ENV),
    PORT: Number(process.env.PORT) || 7145,
    JWT_SECRET: String(process.env.JWT_SECRET),
    REDIS_URL: String(process.env.REDIS_URL),
    ENCRYPTION_KEY: String(process.env.ENCRYPTION_KEY),
    FRONTEND_URL: process.env.FRONTEND_URL
        ? process.env.FRONTEND_URL.split(',').map(u => u.trim()).filter(Boolean)
        : ["*"],
    GROQ_API_KEY: optional(process.env.GROQ_API_KEY),
    OPENROUTER_API_KEY: optional(process.env.OPENROUTER_API_KEY),
    NVIDIA_API_KEY: optional(process.env.NVIDIA_API_KEY),
    GEMINI_API_KEY: optional(process.env.GEMINI_API_KEY),
    MISTRAL_API_KEY: optional(process.env.MISTRAL_API_KEY),
    OPENCODE_MODEL: optional(process.env.OPENCODE_MODEL),
    OPENCODE_BASE_URL: optional(process.env.OPENCODE_BASE_URL),
    OPENCODE_FULL_SYSTEM_PROMPT: asBool(process.env.OPENCODE_FULL_SYSTEM_PROMPT),
}
export const __CONFIG__ = Object.freeze(config);
