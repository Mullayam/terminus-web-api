import SFTPClient from 'ssh2-sftp-client';
import { Logging } from '@enjoys/express-utils/logger';
const sftp = new SFTPClient();

 class SFTP_Service{
    is_connected = false
     connectSFTP = async (options: SFTPClient.ConnectOptions): Promise<void> => {
        try {
            await sftp.connect(options);
            this.is_connected = true
            Logging.dev('Connected to SFTP server');
        } catch (err) {
            Logging.dev('SFTP Connection Error:' + err, "error");
        }
    };
    getSftpInstance = (): SFTPClient => sftp;
}
export const Sftp_Service =  new SFTP_Service()
