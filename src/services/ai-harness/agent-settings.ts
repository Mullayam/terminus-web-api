export interface AgentSettings {
  autoMode: boolean;
  model?: string;
}

const DEFAULTS: AgentSettings = { autoMode: false };

class SettingsStore {
  private store = new Map<string, AgentSettings>();

  get(sessionId: string): AgentSettings {
    return { ...DEFAULTS, ...this.store.get(sessionId) };
  }

  set(sessionId: string, patch: Partial<AgentSettings>): AgentSettings {
    const next: AgentSettings = { ...this.get(sessionId), ...patch };
    this.store.set(sessionId, next);
    return next;
  }

  clear(sessionId: string): void {
    this.store.delete(sessionId);
  }
}

export const AgentSettingsStore = new SettingsStore();
