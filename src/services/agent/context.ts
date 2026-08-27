import type { AiChatMessage } from "../ai";

export interface ContextOptions {
  /** Approximate character budget for the whole message window */
  maxChars?: number;
  /** Always keep this many of the most recent messages verbatim */
  keepRecent?: number;
}

const DEFAULT_MAX_CHARS = 60_000;
const DEFAULT_KEEP_RECENT = 8;

/**
 * Bounded conversation window for the agent loop.
 *
 * Tool output grows without limit across steps, so older observations are
 * collapsed into a compact digest instead of being replayed verbatim.
 */
export class AgentContext {
  private system: AiChatMessage;
  private messages: AiChatMessage[] = [];
  private digest: string[] = [];
  private readonly maxChars: number;
  private readonly keepRecent: number;

  constructor(systemPrompt: string, opts: ContextOptions = {}) {
    this.system = { role: "system", content: systemPrompt };
    this.maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
    this.keepRecent = opts.keepRecent ?? DEFAULT_KEEP_RECENT;
  }

  push(message: AiChatMessage): void {
    this.messages.push(message);
  }

  pushAll(messages: AiChatMessage[]): void {
    this.messages.push(...messages);
  }

  /** Record a durable fact that survives compaction (e.g. discovered environment). */
  remember(fact: string): void {
    if (fact && !this.digest.includes(fact)) this.digest.push(fact);
  }

  private size(msgs: AiChatMessage[]): number {
    return msgs.reduce((n, m) => n + (m.content?.length ?? 0), 0);
  }

  /**
   * Compact old messages once the window exceeds budget. Tool results are the
   * bulk of the payload, so they are summarised to their first lines and a
   * status marker; the assistant/user turns around them are preserved.
   */
  private compact(): void {
    if (this.size(this.messages) <= this.maxChars) return;

    const cutoff = Math.max(0, this.messages.length - this.keepRecent);
    const old = this.messages.slice(0, cutoff);
    const recent = this.messages.slice(cutoff);

    const summarised: string[] = [];
    for (const m of old) {
      if (m.role === "tool") {
        const firstLines = (m.content ?? "").split("\n").slice(0, 3).join(" | ");
        summarised.push(`tool result: ${firstLines.slice(0, 200)}`);
      } else if (m.role === "assistant" && m.tool_calls?.length) {
        summarised.push(
          `ran: ${m.tool_calls.map((c) => c.function.name).join(", ")}`,
        );
      } else if (m.content) {
        summarised.push(`${m.role}: ${m.content.slice(0, 200)}`);
      }
    }

    // A dangling tool message without its parent assistant call is invalid for
    // the OpenAI wire format, so drop leading orphans after the cut.
    while (recent.length && recent[0].role === "tool") recent.shift();

    this.messages = recent;
    if (summarised.length) {
      this.digest.push(...summarised.slice(-30));
    }
  }

  build(): AiChatMessage[] {
    this.compact();

    const out: AiChatMessage[] = [this.system];
    if (this.digest.length) {
      out.push({
        role: "system",
        content:
          "Established facts and earlier steps (condensed, do not repeat this work):\n" +
          this.digest.slice(-40).map((d) => `- ${d}`).join("\n"),
      });
    }
    return out.concat(this.messages);
  }

  get length(): number {
    return this.messages.length;
  }
}
