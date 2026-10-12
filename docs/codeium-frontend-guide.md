# Codeium Inline Completions — Frontend Integration Guide

This is the **contract the UI must implement** against the Terminus backend.
Everything here is live and verified. There are no frontend source files in this
repo (it is the backend); hand this document to whoever builds the editor UI.

Base URL: the same origin as the rest of the API (e.g. `__config.API_URL`).
All routes below are under `/api/codeium`.

Optional identity: append `?user=base64(hostId)` to any request (same convention
as `/api/chat`). Required only when the backend runs in **per-user key** mode.

The Codeium `api_key` **never reaches the browser**. The UI only ever deals with
the short-lived login *token*, never the key.

---

## 1. Endpoints at a glance

| Method | Path | Purpose |
|---|---|---|
| `GET`  | `/api/codeium/auth/url` | Get the Codeium login page URL |
| `GET`  | `/api/codeium/auth/status` | Is a key configured for this user? |
| `POST` | `/api/codeium/auth` | Exchange a pasted token for an api_key (stored server-side) |
| `POST` | `/api/codeium/complete` | Get completions (JSON or SSE) |
| `POST` | `/api/codeium/accept` | Report an accepted completion (fire-and-forget) |
| `GET`  | `/health` | Companion state + metrics (`result.codeium`) |

---

## 2. Auth UI (the only new UI to build)

The completion provider (ghost text, debounce, accept) already exists. The new
UI is a small **"Connect Codeium"** flow, driven by three calls.

### 2.1 On editor / settings open — check status

```
GET /api/codeium/auth/status?user=<base64 hostId>
→ 200
{
  "enabled": true,        // companion turned on server-side
  "perUser": false,       // true = each user must bring their own key
  "authenticated": true,  // a key is resolvable for this caller
  "required": false       // true = show the connect flow
}
```

- `required: true` → render the **Connect Codeium** card.
- `authenticated: true` → render a **Connected ✓** badge, hide the card.

### 2.2 Connect button — open the login URL

```
GET /api/codeium/auth/url
→ 200
{ "url": "https://www.codeium.com/profile?response_type=token&redirect_uri=vim-show-auth-token&state=a&scope=openid%20profile%20email&redirect_parameters_type=query" }
```

Open `url` in a new tab. The user signs in and lands on a **"Provide
Authentication Token"** page showing a token that **expires in ~5 minutes**.

### 2.3 Token input — submit for exchange

Show a text field ("Paste your token here") and submit:

```
POST /api/codeium/auth?user=<base64 hostId>
Content-Type: application/json
{ "token": "<the token the user pasted>" }

→ 200 { "success": true }         // key registered + stored encrypted
→ 400 { "success": false, "message": "token is required." }
→ 502 { "success": false, "message": "Codeium registration failed …" }  // bad/expired token
```

On `200`, re-call `/auth/status` and flip the UI to **Connected**. Surface the
5-minute expiry near the field so users paste promptly.

> Never store or display an api_key — the backend keeps it encrypted and never
> returns it. The UI only handles the short-lived token.

### 2.4 Suggested component states

```
disconnected  → "Connect Codeium" button        (status.required === true)
awaiting-token→ show URL opened + token input
verifying     → spinner during POST /auth
connected     → "Connected ✓"                    (status.authenticated === true)
error         → show message from 400/502
```

---

## 3. Requesting completions

`POST /api/codeium/complete?user=<base64 hostId>`

### 3.1 Request body

```jsonc
{
  "requestId": 12,                       // monotonic per browser tab
  "document": {
    "filePath": "/srv/app/index.ts",     // remote SFTP path
    "languageId": "typescript",          // Monaco language id
    "text": "<entire buffer>",           // full file, not a window
    "cursorPosition": { "lineNumber": 1, "column": 10 }, // 1-based, UTF-16
    "lineEnding": "\n"                    // "\n" | "\r\n"
  },
  "otherDocuments": [                     // max 3, ≤ 60k chars each
    { "filePath": "…", "languageId": "…", "text": "…" }
  ],
  "editorOptions": { "tabSize": 2, "insertSpaces": true }
}
```

Coordinate rules (do not deviate — off-by-one here corrupts non-ASCII lines):
- `lineNumber` and `column` are **1-based**, `column` counts **UTF-16 code units**
  (Monaco's native `position`). The backend converts to Codeium's byte offsets.
- `text` is the **whole file**, with lines joined by `lineEnding`.
- `otherDocuments` are other open tabs (no cursor). Cap at 3, ≤ 60k chars each.

### 3.2 Response — two modes (content-negotiated)

**A) Default: plain JSON** (send no special `Accept`, or `application/json`):

