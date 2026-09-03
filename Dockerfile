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

# ---- Codeium language server (baked in, linux/amd64) ----
# Fetched at build time so there is no ~170 MB download in the startup path (§9).
# Pinned version — only the 1.x line is verified against the proxy. Remove this
# stage (and the COPY/ENV below) if the Codeium feature is not used.
FROM debian:bookworm-slim AS codeium
ARG CODEIUM_VERSION=1.20.8
ADD https://github.com/Exafunction/codeium/releases/download/language-server-v${CODEIUM_VERSION}/language_server_linux_x64.gz /tmp/ls.gz
RUN gunzip /tmp/ls.gz && chmod +x /tmp/ls

# ---- Production ----
FROM oven/bun:1 AS runner
WORKDIR /app

ENV NODE_ENV=production
# Embedded RocksDB store. Mount a volume here or the completion cache is lost
# on every restart and each cold start pays full model latency.
ENV STORE_PATH=/data/store
# SFTP staging (uploads/downloads/zips). Must be writable by USER bun; /app is
# root-owned so this lives on the mounted /data volume, not the image.
ENV STORAGE_PATH=/data/storage

COPY --from=deps --chown=bun:bun /app/node_modules ./node_modules
COPY --from=builder --chown=bun:bun /app/build ./build
COPY --from=builder --chown=bun:bun /app/package.json ./package.json
COPY --from=builder --chown=bun:bun /app/claude-sonet.4.6.txt ./claude-sonet.4.6.txt
COPY --from=builder --chown=bun:bun /app/code-completion.md ./code-completion.md

# Baked language server; CODEIUM_BINARY_PATH makes the app skip the boot download.
COPY --from=codeium --chown=bun:bun /tmp/ls /app/codeium/language_server
ENV CODEIUM_BINARY_PATH=/app/codeium/language_server

# Ownership is set at COPY time above, so only /data needs a chown here — a
# recursive chown of /app would duplicate node_modules + the binary in a new layer.
# The app creates STORAGE_PATH (/data/storage) itself at boot; /data is bun-owned
# so that mkdir succeeds (unlike /app, which is root-owned).
RUN mkdir -p /data/store && chown -R bun:bun /data
VOLUME ["/data"]

USER bun

EXPOSE 7145

CMD ["bun", "build/main.js"]
