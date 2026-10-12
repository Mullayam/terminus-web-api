import { DefaultEventsMap, Server } from "socket.io";
import type { Server as HttpServer } from "http";
import { Logging } from "@enjoys/express-utils/logger";
import { SocketListener } from "./listener";
import { createAdapter } from "@socket.io/redis-adapter";
import { createClient } from "redis";
import { __CONFIG__ } from "@/utils/constant";
import { DedicatedTerminal } from "./dedicated-terminal";
import { LSPNamespace } from "./lsp-namespace";
import { AiNamespace } from "./ai-namespace";
import { SFTPNamespace } from "./sftp-namespace";
import { CollaborativeTerminal } from "./collaborative-terminal";
import { AgentSessionRegistry } from "../ai-harness/session-registry";
import { AgentHarness } from "../ai-harness/opencode/harness";
import { AiAgentNamespace } from "../ai-harness/ai-agent-namespace";


let socketIo: Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, any>;

export const InitSocketConnection = async (server: HttpServer) => {
  Logging.dev("Socket are Initialized");
  const allowedOrigins = __CONFIG__.FRONTEND_URL;
  const io = new Server(server, {
    connectTimeout: 3000,
    cors: {
      origin: (origin: string | undefined, callback: (err: Error | null, allow?: boolean | string) => void) => {
        if (!origin || allowedOrigins.includes(origin)) {
          callback(null, origin || true);
        } else {
          callback(null, false);
        }
      },
    },
  });
  let pubClient = createClient({ url: __CONFIG__.REDIS_URL });
  await pubClient.connect();
  let subClient = pubClient.duplicate();
  await subClient.connect();
  const redisClient = createClient({ url: __CONFIG__.REDIS_URL });
  await redisClient.connect();

  io.adapter(createAdapter(pubClient, subClient));
  Logging.dev("🔌 Redis adapter connected and attached to socket.io", "alert");

  const listner = new SocketListener(
    redisClient as any,
    pubClient as any,
    subClient as any,
    io,
  );

  const collabSubClient = subClient.duplicate();
  await collabSubClient.connect();

  const collab = new CollaborativeTerminal(
    io,
    pubClient as any,
    collabSubClient as any,
  );

  AgentHarness.configure(`http://localhost:${__CONFIG__.PORT}/mcp`);

  listner.on("shell-ready", ({ sessionId, stream, socket: adminSocket, conn }) => {
    collab.createSession(sessionId, adminSocket.id);
    collab.bindStream(sessionId, stream);
    AgentSessionRegistry.register(sessionId, conn, stream);

    // Clean up collab state when the PTY stream closes
    stream.on("close", () => {
      collab.destroySession(sessionId);
      AgentSessionRegistry.unregister(sessionId);
    });
  });

  // Sync SSH_PERMISSIONS into the collaborative session
  listner.on("permission-changed", ({ sessionId, targetSocketId, permission }) => {
    collab.syncPermission(sessionId, targetSocketId, permission);
  });

  io.on("connection", (socket) => {
    listner.onConnection(socket);
    collab.registerAll(socket);
  });
 
  io.of("/dedicated-terminal").on("connection", (socket) => {
    new DedicatedTerminal(socket, redisClient as any);
  });
  io.of("/lsp").on("connection", (socket) => {
    new LSPNamespace(socket);
  });
  io.of("/ai").on("connection", (socket) => {
    new AiNamespace(socket);
  });
  io.of("/sftp").on("connection", (socket) => {
    new SFTPNamespace(socket, redisClient as any);
  });
  io.of("/ai-agent").on("connection", (socket) => {
    new AiAgentNamespace(socket);
  });
  socketIo = io;
  return io;
};

export const getSocketIo = () => socketIo;
