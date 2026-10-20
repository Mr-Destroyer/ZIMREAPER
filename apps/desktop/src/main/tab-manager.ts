import { app, session, WebContentsView, type BrowserWindow, type Rectangle, type Session, type WebContents } from "electron";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Event, TabInfo } from "@zimreaper/protocol";
import type { ChromeBounds, TabSnapshot, TabViewState } from "../shared/ipc.js";

interface ManagedTab {
  tabId: string;
  view: WebContentsView;
  partition: string;
  createdAt: number;
  favicon?: string;
  loading: boolean;
  active: boolean;
}

export interface TabManagerOptions {
  window: BrowserWindow;
  onEvent: (event: Event | { type: "tab.snapshot"; snapshot: TabSnapshot }) => void;
  onHumanInput: (tabId: string, kind: "mouse" | "keyboard" | "wheel" | "other") => void;
  onKill: () => void;
  onFocusUrl: () => void;
  contentBounds: () => Rectangle;
}

const DEFAULT_PARTITION = "persist:zimreaper";

function partitionFor(raw?: string): string {
  // A caller-supplied partition is intentionally isolated unless it opts into persistence.
  return raw || DEFAULT_PARTITION;
}

function normalizeUrl(input: string): string {
  const trimmed = input.trim();
  if (!trimmed) return "https://www.google.com";
  if (/^[a-zA-Z][a-zA-Z\d+.-]*:/.test(trimmed)) return trimmed;
  if (trimmed.includes(".") && !trimmed.includes(" ")) return `https://${trimmed}`;
  return `https://www.google.com/search?q=${encodeURIComponent(trimmed)}`;
}

export class TabManager {
  private readonly window: BrowserWindow;
  private readonly tabs = new Map<string, ManagedTab>();
  private readonly order: string[] = [];
  private readonly onEvent: TabManagerOptions["onEvent"];
  private readonly onHumanInput: TabManagerOptions["onHumanInput"];
  private readonly onKill: TabManagerOptions["onKill"];
  private readonly onFocusUrl: TabManagerOptions["onFocusUrl"];
  private readonly contentBounds: TabManagerOptions["contentBounds"];
  private readonly sessions = new Map<string, Session>();
  private activeId: string | undefined;
  private nextId = 1;
  private bounds: Rectangle = { x: 0, y: 0, width: 0, height: 0 };
  private lastHumanSignal = 0;

  constructor(opts: TabManagerOptions) {
    this.window = opts.window;
    this.onEvent = opts.onEvent;
    this.onHumanInput = opts.onHumanInput;
    this.onKill = opts.onKill;
    this.onFocusUrl = opts.onFocusUrl;
    this.contentBounds = opts.contentBounds;
  }

  setBounds(bounds: ChromeBounds): void {
    this.bounds = {
      x: Math.max(0, Math.round(bounds.x)),
      y: Math.max(0, Math.round(bounds.y)),
      width: Math.max(1, Math.round(bounds.width)),
      height: Math.max(1, Math.round(bounds.height)),
    };
    this.layout();
  }

  getActive(): ManagedTab | undefined {
    return this.activeId ? this.tabs.get(this.activeId) : undefined;
  }

  get(tabId: string): ManagedTab | undefined {
    return this.tabs.get(tabId);
  }

  activeTabId(): string | undefined {
    return this.activeId;
  }

  list(): TabInfo[] {
    return this.order.flatMap((id) => {
      const tab = this.tabs.get(id);
      return tab ? [this.toInfo(tab)] : [];
    });
  }

  listView(): TabViewState[] {
    return this.order.flatMap((id) => {
      const tab = this.tabs.get(id);
      return tab ? [{ ...this.toInfo(tab), favicon: tab.favicon, audible: tab.view.webContents.isCurrentlyAudible() }] : [];
    });
  }

  snapshot(): TabSnapshot {
    return { tabs: this.listView(), activeTabId: this.activeId };
  }

  async create(opts: { url?: string; active?: boolean; partition?: string; forkFrom?: string } = {}): Promise<TabInfo> {
    const tabId = `t${this.nextId++}`;
    const partition = partitionFor(opts.partition);
    const ses = this.getSession(partition);
    const view = new WebContentsView({
      webPreferences: {
        partition,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        webSecurity: true,
        spellcheck: true,
        // A background tab that is throttled cannot be driven: agents act on tabs the user is
        // not looking at, and hidden windows (serve mode) must still render and dispatch input.
        backgroundThrottling: false,
      },
    });

    const tab: ManagedTab = {
      tabId,
      view,
      partition,
      createdAt: Date.now(),
      loading: true,
      active: false,
    };
    this.tabs.set(tabId, tab);
    this.order.push(tabId);
    this.wire(tab, ses);
    this.window.contentView.addChildView(view);
    view.setVisible(false);
    view.setBackgroundColor("#0b0d10");

    if (opts.active !== false || this.activeId === undefined) {
      this.activate(tabId);
    } else {
      this.emitSnapshot();
    }

    const target = opts.url ? normalizeUrl(opts.url) : "https://www.google.com";
    void view.webContents.loadURL(target).catch(() => undefined);
    if (opts.forkFrom) {
      await this.copySession(opts.forkFrom, tabId);
    }
    return this.toInfo(tab);
  }

