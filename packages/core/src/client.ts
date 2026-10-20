import WebSocket from "ws";
import type { Action, Event, Query, ResponseMeta } from "@zimreaper/protocol";
import { ZimReaperError } from "@zimreaper/protocol";
import { createLogger } from "./logger.js";

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

interface PendingRequest {
  method: string;
  resolve: (frame: ResponseFrame) => void;
  reject: (error: ZimReaperError) => void;
  timer: ReturnType<typeof setTimeout>;
  cleanup?: () => void;
}

interface ResponseFrame {
  jsonrpc?: string;
  id: string;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; details?: unknown; retryable?: boolean };
  meta?: ResponseMeta;
}

interface EventFrame {
  method: "event";
  params: Event;
}

const log = createLogger("core:client");
const MAX_RECONNECT = 3;
const RECONNECT_BACKOFF_MS = 250;

/**
 * Thin JSON-RPC client used by the CLI, the MCP server, and tests.
 * In-flight calls reject with CANCELLED on close; the event stream reconnects with backoff.
 */
export class ControlClient {
  readonly url: string;
  sessionId?: string;
  protocolVersion?: string;
  appVersion?: string;

  private readonly token: string;
  private readonly clientName: string;
  private readonly defaultTimeoutMs: number;
  private readonly listeners = new Set<(event: Event) => void>();
  private readonly pending = new Map<string, PendingRequest>();
  private ws: WebSocket;
  private nextId = 1;
  private closed = false;
  private reconnectAttempts = 0;
  private lastCloseCode?: number;

  private constructor(ws: WebSocket, opts: ControlClientOptions) {
    this.ws = ws;
    this.url = opts.url;
    this.token = opts.token;
    this.clientName = opts.client ?? "client";
    this.defaultTimeoutMs = opts.timeoutMs ?? 30_000;
    this.attach(ws);
  }

  static async connect(opts: ControlClientOptions): Promise<ControlClient> {
    const ws = await openSocket(opts.url);
    const client = new ControlClient(ws, opts);
    try {
      const frame = await client.request("ping", { token: opts.token, client: opts.client ?? "client" }, {});
      const info = (frame.result ?? {}) as {
        sessionId?: string;
        protocolVersion?: string;
        appVersion?: string;
      };
      client.sessionId = info.sessionId;
      client.protocolVersion = info.protocolVersion;
      client.appVersion = info.appVersion;
      return client;
    } catch (err) {
      client.close();
      throw err instanceof ZimReaperError
        ? err
        : new ZimReaperError("UNAUTHORIZED", `handshake failed: ${String(err)}`);
    }
  }

  get connected(): boolean {
    return !this.closed && this.ws.readyState === WebSocket.OPEN;
  }

  async act(action: Action, opts: CallOptions = {}): Promise<{ result: unknown; meta?: ResponseMeta }> {
    const frame = await this.request("act", action, opts);
    return { result: frame.result, meta: frame.meta };
  }

  async query<T = unknown>(query: Query, opts: CallOptions = {}): Promise<T> {
    const frame = await this.request("query", query, opts);
    return frame.result as T;
  }

  async cancel(tabId?: string): Promise<{ cancelled: number }> {
    const frame = await this.request("cancel", tabId ? { tabId } : {}, {});
    return (frame.result ?? { cancelled: 0 }) as { cancelled: number };
  }

