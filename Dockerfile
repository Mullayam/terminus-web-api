# RocksDB (via @enjoys/store) ships prebuilt binaries only for
# darwin-x64+arm64, linux-x64 and win32-x64 — there is no musl or linux-arm64
# build. Alpine cannot run this image; build with --platform=linux/amd64.

# ---- Dependencies ----
FROM oven/bun:1 AS deps
WORKDIR /app

COPY bun.lockb package.json ./
RUN bun install --production

# ---- Build ----
FROM oven/bun:1 AS builder
WORKDIR /app

COPY bun.lockb package.json ./
RUN bun install

COPY . .
RUN bun run build

# ---- Production ----
FROM oven/bun:1 AS runner
WORKDIR /app

ENV NODE_ENV=production
# Embedded RocksDB store. Mount a volume here or the completion cache is lost
# on every restart and each cold start pays full model latency.
ENV STORE_PATH=/data/store

COPY --from=deps /app/node_modules ./node_modules
COPY --from=builder /app/build ./build
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/claude-sonet.4.6.txt ./claude-sonet.4.6.txt
COPY --from=builder /app/code-completion.md ./code-completion.md

# Docker seeds a fresh named volume from the image directory, ownership
# included, so chown here is what makes the mount writable for uid 1000.
RUN mkdir -p /data/store && chown -R bun:bun /data /app
VOLUME ["/data"]

USER bun

EXPOSE 7145

CMD ["bun", "build/main.js"]