  async close(tabId: string): Promise<void> {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    const index = this.order.indexOf(tabId);
    if (index >= 0) this.order.splice(index, 1);
    this.tabs.delete(tabId);
    this.window.contentView.removeChildView(tab.view);
    if (!tab.view.webContents.isDestroyed()) tab.view.webContents.close({ waitForBeforeUnload: false });
    this.onEvent({ kind: "tab.closed", tabId });

    if (this.activeId === tabId) {
      this.activeId = undefined;
      const nextId = this.order[Math.min(index, this.order.length - 1)];
      if (nextId) this.activate(nextId);
    }
    this.emitSnapshot();
  }

  activate(tabId: string): void {
    const tab = this.tabs.get(tabId);
    if (!tab) return;
    if (this.activeId && this.activeId !== tabId) {
      const previous = this.tabs.get(this.activeId);
      if (previous) {
        previous.active = false;
        previous.view.setVisible(false);
      }
    }
    this.activeId = tabId;
    tab.active = true;
    tab.view.setVisible(true);
    this.layout();
    tab.view.webContents.focus();
    this.onEvent({ kind: "tab.activated", tabId });
    this.emitSnapshot();
  }

  reorder(tabIds: string[]): void {
    const unique = tabIds.filter((id, index) => tabIds.indexOf(id) === index && this.tabs.has(id));
    for (const id of this.order) if (!unique.includes(id)) unique.push(id);
    this.order.splice(0, this.order.length, ...unique);
    this.emitSnapshot();
  }

  back(): void {
    const tab = this.getActive();
    if (tab?.view.webContents.navigationHistory.canGoBack()) tab.view.webContents.navigationHistory.goBack();
  }

  forward(): void {
    const tab = this.getActive();
    if (tab?.view.webContents.navigationHistory.canGoForward()) tab.view.webContents.navigationHistory.goForward();
  }

  reload(): void {
    this.getActive()?.view.webContents.reload();
  }

  goto(url: string): void {
    const tab = this.getActive();
    if (!tab) return;
    void tab.view.webContents.loadURL(normalizeUrl(url)).catch(() => undefined);
  }

  focusChrome(): void {
    this.window.webContents.focus();
  }

  emitSnapshot(): void {
    this.onEvent({ type: "tab.snapshot", snapshot: this.snapshot() });
  }

  destroy(): void {
    for (const id of [...this.order]) {
      const tab = this.tabs.get(id);
      if (tab && !tab.view.webContents.isDestroyed()) {
        try {
          if (tab.view.webContents.debugger.isAttached()) tab.view.webContents.debugger.detach();
        } catch {
          // The renderer may already be gone.
        }
        tab.view.webContents.close({ waitForBeforeUnload: false });
      }
    }
    this.tabs.clear();
    this.order.splice(0);
  }

  private getSession(partition: string): Session {
    const existing = this.sessions.get(partition);
    if (existing) return existing;
    const ses = session.fromPartition(partition);
    this.sessions.set(partition, ses);
    this.configureSession(ses);
    return ses;
  }

  private configureSession(ses: Session): void {
    ses.setPermissionRequestHandler((_wc, permission, callback, details) => {
      const allowed = permission === "clipboard-read" && details.isMainFrame;
      callback(allowed);
    });
    ses.setPermissionCheckHandler((_wc, permission) => permission === "clipboard-read");
    ses.on("will-download", (_event, item, wc) => {
      const tabId = this.tabIdFor(wc);
      const filename = item.getFilename();
      const savePath = join(homedir(), "Downloads", filename.replace(/[/\\]/g, "_"));
      item.setSavePath(savePath);
      this.onEvent({ kind: "download.started", tabId, url: item.getURL(), filename });
      item.once("done", (_doneEvent, state) => {
        this.onEvent({ kind: "download.finished", tabId, path: item.getSavePath() || savePath, state });
      });
    });
  }

  private tabIdFor(wc: WebContents): string {
    for (const [tabId, tab] of this.tabs) if (tab.view.webContents.id === wc.id) return tabId;
    return this.activeId ?? "unknown";
  }

