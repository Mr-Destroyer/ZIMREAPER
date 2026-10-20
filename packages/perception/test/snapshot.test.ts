import { describe, expect, it } from "vitest";
import { buildSnapshot, renderSnapshotText } from "../src/index.js";
import type { RawPageData } from "../src/index.js";
import { loadFixture } from "./helpers.js";

const LOGIN = loadFixture("ax-login");
const TABLE = loadFixture("ax-table");

function snap(raw: RawPageData, id: string, maxChars = 12_000) {
  return buildSnapshot(raw, { snapshotId: id, generation: 1, maxChars });
}

const LOGIN_TEXT = `page: "Sign in — Example"  url=https://example.com/login  viewport=1280x800  scroll=0/2000  snap=s-login
[e3] textbox "Email" value="" @(412,318) 240x36
[e4] textbox "Password" value="" @(412,368) 240x36
[e5] button "Sign in" @(412,428) 240x40
[e6] link "Forgot password?" @(470,486) 96x18
[e7] button "Load more" @(412,1800) 240x40
[e1] heading "Sign in" @(412,280) 240x40
[e2] text "Welcome back" @(412,250) 240x20`;

const TABLE_TEXT = `page: "Orders — Example"  url=https://example.com/orders  viewport=1024x768  scroll=0/1200  snap=s-table
[e6] link "Shipped" @(672,150) 320x40
[e9] link "Pending" @(672,1900) 320x40
[e1] columnheader "Order" @(32,120) 320x30
[e2] columnheader "Total" @(352,120) 320x30
[e3] columnheader "Status" @(672,120) 320x30
[e4] cell "A-1001" @(32,150) 320x40
[e5] cell "$42.00" @(352,150) 320x40
[e7] cell "A-1002" @(32,1900) 320x40
[e8] cell "$7.50" @(352,1900) 320x40`;

describe("buildSnapshot / renderSnapshotText", () => {
  it("renders the login page golden", () => {
    const snapshot = snap(LOGIN, "s-login");
    expect(snapshot.text).toBe(LOGIN_TEXT);
    expect(snapshot.truncated).toBe(false);
    expect(renderSnapshotText(snapshot, 12_000)).toBe(LOGIN_TEXT);
  });

  it("renders the table page golden", () => {
    expect(snap(TABLE, "s-table").text).toBe(TABLE_TEXT);
  });

  it("allocates refs in DOM order and skips ignored, zero-size and boxless nodes", () => {
    const snapshot = snap(LOGIN, "s-login");
    expect(snapshot.refs.map((ref) => `${ref.ref}:${ref.role}:${ref.name}`)).toEqual([
      "e1:heading:Sign in",
      "e2:text:Welcome back",
      "e3:textbox:Email",
      "e4:textbox:Password",
      "e5:button:Sign in",
      "e6:link:Forgot password?",
      "e7:button:Load more",
    ]);
    const names = snapshot.refs.map((ref) => ref.name);
    expect(names).not.toContain("Hidden action");
    expect(names).not.toContain("Detached");
    expect(names).not.toContain("Ignored button");
  });

  it("stamps generation, page hash and text hash on every ref", () => {
    const snapshot = snap(LOGIN, "s-login");
    expect(snapshot.generation).toBe(1);
    expect(snapshot.pageHash).toMatch(/^[0-9a-f]{16}$/);
    for (const ref of snapshot.refs) {
      expect(ref.generation).toBe(1);
      expect(ref.textHash).toMatch(/^[0-9a-f]{12}$/);
    }
    const email = snapshot.refs.find((ref) => ref.ref === "e3");
    expect(email?.textHash).not.toBe(snapshot.refs.find((ref) => ref.ref === "e4")?.textHash);
  });

  it("renders textbox values and escapes quotes", () => {
    const raw: RawPageData = structuredClone(LOGIN);
    const email = raw.ax.find((node) => node.nodeId === "5");
    if (!email?.value) throw new Error("fixture missing email value");
    email.value.value = 'zim "the" reaper';
    const text = snap(raw, "s-values").text;
    expect(text).toContain('[e3] textbox "Email" value="zim \\"the\\" reaper" @(412,318) 240x36');
  });

  it("omits value= for roles that do not carry one", () => {
    const text = snap(LOGIN, "s-login").text;
    expect(text).toContain('[e5] button "Sign in" @(412,428) 240x40');
    expect(text).not.toContain('[e5] button "Sign in" value=');
  });

  it("truncates on line boundaries and marks the loss", () => {
    const snapshot = snap(LOGIN, "s-login", 220);
    expect(snapshot.truncated).toBe(true);

    const lines = snapshot.text.split("\n");
    const last = lines[lines.length - 1] ?? "";
    expect(last).toMatch(/^… \(\+\d+ more refs, truncated — raise maxChars or scroll\)$/);

    const shown = lines.slice(1, -1);
    expect(shown.length).toBeGreaterThan(0);
    for (const line of shown) {
      expect(line).toMatch(/^\[e\d+\] /);
      expect(LOGIN_TEXT.split("\n")).toContain(line);
    }
    const dropped = Number(last.match(/\+(\d+)/)?.[1] ?? "0");
    expect(shown.length + dropped).toBe(snapshot.refs.length);
  });

  it("honours interactiveOnly", () => {
    const snapshot = buildSnapshot(LOGIN, {
      snapshotId: "s-int",
      interactiveOnly: true,
      maxChars: 12_000,
    });
    expect(snapshot.refs.map((ref) => ref.role)).toEqual([
      "textbox",
      "textbox",
      "button",
      "link",
      "button",
    ]);
    expect(snapshot.text).not.toContain("heading");
  });

  it("attaches selectors supplied by the DOM pass", () => {
    const snapshot = buildSnapshot(LOGIN, {
      snapshotId: "s-sel",
      selectors: { "5": "#login > input.field" },
    });
    const email = snapshot.refs.find((ref) => ref.ref === "e3");
    expect(email?.selector).toBe("#login > input.field");
    expect(snapshot.refs.find((ref) => ref.ref === "e4")?.selector).toBeUndefined();
  });
});
