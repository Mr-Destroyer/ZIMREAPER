import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { ZimReaperError, type Action } from "@zimreaper/protocol";
import { Executor, type ActionContext } from "../src/executor.js";
import { FakeBackend, FakePerception, FakePolicy } from "./fakes.js";

let artifactsDir: string;

beforeAll(async () => {
  artifactsDir = await mkdtemp(join(tmpdir(), "zimreaper-core-test-"));
});

function setup(): {
  backend: FakeBackend;
  perception: FakePerception;
  policy: FakePolicy;
  executor: Executor;
} {
  const backend = new FakeBackend();
  const perception = new FakePerception();
  const policy = new FakePolicy();
  const executor = new Executor({ backend, perception, policy, artifactsDir });
  return { backend, perception, policy, executor };
}

function ctx(tabId = "t1", signal?: AbortSignal): ActionContext {
  return {
    tabId,
    requestId: "r1",
    actor: "test",
    signal: signal ?? new AbortController().signal,
  };
}

const clickOn = (ref: string): Action => ({
  kind: "mouse.click",
  target: { ref },
  button: "left",
  clickCount: 1,
  modifiers: [],
  delayMs: 0,
});

async function codeOf(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ZimReaperError) return err.code;
    throw err;
  }
  throw new Error("expected the action to fail");
}

describe("Executor target resolution", () => {
  it("click by ref resolves the box model then dispatches real mouse input at the quad center", async () => {
    const { backend, perception, executor } = setup();
    perception.setRef("e1", { backendNodeId: 42 });

    const result = await executor.act(clickOn("e1"), ctx());

    const boxCalls = backend.callsFor("DOM.getBoxModel");
    expect(boxCalls).toHaveLength(1);
    expect(boxCalls[0]?.params.backendNodeId).toBe(42);

    const pressed = backend.lastCall("Input.dispatchMouseEvent", (p) => p.type === "mousePressed");
    const released = backend.lastCall("Input.dispatchMouseEvent", (p) => p.type === "mouseReleased");
    const moves = backend.callsFor("Input.dispatchMouseEvent", (p) => p.type === "mouseMoved");

    expect(pressed?.params).toMatchObject({
      type: "mousePressed",
      x: 200,
      y: 230,
      button: "left",
      buttons: 1,
      clickCount: 1,
      modifiers: 0,
    });
    expect(released?.params).toMatchObject({ type: "mouseReleased", x: 200, y: 230, buttons: 0 });
    expect(moves.length).toBeGreaterThan(1);
    expect(moves.at(-1)?.params).toMatchObject({ x: 200, y: 230 });

    // Real input only: no element.click() / JS click shortcut anywhere.
    expect(backend.methods()).not.toContain("Runtime.callFunctionOn");
    expect(result.clicked).toEqual({ x: 200, y: 230 });
    expect(result.ref).toBe("e1");
  });

  it("resolves a selector through getBoundingClientRect", async () => {
    const { backend, executor } = setup();

    const result = await executor.act(
      { kind: "mouse.click", target: { selector: "#go" }, button: "left", clickCount: 1, modifiers: [], delayMs: 0 },
      ctx(),
    );

    const evaluate = backend.callsFor("Runtime.evaluate", (p) =>
      String(p.expression).includes("getBoundingClientRect"),
    );
    expect(evaluate.length).toBeGreaterThan(0);
    expect(result.clicked).toEqual({ x: 200, y: 230 });
  });

  it("returns STALE_REF for a ref from an older generation", async () => {
    const { perception, executor } = setup();
    perception.setRef("e1", { backendNodeId: 42 });
    perception.generationValue = 4;

    expect(await codeOf(executor.act(clickOn("e99"), ctx()))).toBe("STALE_REF");
  });

  it("returns NO_TARGET for a ref with no snapshot at all", async () => {
    const { perception, executor } = setup();
    perception.generationValue = 0;

    expect(await codeOf(executor.act(clickOn("e1"), ctx()))).toBe("NO_TARGET");
  });
});

