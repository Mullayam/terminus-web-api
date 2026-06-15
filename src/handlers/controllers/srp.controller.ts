import type { Request, Response } from "express";
import { srpService } from "@/services/srp";

class SrpController {
  async params(_req: Request, res: Response) {
    res.json({
      status: true,
      message: "SRP params fetched",
      result: srpService.getParams(),
    });
    return;
  }

  async register(req: Request, res: Response) {
    try {
      const { username, password } = req.body as {
        username?: string;
        password?: string;
      };

      if (!username || !password) {
        res.status(400).json({
          status: false,
          message: "username and password are required",
          result: null,
        });
        return;
      }

      const result = srpService.register(username, password);
      res.json({
        status: true,
        message: "SRP registration successful",
        result,
      });
      return;
    } catch (err) {
      res.status(400).json({
        status: false,
        message: err instanceof Error ? err.message : "SRP registration failed",
        result: null,
      });
      return;
    }
  }

  async challenge(req: Request, res: Response) {
    try {
      const { username, clientPublic } = req.body as {
        username?: string;
        clientPublic?: string;
      };

      if (!username || !clientPublic) {
        res.status(400).json({
          status: false,
          message: "username and clientPublic are required",
          result: null,
        });
        return;
      }

      const result = srpService.challenge(username, clientPublic);
      res.json({
        status: true,
        message: "SRP challenge created",
        result,
      });
      return;
    } catch (err) {
      res.status(400).json({
        status: false,
        message: err instanceof Error ? err.message : "SRP challenge failed",
        result: null,
      });
      return;
    }
  }

  async verify(req: Request, res: Response) {
    try {
      const { sessionId, clientProof } = req.body as {
        sessionId?: string;
        clientProof?: string;
      };

      if (!sessionId || !clientProof) {
        res.status(400).json({
          status: false,
          message: "sessionId and clientProof are required",
          result: null,
        });
        return;
      }

      const result = srpService.verify(sessionId, clientProof);
      res.json({
        status: true,
        message: "SRP login successful",
        result,
      });
      return;
    } catch (err) {
      res.status(401).json({
        status: false,
        message: err instanceof Error ? err.message : "SRP verification failed",
        result: null,
      });
      return;
    }
  }
}

export default new SrpController();
