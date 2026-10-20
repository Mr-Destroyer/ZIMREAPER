import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Action } from "@zimreaper/protocol";
import { defaultPolicyConfig } from "../src/config.js";
import type { OriginPolicy, PolicyConfig, PolicyContext } from "../src/types.js";

export function tempDir(prefix = "zimreaper-policy-"): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return {
    dir,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

export function configFor(
  origin: string,
  tier: OriginPolicy["tier"],
  extra: Partial<OriginPolicy> = {},
): PolicyConfig {
  const config = defaultPolicyConfig();
  config.origins[origin] = { tier, ...extra };
  return config;
}

export function ctx(url = "https://example.com/page", extra: Partial<PolicyContext> = {}): PolicyContext {
  return { actor: "agent", url, ...extra };
}

export function click(selector = "#go"): Action {
  return {
    kind: "mouse.click",
    target: { selector },
    button: "left",
    clickCount: 1,
    modifiers: [],
    delayMs: 24,
  };
}

export function clickPoint(x = 10, y = 20): Action {
  return {
    kind: "mouse.click",
    target: { point: { x, y } },
    button: "left",
    clickCount: 1,
    modifiers: [],
    delayMs: 24,
  };
}

export function navGoto(url: string): Action {
  return { kind: "nav.goto", url, waitUntil: "load" };
}

export function nav(kind: "nav.back" | "nav.forward" | "nav.stop"): Action {
  return { kind };
}

export function navReload(): Action {
  return { kind: "nav.reload", ignoreCache: false };
}

export function mouseMove(): Action {
  return { kind: "mouse.move", to: { x: 10, y: 20 }, steps: 4, durationMs: 10 };
}

export function mouseWheel(): Action {
  return { kind: "mouse.wheel", deltaX: 0, deltaY: 120 };
}

export function mouseHover(): Action {
  return { kind: "mouse.hover", target: { selector: "#menu" }, durationMs: 10 };
}

export function pageScroll(): Action {
  return { kind: "page.scroll", deltaX: 0, deltaY: 200, toTop: false, toBottom: false };
}

export function pageScreenshot(): Action {
  return { kind: "page.screenshot", fullPage: false, annotate: false, format: "png" };
}

export function pagePdf(): Action {
  return { kind: "page.pdf", path: "/tmp/zim.pdf", format: "A4", printBackground: true };
}

export function pageWait(): Action {
  return { kind: "page.wait", for: { text: "ready" }, timeoutMs: 15_000, pollMs: 100 };
}

export function pageEval(): Action {
  return { kind: "page.eval", expression: "1 + 1", awaitPromise: true, isolated: false };
}

export function keyPress(key = "Enter"): Action {
  return { kind: "key.press", key, modifiers: [], count: 1 };
}

export function keyType(text = "hello"): Action {
  return { kind: "key.type", text, delayMs: 8, clearFirst: false };
}

export function domFill(selector = "#field"): Action {
  return { kind: "dom.fill", target: { selector }, text: "value", clear: true, submit: false };
}

export function domSetFiles(selector = "#file"): Action {
  return { kind: "dom.setFiles", target: { selector }, paths: ["/tmp/upload.txt"] };
}

export function storageLocal(op: "get" | "set" | "remove" | "clear"): Action {
  return { kind: "storage.local", op, origin: "https://example.com", key: "token", value: "x" };
}

export function clipboardWrite(): Action {
  return { kind: "clipboard.write", text: "copied" };
}

export function clipboardRead(): Action {
  return { kind: "clipboard.read" };
}

export function netRoute(): Action {
  return { kind: "net.route", pattern: "*", mode: "block" };
}

export function netReplay(): Action {
  return { kind: "net.replay", requestId: "r1" };
}

export function netHar(): Action {
  return { kind: "net.har", action: "start" };
}

export function dialogRespond(): Action {
  return { kind: "dialog.respond", accept: true };
}

export function humanRequest(): Action {
  return { kind: "human.request", reason: "need a human", timeoutMs: 1000 };
}

export function sessionKill(): Action {
  return { kind: "session.kill" };
}

export function sessionCancel(): Action {
  return { kind: "session.cancel" };
}
