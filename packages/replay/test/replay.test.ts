import { describe, expect, it } from "vitest";
import type { Action, Snapshot } from "@zimreaper/protocol";
import {
  TRACE_VERSION,
  TracePlayer,
  TraceRecorder,
  parseTrace,
  toJSONL,
  traceHash,
  type ReplayClient,
  type TraceStep,
} from "../src/index.js";

function snapshot(overrides: Partial<Snapshot> = {}): Snapshot {
  return {
    snapshotId: "s1",
    tabId: "t1",
    url: "http://127.0.0.1/login",
    title: "Sign in",
    generation: 1,
    viewport: { width: 800, height: 600 },
    scroll: { x: 0, y: 0 },
    text: "",
    refs: [
      { ref: "e1", role: "textbox", name: "Email" },
      { ref: "e2", role: "textbox", name: "Password" },
      { ref: "e3", role: "button", name: "Sign in" },
    ],
    truncated: false,
    pageHash: "hash-1",
    createdAt: new Date().toISOString(),
    ...overrides,
  } as Snapshot;
}

class FakeClient implements ReplayClient {
  readonly acts: Action[] = [];
  constructor(
    public snaps: Snapshot[],
    private readonly failOn: string[] = [],
  ) {}

  async act(action: Action): Promise<{ result: unknown }> {
    this.acts.push(action);
    if (this.failOn.includes(action.kind)) {
      throw Object.assign(new Error("nope"), { code: "BLOCKED_BY_POLICY" });
    }
    return { result: { ok: true } };
  }

  async query<T>(query: { kind: string }): Promise<T> {
    if (query.kind !== "page.snapshot") throw new Error(`unexpected query ${query.kind}`);
    return (this.snaps.length > 1 ? this.snaps.shift() : this.snaps[0]) as T;
  }
}

const click = (ref: string): Action => ({ kind: "mouse.click", target: { ref } }) as Action;

describe("trace serialisation", () => {
  it("round-trips a trace through JSONL", () => {
    const client = new FakeClient([snapshot()]);
    const recorder = new TraceRecorder(client, { verify: false });
    return recorder.start().then(async () => {
      await recorder.step(click("e3"));
      const text = recorder.toJSONL();
      expect(text.split("\n").filter(Boolean)).toHaveLength(3);
      const trace = parseTrace(text);
      expect(trace.header.version).toBe(TRACE_VERSION);
      expect(trace.steps).toHaveLength(1);
      expect(trace.steps[0].action.kind).toBe("mouse.click");
    });
  });

  it("rejects a trace without a header", () => {
    expect(() => parseTrace('{"kind":"step","seq":0}')).toThrow(/no header/);
  });

  it("rejects an unsupported version", () => {
    expect(() => parseTrace('{"kind":"header","version":99,"createdAt":"","url":"","zimreaper":"x"}')).toThrow(
      /version 99/,
    );
  });

  it("rejects non-JSON lines", () => {
    expect(() => parseTrace("not json")).toThrow(/not JSON/);
  });

  it("hashes only the action body, so timestamps do not churn the hash", () => {
    const lines = toJSONL([
      { kind: "header", version: 1, createdAt: "a", url: "u", zimreaper: "0.1.0" },
      {
        kind: "step",
        seq: 0,
        ts: 1,
        action: click("e3"),
        ok: true,
        ms: 5,
      },
    ]);
    const other = toJSONL([
      { kind: "header", version: 1, createdAt: "b", url: "u", zimreaper: "0.1.0" },
      {
        kind: "step",
        seq: 9,
        ts: 999,
        action: click("e3"),
        ok: false,
        ms: 40,
      },
    ]);
    expect(traceHash(parseTrace(lines))).toBe(traceHash(parseTrace(other)));
  });
});

