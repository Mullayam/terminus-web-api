import type { Request, Response } from "express";
import { MODEL_CATALOG } from "@/services/ai-harness/models";
import { configuredProviders } from "@/services/ai-harness/opencode/config";
import { AgentSettingsStore } from "@/services/ai-harness/agent-settings";

function models(_req: Request, res: Response) {
  res.json({
    success: true,
    data: { providers: MODEL_CATALOG, configured: configuredProviders() },
  });
}

function getSettings(req: Request, res: Response): void {
  const sessionId = String(req.query.sessionId ?? "");
  if (!sessionId) {
    res.status(400).json({ success: false, message: "sessionId is required" });
    return;
  }
  res.json({ success: true, data: AgentSettingsStore.get(sessionId) });
}

function updateSettings(req: Request, res: Response): void {
  const { sessionId, autoMode, model } = req.body ?? {};
  if (!sessionId || typeof sessionId !== "string") {
    res.status(400).json({ success: false, message: "sessionId is required" });
    return;
  }

  const patch: { autoMode?: boolean; model?: string } = {};
  if (typeof autoMode === "boolean") patch.autoMode = autoMode;
  if (typeof model === "string") patch.model = model;

  res.json({ success: true, data: AgentSettingsStore.set(sessionId, patch) });
}

export default { models, getSettings, updateSettings };
