import { Router } from 'express'
import { Authentication, TerminalSession, SFTP } from '@/handlers/ctrl';


const router = Router();
// Authentication
router.get('/login', Authentication.default.login);
router.get('/register', Authentication.default.register);
router.get('/refresh', Authentication.default.refresh);

//Terminal
router.post('/sessions/create', TerminalSession.default.create);
router.get('/sessions/:id', TerminalSession.default.getSingleSession);
router.put('/sessions/:id/permissions ', TerminalSession.default.updatePermission);
router.delete('/sessions/:id', TerminalSession.default.deleteSession);

// SFTP Operations
router.post('/upload', SFTP.default.handleUpload);
router.post('/download', SFTP.default.handleDownload);





export default router