describe("recorder", () => {
  it("records the identity of every ref target, not just the session-scoped ref", async () => {
    const client = new FakeClient([snapshot()]);
    const recorder = new TraceRecorder(client, { verify: false });
    await recorder.start();
    await recorder.step(click("e3"));
    const step = recorder.steps[0];
    expect(step.resolved?.target).toMatchObject({ role: "button", name: "Sign in", ordinal: 0 });
    expect(step.hashBefore).toBe("hash-1");
  });

  it("records the ordinal of a repeated label", async () => {
    const snap = snapshot({
      refs: [
        { ref: "e1", role: "link", name: "details" },
        { ref: "e2", role: "link", name: "details" },
      ],
    } as Partial<Snapshot>);
    const recorder = new TraceRecorder(new FakeClient([snap]));
    await recorder.start();
    await recorder.step(click("e2"));
    expect(recorder.steps[0].resolved?.target.ordinal).toBe(1);
  });

  it("captures failures and rethrows with the protocol code", async () => {
    const client = new FakeClient([snapshot()], ["mouse.click"]);
    const recorder = new TraceRecorder(client);
    await recorder.start();
    await expect(recorder.step(click("e3"))).rejects.toMatchObject({ code: "BLOCKED_BY_POLICY" });
    expect(recorder.steps[0]).toMatchObject({ ok: false, error: { code: "BLOCKED_BY_POLICY" } });
  });
});

describe("player", () => {
  async function record(): Promise<{ text: string }> {
    const recorder = new TraceRecorder(new FakeClient([snapshot()]));
    await recorder.start();
    await recorder.step(click("e3"));
    await recorder.step({ kind: "key.type", text: "hello" } as Action);
    return { text: recorder.toJSONL() };
  }

  it("re-binds refs by role and name in a fresh session", async () => {
    const { text } = await record();
    const trace = parseTrace(text);
    // Same page, different ref numbering — the trace must still drive the right element.
    const shifted = snapshot({
      refs: [
        { ref: "e7", role: "heading", name: "Welcome" },
        { ref: "e8", role: "textbox", name: "Email" },
        { ref: "e9", role: "textbox", name: "Password" },
        { ref: "e10", role: "button", name: "Sign in" },
      ],
    } as Partial<Snapshot>);
    const client = new FakeClient([shifted]);
    const report = await new TracePlayer(client, trace).play();
    expect(report.failed).toBe(0);
    expect(report.divergences).toHaveLength(0);
    expect((client.acts[0] as { target: { ref: string } }).target.ref).toBe("e10");
  });

  it("reports a page-hash divergence instead of clicking blind", async () => {
    const { text } = await record();
    const trace = parseTrace(text);
    const drifted = snapshot({ pageHash: "hash-2" });
    const client = new FakeClient([drifted]);
    const report = await new TracePlayer(client, trace).play();
    expect(report.divergences[0]).toMatchObject({ reason: "page-hash", expected: "hash-1", actual: "hash-2" });
    expect(client.acts).toHaveLength(0);
  });

  it("reports a missing target", async () => {
    const { text } = await record();
    const trace = parseTrace(text);
    const gone = snapshot({ refs: [{ ref: "e1", role: "textbox", name: "Email" }] } as Partial<Snapshot>);
    const report = await new TracePlayer(new FakeClient([gone]), trace).play();
    expect(report.divergences[0].reason).toBe("target-missing");
  });

  it("can continue past a divergence when asked", async () => {
    const { text } = await record();
    const trace = parseTrace(text);
    const client = new FakeClient([snapshot({ pageHash: "hash-2" })]);
    const report = await new TracePlayer(client, trace, { stopOnDivergence: false }).play();
    expect(report.passed).toBeGreaterThan(0);
    expect(report.divergences.length).toBeGreaterThan(0);
  });

  it("counts a failed step and stops by default", async () => {
    const { text } = await record();
    const trace = parseTrace(text);
    const client = new FakeClient([snapshot()], ["mouse.click"]);
    const report = await new TracePlayer(client, trace).play();
    expect(report.failed).toBe(1);
    expect(report.passed).toBe(0);
    expect(report.divergences[0]).toMatchObject({ reason: "step-failed", actual: "BLOCKED_BY_POLICY" });
  });

  it("leaves the recorded action objects untouched", async () => {
    const { text } = await record();
    const trace = parseTrace(text);
    const before = JSON.stringify((trace.steps[0] as TraceStep).action);
    await new TracePlayer(new FakeClient([snapshot()]), trace).play();
    expect(JSON.stringify(trace.steps[0].action)).toBe(before);
  });
});