  on(listener: (event: Event) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.cleanup?.();
      pending.reject(new ZimReaperError("CANCELLED", `${pending.method} cancelled: client closed`));
      this.pending.delete(id);
    }
    try {
      this.ws.close();
    } catch {
      this.ws.terminate();
    }
    this.listeners.clear();
  }

  /* -------------------------------------------------------------- internals */

  private attach(ws: WebSocket): void {
    ws.on("message", (raw) => this.onFrame(raw.toString()));
    ws.on("close", (code: number) => {
      this.lastCloseCode = code;
      const error =
        code === 4401
          ? new ZimReaperError("UNAUTHORIZED", "unauthorized (4401): bad or missing control token")
          : new ZimReaperError("CANCELLED", `connection closed (${code})`);
      this.rejectAll(error);
      if (this.closed) return;
      if (code === 4401) {
        this.closed = true;
        return;
      }
      this.scheduleReconnect();
    });
    ws.on("error", (err: Error) => log.debug("client socket error", { error: err.message }));
  }

  private onFrame(raw: string): void {
    let frame: ResponseFrame & Partial<EventFrame>;
    try {
      frame = JSON.parse(raw) as ResponseFrame & Partial<EventFrame>;
    } catch {
      return;
    }
    if (frame.method === "event" && frame.params) {
      for (const listener of this.listeners) {
        try {
          listener(frame.params);
        } catch (err) {
          log.warn("event listener threw", { error: String(err) });
        }
      }
      return;
    }
    if (typeof frame.id !== "string") return;
    const pending = this.pending.get(frame.id);
    if (!pending) return;
    this.pending.delete(frame.id);
    clearTimeout(pending.timer);
    pending.cleanup?.();
    if (frame.ok) {
      pending.resolve(frame);
      return;
    }
    const error = frame.error;
    pending.reject(
      new ZimReaperError(
        (error?.code ?? "INTERNAL") as ZimReaperError["code"],
        error?.message ?? "request failed",
        { details: error?.details, retryable: error?.retryable },
      ),
    );
  }

  private request(method: string, params: unknown, opts: CallOptions): Promise<ResponseFrame> {
    if (this.closed) {
      return Promise.reject(new ZimReaperError("CANCELLED", `client closed before ${method}`));
    }
    if (this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new ZimReaperError("BACKEND_ERROR", `socket not open for ${method}`));
    }
    const id = `c${this.nextId++}`;
    const timeoutMs = opts.timeoutMs ?? this.defaultTimeoutMs;
    return new Promise<ResponseFrame>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        cleanup?.();
        reject(new ZimReaperError("TIMEOUT", `${method} timed out after ${timeoutMs}ms`, { retryable: true }));
      }, timeoutMs);
      let cleanup: (() => void) | undefined;
      const entry: PendingRequest = { method, resolve, reject, timer };
      if (opts.signal) {
        const signal = opts.signal;
        const onAbort = (): void => {
          const current = this.pending.get(id);
          if (!current) return;
          this.pending.delete(id);
          clearTimeout(current.timer);
          current.reject(new ZimReaperError("CANCELLED", `${method} cancelled`));
        };
        if (signal.aborted) {
          clearTimeout(timer);
          reject(new ZimReaperError("CANCELLED", `${method} cancelled`));
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        cleanup = () => signal.removeEventListener("abort", onAbort);
        entry.cleanup = cleanup;
      }
      this.pending.set(id, entry);
      const frame: Record<string, unknown> = { jsonrpc: "2.0", id, method, params };
      if (opts.tabId) frame.tabId = opts.tabId;
      if (opts.timeoutMs) frame.timeoutMs = opts.timeoutMs;
      try {
        this.ws.send(JSON.stringify(frame), (err) => {
          if (!err) return;
          const current = this.pending.get(id);
          if (!current) return;
          this.pending.delete(id);
          clearTimeout(current.timer);
          current.reject(new ZimReaperError("BACKEND_ERROR", `send failed: ${err.message}`));
        });
      } catch (err) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(new ZimReaperError("BACKEND_ERROR", `send failed: ${String(err)}`));
      }
    });
  }

  private rejectAll(error: ZimReaperError): void {
    for (const [id, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.cleanup?.();
      pending.reject(error);
      this.pending.delete(id);
    }
  }

  /**
   * Reconnect only the event stream: calls are not retried (the executor never silently
   * repeats a mutating action), but subscribers keep receiving events across a blip.
   */
  private scheduleReconnect(): void {
    if (this.closed || this.reconnectAttempts >= MAX_RECONNECT) return;
    this.reconnectAttempts += 1;
    const attempt = this.reconnectAttempts;
    setTimeout(() => {
      if (this.closed) return;
      void (async () => {
        try {
          const ws = await openSocket(this.url);
          this.ws = ws;
          this.attach(ws);
          const frame = await this.request(
            "ping",
            { token: this.token, client: this.clientName },
            { timeoutMs: 5_000 },
          );
          const info = (frame.result ?? {}) as { sessionId?: string };
          if (info.sessionId) this.sessionId = info.sessionId;
          this.reconnectAttempts = 0;
          log.info("event stream reconnected", { attempt, afterClose: this.lastCloseCode });
        } catch (err) {
          log.warn("reconnect failed", { attempt, error: String(err) });
          this.scheduleReconnect();
        }
      })();
    }, RECONNECT_BACKOFF_MS * attempt);
  }
}

async function openSocket(url: string): Promise<WebSocket> {
  const ws = new WebSocket(url, { maxPayload: 256 * 1024 * 1024 });
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.terminate();
      reject(new ZimReaperError("TIMEOUT", `cannot connect to ${url} within 10s`));
    }, 10_000);
    ws.once("open", () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once("error", (err: Error) => {
      clearTimeout(timer);
      reject(new ZimReaperError("BACKEND_ERROR", `cannot connect to ${url}: ${err.message}`));
    });
    ws.once("close", (code: number) => {
      clearTimeout(timer);
      if (code === 4401) {
        reject(new ZimReaperError("UNAUTHORIZED", `unauthorized (4401) at ${url}`));
        return;
      }
      reject(new ZimReaperError("BACKEND_ERROR", `connection closed (${code}) before open`));
    });
  });
  return ws;
}
