# AI Harness

Agentic AI layer for the terminal platform. An AI agent (opencode) drives the
user's live SSH sessions through a generic, transport-agnostic tool core exposed
over MCP, streaming tagged events back to the xterm UI.

## Layers

```
tools/            Generic tool core (single source of truth)
  definitions.ts  list_sessions, get_session_info, run_command, read_file,
                  write_file, list_dir, stat_path
  danger.ts       dangerous-command classifier
  context.ts      ToolContext / ToolResult / ToolDefinition contracts
  registry.ts     name -> tool lookup
session-registry  sessionId -> { ssh2 Client, PTY stream } bridge to the socket layer
agent-bus         sessionId <-> /ai-agent sockets; emit events + await confirmations
protocol          [COMMAND] [EXECUTE_TASK] [DANGEROUS] [OUTPUT] [MESSAGE] [DONE] [ERROR]
opencode/         spawns opencode (ESM SDK, dynamic import), drives sessions,
                  translates opencode events -> agent-bus
ai-agent-namespace  Socket.IO /ai-agent namespace (prompt in, tagged events out)
```

## Flow

1. UI connects to `/ai-agent`, emits `@@AI_AGENT_PROMPT { sessionId, prompt, model? }`.
2. The harness creates/reuses an opencode session and injects the active terminal
   `sessionId` into the prompt context.
3. opencode reaches the tool core via the remote MCP server at `/mcp`
   (the MCP service lives in `src/services/mcp`).
4. `run_command` classifies the command; dangerous commands emit `[DANGEROUS]` and
   block on `confirm()` until the UI replies `@@AI_AGENT_CONFIRM_REPLY`.
5. Approved commands are written into the live PTY (visible to all collaborators)
   and their output is captured via sentinel markers.
6. Tagged `@@AI_AGENT_EVENT`s stream back to the UI; `[DONE]` ends the turn.

## Runtime requirements

- `opencode` CLI resolvable on PATH (installed as the `opencode-ai` dependency, so
  it resolves under `npm run dev` / `npm run start`). Or set `OPENCODE_BASE_URL` to
  an already-running `opencode serve` instance.
- Provider keys in `.env`: `GROQ_API_KEY`, `OPENROUTER_API_KEY`, `GEMINI_API_KEY`,
  `MISTRAL_API_KEY` (set whichever you use). Optional `OPENCODE_MODEL` to pick the
  default model (e.g. `groq/llama-3.3-70b-versatile`).
