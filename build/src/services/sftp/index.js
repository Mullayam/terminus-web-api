"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.Sftp_Service = void 0;
const ssh2_sftp_client_1 = __importDefault(require("ssh2-sftp-client"));
const logger_1 = require("@enjoys/express-utils/logger");
const sftp = new ssh2_sftp_client_1.default();
class SFTP_Service {
    constructor() {
        this.connectSFTP = async (options) => {
            try {
                await sftp.connect(options);
                logger_1.Logging.dev('Connected to SFTP server');
            }
            catch (err) {
                logger_1.Logging.dev('SFTP Connection Error:' + err, "error");
            }
        };
        this.getSftpInstance = () => sftp;
    }
}
exports.Sftp_Service = new SFTP_Service();
