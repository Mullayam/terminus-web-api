import SFTPClient from 'ssh2-sftp-client';
import { Logging } from '@enjoys/express-utils/logger';
const sftp = new SFTPClient();

 class SFTP_Service{
     connectSFTP = async (options: SFTPClient.ConnectOptions): Promise<void> => {
        try {
            await sftp.connect(options);
            Logging.dev('Connected to SFTP server');
        } catch (err) {
            Logging.dev('SFTP Connection Error:' + err, "error");
        }
    };
    getSftpInstance = (): SFTPClient => sftp;
}
export const Sftp_Service =  new SFTP_Service()
