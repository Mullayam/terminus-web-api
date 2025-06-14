export enum SocketEventConstants {
  ServerClosed = "@@ServerClosed",
  Error = "@@Error",

  SESSIONN_END = "@@SESSIONN_END",
  CreateTerminal = "@@Create_Terminal",
  TerminalUrl = "@@Terminal_Url",
  terminal_output = "@@terminal_output",
  terminal_input = "@@terminal_input",
  join_terminal = "@@join_terminal",
  session_not_found = "@@session_not_found",
  session_info = "@@session_info",


  SSH_START_SESSION = "@@SSH_START_SESSION",
  SSH_SESSION = "@@SSH_SESSION",

  SSH_RESUME = "@@SSH_RESUME",
  SSH_CONNECT = "@@SSH_CONNECT",
  SSH_READY = "@@SSH_READY",
  SSH_EMIT_INPUT = "@@SSH_EMIT_INPUT",
  SSH_EMIT_RESIZE = "@@SSH_EMIT_RESIZE",
  SSH_EMIT_DATA = "@@SSH_EMIT_DATA",
  SSH_EMIT_ERROR = "@@SSH_EMIT_ERROR",
  SSH_EMIT_LOGS = "@@SSH_EMIT_LOGS",
  SSH_DISCONNECTED = "@@SSH_DISCONNECTED",
  CLIENT_CONNECTED = "@@CLIENT_CONNECTED",

  SSH_BANNER = "@@SSH_BANNER",
  SSH_TCP_CONNECTION = "@@SSH_TCP_CONNECTION",
  SSH_HOST_KEYS = "@@SSH_HOST_KEYS",
  SSH_PERMISSIONS = "@@SSH_PERMISSIONS",

  // SFTP
  SFTP_CURRENT_PATH = "@@SFTP_CURRENT_PATH",
  SFTP_CONNECT = "@@SFTP_CONNECT",
  SFTP_EMIT_ERROR = "@@SFTP_EMIT_ERROR",
  SFTP_READY = "@@SFTP_READY",
  SFTP_GET_FILE = "@@SFTP_GET_FILE",
  SFTP_FILES_LIST = "@@SFTP_FILES_LIST",
  SFTP_RENAME_FILE = "@@SFTP_RENAME_FILE",
  SFTP_MOVE_FILE = "@@SFTP_MOVE_FILE",
  SFTP_DELETE_DIR = "@@SFTP_DELETE_DIR",
  SFTP_DELETE_FILE = "@@SFTP_DELETE_FILE",
  SFTP_COPY_FILE = "@@SFTP_COPY_FILE",
  SFTP_CREATE_FILE = "@@SFTP_CREATE_FILE",
  SFTP_CREATE_DIR = "@@SFTP_CREATE_DIR",
  SFTP_EXISTS = "@@SFTP_EXISTS",
  SFTP_FILE_STATS = "@@SFTP_FILE_STATS",
  SFTP_ZIP_EXTRACT = "@@SFTP_ZIP_EXTRACT",
  FILE_UPLOADED = "@@FILE_UPLOADED",
  FILE_UPLOADED_PROGRESS = "@@FILE_UPLOADED_PROGRESS",
  SFTP_FILE_DOWNLOAD = "@@FILE_DOWNLOAD",
  DOWNLOAD_PROGRESS = "@@DOWNLOAD_PROGRESS",
  COMPRESSING = "@@COMPRESSING",

  CANCEL_UPLOADING = "@@CANCEL_UPLOADING",
  CANCEL_DOWNLOADING = "@@CANCEL_DOWNLOADING",

  SUCCESS = "@@SUCCESS",
  ERROR = "@@ERROR"

}
