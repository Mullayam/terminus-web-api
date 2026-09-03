const config = {
    NODE_ENV: String(process.env.NODE_ENV),
    PORT: Number(process.env.PORT) || 7145,
    JWT_SECRET: String(process.env.JWT_SECRET),
    REDIS_URL: String(process.env.REDIS_URL),
    ENCRYPTION_KEY: String(process.env.ENCRYPTION_KEY),
    FRONTEND_URL: process.env.FRONTEND_URL
        ? process.env.FRONTEND_URL.split(',').map(u => u.trim()).filter(Boolean)
        : ["*"],
    CODEIUM: {
        /** Master switch. When false the companion never spawns and completions return empty. */
        ENABLED: process.env.CODEIUM_ENABLED === "true",
        /**
         * Pinned language-server release. The 1.x request/response shapes are the only
         * ones verified against this proxy — do not auto-follow `latest`.
         */
        VERSION: process.env.CODEIUM_VERSION ?? "1.20.8",
        API_SERVER_URL: process.env.CODEIUM_API_SERVER_URL ?? "https://server.codeium.com",
        /** Required launch flag — the only way to learn the RPC port. */
        MANAGER_DIR: process.env.CODEIUM_MANAGER_DIR ?? "/tmp/terminus/codeium/manager",
        /** Version-keyed cache so restarts don't re-download the ~170 MB binary. */
        BINARY_DIR: process.env.CODEIUM_BINARY_DIR ?? "/tmp/terminus/codeium/bin",
        /** Set to a pre-baked binary (Docker image) to skip the boot-time download. */
        BINARY_PATH: process.env.CODEIUM_BINARY_PATH || "",
        /** Optional sha256 of the decompressed binary; verified when set. */
        BINARY_SHA256: process.env.CODEIUM_BINARY_SHA256 || "",
        /** Simplest auth: one shared account key for every user. */
        SHARED_API_KEY: process.env.CODEIUM_SHARED_API_KEY || "",
        /** When true, each user brings their own key via /api/codeium/auth. */
        PER_USER_KEYS: process.env.CODEIUM_PER_USER_KEYS === "true",
        /** Codeium's undocumented registration endpoint used by /api/codeium/auth. */
        REGISTER_URL: process.env.CODEIUM_REGISTER_URL ?? "https://api.codeium.com/register_user/",
        /** Page a user opens to copy their auth token (§4.1 step 1). */
        PROFILE_URL: process.env.CODEIUM_PROFILE_URL ?? "https://www.codeium.com/profile",
        /** Reject payloads over this size (§8 step 3). Matches the 400k client cap. */
        MAX_DOCUMENT_CHARS: Number(process.env.CODEIUM_MAX_DOCUMENT_CHARS ?? 400_000),
        /** Per-user in-flight completion cap (§8 step 2). */
        MAX_CONCURRENT_PER_USER: Number(process.env.CODEIUM_MAX_CONCURRENT_PER_USER ?? 4),
        /** Byte-offset range conversion (§6.2) — off until verified against real traffic. */
        ENABLE_RANGE_CONVERSION: process.env.CODEIUM_ENABLE_RANGE_CONVERSION === "true",
    },
    KEEPALIVE: {
        /** Master switch. When false the pinger never starts. Defaults on in production. */
        ENABLED: process.env.KEEPALIVE_ENABLED
            ? process.env.KEEPALIVE_ENABLED === "true"
            : process.env.NODE_ENV === "production",
        /** Render service to keep warm — it spins down after ~15 min of inactivity. */
        URL: process.env.KEEPALIVE_URL ?? "https://monaco-lsp-hub.onrender.com",
        /** Ping cadence in minutes. Keep below 15 so Render never idles out. */
        INTERVAL_MINUTES: Number(process.env.KEEPALIVE_INTERVAL_MINUTES ?? 30),
        /** Abort a hung request so a cold start never stacks pings. */
        TIMEOUT_MS: Number(process.env.KEEPALIVE_TIMEOUT_MS ?? 30_000),
    },
}
export const __CONFIG__ = Object.freeze(config);