  private wire(tab: ManagedTab, _ses: Session): void {
    const wc = tab.view.webContents;

    wc.setWindowOpenHandler(({ url }) => {
      void this.create({ url, active: true });
      return { action: "deny" };
    });

    wc.on("will-navigate", (details, url) => {
      const target = details.url || url;
      if (!/^(https?|file):/i.test(target)) details.preventDefault();
    });

    wc.on("did-start-loading", () => {
      tab.loading = true;
      this.emitUpdated(tab);
    });
    wc.on("did-stop-loading", () => {
      tab.loading = false;
      this.emitUpdated(tab);
    });
    wc.on("did-navigate", (_event, url, status) => {
      tab.loading = false;
      this.onEvent({ kind: "nav.committed", tabId: tab.tabId, url });
      this.onEvent({ kind: "nav.loaded", tabId: tab.tabId, url, status: status >= 0 ? status : undefined });
      this.emitUpdated(tab);
    });
    wc.on("did-navigate-in-page", (_event, url) => {
      this.onEvent({ kind: "nav.committed", tabId: tab.tabId, url });
      this.emitUpdated(tab);
    });
    wc.on("page-title-updated", (_event, title) => {
      this.emitUpdated(tab, title);
    });
    wc.on("page-favicon-updated", (_event, favicons) => {
      tab.favicon = favicons[0];
      this.emitSnapshot();
    });
    wc.on("did-fail-load", (_event, code, description, url, isMainFrame) => {
      if (!isMainFrame || code === -3) return;
      tab.loading = false;
      this.onEvent({ kind: "nav.loaded", tabId: tab.tabId, url, status: code });
      this.onEvent({ kind: "console.message", tabId: tab.tabId, level: "error", text: `${description} (${code})` });
      this.emitUpdated(tab);
    });
    wc.on("render-process-gone", (_event, details) => {
      this.onEvent({ kind: "console.message", tabId: tab.tabId, level: "error", text: `renderer exited: ${details.reason}` });
    });

    wc.on("before-input-event", (event, input) => {
      const mod = process.platform === "darwin" ? input.meta : input.control;
      const key = input.key.toLowerCase();
      if (mod && key === "l") {
        event.preventDefault();
        this.focusChrome();
        this.onFocusUrl();
        return;
      }
      if (mod && key === "t") {
        event.preventDefault();
        void this.create({ active: true });
        return;
      }
      if (mod && key === "w") {
        event.preventDefault();
        void this.close(tab.tabId);
        return;
      }
      if (mod && key === "r") {
        event.preventDefault();
        wc.reload();
        return;
      }
      if (input.alt && key === "left") {
        event.preventDefault();
        if (wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
        return;
      }
      if (input.alt && key === "right") {
        event.preventDefault();
        if (wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
        return;
      }
      if (key === "escape" && input.type === "keyDown") {
        event.preventDefault();
        this.onEvent({ kind: "human.input", tabId: tab.tabId, inputKind: "keyboard" });
        this.focusChrome();
        this.onKill();
        return;
      }
      if (input.type === "keyDown" || input.type === "keyUp") this.signalHuman(tab.tabId, "keyboard");
    });

    const signalMouse = (_event: unknown, input: { type: string }): void => {
      if (input.type === "mouseDown" || input.type === "mouseUp") this.signalHuman(tab.tabId, "mouse");
      else if (input.type === "mouseWheel") this.signalHuman(tab.tabId, "wheel");
    };
    (wc as WebContents & { on(event: "input-event", listener: (event: unknown, input: { type: string }) => void): void }).on("input-event", signalMouse);
  }

  private signalHuman(tabId: string, inputKind: "mouse" | "keyboard" | "wheel" | "other"): void {
    const now = Date.now();
    if (now - this.lastHumanSignal < 250) return;
    this.lastHumanSignal = now;
    this.onEvent({ kind: "human.input", tabId, inputKind });
    this.onHumanInput(tabId, inputKind);
  }

  private emitUpdated(tab: ManagedTab, title?: string): void {
    const wc = tab.view.webContents;
    this.onEvent({
      kind: "tab.updated",
      tabId: tab.tabId,
      url: wc.getURL(),
      title: title ?? wc.getTitle() ?? "",
      loading: tab.loading,
    });
    this.emitSnapshot();
  }

  private layout(): void {
    const active = this.getActive();
    if (!active) return;
    const bounds = this.bounds.width > 1 ? this.bounds : this.contentBounds();
    active.view.setBounds(bounds);
  }

  private toInfo(tab: ManagedTab): TabInfo {
    const wc = tab.view.webContents;
    return {
      tabId: tab.tabId,
      url: wc.getURL(),
      title: wc.getTitle() || "New tab",
      active: this.activeId === tab.tabId,
      partition: tab.partition,
      loading: tab.loading || wc.isLoading(),
      canGoBack: wc.navigationHistory.canGoBack(),
      canGoForward: wc.navigationHistory.canGoForward(),
      createdAt: tab.createdAt,
    };
  }

  private async copySession(fromTabId: string, toTabId: string): Promise<void> {
    const from = this.tabs.get(fromTabId);
    const to = this.tabs.get(toTabId);
    if (!from || !to) return;
    const cookies = await from.view.webContents.session.cookies.get({});
    for (const cookie of cookies) {
      if (!cookie.domain) continue;
      const url = `${cookie.secure ? "https" : "http"}://${cookie.domain.replace(/^\./, "")}${cookie.path || "/"}`;
      await to.view.webContents.session.cookies.set({ url, name: cookie.name, value: cookie.value, domain: cookie.domain, path: cookie.path, secure: cookie.secure, httpOnly: cookie.httpOnly, expirationDate: cookie.expirationDate }).catch(() => undefined);
    }
  }
}
