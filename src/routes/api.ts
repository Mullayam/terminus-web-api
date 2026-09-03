import { Router } from "express";
import {
  Authentication,
  TerminalSession,
  SFTP,
  AiController,
  AgentController,
  CodeiumController,
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
router.post("/upload/status", SFTP.default.handleUploadStatus);
router.post("/upload/chunk", SFTP.default.handleUploadChunk);
router.post("/upload/abort", SFTP.default.handleUploadAbort);
router.post("/download", SFTP.default.handleDownload);
router.post("/file/read", SFTP.default.handleFileRead);
router.post("/file/write", SFTP.default.handleFileWrite);
router.post("/files", SFTP.default.handleLoadFilesAndDir);

// AI
router.get("/ai/providers", AiController.default.providers); 
router.get("/ai/quota", AiController.default.quotaStatus);
router.post("/complete", AiController.default.generate);
router.post("/completions", AiController.default.completions);
router.post("/hover", AiController.default.hover);
router.post("/stream", AiController.default.stream);
router.post("/chat", AiController.default.chat);
router.post("/chat/ai", AiController.default.chatWithAI);

// Agent
router.get("/agent/profiles", AgentController.default.profiles);
router.get("/agent/models", AgentController.default.models);
router.post("/agent/run", AgentController.default.run);
router.post("/agent/result", AgentController.default.result);

// Codeium inline completions
router.post("/codeium/complete", CodeiumController.default.complete);
router.post("/codeium/accept", CodeiumController.default.accept);
router.get("/codeium/auth/url", CodeiumController.default.authUrl);
router.get("/codeium/auth/status", CodeiumController.default.authStatus);
router.post("/codeium/auth", CodeiumController.default.auth);

export default router;
