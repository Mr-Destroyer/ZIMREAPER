import { contextBridge, ipcRenderer } from "electron";
import type { DesktopBridge, HudEvent, TabSnapshot, TabViewState } from "../shared/ipc.js";
import { IPC } from "../shared/ipc.js";

const bridge: DesktopBridge = {
  tabs: {
    list: () => ipcRenderer.invoke(IPC.tabsList) as Promise<TabSnapshot>,
    create: (url?: string) => ipcRenderer.invoke(IPC.tabsCreate, url) as Promise<TabViewState>,
    close: (tabId: string) => ipcRenderer.invoke(IPC.tabsClose, tabId) as Promise<void>,
    activate: (tabId: string) => ipcRenderer.invoke(IPC.tabsActivate, tabId) as Promise<void>,
    reorder: (tabIds: string[]) => ipcRenderer.invoke(IPC.tabsReorder, tabIds) as Promise<void>,
    setContentBounds: (bounds) => ipcRenderer.invoke(IPC.tabsSetBounds, bounds) as Promise<void>,
  },
  nav: {
    back: () => ipcRenderer.invoke(IPC.navBack) as Promise<void>,
    forward: () => ipcRenderer.invoke(IPC.navForward) as Promise<void>,
    reload: () => ipcRenderer.invoke(IPC.navReload) as Promise<void>,
    goto: (url: string) => ipcRenderer.invoke(IPC.navGoto, url) as Promise<void>,
  },
  hud: {
    subscribe: (cb: (event: HudEvent) => void) => {
      const listener = (_event: Electron.IpcRendererEvent, value: HudEvent) => cb(value);
      ipcRenderer.on(IPC.hudEvent, listener);
      return () => ipcRenderer.removeListener(IPC.hudEvent, listener);
    },
    resolveApproval: (id: string, approved: boolean) => ipcRenderer.invoke(IPC.hudResolveApproval, id, approved) as Promise<void>,
  },
  app: {
    info: () => ipcRenderer.invoke(IPC.appInfo) as ReturnType<DesktopBridge["app"]["info"]>,
  },
  agent: {
    kill: () => ipcRenderer.invoke(IPC.agentKill) as Promise<void>,
    resume: () => ipcRenderer.invoke(IPC.agentResume) as Promise<void>,
  },
};

contextBridge.exposeInMainWorld("zimreaper", bridge);
