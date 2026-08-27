# Terminus Agent — Frontend Integration Guide

Everything the UI needs to consume the agent and AI endpoints, and what changes
on your side. All measurements quoted here were taken against live providers.

---

## 1. The one architectural change that matters

**The backend no longer executes commands.** It proposes them; your UI runs them
and posts the output back.

```
UI                          Backend                     Model
 │  POST /api/agent/run        │                          │
 │ ───────────────────────────>│                          │
 │                             │ ────────────────────────>│
 │  <── event: tool_call ──────│ <── tool_calls ──────────│
 │                             │                          │
 │  (user approves)            │  ⏳ waits up to 15s      │
 │  run in terminal            │                          │
 │                             │                          │
 │  POST /api/agent/result ───>│ ────────────────────────>│
 │  <── event: tool_result ────│                          │
 │  <── event: final ──────────│                          │
```

The backend holds the SSE stream open while it waits. If you do not post a
result within `timeoutMs`, the call is recorded as declined and the agent
adapts. **A run stalls if the UI ignores `tool_call`.**

---

## 2. Endpoints

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/agent/run` | Start an agent run (SSE stream) |
| `POST` | `/api/agent/result` | Post the output of a command you executed |
| `GET`  | `/api/agent/profiles` | Profiles, modes, default timeout |
| `GET`  | `/api/agent/models` | Full model catalog with descriptions |
| `GET`  | `/api/ai/providers` | Chat/completion catalog + capability flags |

### `POST /api/agent/run`

```jsonc
{
  "input": "Why is my API returning 502?",
  "profile": "linux",          // linux | coding | reasoning — omitted = inferred
  "mode": "auto",              // auto | fast | thinking
  "providerId": "auto",        // auto | groq | openrouter | nvidia
  "model": "openai/gpt-oss-120b", // optional, must exist in the catalog
  "context": "<terminal buffer>",
  "history": [{ "role": "user", "content": "..." }],
  "maxSteps": 12,              // capped at 25
  "toolTimeoutMs": 15000,      // capped at 20000
  "autoApproveMedium": false,
  "denyDangerous": false,

  // Optional: run several agents concurrently over the same input
  "agents": [
    { "name": "ops",     "profile": "linux",     "mode": "fast" },
    { "name": "analyst", "profile": "reasoning", "mode": "fast" }
  ]
}
```

Validation returns `400` with the valid set for: missing `input`, unknown
`profile`, unknown `mode`, unknown `providerId`, or a `model` not in the catalog
for that provider.

### `POST /api/agent/result`

```jsonc
{
  "callId": "call_abc123",   // from the tool_call event
  "output": "● nginx.service - failed",
  "exitCode": 3,
  "declined": false          // true if the user refused
}
```

`404` means the agent already timed out waiting — drop the result.

---

## 3. SSE events

Every event carries `agent` (the run name) so multi-agent output can be routed
to separate panes.

| Event | Payload | UI treatment |
| --- | --- | --- |
| `status` | `message` | Spinner label — "Analyzing request" |
| `routing` | `provider, model, tier, reason, profile, complexity, capability, signals` | Badge: which model and **why** |
| `plan` | `steps[]` | Checklist, tick off as tools run |
| `chunk` | `text` | Append to the streaming answer |
| `tool_call` | `callId, name, command, purpose, risk, requiresApproval, reason, timeoutMs` | **Execute this** — see below |
| `tool_result` | `callId, name, ok, declined, output` | Collapse under the command |
| `final` | `text` | Replace the streamed text |
| `error` | `message` | Error state |
| `done` | — | Close the stream |

### Handling `tool_call`

```ts
if (evt.type === "tool_call") {
  const approved = evt.requiresApproval
    ? await showApprovalDialog({
        command: evt.command,
        risk: evt.risk,          // safe | medium | dangerous
        reason: evt.reason,      // why it was flagged
        purpose: evt.purpose,    // why the agent wants it
        timeoutMs: evt.timeoutMs // countdown in the dialog
      })
    : true;

  if (!approved) {
    await postResult({ callId: evt.callId, declined: true });
    return;
  }

  const { output, exitCode } = await terminal.run(evt.command);
  await postResult({ callId: evt.callId, output, exitCode });
}
```

**Risk levels.** The backend labels, the UI decides:

| `risk` | Meaning | Suggested UI |
| --- | --- | --- |
| `safe` | Read-only inspection | Run without prompting |
| `medium` | May modify state | Confirm |
| `dangerous` | Destructive / irreversible / secret-reading | Confirm with a clear warning |

`blocked` never reaches you — it is refused server-side and arrives as a
`tool_result` with `declined: true`.

Multiple `tool_call` events can arrive **before** any result. That is
deliberate: independent read-only checks are batched so you can run them in
parallel. Post a result for each `callId`.

---

## 4. Model picker

`GET /api/agent/models` returns every model with a description, capability tags,
**measured** latency, and context window:

```jsonc
{
  "provider": "groq",
  "model": "openai/gpt-oss-120b",
  "label": "GPT-OSS 120B (Groq)",
  "description": "Large model at near-fast latency. The default for planning…",
  "bestFor": ["reasoning", "planning", "linux", "coding"],
  "tiers": ["fast", "thinking"],
  "complexity": "hard",
  "latencyMs": 605,
  "contextWindow": 131072,
  "free": false,
  "supportsTools": true,
  "available": true
}
```

Also returns `capabilities` (label + description per tag, for tooltips) and
`rejected` (models tested and excluded, with reasons — use it to explain gaps
rather than silently hiding them).

`GET /api/ai/providers` additionally exposes per-model **`supportsInline`** and
**`supportsHover`**. Filter your picker by surface:

| Provider | tools | inline | hover |
| --- | --- | --- | --- |
| groq | ✓ | ✓ | partial |
| openrouter | ✓ | ✓ | partial |
| nvidia | ✓ | ✗ | ✗ |
| mistral | ✗ | ✓ | ✓ |
| gemini | ✗ | ✓ | ✓ |

Send `providerId: "auto"` to let the backend classifier choose. It infers a
capability from the request and picks the fastest matching model:

| Request | Routed to | Capability |
| --- | --- | --- |
| "show running docker containers" | `groq/gpt-oss-20b` | linux |
| "refactor this function, fix the test" | `groq/qwen3.8-27b` | coding |
| "compare nginx vs haproxy trade-offs" | `groq/qwen3.8-27b` | reasoning |
| 50KB terminal buffer in `context` | `openrouter/nemotron-3.5-lightning:free` | long-context |

Show `routing.reason` in the UI — it explains the choice in plain English.

---

## 5. Modes and profiles

**Modes** (`mode`):
- `auto` — classifier decides per phase. Only genuinely hard planning and
  observation get the thinking tier; everything else stays fast.
- `fast` — always fast tier. Best for a "quick answer" toggle.
- `thinking` — always thinking tier, and forces an explicit plan first.

**Profiles** (`profile`):

| Profile | Tools | Use for |
| --- | --- | --- |
| `linux` | 10 ops tools | Service failures, containers, resources |
| `coding` | read/write/search/run | Repository work |
| `reasoning` | **none** | Analysis over evidence you already have |

`reasoning` never emits `tool_call` — no execution UI needed for it.

---

## 6. Inline completion and hover

**NVIDIA is rejected on both** (`400` in ~2ms). It measured 2.5s for a tool turn
and 28s for a one-word reply. Filter it out of those pickers using
`supportsInline` / `supportsHover`.

Hover now prefers fast, coding-capable models:

| Selection | Resolved | Latency |
| --- | --- | --- |
| `auto` | `groq/qwen3.8-27b` | 748ms |
| `mistral` | `mistral-small-latest` | 891ms |
| `gemini` | `gemini-2.5-flash` | 2370ms |

### Completions are now cached

`/api/completions` returns an `X-Cache: HIT | MISS` header. Items are cached per
language + model; the cursor `range` is re-applied per request, so a hit is
still correct at any cursor position.

| | Latency |
| --- | --- |
| Cold (`MISS`) | 21.6s |
| Warm (`HIT`) | **30ms** |

Send `"refresh": true` to force regeneration.

**Provider caveat:** Groq cannot serve this endpoint on the free tier — its
8000 TPM limit rejects the large completion prompt with `413`. Use `mistral` or
`gemini` for completions until the Groq plan is upgraded. Hover and agent runs
on Groq are unaffected.

---

## 7. Reference client

```ts
async function runAgent(body: AgentRunBody, onEvent: (e: AgentEvent) => void) {
  const res = await fetch("/api/agent/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let type = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });

    const lines = buf.split("\n");
    buf = lines.pop() ?? "";           // keep the partial line

    for (const line of lines) {
      if (line.startsWith("event:")) type = line.slice(6).trim();
      else if (line.startsWith("data:")) {
        onEvent({ type, ...JSON.parse(line.slice(5).trim()) } as AgentEvent);
      }
    }
  }
}
```

Two things that will bite you:
- **Buffer partial lines.** SSE frames split across chunks; the `buf.pop()` above
  is required.
- **Abort on unmount.** Pass an `AbortSignal`; the backend watches for
  disconnect and stops the run, but only once the socket actually closes.

---

## 8. UI work checklist

- [ ] SSE client with partial-line buffering and abort
- [ ] Execute `tool_call` in the terminal, post to `/api/agent/result`
- [ ] Approval dialog with risk level, reason, purpose, and a countdown
- [ ] Handle several `tool_call` events before any result (parallel batch)
- [ ] Render `plan` as a checklist
- [ ] Model badge showing `routing.model` + `routing.reason`
- [ ] Model picker from `/api/agent/models`, with "Auto" as default
- [ ] Filter inline/hover pickers by `supportsInline` / `supportsHover`
- [ ] Mode toggle: Auto / Fast / Thinking
- [ ] Profile selector: Linux Ops / Coding / Reasoning
- [ ] Multi-agent panes keyed by `agent`
- [ ] Show `X-Cache: HIT` on completions if you surface diagnostics
- [ ] Default completions provider to `mistral` or `gemini`, not `groq`

---

## 9. Not yet implemented

Requested but still outstanding, so do not design around them yet:

- **Per-event usage tokens / timestamp** — events currently carry no `usage` or
  `ts` field.
- **Context-based follow-up suggestions** — no `suggestions` event exists.
