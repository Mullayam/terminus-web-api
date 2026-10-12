import type { OpencodeClient } from "@opencode-ai/sdk";
import { Logging } from "@enjoys/express-utils/logger";
import { __CONFIG__ } from "@/utils/constant";
import { buildOpencodeConfig } from "./config";

interface OpencodeInstance {
  client: OpencodeClient;
  close: () => void;
}

let instance: OpencodeInstance | null = null;
let pending: Promise<OpencodeClient> | null = null;

async function start(mcpUrl: string): Promise<OpencodeClient> {
  const sdk = await import("@opencode-ai/sdk");

  if (__CONFIG__.OPENCODE_BASE_URL) {
    const client = sdk.createOpencodeClient({ baseUrl: __CONFIG__.OPENCODE_BASE_URL });
    instance = { client, close: () => {} };
    Logging.dev(`Connected to external opencode server: ${__CONFIG__.OPENCODE_BASE_URL}`);
    return client;
  }

  const { client, server } = await sdk.createOpencode({ config: buildOpencodeConfig(mcpUrl) });
  instance = { client, close: () => server.close() };
  Logging.dev(`Spawned opencode server: ${server.url}`);
  return client;
}

export async function getOpencodeClient(mcpUrl: string): Promise<OpencodeClient> {
  if (instance) return instance.client;
  if (!pending) {
    pending = start(mcpUrl).finally(() => {
      pending = null;
    });
  }
  return pending;
}

export function closeOpencode(): void {
  instance?.close();
  instance = null;
}
