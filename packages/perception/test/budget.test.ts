import { describe, expect, it } from "vitest";
import { buildSnapshot, MAX_REF_NODES } from "../src/index.js";
import type { RawPageData } from "../src/index.js";
import { syntheticPage } from "./helpers.js";

function pageWith(count: number): RawPageData {
  const { ax, boxes } = syntheticPage(count);
  return {
    tabId: "t-budget",
    url: "https://example.com/list",
    title: "Budget",
    viewport: { width: 1280, height: 800 },
    scroll: { x: 0, y: 0, maxY: 0 },
    ax,
    boxes,
    now: 1_760_000_000_000,
  };
}

const BUDGET = 2_000;

describe("token budget", () => {
  const raw = pageWith(300);
  const snapshot = buildSnapshot(raw, { snapshotId: "s-budget", maxChars: BUDGET });

  it("keeps every ref but truncates the text", () => {
    expect(snapshot.refs).toHaveLength(300);
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.text.length).toBeLessThanOrEqual(BUDGET);
  });

  it("marks the truncation in-band", () => {
    const lines = snapshot.text.split("\n");
    const last = lines[lines.length - 1] ?? "";
    expect(last).toMatch(/^… \(\+\d+ more refs, truncated — raise maxChars or scroll\)$/);
    const dropped = Number(last.match(/\+(\d+)/)?.[1] ?? "0");
    expect(dropped).toBeGreaterThan(0);
    expect(lines.length - 2 + dropped).toBe(snapshot.refs.length);
  });

  it("spends the budget on interactive refs before text refs", () => {
    const refLines = snapshot.text.split("\n").slice(1, -1);
    const buttons = snapshot.refs.filter((ref) => ref.role === "button");
    expect(buttons.length).toBe(30);
    expect(refLines.length).toBeGreaterThan(buttons.length);

    const firstTextLine = refLines.findIndex((line) => !line.includes('button "Action'));
    expect(firstTextLine).toBe(buttons.length);
    for (const line of refLines.slice(0, buttons.length)) {
      expect(line).toMatch(/\[e\d+\] button "Action \d+"/);
    }

    const shownRefs = new Set(refLines.map((line) => line.slice(0, line.indexOf("]") + 1)));
    for (const button of buttons) {
      expect(shownRefs.has(`[${button.ref}]`)).toBe(true);
    }
  });

  it("fits the whole page when the budget allows", () => {
    const roomy = buildSnapshot(raw, { snapshotId: "s-roomy", maxChars: 200_000 });
    expect(roomy.truncated).toBe(false);
    expect(roomy.text.split("\n")).toHaveLength(301);
    expect(roomy.text).not.toContain("truncated");
  });

  it("caps box resolution at MAX_REF_NODES", () => {
    const big = pageWith(MAX_REF_NODES + 150);
    const capped = buildSnapshot(big, { snapshotId: "s-capped", maxChars: 200_000 });
    expect(capped.refs).toHaveLength(MAX_REF_NODES);
  });
});
