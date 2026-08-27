import { createStore } from "@enjoys/store";
import { Logging } from "@enjoys/express-utils/logger";

/**
 * Embedded RocksDB-backed store.
 *
 * `STORE_PATH` must point at a mounted volume in Docker, otherwise the cache is
 * lost on every container restart and every cold start pays full model latency.
 */
const DB_PATH = process.env.STORE_PATH ?? "./.terminus-store";

export const store = createStore({ mode: "embedded", dbPath: DB_PATH });

Logging.dev(`[store] Embedded store at ${DB_PATH}`);

/**
 * Monaco completion items are language-generic — the cursor `range` is injected
 * per request — so they are cached per language and model rather than per
 * keystroke. This turns an 8-28s call into a local read.
 */
export const completionCache = store.cache<any[]>("ai:completions");

/** Completion sets are stable; a day is long enough to survive a deploy cycle. */
export const COMPLETION_TTL_MS = 24 * 60 * 60 * 1000;

export function completionCacheKey(language: string, provider: string, model: string): string {
  return `${language.toLowerCase()}::${provider}/${model}`;
}
