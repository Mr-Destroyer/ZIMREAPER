import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const core = await import(path.join(ROOT, "packages/core/dist/index.js"));
const fx = spawn(process.execPath, [path.join(ROOT, "fixtures/site/server.mjs")], { env: { ...process.env, PORT: "4319" }, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 700));
const backend = await core.launchCdpBackend({ executablePath: "/usr/bin/chromium", headless: true });
const server = await core.startControlServer({ backend, policyDir: "/tmp/zr-shape", policy: { mode: "permissive" } });
const client = await core.ControlClient.connect({ url: server.url, token: server.token });
const base = "http://127.0.0.1:4319";

await client.act({ kind: "nav.goto", url: `${base}/spa`, waitUntil: "load" });
const before = await client.query({ kind: "page.snapshot" });
console.log("snapshot keys:", Object.keys(before));
const btn = before.refs.find((r) => r.role === "button" && /load list/i.test(r.name));
await client.act({ kind: "mouse.click", target: { ref: btn.ref } });
await client.act({ kind: "page.wait", for: { text: "Async item 5" }, timeoutMs: 8000 });
const after = await client.query({ kind: "page.snapshot" });
console.log("after refs:", after.refs.map((r) => `${r.ref}:${r.role}:${r.name}`).join(" | ").slice(0, 300));
const diff = await client.query({ kind: "page.diff", since: before.snapshotId });
console.log("diff:", JSON.stringify(diff).slice(0, 600));

await client.act({ kind: "nav.goto", url: `${base}/net`, waitUntil: "networkidle" });
const net = await client.query({ kind: "net.log", limit: 100 });
console.log("net keys:", Object.keys(net), "count", (net.entries ?? net).length);
console.log("net first:", JSON.stringify((net.entries ?? net)[0]).slice(0, 300));
console.log("net urls:", (net.entries ?? net).map((e) => e.url ?? e.request?.url).join(" , ").slice(0, 400));

const cookies = await client.act({ kind: "storage.cookies", op: "get", url: `${base}/net` });
console.log("cookies:", JSON.stringify(cookies.result).slice(0, 300));

client.close();
await server.close();
await backend.close();
fx.kill();
