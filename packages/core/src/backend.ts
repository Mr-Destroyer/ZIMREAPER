import type { Event, TabInfo } from "@zimreaper/protocol";

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

/**
 * The only Chromium-shaped interface in the system. Implementations:
 *  - CdpBackend      raw WebSocket to a Chromium debug port (tests, `zimreaper attach`)
 *  - ElectronBackend in-process webContents.debugger (the shipped app)
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
}
