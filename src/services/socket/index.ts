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
      origin: "*"
    }
  })
  let pubClient = createClient({ url: 'redis://localhost:6379' });
  await pubClient.connect();
  let subClient = pubClient.duplicate();
  await subClient.connect();
  const redisClient = createClient();
  await redisClient.connect();

  io.adapter(createAdapter(pubClient, subClient));
  Logging.dev('🔌 Redis adapter connected and attached to socket.io', "alert");


  const listner = new SocketListener(
    redisClient as any,
    pubClient as any,
    subClient as any,
    io,
  )
  

  io.on('connection', (socket) => {
    listner.onConnection(socket)
  })

  socketIo = io
  return io
};

export const getSocketIo = () => socketIo
