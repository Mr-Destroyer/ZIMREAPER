#!/usr/bin/env node
/**
 * Prove the packaged AppImage is really three products in one file.
 *
 *   1. CLI      — `AppImage --help` runs our CLI on Electron's bundled Node, no system node needed
 *   2. MCP      — `AppImage mcp --launch` serves 21 tools and drives a browser on its own
 *   3. attach   — `AppImage` in serve mode holds a live session; `AppImage mcp` attaches to it
 *
 * Step 3 is the one that matters: it is exactly what Claude Desktop or Hermes does when a user
 * points their MCP config at the AppImage.
 *
 * Usage: node scripts/appimage-check.mjs [path/to.AppImage]
 */
import { execFile, spawn } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { promisify } from "node:util";
import path from "node:path";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");

const image =
  process.argv[2] ??
  path.join(
    ROOT,
    "dist",
    readdirSync(path.join(ROOT, "dist")).find((f) => f.endsWith(".AppImage")) ?? "missing.AppImage",
  );
if (!existsSync(image)) {
  console.error(`no AppImage at ${image} — run: node scripts/package-linux.mjs`);
  process.exit(2);
}

const results = [];
const check = (name, ok, detail = "") => {
  results.push(ok);
  process.stdout.write(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}\n`);
};

const home = (name) => {
  const dir = path.join("/tmp", `zr-img-${name}`);
  return dir;
};

// 1. CLI personality
try {
  const { stdout } = await execFileAsync(image, ["--help"], { timeout: 60_000 });
  check("AppImage runs the CLI on its bundled Node", stdout.includes("zimreaper replay") && stdout.includes("--connect"));
} catch (err) {
  check("AppImage runs the CLI on its bundled Node", false, err.message);
}

// 2. MCP personality, self-launching a browser
{
  const dir = home("mcp");
  await rm(dir, { recursive: true, force: true });
  try {
    const { stdout } = await execFileAsync(process.execPath, [path.join(ROOT, "scripts/mcp-check.mjs")], {
      timeout: 240_000,
      env: { ...process.env, ZIMREAPER_CLI: image, ZIMREAPER_MCP_HOME: dir, ZIMREAPER_HOME: dir },
    });
    check("AppImage mcp --launch serves tools and drives a browser", /TOOLS 21/.test(stdout) && /RESULT: PASS/.test(stdout));
  } catch (err) {
    check("AppImage mcp --launch serves tools and drives a browser", false, (err.stdout ?? err.message).slice(-300));
  }
}

// 3. Serve mode + attach: the real agent topology
{
  const dir = home("serve");
  await rm(dir, { recursive: true, force: true });
  const child = spawn(image, [], {
    env: { ...process.env, ZIMREAPER_HOME: dir, ZIMREAPER_SERVE: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (d) => (log += d.toString()));
  child.stderr.on("data", (d) => (log += d.toString()));

  const deadline = Date.now() + 45_000;
  let ready = false;
  while (Date.now() < deadline) {
    if (/serve-mode ws:\/\//.test(log)) {
      ready = true;
      break;
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  check("serve mode keeps a live session with no visible window", ready, ready ? "" : log.slice(-200));

  if (ready) {
    try {
      const { stdout } = await execFileAsync(process.execPath, [path.join(ROOT, "scripts/mcp-check.mjs"), "--attach"], {
        timeout: 240_000,
        env: { ...process.env, ZIMREAPER_CLI: image, ZIMREAPER_MCP_HOME: dir, ZIMREAPER_HOME: dir },
      });
      check("an MCP client attached to the running app completes a login", /TOOLS 21/.test(stdout) && /RESULT: PASS/.test(stdout));
    } catch (err) {
      check("an MCP client attached to the running app completes a login", false, (err.stdout ?? err.message).slice(-300));
    }
  }
  child.kill("SIGTERM");
  await new Promise((r) => setTimeout(r, 800));
  if (!child.killed) child.kill("SIGKILL");
  await rm(dir, { recursive: true, force: true }).catch(() => undefined);
}

const passed = results.filter(Boolean).length;
process.stdout.write(`\n${passed}/${results.length} checks passed\n`);
process.exitCode = passed === results.length ? 0 : 1;
