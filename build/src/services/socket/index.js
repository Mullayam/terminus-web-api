"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.getSocketIo = exports.InitSocketConnection = void 0;
const socket_io_1 = require("socket.io");
const logger_1 = require("@enjoys/express-utils/logger");
const listener_1 = require("./listener");
let socketIo;
const listner = new listener_1.SocketListener();
const InitSocketConnection = (server) => {
    logger_1.Logging.dev("Socket are Initialized");
    const io = new socket_io_1.Server(server, {
        connectTimeout: 3000,
        cors: {
            origin: "*",
            // origin: process.env.NODE_ENV === 'development' ? process.env.REACT_APP_URL : "*",
        }
    });
    // io.use((socket, next) => {
    //   // socket.request.res ? session(socket.request, socket.request.res, next) : next(next); // eslint disable-line
    // })
    io.on('connection', (socket) => {
        listner.onConnection(socket);
        listner.sftpOperation(socket);
    });
    socketIo = io;
    return io;
};
exports.InitSocketConnection = InitSocketConnection;
const getSocketIo = () => socketIo;
exports.getSocketIo = getSocketIo;
