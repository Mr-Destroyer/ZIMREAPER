import { describe, expect, it } from "vitest";
import { classify, classifyQuery } from "../src/classify.js";
import { defaultPolicyConfig } from "../src/config.js";
import type { PolicyConfig, PolicyContext, Verdict } from "../src/types.js";
import {
  click,
  clickPoint,
  clipboardRead,
  clipboardWrite,
  configFor,
  ctx,
  dialogRespond,
  domFill,
  domSetFiles,
  humanRequest,
  keyPress,
  keyType,
  mouseHover,
  mouseMove,
  mouseWheel,
  nav,
  navGoto,
  netHar,
  netReplay,
  netRoute,
  pageEval,
  pagePdf,
  pageScreenshot,
  pageScroll,
  pageWait,
  sessionCancel,
  sessionKill,
  storageLocal,
} from "./helpers.js";

interface Case {
  name: string;
  action: ReturnType<typeof click>;
  context: PolicyContext;
  config: PolicyConfig;
  verdict: Verdict;
}

const read = configFor("example.com", "read");
const interact = configFor("example.com", "interact");
const interactEval = configFor("example.com", "interact", { allowEval: true });
const interactUpload = configFor("example.com", "interact", { allowUploads: true });
const transact = configFor("example.com", "transact");
const permissive = defaultPolicyConfig();
permissive.mode = "permissive";
const strict = defaultPolicyConfig();
strict.mode = "strict";
const strictInteract = configFor("example.com", "interact");
strictInteract.mode = "strict";
const permissiveInteract = configFor("example.com", "interact");
permissiveInteract.mode = "permissive";
const standard = defaultPolicyConfig();

const site = ctx("https://example.com/page");
const siteTainted = ctx("https://example.com/page", { tainted: true });

