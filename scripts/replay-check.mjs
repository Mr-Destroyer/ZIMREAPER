#!/usr/bin/env node
/**
 * Replay exit check: record a real login, replay it in a fresh tab, prove divergence is caught.
 *
 *   1. record  — drive /login with mouse + keyboard through TraceRecorder
 *   2. replay  — open a new tab, re-run the trace, assert the same end state
 *   3. diverge — replay the same trace against a different page; must refuse, not click blind
 *
 * Usage: node scripts/replay-check.mjs
 */
import { spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.dirname(new URL(import.meta.url).pathname);
const PORT = "4321";
const home = await mkdtemp(path.join(tmpdir(), "zr-replay-"));
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
const replay = await import(path.join(ROOT, "..", "packages/replay/dist/index.js"));

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

const pick = (snap, role, re) => snap.refs.find((r) => r.role === role && re.test(r.name));
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
  client = await core.ControlClient.connect({ url: server.url, token: server.token, client: "replay" });
  const login = `http://127.0.0.1:${PORT}/login`;

  // ---- 1. record
  await client.act({ kind: "nav.goto", url: login, waitUntil: "load" });
  const recorder = new replay.TraceRecorder(client, { verify: true });
  await recorder.start();
  let snap = await client.query({ kind: "page.snapshot" });
  await recorder.step({ kind: "mouse.click", target: { ref: pick(snap, "textbox", /e-?mail/i).ref } });
  await recorder.step({ kind: "key.type", text: "replay@zimreaper.dev" });
  snap = await client.query({ kind: "page.snapshot" });
  await recorder.step({ kind: "mouse.click", target: { ref: pick(snap, "textbox", /pass(word)?/i).ref } });
  await recorder.step({ kind: "key.type", text: "zimreaper" });
  snap = await client.query({ kind: "page.snapshot" });
  await recorder.step({ kind: "mouse.click", target: { ref: pick(snap, "button", /sign in/i).ref } });
  await recorder.step({ kind: "page.wait", for: { text: "Welcome," }, timeoutMs: 15_000 });
  await recorder.checkpoint("after-login");

  const tracePath = path.join(home, "login.jsonl");
  await recorder.save(tracePath);
  const raw = await readFile(tracePath, "utf8");
  const parsed = replay.parseTrace(raw);
  const checkpoints = parsed.lines.filter((line) => line.kind === "checkpoint").length;
  const identified = recorder.steps.filter((s) => s.resolved && Object.keys(s.resolved).length > 0).length;
  check(
    "recorded a trace with identity for every ref",
    parsed.header.version === 1 &&
      checkpoints === 2 &&
      identified === recorder.steps.filter((s) => s.action.target).length &&
      recorder.steps.every((s) => !s.resolved || Object.values(s.resolved).every((r) => r.role && r.name)),
    `${recorder.steps.length} steps, ${identified} ref targets, ${checkpoints} checkpoints`,
  );

  // ---- 2. replay in a fresh tab
  const trace = await replay.loadTrace(tracePath);
  await client.act({ kind: "tab.new", url: login, active: true });
  await client.act({ kind: "page.wait", for: { selector: "form" }, timeoutMs: 15_000 });
  const report = await new replay.TracePlayer(client, trace).play();
  const textResult = await client.query({ kind: "page.text", maxChars: 4000 });
  const pageText = typeof textResult === "string" ? textResult : textResult?.text ?? "";
  check(
    "replayed every step in a fresh tab",
    report.passed === trace.steps.length && report.failed === 0 && report.divergences.length === 0,
    `${report.passed}/${report.total} in ${report.durationMs}ms`,
  );
  check("replay reproduced the end state", /Welcome, replay@zimreaper\.dev/.test(pageText), pageText.slice(0, 80).replace(/\s+/g, " "));

  // ---- 3. divergence: same trace, different page
  await client.act({ kind: "nav.goto", url: `http://127.0.0.1:${PORT}/table`, waitUntil: "load" });
  const drifted = await new replay.TracePlayer(client, trace).play();
  const kinds = drifted.divergences.map((d) => d.reason).join(",");
  check(
    "divergence detected instead of clicking blind",
    drifted.divergences.length > 0 && drifted.passed === 0,
    `${drifted.divergences.length} divergence(s): ${kinds}`,
  );
} catch (err) {
  check("replay run", false, err?.message ?? String(err));
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
