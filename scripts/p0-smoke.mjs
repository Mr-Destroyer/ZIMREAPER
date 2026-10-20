#!/usr/bin/env node
/**
 * P0 exit check: drive the real stack end to end with real mouse/keyboard events.
 *
 *   fixture site -> Chromium (CDP) -> control server -> ControlClient -> assertions
 *
 * Phase A (permissive policy): log in on /login with mouse clicks and typed keys, assert the
 * welcome text, assert the audit hash chain verifies.
 * Phase B (standard policy, unknown origin): a click must be refused with BLOCKED_BY_POLICY.
 *
 * Usage: node scripts/p0-smoke.mjs [--headed] [--keep]
 */
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import process from "node:process";

const args = new Set(process.argv.slice(2));
const HEADED = args.has("--headed");
const KEEP = args.has("--keep");
const FIXTURE_PORT = 4310;
const ROOT = path.resolve(import.meta.dirname, "..");

const results = [];
let crashed = null;
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  const mark = ok ? "PASS" : "FAIL";
  process.stdout.write(`${mark}  ${name}${detail ? ` — ${detail}` : ""}\n`);
}
async function finish() {
  const failed = results.filter((r) => !r.ok);
  if (crashed) process.stdout.write(`\nCRASH: ${crashed?.stack ?? crashed}\n`);
  process.stdout.write(
    `\n${results.length - failed.length}/${results.length} checks passed${failed.length ? `, ${failed.length} failed` : ""}\n`,
  );
  process.exit(failed.length || crashed ? 1 : 0);
}

async function waitForHttp(url, timeoutMs = 10_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      if (res.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error(`fixture did not come up at ${url}`);
}

const home = await mkdtemp(path.join(tmpdir(), "zr-smoke-"));
process.env.ZIMREAPER_HOME = home;
process.env.ZIMREAPER_LOG = "warn";

let fixture;
let backend;
let serverA;
let serverB;
let clientA;
let clientB;

try {
  const core = await import(path.join(ROOT, "packages/core/dist/index.js"));
  const policyPkg = await import(path.join(ROOT, "packages/policy/dist/index.js"));

  fixture = spawn(process.execPath, [path.join(ROOT, "fixtures/site/server.mjs")], {
    env: { ...process.env, PORT: String(FIXTURE_PORT) },
    stdio: ["ignore", "pipe", "pipe"],
  });
  fixture.stderr.on("data", (d) => process.stderr.write(`[fixture] ${d}`));
  await waitForHttp(`http://127.0.0.1:${FIXTURE_PORT}/`);
  check("fixture site is up", true, `port ${FIXTURE_PORT}`);

  backend = await core.launchCdpBackend({
    executablePath: process.env.CHROMIUM_PATH ?? "/usr/bin/chromium",
    headless: !HEADED,
  });
  check("chromium launched over CDP", true, backend.name);

  serverA = await core.startControlServer({
    backend,
    artifactsDir: path.join(home, "artifacts"),
    policyDir: home,
    policy: { mode: "permissive" },
  });
  clientA = await core.ControlClient.connect({ url: serverA.url, token: serverA.token, client: "smoke" });
  const info = await clientA.query({ kind: "session.info" });
  check("control server handshake", info?.sessionId === serverA.sessionId, `session ${serverA.sessionId}`);

  const t0 = Date.now();
  await clientA.act(
    { kind: "nav.goto", url: `http://127.0.0.1:${FIXTURE_PORT}/login`, waitUntil: "load", timeoutMs: 20_000 },
    { timeoutMs: 25_000 },
  );
  check("navigate to /login", true, `${Date.now() - t0} ms`);

  let snap = await clientA.query({ kind: "page.snapshot" });
  check("snapshot has refs", Array.isArray(snap?.refs) && snap.refs.length > 0, `${snap?.refs?.length ?? 0} refs`);
  check("snapshot text is compact", typeof snap?.text === "string" && snap.text.length < 20_000, `${snap?.text?.length ?? 0} chars`);

  const byName = (re) => snap.refs.find((r) => re.test(r.name) || re.test(r.selector ?? ""));
  const email = byName(/e-?mail/i);
  const password = byName(/pass(word)?/i);
  const submit = byName(/sign in|log ?in|submit/i);
  check("found email/password/submit refs", Boolean(email && password && submit), [email?.ref, password?.ref, submit?.ref].join(","));
  if (!email || !password || !submit) throw new Error("cannot continue without refs");

  await clientA.act({ kind: "mouse.click", target: { ref: email.ref } });
  await clientA.act({ kind: "key.type", text: "agent@zimreaper.dev" });
  await clientA.act({ kind: "mouse.click", target: { ref: password.ref } });
  await clientA.act({ kind: "key.type", text: "hunter2-but-real" });
  await clientA.act({ kind: "mouse.click", target: { ref: submit.ref } });
  check("clicked and typed with real input events", true);

  await clientA.act({ kind: "page.wait", for: { text: "Welcome," }, timeoutMs: 15_000 });
  const text = await clientA.query({ kind: "page.text", maxChars: 4000 });
  check("login succeeded", /Welcome, agent@zimreaper\.dev/.test(text), text.slice(0, 120).replace(/\s+/g, " "));

  const tail = await clientA.query({ kind: "audit.tail", limit: 200 });
  check("audit entries written", Array.isArray(tail) && tail.length >= 6, `${tail?.length ?? 0} entries`);

  const verifier = await policyPkg.createPolicy({ dir: home, sessionId: serverA.sessionId });
  const chain = verifier.verifyChain();
  check("audit hash chain verifies", chain.ok === true, `${chain.entries} entries`);

  // ---- Phase B: trust boundary on an unknown origin under standard policy
  serverB = await core.startControlServer({
    backend,
    artifactsDir: path.join(home, "artifacts"),
    policyDir: home,
    policy: { mode: "standard" },
  });
  clientB = await core.ControlClient.connect({ url: serverB.url, token: serverB.token, client: "smoke-b" });
  await clientB.act(
    { kind: "nav.goto", url: `http://127.0.0.1:${FIXTURE_PORT}/table`, waitUntil: "load", timeoutMs: 20_000 },
    { timeoutMs: 25_000 },
  );
  const snapB = await clientB.query({ kind: "page.snapshot" });
  const firstLink = snapB.refs.find((r) => r.role === "link") ?? snapB.refs[0];
  let blocked = false;
  let code = "";
  try {
    await clientB.act({ kind: "mouse.click", target: { ref: firstLink.ref } });
  } catch (err) {
    blocked = true;
    code = err?.code ?? "unknown";
  }
  check("unknown origin click is refused", blocked && code === "BLOCKED_BY_POLICY", code);

  // ---- screenshot round-trip
  const shot = await clientB.act({ kind: "page.screenshot", fullPage: false });
  check("screenshot produced", Boolean(shot?.path || shot?.image), String(shot?.path ?? `${shot?.image?.length ?? 0} b64`));

  process.stdout.write(`\nartifacts: ${path.join(home, "artifacts")}\n`);
} catch (err) {
  crashed = err;
} finally {
  try {
    clientA?.close?.();
    clientB?.close?.();
    await serverA?.close?.();
    await serverB?.close?.();
    await backend?.close?.();
  } catch (err) {
    process.stderr.write(`cleanup: ${err}\n`);
  }
  fixture?.kill("SIGTERM");
  if (!KEEP) await rm(home, { recursive: true, force: true });
  else process.stdout.write(`kept: ${home}\n`);
  await finish();
}
