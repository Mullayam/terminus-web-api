import * as fs from "fs";
import * as path from "path";
import * as zlib from "zlib";
import * as crypto from "crypto";
import { Readable } from "stream";
import { pipeline } from "stream/promises";
import { Logging } from "@enjoys/express-utils/logger";
import { __CONFIG__ } from "../../utils/constant";

/**
 * Acquisition of the Codeium `language_server` binary (spec §3.1).
 *
 * download `.gz` → gunzip → `chmod +x` → cache under a version-keyed directory
 * so restarts don't re-download. A pre-baked binary (CODEIUM_BINARY_PATH) skips
 * the download entirely, which is the recommended path for production (§9).
 */

const RELEASE_BASE =
  "https://github.com/Exafunction/codeium/releases/download";

/** Maps the host platform/arch to Codeium's release asset suffix (§3.1). */
function assetSuffix(): string {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === "linux") {
    if (arch === "x64") return "linux_x64";
    if (arch === "arm64") return "linux_arm";
  }
  if (platform === "darwin") {
    if (arch === "x64") return "macos_x64";
    if (arch === "arm64") return "macos_arm";
  }
  if (platform === "win32" && arch === "x64") return "windows_x64.exe";

  throw new Error(`Unsupported platform for Codeium: ${platform}/${arch}`);
}

function executableName(): string {
  return process.platform === "win32" ? "language_server.exe" : "language_server";
}

/** Version-keyed cache path so a version bump lands in its own directory. */
function cachedBinaryPath(version: string): string {
  return path.join(__CONFIG__.CODEIUM.BINARY_DIR, version, executableName());
}

async function verifySha256(filePath: string, expected: string): Promise<void> {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(filePath), hash);
  const actual = hash.digest("hex");
  if (actual !== expected.toLowerCase()) {
    throw new Error(
      `Codeium binary sha256 mismatch: expected ${expected}, got ${actual}`,
    );
  }
}

/**
 * Streams the `.gz` asset straight through gunzip into the cache file, so the
 * ~170 MB decompressed binary never sits in memory as a single buffer.
 */
async function downloadAndExtract(version: string, dest: string): Promise<void> {
  const suffix = assetSuffix();
  const url = `${RELEASE_BASE}/language-server-v${version}/language_server_${suffix}.gz`;

  Logging.dev(`[codeium] Downloading language server ${version} (${suffix})`, "notice");

  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Codeium download failed: ${res.status} ${res.statusText} (${url})`);
  }

  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.download`;

  // Web ReadableStream → Node stream → gunzip → file, without buffering the whole binary.
  await pipeline(
    Readable.fromWeb(res.body as any),
    zlib.createGunzip(),
    fs.createWriteStream(tmp),
  );

  fs.renameSync(tmp, dest);
  Logging.dev(`[codeium] Extracted language server to ${dest}`, "notice");
}

/**
 * Returns a path to a ready-to-run language server, downloading and caching it
 * on first use. Prefers a pre-baked binary when configured.
 */
export async function ensureBinary(): Promise<string> {
  const { VERSION, BINARY_PATH, BINARY_SHA256 } = __CONFIG__.CODEIUM;

  // Pre-baked into the image: use it directly, no download path in startup.
  if (BINARY_PATH) {
    if (!fs.existsSync(BINARY_PATH)) {
      throw new Error(`CODEIUM_BINARY_PATH set but not found: ${BINARY_PATH}`);
    }
    fs.chmodSync(BINARY_PATH, 0o755);
    return BINARY_PATH;
  }

  const dest = cachedBinaryPath(VERSION);
  if (!fs.existsSync(dest)) {
    await downloadAndExtract(VERSION, dest);
    if (BINARY_SHA256) await verifySha256(dest, BINARY_SHA256);
  }

  fs.chmodSync(dest, 0o755);
  return dest;
}
