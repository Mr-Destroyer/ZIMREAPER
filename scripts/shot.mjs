import { _electron as electron } from "playwright";
import path from "node:path";

const ROOT = "/home/zim/Projects/ZIMREAPER";
const app = await electron.launch({
  executablePath: path.join(ROOT, "node_modules/electron/dist/electron"),
  args: [path.join(ROOT, "apps/desktop"), "--no-sandbox", "--ozone-platform=x11"],
  cwd: path.join(ROOT, "apps/desktop"),
});
app.process().stderr?.on("data", (d) => process.stderr.write(`[electron] ${d}`));
try {
  const win = await app.firstWindow({ timeout: 20_000 });
  await win.waitForTimeout(2500);
  console.log(JSON.stringify({ title: await win.title(), url: win.url() }));
  const dom = await win.evaluate(() => ({
    tabs: document.querySelectorAll("[role='tab'], .tab").length,
    inputs: document.querySelectorAll("input").length,
    buttons: document.querySelectorAll("button").length,
    hudText: (document.querySelector("[data-testid='hud'], .hud, aside")?.textContent ?? "").slice(0, 160),
  }));
  console.log(JSON.stringify(dom));
  const counts = await win.evaluate(() => ({
    tabs: document.querySelectorAll("[role='tab'], .tab").length,
    inputs: document.querySelectorAll("input").length,
    text: document.body.innerText.slice(0, 300),
  }));
  console.log(JSON.stringify(counts));
} catch (err) {
  console.log("NO WINDOW:", err.message.slice(0, 300));
  const wins = app.windows().length;
  console.log("windows:", wins);
}
await app.close().catch(() => undefined);
