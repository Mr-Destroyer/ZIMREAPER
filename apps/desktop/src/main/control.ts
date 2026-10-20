import type { Backend, ControlServer } from "@zimreaper/core";
import { createLogger, startControlServer } from "@zimreaper/core";
import type { Action, Event } from "@zimreaper/protocol";
import { ZimReaperError } from "@zimreaper/protocol";

const log = createLogger("desktop:control");

type PublishableBackend = Backend & { publish?: (event: Event) => void };

export interface ControlBridge {
  readonly available: boolean;
  readonly port: number;
  readonly token: string;
  readonly url: string;
  on(listener: (event: Event) => void): () => void;
  resolveApproval(id: string, approved: boolean): Promise<void>;
  kill(): Promise<void>;
  releaseHuman(tabId: string): Promise<void>;
  close(): Promise<void>;
}

export interface ControlStartup {
  bridge: ControlBridge;
  warning?: string;
}

class StubControlBridge implements ControlBridge {
  readonly available = false;
  readonly port = 0;
  readonly token = "";
  readonly url = "";
  private readonly listeners = new Set<(event: Event) => void>();
  private readonly backend: PublishableBackend;

  constructor(backend: PublishableBackend) {
    this.backend = backend;
  }

  on(listener: (event: Event) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async resolveApproval(id: string, approved: boolean): Promise<void> {
    this.emit({ kind: "approval.resolved", id, approved });
  }

  async kill(): Promise<void> {
    this.emit({ kind: "agent.status", state: "paused", detail: "kill switch" });
  }

  async releaseHuman(tabId: string): Promise<void> {
    this.emit({ kind: "human.released", tabId });
  }

  async close(): Promise<void> {
    this.listeners.clear();
  }

  private emit(event: Event): void {
    this.backend.publish?.(event);
    for (const listener of this.listeners) listener(event);
  }
}

class LiveControlBridge implements ControlBridge {
  readonly available = true;
  readonly port: number;
  readonly token: string;
  readonly url: string;
  private readonly server: ControlServer;
  private readonly backend: PublishableBackend;
  private readonly listeners = new Set<(event: Event) => void>();
  private readonly detachServer: () => void;

  constructor(server: ControlServer, backend: PublishableBackend) {
    this.server = server;
    this.backend = backend;
    this.port = server.port;
    this.token = server.token;
    this.url = server.url;
    this.detachServer = server.on((event) => this.emit(event, false));
  }

  on(listener: (event: Event) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async resolveApproval(id: string, approved: boolean): Promise<void> {
    // P0 freezes approvals as bus events, not an RPC. Resolve locally so the HUD stays
    // responsive; a future core endpoint can be called here without touching the UI.
    this.emit({ kind: "approval.resolved", id, approved });
  }

  async kill(): Promise<void> {
    await this.action({ kind: "session.kill" });
  }

  async releaseHuman(tabId: string): Promise<void> {
    this.emit({ kind: "human.released", tabId });
  }

  async close(): Promise<void> {
    this.detachServer();
    this.listeners.clear();
    await this.server.close();
  }

  private emit(event: Event, publish = true): void {
    if (publish) this.backend.publish?.(event);
    for (const listener of this.listeners) listener(event);
  }

  private async action(action: Action): Promise<void> {
    await this.request("act", action);
  }

  private async request(method: "act" | "query", params: unknown): Promise<unknown> {
    if (!this.url) throw new ZimReaperError("UNSUPPORTED", "control server has no URL");
    const wsUrl = this.url.replace(/^http/, "ws");
    const response = await new Promise<unknown>((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      let handshaken = false;
      const timer = setTimeout(() => {
        ws.close();
        reject(new ZimReaperError("TIMEOUT", "control request timed out"));
      }, 5000);
      ws.addEventListener("open", () => {
        ws.send(JSON.stringify({ jsonrpc: "2.0", id: "desktop-handshake", method: "ping", params: { token: this.token, client: "hud" } }));
      });
      ws.addEventListener("message", (message) => {
        try {
          const frame = JSON.parse(String(message.data)) as { id?: string; ok?: boolean; error?: { message?: string } };
          if (frame.id === "desktop-handshake" && !handshaken) {
            handshaken = true;
            ws.send(JSON.stringify({ jsonrpc: "2.0", id: "desktop-request", method, params }));
            return;
          }
          if (frame.id !== "desktop-request") return;
          clearTimeout(timer);
          ws.close();
          if (frame.ok === false) reject(new ZimReaperError("BACKEND_ERROR", frame.error?.message ?? "control request failed"));
          else resolve(frame);
        } catch {
          // Ignore unrelated push frames.
        }
      });
      ws.addEventListener("error", () => {
        clearTimeout(timer);
        reject(new ZimReaperError("BACKEND_ERROR", "control server connection failed"));
      });
    });
    return response;
  }
}

export async function startControl(backend: PublishableBackend, appVersion: string): Promise<ControlStartup> {
  try {
    const server = await startControlServer({ backend, appVersion });
    log.info("control server ready", { port: server.port });
    return { bridge: new LiveControlBridge(server, backend) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn("control server unavailable; continuing with browsing only", { message });
    return {
      bridge: new StubControlBridge(backend),
      warning: `Control plane unavailable: ${message}`,
    };
  }
}
