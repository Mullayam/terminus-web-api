"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SocketEventConstants = void 0;
var SocketEventConstants;
(function (SocketEventConstants) {
    SocketEventConstants["ServerClosed"] = "@@ServerClosed";
    SocketEventConstants["SSH_CONNECT"] = "@@SSH_CONNECT";
    SocketEventConstants["SSH_READY"] = "@@SSH_READY";
    SocketEventConstants["SSH_EMIT_INPUT"] = "@@SSH_EMIT_INPUT";
    SocketEventConstants["SSH_EMIT_DATA"] = "@@SSH_EMIT_DATA";
    SocketEventConstants["SSH_EMIT_ERROR"] = "@@SSH_EMIT_ERROR";
    SocketEventConstants["SSH_DISCONNECTED"] = "@@SSH_DISCONNECTED";
    SocketEventConstants["CLIENT_CONNECTED"] = "@@CLIENT_CONNECTED";
    SocketEventConstants["SSH_BANNER"] = "@@SSH_BANNER";
    SocketEventConstants["SSH_TCP_CONNECTION"] = "@@SSH_TCP_CONNECTION";
    SocketEventConstants["SSH_HOST_KEYS"] = "@@SSH_HOST_KEYS";
    // SFTP
    SocketEventConstants["SFTP_GET_FILE"] = "@@SFTP_GET_FILE";
    SocketEventConstants["SFTP_FILES_LIST"] = "@@SFTP_FILES_LIST";
    SocketEventConstants["SFTP_RENAME_FILE"] = "@@SFTP_RENAME_FILE";
    SocketEventConstants["SFTP_MOVE_FILE"] = "@@SFTP_MOVE_FILE";
    SocketEventConstants["SFTP_DELETE_FILE_OR_DIR"] = "@@SFTP_DELETE_FILE_OR_DIR";
    SocketEventConstants["SFTP_COPY_FILE"] = "@@SFTP_COPY_FILE";
    SocketEventConstants["SFTP_CREATE_FILE"] = "@@SFTP_CREATE_FILE";
    SocketEventConstants["SFTP_CREATE_DIR"] = "@@SFTP_CREATE_DIR";
    SocketEventConstants["SUCCESS"] = "@@SUCCESS";
    SocketEventConstants["ERROR"] = "@@ERROR";
})(SocketEventConstants || (exports.SocketEventConstants = SocketEventConstants = {}));
