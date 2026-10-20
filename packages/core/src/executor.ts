import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type {
  Action,
  Modifier,
  MouseButton,
  Point,
  Query,
  RefInfo,
  Snapshot,
  Target,
} from "@zimreaper/protocol";
import { ZimReaperError, parseChord } from "@zimreaper/protocol";
import type { Backend } from "./backend.js";
import { createLogger } from "./logger.js";
import type { Perception } from "@zimreaper/perception";
import type { PolicyEngine } from "@zimreaper/policy";

export interface ActionContext {
  tabId: string;
  requestId: string;
  actor: string;
  signal: AbortSignal;
}

export type ActionResult = Record<string, unknown>;

/** A hint from an external vision model, used when the DOM has nothing to match on. */
export interface GroundHint {
  ref?: string;
  point?: Point;
  confidence?: number;
}

export interface GroundInput {
  tabId: string;
  description: string;
  screenshotPath?: string;
  refs: RefInfo[];
}

export interface ExecutorOptions {
  backend: Backend;
  perception: Perception;
  policy: PolicyEngine;
  /** ~/.zimreaper/artifacts/<sessionId> */
  artifactsDir: string;
  now?: () => number;
  /**
   * Pluggable VLM grounding. When absent, `vision.ground` falls back to a deterministic
   * name/role token match against the current snapshot refs.
   */
  vlmGround?: (input: GroundInput) => Promise<GroundHint | undefined>;
}

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

interface ResolvedTarget {
  x: number;
  y: number;
  via: "ref" | "selector" | "point";
  ref?: string;
  selector?: string;
  backendNodeId?: number;
  bbox?: Box;
}

interface KeySpec {
  key: string;
  code: string;
  vk: number;
  text?: string;
}

interface RouteRule {
  id: string;
  pattern: string;
  mode: "block" | "mock" | "pass";
  status?: number;
  headers?: Record<string, string>;
  body?: string;
  method?: string;
  tabId: string;
  hits: number;
}

const MODIFIER_BITS: Record<Modifier, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
const BUTTON_BITS: Record<MouseButton, number> = { left: 1, right: 2, middle: 4, back: 8, forward: 16 };

const NAMED_KEYS: Record<string, KeySpec> = {
  enter: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  return: { key: "Enter", code: "Enter", vk: 13, text: "\r" },
  tab: { key: "Tab", code: "Tab", vk: 9, text: "\t" },
  escape: { key: "Escape", code: "Escape", vk: 27 },
  esc: { key: "Escape", code: "Escape", vk: 27 },
  backspace: { key: "Backspace", code: "Backspace", vk: 8 },
  delete: { key: "Delete", code: "Delete", vk: 46 },
  arrowleft: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  left: { key: "ArrowLeft", code: "ArrowLeft", vk: 37 },
  arrowup: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  up: { key: "ArrowUp", code: "ArrowUp", vk: 38 },
  arrowright: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  right: { key: "ArrowRight", code: "ArrowRight", vk: 39 },
  arrowdown: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  down: { key: "ArrowDown", code: "ArrowDown", vk: 40 },
  home: { key: "Home", code: "Home", vk: 36 },
  end: { key: "End", code: "End", vk: 35 },
  pageup: { key: "PageUp", code: "PageUp", vk: 33 },
  pagedown: { key: "PageDown", code: "PageDown", vk: 34 },
  space: { key: " ", code: "Space", vk: 32, text: " " },
};

const SETTLING_KINDS = new Set<Action["kind"]>([
  "nav.goto",
  "nav.back",
  "nav.forward",
  "nav.reload",
  "mouse.click",
  "dom.click",
  "dom.fill",
  "dom.check",
  "key.press",
  "key.chord",
  "dialog.respond",
]);

function keySpec(raw: string): KeySpec {
  const named = NAMED_KEYS[raw.toLowerCase()];
  if (named) return named;
  const fMatch = /^f(\d{1,2})$/i.exec(raw);
  if (fMatch?.[1]) {
    const n = Number(fMatch[1]);
    if (n >= 1 && n <= 24) return { key: `F${n}`, code: `F${n}`, vk: 111 + n };
  }
  if (raw.length === 1) {
    const upper = raw.toUpperCase();
    if (/[A-Z]/.test(upper)) return { key: raw, code: `Key${upper}`, vk: upper.charCodeAt(0), text: raw };
    if (/[0-9]/.test(raw)) return { key: raw, code: `Digit${raw}`, vk: raw.charCodeAt(0), text: raw };
    return { key: raw, code: "", vk: 0, text: raw };
  }
  // Multi-character names we do not model: send the key name with no virtual code.
  return { key: raw, code: "", vk: 0 };
}

