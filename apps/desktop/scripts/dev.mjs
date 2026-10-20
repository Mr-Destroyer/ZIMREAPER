import { spawn } from "node:child_process";
import { createServer } from "vite";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

const server = await createServer({ configFile: resolve(root, "vite.config.ts") });
await server.listen();
const url = server.resolvedUrls?.local[0];
if (!url) throw new Error("Vite did not expose a local URL");
server.printUrls();

const electronBin = resolve(root, "../../node_modules/electron/cli.js");
const env = { ...process.env, VITE_DEV_SERVER_URL: url };
if (process.platform === "linux" && env.WAYLAND_DISPLAY) env.ELECTRON_OZONE_PLATFORM_HINT = "wayland";
const child = spawn(process.execPath, [electronBin, "."], { cwd: root, env, stdio: "inherit" });

const stop = async () => {
  if (!child.killed) child.kill("SIGTERM");
  await server.close();
  process.exit(0);
};
process.on("SIGINT", () => void stop());
process.on("SIGTERM", () => void stop());
child.on("exit", (code) => {
  void server.close().finally(() => process.exit(code ?? 0));
});
