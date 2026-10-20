import { describe, expect, it } from "vitest";
import { buildSnapshot, diffSnapshots } from "../src/index.js";
import type { RawPageData } from "../src/index.js";
import { loadFixture } from "./helpers.js";

const LOGIN = loadFixture("ax-login");

function withEmailValue(raw: RawPageData, value: string): RawPageData {
  const copy = structuredClone(raw);
  const email = copy.ax.find((node) => node.nodeId === "5");
  if (!email?.value) throw new Error("fixture missing email value");
  email.value.value = value;
  return copy;
}

/** Swap the "Load more" button for a "Next" link, as a paginated list would. */
function paginate(raw: RawPageData): RawPageData {
  const copy = structuredClone(raw);
  const root = copy.ax.find((node) => node.nodeId === "2");
  if (!root?.childIds) throw new Error("fixture missing container");
  root.childIds = root.childIds.filter((id) => id !== "12");
  copy.ax = copy.ax.filter((node) => node.nodeId !== "12");
  copy.ax.push({
    nodeId: "14",
    backendDOMNodeId: 15,
    role: { value: "link" },
    name: { value: "Next" },
  });
  root.childIds.push("14");
  copy.boxes["15"] = { x: 600, y: 428, width: 80, height: 20 };
  return copy;
}

const prev = buildSnapshot(withEmailValue(LOGIN, "a"), { snapshotId: "s-prev" });
const next = buildSnapshot(paginate(withEmailValue(LOGIN, "ab")), { snapshotId: "s-next" });

describe("diffSnapshots", () => {
  it("reports added, removed and changed refs with compact text", () => {
    const diff = diffSnapshots(prev, next);
    expect(diff.snapshotId).toBe("s-next");
    expect(diff.since).toBe("s-prev");
    expect(diff.pageHashChanged).toBe(true);

    expect(diff.added.map((ref) => `${ref.ref}:${ref.name}`)).toEqual(["e7:Next"]);
    expect(diff.removed.map((ref) => `${ref.ref}:${ref.name}`)).toEqual(["e7:Load more"]);
    expect(diff.changed).toEqual([
      { ref: "e3", before: 'value "a"', after: 'value "ab"' },
    ]);

    expect(diff.text.split("\n")).toEqual([
      "diff snap=s-prev->s-next  +1 -1 ~1  pageHash=changed",
      '+ [e7] link "Next" @(600,428) 80x20',
      '- [e7] button "Load more" @(412,1800) 240x40',
      '~ [e3] value "a" -> "ab"',
    ]);
  });

  it("is silent when nothing changed", () => {
    const diff = diffSnapshots(prev, prev);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
    expect(diff.pageHashChanged).toBe(false);
    expect(diff.text).toBe("diff snap=s-prev->s-prev  +0 -0 ~0  pageHash=same");
  });

  it("matches identical content by textHash even when the selector moved", () => {
    const a = buildSnapshot(LOGIN, { snapshotId: "s-a", selectors: { "5": "#login > input.field" } });
    const b = buildSnapshot(LOGIN, {
      snapshotId: "s-b",
      selectors: { "5": "form > input:nth-of-type(1)" },
    });
    const diff = diffSnapshots(a, b);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  it("describes a rename instead of add + remove when the selector pins the element", () => {
    const base = buildSnapshot(LOGIN, {
      snapshotId: "s-a",
      selectors: { "8": "a.forgot" },
    });
    const renamed = structuredClone(base);
    renamed.snapshotId = "s-b";
    const link = renamed.refs.find((ref) => ref.name === "Forgot password?");
    if (!link) throw new Error("expected the forgot-password link");
    link.name = "Forgot your password?";
    link.textHash = "0".repeat(12);

    const diff = diffSnapshots(base, renamed);
    expect(diff.added).toEqual([]);
    expect(diff.removed).toEqual([]);
    expect(diff.changed).toEqual([
      { ref: link.ref, before: 'name "Forgot password?"', after: 'name "Forgot your password?"' },
    ]);
    expect(diff.text).toContain('~ [e6] name "Forgot password?" -> "Forgot your password?"');
  });
});
