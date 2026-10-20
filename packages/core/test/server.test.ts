import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Action, Event, SessionInfo } from "@zimreaper/protocol";
import { ZimReaperError } from "@zimreaper/protocol";
import { ControlClient } from "../src/client.js";
import { startControlServer, type ControlServer } from "../src/server.js";
import { FakeBackend, FakePerception, FakePolicy } from "./fakes.js";

const TOKEN = "test-token-0123456789";

let server: ControlServer;
let client: ControlClient;
let backend: FakeBackend;
let perception: FakePerception;
let policy: FakePolicy;
let dir: string;

const click: Action = {
  kind: "mouse.click",
  target: { ref: "e1" },
  button: "left",
  clickCount: 1,
  modifiers: [],
  delayMs: 0,
};

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("condition not met in time");
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ZimReaperError) return err.code;
    throw err;
  }
  throw new Error("expected the call to fail");
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "zimreaper-server-test-"));
  backend = new FakeBackend();
  perception = new FakePerception();
  perception.setRef("e1", { backendNodeId: 42 });
  policy = new FakePolicy();
  server = await startControlServer({
    backend,
    perception,
    policyEngine: policy,
    token: TOKEN,
    tokenPath: join(dir, "control.token"),
    artifactsDir: join(dir, "artifacts"),
    sessionId: "s-test",
  });
  client = await ControlClient.connect({ url: server.url, token: TOKEN, client: "test" });
});

afterEach(async () => {
  client.close();
  await server.close();
});

describe("control server transport", () => {
  it("round-trips ping, act and query over a real websocket", async () => {
    expect(client.sessionId).toBe("s-test");
    expect(client.protocolVersion).toBe("0.1.0");

    const { result, meta } = await client.act(click);
    expect(result.clicked).toEqual({ x: 200, y: 230 });
    expect(meta?.tabId).toBe("t1");
    expect(meta?.backend).toBe("fake");

    const info = await client.query<SessionInfo>({ kind: "session.info" });
    expect(info.sessionId).toBe("s-test");
    expect(info.backend).toBe("fake");
    expect(info.policyMode).toBe("standard");
    expect(info.activeTabId).toBe("t1");
  });

  it("closes the socket with 4401 on a bad token", async () => {
    await expect(ControlClient.connect({ url: server.url, token: "wrong" })).rejects.toMatchObject({
      code: "UNAUTHORIZED",
    });
  });

  it("rejects a malformed action with BAD_REQUEST", async () => {
    const bad = { kind: "mouse.click", target: { ref: "not-a-ref" } } as unknown as Action;
    expect(await codeOf(client.act(bad))).toBe("BAD_REQUEST");
  });

  it("serializes actions per tab while queries stay concurrent", async () => {
    let active = 0;
    let peak = 0;
    backend.delayFor = (method) => (method === "DOM.getBoxModel" ? 150 : 0);
    backend.beforeRespond = (method) => {
      if (method !== "DOM.getBoxModel") return;
      active += 1;
      peak = Math.max(peak, active);
    };
    backend.afterRespond = (method) => {
      if (method === "DOM.getBoxModel") active -= 1;
    };

    const first = client.act(click);
    const second = client.act(click);
    await waitFor(() => active === 1);

    // A query resolves while an action is still mid-flight: queries are not queued behind acts.
    const tabs = await client.query<{ tabs: unknown[] }>({ kind: "tab.list" });
    expect(tabs.tabs).toHaveLength(1);
    expect(active).toBe(1);

    const [a, b] = await Promise.all([first, second]);
    expect(a.result.clicked).toBeDefined();
    expect(b.result.clicked).toBeDefined();
    // Two actions on one tab never overlap.
    expect(peak).toBe(1);
  });
});

describe("control server policy", () => {
  it("blocks an action the policy rejects", async () => {
    policy.verdict = "block";
    policy.reason = "origin is read-only";

    expect(await codeOf(client.act(click))).toBe("BLOCKED_BY_POLICY");
    expect(backend.calls).toHaveLength(0);
    expect(policy.entries.at(-1)?.outcome).toBe("block");
  });

  it("parks a confirm action until a human approves it", async () => {
    policy.verdict = "confirm";
    policy.reason = "destructive: send";

    const events: Event[] = [];
    client.on((event) => events.push(event));

    const pending = client.act(click);
    await waitFor(() => events.some((event) => event.kind === "approval.requested"));

    const requested = events.find(
      (event): event is Extract<Event, { kind: "approval.requested" }> => event.kind === "approval.requested",
    );
    expect(requested?.actionKind).toBe("mouse.click");

    server.resolveApproval(requested?.id ?? "", true);
    const { result } = await pending;

    expect(result.clicked).toEqual({ x: 200, y: 230 });
    await waitFor(() => events.some((event) => event.kind === "approval.resolved"));
    const resolved = events.find(
      (event): event is Extract<Event, { kind: "approval.resolved" }> => event.kind === "approval.resolved",
    );
    expect(resolved?.approved).toBe(true);
  });

  it("returns NEEDS_HUMAN when the approval times out", async () => {
    policy.verdict = "confirm";
    policy.reason = "destructive: delete";

    expect(await codeOf(client.act(click, { timeoutMs: 30_000 }))).toBe("NEEDS_HUMAN");
  }, 10_000);

  it("audits every executed action with a sha256 argsHash", async () => {
    const events: Event[] = [];
    client.on((event) => events.push(event));

    await client.act(click);
    await waitFor(() => events.some((event) => event.kind === "audit.entry"));

    const audit = events.find(
      (event): event is Extract<Event, { kind: "audit.entry" }> => event.kind === "audit.entry",
    );
    expect(audit?.entry.outcome).toBe("ok");
    expect(audit?.entry.kind).toBe("mouse.click");
    expect(audit?.entry.argsHash).toMatch(/^[a-f0-9]{64}$/);
    expect(audit?.entry.actor).toBe("test");
    expect(audit?.entry.sessionId).toBe("s-test");
  });

  it("emits action.started and action.finished around an act", async () => {
    const events: Event[] = [];
    client.on((event) => events.push(event));

    await client.act(click);
    await waitFor(() => events.some((event) => event.kind === "action.finished"));

    const started = events.find((event) => event.kind === "action.started") as
      | { actionKind?: string }
      | undefined;
    const finished = events.find((event) => event.kind === "action.finished") as
      | { ok?: boolean; actionKind?: string }
      | undefined;
    expect(started?.actionKind).toBe("mouse.click");
    expect(finished?.ok).toBe(true);
    expect(finished?.actionKind).toBe("mouse.click");
  });
});

describe("control server cancel", () => {
  it("aborts in-flight work for a tab", async () => {
    backend.responseFor = (method) => {
      if (method === "Page.getLayoutMetrics") return { cssLayoutViewport: { clientWidth: 1280, clientHeight: 800 } };
      return undefined;
    };
    const pending = client.act({ ...click, delayMs: 1_000 } as Action);
    await waitFor(() => backend.callsFor("Input.dispatchMouseEvent").length > 0);

    const { cancelled } = await client.cancel("t1");
    expect(cancelled).toBeGreaterThan(0);
    expect(await codeOf(pending)).toBe("CANCELLED");
  });
});
