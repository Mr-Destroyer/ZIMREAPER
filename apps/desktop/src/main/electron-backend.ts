import type { Backend, BackendCapabilities, BackendListener, CreateTabOptions } from "@zimreaper/core";
import type { Event, NetEntry, TabInfo } from "@zimreaper/protocol";
import { ZimReaperError } from "@zimreaper/protocol";
import type { TabManager } from "./tab-manager.js";

interface PendingNet {
  entry: NetEntry;
  started: number;
}

type CdpParams = Record<string, unknown>;

function record(value: unknown): CdpParams {
  return typeof value === "object" && value !== null ? (value as CdpParams) : {};
}

function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function headerRecord(value: unknown): Record<string, string> | undefined {
  const headers = record(value);
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(headers)) {
    if (typeof raw === "string") out[key] = raw;
    else if (Array.isArray(raw)) out[key] = raw.map(String).join(", ");
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

export class ElectronBackend implements Backend {
  readonly name = "electron";
  private readonly tabs: TabManager;
  private readonly onGhost?: (tabId: string, x: number, y: number, label?: string) => void;
  private readonly listeners = new Set<BackendListener>();
  private readonly netByRequest = new Map<string, PendingNet>();
  private readonly attached = new Set<string>();
  private netSeq = 0;
  private closed = false;

  constructor(tabs: TabManager, onGhost?: (tabId: string, x: number, y: number, label?: string) => void) {
    this.tabs = tabs;
    this.onGhost = onGhost;
  }

  capabilities(): BackendCapabilities {
    return {
      name: this.name,
      tabs: true,
      screenshots: true,
      network: true,
      frames: true,
      domains: [
        "Page",
        "Network",
        "Runtime",
        "DOM",
        "Input",
        "Target",
        "Emulation",
        "Storage",
        "Accessibility",
        "Log",
        "Fetch",
      ],
    };
  }

  async listTabs(): Promise<TabInfo[]> {
    return this.tabs.list();
  }

  async getTab(tabId: string): Promise<TabInfo | undefined> {
    const tab = this.tabs.get(tabId);
    return tab ? this.tabs.list().find((entry) => entry.tabId === tabId) : undefined;
  }

  async createTab(opts: CreateTabOptions = {}): Promise<TabInfo> {
    const info = await this.tabs.create(opts);
    this.emit({ kind: "tab.created", tab: info });
    await this.attach(info.tabId);
    return info;
  }

  async closeTab(tabId: string): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new ZimReaperError("NOT_FOUND", `no tab ${tabId}`);
    if (tab.view.webContents.debugger.isAttached()) {
      try {
        tab.view.webContents.debugger.detach();
      } catch {
        // Detach is best-effort during teardown.
      }
    }
    this.attached.delete(tabId);
    await this.tabs.close(tabId);
  }

  async activateTab(tabId: string): Promise<void> {
    if (!this.tabs.get(tabId)) throw new ZimReaperError("NOT_FOUND", `no tab ${tabId}`);
    this.tabs.activate(tabId);
  }

  activeTabId(): string | undefined {
    return this.tabs.activeTabId();
  }

  async send<T = unknown>(tabId: string, method: string, params?: Record<string, unknown>, sessionId?: string): Promise<T> {
    if (this.closed) throw new ZimReaperError("BACKEND_ERROR", "backend closed");
    const tab = this.tabs.get(tabId);
    if (!tab) throw new ZimReaperError("NOT_FOUND", `no tab ${tabId}`);
    if (tab.view.webContents.isDestroyed()) throw new ZimReaperError("TAB_CLOSED", `tab ${tabId} closed`);
    await this.attach(tabId);
    if (method === "Input.dispatchMouseEvent" && params && typeof params.x === "number" && typeof params.y === "number") {
      this.onGhost?.(tabId, params.x, params.y, str(params.type));
    }
    try {
      const result = await tab.view.webContents.debugger.sendCommand(method, params, sessionId);
      return result as T;
    } catch (error) {
      throw ZimReaperError.from(error, "BACKEND_ERROR");
    }
  }

  on(listener: BackendListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(event: Event): void {
    this.emit(event);
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const tabId of [...this.attached]) {
      const tab = this.tabs.get(tabId);
      if (tab && !tab.view.webContents.isDestroyed() && tab.view.webContents.debugger.isAttached()) {
        try {
          tab.view.webContents.debugger.detach();
        } catch {
          // Ignore detach races at shutdown.
        }
      }
    }
    this.attached.clear();
    this.listeners.clear();
    this.netByRequest.clear();
  }

  private async attach(tabId: string): Promise<void> {
    if (this.attached.has(tabId)) return;
    const tab = this.tabs.get(tabId);
    if (!tab) throw new ZimReaperError("NOT_FOUND", `no tab ${tabId}`);
    const dbg = tab.view.webContents.debugger;
    if (!dbg.isAttached()) {
      try {
        dbg.attach("1.3");
      } catch (error) {
        throw ZimReaperError.from(error, "BACKEND_ERROR");
      }
    }
    this.attached.add(tabId);
    dbg.on("message", (_event, method, rawParams, sessionId) => this.translate(tabId, method, rawParams, sessionId));
    dbg.on("detach", () => this.attached.delete(tabId));

    await Promise.allSettled([
      dbg.sendCommand("Page.enable"),
      dbg.sendCommand("Runtime.enable"),
      dbg.sendCommand("Network.enable"),
      dbg.sendCommand("Log.enable"),
    ]);
  }

  private emit(event: Event): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A bad consumer must not break CDP event translation.
      }
    }
  }

  private translate(tabId: string, method: string, raw: unknown, _sessionId: string): void {
    const params = record(raw);
    switch (method) {
      case "Page.frameNavigated": {
        const frame = record(params.frame);
        if (frame.parentId) return;
        const url = str(frame.url);
        if (url) this.emit({ kind: "nav.committed", tabId, url });
        return;
      }
      case "Page.loadEventFired":
        this.emit({ kind: "nav.loaded", tabId, url: this.tabs.get(tabId)?.view.webContents.getURL() ?? "" });
        return;
      case "Runtime.consoleAPICalled": {
        const type = str(params.type, "log");
        const args = Array.isArray(params.args) ? params.args : [];
        const text = args
          .map((arg) => {
            const value = record(arg);
            if (typeof value.value === "string") return value.value;
            if (value.value !== undefined) return String(value.value);
            return str(value.description);
          })
          .filter(Boolean)
          .join(" ");
        this.emit({ kind: "console.message", tabId, level: type, text });
        return;
      }
      case "Runtime.exceptionThrown": {
        const details = record(params.exceptionDetails);
        const exception = record(details.exception);
        this.emit({
          kind: "console.message",
          tabId,
          level: "error",
          text: str(exception.description) || str(details.text, "Uncaught exception"),
        });
        return;
      }
      case "Network.requestWillBeSent": {
        const request = record(params.request);
        const requestId = str(params.requestId);
        const entry: NetEntry = {
          seq: ++this.netSeq,
          requestId,
          tabId,
          url: str(request.url),
          method: str(request.method, "GET"),
          resourceType: str(params.type, "Other"),
          requestHeaders: headerRecord(request.headers),
          startedAt: num(params.timestamp) > 0 ? num(params.timestamp) * 1000 : Date.now(),
        };
        this.netByRequest.set(requestId, { entry, started: Date.now() });
        this.emit({ kind: "net.request", tabId, entry });
        return;
      }
      case "Network.responseReceived": {
        const response = record(params.response);
        const pending = this.netByRequest.get(str(params.requestId));
        if (!pending) return;
        const entry: NetEntry = {
          ...pending.entry,
          status: num(response.status),
          mimeType: str(response.mimeType) || undefined,
          responseHeaders: headerRecord(response.headers),
        };
        pending.entry = entry;
        this.emit({ kind: "net.response", tabId, entry });
        return;
      }
      case "Network.loadingFinished": {
        const requestId = str(params.requestId);
        const pending = this.netByRequest.get(requestId);
        if (!pending) return;
        this.netByRequest.delete(requestId);
        const entry: NetEntry = {
          ...pending.entry,
          encodedBytes: num(params.encodedDataLength),
          finishedAt: num(params.timestamp) > 0 ? num(params.timestamp) * 1000 : Date.now(),
        };
        this.emit({ kind: "net.response", tabId, entry });
        return;
      }
      case "Network.loadingFailed": {
        const requestId = str(params.requestId);
        const pending = this.netByRequest.get(requestId);
        if (!pending) return;
        this.netByRequest.delete(requestId);
        const entry: NetEntry = {
          ...pending.entry,
          error: str(params.errorText, "network failed"),
          finishedAt: Date.now(),
        };
        this.emit({ kind: "net.failed", tabId, entry });
        return;
      }
      case "Page.javascriptDialogOpening": {
        this.emit({
          kind: "dialog.opened",
          tabId,
          type: str(params.type, "alert"),
          message: str(params.message),
          defaultPrompt: str(params.defaultPrompt) || undefined,
        });
        return;
      }
      default:
        return;
    }
  }
}