const cases: Case[] = [
  { name: "always allows session.kill", action: sessionKill(), context: site, config: standard, verdict: "allow" },
  { name: "always allows session.cancel", action: sessionCancel(), context: site, config: standard, verdict: "allow" },
  { name: "always allows human.request", action: humanRequest(), context: site, config: standard, verdict: "allow" },
  { name: "always allows page.wait", action: pageWait(), context: site, config: read, verdict: "allow" },
  { name: "always allows clipboard.read", action: clipboardRead(), context: site, config: read, verdict: "allow" },

  { name: "blocks file: origins", action: navGoto("file:///etc/passwd"), context: site, config: standard, verdict: "block" },
  { name: "blocks chrome: origins", action: navGoto("chrome://settings"), context: site, config: standard, verdict: "block" },
  {
    name: "blocks devtools: origins",
    action: navGoto("devtools://devtools/bundled/inspector.html"),
    context: site,
    config: standard,
    verdict: "block",
  },
  {
    name: "permissive mode allows non-http origins",
    action: navGoto("file:///etc/passwd"),
    context: site,
    config: permissive,
    verdict: "allow",
  },

  { name: "read tier allows navigation", action: navGoto("https://example.com/next"), context: site, config: read, verdict: "allow" },
  { name: "read tier allows back", action: nav("nav.back"), context: site, config: read, verdict: "allow" },
  { name: "read tier allows screenshots", action: pageScreenshot(), context: site, config: read, verdict: "allow" },
  { name: "read tier allows mouse.move", action: mouseMove(), context: site, config: read, verdict: "allow" },
  { name: "read tier allows mouse.wheel", action: mouseWheel(), context: site, config: read, verdict: "allow" },
  { name: "read tier allows mouse.hover", action: mouseHover(), context: site, config: read, verdict: "allow" },
  { name: "read tier allows page.scroll", action: pageScroll(), context: site, config: read, verdict: "allow" },
  { name: "read tier allows navigation keys", action: keyPress("ArrowDown"), context: site, config: read, verdict: "allow" },
  { name: "read tier blocks Space because it can activate a control", action: keyPress(" "), context: site, config: read, verdict: "block" },
  { name: "read tier blocks Enter", action: keyPress("Enter"), context: site, config: read, verdict: "block" },
  { name: "read tier blocks clicks", action: click(), context: site, config: read, verdict: "block" },
  { name: "read tier blocks fills", action: domFill(), context: site, config: read, verdict: "block" },
  { name: "read tier blocks typing", action: keyType(), context: site, config: read, verdict: "block" },
  { name: "read tier blocks eval", action: pageEval(), context: site, config: read, verdict: "block" },
  { name: "read tier blocks uploads", action: domSetFiles(), context: site, config: read, verdict: "block" },
  { name: "read tier blocks storage writes", action: storageLocal("set"), context: site, config: read, verdict: "block" },
  { name: "read tier allows storage reads", action: storageLocal("get"), context: site, config: read, verdict: "allow" },
  { name: "read tier blocks clipboard writes", action: clipboardWrite(), context: site, config: read, verdict: "block" },
  { name: "read tier blocks network routes", action: netRoute(), context: site, config: read, verdict: "block" },
  { name: "read tier allows HAR capture", action: netHar(), context: site, config: read, verdict: "allow" },

  { name: "interact tier allows clicks", action: click(), context: site, config: interact, verdict: "allow" },
  { name: "interact tier allows typing", action: keyType(), context: site, config: interact, verdict: "allow" },
  { name: "interact tier allows fills", action: domFill(), context: site, config: interact, verdict: "allow" },
  { name: "interact tier blocks eval by default", action: pageEval(), context: site, config: interact, verdict: "block" },
  { name: "interact tier allows eval with allowEval", action: pageEval(), context: site, config: interactEval, verdict: "allow" },
  { name: "interact tier blocks uploads by default", action: domSetFiles(), context: site, config: interact, verdict: "block" },
  {
    name: "interact tier allows uploads with allowUploads",
    action: domSetFiles(),
    context: site,
    config: interactUpload,
    verdict: "allow",
  },
  { name: "interact tier allows net.route", action: netRoute(), context: site, config: interact, verdict: "allow" },
  { name: "interact tier allows net.replay", action: netReplay(), context: site, config: interact, verdict: "allow" },
  { name: "interact tier allows storage writes", action: storageLocal("set"), context: site, config: interact, verdict: "allow" },
  { name: "interact tier allows clipboard writes", action: clipboardWrite(), context: site, config: interact, verdict: "allow" },
  { name: "interact tier allows dialog responses", action: dialogRespond(), context: site, config: interact, verdict: "allow" },
  { name: "interact tier allows PDFs", action: pagePdf(), context: site, config: interact, verdict: "allow" },

  { name: "transact tier allows eval", action: pageEval(), context: site, config: transact, verdict: "allow" },
  { name: "transact tier allows uploads", action: domSetFiles(), context: site, config: transact, verdict: "allow" },
  { name: "transact tier allows destructive clicks", action: click("#delete-account"), context: site, config: transact, verdict: "allow" },
  { name: "transact tier allows network routes", action: netRoute(), context: site, config: transact, verdict: "allow" },

  { name: "unknown origin defaults to read", action: click(), context: ctx("https://unknown.test/"), config: standard, verdict: "block" },
  { name: "unknown origin is interact in permissive", action: click(), context: ctx("https://unknown.test/"), config: permissive, verdict: "allow" },
  { name: "unknown origin stays read in strict", action: click(), context: ctx("https://unknown.test/"), config: strict, verdict: "block" },

  { name: "destructive click requires confirmation", action: click("#delete-account"), context: site, config: interact, verdict: "confirm" },
  { name: "camelCase destructive selectors require confirmation", action: click("#deleteAccount"), context: site, config: interact, verdict: "confirm" },
  { name: "hyphenated destructive phrases require confirmation", action: click("#buy-now"), context: site, config: interact, verdict: "confirm" },
  { name: "destructive pay click requires confirmation", action: click("#pay-now"), context: site, config: interact, verdict: "confirm" },
  { name: "ordinary click is allowed", action: click("#save"), context: site, config: interact, verdict: "allow" },
  { name: "word boundaries avoid postal/post", action: click("#postal-code"), context: site, config: interact, verdict: "allow" },
  { name: "destructive fill requires confirmation", action: domFill("#send-message"), context: site, config: interact, verdict: "confirm" },
  {
    name: "Enter on a destructive target requires confirmation",
    action: keyPress("Enter"),
    context: ctx("https://example.com/checkout", { target: { name: "Place order" } }),
    config: interact,
    verdict: "confirm",
  },
  {
    name: "Enter on a benign target is allowed",
    action: keyPress("Enter"),
    context: ctx("https://example.com/search", { target: { name: "Search" } }),
    config: interact,
    verdict: "allow",
  },
  { name: "read tier blocks destructive click before confirm", action: click("#delete-account"), context: site, config: read, verdict: "block" },

  { name: "tainted mutating action confirms in standard", action: click(), context: siteTainted, config: interact, verdict: "confirm" },
  { name: "tainted mutating action blocks in strict", action: click(), context: siteTainted, config: strictInteract, verdict: "block" },
  {
    name: "tainted mutating action is allowed in permissive",
    action: click(),
    context: siteTainted,
    config: permissiveInteract,
    verdict: "allow",
  },
  {
    name: "tainted read-only action stays allowed",
    action: pageScreenshot(),
    context: siteTainted,
    config: interact,
    verdict: "allow",
  },
  {
    name: "untainted click is allowed in standard",
    action: click(),
    context: site,
    config: interact,
    verdict: "allow",
  },
  {
    name: "point clicks use the context origin",
    action: clickPoint(),
    context: ctx("https://example.com/canvas"),
    config: interact,
    verdict: "allow",
  },
];

describe("classify", () => {
  it.each(cases)("$name", ({ action, context, config, verdict }) => {
    const decision = classify(action, context, config);
    expect(decision.verdict).toBe(verdict);
    expect(decision.reason.length).toBeGreaterThan(3);
  });

  it("allows audit and session queries", () => {
    expect(classifyQuery({ kind: "audit.tail", limit: 10 }, site, standard).verdict).toBe("allow");
    expect(classifyQuery({ kind: "session.info" }, site, standard).verdict).toBe("allow");
  });
});