function modifierMask(modifiers: readonly Modifier[]): number {
  return modifiers.reduce((mask, mod) => mask | MODIFIER_BITS[mod], 0);
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… [truncated ${text.length - max} chars]` : text;
}

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const log = createLogger("core:executor");

/**
 * Resolves targets (ref -> box model -> viewport point), dispatches real CDP input,
 * settles the page, and maps failures to the protocol error taxonomy.
 */
export class Executor {
  private readonly backend: Backend;
  private readonly perception: Perception;
  private readonly policy: PolicyEngine;
  private readonly artifactsDir: string;
  private readonly now: () => number;
  private readonly vlmGround?: (input: GroundInput) => Promise<GroundHint | undefined>;
  private readonly cursor = new Map<string, Point>();
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly routes = new Map<string, RouteRule>();
  private readonly harStart = new Map<string, { seq: number; at: number }>();
  private readonly controllers = new Map<string, Set<AbortController>>();
  private routeSeq = 0;

  constructor(opts: ExecutorOptions) {
    this.backend = opts.backend;
    this.perception = opts.perception;
    this.policy = opts.policy;
    this.artifactsDir = opts.artifactsDir;
    this.now = opts.now ?? (() => Date.now());
    this.vlmGround = opts.vlmGround;
    this.backend.onCdp?.((tabId, method, params) => {
      if (method === "Fetch.requestPaused") void this.onRequestPaused(tabId, params);
    });
  }

  /* -------------------------------------------------------------------- act */

  async act(action: Action, ctx: ActionContext): Promise<ActionResult> {
    const controller = new AbortController();
    const forward = (): void => controller.abort();
    if (ctx.signal.aborted) controller.abort();
    else ctx.signal.addEventListener("abort", forward, { once: true });
    const inner: ActionContext = { ...ctx, signal: controller.signal };
    this.trackController(ctx.tabId, controller);
    try {
      this.checkAbort(inner);
      const result = await this.dispatch(action, inner);
      if (SETTLING_KINDS.has(action.kind)) {
        const settled = await this.settle(ctx.tabId, inner);
        return { ...result, ...settled };
      }
      return result;
    } catch (err) {
      if (controller.signal.aborted) {
        throw new ZimReaperError("CANCELLED", `${action.kind} cancelled`);
      }
      throw ZimReaperError.from(err, "INTERNAL");
    } finally {
      ctx.signal.removeEventListener("abort", forward);
      this.untrackController(ctx.tabId, controller);
    }
  }

  private async dispatch(action: Action, ctx: ActionContext): Promise<ActionResult> {
    const tabId = ctx.tabId;
    switch (action.kind) {
      /* ------------------------------------------------------------------ nav */
      case "nav.goto": {
        const timeoutMs = action.timeoutMs ?? 30_000;
        const res = await this.backend.send<{ frameId?: string; errorText?: string }>(
          tabId,
          "Page.navigate",
          {
            url: action.url,
            ...(action.referrer ? { referrer: action.referrer } : {}),
          },
        );
        if (res.errorText) {
          throw new ZimReaperError("NAV_FAILED", `navigation to ${action.url} failed: ${res.errorText}`, {
            details: { url: action.url, errorText: res.errorText },
          });
        }
        await this.waitForLoad(tabId, action.waitUntil, timeoutMs, ctx);
        const info = await this.pageInfo(tabId);
        return { url: info.url, title: info.title, waitUntil: action.waitUntil };
      }
      case "nav.back":
      case "nav.forward": {
        await this.evaluate(tabId, `history.${action.kind === "nav.back" ? "back" : "forward"}()`);
        await this.waitForLoad(tabId, "load", 30_000, ctx);
        const info = await this.pageInfo(tabId);
        return { url: info.url, title: info.title };
      }
      case "nav.reload": {
        await this.backend.send(tabId, "Page.reload", { ignoreCache: action.ignoreCache });
        await this.waitForLoad(tabId, "load", 30_000, ctx);
        const info = await this.pageInfo(tabId);
        return { url: info.url, title: info.title };
      }
      case "nav.stop": {
        await this.backend.send(tabId, "Page.stopLoading", {});
        return { stopped: true };
      }

      /* ------------------------------------------------------------------ tabs */
      case "tab.new": {
        const tab = await this.backend.createTab({
          url: action.url,
          active: action.active,
          partition: action.partition,
          forkFrom: action.forkFrom,
        });
        if (action.forkFrom) await this.copySession(action.forkFrom, tab.tabId);
        return { tab };
      }
      case "tab.close": {
        await this.backend.closeTab(action.tabId);
        return { closed: action.tabId };
      }
      case "tab.activate": {
        await this.backend.activateTab(action.tabId);
        return { activeTabId: action.tabId };
      }

      /* ----------------------------------------------------------------- mouse */
      case "mouse.move": {
        await this.moveTo(tabId, action.to, action.steps, action.durationMs, ctx);
        return { moved: action.to };
      }
      case "mouse.click": {
        const point = await this.resolveTarget(action.target, ctx);
        await this.clickAt(tabId, point, action, ctx);
        return { clicked: { x: point.x, y: point.y }, ...(point.ref ? { ref: point.ref } : {}) };
      }
      case "mouse.down":
      case "mouse.up": {
        const point = action.target
          ? await this.resolveTarget(action.target, ctx)
          : (this.cursor.get(tabId) ?? { x: 0, y: 0 });
        await this.dispatchMouse(tabId, action.kind === "mouse.down" ? "mousePressed" : "mouseReleased", point, {
          button: action.button,
          buttons: action.kind === "mouse.down" ? BUTTON_BITS[action.button] : 0,
          clickCount: 1,
          modifiers: 0,
        });
        return { button: action.button, at: point };
      }
      case "mouse.drag": {
        const from = await this.resolveTarget(action.from, ctx);
        const to = await this.resolveTarget(action.to, ctx);
        await this.moveTo(tabId, from, 6, 60, ctx);
        await this.dispatchMouse(tabId, "mousePressed", from, {
          button: action.button,
          buttons: BUTTON_BITS[action.button],
          clickCount: 1,
          modifiers: 0,
        });
        const steps = Math.max(1, action.steps);
        for (let i = 1; i <= steps; i += 1) {
          this.checkAbort(ctx);
          const t = i / steps;
          const point = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
          await this.dispatchMouse(tabId, "mouseMoved", point, {
            button: action.button,
            buttons: BUTTON_BITS[action.button],
            clickCount: 0,
            modifiers: 0,
          });
          if (action.durationMs > 0) await this.sleep(action.durationMs / steps, ctx);
        }
        await this.dispatchMouse(tabId, "mouseReleased", to, {
          button: action.button,
          buttons: 0,
          clickCount: 1,
          modifiers: 0,
        });
        this.cursor.set(tabId, to);
        return { dragged: { from: { x: from.x, y: from.y }, to: { x: to.x, y: to.y } } };
      }
      case "mouse.wheel": {
        const point = action.target
          ? await this.resolveTarget(action.target, ctx)
          : (this.cursor.get(tabId) ?? { x: 0, y: 0 });
        await this.dispatchMouse(tabId, "mouseMoved", point, { button: "none", buttons: 0, clickCount: 0, modifiers: 0 });
        await this.backend.send(tabId, "Input.dispatchMouseEvent", {
          type: "mouseWheel",
          x: point.x,
          y: point.y,
          deltaX: action.deltaX,
          deltaY: action.deltaY,
          button: "none",
          buttons: 0,
          modifiers: 0,
        });
        this.cursor.set(tabId, point);
        return { scrolled: { deltaX: action.deltaX, deltaY: action.deltaY, at: point } };
      }
      case "mouse.hover": {
        const point = await this.resolveTarget(action.target, ctx);
        await this.moveTo(tabId, point, 12, 80, ctx);
        await this.sleep(action.durationMs, ctx);
        return { hovered: { x: point.x, y: point.y }, ...(point.ref ? { ref: point.ref } : {}) };
      }

      /* -------------------------------------------------------------- keyboard */
      case "key.type": {
        if (action.target) {
          const point = await this.resolveTarget(action.target, ctx);
          await this.clickAt(tabId, point, { button: "left", clickCount: 1, modifiers: [], delayMs: 10 }, ctx);
        }
        if (action.clearFirst) {
          await this.pressKey(tabId, "a", ["Control"], ctx);
          await this.pressKey(tabId, "Backspace", [], ctx);
        }
        if (action.delayMs === 0) {
          await this.backend.send(tabId, "Input.insertText", { text: action.text });
          return { typed: action.text.length, mode: "insertText" };
        }
        for (const ch of Array.from(action.text)) {
          this.checkAbort(ctx);
          if (ch === "\n") {
            await this.pressKey(tabId, "Enter", [], ctx);
          } else {
            const spec = keySpec(ch);
            await this.sendKeyEvent(tabId, "rawKeyDown", spec, [], undefined);
            if (spec.text) await this.sendKeyEvent(tabId, "char", spec, [], spec.text);
            await this.sendKeyEvent(tabId, "keyUp", spec, [], undefined);
          }
          await this.sleep(action.delayMs, ctx);
        }
        return { typed: action.text.length, mode: "per-character", delayMs: action.delayMs };
      }
      case "key.press": {
        for (let i = 0; i < action.count; i += 1) {
          this.checkAbort(ctx);
          await this.pressKey(tabId, action.key, action.modifiers, ctx);
        }
        return { key: action.key, count: action.count, modifiers: action.modifiers };
      }
      case "key.chord": {
        const { key, modifiers } = parseChord(action.chord);
        await this.pressKey(tabId, key, modifiers, ctx);
        return { chord: action.chord, key, modifiers, modifiersMask: modifierMask(modifiers) };
      }
      case "key.down":
      case "key.up": {
        const spec = keySpec(action.key);
        const mask = modifierMask(action.modifiers);
        await this.sendKeyEvent(
          tabId,
          action.kind === "key.down" ? "rawKeyDown" : "keyUp",
          spec,
          action.modifiers,
          action.kind === "key.down" ? spec.text : undefined,
        );
        return { key: action.key, modifiersMask: mask };
      }

      /* ------------------------------------------------------------------ page */
      case "page.scroll": {
        const expression = action.toTop
          ? "window.scrollTo(0, 0)"
          : action.toBottom
            ? "window.scrollTo(0, document.body.scrollHeight)"
            : `window.scrollBy(${action.deltaX}, ${action.deltaY})`;
        await this.evaluate(tabId, expression);
        const scroll = await this.evaluate(
          tabId,
          "({x: window.scrollX, y: window.scrollY, maxY: Math.max(0, document.documentElement.scrollHeight - window.innerHeight)})",
        );
        return { scroll };
      }
      case "page.screenshot":
        return this.screenshot(action, ctx);
      case "page.pdf": {
        const size = paperSize(action.format);
        const res = await this.backend.send<{ data: string }>(tabId, "Page.printToPDF", {
          printBackground: action.printBackground,
          paperWidth: size.width,
          paperHeight: size.height,
          preferCSSPageSize: false,
        });
        const target = action.path;
        await mkdir(dirname(target), { recursive: true });
        const bytes = Buffer.from(res.data, "base64");
        await writeFile(target, bytes, { mode: 0o600 });
        return { path: target, bytes: bytes.length };
      }
      case "page.setViewport": {
        await this.backend.send(tabId, "Emulation.setDeviceMetricsOverride", {
          width: action.width,
          height: action.height,
          deviceScaleFactor: action.deviceScaleFactor,
          mobile: action.mobile,
        });
        return { viewport: { width: action.width, height: action.height } };
      }
      case "page.emulate": {
        const applied: string[] = [];
        if (action.userAgent) {
          await this.backend.send(tabId, "Emulation.setUserAgentOverride", {
            userAgent: action.userAgent,
            ...(action.locale ? { acceptLanguage: action.locale } : {}),
          });
          applied.push("userAgent");
        }
        if (action.locale) {
          await this.backend.send(tabId, "Emulation.setLocaleOverride", { locale: action.locale });
          applied.push("locale");
        }
        if (action.timezone) {
          await this.backend.send(tabId, "Emulation.setTimezoneOverride", { timezoneId: action.timezone });
          applied.push("timezone");
        }
        if (action.colorScheme) {
          await this.backend.send(tabId, "Emulation.setEmulatedMedia", {
            features: [{ name: "prefers-color-scheme", value: action.colorScheme }],
          });
          applied.push("colorScheme");
        }
        if (action.geolocation) {
          await this.backend.send(tabId, "Emulation.setGeolocationOverride", {
            latitude: action.geolocation.latitude,
            longitude: action.geolocation.longitude,
            accuracy: action.geolocation.accuracy,
          });
          applied.push("geolocation");
        }
        return { applied };
      }
      case "page.eval": {
        let contextId: number | undefined;
        if (action.isolated) {
          const { frameTree } = await this.backend.send<{ frameTree?: { frame?: { id?: string } } }>(
            tabId,
            "Page.getFrameTree",
            {},
          );
          const frameId = frameTree?.frame?.id;
          if (!frameId) throw new ZimReaperError("BACKEND_ERROR", "no main frame to isolate");
          const world = await this.backend.send<{ executionContextId: number }>(
            tabId,
            "Page.createIsolatedWorld",
            { frameId, worldName: "zimreaper", grantUniveralAccess: false },
          );
          contextId = world.executionContextId;
        }
        const value = await this.evaluate(tabId, action.expression, {
          awaitPromise: action.awaitPromise,
          contextId,
        });
        return { value, isolated: action.isolated };
      }
      case "page.wait": {
        const started = this.now();
        const deadline = started + action.timeoutMs;
        const condition = action.for;
        while (this.now() < deadline) {
          this.checkAbort(ctx);
          if (await this.conditionMet(tabId, condition, ctx)) {
            const info = await this.pageInfo(tabId);
            return { waitedMs: this.now() - started, url: info.url, title: info.title };
          }
          await this.sleep(action.pollMs, ctx);
        }
        throw new ZimReaperError("TIMEOUT", `page.wait timed out after ${action.timeoutMs}ms`, {
          details: { condition, timeoutMs: action.timeoutMs },
          retryable: true,
        });
      }

      /* ------------------------------------------------------------------- dom */
      case "dom.click": {
        const point = await this.resolveTarget(action.target, ctx);
        await this.clickAt(tabId, point, { button: "left", clickCount: 1, modifiers: [], delayMs: 24 }, ctx);
        return { clicked: { x: point.x, y: point.y }, ...(point.ref ? { ref: point.ref } : {}) };
      }
      case "dom.fill": {
        const point = await this.resolveTarget(action.target, ctx);
        await this.clickAt(tabId, point, { button: "left", clickCount: 1, modifiers: [], delayMs: 10 }, ctx);
        if (action.clear) {
          await this.pressKey(tabId, "a", ["Control"], ctx);
          await this.pressKey(tabId, "Backspace", [], ctx);
        }
        await this.backend.send(tabId, "Input.insertText", { text: action.text });
        if (action.submit) await this.pressKey(tabId, "Enter", [], ctx);
        return { filled: action.text.length, ...(point.ref ? { ref: point.ref } : {}) };
      }
      case "dom.select": {
        const target = action.target;
        const values = action.values;
        const script = `function (values) {
          const el = this;
          if (!el || el.tagName !== "SELECT") throw new Error("target is not a <select>");
          const wanted = new Set(values);
          for (const opt of el.options) opt.selected = wanted.has(opt.value) || wanted.has(opt.text);
          el.dispatchEvent(new Event("input", { bubbles: true }));
          el.dispatchEvent(new Event("change", { bubbles: true }));
          return Array.from(el.selectedOptions).map((o) => o.value);
        }`;
        if (target.ref || target.selector) {
          const objectId = await this.objectIdFor(target, ctx);
          const res = await this.backend.send<{
            result?: { value?: unknown };
            exceptionDetails?: { text?: string; exception?: { description?: string } };
          }>(tabId, "Runtime.callFunctionOn", {
            objectId,
            functionDeclaration: script,
            arguments: [{ value: values }],
            returnByValue: true,
            userGesture: true,
          });
          if (res.exceptionDetails) {
            throw new ZimReaperError("NO_TARGET", `dom.select failed: ${res.exceptionDetails.text ?? "page error"}`);
          }
          return { selected: res.result?.value ?? values };
        }
        throw new ZimReaperError("BAD_REQUEST", "dom.select requires a ref or selector target");
      }
      case "dom.check": {
        const current = await this.isChecked(action.target, ctx);
        if (current === action.checked) return { checked: current, changed: false };
        const point = await this.resolveTarget(action.target, ctx);
        await this.clickAt(tabId, point, { button: "left", clickCount: 1, modifiers: [], delayMs: 20 }, ctx);
        return { checked: action.checked, changed: true };
      }
      case "dom.setFiles": {
        const backendNodeId = await this.backendNodeIdFor(action.target, ctx);
        await this.backend.send(tabId, "DOM.setFileInputFiles", {
          files: action.paths,
          backendNodeId,
        });
        return { files: action.paths };
      }
      case "dom.scrollIntoView": {
        if (action.target.ref) {
          const info = this.perception.ref(tabId, action.target.ref);
          if (!info?.backendNodeId) {
            throw new ZimReaperError("STALE_REF", `ref ${action.target.ref} has no live node`, {
              retryable: true,
            });
          }
          await this.backend.send(tabId, "DOM.scrollIntoViewIfNeeded", {
            backendNodeId: info.backendNodeId,
          });
        } else if (action.target.selector) {
          await this.evaluate(
            tabId,
            `document.querySelector(${JSON.stringify(action.target.selector)})?.scrollIntoView({block: ${JSON.stringify(action.block)}, inline: "center"})`,
          );
        } else if (action.target.point) {
          await this.evaluate(tabId, `window.scrollTo(${action.target.point.x}, ${action.target.point.y})`);
        }
        return { scrolled: true };
      }

      /* --------------------------------------------------------------- dialogs */
      case "dialog.respond": {
        await this.backend.send(tabId, "Page.handleJavaScriptDialog", {
          accept: action.accept,
          ...(action.promptText !== undefined ? { promptText: action.promptText } : {}),
        });
        return { accepted: action.accept };
      }

      /* ------------------------------------------------------------- clipboard */
      case "clipboard.read": {
        const text = await this.evaluate(tabId, "navigator.clipboard.readText()", { awaitPromise: true });
        return { text: typeof text === "string" ? text : "" };
      }
      case "clipboard.write": {
        await this.evaluate(tabId, `navigator.clipboard.writeText(${JSON.stringify(action.text)})`, {
          awaitPromise: true,
        });
        return { written: action.text.length };
      }

      /* --------------------------------------------------------------- network */
      case "net.route":
        return this.route(action, ctx);
      case "net.unroute": {
        const rule = this.routes.get(action.ruleId);
        if (!rule) throw new ZimReaperError("NOT_FOUND", `no route rule ${action.ruleId}`);
        this.routes.delete(action.ruleId);
        if (this.routes.size === 0) {
          await this.backend.send(rule.tabId, "Fetch.disable", {}).catch(() => undefined);
        }
        return { removed: action.ruleId };
      }
      case "net.replay":
        return this.replay(action, ctx);
      case "net.har":
        return this.har(action, ctx);
      case "net.setExtraHeaders": {
        await this.backend.send(tabId, "Network.setExtraHTTPHeaders", { headers: action.headers });
        return { headers: action.headers };
      }

      /* --------------------------------------------------------------- storage */
      case "storage.cookies": {
        if (action.op === "get") {
          const url = action.url ?? (await this.pageInfo(tabId)).url;
          const res = await this.backend.send<{ cookies?: unknown[] }>(tabId, "Network.getCookies", {
            urls: [url],
          });
          return { cookies: res.cookies ?? [], url };
        }
        if (action.op === "set") {
          const cookies = action.cookies ?? [];
          await this.backend.send(tabId, "Network.setCookies", { cookies });
          return { set: cookies.length };
        }
        await this.backend.send(tabId, "Network.clearBrowserCookies", {});
        return { cleared: true };
      }
      case "storage.local": {
        await this.backend.send(tabId, "DOMStorage.enable", {});
        const storageId = { securityOrigin: action.origin, isLocalStorage: true };
        if (action.op === "get") {
          const res = await this.backend.send<{ entries?: Array<[string, string]> }>(
            tabId,
            "DOMStorage.getDOMStorageItems",
            { storageId },
          );
          const items: Record<string, string> = {};
          for (const [key, value] of res.entries ?? []) items[key] = value;
          return action.key ? { key: action.key, value: items[action.key] ?? null } : { items };
        }
        if (action.op === "set") {
          if (!action.key) throw new ZimReaperError("BAD_REQUEST", "storage.local set requires key");
          await this.backend.send(tabId, "DOMStorage.setDOMStorageItem", {
            storageId,
            key: action.key,
            value: action.value ?? "",
          });
          return { key: action.key, value: action.value ?? "" };
        }
        if (action.op === "remove") {
          if (!action.key) throw new ZimReaperError("BAD_REQUEST", "storage.local remove requires key");
          await this.backend.send(tabId, "DOMStorage.removeDOMStorageItem", {
            storageId,
            key: action.key,
          });
          return { removed: action.key };
        }
        await this.backend.send(tabId, "DOMStorage.clear", { storageId });
        return { cleared: true };
      }

      /* --------------------------------------------------------------- session */
      case "session.fork": {
        const source = action.tabId ?? tabId;
        const url = action.url ?? (await this.pageInfo(source)).url;
        const tabs = [] as unknown[];
        for (let i = 0; i < action.count; i += 1) {
          this.checkAbort(ctx);
          const tab = await this.backend.createTab({ url, active: false });
          await this.copySession(source, tab.tabId);
          tabs.push(tab);
        }
        return { tabs };
      }
      case "session.kill": {
        let cancelled = 0;
        for (const [key, set] of this.controllers) {
          for (const controller of set) {
            controller.abort();
            cancelled += 1;
          }
          set.clear();
          this.controllers.delete(key);
        }
        return { killed: true, cancelled };
      }
      case "session.cancel": {
        const cancelled = this.cancel(action.tabId ?? tabId);
        return { cancelled };
      }

      /* ----------------------------------------------------------------- human */
      case "human.request":
        throw new ZimReaperError("NEEDS_HUMAN", action.reason, {
          details: { reason: action.reason, detail: action.detail, timeoutMs: action.timeoutMs },
        });

      /* ---------------------------------------------------------------- vision */
      case "vision.ground":
        return this.ground(action, ctx);

      default: {
        const exhaustive: never = action;
        throw new ZimReaperError("UNSUPPORTED", `unsupported action ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  /* ------------------------------------------------------------------ query */

  async query(query: Query, ctx: ActionContext): Promise<unknown> {
    const tabId = ctx.tabId;
    switch (query.kind) {
      case "tab.list":
        return { tabs: await this.backend.listTabs(), activeTabId: this.backend.activeTabId() };
      case "page.snapshot": {
        const snapshot = await this.perception.snapshot(tabId, {
          mode: query.mode,
          maxChars: query.maxChars,
          includeFrames: query.includeFrames,
          interactiveOnly: query.interactiveOnly,
          cache: query.cache,
        });
        this.snapshots.set(tabId, snapshot);
        return snapshot;
      }
      case "page.diff": {
        const diff = await this.perception.diff(tabId, query.since);
        return diff;
      }
      case "page.text": {
        const expression = query.selector
          ? `(() => { const el = document.querySelector(${JSON.stringify(query.selector)}); return el ? (el.innerText || el.textContent || "") : null; })()`
          : "document.body ? document.body.innerText : \"\"";
        const text = await this.evaluate(tabId, expression);
        if (text === null) throw new ZimReaperError("NO_TARGET", `no element for ${query.selector}`);
        return { text: truncate(String(text), query.maxChars) };
      }
      case "page.html": {
        const property = query.outer ? "outerHTML" : "innerHTML";
        const expression = query.selector
          ? `(() => { const el = document.querySelector(${JSON.stringify(query.selector)}); return el ? el.${property} : null; })()`
          : `document.documentElement.${property}`;
        const html = await this.evaluate(tabId, expression);
        if (html === null) throw new ZimReaperError("NO_TARGET", `no element for ${query.selector}`);
        return { html: truncate(String(html), query.maxChars) };
      }
      case "dom.query": {
        const expression = `(() => {
          const nodes = Array.from(document.querySelectorAll(${JSON.stringify(query.selector)}));
          const slice = ${query.all ? `nodes.slice(0, ${query.limit})` : "nodes.slice(0, 1)"};
          const attrs = ${JSON.stringify(query.attrs)};
          return slice.map((el) => {
            const out = { tag: el.tagName.toLowerCase(), text: (el.innerText || el.textContent || "").trim().slice(0, 500), attrs: {} };
            for (const name of attrs) out.attrs[name] = el.getAttribute(name);
            return out;
          });
        })()`;
        return { nodes: await this.evaluate(tabId, expression) };
      }
      case "dom.attrs": {
        const objectId = await this.objectIdFor(query.target, ctx);
        const res = await this.backend.send<{
          result?: { value?: unknown };
          exceptionDetails?: { text?: string };
        }>(tabId, "Runtime.callFunctionOn", {
          objectId,
          functionDeclaration: `function () {
            const attrs = {};
            for (const attr of this.attributes) attrs[attr.name] = attr.value;
            const rect = this.getBoundingClientRect();
            return { tag: this.tagName.toLowerCase(), attrs, text: (this.innerText || "").trim().slice(0, 2000), bbox: { x: rect.x, y: rect.y, width: rect.width, height: rect.height } };
          }`,
          returnByValue: true,
        });
        if (res.exceptionDetails) {
          throw new ZimReaperError("NO_TARGET", `dom.attrs failed: ${res.exceptionDetails.text ?? "page error"}`);
        }
        return res.result?.value;
      }
      case "net.log": {
        const entries = this.backend.netEntries?.(tabId) ?? [];
        const filter = query.filter;
        const filtered = entries.filter((entry) => {
          if (entry.seq < query.sinceSeq) return false;
          if (filter?.urlContains && !entry.url.includes(filter.urlContains)) return false;
          if (filter?.method && entry.method.toUpperCase() !== filter.method.toUpperCase()) return false;
          if (filter?.status !== undefined && entry.status !== filter.status) return false;
          if (filter?.resourceType && entry.resourceType !== filter.resourceType) return false;
          return true;
        });
        return { entries: filtered.slice(-query.limit), total: filtered.length };
      }
      case "net.body": {
        if (query.part === "response") {
          const res = await this.backend.send<{ body?: string; base64Encoded?: boolean }>(
            tabId,
            "Network.getResponseBody",
            { requestId: query.requestId },
          );
          const text = res.base64Encoded
            ? Buffer.from(res.body ?? "", "base64").toString("utf8")
            : (res.body ?? "");
          return { requestId: query.requestId, part: "response", body: truncate(text, query.maxBytes) };
        }
        const res = await this.backend.send<{ postData?: string }>(
          tabId,
          "Network.getRequestPostData",
          { requestId: query.requestId },
        );
        return { requestId: query.requestId, part: "request", body: truncate(res.postData ?? "", query.maxBytes) };
      }
      case "audit.tail":
        return { entries: this.policy.tail(query.limit) };
      case "policy.get":
        return { policy: this.policy.config() };
      case "vault.list":
        return { entries: [] };
      case "session.info":
        return {
          activeTabId: this.backend.activeTabId(),
          backend: this.backend.name,
          capabilities: this.backend.capabilities().domains,
        };
      case "page.extract": {
        const expression = `(() => {
          const rows = Array.from(document.querySelectorAll(${JSON.stringify(query.rowSelector)})).slice(0, ${query.limit});
          const fields = ${JSON.stringify(query.fields)};
          return rows.map((row) => {
            const out = {};
            for (const [name, field] of Object.entries(fields)) {
              const el = field.self ? row : (field.selector ? row.querySelector(field.selector) : null);
              out[name] = el ? (field.attr ? el.getAttribute(field.attr) : (el.textContent || "").trim()) : null;
            }
            return out;
          });
        })()`;
        const rows = await this.evaluate(tabId, expression);
        return { rows: rows ?? [], count: Array.isArray(rows) ? rows.length : 0 };
      }
      default: {
        const exhaustive: never = query;
        throw new ZimReaperError("UNSUPPORTED", `unsupported query ${JSON.stringify(exhaustive)}`);
      }
    }
  }

  /* ----------------------------------------------------------------- cancel */

  /** Abort in-flight work for one tab (or every tab). Returns how many actions were aborted. */
  cancel(tabId?: string): number {
    let cancelled = 0;
    for (const [key, set] of this.controllers) {
      if (tabId && key !== tabId) continue;
      for (const controller of set) {
        controller.abort();
        cancelled += 1;
      }
      set.clear();
    }
    return cancelled;
  }

  /* ----------------------------------------------------------------- settle */

  /** Wait for in-flight network to drain plus a quiet window; capped so a chatty page never hangs us. */
  async settle(
    tabId: string,
    ctx: ActionContext,
  ): Promise<{ settled: boolean; url: string; title: string }> {
    const deadline = this.now() + 5_000;
    const inFlight = (): number => this.backend.inFlight?.(tabId) ?? 0;
    while (this.now() < deadline && inFlight() > 0) {
      this.checkAbort(ctx);
      await this.sleep(40, ctx);
    }
    let quietSince = this.now();
    while (this.now() < deadline) {
      if (inFlight() > 0) {
        quietSince = this.now();
      } else if (this.now() - quietSince >= 120) {
        break;
      }
      await this.sleep(30, ctx);
    }
    const info = await this.pageInfo(tabId).catch(() => ({ url: "", title: "" }));
    return { settled: inFlight() === 0, url: info.url, title: info.title };
  }

  /* -------------------------------------------------------------- internals */

  private checkAbort(ctx: ActionContext): void {
    if (ctx.signal.aborted) throw new ZimReaperError("CANCELLED", "action cancelled");
  }

  private async sleep(ms: number, ctx: ActionContext): Promise<void> {
    if (ms <= 0) return;
    const signal = ctx.signal;
    await new Promise<void>((resolve, reject) => {
      if (signal.aborted) {
        reject(new ZimReaperError("CANCELLED", "action cancelled"));
        return;
      }
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      }, ms);
      const onAbort = (): void => {
        clearTimeout(timer);
        reject(new ZimReaperError("CANCELLED", "action cancelled"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
  }

  private trackController(tabId: string, controller: AbortController): void {
    const set = this.controllers.get(tabId) ?? new Set<AbortController>();
    set.add(controller);
    this.controllers.set(tabId, set);
  }

  private untrackController(tabId: string, controller: AbortController): void {
    const set = this.controllers.get(tabId);
    if (!set) return;
    set.delete(controller);
    if (set.size === 0) this.controllers.delete(tabId);
  }

  private async evaluate(
    tabId: string,
    expression: string,
    opts: { awaitPromise?: boolean; contextId?: number; returnByValue?: boolean } = {},
  ): Promise<unknown> {
    const res = await this.backend.send<{
      result?: { value?: unknown; objectId?: string };
      exceptionDetails?: { text?: string; exception?: { description?: string } };
    }>(tabId, "Runtime.evaluate", {
      expression,
      awaitPromise: opts.awaitPromise ?? false,
      returnByValue: opts.returnByValue ?? true,
      userGesture: true,
      ...(opts.contextId !== undefined ? { contextId: opts.contextId } : {}),
    });
    if (res.exceptionDetails) {
      const detail = res.exceptionDetails.exception?.description ?? res.exceptionDetails.text ?? "page error";
      throw new ZimReaperError("INTERNAL", `page evaluation failed: ${detail.split("\n")[0]}`, {
        details: { expression: expression.slice(0, 300) },
      });
    }
    return res.result?.value;
  }

  private async pageInfo(tabId: string): Promise<{ url: string; title: string }> {
    try {
      const value = await this.evaluate(tabId, "({url: location.href, title: document.title})");
      if (value && typeof value === "object") {
        const info = value as { url?: unknown; title?: unknown };
        return { url: String(info.url ?? ""), title: String(info.title ?? "") };
      }
    } catch {
      /* fall through to the tab registry */
    }
    const tab = await this.backend.getTab(tabId).catch(() => undefined);
    return { url: tab?.url ?? "", title: tab?.title ?? "" };
  }

  private async viewport(tabId: string): Promise<{ width: number; height: number }> {
    const metrics = await this.backend.send<{
      cssLayoutViewport?: { clientWidth: number; clientHeight: number };
      layoutViewport?: { clientWidth: number; clientHeight: number };
    }>(tabId, "Page.getLayoutMetrics", {});
    const vp = metrics.cssLayoutViewport ?? metrics.layoutViewport;
    return { width: vp?.clientWidth ?? 1280, height: vp?.clientHeight ?? 800 };
  }

  private async resolveTarget(target: Target, ctx: ActionContext): Promise<ResolvedTarget> {
    if (target.point) {
      return { x: target.point.x, y: target.point.y, via: "point" };
    }
    if (target.ref) {
      return this.resolveRef(target, ctx);
    }
    if (target.selector) {
      return this.resolveSelector(target, ctx);
    }
    throw new ZimReaperError("BAD_REQUEST", "target requires one of ref, selector, point");
  }

  private async resolveRef(target: Target, ctx: ActionContext): Promise<ResolvedTarget> {
    const tabId = ctx.tabId;
    const ref = target.ref as string;
    const info = this.perception.ref(tabId, ref);
    if (!info) {
      const generation = this.perception.generation(tabId);
      if (generation > 0) {
        throw new ZimReaperError(
          "STALE_REF",
          `ref ${ref} is from an older snapshot (generation ${generation}); re-snapshot`,
          { details: { ref, generation }, retryable: true },
        );
      }
      throw new ZimReaperError("NO_TARGET", `unknown ref ${ref}; take a snapshot first`, {
        details: { ref },
        retryable: true,
      });
    }

    let bbox = info.backendNodeId ? await this.boxForNode(tabId, info.backendNodeId) : undefined;
    if (!bbox && info.selector) {
      bbox = await this.selectorBox(tabId, info.selector).catch(() => undefined);
    }
    if (!bbox) {
      throw new ZimReaperError("STALE_REF", `ref ${ref} has no layout box; re-snapshot`, {
        details: { ref, generation: info.generation },
        retryable: true,
      });
    }

    let point = this.pointIn(bbox, target.offset);
    const vp = await this.viewport(tabId);
    if (point.x < 0 || point.y < 0 || point.x > vp.width || point.y > vp.height) {
      await this.scrollIntoView(tabId, info);
      if (info.backendNodeId) bbox = await this.boxForNode(tabId, info.backendNodeId);
      else if (info.selector) bbox = await this.selectorBox(tabId, info.selector);
      point = this.pointIn(bbox, target.offset);
    }
    return {
      x: point.x,
      y: point.y,
      via: "ref",
      ref,
      backendNodeId: info.backendNodeId,
      bbox,
    };
  }

  private async resolveSelector(target: Target, ctx: ActionContext): Promise<ResolvedTarget> {
    const selector = target.selector as string;
    const bbox = await this.selectorBox(ctx.tabId, selector);
    const point = this.pointIn(bbox, target.offset);
    return { x: point.x, y: point.y, via: "selector", selector, bbox };
  }

  private pointIn(bbox: Box, offset?: Point): Point {
    if (offset) return { x: bbox.x + offset.x, y: bbox.y + offset.y };
    return { x: bbox.x + bbox.width / 2, y: bbox.y + bbox.height / 2 };
  }

  private async boxForNode(tabId: string, backendNodeId: number): Promise<Box> {
    const res = await this.backend.send<{
      model?: { content?: number[]; width?: number; height?: number };
    }>(tabId, "DOM.getBoxModel", { backendNodeId });
    const quad = res.model?.content;
    if (!quad || quad.length < 8) {
      throw new ZimReaperError("NO_TARGET", `no box model for node ${backendNodeId}`);
    }
    const xs = [quad[0], quad[2], quad[4], quad[6]].filter((v): v is number => typeof v === "number");
    const ys = [quad[1], quad[3], quad[5], quad[7]].filter((v): v is number => typeof v === "number");
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
  }

  private async selectorBox(tabId: string, selector: string): Promise<Box> {
    const expression = `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: "center", inline: "center" });
      const rect = el.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
    })()`;
    const value = await this.evaluate(tabId, expression);
    if (!value || typeof value !== "object") {
      throw new ZimReaperError("NO_TARGET", `selector matched nothing: ${selector}`, {
        details: { selector },
        retryable: true,
      });
    }
    const box = value as Box;
    return { x: box.x, y: box.y, width: box.width, height: box.height };
  }

  private async scrollIntoView(tabId: string, info: RefInfo): Promise<void> {
    if (info.backendNodeId) {
      await this.backend.send(tabId, "DOM.scrollIntoViewIfNeeded", { backendNodeId: info.backendNodeId });
      return;
    }
    if (info.selector) {
      await this.evaluate(
        tabId,
        `document.querySelector(${JSON.stringify(info.selector)})?.scrollIntoView({block: "center"})`,
      );
    }
  }

  private async backendNodeIdFor(target: Target, ctx: ActionContext): Promise<number> {
    if (target.ref) {
      const info = this.perception.ref(ctx.tabId, target.ref);
      if (!info?.backendNodeId) {
        throw new ZimReaperError("STALE_REF", `ref ${target.ref} has no live node; re-snapshot`, {
          details: { ref: target.ref },
          retryable: true,
        });
      }
      return info.backendNodeId;
    }
    if (target.selector) {
      const { root } = await this.backend.send<{ root?: { nodeId: number } }>(ctx.tabId, "DOM.getDocument", {
        depth: 0,
      });
      if (!root) throw new ZimReaperError("BACKEND_ERROR", "no document root");
      const { nodeId } = await this.backend.send<{ nodeId: number }>(ctx.tabId, "DOM.querySelector", {
        nodeId: root.nodeId,
        selector: target.selector,
      });
      if (!nodeId) {
        throw new ZimReaperError("NO_TARGET", `selector matched nothing: ${target.selector}`, {
          retryable: true,
        });
      }
      const { node } = await this.backend.send<{ node?: { backendNodeId: number } }>(
        ctx.tabId,
        "DOM.describeNode",
        { nodeId },
      );
      if (!node?.backendNodeId) throw new ZimReaperError("NO_TARGET", "node has no backendNodeId");
      return node.backendNodeId;
    }
    throw new ZimReaperError("BAD_REQUEST", "target requires a ref or selector");
  }

  private async objectIdFor(target: Target, ctx: ActionContext): Promise<string> {
    const backendNodeId = await this.backendNodeIdFor(target, ctx);
    const res = await this.backend.send<{ object?: { objectId?: string } }>(
      ctx.tabId,
      "DOM.resolveNode",
      { backendNodeId },
    );
    const objectId = res.object?.objectId;
    if (!objectId) throw new ZimReaperError("NO_TARGET", "cannot resolve node to a JS object");
    return objectId;
  }

  private async isChecked(target: Target, ctx: ActionContext): Promise<boolean> {
    const objectId = await this.objectIdFor(target, ctx);
    const res = await this.backend.send<{ result?: { value?: unknown } }>(ctx.tabId, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration: "function () { return Boolean(this.checked ?? this.getAttribute('aria-checked') === 'true'); }",
      returnByValue: true,
    });
    return res.result?.value === true;
  }

  /* ------------------------------------------------------------- input prims */

  private async dispatchMouse(
    tabId: string,
    type: "mouseMoved" | "mousePressed" | "mouseReleased",
    point: Point,
    opts: { button: MouseButton | "none"; buttons: number; clickCount: number; modifiers: number },
  ): Promise<void> {
    await this.backend.send(tabId, "Input.dispatchMouseEvent", {
      type,
      x: point.x,
      y: point.y,
      button: opts.button,
      buttons: opts.buttons,
      clickCount: opts.clickCount,
      modifiers: opts.modifiers,
    });
  }

  private async moveTo(
    tabId: string,
    to: Point,
    steps: number,
    durationMs: number,
    ctx: ActionContext,
  ): Promise<void> {
    const from = this.cursor.get(tabId) ?? { x: 0, y: 0 };
    const total = Math.max(1, steps);
    for (let i = 1; i <= total; i += 1) {
      this.checkAbort(ctx);
      const t = i / total;
      const point = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
      await this.dispatchMouse(tabId, "mouseMoved", point, {
        button: "none",
        buttons: 0,
        clickCount: 0,
        modifiers: 0,
      });
      if (durationMs > 0) await this.sleep(durationMs / total, ctx);
    }
    this.cursor.set(tabId, to);
  }

  private async clickAt(
    tabId: string,
    point: Point,
    opts: { button: MouseButton; clickCount: number; modifiers: Modifier[]; delayMs: number },
    ctx: ActionContext,
  ): Promise<void> {
    const mask = modifierMask(opts.modifiers);
    const buttons = BUTTON_BITS[opts.button];
    await this.moveTo(tabId, point, 12, 60, ctx);
    await this.dispatchMouse(tabId, "mouseMoved", point, {
      button: "none",
      buttons: 0,
      clickCount: 0,
      modifiers: mask,
    });
    await this.dispatchMouse(tabId, "mousePressed", point, {
      button: opts.button,
      buttons,
      clickCount: opts.clickCount,
      modifiers: mask,
    });
    await this.sleep(opts.delayMs, ctx);
    await this.dispatchMouse(tabId, "mouseReleased", point, {
      button: opts.button,
      buttons: 0,
      clickCount: opts.clickCount,
      modifiers: mask,
    });
    this.cursor.set(tabId, point);
  }

  private async sendKeyEvent(
    tabId: string,
    type: "rawKeyDown" | "keyUp" | "char",
    spec: KeySpec,
    modifiers: readonly Modifier[],
    text: string | undefined,
  ): Promise<void> {
    const params: Record<string, unknown> = {
      type,
      key: spec.key,
      modifiers: modifierMask(modifiers),
    };
    if (spec.code) params.code = spec.code;
    if (spec.vk) {
      params.windowsVirtualKeyCode = spec.vk;
      params.nativeVirtualKeyCode = spec.vk;
    }
    if (text !== undefined) {
      params.text = text;
      params.unmodifiedText = text;
    }
    await this.backend.send(tabId, "Input.dispatchKeyEvent", params);
  }

  private async pressKey(
    tabId: string,
    key: string,
    modifiers: readonly Modifier[],
    ctx: ActionContext,
  ): Promise<void> {
    this.checkAbort(ctx);
    const spec = keySpec(key);
    const text = spec.text;
    await this.sendKeyEvent(tabId, "rawKeyDown", spec, modifiers, text);
    if (text && text !== "\r" && text !== "\t") {
      await this.sendKeyEvent(tabId, "char", spec, modifiers, text);
    }
    await this.sendKeyEvent(tabId, "keyUp", spec, modifiers, undefined);
  }

  /* ------------------------------------------------------------------- waits */

  private async waitForLoad(
    tabId: string,
    waitUntil: "load" | "domcontentloaded" | "networkidle" | "commit",
    timeoutMs: number,
    ctx: ActionContext,
  ): Promise<void> {
    if (waitUntil === "commit") return;
    const deadline = this.now() + timeoutMs;
    while (this.now() < deadline) {
      this.checkAbort(ctx);
      if (waitUntil === "networkidle") {
        const inflight = this.backend.inFlight?.(tabId) ?? 0;
        if (inflight === 0) return;
      } else {
        const ready = await this.evaluate(tabId, "document.readyState").catch(() => undefined);
        if (waitUntil === "domcontentloaded" && (ready === "interactive" || ready === "complete")) return;
        if (waitUntil === "load" && ready === "complete") return;
      }
      await this.sleep(50, ctx);
    }
    throw new ZimReaperError("TIMEOUT", `page did not reach ${waitUntil} within ${timeoutMs}ms`, {
      details: { waitUntil, timeoutMs },
      retryable: true,
    });
  }

  private async conditionMet(
    tabId: string,
    condition: {
      selector?: string;
      text?: string;
      urlContains?: string;
      networkIdle?: boolean;
      expression?: string;
      refGone?: string;
    },
    ctx: ActionContext,
  ): Promise<boolean> {
    if (condition.networkIdle) {
      if ((this.backend.inFlight?.(tabId) ?? 0) > 0) return false;
    }
    if (condition.urlContains) {
      const info = await this.pageInfo(tabId);
      if (!info.url.includes(condition.urlContains)) return false;
    }
    if (condition.refGone) {
      if (this.perception.ref(tabId, condition.refGone) !== undefined) return false;
    }
    if (condition.selector) {
      const found = await this.evaluate(
        tabId,
        `Boolean(document.querySelector(${JSON.stringify(condition.selector)}))`,
      ).catch(() => false);
      if (found !== true) return false;
    }
    if (condition.text) {
      const found = await this.evaluate(
        tabId,
        `(document.body ? document.body.innerText : "").includes(${JSON.stringify(condition.text)})`,
      ).catch(() => false);
      if (found !== true) return false;
    }
    if (condition.expression) {
      const ok = await this.evaluate(tabId, `Boolean(${condition.expression})`, { awaitPromise: true }).catch(
        () => false,
      );
      if (ok !== true) return false;
    }
    this.checkAbort(ctx);
    return true;
  }

  /* --------------------------------------------------------------- artifacts */

  private async screenshot(
    action: Extract<Action, { kind: "page.screenshot" }>,
    ctx: ActionContext,
  ): Promise<ActionResult> {
    const tabId = ctx.tabId;
    const params: Record<string, unknown> = {
      format: action.format,
      ...(action.quality !== undefined ? { quality: action.quality } : {}),
    };
    if (action.clip) {
      params.clip = { ...action.clip, scale: 1 };
    } else if (action.fullPage) {
      const metrics = await this.backend.send<{
        cssContentSize?: { width: number; height: number };
        contentSize?: { width: number; height: number };
      }>(tabId, "Page.getLayoutMetrics", {});
      const size = metrics.cssContentSize ?? metrics.contentSize;
      if (size) {
        params.captureBeyondViewport = true;
        params.clip = {
          x: 0,
          y: 0,
          width: Math.ceil(size.width),
          height: Math.ceil(size.height),
          scale: 1,
        };
      }
    }
    const { data } = await this.backend.send<{ data: string }>(tabId, "Page.captureScreenshot", params);
    const ext = action.format === "jpeg" ? "jpg" : action.format;
    const target = action.path ?? join(this.artifactsDir, `${tabId}-${this.now()}.${ext}`);
    await mkdir(dirname(target), { recursive: true });
    const bytes = Buffer.from(data, "base64");
    await writeFile(target, bytes, { mode: 0o600 });

    const result: ActionResult = { path: target, format: action.format, bytes: bytes.length };
    if (action.annotate) {
      // The HUD draws the boxes; the executor only reports where they go.
      const snapshot = this.snapshots.get(tabId) ?? (await this.perception.snapshot(tabId, { maxChars: 12_000 }));
      this.snapshots.set(tabId, snapshot);
      const marks = snapshot.refs.map((ref, index) => ({ n: index + 1, ref: ref.ref, bbox: ref.bbox }));
      result.marks = marks;
      result.image = `data:image/${action.format};base64,${data}`;
      result.snapshotId = snapshot.snapshotId;
    }
    return result;
  }

  /* ---------------------------------------------------------------- network */

  private async route(
    action: Extract<Action, { kind: "net.route" }>,
    ctx: ActionContext,
  ): Promise<ActionResult> {
    const tabId = ctx.tabId;
    const id = `r${++this.routeSeq}`;
    const rule: RouteRule = {
      id,
      pattern: action.pattern,
      mode: action.mode,
      status: action.status,
      headers: action.headers,
      body: action.body,
      method: action.method,
      tabId,
      hits: 0,
    };
    this.routes.set(id, rule);
    await this.backend.send(tabId, "Fetch.enable", {
      patterns: [{ urlPattern: "*", requestStage: "Request" }],
    });
    return { ruleId: id, pattern: rule.pattern, mode: rule.mode };
  }

  private patternMatches(pattern: string, url: string): boolean {
    if (pattern.startsWith("re:")) {
      try {
        return new RegExp(pattern.slice(3)).test(url);
      } catch {
        return false;
      }
    }
    if (pattern.includes("*")) {
      const escaped = pattern
        .split("*")
        .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join(".*");
      return new RegExp(`^${escaped}$`).test(url);
    }
    return url.includes(pattern);
  }

  private async onRequestPaused(tabId: string, params: Record<string, unknown>): Promise<void> {
    const requestId = String(params.requestId ?? "");
    const request = (params.request ?? {}) as Record<string, unknown>;
    const url = String(request.url ?? "");
    const method = String(request.method ?? "GET").toUpperCase();
    if (!requestId) return;
    const rule = [...this.routes.values()].find(
      (candidate) =>
        candidate.tabId === tabId &&
        (!candidate.method || candidate.method.toUpperCase() === method) &&
        this.patternMatches(candidate.pattern, url),
    );
    try {
      if (!rule || rule.mode === "pass") {
        await this.backend.send(tabId, "Fetch.continueRequest", { requestId });
        return;
      }
      rule.hits += 1;
      if (rule.mode === "block") {
        await this.backend.send(tabId, "Fetch.failRequest", { requestId, errorReason: "BlockedByClient" });
        return;
      }
      const headers = Object.entries(rule.headers ?? {}).map(([name, value]) => ({ name, value }));
      if (!headers.some((header) => header.name.toLowerCase() === "content-type")) {
        headers.push({ name: "content-type", value: "application/json" });
      }
      await this.backend.send(tabId, "Fetch.fulfillRequest", {
        requestId,
        responseCode: rule.status ?? 200,
        responseHeaders: headers,
        body: Buffer.from(rule.body ?? "").toString("base64"),
      });
    } catch (err) {
      // A paused request whose tab navigated away cannot be continued; drop it.
      log.debug("fetch interception failed", { tabId, error: String(err) });
    }
  }

  private async replay(
    action: Extract<Action, { kind: "net.replay" }>,
    ctx: ActionContext,
  ): Promise<ActionResult> {
    const tabId = ctx.tabId;
    const entries = this.backend.netEntries?.(tabId) ?? [];
    const entry = entries.find((candidate) => candidate.requestId === action.requestId);
    if (!entry) {
      throw new ZimReaperError("NOT_FOUND", `no captured request ${action.requestId}`, {
        details: { requestId: action.requestId },
      });
    }
    const url = action.overrides?.url ?? entry.url;
    const method = action.overrides?.method ?? entry.method;
    const headers = action.overrides?.headers ?? entry.requestHeaders ?? {};
    const body = action.overrides?.body;
    const expression = `(async () => {
      const res = await fetch(${JSON.stringify(url)}, {
        method: ${JSON.stringify(method)},
        headers: ${JSON.stringify(headers)},
        credentials: "include",
        ${body !== undefined ? `body: ${JSON.stringify(body)},` : ""}
      });
      const text = await res.text();
      return JSON.stringify({ status: res.status, headers: Object.fromEntries(res.headers.entries()), body: text.slice(0, 200000) });
    })()`;
    const raw = await this.evaluate(tabId, expression, { awaitPromise: true });
    if (typeof raw !== "string") {
      throw new ZimReaperError("BACKEND_ERROR", "replay produced no response");
    }
    const parsed = JSON.parse(raw) as { status: number; headers: Record<string, string>; body: string };
    return { requestId: action.requestId, url, method, status: parsed.status, headers: parsed.headers, body: parsed.body };
  }

  private async har(action: Extract<Action, { kind: "net.har" }>, ctx: ActionContext): Promise<ActionResult> {
    const tabId = ctx.tabId;
    if (action.action === "start") {
      const entries = this.backend.netEntries?.(tabId) ?? [];
      const lastSeq = entries.length > 0 ? (entries[entries.length - 1]?.seq ?? 0) : 0;
      this.harStart.set(tabId, { seq: lastSeq, at: this.now() });
      return { recording: true, fromSeq: lastSeq };
    }
    const start = this.harStart.get(tabId);
    if (!start) throw new ZimReaperError("BAD_REQUEST", "net.har stop without start");
    this.harStart.delete(tabId);
    const entries = (this.backend.netEntries?.(tabId) ?? []).filter((entry) => entry.seq > start.seq);
    const har = {
      log: {
        version: "1.2",
        creator: { name: "zimreaper", version: "0.1.0" },
        pages: [],
        entries: entries.map((entry) => ({
          startedDateTime: new Date(entry.startedAt).toISOString(),
          time: (entry.finishedAt ?? entry.startedAt) - entry.startedAt,
          request: {
            method: entry.method,
            url: entry.url,
            httpVersion: "HTTP/1.1",
            headers: Object.entries(entry.requestHeaders ?? {}).map(([name, value]) => ({ name, value })),
            queryString: [],
            cookies: [],
            headersSize: -1,
            bodySize: -1,
          },
          response: {
            status: entry.status ?? 0,
            statusText: "",
            httpVersion: "HTTP/1.1",
            headers: Object.entries(entry.responseHeaders ?? {}).map(([name, value]) => ({ name, value })),
            cookies: [],
            content: { size: entry.encodedBytes ?? 0, mimeType: entry.mimeType ?? "" },
            redirectURL: "",
            headersSize: -1,
            bodySize: entry.encodedBytes ?? -1,
          },
          cache: {},
          timings: { send: 0, wait: 0, receive: 0 },
        })),
      },
    };
    const path = action.path ?? join(this.artifactsDir, `har-${this.now()}.json`);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(har, null, 2), { mode: 0o600 });
    return { path, entries: entries.length, fromSeq: start.seq };
  }

  /* ---------------------------------------------------------------- session */

  private async copySession(sourceTabId: string, targetTabId: string): Promise<void> {
    const cookies = await this.backend
      .send<{ cookies?: unknown[] }>(sourceTabId, "Network.getCookies", {})
      .catch(() => ({ cookies: [] as unknown[] }));
    if (cookies.cookies && cookies.cookies.length > 0) {
      await this.backend
        .send(targetTabId, "Network.setCookies", { cookies: cookies.cookies })
        .catch(() => undefined);
    }
    const info = await this.pageInfo(sourceTabId);
    let origin: string | undefined;
    try {
      origin = info.url ? new URL(info.url).origin : undefined;
    } catch {
      origin = undefined;
    }
    if (!origin) return;
    const storageId = { securityOrigin: origin, isLocalStorage: true };
    const items = await this.backend
      .send<{ entries?: Array<[string, string]> }>(sourceTabId, "DOMStorage.getDOMStorageItems", {
        storageId,
      })
      .catch(() => ({ entries: [] as Array<[string, string]> }));
    for (const [key, value] of items.entries ?? []) {
      await this.backend
        .send(targetTabId, "DOMStorage.setDOMStorageItem", { storageId, key, value })
        .catch(() => undefined);
    }
  }

  /* ----------------------------------------------------------------- vision */

  private async ground(
    action: Extract<Action, { kind: "vision.ground" }>,
    ctx: ActionContext,
  ): Promise<ActionResult> {
    const tabId = ctx.tabId;
    const screenshot = await this.screenshot(
      {
        kind: "page.screenshot",
        fullPage: false,
        annotate: false,
        format: "png",
        ...(action.screenshotPath ? { path: action.screenshotPath } : {}),
      } as Extract<Action, { kind: "page.screenshot" }>,
      ctx,
    );
    const path = typeof screenshot.path === "string" ? screenshot.path : undefined;
    const snapshot = this.snapshots.get(tabId) ?? (await this.perception.snapshot(tabId, { maxChars: 12_000 }));
    this.snapshots.set(tabId, snapshot);

    if (this.vlmGround) {
      const hint = await this.vlmGround({
        tabId,
        description: action.description,
        screenshotPath: path,
        refs: snapshot.refs,
      });
      if (hint?.ref || hint?.point) {
        const info = hint.ref ? snapshot.refs.find((ref) => ref.ref === hint.ref) : undefined;
        const point = hint.point ?? (info ? { x: info.bbox.x + info.bbox.width / 2, y: info.bbox.y + info.bbox.height / 2 } : undefined);
        if (point) {
          return {
            ref: hint.ref ?? info?.ref,
            point,
            confidence: hint.confidence ?? 1,
            method: "vlm",
            screenshotPath: path,
          };
        }
      }
    }

    // Deterministic fallback: token overlap against ref role/name. A VLM hook replaces this.
    const words = action.description.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 1);
    let best: { ref: RefInfo; score: number } | undefined;
    for (const ref of snapshot.refs) {
      const haystack = `${ref.role} ${ref.name}`.toLowerCase();
      let score = 0;
      for (const word of words) if (haystack.includes(word)) score += 1;
      if (ref.role === "button" || ref.role === "link" || ref.role === "textbox") score += 0.25;
      if (!best || score > best.score) best = { ref, score };
    }
    if (!best || best.score === 0) {
      throw new ZimReaperError("NO_TARGET", `could not ground "${action.description}" against the snapshot`, {
        details: { description: action.description, refs: snapshot.refs.length },
        retryable: true,
      });
    }
    return {
      ref: best.ref.ref,
      point: { x: best.ref.bbox.x + best.ref.bbox.width / 2, y: best.ref.bbox.y + best.ref.bbox.height / 2 },
      confidence: Math.min(1, best.score / Math.max(1, words.length)),
      method: "heuristic",
      screenshotPath: path,
      note: "heuristic name match; pass ExecutorOptions.vlmGround to use a vision model",
    };
  }
}

function paperSize(format: string): { width: number; height: number } {
  const sizes: Record<string, { width: number; height: number }> = {
    A3: { width: 11.69, height: 16.54 },
    A4: { width: 8.27, height: 11.69 },
    A5: { width: 5.83, height: 8.27 },
    Letter: { width: 8.5, height: 11 },
    Legal: { width: 8.5, height: 14 },
    Tabloid: { width: 11, height: 17 },
  };
  return sizes[format] ?? sizes.A4 ?? { width: 8.27, height: 11.69 };
}

/** sha256 of canonical JSON; used for audit argsHash so ordering never changes the digest. */
export function canonicalHash(value: unknown): string {
  return createHash("sha256").update(canonicalJson(value)).digest("hex");
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
}

export { delay as sleepMs };
