import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import type { Event, NetEntry, TabInfo } from "@zimreaper/protocol";
import { ZimReaperError } from "@zimreaper/protocol";
import type {
  Backend,
  BackendCapabilities,
  BackendListener,
  CdpEventListener,
  CreateTabOptions,
} from "./backend.js";
import { createLogger } from "./logger.js";

export interface CdpBackendOptions {
  /** Existing debug endpoint, e.g. http://127.0.0.1:9222 */
  endpoint?: string;
  executablePath?: string;
  userDataDir?: string;
  headless?: boolean;
  args?: string[];
  /** Default navigation timeout. */
  timeoutMs?: number;
}

const log = createLogger("core:cdp");

interface CdpErrorShape {
  code: number;
  message: string;
  data?: string;
}

interface CdpMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: Record<string, unknown>;
  error?: CdpErrorShape;
  sessionId?: string;
}

interface PendingCall {
  method: string;
  resolve: (value: unknown) => void;
  reject: (error: ZimReaperError) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface NetworkState {
  seq: number;
  inflight: Set<string>;
  entries: NetEntry[];
}

interface TabState {
  tabId: string;
  targetId: string;
  sessionId: string;
  url: string;
  title: string;
  active: boolean;
  loading: boolean;
  createdAt: number;
  partition: string;
  lastStatus?: number;
  net: NetworkState;
}

/** Session-gone first: a dead session reports as TAB_CLOSED even if the message also says "target". */
function mapCdpError(method: string, error: CdpErrorShape): ZimReaperError {
  const text = error.message.toLowerCase();
  const sessionGone =
    text.includes("session with given id not found") ||
    text.includes("session closed") ||
    text.includes("not attached to an active page") ||
    text.includes("inspected target navigated or closed") ||
    text.includes("target closed");
  if (sessionGone) {
    return new ZimReaperError("TAB_CLOSED", `${method}: ${error.message}`, { details: error });
  }
  const missing =
    text.includes("no target with given id") ||
    text.includes("target not found") ||
    text.includes("no node with given id") ||
    text.includes("could not find node") ||
    text.includes("node is detached");
  if (missing) {
    return new ZimReaperError("NO_TARGET", `${method}: ${error.message}`, { details: error });
  }
  return new ZimReaperError("BACKEND_ERROR", `${method}: ${error.message}`, { details: error });
}

function headersToRecord(raw: unknown): Record<string, string> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    out[key] = Array.isArray(value) ? value.map(String).join(", ") : String(value);
  }
  return out;
}

