import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const electron = resolve(root, "../../node_modules/electron/dist/electron");
const args = [root];

// Headless CI containers commonly lack the namespace/socket setup Chromium expects.
if (process.env.ZIMREAPER_HEADLESS_SMOKE === "1") {
  args.unshift("--no-sandbox", "--disable-setuid-sandbox", "--disable-gpu", "--disable-dev-shm-usage");
}
if (process.platform === "linux") {
  if (process.env.WAYLAND_DISPLAY) args.unshift("--ozone-platform=wayland");
  else args.unshift("--ozone-platform=x11");
}

const child = spawn(electron, args, { cwd: root, env: process.env, stdio: "inherit" });
child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
