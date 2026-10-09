import { randomUUID } from "crypto";
import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { isInitializeRequest } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { Logging } from "@enjoys/express-utils/logger";
import { listTools } from "../ai-harness/tools/registry";
import { AgentBus } from "../ai-harness/agent-bus";

const transports: Record<string, StreamableHTTPServerTransport> = {};

function buildServer(): McpServer {
  const server = new McpServer({ name: "terminus-agent-tools", version: "1.0.0" });

  for (const tool of listTools()) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: tool.inputSchema as z.ZodRawShape,
      },
      async (args: Record<string, any>) => {
        const ctx = AgentBus.contextFor(args?.sessionId);
        try {
          const result = await tool.execute(args ?? {}, ctx);
          return {
            content: [{ type: "text" as const, text: result.content }],
            isError: !result.ok,
          };
        } catch (err: any) {
          return {
            content: [{ type: "text" as const, text: `Tool error: ${err.message}` }],
            isError: true,
          };
        }
      },
    );
  }

  return server;
}

export function createMcpRouter(): express.Router {
  const router = express.Router();
  router.use(express.json());

  router.post("/", async (req, res) => {
    const sid = req.headers["mcp-session-id"] as string | undefined;
    let transport = sid ? transports[sid] : undefined;

    if (!transport && isInitializeRequest(req.body)) {
      transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: (id) => {
          transports[id] = transport!;
        },
      });
      transport.onclose = () => {
        if (transport!.sessionId) delete transports[transport!.sessionId];
      };
      const server = buildServer();
      await server.connect(transport);
    }

    if (!transport) {
      res.status(400).json({
        jsonrpc: "2.0",
        error: { code: -32000, message: "No valid MCP session" },
        id: null,
      });
      return;
    }

    await transport.handleRequest(req, res, req.body);
  });

  const sessionHandler = async (req: express.Request, res: express.Response) => {
    const sid = req.headers["mcp-session-id"] as string | undefined;
    const transport = sid ? transports[sid] : undefined;
    if (!transport) {
      res.status(400).send("Invalid or missing MCP session id");
      return;
    }
    await transport.handleRequest(req, res);
  };

  router.get("/", sessionHandler);
  router.delete("/", sessionHandler);

  Logging.dev("MCP tool server router mounted");
  return router;
}
