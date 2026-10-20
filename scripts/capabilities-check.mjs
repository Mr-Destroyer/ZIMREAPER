#!/usr/bin/env node
/**
 * Superhuman-capability check: the things a human browser session cannot do in one pass.
 *
 *   extract  schema-driven rows from a table without a DOM query language
 *   diff     what changed since a snapshot id (instead of re-reading the page)
 *   net      the request log the page itself never shows
 *   fork     N isolated tabs cloned from a live session
 *   cookies  read/write the jar directly
 *   eval     page JS under policy, in an isolated world
 *
 * Usage: node scripts/capabilities-check.mjs
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const PORT = "4318";
const home = await mkdtemp(path.join(tmpdir(), "zr-caps-"));
process.env.ZIMREAPER_HOME = home;

function chromiumPath() {
  if (process.env.ZIMREAPER_CHROMIUM) return process.env.ZIMREAPER_CHROMIUM;
  for (const candidate of ["/usr/bin/chromium", "/usr/bin/chromium-browser", "/usr/bin/google-chrome"]) {
    if (existsSync(candidate)) return candidate;
  }
  const cache = path.join(homedir(), ".cache", "ms-playwright");
  for (const dir of readdirSync(cache)) {
    const candidate = path.join(cache, dir, "chrome-linux", "chrome");
    if (existsSync(candidate)) return candidate;
  }
  throw new Error("no chromium found: set ZIMREAPER_CHROMIUM");
}

const core = await import(path.join(ROOT, "..", "packages/core/dist/index.js"));
const fixture = spawn(process.execPath, [path.join(ROOT, "..", "fixtures/site/server.mjs")], {
  env: { ...process.env, PORT },
  stdio: "ignore",
});
await new Promise((r) => setTimeout(r, 800));

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok });
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}\n`);
}

let backend;
let server;
let client;
try {
  backend = await core.launchCdpBackend({ executablePath: chromiumPath(), headless: true });
  server = await core.startControlServer({
    backend,
    artifactsDir: path.join(home, "artifacts"),
    policyDir: home,
    policy: { mode: "permissive" },
  });
  client = await core.ControlClient.connect({ url: server.url, token: server.token, client: "caps" });
  const base = `http://127.0.0.1:${PORT}`;

  // ---- extract: 25 rows, three fields, no CSS knowledge from the caller
  await client.act({ kind: "nav.goto", url: `${base}/table`, waitUntil: "load" });
  const rows = await client.query({
    kind: "page.extract",
    rowSelector: "#inventory tbody tr",
    fields: {
      name: { selector: "td:nth-child(1)" },
      price: { selector: "td:nth-child(2)" },
      stock: { selector: "td:nth-child(3)" },
    },
    limit: 50,
  });
  const list = rows?.rows ?? rows ?? [];
  check(
    "extract 25 rows x 3 fields",
    list.length === 25 && list[0]?.name === "Item 01" && /^\$/.test(list[0]?.price ?? ""),
    `${list.length} rows, first=${JSON.stringify(list[0])}`,
  );

  // ---- diff: only what changed after an async list load
  await client.act({ kind: "nav.goto", url: `${base}/spa`, waitUntil: "load" });
  const before = await client.query({ kind: "page.snapshot" });
  const loadBtn = before.refs.find((r) => r.role === "button" && /load list/i.test(r.name));
  await client.act({ kind: "mouse.click", target: { ref: loadBtn.ref } });
  await client.act({ kind: "page.wait", for: { text: "Async item 5" }, timeoutMs: 10_000 });
  const diff = await client.query({ kind: "page.diff", since: before.snapshotId });
  const added = diff?.added?.length ?? 0;
  const diffText = JSON.stringify(diff ?? {});
  check("diff reports only the new list items", added >= 5 && /Async item 5/.test(diffText), `${added} added`);

  // ---- net: the request log behind the page
  await client.act({ kind: "nav.goto", url: `${base}/net`, waitUntil: "load" });
  const netSnap = await client.query({ kind: "page.snapshot" });
  const chainBtn = netSnap.refs.find((r) => r.role === "button" && /run chain/i.test(r.name));
  await client.act({ kind: "mouse.click", target: { ref: chainBtn.ref } });
  await client.act({ kind: "page.wait", for: { text: "\"step\": \"C\"" }, timeoutMs: 10_000 });
  const net = await client.query({ kind: "net.log", limit: 100 });
  const entries = net?.entries ?? net ?? [];
  const urls = entries.map((e) => e.url ?? "").join(" ");
  check("net log captured the fetch chain", /\/net\/api\/a/.test(urls) && /\/net\/api\/c/.test(urls), `${entries.length} entries`);

  // ---- cookies: read the jar the page set
  await client.act({
    kind: "storage.cookies",
    op: "set",
    url: `${base}/net`,
    cookies: [{ name: "zr", value: "1", domain: "127.0.0.1", path: "/" }],
  });
  const cookies = await client.act({ kind: "storage.cookies", op: "get", url: `${base}/net` });
  const jar = cookies?.result?.cookies ?? [];
  check("cookie jar writable and readable", jar.some((c) => c.name === "zr"), `${jar.length} cookies`);

  // ---- fork: clone the live tab into two isolated tabs
  const tabsOf = (result) => (Array.isArray(result) ? result : result?.tabs ?? []);
  const beforeTabs = tabsOf(await client.query({ kind: "tab.list" }));
  const fork = await client.act({ kind: "session.fork", count: 2, url: `${base}/table` });
  const afterTabs = tabsOf(await client.query({ kind: "tab.list" }));
  const forked = fork?.result?.tabs ?? fork?.result ?? [];
  check(
    "fork session into 2 tabs",
    afterTabs.length === beforeTabs.length + 2,
    `${beforeTabs.length} -> ${afterTabs.length} tabs, ${Array.isArray(forked) ? forked.length : "?"} reported`,
  );

  // ---- eval: policy-gated page JS
  const evalResult = await client.act({ kind: "page.eval", expression: "2 + 2", awaitPromise: true });
  const value = evalResult?.result?.value ?? evalResult?.result?.result?.value ?? evalResult?.result;
  check("page.eval returns a value", String(value).includes("4"), JSON.stringify(value).slice(0, 80));
} catch (err) {
  check("capability run", false, err?.message ?? String(err));
} finally {
  try {
    client?.close?.();
    await server?.close?.();
    await backend?.close?.();
  } catch {
    /* ignore */
  }
  fixture.kill();
  await rm(home, { recursive: true, force: true }).catch(() => undefined);
  const passed = results.filter((r) => r.ok).length;
  process.stdout.write(`\n${passed}/${results.length} checks passed\n`);
  process.exitCode = passed === results.length ? 0 : 1;
}
