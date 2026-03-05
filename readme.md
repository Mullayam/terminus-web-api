
# Terminal Collaboration Platform - Backend

A secure, real-time terminal collaboration platform enabling shared SFTP sessions, multi-user terminal access, and AI-assisted development.

![Build Status](https://img.shields.io/badge/build-passing-brightgreen)
![License](https://img.shields.io/badge/license-MIT-blue)
![Version](https://img.shields.io/badge/version-1.0.0-orange)

## 🚀 Features

- **Live Terminal Sharing**
  - Real-time terminal session collaboration
  - Multiple user support with concurrent access
  - Role-based permissions (read/write/admin)
  - Session recording and playback

- **Secure SFTP Integration**
  - Web-based SFTP client
  - File system operations with live updates
  - Multi-user file access control
  - Transfer progress monitoring

- **AI Development Assistant**
  - Context-aware code suggestions
  - Command history analysis
  - Error detection and resolution
  - Best practices recommendations

- **Key Vault Management**
  - Secure credential storage
  - SSH key management
  - Access token handling
  - Encryption at rest

## 🛠 Technology Stack

- **Core:**
  - Node.js / Express.js
  - WebSocket (Socket.io)
  - Redis for session management

- **Security:**
  - JWT authentication
  - SSH key encryption
  - HTTPS/WSS protocols
  - Rate limiting

- **Terminal:**
  - SSH2 for SFTP operations
  - xterm.js compatibility

## 📋 Prerequisites

```bash
Node.js >= 18.x
Redis >= 6.x
Python >= 3.8 (for AI components)
```

## 🔧 Installation

1. Clone the repository:
```bash
git clone https://github.com/Mullayam/terminus-web
cd terminus-web
```

2. Install dependencies:
```bash
npm install
```

3. Set up environment variables:
```bash
cp .env.example .env
# Edit .env with your configuration
```

4. Start the server:
```bash
npm run dev     # Development
npm run start   # Production
```

## ⚙️ Configuration

The platform can be configured through environment variables:

```env
# Server Configuration
PORT=7145
NODE_ENV=development

# Database
REDIS_URL=""

# Security
JWT_SECRET=your_jwt_secret
ENCRYPTION_KEY=your_encryption_key
FRONTEND_URL=http://localhost:5173
```

## 🔐 Security Considerations

- All sessions are encrypted end-to-end
- Credentials are never stored in plaintext
- Regular security audits are performed
- Rate limiting prevents abuse
- Session timeouts are enforced
- Access logs are maintained

## 🌐 API Documentation




### SFTP Operations

```bash
POST /api/sftp/upload
GET /api/sftp/download 
```

## LOCAL TERMINAL SOCKET EVENTS
 - `@@SSH_EMIT_RESIZE` : When is Resize the xTerm
 - `@@SEND_COMMAND` :  Use in `term.write()` function to send command to Backend to write cmd to PTY.
 - `@@RECIEVE_COMMAND` : Use in `term.onData()` or  `term.data()` to recive the output from Backend.

---

## Collaborative Terminal — Architecture

### The Problem: Race Conditions in Shared PTY

When multiple users share a single SSH shell (PTY), two race conditions emerge:

1. **Keystroke interleaving** — Two users typing simultaneously produce garbled input.  
   Example: User A types `ls -la` while User B types `pwd` → the PTY receives `lpws -dla`.

2. **Registration timing** — Event listeners were bound only when `sessionId` existed in the
   socket handshake query. If a user was kicked and reconnected on a fresh socket (no query
   param), the `COLLAB_JOIN_TERMINAL` listener was never attached → "session not found" on
   rejoin.

### How It's Solved

#### 1. Permission-Gated Writes (`400` / `700` / `777`)

Every socket gets a permission level that controls PTY access:

| Permission | Name       | Can Read Output | Can Write to PTY | Subject to Lock |
|------------|------------|:---------------:|:-----------------:|:---------------:|
| `400`      | Read-only  | ✅              | ❌                | N/A             |
| `700`      | Write      | ✅              | ✅                | ✅              |
| `777`      | Admin      | ✅              | ✅                | ❌ (immune)     |

- New joiners default to `400` (read-only). The admin must explicitly promote them to `700`.
- Only one socket can be `777` (the session creator). Promotion to `777` is blocked.
- Permission changes take effect immediately — if a `700` user is downgraded to `400` while
  holding the auto-lock, the lock is released instantly.

#### 2. Two-Tier Locking (Auto-Lock + Admin Lock)

**Auto-lock** prevents keystroke interleaving between `700` users:

```
User A starts typing
  → Auto-lock acquired by A (broadcast COLLAB_PTY_LOCKED)
  → 4-second TTL timer starts
  → Each subsequent keystroke from A resets the timer
  → User B (700) tries to type → rejected with "locked-auto"
  → User A stops typing → 4s passes → lock released (COLLAB_PTY_UNLOCKED)
  → User B can now type
```

Key behaviors:
- `777` (admin) **bypasses** auto-lock — they can always type, and their typing does **not**
  create an auto-lock.
- `400` users are rejected before the lock is even checked (read-only).
- Only one auto-lock exists per session. It's purely in-memory (`Map<sessionId, LockState>`).

**Admin lock** is a manual override:

```
Admin emits COLLAB_ADMIN_LOCK { sessionId, lock: true }
  → Any existing auto-lock is cleared
  → Admin lock set (no TTL — stays until manually released)
  → All 700 users blocked: "locked-admin"
  → Only admin (777) can type
Admin emits COLLAB_ADMIN_LOCK { sessionId, lock: false }
  → Lock removed, all 700 users can type again
```

#### 3. Payload-Based Handler Registration

The original design bound event listeners per-session:

```ts
// OLD — only ran when sessionId was in handshake query
if (sessionId) collab.register(socket, sessionId);
```

This broke kicked-user rejoin because their new socket had no `sessionId` in the query.

The fix: **register ALL listeners on EVERY socket**, with each handler reading `sessionId`
from its payload at runtime:

```ts
// NEW — runs for every connecting socket
collab.registerAll(socket);

// Inside each handler:
socket.on(COLLAB_JOIN_TERMINAL, (payload: JoinTerminalPayload) => {
    const sessionId = payload.sessionId; // from payload, not closure
    // ...
});
```

A `socketSessions` map (`socketId → Set<sessionId>`) tracks which sessions each socket has
joined. This enables:
- **Input routing** without `sessionId` in every keystroke payload (`findSessionForSocket()`)
- **Disconnect cleanup** that iterates all sessions the socket belonged to
- **Kicked-user rejoin** — their new socket already has all listeners; they just emit
  `COLLAB_JOIN_TERMINAL { sessionId }` again

#### 4. IP-Based Block Enforcement

Blocking operates at the IP level per-session:

```
Admin blocks User B (socketId: "abc123")
  → Resolve IP from B's socket handshake (x-forwarded-for or address)
  → Add IP to session.blockedIPs
  → Remove B from session, force-leave room, notify
  → B reconnects on new socket, emits COLLAB_JOIN_TERMINAL
  → Server checks blockedIPs → IP match → COLLAB_JOIN_REJECTED { reason: "blocked" }
```

Kicked (not blocked) users can rejoin freely. Blocked users are permanently excluded from
that session unless the admin explicitly unblocks their IP via `COLLAB_UNBLOCK_IP`.

### Data Flow Summary

```
┌──────────┐    COLLAB_INPUT     ┌─────────────────────────┐     stream.write()    ┌─────┐
│  Client   │ ──────────────────→│  CollaborativeTerminal  │ ───────────────────→  │ PTY │
│ (socket)  │                    │                         │                       │     │
│           │ ←──────────────────│  1. check permission    │ ←─────────────────── │     │
│           │  COLLAB_INPUT_     │  2. check lock state    │   stream data event   │     │
│           │  REJECTED          │  3. write or reject     │                       │     │
│           │                    │  4. reset auto-lock TTL │                       │     │
│           │ ←──────────────────│                         │                       │     │
│           │  COLLAB_TERMINAL_  │  Redis pub/sub relay    │                       │     │
│           │  OUTPUT            │  (terminal:{sessionId}) │                       │     │
└──────────┘                    └─────────────────────────┘                       └─────┘
```

### Session Lifecycle

```
1. Admin connects → SSH shell opens → createSession(sessionId, adminSocketId)
2. Admin auto-joins collab room, gets "777" permission
3. Joiners emit COLLAB_JOIN_TERMINAL { sessionId }
   → IP block check → join room → default "400" → receive COLLAB_ROOM_STATE
4. Admin promotes joiner to "700" via COLLAB_CHANGE_PERMISSION
5. Active session: auto-lock arbitrates between "700" users
6. Admin disconnects → COLLAB_SESSION_ENDED broadcast → destroySession()
```

---

## 🤝 Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/AmazingFeature`)
3. Commit your changes (`git commit -m 'Add some AmazingFeature'`)
4. Push to the branch (`git push origin feature/AmazingFeature`)
5. Open a Pull Request

## 📝 License

This project is licensed under the MIT License - see the [LICENSE.md](LICENSE.md) file for details.

## 👥 Authors

-  [Mullayam ](https://github.com/Mullayam)


## 🙏 Acknowledgments


- Socket.io team for real-time capabilities
- OpenAI for AI integration support

## 📞 Support

For support, email mullayam06@outlook.com