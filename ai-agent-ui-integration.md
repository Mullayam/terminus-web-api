# AI Agent — UI Integration Guide

How to wire the AI Agent harness into the frontend: which transport to use, the
events, the confirmation flow, and the exact sequence you get back for real prompts.

---

## 1. Transport: Socket.IO, not SSE

The agent is **real-time and bidirectional** (it streams progress *and* has to ask you
to confirm dangerous commands mid-run), so it runs over a **Socket.IO namespace**, not SSE.

| Use case | Transport | Where |
|----------|-----------|-------|
| **Agent** (run tasks, execute commands, confirmations) | Socket.IO namespace `/ai-agent` | this guide |
| Plain one-shot AI chat / completion | HTTP SSE | `POST /api/stream`, `/api/chat` (separate, not the agent) |

> SSE is one-directional (server → client), so it can't carry the `approve/deny` reply the
> agent needs for dangerous commands. Use the socket for anything agentic.

Connect to the namespace (no handshake query required — session is passed per prompt):

```ts
import { io } from "socket.io-client";

const agent = io(`${API_BASE}/ai-agent`, {
  withCredentials: true,
  transports: ["websocket"],
});
```

---

## 2. Event contract

### Client → Server

| Event | Payload | Purpose |
|-------|---------|---------|
| `@@AI_AGENT_PROMPT` | `{ sessionId, prompt, model? }` | Start/continue an agent turn |
| `@@AI_AGENT_CONFIRM_REPLY` | `{ confirmId, approved }` | Answer a dangerous-command prompt |
| `@@AI_AGENT_ABORT` | `{ sessionId }` | **Stop** the current run |

- `sessionId` is **the terminal (SSH) session id** — the same one the live terminal uses.
  The agent operates on that session's real PTY.
- `model` is optional (e.g. `"groq/openai/gpt-oss-120b"`). If omitted, the server uses the
  per-session setting or the configured default.

### Server → Client

| Event | Payload | Purpose |
|-------|---------|---------|
| `@@AI_AGENT_EVENT` | `{ kind, tag, sessionId, payload, ts }` | All streamed progress |
| `@@AI_AGENT_CONFIRM_REQUEST` | `{ confirmId, sessionId, command, reason, level }` | Agent needs a yes/no before running |

`@@AI_AGENT_EVENT.kind` (and its `tag`, which is just `[KIND]`):

| `kind` | `payload` | Render as |
|--------|-----------|-----------|
| `MESSAGE` | `{ text }` | Assistant prose (plan, explanation). Arrives in chunks — append/stream. |
| `COMMAND` | `{ sessionId, command }` | "▶ running `<command>`" chip |
| `EXECUTE_TASK` | `{ sessionId, task }` | A non-command action (e.g. writing a file) |
| `DANGEROUS` | `{ sessionId, command, reason, level }` | Warning banner; a `CONFIRM_REQUEST` follows |
| `OUTPUT` | `{ sessionId, command, output, exitCode, timedOut }` | Captured command output |
| `ERROR` | `{ error }` | Error bubble |
| `DONE` | `{}` or `{ stopped: true }` | Turn finished (`stopped` = user aborted) |

> **The command + its output also appear in your normal xterm stream** (the agent writes
> into the live PTY). So you have two choices for rendering output:
> 1. Let the existing terminal view show it (via `@@SSH_EMIT_DATA` / `@@COLLAB_TERMINAL_OUTPUT`), and use `COMMAND`/`OUTPUT` only for a chat-side transcript, **or**
> 2. Render everything in the chat panel from the agent events.
> Most UIs do both: chip + collapsible output in chat, full stream in the terminal.

---

## 3. Minimal client

```ts
type AgentEvent = {
  kind: "MESSAGE" | "COMMAND" | "EXECUTE_TASK" | "DANGEROUS" | "OUTPUT" | "ERROR" | "DONE";
  tag: string;
  sessionId?: string;
  payload: Record<string, any>;
  ts: number;
};

type ConfirmRequest = {
  confirmId: string;
  sessionId: string;
  command: string;
  reason: string;
  level: "confirm" | "blocked";
};

function sendPrompt(sessionId: string, prompt: string, model?: string) {
  agent.emit("@@AI_AGENT_PROMPT", { sessionId, prompt, model });
}

agent.on("@@AI_AGENT_EVENT", (e: AgentEvent) => {
  switch (e.kind) {
    case "MESSAGE":      appendAssistantText(e.payload.text); break;
    case "COMMAND":      addCommandChip(e.payload.command); break;
    case "OUTPUT":       addOutput(e.payload.command, e.payload.output, e.payload.exitCode); break;
    case "EXECUTE_TASK": addTaskChip(e.payload.task); break;
    case "ERROR":        addError(e.payload.error); break;
    case "DONE":         finishTurn(e.payload.stopped === true); break;
  }
});

agent.on("@@AI_AGENT_CONFIRM_REQUEST", (req: ConfirmRequest) => {
  showConfirmDialog(req, (approved) =>
    agent.emit("@@AI_AGENT_CONFIRM_REPLY", { confirmId: req.confirmId, approved }),
  );
});

function stop(sessionId: string) {
  agent.emit("@@AI_AGENT_ABORT", { sessionId });
}
```

---

## 4. The confirmation flow (dangerous commands)

The server classifies every command into three tiers:

