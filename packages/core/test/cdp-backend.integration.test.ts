import { describe, expect, it } from "vitest";
import type { Perception } from "@zimreaper/perception";
import type { RefInfo } from "@zimreaper/protocol";
import type { Backend } from "../src/backend.js";
import { launchCdpBackend } from "../src/cdp-backend.js";
import { Executor } from "../src/executor.js";
import { FakePolicy } from "./fakes.js";

/**
 * Real-browser smoke test. Opt-in because it needs a Chromium binary and a display-free
 * environment: ZIMREAPER_INTEGRATION=1 npm test -w @zimreaper/core
 */
const enabled = process.env.ZIMREAPER_INTEGRATION === "1";

describe.skipIf(!enabled)("CdpBackend against real Chromium", () => {
  it("launches, lists a tab, evaluates script and captures a screenshot", async () => {
    let backend: Backend | undefined;
    try {
      backend = await launchCdpBackend({ headless: true });
      const tabs = await backend.listTabs();
      expect(tabs.length).toBeGreaterThan(0);

      const tabId = tabs[0]?.tabId as string;
      await backend.send(tabId, "Page.navigate", { url: "data:text/html,<title>Zim</title><h1 id=h>hello</h1>" });
      await new Promise((resolve) => setTimeout(resolve, 300));

      const evaluated = await backend.send<{ result?: { value?: unknown } }>(tabId, "Runtime.evaluate", {
        expression: "document.querySelector('#h').textContent",
        returnByValue: true,
      });
      expect(evaluated.result?.value).toBe("hello");

      const shot = await backend.send<{ data?: string }>(tabId, "Page.captureScreenshot", { format: "png" });
      expect((shot.data ?? "").length).toBeGreaterThan(100);

      const box = await backend.send<{ model?: { content?: number[] } }>(tabId, "DOM.getBoxModel", {
        backendNodeId: await backendNodeId(backend, tabId, "h1"),
      });
      expect(box.model?.content?.length).toBe(8);
    } finally {
      await backend?.close();
    }
  }, 60_000);

  it("creates and closes a second tab", async () => {
    let backend: Backend | undefined;
    try {
      backend = await launchCdpBackend({ headless: true });
      const created = await backend.createTab({ url: "about:blank" });
      expect((await backend.listTabs()).length).toBeGreaterThanOrEqual(2);
      await backend.closeTab(created.tabId);
      const remaining = await backend.listTabs();
      expect(remaining.some((tab) => tab.tabId === created.tabId)).toBe(false);
    } finally {
      await backend?.close();
    }
  }, 60_000);

  it("clicks a real button through the executor with real mouse events", async () => {
    let backend: Backend | undefined;
    try {
      backend = await launchCdpBackend({ headless: true });
      const tab = (await backend.listTabs())[0];
      expect(tab).toBeDefined();
      const tabId = tab?.tabId as string;
      const html = `<button id=go style="position:absolute;left:100px;top:100px;width:200px;height:60px"
        onclick="document.title='clicked'">Go</button>`;
      await backend.send(tabId, "Page.navigate", {
        url: `data:text/html,${encodeURIComponent(html)}`,
      });
      await new Promise((resolve) => setTimeout(resolve, 400));

      const nodeId = await backendNodeId(backend, tabId, "button");
      const ref: RefInfo = {
        ref: "e1",
        role: "button",
        name: "Go",
        bbox: { x: 100, y: 100, width: 200, height: 60 },
        textHash: "h",
        generation: 1,
        backendNodeId: nodeId,
      };
      const perception: Perception = {
        snapshot: async () => {
          throw new Error("not used");
        },
        diff: async () => {
          throw new Error("not used");
        },
        ref: (_tab, candidate) => (candidate === "e1" ? ref : undefined),
        generation: () => 1,
        pageHash: () => "h",
        invalidate: () => undefined,
      };
      const executor = new Executor({
        backend,
        perception,
        policy: new FakePolicy(),
        artifactsDir: "/tmp",
      });

      const result = await executor.act(
        { kind: "mouse.click", target: { ref: "e1" }, button: "left", clickCount: 1, modifiers: [], delayMs: 20 },
        { tabId, requestId: "r1", actor: "test", signal: new AbortController().signal },
      );

      const title = await backend.send<{ result?: { value?: unknown } }>(tabId, "Runtime.evaluate", {
        expression: "document.title",
        returnByValue: true,
      });
      expect(title.result?.value).toBe("clicked");
      expect(result.clicked).toEqual({ x: 200, y: 130 });
    } finally {
      await backend?.close();
    }
  }, 60_000);
});

async function backendNodeId(backend: Backend, tabId: string, selector: string): Promise<number> {
  const { root } = await backend.send<{ root: { nodeId: number } }>(tabId, "DOM.getDocument", { depth: 0 });
  const { nodeId } = await backend.send<{ nodeId: number }>(tabId, "DOM.querySelector", {
    nodeId: root.nodeId,
    selector,
  });
  const { node } = await backend.send<{ node: { backendNodeId: number } }>(tabId, "DOM.describeNode", {
    nodeId,
  });
  return node.backendNodeId;
}
