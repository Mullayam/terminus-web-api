import { DefaultEventsMap, Server } from "socket.io";
import type { Server as HttpServer } from 'http'
import { Logging } from '@enjoys/express-utils/logger';
import { SocketListener } from "./listener";
import { createAdapter } from '@socket.io/redis-adapter';
import { createClient } from 'redis';

let socketIo: Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, any>;


export const InitSocketConnection = async (server: HttpServer) => {
  Logging.dev("Socket are Initialized")
  const io = new Server(server, {
    connectTimeout: 3000,
    cors: {
      origin: "*",
      // origin: process.env.NODE_ENV === 'development' ? process.env.REACT_APP_URL : "*",
    }
  })
  const pubClient = createClient({ url: 'redis://localhost:6379' });
  const subClient = pubClient.duplicate();
  await pubClient.connect();
  await subClient.connect();
  io.adapter(createAdapter(pubClient, subClient));
  console.log('🔌 Redis adapter connected and attached to socket.io');

  const redisClient = createClient();
  await redisClient.connect();

  io.on('connection', (socket) => {
    const listner = new SocketListener(
      redisClient as any,
      pubClient as any,
      subClient as any,
      io,
    )

    listner.onConnection(socket)
  })

  socketIo = io
  return io
};

export const getSocketIo = () => socketIo
