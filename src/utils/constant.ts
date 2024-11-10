const config = {
    NODE_ENV: String(process.env.NODE_ENV),
    PORT: Number(process.env.PORT) || 7145,
    JWT_SECRET: String(process.env.JWT_SECRET),
    REDIS_URL: String(process.env.REDIS_URL),
    ENCRYPTION_KEY: String(process.env.ENCRYPTION_KEY),
    FRONTEND_URL: String(process.env.FRONTEND_URL),
}
export const __CONFIG__ = Object.freeze(config);