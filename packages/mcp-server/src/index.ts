/**
 * MCP surface: browser tools over stdio (Claude Desktop/Code, Hermes, Codex) and
 * streamable HTTP for remote clients. Tools are thin wrappers over ControlClient.
 */
import type { Tool } from "@zimreaper/agent";
import type { ControlClient } from "@zimreaper/core";
import { ZimReaperError } from "@zimreaper/protocol";

export interface McpServerOptions {
  client: ControlClient;
  name?: string;
  version?: string;
  /** Emit tool calls + results on stderr for debugging. */
  debug?: boolean;
}

export interface RunningMcpServer {
  close(): Promise<void>;
  port?: number;
}

export function browserTools(_client: ControlClient): Tool[] {
  throw new ZimReaperError("UNSUPPORTED", "browserTools not implemented yet");
}

export async function runStdio(_opts: McpServerOptions): Promise<RunningMcpServer> {
  throw new ZimReaperError("UNSUPPORTED", "runStdio not implemented yet");
}

export async function runHttp(
  _opts: McpServerOptions & { port?: number; host?: string },
): Promise<RunningMcpServer> {
  throw new ZimReaperError("UNSUPPORTED", "runHttp not implemented yet");
}
