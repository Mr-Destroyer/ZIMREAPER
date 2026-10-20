import { describe, expect, it } from "vitest";
import { buildSelectorMap, buildSnapshot, createPerception } from "../src/index.js";
import type { CdpDomNode } from "../src/selectors.js";
import type { RawPageData } from "../src/index.js";
import { createFakeCdp, loadFixture } from "./helpers.js";
import type { FakeCdp } from "./helpers.js";

const LOGIN = loadFixture("ax-login");

const LOGIN_DOM: CdpDomNode = {
  nodeType: 9,
  nodeName: "#document",
  children: [
    {
      nodeType: 1,
      nodeName: "HTML",
      backendNodeId: 1,
      children: [
        {
          nodeType: 1,
          nodeName: "BODY",
          backendNodeId: 2,
          children: [
            {
              nodeType: 1,
              nodeName: "FORM",
              backendNodeId: 3,
              attributes: ["id", "login"],
              children: [
                { nodeType: 1, nodeName: "INPUT", backendNodeId: 5, attributes: ["id", "email"] },
                { nodeType: 1, nodeName: "INPUT", backendNodeId: 6, attributes: ["class", "field css-1x2y3z"] },
              ],
            },
          ],
        },
      ],
    },
  ],
};

function fakeFrom(raw: RawPageData, dom?: CdpDomNode): FakeCdp {
  const copy = structuredClone(raw);
  return createFakeCdp({
    url: copy.url,
    title: copy.title,
    viewport: copy.viewport,
    scroll: copy.scroll,
    ax: copy.ax,
    boxes: copy.boxes,
    dom,
  });
}

describe("buildSelectorMap", () => {
  it("prefers a unique id, then a stable class, then nth-of-type", () => {
    const map = buildSelectorMap(LOGIN_DOM);
    expect(map["1"]).toBe("html");
    expect(map["2"]).toBe("body");
    expect(map["3"]).toBe("#login");
    expect(map["5"]).toBe("#email");
    // Both inputs share the class, so the path needs the position to be unique.
    expect(map["6"]).toBe("#login > input.field:nth-of-type(2)");
  });

  it("ignores generated class names", () => {
    const map = buildSelectorMap(LOGIN_DOM);
    expect(JSON.stringify(map)).not.toContain("css-1x2y3z");
  });

  it("walks past duplicate ids to an nth-of-type chain", () => {
    const dom: CdpDomNode = {
      nodeType: 9,
      nodeName: "#document",
      children: [
        {
          nodeType: 1,
          nodeName: "HTML",
          backendNodeId: 1,
          children: [
            {
              nodeType: 1,
              nodeName: "BODY",
              backendNodeId: 2,
              children: [
                { nodeType: 1, nodeName: "DIV", backendNodeId: 7, attributes: ["id", "dup"] },
                { nodeType: 1, nodeName: "DIV", backendNodeId: 8, attributes: ["id", "dup"] },
              ],
            },
          ],
        },
      ],
    };
    const map = buildSelectorMap(dom);
    expect(map["7"]).toBe("body > div:nth-of-type(1)");
    expect(map["8"]).toBe("body > div:nth-of-type(2)");
  });

  it("is stable across runs", () => {
    expect(buildSelectorMap(LOGIN_DOM)).toEqual(buildSelectorMap(LOGIN_DOM));
  });
});

describe("determinism", () => {
  it("produces identical refs, pageHash and text for identical input", () => {
    const a = buildSnapshot(LOGIN, { snapshotId: "s-fixed" });
    const b = buildSnapshot(LOGIN, { snapshotId: "s-fixed" });
    expect(b.refs).toEqual(a.refs);
    expect(b.pageHash).toBe(a.pageHash);
    expect(b.text).toBe(a.text);
  });

  it("changes the pageHash when an interactive name changes", () => {
    const mutated = structuredClone(LOGIN);
    const button = mutated.ax.find((node) => node.nodeId === "7");
    if (!button?.name) throw new Error("fixture missing button name");
    button.name.value = "Log in";
    const before = buildSnapshot(LOGIN, { snapshotId: "s-1" });
    const after = buildSnapshot(mutated, { snapshotId: "s-2" });
    expect(after.pageHash).not.toBe(before.pageHash);
  });
});

