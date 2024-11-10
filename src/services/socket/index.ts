import { DefaultEventsMap, Server } from "socket.io";
import type { Server as HttpServer } from 'http'
import { Logging } from '@enjoys/express-utils/logger';
import { SocketListener } from "./listener";
let socketIo: Server<DefaultEventsMap, DefaultEventsMap, DefaultEventsMap, any>;


const listner = new SocketListener()
export const InitSocketConnection = (server: HttpServer) => {
  Logging.dev("Socket are Initialized")
  const io = new Server(server, {
    connectTimeout: 3000,
    cors: {
      origin: "*",
      // origin: process.env.NODE_ENV === 'development' ? process.env.REACT_APP_URL : "*",
    }
  })
  // io.use((socket, next) => {
  //   // socket.request.res ? session(socket.request, socket.request.res, next) : next(next); // eslint disable-line
  // })

  io.on('connection', (socket) => {
    listner.onConnection(socket)   
  })

  socketIo = io
  return io
};

export const getSocketIo = () => socketIo
