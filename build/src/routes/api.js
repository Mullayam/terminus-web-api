"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = require("express");
const ctrl_1 = require("@/handlers/ctrl");
const router = (0, express_1.Router)();
// Authentication
router.get('/login', ctrl_1.Authentication.default.login);
router.get('/register', ctrl_1.Authentication.default.register);
router.get('/refresh', ctrl_1.Authentication.default.refresh);
//Terminal 
router.post('/sessions/create', ctrl_1.TerminalSession.default.create);
router.get('/sessions/:id', ctrl_1.TerminalSession.default.getSingleSession);
router.put('/sessions/:id/permissions ', ctrl_1.TerminalSession.default.updatePermission);
router.delete('/sessions/:id', ctrl_1.TerminalSession.default.deleteSession);
// SFTP Operations
router.post('/upload', ctrl_1.SFTP.default.handleUpload);
router.get('/download ', ctrl_1.SFTP.default.handleDownload);
// Key Management
router.post('/keys/create ', ctrl_1.KeyVault.default.create);
router.get('/keys/list ', ctrl_1.KeyVault.default.list);
router.put('/keys/update ', ctrl_1.KeyVault.default.update);
router.delete('/api/keys/delete ', ctrl_1.KeyVault.default.delete);
exports.default = router;