describe("createPerception", () => {
  it("caches by pageHash, bumps generation on change, and invalidates refs", async () => {
    const fake = fakeFrom(LOGIN, LOGIN_DOM);
    const perception = createPerception({ send: () => fake.send, now: () => 1_760_000_000_000 });

    const first = await perception.snapshot("t1");
    expect(first.generation).toBe(1);
    expect(first.tabId).toBe("t1");
    expect(first.createdAt).toBe(1_760_000_000_000);
    expect(first.refs).toHaveLength(7);
    expect(perception.ref("t1", "e3")?.name).toBe("Email");
    expect(perception.ref("t1", "e3")?.selector).toBe("#email");
    expect(perception.ref("t1", "e4")?.selector).toBe("#login > input.field:nth-of-type(2)");
    expect(perception.generation("t1")).toBe(1);
    expect(perception.pageHash("t1")).toBe(first.pageHash);

    const cached = await perception.snapshot("t1");
    expect(cached.snapshotId).toBe(first.snapshotId);
    expect(cached.text).toBe(first.text);
    expect(perception.generation("t1")).toBe(1);

    const tight = await perception.snapshot("t1", { maxChars: 220 });
    expect(tight.snapshotId).toBe(first.snapshotId);
    expect(tight.truncated).toBe(true);

    const forced = await perception.snapshot("t1", { cache: false });
    expect(forced.snapshotId).not.toBe(first.snapshotId);
    expect(perception.generation("t1")).toBe(2);

    fake.page.title = "Sign in — changed";
    const third = await perception.snapshot("t1");
    expect(third.snapshotId).not.toBe(first.snapshotId);
    expect(third.generation).toBe(3);
    expect(third.pageHash).not.toBe(first.pageHash);

    const diff = await perception.diff("t1", first.snapshotId);
    expect(diff.since).toBe(first.snapshotId);
    expect(diff.snapshotId).toBe(third.snapshotId);
    expect(diff.pageHashChanged).toBe(true);

    perception.invalidate("t1");
    expect(perception.ref("t1", "e3")).toBeUndefined();
    expect(perception.pageHash("t1")).toBeUndefined();
    expect(perception.generation("t1")).toBe(3);

    const fourth = await perception.snapshot("t1");
    expect(fourth.generation).toBe(4);
  });

  it("resolves boxes only for candidates, and skips ignored nodes", async () => {
    const fake = fakeFrom(LOGIN, LOGIN_DOM);
    const perception = createPerception({ send: () => fake.send, now: () => 1 });
    await perception.snapshot("t1");

    const boxCalls = fake.calls.filter((call) => call.method === "DOM.getBoxModel");
    expect(boxCalls).toHaveLength(9);
    const requested = boxCalls.map((call) => Number(call.params?.backendNodeId));
    expect(requested).not.toContain(14); // ignored AX node
    expect(fake.calls.map((call) => call.method)).toContain("Accessibility.getFullAXTree");
    expect(fake.calls.map((call) => call.method)).toContain("DOM.getDocument");
    expect(fake.calls.map((call) => call.method)).toContain("Page.getLayoutMetrics");
  });

  it("rejects a diff against an unknown snapshot", async () => {
    const fake = fakeFrom(LOGIN);
    const perception = createPerception({ send: () => fake.send, now: () => 1 });
    await perception.snapshot("t1");
    await expect(perception.diff("t1", "s-missing")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  });

  it("reports no changes when nothing moved", async () => {
    const fake = fakeFrom(LOGIN);
    const perception = createPerception({ send: () => fake.send, now: () => 1 });
    const snapshot = await perception.snapshot("t1");
    const diff = await perception.diff("t1", snapshot.snapshotId);
    expect(diff.text).toBe(`diff snap=${snapshot.snapshotId}->${snapshot.snapshotId}  +0 -0 ~0  pageHash=same`);
  });
});
