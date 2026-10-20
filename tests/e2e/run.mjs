#!/usr/bin/env node
/**
 * E2E orchestrator: start the fixture site, run the Playwright journey, always
 * stop the fixture, and exit with the spec's status.
 */
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "../..");
const FIXTURE_SERVER = join(ROOT, "fixtures/site/server.mjs");
const PLAYWRIGHT_CLI = join(ROOT, "node_modules/playwright/cli.js");
const CONFIG = join(HERE, "playwright.config.ts");

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function freePort() {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => resolve(port));
    });
  });
}

async function waitForFixture(url, fixture, logs) {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (fixture.exitCode !== null) {
      throw new Error(`fixture exited early (code ${fixture.exitCode})\n${logs()}`);
    }
    try {
      const response = await fetch(`${url}/healthz`);
      if (response.ok) return;
    } catch {
      // not listening yet
    }
    await sleep(100);
  }
  throw new Error(`fixture did not become ready at ${url}\n${logs()}`);
}

function runPlaywright(url) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [PLAYWRIGHT_CLI, "test", "--config", CONFIG], {
      cwd: ROOT,
      env: { ...process.env, ZIMREAPER_FIXTURE_URL: url },
      stdio: "inherit",
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => resolve(code ?? (signal ? 1 : 0)));
  });
}

async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  const exited = await Promise.race([
    new Promise((resolve) => child.once("exit", () => resolve(true))),
    sleep(2_000).then(() => false),
  ]);
  if (!exited) child.kill("SIGKILL");
}

async function main() {
  const requested = Number.parseInt(process.env.ZIMREAPER_E2E_FIXTURE_PORT ?? "", 10);
  const port = Number.isFinite(requested) && requested > 0 ? requested : await freePort();
  const url = `http://127.0.0.1:${port}`;
  const logs = [];

  const fixture = spawn(process.execPath, [FIXTURE_SERVER], {
    cwd: ROOT,
    env: { ...process.env, PORT: String(port), HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  fixture.stdout.on("data", (chunk) => logs.push(chunk.toString()));
  fixture.stderr.on("data", (chunk) => logs.push(chunk.toString()));
  fixture.on("error", (error) => logs.push(`fixture spawn error: ${error.message}\n`));

  let code = 1;
  try {
    if (!existsSync(PLAYWRIGHT_CLI)) throw new Error(`Playwright CLI missing at ${PLAYWRIGHT_CLI}`);
    await waitForFixture(url, fixture, () => logs.join("").slice(-4_000));
    console.log(`e2e fixture: ${url}`);
    code = await runPlaywright(url);
  } catch (error) {
    console.error(`E2E harness error: ${error instanceof Error ? error.message : String(error)}`);
    code = 1;
  } finally {
    await stop(fixture);
  }

  if (code !== 0) {
    console.error(
      "E2E did not pass. Check the first failure above; if it mentions a zod discriminator for `kind`, " +
        "the blocker is packages/protocol EventSchema (action.started/action.finished override the literal kind).",
    );
  }
  process.exit(code);
}

main().catch((error) => {
  console.error(`E2E harness crashed: ${error instanceof Error ? error.stack : String(error)}`);
  process.exit(1);
});