function consoleArgText(args: unknown): string {
  if (!Array.isArray(args)) return "";
  return args
    .map((arg) => {
      if (arg && typeof arg === "object") {
        const a = arg as Record<string, unknown>;
        if ("value" in a && a.value !== undefined) return String(a.value);
        if (typeof a.description === "string") return a.description;
        if (typeof a.type === "string") return `<${a.type}>`;
      }
      return String(arg);
    })
    .join(" ");
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Chromium driver over raw CDP. One WebSocket to the browser target, flat sessions per page.
 * Tabs are addressed by a stable `tN` id; targetId/sessionId stay internal.
 */
class CdpBackend implements Backend {
  readonly name = "cdp";

  private readonly ws: WebSocket;
  private readonly tabs = new Map<string, TabState>();
  private readonly byTarget = new Map<string, TabState>();
  private readonly bySession = new Map<string, TabState>();
  private readonly pending = new Map<number, PendingCall>();
  private readonly listeners = new Set<BackendListener>();
  private readonly cdpListeners = new Set<CdpEventListener>();
  private readonly contexts = new Map<string, string>();
  private nextCallId = 1;
  private nextTabNumber = 1;
  private activeId?: string;
  private closed = false;
  private child?: ChildProcess;
  private readonly tempUserDataDir?: string;
  private readonly defaultTimeoutMs: number;

  private constructor(
    ws: WebSocket,
    opts: {
      child?: ChildProcess;
      tempUserDataDir?: string;
      timeoutMs?: number;
    } = {},
  ) {
    this.ws = ws;
    this.child = opts.child;
    this.tempUserDataDir = opts.tempUserDataDir;
    this.defaultTimeoutMs = opts.timeoutMs ?? 30_000;
    this.ws.on("message", (data) => this.handleMessage(data.toString()));
    this.ws.on("close", () => this.handleSocketClosed());
    this.ws.on("error", (err: Error) => log.warn("socket error", { error: err.message }));
  }

  /** Open the socket, attach to every existing page, and enable the domains we translate. */
  static async open(
    wsUrl: string,
    opts: { child?: ChildProcess; tempUserDataDir?: string; timeoutMs?: number } = {},
  ): Promise<CdpBackend> {
    const ws = new WebSocket(wsUrl, { maxPayload: 256 * 1024 * 1024 });
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new ZimReaperError("BACKEND_ERROR", `timed out connecting to ${wsUrl}`));
      }, 15_000);
      ws.once("open", () => {
        clearTimeout(timer);
        resolve();
      });
      ws.once("error", (err: Error) => {
        clearTimeout(timer);
        reject(new ZimReaperError("BACKEND_ERROR", `cannot connect to ${wsUrl}: ${err.message}`));
      });
    });
    const backend = new CdpBackend(ws, opts);
    await backend.bootstrap();
    return backend;
  }

  private async bootstrap(): Promise<void> {
    await this.call("Target.setDiscoverTargets", { discover: true }, undefined, 5_000).catch(() => {
      /* older builds; attach still works */
    });
    await this.call(
      "Target.setAutoAttach",
      { autoAttach: true, waitForDebuggerOnStart: false, flatten: true },
      undefined,
      5_000,
    );
    await this.sendBrowser("Browser.setDownloadBehavior", {
      behavior: "allow",
      eventsEnabled: true,
    }).catch(() => {
      /* download events are optional */
    });
    const { targetInfos } = await this.call<{
      targetInfos: Array<{ targetId: string; type: string; url: string; title: string }>;
    }>("Target.getTargets", {}, undefined, 5_000);
    const pages = (targetInfos ?? []).filter((t) => t.type === "page");
    await Promise.all(
      pages.map(async (target) => {
        if (this.byTarget.has(target.targetId)) return;
        await this.call("Target.attachToTarget", { targetId: target.targetId, flatten: true }).catch(
          (err: unknown) => log.debug("attach failed", { targetId: target.targetId, err: String(err) }),
        );
      }),
    );
  }

  capabilities(): BackendCapabilities {
    return {
      name: "cdp",
      tabs: true,
      screenshots: true,
      network: true,
      frames: true,
      domains: [
        "Page",
        "Runtime",
        "Network",
        "DOM",
        "Accessibility",
        "Log",
        "Emulation",
        "Fetch",
        "DOMStorage",
        "Input",
        "Browser",
      ],
    };
  }

  /* ------------------------------------------------------------------ tabs */

  async listTabs(): Promise<TabInfo[]> {
    return [...this.tabs.values()].map((tab) => this.toTabInfo(tab));
  }

  async getTab(tabId: string): Promise<TabInfo | undefined> {
    const tab = this.tabs.get(tabId);
    return tab ? this.toTabInfo(tab) : undefined;
  }

  activeTabId(): string | undefined {
    return this.activeId;
  }

  async createTab(opts: CreateTabOptions = {}): Promise<TabInfo> {
    const params: Record<string, unknown> = { url: opts.url ?? "about:blank" };
    if (opts.partition) {
      params.browserContextId = await this.contextFor(opts.partition);
    }
    const { targetId } = await this.call<{ targetId: string }>("Target.createTarget", params);
    const tab = await this.waitForTab(targetId, opts.partition ?? "default");
    if (opts.active !== false) await this.activateTab(tab.tabId);
    return this.toTabInfo(tab);
  }

  async closeTab(tabId: string): Promise<void> {
    const tab = this.requireTab(tabId);
    await this.call("Target.closeTarget", { targetId: tab.targetId }).catch((err: unknown) => {
      // Already gone is a success from the caller's point of view.
      if (err instanceof ZimReaperError && err.code === "NO_TARGET") return;
      throw err;
    });
    this.forgetTab(tab);
  }

  async activateTab(tabId: string): Promise<void> {
    const tab = this.requireTab(tabId);
    await this.call("Target.activateTarget", { targetId: tab.targetId }).catch(() => {
      /* headless has no window to activate */
    });
    await this.send(tabId, "Page.bringToFront").catch(() => undefined);
    this.activeId = tabId;
    for (const other of this.tabs.values()) other.active = other.tabId === tabId;
    this.emit({ kind: "tab.activated", tabId });
  }

  /* ------------------------------------------------------------------- cdp */

  async send<T = unknown>(
    tabId: string,
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    const tab = this.requireTab(tabId);
    return this.call<T>(method, params, sessionId ?? tab.sessionId, this.defaultTimeoutMs);
  }

  async sendBrowser<T = unknown>(method: string, params: Record<string, unknown> = {}): Promise<T> {
    return this.call<T>(method, params, undefined, this.defaultTimeoutMs);
  }

  inFlight(tabId: string): number {
    return this.tabs.get(tabId)?.net.inflight.size ?? 0;
  }

  netEntries(tabId: string): NetEntry[] {
    return this.tabs.get(tabId)?.net.entries ?? [];
  }

  on(listener: BackendListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onCdp(listener: CdpEventListener): () => void {
    this.cdpListeners.add(listener);
    return () => this.cdpListeners.delete(listener);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const [id, call] of this.pending) {
      clearTimeout(call.timer);
      call.reject(new ZimReaperError("CANCELLED", `${call.method} cancelled: backend closing`));
      this.pending.delete(id);
    }
    await new Promise<void>((resolve) => {
      if (this.ws.readyState === WebSocket.CLOSED) return resolve();
      const timer = setTimeout(() => {
        this.ws.terminate();
        resolve();
      }, 2_000);
      this.ws.once("close", () => {
        clearTimeout(timer);
        resolve();
      });
      this.ws.close();
    });
    const child = this.child;
    if (child && child.exitCode === null) {
      child.kill("SIGTERM");
      const deadline = Date.now() + 2_000;
      while (child.exitCode === null && Date.now() < deadline) await delay(50);
      if (child.exitCode === null) child.kill("SIGKILL");
    }
    if (this.tempUserDataDir) {
      await rm(this.tempUserDataDir, { recursive: true, force: true }).catch(() => undefined);
    }
    this.listeners.clear();
    this.cdpListeners.clear();
    this.tabs.clear();
    this.byTarget.clear();
    this.bySession.clear();
  }

  /* -------------------------------------------------------------- internals */

  private requireTab(tabId: string): TabState {
    const tab = this.tabs.get(tabId);
    if (!tab) throw new ZimReaperError("NO_TARGET", `no tab ${tabId}`);
    return tab;
  }

  private toTabInfo(tab: TabState): TabInfo {
    return {
      tabId: tab.tabId,
      url: tab.url,
      title: tab.title,
      active: tab.tabId === this.activeId,
      partition: tab.partition,
      loading: tab.loading,
      canGoBack: false,
      canGoForward: false,
      createdAt: tab.createdAt,
    };
  }

  private emit(event: Event): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        log.warn("listener threw", { error: String(err) });
      }
    }
  }

  private async contextFor(partition: string): Promise<string> {
    const existing = this.contexts.get(partition);
    if (existing) return existing;
    const { browserContextId } = await this.call<{ browserContextId: string }>(
      "Target.createBrowserContext",
      { disposeOnDetach: false },
    );
    this.contexts.set(partition, browserContextId);
    return browserContextId;
  }

  private async waitForTab(targetId: string, partition: string): Promise<TabState> {
    const deadline = Date.now() + 10_000;
    let attached = false;
    while (Date.now() < deadline) {
      const tab = this.byTarget.get(targetId);
      if (tab) return tab;
      if (!attached && Date.now() > deadline - 9_600) {
        attached = true;
        await this.call("Target.attachToTarget", { targetId, flatten: true }).catch(() => undefined);
      }
      await delay(20);
    }
    throw new ZimReaperError("BACKEND_ERROR", `target ${targetId} did not attach`, {
      details: { partition },
    });
  }

  private registerTab(targetInfo: Record<string, unknown>, sessionId: string): TabState {
    const targetId = String(targetInfo.targetId ?? "");
    const existing = this.byTarget.get(targetId);
    if (existing) {
      existing.sessionId = sessionId;
      this.bySession.set(sessionId, existing);
      return existing;
    }
    const tabId = `t${this.nextTabNumber++}`;
    const tab: TabState = {
      tabId,
      targetId,
      sessionId,
      url: String(targetInfo.url ?? "about:blank"),
      title: String(targetInfo.title ?? ""),
      active: false,
      loading: false,
      createdAt: Date.now(),
      partition: "default",
      net: { seq: 0, inflight: new Set<string>(), entries: [] },
    };
    this.tabs.set(tabId, tab);
    this.byTarget.set(targetId, tab);
    this.bySession.set(sessionId, tab);
    if (!this.activeId) this.activeId = tabId;
    this.emit({ kind: "tab.created", tab: this.toTabInfo(tab) });
    return tab;
  }

  private forgetTab(tab: TabState): void {
    this.tabs.delete(tab.tabId);
    this.byTarget.delete(tab.targetId);
    this.bySession.delete(tab.sessionId);
    if (this.activeId === tab.tabId) {
      this.activeId = this.tabs.keys().next().value;
    }
    this.emit({ kind: "tab.closed", tabId: tab.tabId });
  }

  private async enableDomains(tab: TabState): Promise<void> {
    const enable = (method: string, params?: Record<string, unknown>) =>
      this.call(method, params ?? {}, tab.sessionId, 10_000).catch((err: unknown) =>
        log.debug("domain enable failed", { method, err: String(err) }),
      );
    await Promise.all([
      enable("Page.enable"),
      enable("Runtime.enable"),
      enable("Network.enable", { maxTotalBufferSize: 100_000_000, maxResourceBufferSize: 10_000_000 }),
      enable("DOM.enable"),
      enable("Accessibility.enable"),
      enable("Log.enable"),
    ]);
  }

  private call<T = unknown>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
    timeoutMs = 30_000,
  ): Promise<T> {
    if (this.closed) {
      return Promise.reject(new ZimReaperError("CANCELLED", `backend closed before ${method}`));
    }
    if (this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new ZimReaperError("BACKEND_ERROR", `socket not open for ${method}`));
    }
    const id = this.nextCallId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new ZimReaperError("TIMEOUT", `${method} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, {
        method,
        timer,
        resolve: (value) => resolve(value as T),
        reject,
      });
      const frame: CdpMessage = { id, method, params };
      if (sessionId) frame.sessionId = sessionId;
      this.ws.send(JSON.stringify(frame), (err) => {
        if (!err) return;
        const pending = this.pending.get(id);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(id);
        pending.reject(new ZimReaperError("BACKEND_ERROR", `send failed: ${err.message}`));
      });
    });
  }

  private handleMessage(raw: string): void {
    let message: CdpMessage;
    try {
      message = JSON.parse(raw) as CdpMessage;
    } catch {
      log.warn("unparseable cdp frame");
      return;
    }
    if (typeof message.id === "number") {
      const call = this.pending.get(message.id);
      if (!call) return;
      this.pending.delete(message.id);
      clearTimeout(call.timer);
      if (message.error) call.reject(mapCdpError(call.method, message.error));
      else call.resolve(message.result ?? {});
      return;
    }
    if (message.method) this.handleCdpEvent(message.method, message.params ?? {}, message.sessionId);
  }

  private handleCdpEvent(method: string, params: Record<string, unknown>, sessionId?: string): void {
    const tab = sessionId ? this.bySession.get(sessionId) : undefined;

    if (method === "Target.attachedToTarget") {
      const targetInfo = (params.targetInfo ?? {}) as Record<string, unknown>;
      const newSession = String(params.sessionId ?? "");
      if (targetInfo.type !== "page" || !newSession) return;
      const registered = this.registerTab(targetInfo, newSession);
      void this.enableDomains(registered);
      return;
    }
    if (method === "Target.detachedFromTarget") {
      const detachedSession = String(params.sessionId ?? "");
      const detached = detachedSession ? this.bySession.get(detachedSession) : undefined;
      if (detached) this.forgetTab(detached);
      return;
    }
    if (method === "Target.targetInfoChanged") {
      const targetInfo = (params.targetInfo ?? {}) as Record<string, unknown>;
      const changed = this.byTarget.get(String(targetInfo.targetId ?? ""));
      if (!changed) return;
      changed.url = String(targetInfo.url ?? changed.url);
      changed.title = String(targetInfo.title ?? changed.title);
      this.emitTabUpdated(changed);
      return;
    }
    if (method === "Target.targetDestroyed") {
      const destroyed = this.byTarget.get(String(params.targetId ?? ""));
      if (destroyed) this.forgetTab(destroyed);
      return;
    }

    if (method.startsWith("Browser.download")) {
      this.handleDownload(method, params);
      return;
    }

    if (!tab) return;

    for (const listener of this.cdpListeners) {
      try {
        listener(tab.tabId, method, params);
      } catch (err) {
        log.warn("cdp listener threw", { method, error: String(err) });
      }
    }

    switch (method) {
      case "Page.frameNavigated": {
        const frame = (params.frame ?? {}) as Record<string, unknown>;
        if (frame.parentId) return;
        tab.url = String(frame.url ?? tab.url);
        tab.loading = true;
        tab.lastStatus = undefined;
        this.emit({ kind: "nav.committed", tabId: tab.tabId, url: tab.url });
        this.emitTabUpdated(tab);
        return;
      }
      case "Page.loadEventFired": {
        tab.loading = false;
        this.emit({
          kind: "nav.loaded",
          tabId: tab.tabId,
          url: tab.url,
          status: tab.lastStatus,
        });
        this.emitTabUpdated(tab);
        return;
      }
      case "Page.javascriptDialogOpening": {
        this.emit({
          kind: "dialog.opened",
          tabId: tab.tabId,
          type: String(params.type ?? "alert"),
          message: String(params.message ?? ""),
          defaultPrompt:
            typeof params.defaultPrompt === "string" ? params.defaultPrompt : undefined,
        });
        return;
      }
      case "Runtime.consoleAPICalled": {
        this.emit({
          kind: "console.message",
          tabId: tab.tabId,
          level: String(params.type ?? "log"),
          text: consoleArgText(params.args),
        });
        return;
      }
      case "Log.entryAdded": {
        const entry = (params.entry ?? {}) as Record<string, unknown>;
        this.emit({
          kind: "console.message",
          tabId: tab.tabId,
          level: String(entry.level ?? "info"),
          text: String(entry.text ?? ""),
        });
        return;
      }
      case "Network.requestWillBeSent":
        this.onRequestWillBeSent(tab, params);
        return;
      case "Network.responseReceived":
        this.onResponseReceived(tab, params);
        return;
      case "Network.loadingFinished":
        this.onLoadingFinished(tab, params);
        return;
      case "Network.loadingFailed":
        this.onLoadingFailed(tab, params);
        return;
      default:
        return;
    }
  }

  private emitTabUpdated(tab: TabState): void {
    this.emit({
      kind: "tab.updated",
      tabId: tab.tabId,
      url: tab.url,
      title: tab.title,
      loading: tab.loading,
    });
  }

  private onRequestWillBeSent(tab: TabState, params: Record<string, unknown>): void {
    const requestId = String(params.requestId ?? "");
    const request = (params.request ?? {}) as Record<string, unknown>;
    if (!requestId) return;
    const redirect = params.redirectResponse as Record<string, unknown> | undefined;
    if (redirect) this.finishEntry(tab, requestId, Number(redirect.status ?? 0));
    const entry: NetEntry = {
      seq: ++tab.net.seq,
      requestId,
      tabId: tab.tabId,
      url: String(request.url ?? ""),
      method: String(request.method ?? "GET"),
      resourceType: String(params.type ?? "Other"),
      requestHeaders: headersToRecord(request.headers),
      startedAt: Date.now(),
    };
    tab.net.inflight.add(requestId);
    tab.net.entries.push(entry);
    if (tab.net.entries.length > 2_000) tab.net.entries.splice(0, 500);
    this.emit({ kind: "net.request", tabId: tab.tabId, entry: { ...entry } });
  }

  private onResponseReceived(tab: TabState, params: Record<string, unknown>): void {
    const requestId = String(params.requestId ?? "");
    const response = (params.response ?? {}) as Record<string, unknown>;
    const entry = this.findEntry(tab, requestId);
    if (!entry) return;
    entry.status = Number(response.status ?? 0);
    entry.mimeType = typeof response.mimeType === "string" ? response.mimeType : undefined;
    entry.responseHeaders = headersToRecord(response.headers);
    if (params.type === "Document" && typeof params.frameId === "string" && !params.frameId.includes(".")) {
      // Main frame document response: the status a nav.goto reports.
      tab.lastStatus = entry.status;
    }
    this.emit({ kind: "net.response", tabId: tab.tabId, entry: { ...entry } });
  }

  private onLoadingFinished(tab: TabState, params: Record<string, unknown>): void {
    const requestId = String(params.requestId ?? "");
    const entry = this.findEntry(tab, requestId);
    if (entry) {
      entry.finishedAt = Date.now();
      entry.encodedBytes = Number(params.encodedDataLength ?? 0) || undefined;
    }
    tab.net.inflight.delete(requestId);
  }

  private onLoadingFailed(tab: TabState, params: Record<string, unknown>): void {
    const requestId = String(params.requestId ?? "");
    const entry = this.findEntry(tab, requestId);
    tab.net.inflight.delete(requestId);
    if (!entry) return;
    entry.error = String(params.errorText ?? "failed");
    entry.finishedAt = Date.now();
    this.emit({ kind: "net.failed", tabId: tab.tabId, entry: { ...entry } });
  }

  private finishEntry(tab: TabState, requestId: string, status: number): void {
    const entry = this.findEntry(tab, requestId);
    if (!entry) return;
    entry.status = status || entry.status;
    entry.finishedAt = Date.now();
    tab.net.inflight.delete(requestId);
  }

  private findEntry(tab: TabState, requestId: string): NetEntry | undefined {
    for (let i = tab.net.entries.length - 1; i >= 0; i -= 1) {
      const entry = tab.net.entries[i];
      if (entry && entry.requestId === requestId) return entry;
    }
    return undefined;
  }

  private handleDownload(method: string, params: Record<string, unknown>): void {
    const owner = (this.activeId ? this.tabs.get(this.activeId) : undefined) ?? this.tabs.values().next().value;
    const tabId = owner?.tabId ?? "";
    if (method === "Browser.downloadWillBegin") {
      this.emit({
        kind: "download.started",
        tabId,
        url: String(params.url ?? ""),
        filename: String(params.suggestedFilename ?? ""),
      });
      return;
    }
    if (method === "Browser.downloadProgress" && params.state !== "inProgress") {
      this.emit({
        kind: "download.finished",
        tabId,
        path: String(params.guid ?? ""),
        state: String(params.state ?? "completed"),
      });
    }
  }

  private handleSocketClosed(): void {
    for (const [id, call] of this.pending) {
      clearTimeout(call.timer);
      call.reject(new ZimReaperError("BACKEND_ERROR", `${call.method} failed: socket closed`));
      this.pending.delete(id);
    }
  }
}

function normalizeEndpoint(endpoint: string): string {
  return endpoint.replace(/\/+$/, "");
}

/** Attach to a running Chromium: GET /json/version, then drive its browser target. */
export async function connectCdpBackend(endpoint: string): Promise<Backend> {
  const base = normalizeEndpoint(endpoint);
  if (base.startsWith("ws://") || base.startsWith("wss://")) {
    return CdpBackend.open(base);
  }
  let version: { webSocketDebuggerUrl?: string };
  try {
    const res = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(10_000) });
    if (!res.ok) {
      throw new ZimReaperError("BACKEND_ERROR", `${base}/json/version -> HTTP ${res.status}`);
    }
    version = (await res.json()) as { webSocketDebuggerUrl?: string };
  } catch (err) {
    if (err instanceof ZimReaperError) throw err;
    throw new ZimReaperError(
      "BACKEND_ERROR",
      `cannot reach Chromium at ${base}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const wsUrl = version.webSocketDebuggerUrl;
  if (!wsUrl) {
    throw new ZimReaperError("BACKEND_ERROR", `no webSocketDebuggerUrl at ${base}/json/version`);
  }
  return CdpBackend.open(wsUrl);
}

