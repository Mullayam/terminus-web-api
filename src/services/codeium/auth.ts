import * as crypto from "crypto";
import { Logging } from "@enjoys/express-utils/logger";
import { store } from "../store";
import { __CONFIG__ } from "../../utils/constant";

/**
 * Codeium authentication and key storage (spec §4).
 *
 * The api_key is a long-lived bearer credential: it is encrypted at rest and
 * never leaves the backend. Keys are held in the persistent KV store (not the
 * TTL cache) so they survive restarts.
 */

/** Persistent, un-expiring store for encrypted keys. */
const keyStore = store.kv<string>("codeium:keys");

/** Fixed slot for the single shared service-account key, when one is registered. */
const SHARED_SLOT = "__shared__";

// ─── Encryption at rest (AES-256-GCM) ─────────────────────────────────────────

/** Derives a stable 32-byte key from the configured secret. */
function encryptionKey(): Buffer {
  return crypto.createHash("sha256").update(__CONFIG__.ENCRYPTION_KEY).digest();
}

/** Serialises as iv:authTag:ciphertext (all hex). */
function encrypt(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", encryptionKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString("hex")}:${tag.toString("hex")}:${enc.toString("hex")}`;
}

function decrypt(payload: string): string {
  const [ivHex, tagHex, dataHex] = payload.split(":");
  if (!ivHex || !tagHex || !dataHex) throw new Error("Malformed encrypted key.");
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    encryptionKey(),
    Buffer.from(ivHex, "hex"),
  );
  decipher.setAuthTag(Buffer.from(tagHex, "hex"));
  return Buffer.concat([
    decipher.update(Buffer.from(dataHex, "hex")),
    decipher.final(),
  ]).toString("utf8");
}

// ─── Registration (§4.1) ──────────────────────────────────────────────────────

/**
 * The page a user opens to obtain the token they paste into /api/codeium/auth
 * (§4.1 step 1). The `vim-show-auth-token` redirect renders the token inline.
 */
export function authorizationUrl(): string {
  const params = [
    ["response_type", "token"],
    ["redirect_uri", "vim-show-auth-token"],
    ["state", "a"],
    ["scope", "openid profile email"],
    ["redirect_parameters_type", "query"],
  ]
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .join("&");
  return `${__CONFIG__.CODEIUM.PROFILE_URL}?${params}`;
}

/**
 * Exchanges the token from Codeium's profile page for a long-lived api_key.
 * Retries up to 3× on failure (§4.1).
 */
export async function registerUser(token: string): Promise<string> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(__CONFIG__.CODEIUM.REGISTER_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ firebase_id_token: token }),
      });

      if (!res.ok) {
        throw new Error(`register_user returned ${res.status} ${res.statusText}`);
      }

      const data = (await res.json()) as { api_key?: string };
      if (!data.api_key) throw new Error("register_user response had no api_key.");
      return data.api_key;
    } catch (err) {
      lastError = err;
      Logging.dev(
        `[codeium] register_user attempt ${attempt}/3 failed: ${(err as Error).message}`,
        "notice",
      );
    }
  }

  throw new Error(
    `Codeium registration failed after 3 attempts: ${(lastError as Error)?.message ?? "unknown"}`,
  );
}

// ─── Key storage ──────────────────────────────────────────────────────────────

/** Persists an encrypted key for a Terminus user (or the shared slot). */
export async function storeKey(user: string, apiKey: string): Promise<void> {
  await keyStore.set(user, encrypt(apiKey));
}

async function readKey(user: string): Promise<string | null> {
  const enc = await keyStore.get(user);
  if (!enc) return null;
  try {
    return decrypt(enc);
  } catch (err) {
    Logging.dev(`[codeium] Failed to decrypt key for ${user}: ${(err as Error).message}`, "error");
    return null;
  }
}

/**
 * Resolves the api_key to use for a request (§8 step 1).
 *
 * Per-user mode looks up the caller's own key; otherwise the shared key is used
 * (env-configured, or one registered into the shared slot). Returns null when
 * no key is available, which the controller turns into a 403.
 */
export async function resolveApiKey(user?: string): Promise<string | null> {
  if (__CONFIG__.CODEIUM.PER_USER_KEYS) {
    if (!user) return null;
    return readKey(user);
  }

  if (__CONFIG__.CODEIUM.SHARED_API_KEY) return __CONFIG__.CODEIUM.SHARED_API_KEY;
  return readKey(SHARED_SLOT);
}

/** Stores a registered shared key when per-user mode is off. */
export async function storeSharedKey(apiKey: string): Promise<void> {
  await storeKey(SHARED_SLOT, apiKey);
}

/** Whether a usable key already exists for the caller (never exposes the key). */
export async function hasApiKey(user?: string): Promise<boolean> {
  return (await resolveApiKey(user)) !== null;
}

/**
 * A key that heartbeat/status can present. Never registers users on its own;
 * returns whatever the shared resolution yields, so supervision works before
 * any user has authenticated.
 */
export async function heartbeatApiKey(): Promise<string | null> {
  if (__CONFIG__.CODEIUM.SHARED_API_KEY) return __CONFIG__.CODEIUM.SHARED_API_KEY;
  return readKey(SHARED_SLOT);
}
