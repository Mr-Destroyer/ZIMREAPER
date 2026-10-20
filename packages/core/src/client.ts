import type { Action, Event, Query, ResponseMeta } from "@zimreaper/protocol";
import { ZimReaperError } from "@zimreaper/protocol";

export interface ControlClientOptions {
  url: string;
  token: string;
  client?: string;
  timeoutMs?: number;
}

export interface CallOptions {
  tabId?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/**
 * Thin JSON-RPC client used by the CLI, the MCP server, and tests.
 * Reconnects with backoff; in-flight calls reject with CANCELLED on close.
 */
export class ControlClient {
  static connect(_opts: ControlClientOptions): Promise<ControlClient> {
    throw new ZimReaperError("UNSUPPORTED", "ControlClient.connect not implemented yet");
  }

  act(_action: Action, _opts?: CallOptions): Promise<{ result: unknown; meta?: ResponseMeta }> {
    throw new ZimReaperError("UNSUPPORTED", "ControlClient.act not implemented yet");
  }

  query<T = unknown>(_query: Query, _opts?: CallOptions): Promise<T> {
    throw new ZimReaperError("UNSUPPORTED", "ControlClient.query not implemented yet");
  }

  on(_listener: (event: Event) => void): () => void {
    throw new ZimReaperError("UNSUPPORTED", "ControlClient.on not implemented yet");
  }

  close(): void {
    throw new ZimReaperError("UNSUPPORTED", "ControlClient.close not implemented yet");
  }
}
