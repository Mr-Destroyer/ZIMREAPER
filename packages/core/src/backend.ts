import type { Event, NetEntry, TabInfo } from "@zimreaper/protocol";

export interface BackendCapabilities {
  name: string;
  tabs: boolean;
  screenshots: boolean;
  network: boolean;
  frames: boolean;
  domains: string[];
}

export interface CreateTabOptions {
  url?: string;
  active?: boolean;
  partition?: string;
  forkFrom?: string;
}

export type BackendListener = (event: Event) => void;

/** Raw CDP event tap for domains the protocol does not model (Fetch, Emulation, ...). */
export type CdpEventListener = (
  tabId: string,
  method: string,
  params: Record<string, unknown>,
) => void;

/**
 * The only Chromium-shaped interface in the system. Implementations:
 *  - CdpBackend      raw WebSocket to a Chromium debug port (tests, `zimreaper attach`)
 *  - ElectronBackend in-process webContents.debugger (the shipped app)
 *
 * Everything past `send` is optional so an implementation can omit what it cannot do;
 * the executor feature-detects rather than assuming.
 */
export interface Backend {
  readonly name: string;
  capabilities(): BackendCapabilities;
  listTabs(): Promise<TabInfo[]>;
  getTab(tabId: string): Promise<TabInfo | undefined>;
  createTab(opts?: CreateTabOptions): Promise<TabInfo>;
  closeTab(tabId: string): Promise<void>;
  activateTab(tabId: string): Promise<void>;
  activeTabId(): string | undefined;
  send<T = unknown>(
    tabId: string,
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string,
  ): Promise<T>;
  on(listener: BackendListener): () => void;
  close(): Promise<void>;

  /** Browser-level CDP (Browser.*) for implementations that can address the browser target. */
  sendBrowser?<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  /** In-flight network requests for a tab, feeding `page.wait {networkIdle}`. */
  inFlight?(tabId: string): number;
  /** Captured network entries for a tab, feeding `net.log` / `net.har` / `net.replay`. */
  netEntries?(tabId: string): NetEntry[];
  /** Raw CDP event stream for tabs, used by network surgery (Fetch.requestPaused). */
  onCdp?(listener: CdpEventListener): () => void;
}
