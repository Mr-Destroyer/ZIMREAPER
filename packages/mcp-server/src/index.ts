/**
 * MCP surface: browser tools over stdio (Claude Desktop/Code, Hermes, Codex) and
 * streamable HTTP for remote clients. Tools are thin wrappers over ControlClient.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { randomBytes } from "node:crypto";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { Provider, ProviderConfig, Tool } from "@zimreaper/agent";
import type { ControlClient } from "@zimreaper/core";
import { ZimReaperError } from "@zimreaper/protocol";
import { browserToolDefinitions, browserTools, type BrowserToolOptions } from "./tools.js";

export { browserToolDefinitions, browserTools, zodShapeToJsonSchema } from "./tools.js";
export type { BrowserToolOptions, McpToolDefinition } from "./tools.js";

export interface McpServerOptions {
  client: ControlClient;
  name?: string;
  version?: string;
  /** Emit tool calls + results on stderr for debugging. */
  debug?: boolean;
  /** Provider for browser_task; when omitted, environment configuration is used. */
  provider?: Provider;
  providerConfig?: ProviderConfig;
  taskMaxSteps?: number;
}

export interface RunningMcpServer {
  close(): Promise<void>;
  port?: number;
  /** Present for HTTP mode; the bearer path token protects the MCP endpoint. */
  path?: string;
  url?: string;
}

function log(debug: boolean | undefined, message: string): void {
  if (debug) process.stderr.write(`[zimreaper-mcp] ${message}\n`);
}

function errorResult(err: unknown): CallToolResult {
  const zim = ZimReaperError.from(err);
  return {
    content: [{ type: "text", text: `${zim.code}: ${zim.message}` }],
    structuredContent: {
      error: { code: zim.code, message: zim.message, retryable: zim.retryable },
    },
    isError: true,
  };
}

function successResult(value: unknown): CallToolResult {
  if (typeof value === "string") {
    return { content: [{ type: "text", text: value }] };
  }
  if (typeof value === "object" && value !== null) {
    const record = value as Record<string, unknown>;
    const text = typeof record.text === "string" ? record.text : JSON.stringify(value, null, 2);
    const structuredContent =
      typeof record.structuredContent === "object" &&
      record.structuredContent !== null &&
      !Array.isArray(record.structuredContent)
        ? (record.structuredContent as Record<string, unknown>)
        : undefined;
    return {
      content: [{ type: "text", text }],
      ...(structuredContent ? { structuredContent } : {}),
    };
  }
  return { content: [{ type: "text", text: String(value) }] };
}

export function browserToolsForMcp(client: ControlClient, opts: BrowserToolOptions = {}): Tool[] {
  return browserTools(client, opts);
}

function buildServer(opts: McpServerOptions): McpServer {
  const server = new McpServer({
    name: opts.name ?? "zimreaper",
    version: opts.version ?? "0.1.0",
  });
  const definitions = browserToolDefinitions(opts.client, {
    ...(opts.provider ? { provider: opts.provider } : {}),
    ...(opts.providerConfig ? { providerConfig: opts.providerConfig } : {}),
    ...(opts.taskMaxSteps ? { taskMaxSteps: opts.taskMaxSteps } : {}),
  });

  for (const def of definitions) {
    server.registerTool(
      def.name,
      {
        description: def.description,
        inputSchema: def.shape,
        annotations: { readOnlyHint: !def.mutates },
      },
      async (args: Record<string, unknown>): Promise<CallToolResult> => {
        const started = Date.now();
        log(opts.debug, `${def.name} ${JSON.stringify(args)}`);
        try {
          const result = await def.run(args);
          log(opts.debug, `${def.name} ok ${Date.now() - started}ms`);
          return successResult(result);
        } catch (err) {
          const zim = ZimReaperError.from(err);
          log(opts.debug, `${def.name} ${zim.code}: ${zim.message}`);
          return errorResult(zim);
        }
      },
    );
  }
  return server;
}

export async function runStdio(opts: McpServerOptions): Promise<RunningMcpServer> {
  const server = buildServer(opts);
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return {
    async close() {
      await server.close();
    },
  };
}

function randomToken(): string {
  return randomBytes(24).toString("hex");
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)));
  }
  if (chunks.length === 0) return undefined;
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim().length === 0) return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new ZimReaperError("BAD_REQUEST", "invalid JSON request body");
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(text),
    "cache-control": "no-store",
  });
  res.end(text);
}

export async function runHttp(
  opts: McpServerOptions & { port?: number; host?: string },
): Promise<RunningMcpServer> {
  const host = opts.host ?? "127.0.0.1";
  const port = opts.port ?? 7421;
  const pathToken = randomToken();
  const mcpPath = `/mcp/${pathToken}`;
  const server = buildServer(opts);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);

  const http = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);
    if (req.method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, name: opts.name ?? "zimreaper" });
      return;
    }
    if (url.pathname !== mcpPath) {
      sendJson(res, 404, { error: { code: "NOT_FOUND", message: "not found" } });
      return;
    }
    try {
      const parsedBody = req.method === "POST" ? await readBody(req) : undefined;
      await transport.handleRequest(req, res, parsedBody);
    } catch (err) {
      const zim = ZimReaperError.from(err);
      if (!res.headersSent) {
        sendJson(res, 400, { error: { code: zim.code, message: zim.message } });
      } else {
        res.end();
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error): void => {
      http.off("error", onError);
      reject(new ZimReaperError("BACKEND_ERROR", `MCP HTTP listen failed: ${err.message}`));
    };
    http.once("error", onError);
    http.listen(port, host, () => {
      http.off("error", onError);
      resolve();
    });
  });

  const address = http.address();
  const boundPort = typeof address === "object" && address !== null ? address.port : port;
  return {
    port: boundPort,
    path: mcpPath,
    url: `http://${host}:${boundPort}${mcpPath}`,
    async close() {
      await transport.close();
      await server.close();
      await new Promise<void>((resolve, reject) => {
        http.close((err) => (err ? reject(ZimReaperError.from(err, "BACKEND_ERROR")) : resolve()));
      });
    },
  };
}
