/**
 * Electron shell entry point. Owns the window, tab WebContentsViews, the control server,
 * and the IPC bridge to the chrome UI. Placeholder until codex-shell lands the real shell.
 */
import { app, BrowserWindow } from "electron";

export async function createApp(): Promise<BrowserWindow> {
  await app.whenReady();
  const win = new BrowserWindow({ width: 1440, height: 900, show: true });
  return win;
}

app.whenReady().then(async () => {
  if (process.env.ZIMREAPER_HEADLESS_SMOKE === "1") {
    process.stdout.write("desktop-ready\n");
    app.quit();
    return;
  }
  await createApp();
});