describe("Executor keyboard", () => {
  it("parses Control+Shift+T into modifier mask 10", async () => {
    const { backend, executor } = setup();

    const result = await executor.act({ kind: "key.chord", chord: "Control+Shift+T" }, ctx());

    const down = backend.lastCall("Input.dispatchKeyEvent", (p) => p.type === "rawKeyDown");
    expect(down?.params).toMatchObject({ key: "T", code: "KeyT", modifiers: 10, windowsVirtualKeyCode: 84 });
    expect(backend.lastCall("Input.dispatchKeyEvent", (p) => p.type === "keyUp")?.params.modifiers).toBe(10);
    expect(result.modifiersMask).toBe(10);
  });

  it("uses Input.insertText when key.type delayMs is 0", async () => {
    const { backend, executor } = setup();

    await executor.act({ kind: "key.type", text: "hello", delayMs: 0, clearFirst: false }, ctx());

    expect(backend.lastCall("Input.insertText")?.params.text).toBe("hello");
    expect(backend.callsFor("Input.dispatchKeyEvent")).toHaveLength(0);
  });

  it("dispatches per-character events when a delay is requested", async () => {
    const { backend, executor } = setup();

    await executor.act({ kind: "key.type", text: "ab", delayMs: 1, clearFirst: false }, ctx());

    expect(backend.callsFor("Input.insertText")).toHaveLength(0);
    const chars = backend.callsFor("Input.dispatchKeyEvent", (p) => p.type === "char");
    expect(chars.map((call) => call.params.text)).toEqual(["a", "b"]);
  });

  it("maps Enter to virtual key code 13", async () => {
    const { backend, executor } = setup();

    await executor.act({ kind: "key.press", key: "Enter", modifiers: [], count: 1 }, ctx());

    const down = backend.lastCall("Input.dispatchKeyEvent", (p) => p.type === "rawKeyDown");
    expect(down?.params).toMatchObject({ key: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
  });
});

describe("Executor dom + page actions", () => {
  it("dom.fill focuses the field, clears it and inserts text", async () => {
    const { backend, perception, executor } = setup();
    perception.setRef("e2", { backendNodeId: 43, role: "textbox" });

    await executor.act(
      { kind: "dom.fill", target: { ref: "e2" }, text: "zim", clear: true, submit: false },
      ctx(),
    );

    const press = backend.lastCall("Input.dispatchMouseEvent", (p) => p.type === "mousePressed");
    expect(press?.params).toMatchObject({ x: 200, y: 230 });
    expect(backend.lastCall("Input.insertText")?.params.text).toBe("zim");
    // clearFirst path: Control+A then Backspace
    const chordA = backend.lastCall("Input.dispatchKeyEvent", (p) => p.type === "rawKeyDown" && p.key === "a");
    expect(chordA?.params.modifiers).toBe(2);
    const backspace = backend.lastCall("Input.dispatchKeyEvent", (p) => p.type === "rawKeyDown" && p.key === "Backspace");
    expect(backspace?.params.windowsVirtualKeyCode).toBe(8);
  });

  it("dom.check clicks only when the state differs", async () => {
    const { backend, perception, executor } = setup();
    perception.setRef("e3", { backendNodeId: 44, role: "checkbox" });
    backend.responseFor = (method, params) => {
      if (method === "Runtime.callFunctionOn" && String(params.functionDeclaration).includes("checked")) {
        return { result: { value: true } };
      }
      return undefined;
    };

    const result = await executor.act(
      { kind: "dom.check", target: { ref: "e3" }, checked: true },
      ctx(),
    );

    expect(result.changed).toBe(false);
    expect(backend.callsFor("Input.dispatchMouseEvent")).toHaveLength(0);
  });

  it("page.wait returns once the condition holds", async () => {
    const { executor } = setup();

    const result = await executor.act(
      { kind: "page.wait", for: { selector: "#done" }, timeoutMs: 2_000, pollMs: 25 },
      ctx(),
    );

    expect(result.url).toBe("https://example.test/");
    expect(typeof result.waitedMs).toBe("number");
  });

  it("page.wait maps a never-true condition to TIMEOUT", async () => {
    const { backend, executor } = setup();
    backend.responseFor = (method, params) => {
      if (method === "Runtime.evaluate" && String(params.expression).includes("Boolean(document.querySelector")) {
        return { result: { value: false } };
      }
      return undefined;
    };

    expect(
      await codeOf(
        executor.act({ kind: "page.wait", for: { selector: "#never" }, timeoutMs: 120, pollMs: 25 }, ctx()),
      ),
    ).toBe("TIMEOUT");
  });

  it("page.screenshot writes an artifact and returns marks when annotating", async () => {
    const { perception, executor } = setup();
    perception.setRef("e1", { backendNodeId: 42 });
    perception.setRef("e2", { backendNodeId: 43, name: "Cancel" });

    const result = await executor.act(
      { kind: "page.screenshot", fullPage: true, annotate: true, format: "png" },
      ctx(),
    );

    expect(typeof result.path).toBe("string");
    expect(String(result.path).startsWith(artifactsDir)).toBe(true);
    const marks = result.marks as Array<{ n: number; ref: string }>;
    expect(marks.map((mark) => mark.ref)).toEqual(["e1", "e2"]);
    expect(String(result.image).startsWith("data:image/png;base64,")).toBe(true);
  });

  it("net.route enables Fetch interception and reports a rule id", async () => {
    const { backend, executor } = setup();

    const result = await executor.act(
      { kind: "net.route", pattern: "*://example.test/api/*", mode: "mock", status: 201, body: "{}" },
      ctx(),
    );

    expect(backend.lastCall("Fetch.enable")).toBeDefined();
    expect(result.ruleId).toBe("r1");
  });

  it("answers paused requests with the mocked body", async () => {
    const { backend, executor } = setup();
    await executor.act(
      { kind: "net.route", pattern: "*api/items*", mode: "mock", status: 201, body: '{"ok":true}' },
      ctx(),
    );

    backend.emitCdp("t1", "Fetch.requestPaused", {
      requestId: "req-9",
      request: { url: "https://example.test/api/items", method: "GET" },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const fulfilled = backend.lastCall("Fetch.fulfillRequest");
    expect(fulfilled?.params).toMatchObject({ requestId: "req-9", responseCode: 201 });
    expect(Buffer.from(String(fulfilled?.params.body), "base64").toString()).toBe('{"ok":true}');
  });
});

describe("Executor cancellation", () => {
  it("aborts before dispatch when the signal is already aborted", async () => {
    const { backend, executor } = setup();
    const controller = new AbortController();
    controller.abort();

    expect(await codeOf(executor.act(clickOn("e1"), ctx("t1", controller.signal)))).toBe("CANCELLED");
    expect(backend.calls).toHaveLength(0);
  });
});