```jsonc
// HTTP 200, Content-Type: application/json
{
  "completions": [
    {
      "id": "<Codeium completionId>",     // echo verbatim on accept
      "text": "for (let i = 0; i < n; i++) {\n  …\n}",
      "range": {                          // OPTIONAL; omit → insert at cursor
        "startLineNumber": 1, "startColumn": 10,
        "endLineNumber": 1,   "endColumn": 10
      }
    }
  ]
}
```

- `"completions": []` with **200** means "no suggestion". This is normal, not an
  error. Only **non-2xx** should be treated as a failure.
- `range` is **1-based UTF-16 Monaco coords**. When present, replace that range;
  when omitted, insert `text` at the cursor. (Range conversion is currently
  behind a server flag, so most responses omit it.)

**B) SSE stream** (opt-in): send `Accept: text/event-stream` **or** `?stream=1`.

```
// HTTP 200, Content-Type: text/event-stream
event: completion
data: {"id":"…","text":"…","range":{…}}

event: completion
data: {"id":"…","text":"…"}

event: done
data: {"count":2}

// on an error after the stream opened:
event: error
data: {"message":"…"}
```

Consume with `fetch` + a stream reader (EventSource can't POST). One
`completion` event per item, terminated by a single `done` event.

> **Important:** this is **not token-by-token streaming.** Codeium returns each
> completion whole, so a `completion` event carries a full suggestion. SSE here
> just frames the (usually 0–1) items and a `done`. For ghost text, the plain
> JSON mode is simpler and recommended; use SSE only if your pipeline prefers an
> event stream. (Chat endpoints `/api/chat` *are* real token streams — different
> feature.)

### 3.3 Client behavior (already implemented in the plugin — keep it)

- Debounce **120 ms**; fire on keystrokes.
- **Abort** the in-flight request on every new keystroke (`AbortController`).
  The backend forwards the cancel to Codeium automatically.
- Request timeout **10 s**.
- Document cap **400k chars**; 3 other documents at ≤ 60k each.
- Render `text` as Monaco inline (ghost) text; on accept, call `/accept`.

Error/status handling:
- `403` → not authenticated → trigger the auth flow (§2).
- `429` → too many concurrent requests → back off silently.
- `413` → document too large → skip completion for this buffer.
- `200 {completions:[]}` → no suggestion, render nothing (no error).

---

## 4. Reporting an accepted completion

Fire-and-forget when the user accepts ghost text. Improves Codeium's ranking.

```
POST /api/codeium/accept?user=<base64 hostId>
Content-Type: application/json
{ "completionId": "<the id from the completion you accepted>" }

→ 204 No Content   (always; do not treat as failure)
```

Use `keepalive: true` so it survives navigation. Never blocks the editor.

---

## 5. Health / status indicator (optional but recommended)

```
GET /health
→ result.codeium:
{
  "state": { "phase": "ready", "port": 63312 },   // downloading|starting|ready|failed|disabled
  "restarts": 0,
  "metrics": { "requested": 2, "returned": 1, "accepted": 1,
               "cancels": 1, "errors": 0, "latencyP50": 1409, "latencyP95": 1409 }
}
```

Map `state.phase` to a small status dot so a dead language server is not mistaken
for "no suggestions":
`disabled`/`failed` → grey/red, `downloading`/`starting` → amber, `ready` → green.

---

## 6. End-to-end sequence

```
open editor
  └─ GET /auth/status ──► required? ──► show "Connect Codeium"
        user clicks connect
          └─ GET /auth/url ──► open in new tab ──► user copies token
                user pastes token
                  └─ POST /auth {token} ──► 200 success
                        └─ GET /auth/status ──► authenticated ──► "Connected ✓"

typing in editor (debounced 120ms, abort previous)
  └─ POST /complete {document,…}
        ├─ 200 {completions:[{id,text}]} ──► render ghost text
        └─ 200 {completions:[]}          ──► render nothing
              user accepts
                └─ POST /accept {completionId} ──► 204
```

---

## 7. Quick reference — status codes

| Code | `/complete` meaning | UI action |
|---|---|---|
| 200 | completions (possibly empty) | render items or nothing |
| 400 | malformed document | fix request shape |
| 403 | no api_key for this user | start auth flow (§2) |
| 413 | document over 400k | skip this buffer |
| 429 | too many concurrent | back off, retry later |