/**
 * Route the browser through an intercepting proxy, the way a hunter actually works.
 *
 * ZIMREAPER_PROXY=http://127.0.0.1:8080   mitmproxy / Burp / ZAP
 * ZIMREAPER_INSECURE=1                    accept the proxy's CA (TLS interception)
 *
 * Chromium bypasses proxies for loopback by default, so a local lab or a localhost API target
 * would silently skip the proxy. `--proxy-bypass-list=<-loopback>` removes that exception; it is
 * the difference between "captured nothing" and "captured the whole flow".
 */
function proxyArgs(): string[] {
  const proxy = process.env.ZIMREAPER_PROXY?.trim();
  const args: string[] = [];
  if (proxy) {
    args.push(`--proxy-server=${proxy}`, "--proxy-bypass-list=<-loopback>");
  }
  if (proxy || process.env.ZIMREAPER_INSECURE === "1") {
    args.push("--ignore-certificate-errors");
  }
  return args;
}

/** Launch a private Chromium (or attach when `endpoint` is set) and drive it over CDP. */
export async function launchCdpBackend(opts: CdpBackendOptions = {}): Promise<Backend> {
  if (opts.endpoint) return connectCdpBackend(opts.endpoint);

  const executablePath = opts.executablePath ?? process.env.ZIMREAPER_CHROMIUM ?? "/usr/bin/chromium";
  const userDataDir = opts.userDataDir ?? (await mkdtemp(join(tmpdir(), "zimreaper-cdp-")));
  const ownsUserDataDir = opts.userDataDir === undefined;
  const launchArgs = [
    ...proxyArgs(),
    "--remote-debugging-port=0",
    `--user-data-dir=${userDataDir}`,
    ...(opts.headless === false ? [] : ["--headless=new"]),
    "--no-first-run",
    "--no-default-browser-check",
    ...(process.env.ZIMREAPER_NO_SANDBOX === "1" ? ["--no-sandbox"] : []),
    "--disable-gpu",
    "--disable-dev-shm-usage",
    ...(opts.args ?? []),
    "about:blank",
  ];

  const child = spawn(executablePath, launchArgs, { stdio: ["ignore", "ignore", "pipe"] });
  const stderr = child.stderr;
  if (!stderr) {
    child.kill("SIGKILL");
    throw new ZimReaperError("BACKEND_ERROR", `cannot read Chromium stderr for ${executablePath}`);
  }
  const wsUrl = await new Promise<string>((resolve, reject) => {
    let buffered = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      finish(() =>
        reject(
          new ZimReaperError("BACKEND_ERROR", `Chromium did not open a debug port within 20s`, {
            details: { executablePath, stderr: buffered.slice(-2_000) },
          }),
        ),
      );
      child.kill("SIGKILL");
    }, 20_000);
    stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      buffered = (buffered + text).slice(-8_000);
      const match = /DevTools listening on (ws:\/\/\S+)/.exec(buffered);
      if (match?.[1]) finish(() => resolve(match[1] as string));
    });
    child.once("error", (err: Error) => {
      finish(() =>
        reject(
          new ZimReaperError("BACKEND_ERROR", `cannot spawn ${executablePath}: ${err.message}`, {
            details: { executablePath },
          }),
        ),
      );
    });
    child.once("exit", (code) => {
      finish(() =>
        reject(
          new ZimReaperError("BACKEND_ERROR", `Chromium exited (code ${code ?? "null"}) before debugging was ready`, {
            details: { executablePath, stderr: buffered.slice(-2_000) },
          }),
        ),
      );
    });
  });

  try {
    return await CdpBackend.open(wsUrl, {
      child,
      tempUserDataDir: ownsUserDataDir ? userDataDir : undefined,
      timeoutMs: opts.timeoutMs,
    });
  } catch (err) {
    child.kill("SIGKILL");
    throw ZimReaperError.from(err, "BACKEND_ERROR");
  }
}
