import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, test } from "playwright/test";
import type { Backend, ControlClient, ControlServer } from "@zimreaper/core";
import type { PolicyEngine } from "@zimreaper/policy";
import type { Action, Snapshot, TabInfo } from "@zimreaper/protocol";

const HERE = fileURLToPath(new URL(".", import.meta.url));
const ROOT = resolve(HERE, "../..");
const FIXTURE = process.env.ZIMREAPER_FIXTURE_URL ?? "http://127.0.0.1:4317";
const USE_ELECTRON = process.env.ZIMREAPER_E2E_ELECTRON === "1";
const CHROMIUM = process.env.ZIMREAPER_CHROMIUM ?? "/usr/bin/chromium";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function findRef(snapshot: Snapshot, role: RegExp, name: RegExp): { ref: string; role: string; name: string } {
  const ref =
    snapshot.refs.find((candidate) => role.test(candidate.role) && name.test(candidate.name)) ??
    snapshot.refs.find((candidate) => name.test(candidate.name));
  if (!ref) {
    const inventory = snapshot.refs.map((candidate) => `${candidate.ref}:${candidate.role}:${candidate.name}`).join(", ");
    throw new Error(`no ${name} ref in snapshot; refs: ${inventory || "(none)"}`);
  }
  return { ref: ref.ref, role: ref.role, name: ref.name };
}

/**
 * The Electron shell owns its control server. It must publish both the token and
 * the ephemeral port so the harness can connect; until it writes `control.port`
 * the explicit ZIMREAPER_CONTROL_URL/TOKEN pair is the escape hatch.
 */
async function electronEndpoint(home: string): Promise<{ url: string; token: string }> {
  const explicitUrl = process.env.ZIMREAPER_CONTROL_URL;
  const tokenPath = join(home, "control.token");
  const portPath = join(home, "control.port");
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (explicitUrl) {
      const token =
        process.env.ZIMREAPER_CONTROL_TOKEN ??
        (existsSync(tokenPath) ? readFileSync(tokenPath, "utf8").trim() : "");
      if (token) return { url: explicitUrl, token };
    } else if (existsSync(tokenPath) && existsSync(portPath)) {
      const token = readFileSync(tokenPath, "utf8").trim();
      const port = Number.parseInt(readFileSync(portPath, "utf8").trim(), 10);
      if (token && Number.isFinite(port)) return { url: `ws://127.0.0.1:${port}`, token };
    }
    await sleep(250);
  }
  throw new Error(
    "BLOCKED: Electron shell did not expose a control endpoint. Expected ZIMREAPER_HOME/control.port + control.token, " +
      "or ZIMREAPER_CONTROL_URL + ZIMREAPER_CONTROL_TOKEN. The desktop shell currently writes only control.token.",
  );
}

