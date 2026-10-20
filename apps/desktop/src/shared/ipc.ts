import type { Event, TabInfo } from "@zimreaper/protocol";

export interface AppInfo {
  port: number;
  token: string;
  version: string;
  controlUrl?: string;
  controlAvailable: boolean;
}

export interface ChromeBounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface TabViewState extends TabInfo {
  favicon?: string;
  audible: boolean;
}

export interface TabSnapshot {
  tabs: TabViewState[];
  activeTabId?: string;
}

export interface GhostCursor {
  x: number;
  y: number;
  label?: string;
}

export type HudEvent =
  | { type: "protocol"; event: Event }
  | { type: "tab.snapshot"; snapshot: TabSnapshot }
  | { type: "nav.state"; tabId: string; url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean }
  | { type: "ghost"; cursor: GhostCursor }
  | { type: "page.diff"; text: string; tabId?: string }
  | { type: "agent.status"; state: "idle" | "working" | "blocked" | "paused"; detail?: string }
  | { type: "approval.requested"; id: string; actionKind: string; reason: string; screenshotPath?: string; expiresAt?: number }
  | { type: "approval.resolved"; id: string; approved: boolean }
  | { type: "human.released"; tabId: string }
  | { type: "focus-url" }
  | { type: "control.unavailable"; message: string };

export interface DesktopBridge {
  tabs: {
    list(): Promise<TabSnapshot>;
    create(url?: string): Promise<TabViewState>;
    close(tabId: string): Promise<void>;
    activate(tabId: string): Promise<void>;
    reorder(tabIds: string[]): Promise<void>;
    setContentBounds(bounds: ChromeBounds): Promise<void>;
  };
  nav: {
    back(): Promise<void>;
    forward(): Promise<void>;
    reload(): Promise<void>;
    goto(url: string): Promise<void>;
  };
  hud: {
    subscribe(cb: (event: HudEvent) => void): () => void;
    resolveApproval(id: string, approved: boolean): Promise<void>;
  };
  app: {
    info(): Promise<AppInfo>;
  };
  agent: {
    kill(): Promise<void>;
    resume(): Promise<void>;
  };
}

export const IPC = {
  tabsList: "tabs:list",
  tabsCreate: "tabs:create",
  tabsClose: "tabs:close",
  tabsActivate: "tabs:activate",
  tabsReorder: "tabs:reorder",
  tabsSetBounds: "tabs:set-bounds",
  navBack: "nav:back",
  navForward: "nav:forward",
  navReload: "nav:reload",
  navGoto: "nav:goto",
  hudEvent: "hud:event",
  hudResolveApproval: "hud:resolve-approval",
  appInfo: "app:info",
  agentKill: "agent:kill",
  agentResume: "agent:resume",
} as const;
