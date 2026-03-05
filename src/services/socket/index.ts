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
 

let socketIo: Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, any>;

export const InitSocketConnection = async (server: HttpServer) => {
  Logging.dev("Socket are Initialized");
  const io = new Server(server, {
    connectTimeout: 3000,
    cors: {
      origin: "*",
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

  listner.on("shell-ready", ({ sessionId, stream, socket: adminSocket }) => {
    collab.createSession(sessionId, adminSocket.id);
    collab.bindStream(sessionId, stream);

    // Clean up collab state when the PTY stream closes
    stream.on("close", () => {
      collab.destroySession(sessionId);
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
  socketIo = io;
  return io;
};

export const getSocketIo = () => socketIo;