test("agent drives the fixture login through the control bus", async () => {
  const home = mkdtempSync(join(tmpdir(), "zimreaper-e2e-"));
  let backend: Backend | undefined;
  let server: ControlServer | undefined;
  let client: ControlClient | undefined;
  let policy: PolicyEngine | undefined;
  let policyModule: typeof import("@zimreaper/policy") | undefined;
  let electronApp: { close: () => Promise<void> } | undefined;

  try {
    let core: typeof import("@zimreaper/core");
    try {
      core = await import("@zimreaper/core");
      policyModule = await import("@zimreaper/policy");
    } catch (error) {
      throw new Error(`BLOCKED: cannot import @zimreaper/core or @zimreaper/policy: ${errorText(error)}`, {
        cause: error,
      });
    }
    if (!policyModule) throw new Error("BLOCKED: @zimreaper/policy did not load");
    const policyMod = policyModule;

    let endpoint: { url: string; token: string };
    if (USE_ELECTRON) {
      const { _electron } = await import("playwright");
      try {
        electronApp = await _electron.launch({
          args: [join(ROOT, "apps/desktop")],
          env: { ...process.env, ZIMREAPER_HOME: home },
        });
      } catch (error) {
        throw new Error(`BLOCKED: Electron launch failed: ${errorText(error)}`, { cause: error });
      }
      endpoint = await electronEndpoint(home);
    } else {
      try {
        backend = await core.launchCdpBackend({ executablePath: CHROMIUM, headless: true });
      } catch (error) {
        throw new Error(`BLOCKED: launchCdpBackend failed: ${errorText(error)}`, { cause: error });
      }
      try {
        policy = await policyMod.createPolicy({
          dir: home,
          sessionId: "e2e",
          config: { origins: { [new URL(FIXTURE).host]: { tier: "interact" } } },
        });
      } catch (error) {
        throw new Error(`BLOCKED: createPolicy failed: ${errorText(error)}`, { cause: error });
      }
      try {
        server = await core.startControlServer({
          backend,
          policyEngine: policy,
          policyDir: home,
          artifactsDir: join(home, "artifacts"),
          tokenPath: join(home, "control.token"),
          sessionId: "e2e",
          port: 0,
        });
      } catch (error) {
        throw new Error(`BLOCKED: startControlServer failed: ${errorText(error)}`, { cause: error });
      }
      endpoint = { url: server.url, token: server.token };
    }

    try {
      client = await core.ControlClient.connect({
        url: endpoint.url,
        token: endpoint.token,
        client: "e2e",
        timeoutMs: 60_000,
      });
    } catch (error) {
      throw new Error(`BLOCKED: ControlClient.connect failed: ${errorText(error)}`, { cause: error });
    }

    const events: string[] = [];
    client.on((event) => events.push(event.kind));

    const tabs = await client.query<{ tabs: TabInfo[]; activeTabId?: string }>({ kind: "tab.list" });
    let tabId = tabs.activeTabId ?? tabs.tabs[0]?.tabId;
    if (!tabId) {
      if (!backend) throw new Error("BLOCKED: no tab available in the Electron shell");
      const created = await backend.createTab({ url: "about:blank", active: true });
      tabId = created.tabId;
    }

    const goto = await client.act(
      { kind: "nav.goto", url: `${FIXTURE}/login`, waitUntil: "load" },
      { tabId },
    );
    expect(String(goto.meta?.url ?? "")).toContain("/login");
    await client.act(
      { kind: "page.wait", for: { selector: "#email" }, timeoutMs: 15_000, pollMs: 100 },
      { tabId },
    );

    const snapshot = await client.query<Snapshot>(
      {
        kind: "page.snapshot",
        mode: "both",
        maxChars: 20_000,
        includeFrames: false,
        interactiveOnly: false,
        cache: false,
      },
      { tabId },
    );
    const email = findRef(snapshot, /textbox|input/i, /email/i);
    const password = findRef(snapshot, /textbox|input/i, /password/i);
    const submit = findRef(snapshot, /button/i, /sign in/i);

    const emailClick = await client.act(
      {
        kind: "mouse.click",
        target: { ref: email.ref },
        button: "left",
        clickCount: 1,
        modifiers: [],
        delayMs: 24,
      },
      { tabId },
    );
    expect(emailClick.result).toMatchObject({ ref: email.ref });

    const typeEmail: Action = { kind: "key.type", text: "agent@example.com", delayMs: 4, clearFirst: false };
    await client.act(typeEmail, { tabId });

    await client.act(
      {
        kind: "mouse.click",
        target: { ref: password.ref },
        button: "left",
        clickCount: 1,
        modifiers: [],
        delayMs: 24,
      },
      { tabId },
    );
    await client.act({ kind: "key.type", text: "zimreaper", delayMs: 4, clearFirst: false }, { tabId });

    await client.act(
      {
        kind: "mouse.click",
        target: { ref: submit.ref },
        button: "left",
        clickCount: 1,
        modifiers: [],
        delayMs: 24,
      },
      { tabId },
    );

    await client.act(
      { kind: "page.wait", for: { text: "Welcome," }, timeoutMs: 20_000, pollMs: 100 },
      { tabId },
    );
    const page = await client.query<{ text: string }>({ kind: "page.text", maxChars: 4_000 }, { tabId });
    expect(page.text).toContain("Welcome, agent@example.com");

    const cookies = await client.act({ kind: "storage.cookies", op: "get", url: FIXTURE }, { tabId });
    expect(JSON.stringify(cookies.result)).toContain("zimreaper_session");

    const verifier = policy ?? (await policyMod.createPolicy({ dir: home, sessionId: "e2e-verify" }));
    const chain = verifier.verifyChain();
    expect(chain.ok).toBe(true);
    expect(chain.entries).toBeGreaterThanOrEqual(8);
    const tail = verifier.tail(100);
    expect(tail.some((entry) => entry.kind === "nav.goto" && entry.outcome === "ok")).toBe(true);
    expect(tail.some((entry) => entry.kind === "mouse.click" && entry.outcome === "ok")).toBe(true);

    expect(events).toContain("action.finished");
    expect(events).toContain("audit.entry");

    const kill = await client.act({ kind: "session.kill" }, { tabId });
    expect(kill.result).toMatchObject({ killed: true });
    const cancelled = await client.cancel(tabId);
    expect(cancelled.cancelled).toBeGreaterThanOrEqual(0);
    expect(verifier.verifyChain().ok).toBe(true);
    const finalTail = verifier.tail(100);
    const killEntry = finalTail.find((entry) => entry.kind === "session.kill");
    expect(killEntry).toBeDefined();
    expect(["kill", "ok"]).toContain(killEntry?.outcome);
  } finally {
    client?.close();
    await server?.close().catch(() => undefined);
    await backend?.close().catch(() => undefined);
    await electronApp?.close().catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
  }
});
