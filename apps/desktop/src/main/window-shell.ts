import { app, BrowserWindow, ipcMain, type IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { Event } from "@zimreaper/protocol";
import { ElectronBackend } from "./electron-backend.js";
import { startControl, type ControlBridge } from "./control.js";
import { TabManager } from "./tab-manager.js";
import { IPC, type AppInfo, type ChromeBounds, type HudEvent, type TabSnapshot } from "../shared/ipc.js";

export interface ShellOptions {
  headless: boolean;
  appVersion: string;
}

export interface Shell {
  window: BrowserWindow;
  backend: ElectronBackend;
  control: ControlBridge;
  tabs: TabManager;
  close(): Promise<void>;
}

const TOOLBAR_HEIGHT = 88;

function isChromeBounds(value: unknown): value is ChromeBounds {
  if (typeof value !== "object" || value === null) return false;
  const bounds = value as Record<string, unknown>;
  return ["x", "y", "width", "height"].every((key) => typeof bounds[key] === "number");
}

function preloadPath(): string {
  return join(app.getAppPath(), "dist", "preload.cjs");
}

function rendererEntry(): string {
  const devUrl = process.env.VITE_DEV_SERVER_URL;
  if (devUrl) return devUrl;
  return pathToFileURL(join(app.getAppPath(), "dist", "renderer", "index.html")).href;
}

export async function createShell(opts: ShellOptions): Promise<Shell> {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 860,
    minHeight: 600,
    show: !opts.headless,
    backgroundColor: "#0b0d10",
    title: "ZimReaper",
    titleBarStyle: process.platform === "darwin" ? "hiddenInset" : "default",
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      sandbox: false,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
    },
  });

  win.setMenuBarVisibility(false);

  let contentBounds: ChromeBounds = { x: 0, y: TOOLBAR_HEIGHT, width: 1440, height: 796 };
  let control: ControlBridge | undefined;
  let backend: ElectronBackend | undefined;

  const emitHud = (event: HudEvent): void => {
    if (!win.isDestroyed()) win.webContents.send(IPC.hudEvent, event);
  };

  const tabs = new TabManager({
    window: win,
    contentBounds: () => ({
      x: contentBounds.x,
      y: contentBounds.y,
      width: Math.max(1, contentBounds.width),
      height: Math.max(1, contentBounds.height),
    }),
    onEvent: (event) => {
      if ("kind" in event) {
        emitHud({ type: "protocol", event });
        if (event.kind === "human.input" || event.kind.startsWith("tab.")) backend?.publish(event);
      } else {
        emitHud(event);
      }
    },
    onHumanInput: () => {
      emitHud({ type: "agent.status", state: "paused", detail: "human input detected" });
    },
    onKill: () => {
      emitHud({ type: "agent.status", state: "paused", detail: "kill switch" });
      void control?.kill().catch(() => undefined);
    },
    onFocusUrl: () => emitHud({ type: "focus-url" }),
  });

  backend = new ElectronBackend(tabs, (tabId, x, y, label) => {
    if (tabs.activeTabId() === tabId) emitHud({ type: "ghost", cursor: { x, y, label } });
  });
  const activeBackend = backend;
  const controlStartup = await startControl(activeBackend, opts.appVersion);
  control = controlStartup.bridge;
  if (controlStartup.warning) emitHud({ type: "control.unavailable", message: controlStartup.warning });

  const unsubscribeControl = control.on((event: Event) => {
    emitHud({ type: "protocol", event });
    if (event.kind === "human.input" || event.kind === "agent.status" || event.kind === "approval.requested" || event.kind === "approval.resolved") {
      // These already reached the HUD above; the branch documents the high-value stream.
    }
  });

  ipcMain.handle(IPC.tabsList, async (): Promise<TabSnapshot> => tabs.snapshot());
  ipcMain.handle(IPC.tabsCreate, async (_event, url?: string) => {
    await activeBackend.createTab({ url: typeof url === "string" ? url : undefined, active: true });
    tabs.emitSnapshot();
    return tabs.listView().find((tab) => tab.tabId === tabs.activeTabId());
  });
  ipcMain.handle(IPC.tabsClose, async (_event, tabId: string) => {
    await activeBackend.closeTab(tabId);
  });
  ipcMain.handle(IPC.tabsActivate, async (_event, tabId: string) => {
    await activeBackend.activateTab(tabId);
  });
  ipcMain.handle(IPC.tabsReorder, async (_event, tabIds: string[]) => {
    if (Array.isArray(tabIds) && tabIds.every((id) => typeof id === "string")) tabs.reorder(tabIds);
  });
  ipcMain.handle(IPC.tabsSetBounds, async (_event, bounds: unknown) => {
    if (!isChromeBounds(bounds)) return;
    contentBounds = bounds;
    tabs.setBounds(bounds);
  });
  ipcMain.handle(IPC.navBack, async () => tabs.back());
  ipcMain.handle(IPC.navForward, async () => tabs.forward());
  ipcMain.handle(IPC.navReload, async () => tabs.reload());
  ipcMain.handle(IPC.navGoto, async (_event, url: string) => {
    if (typeof url === "string") tabs.goto(url);
  });
  ipcMain.handle(IPC.appInfo, async (): Promise<AppInfo> => ({
    port: control?.port ?? 0,
    token: control?.token ?? "",
    version: opts.appVersion,
    controlUrl: control?.url,
    controlAvailable: control?.available ?? false,
  }));
  ipcMain.handle(IPC.hudResolveApproval, async (_event, id: string, approved: boolean) => {
    if (typeof id === "string" && control) await control.resolveApproval(id, Boolean(approved));
  });
  ipcMain.handle(IPC.agentKill, async () => {
    emitHud({ type: "agent.status", state: "paused", detail: "killed by human" });
    if (control) {
      try {
        await control.kill();
      } catch {
        // The local pause still holds even if the bus is unavailable.
      }
    }
  });
  ipcMain.handle(IPC.agentResume, async () => {
    const tabId = tabs.activeTabId();
    if (tabId && control) await control.releaseHuman(tabId);
    emitHud({ type: "agent.status", state: "idle", detail: "human released control" });
  });

  win.webContents.on("did-finish-load", () => {
    tabs.emitSnapshot();
    emitHud({ type: "agent.status", state: "idle" });
  });

  await win.loadURL(rendererEntry());
  if (!tabs.activeTabId()) {
    await activeBackend.createTab({ active: true });
  }

  const close = async (): Promise<void> => {
    unsubscribeControl();
    await activeBackend.close();
    await control?.close();
    tabs.destroy();
    for (const channel of Object.values(IPC)) ipcMain.removeHandler(channel);
  };

  win.on("closed", () => {
    void close();
  });

  return { window: win, backend: activeBackend, control, tabs, close };
}

export function isIpcEventFromChrome(event: IpcMainInvokeEvent, win: BrowserWindow): boolean {
  return event.sender.id === win.webContents.id;
}
