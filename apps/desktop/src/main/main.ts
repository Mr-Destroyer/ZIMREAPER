import { app } from "electron";
import { createShell, type Shell } from "./window-shell.js";

const headless = process.env.ZIMREAPER_HEADLESS_SMOKE === "1";

if (process.platform === "linux") {
  if (process.env.WAYLAND_DISPLAY) app.commandLine.appendSwitch("ozone-platform", "wayland");
  else app.commandLine.appendSwitch("ozone-platform", "x11");
}

let shell: Shell | undefined;
let quitting = false;

async function shutdown(): Promise<void> {
  if (quitting) return;
  quitting = true;
  await shell?.close();
  shell = undefined;
}

app.on("window-all-closed", () => {
  void shutdown().finally(() => app.quit());
});

app.on("before-quit", (event) => {
  if (!shell) return;
  event.preventDefault();
  void shutdown().finally(() => app.quit());
});

async function main(): Promise<void> {
  await app.whenReady();
  const appVersion = app.getVersion();
  shell = await createShell({ headless, appVersion });
  if (headless) {
    const win = shell.window;
    await new Promise<void>((resolve) => {
      if (!win.webContents.isLoading()) resolve();
      else win.webContents.once("did-finish-load", () => resolve());
    });
    process.stdout.write(`desktop-ready ${shell.control.port}\n`);
    await shutdown();
    app.quit();
  }
}

void main().catch((error: unknown) => {
  process.stderr.write(`desktop failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  void shutdown().finally(() => app.exit(1));
});
