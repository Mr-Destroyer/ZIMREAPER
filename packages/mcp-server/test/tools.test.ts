import { describe, expect, it } from "vitest";
import type { AutoUpdateResult, Provider } from "@zimreaper/agent";
import {
  browserToolDefinitions,
  browserTools,
  zodShapeToJsonSchema,
} from "../src/index.js";
import { asClient, FakeControlClient } from "./fake-client.js";

const fake = (): FakeControlClient => new FakeControlClient();

const noUpdate = async (): Promise<AutoUpdateResult> => ({
  enabled: true,
  skipped: true,
  updated: false,
  ahead: 0,
  behind: 0,
  message: "test update check",
});

describe("browser tool surface", () => {
  it("matches the golden name and schema list", () => {
    const defs = browserToolDefinitions(asClient(fake()));
    const snapshot = defs.map((def) => ({
      name: def.name,
      description: def.description,
      mutates: def.mutates,
      inputSchema: zodShapeToJsonSchema(def.shape),
    }));
    expect(snapshot).toMatchSnapshot();
  });

  it("exposes every required browser tool with a non-empty description", () => {
    const defs = browserToolDefinitions(asClient(fake()));
    expect(defs.map((def) => def.name)).toEqual([
      "browser_navigate",
      "browser_snapshot",
      "browser_diff",
      "browser_click",
      "browser_type",
      "browser_press",
      "browser_hover",
      "browser_drag",
      "browser_scroll",
      "browser_screenshot",
      "browser_wait",
      "browser_tabs",
      "browser_nav",
      "browser_eval",
      "browser_extract",
      "browser_network",
      "browser_cookies",
      "browser_set_viewport",
      "browser_fork_session",
      "browser_task",
      "browser_ask_human",
    ]);
    for (const def of defs) expect(def.description.length).toBeGreaterThan(10);
  });

  it("derives agent tools with JSON schemas and validators", () => {
    const tools = browserTools(asClient(fake()));
    const click = tools.find((tool) => tool.spec.name === "browser_click");
    expect(click?.spec.inputSchema).toMatchObject({
      type: "object",
      additionalProperties: false,
    });
    expect(click?.schema?.safeParse({ ref: "e1" }).success).toBe(true);
    expect(click?.schema?.safeParse({}).success).toBe(true);
    expect(click?.schema?.safeParse({ clickCount: "two" }).success).toBe(false);
    const snapshot = tools.find((tool) => tool.spec.name === "browser_snapshot");
    expect(snapshot?.spec.tainted).toBe(true);
    expect(snapshot?.spec.mutates).toBe(false);
  });
});

describe("tool call-through", () => {
  it("maps browser_click to mouse.click with a ref target", async () => {
    const client = fake();
    const tools = browserTools(asClient(client));
    const click = tools.find((tool) => tool.spec.name === "browser_click");
    const result = await click?.run({ ref: "e12", clickCount: 2 });
    expect(client.calls).toHaveLength(1);
    expect(client.calls[0]?.payload).toMatchObject({
      kind: "mouse.click",
      target: { ref: "e12" },
      clickCount: 2,
      button: "left",
    });
    expect(result).toMatchObject({ text: expect.stringContaining("Clicked") });
  });

  it("lists tabs as a table", async () => {
    const client = new FakeControlClient({
      queryResult: [
        {
          tabId: "t1",
          url: "https://example.com",
          title: "Example",
          active: true,
          partition: "default",
          loading: false,
          canGoBack: false,
          canGoForward: false,
          createdAt: 1,
        },
      ],
    });
    const tabs = browserTools(asClient(client)).find((tool) => tool.spec.name === "browser_tabs");
    const result = await tabs?.run({ op: "list" });
    expect(client.calls[0]?.payload).toEqual({ kind: "tab.list" });
    expect(result).toMatchObject({ text: expect.stringContaining("Example") });
  });

  it("maps browser_nav reload and browser_wait conditions", async () => {
    const client = fake();
    const tools = browserTools(asClient(client));
    const nav = tools.find((tool) => tool.spec.name === "browser_nav");
    await nav?.run({ op: "reload", ignoreCache: true });
    expect(client.calls[0]?.payload).toEqual({ kind: "nav.reload", ignoreCache: true });
    const wait = tools.find((tool) => tool.spec.name === "browser_wait");
    await wait?.run({ selector: "#ready", timeoutMs: 5000 });
    expect(client.calls[1]?.payload).toMatchObject({
      kind: "page.wait",
      for: { selector: "#ready" },
      timeoutMs: 5000,
    });
  });

  it("returns a typed error instead of throwing when a required arg is absent", async () => {
    const client = fake();
    const tabs = browserTools(asClient(client)).find((tool) => tool.spec.name === "browser_tabs");
    await expect(tabs?.run({ op: "close" })).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(client.calls).toHaveLength(0);
  });

  it("returns an explanatory error when browser_task has no provider", async () => {
    const previous = process.env.ZIMREAPER_PROVIDER;
    process.env.ZIMREAPER_PROVIDER = "custom:not-configured";
    try {
      const task = browserTools(asClient(fake()), { updateCheck: noUpdate }).find(
        (tool) => tool.spec.name === "browser_task",
      );
      await expect(task?.run({ task: "do it" })).rejects.toMatchObject({ code: "UNSUPPORTED" });
    } finally {
      if (previous === undefined) delete process.env.ZIMREAPER_PROVIDER;
      else process.env.ZIMREAPER_PROVIDER = previous;
    }
  });

  it("checks for repository updates before starting browser_task", async () => {
    let updateChecks = 0;
    const provider: Provider = {
      name: "fake",
      model: "fake-model",
      async complete() {
        return { text: "done", toolCalls: [], stopReason: "end" as const };
      },
    };
    const task = browserTools(asClient(fake()), {
      provider,
      updateCheck: async () => {
        updateChecks += 1;
        return {
          enabled: true,
          skipped: false,
          updated: true,
          branch: "main",
          upstream: "origin/main",
          ahead: 0,
          behind: 1,
          message: "updated",
        };
      },
    }).find((tool) => tool.spec.name === "browser_task");

    const result = await task?.run({ task: "do it" });
    expect(updateChecks).toBe(1);
    expect(result).toMatchObject({
      structuredContent: { update: { updated: true, behind: 1 } },
    });
  });

  it("does not run browser_task when the update preflight fails", async () => {
    let completed = false;
    const provider: Provider = {
      name: "fake",
      model: "fake-model",
      async complete() {
        completed = true;
        return { text: "done", toolCalls: [], stopReason: "end" as const };
      },
    };
    const task = browserTools(asClient(fake()), {
      provider,
      updateCheck: async () => {
        throw new Error("update unavailable");
      },
    }).find((tool) => tool.spec.name === "browser_task");

    await expect(task?.run({ task: "do it" })).rejects.toMatchObject({
      code: "INTERNAL",
      message: "update unavailable",
    });
    expect(completed).toBe(false);
  });
});
