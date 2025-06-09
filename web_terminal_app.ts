// -----------------------------
// 📁 Backend: Express + TypeScript + Redis + socket.io + ssh2 (resumable sessions)
// -----------------------------

// 📄 server.ts
import express from 'express';
import http from 'http';
import { Server } from 'socket.io';
import { createClient } from 'redis';
import { createAdapter } from '@socket.io/redis-adapter';
import { Client as SSHClient } from 'ssh2';
import cors from 'cors';
import { v4 as uuidv4 } from 'uuid';

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const pubClient = createClient({ url: 'redis://localhost:6379' });
const subClient = pubClient.duplicate();
await pubClient.connect();
await subClient.connect();
io.adapter(createAdapter(pubClient, subClient));
console.log('🔌 Redis adapter connected and attached to socket.io');

const redisClient = createClient();
await redisClient.connect();

interface SessionMeta {
  host: string;
  port: number;
  username: string;
  password?: string;
  privateKey?: string;
  localName: string;
}

const sshSessions: Map<string, SSHClient> = new Map();

app.use(cors());
app.use(express.json());

io.on('connection', async (socket) => {
  const sessionId = socket.handshake.query.sessionId as string;
  console.log(`🔌 Client connected: ${sessionId}`);

  const resume = async () => {
    const metaJson = await redisClient.get(`session:${sessionId}:meta`);
    if (!metaJson) return false;

    const meta = JSON.parse(metaJson) as SessionMeta;
    console.log(`♻️ Resuming session for ${sessionId} with`, meta);

    const ssh = new SSHClient();

    ssh.on('ready', () => {
      console.log(`✅ SSH Ready (Resumed): ${sessionId}`);
      ssh.shell((err, stream) => {
        if (err) return socket.emit('error', err.message);

        stream.on('data', (data) => socket.emit('output', data.toString()));
        socket.on('input', (msg) => stream.write(msg));
        socket.on('disconnect', () => ssh.end());
      });
    });

    ssh.on('error', (err) => console.error(`⚠️ Resume Error [${sessionId}]`, err));
    ssh.connect({
      host: meta.host,
      port: meta.port,
      username: meta.username,
      ...(meta.privateKey ? { privateKey: meta.privateKey } : {}),
      ...(meta.password ? { password: meta.password } : {})
    });

    sshSessions.set(sessionId, ssh);
    return true;
  };

  const success = await resume();
  if (!success) {
    console.log(`⚠️ No resumable session for: ${sessionId}`);
    socket.emit('needs-auth');
  }

  socket.on('start-session', async (data: SessionMeta) => {
    console.log(`✨ Starting new session: ${sessionId}`);
    const ssh = new SSHClient();

    ssh.on('ready', () => {
      console.log(`✅ SSH Ready: ${sessionId}`);
      ssh.shell((err, stream) => {
        if (err) return socket.emit('error', err.message);

        stream.on('data', (data) => socket.emit('output', data.toString()));
        socket.on('input', (msg) => stream.write(msg));
        socket.on('disconnect', () => ssh.end());
      });
    });

    ssh.on('error', (err) => console.error(`⚠️ SSH Error [${sessionId}]`, err));

    ssh.connect({
      host: data.host,
      port: data.port,
      username: data.username,
      ...(data.privateKey ? { privateKey: data.privateKey } : {}),
      ...(data.password ? { password: data.password } : {})
    });

    sshSessions.set(sessionId, ssh);
    await redisClient.set(`session:${sessionId}:meta`, JSON.stringify(data), { EX: 3600 });
  });

  socket.on('disconnect', () => {
    const ssh = sshSessions.get(sessionId);
    if (ssh) ssh.end();
    sshSessions.delete(sessionId);
    console.log(`❌ Disconnected: ${sessionId}`);
  });
});

server.listen(4000, () => console.log('🚀 Server running on port 4000'));


// -----------------------------
// 📁 Frontend: React + Vite + xterm.js + socket.io-client
// -----------------------------

// 📄 main.tsx
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);


// 📄 App.tsx
import React, { useState } from 'react';
import TerminalTab from './TerminalTab';
import { v4 as uuidv4 } from 'uuid';

export default function App() {
  const [tabs, setTabs] = useState<string[]>([]);

  const addTab = () => {
    const id = uuidv4();
    console.log(`➕ New tab created: ${id}`);
    setTabs((prev) => [...prev, id]);
  };

  return (
    <div>
      <button onClick={addTab}>+ New Tab</button>
      <div style={{ display: 'flex' }}>
        {tabs.map((tabId) => (
          <TerminalTab key={tabId} sessionId={tabId} />
        ))}
      </div>
    </div>
  );
}


// 📄 TerminalTab.tsx
import React, { useEffect, useRef, useState } from 'react';
import { io } from 'socket.io-client';
import { Terminal } from 'xterm';
import 'xterm/css/xterm.css';

interface Props {
  sessionId: string;
}

export default function TerminalTab({ sessionId }: Props) {
  const termRef = useRef<HTMLDivElement>(null);
  const socketRef = useRef<any>(null);
  const [connected, setConnected] = useState(false);

  const [formData, setFormData] = useState({
    host: '',
    port: 22,
    username: '',
    password: '',
    privateKey: '',
    localName: ''
  });

  const handleChange = (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    const { name, value } = e.target;
    setFormData((prev) => ({ ...prev, [name]: value }));
  };

  const connect = () => {
    const term = new Terminal();
    term.open(termRef.current!);
    term.write('Connecting...\n');

    const socket = io('http://localhost:4000', {
      query: { sessionId }
    });

    socketRef.current = socket;

    socket.on('output', (data: string) => {
      term.write(data);
    });

    socket.on('needs-auth', () => {
      term.write('Session expired or not resumable. Please reconnect.\r\n');
    });

    term.onData((data) => {
      socket.emit('input', data);
    });

    socket.emit('start-session', formData);
    setConnected(true);
  };

  return (
    <div>
      {!connected && (
        <div>
          <input name="host" placeholder="Host" onChange={handleChange} />
          <input name="port" type="number" value={formData.port} onChange={handleChange} />
          <input name="username" placeholder="Username" onChange={handleChange} />
          <input name="password" type="password" placeholder="Password (optional)" onChange={handleChange} />
          <textarea name="privateKey" placeholder="Private Key (optional)" onChange={handleChange} />
          <input name="localName" placeholder="Local Name (for indexing)" onChange={handleChange} />
          <button onClick={connect}>Connect</button>
        </div>
      )}
      <div ref={termRef} style={{ width: 600, height: 400 }} />
    </div>
  );
}
