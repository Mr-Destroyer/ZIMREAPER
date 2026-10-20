import { app } from "electron";
import { createShell, type Shell } from "./window-shell.js";

const smoke = process.env.ZIMREAPER_HEADLESS_SMOKE === "1";
/**
 * Serve mode: no visible window, control server stays up. This is what lets an agent drive the
 * packaged app on a host with no desktop session — same binary, same policy, same audit log.
 */
const serve = process.env.ZIMREAPER_SERVE === "1";
const headless = smoke;

// Agents drive tabs the user is not looking at, and serve mode has no visible window at all.
// Without these, Chromium backgrounds the renderer and Input.dispatchMouseEvent never acks.
app.commandLine.appendSwitch("disable-renderer-backgrounding");
app.commandLine.appendSwitch("disable-backgrounding-occluded-windows");

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
  if (serve) {
    // Serve mode must keep a mapped surface: an unmapped window never acks Input.dispatchMouseEvent,
    // so clicks from an agent would hang forever. Invisible to the user, real to Chromium.
    const win = shell.window;
    win.setOpacity(0);
    win.setSkipTaskbar(true);
    win.setIgnoreMouseEvents(true);
    win.showInactive();
    await new Promise<void>((resolve) => {
      if (!win.webContents.isLoading()) resolve();
      else win.webContents.once("did-finish-load", () => resolve());
    });
    process.stdout.write(`desktop-ready ${shell.control.port}\nserve-mode ${shell.control.url}\n`);
    return;
  }
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
