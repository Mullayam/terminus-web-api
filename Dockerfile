# ---- Dependencies ----
FROM oven/bun:1-alpine AS deps
WORKDIR /app

COPY bun.lockb package.json ./
RUN bun install --production

# ---- Build ----
FROM oven/bun:1-alpine AS builder
WORKDIR /app

COPY bun.lockb package.json ./
RUN bun install

COPY . .
RUN bun run build

# ---- Production ----
FROM oven/bun:1-alpine AS runner
WORKDIR /app

ENV NODE_ENV=production

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/build ./build
COPY --from=builder /app/package.json ./package.json

EXPOSE 7145

CMD ["bun", "build/main.js"]
