import { Router } from "express";
import {
  Authentication,
  TerminalSession,
  SFTP,
  AiController,
} from "@/handlers/ctrl";

const router = Router();
// Authentication
router.post("/login", Authentication.default.login);
router.post("/register", Authentication.default.register);
router.get("/refresh", Authentication.default.refresh);

//Terminal
router.post("/sessions/create", TerminalSession.default.create);
router.get("/sessions/:id", TerminalSession.default.getSingleSession);
router.put(
  "/sessions/:id/permissions",
  TerminalSession.default.updatePermission,
);
router.delete("/sessions/:id", TerminalSession.default.deleteSession);

// SFTP Operations
router.post("/upload", SFTP.default.handleUpload);
router.post("/download", SFTP.default.handleDownload);
router.post("/file/read", SFTP.default.handleFileRead);
router.post("/file/write", SFTP.default.handleFileWrite);

// AI
router.get("/ai/providers", AiController.default.providers);
router.post("/ai/generate", AiController.default.generate);
router.post("/ai/stream", AiController.default.stream);

export default router;