| Tier | Examples | Behavior |
|------|----------|----------|
| `blocked` | `rm -rf`, `rm -r`, `find -delete`, `mkfs`, `dd of=/dev/*`, `DROP`/`TRUNCATE`, `git reset --hard`, force push, fork bombs | **Always** asks — never auto-approved, even in auto mode |
| `confirm` | reboot, recursive `chmod`/`chown`, `systemctl stop/disable`, `docker rm/prune`, `kubectl delete`, `terraform destroy`, firewall flush | Asks unless **auto mode** is on |
| `safe` | everything else | Runs immediately |

Sequence when a command needs approval:

```
… → @@AI_AGENT_EVENT { kind:"DANGEROUS", payload:{ command, reason, level } }
  → @@AI_AGENT_CONFIRM_REQUEST { confirmId, command, reason, level }
  → (you) @@AI_AGENT_CONFIRM_REPLY { confirmId, approved: true|false }
     approved  → @@AI_AGENT_EVENT { kind:"COMMAND" } → { kind:"OUTPUT" }
     denied    → agent adapts or stops (no execution)
```

- Style `blocked` red ("destructive — cannot be undone") and `confirm` amber.
- If you don't reply within **120s** the server auto-denies.

---

## 5. Settings & auto mode (HTTP)

```bash
GET  /api/ai/agent/models                 # provider + model catalog, and which are configured
GET  /api/ai/agent/settings?sessionId=ID  # { autoMode, model? }
PUT  /api/ai/agent/settings               # body: { sessionId, autoMode?, model? }
```

```ts
// Turn on auto mode (confirm-tier runs without asking; blocked still asks)
await fetch(`${API_BASE}/api/ai/agent/settings`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ sessionId, autoMode: true }),
});

// Model picker options
const { data } = await (await fetch(`${API_BASE}/api/ai/agent/models`)).json();
// data.providers = full catalog, data.configured = ["groq", ...] that have keys set
```

---

## 6. Expected output — worked examples

### A) "what's on my screen"

This is a **question**, not a task — the agent answers without running anything.

```
→ @@AI_AGENT_PROMPT { sessionId, prompt: "what's on my screen" }
← @@AI_AGENT_EVENT { kind:"MESSAGE", payload:{ text:"You're at a shell prompt in /var/www; the last command was `docker ps` and caddy is running…" } }
← @@AI_AGENT_EVENT { kind:"DONE", payload:{} }
```

> **Important:** the agent does **not** automatically receive your terminal scrollback.
> For pure "read my screen" questions, include the visible buffer in the prompt, e.g.
> `prompt: "What does this mean?\n\n<last 50 lines of terminal>"`. For task prompts the
> agent gathers what it needs by running read-only commands itself.

### B) "stop my container caddy and force recreate"

A **task** — the agent plans, runs commands, and pauses on the destructive one.

```
→ @@AI_AGENT_PROMPT { sessionId, prompt: "stop my container caddy and force recreate" }

← MESSAGE  { text:"Goal: recreate the caddy container.\nPlan:\n1. ⬜ Find the caddy container\n2. ⬜ Recreate it\n3. ⬜ Verify it's up" }
← COMMAND  { command:"docker ps --filter name=caddy --format '{{.Names}}\t{{.Status}}'" }
← OUTPUT   { command:"docker ps …", output:"caddy\tUp 3 hours", exitCode:0 }

← MESSAGE  { text:"Found it. Recreating — this removes and recreates the container." }
← DANGEROUS        { command:"docker rm -f caddy", reason:"Remove Docker resources", level:"confirm" }
← CONFIRM_REQUEST  { confirmId:"c1", command:"docker rm -f caddy", reason:"Remove Docker resources", level:"confirm" }
   → CONFIRM_REPLY { confirmId:"c1", approved:true }
← COMMAND  { command:"docker rm -f caddy" }
← OUTPUT   { command:"docker rm -f caddy", output:"caddy", exitCode:0 }

← COMMAND  { command:"docker compose up -d --force-recreate caddy" }
← OUTPUT   { command:"docker compose up …", output:"… Started", exitCode:0 }

← COMMAND  { command:"docker ps --filter name=caddy --format '{{.Status}}'" }   # verify step
← OUTPUT   { command:"docker ps …", output:"Up 2 seconds", exitCode:0 }
← MESSAGE  { text:"Done. caddy was recreated and is up.\n1. ✅ 2. ✅ 3. ✅ Verified" }
← DONE     { }
```

If **auto mode** is on, the `docker rm -f caddy` step runs without the `CONFIRM_REQUEST`
round-trip (it's `confirm` tier). A `blocked`-tier command (e.g. `rm -rf /data`) would still
pause for confirmation regardless.

---

## 7. UI checklist

- [ ] Connect to `/ai-agent`; only enable the agent when a terminal `sessionId` is live.
- [ ] Send `@@AI_AGENT_PROMPT { sessionId, prompt }` on submit.
- [ ] Stream `MESSAGE` text; render `COMMAND`/`OUTPUT`/`EXECUTE_TASK` as chips.
- [ ] Handle `@@AI_AGENT_CONFIRM_REQUEST` with an approve/deny dialog (color by `level`).
- [ ] A **Stop** button → `@@AI_AGENT_ABORT { sessionId }`; end the turn on `DONE { stopped:true }`.
- [ ] Settings panel: auto-mode toggle + model picker via `/api/ai/agent/*`.
- [ ] For "read my screen" questions, append the visible terminal buffer to the prompt.
- [ ] `ERROR` events → show the message (e.g. "No provider key configured", rate-limit text).
```
