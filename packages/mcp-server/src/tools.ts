import { z } from "zod";
import type { Tool, Provider, ProviderConfig } from "@zimreaper/agent";
import { AgentLoop, createProvider } from "@zimreaper/agent";
import type { ControlClient } from "@zimreaper/core";
import {
  ActionSchema,
  QuerySchema,
  ZimReaperError,
  type Action,
  type Query,
} from "@zimreaper/protocol";

const TargetShape = z.object({
  ref: z.string().optional().describe("Snapshot ref such as e12"),
  selector: z.string().optional().describe("CSS selector fallback"),
  x: z.number().optional().describe("Viewport x coordinate"),
  y: z.number().optional().describe("Viewport y coordinate"),
  offsetX: z.number().optional(),
  offsetY: z.number().optional(),
});

const TargetInput = TargetShape.describe("A snapshot ref, CSS selector, or raw viewport point");

type TargetInput = z.infer<typeof TargetShape>;
export type JsonRecord = Record<string, unknown>;

export interface BrowserToolOptions {
  /** Provider used by browser_task. Defaults to env-derived provider configuration. */
  provider?: Provider;
  providerConfig?: ProviderConfig;
  taskMaxSteps?: number;
}

export interface ToolOutput {
  text: string;
  structuredContent?: JsonRecord;
  tainted?: boolean;
}

interface ToolDefinition {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  mutates: boolean;
  tainted?: boolean;
  run(args: JsonRecord, signal?: AbortSignal): Promise<ToolOutput>;
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toTarget(input: TargetInput): {
  ref?: string;
  selector?: string;
  point?: { x: number; y: number };
  offset?: { x: number; y: number };
} {
  const target: {
    ref?: string;
    selector?: string;
    point?: { x: number; y: number };
    offset?: { x: number; y: number };
  } = {};
  if (input.ref) target.ref = input.ref;
  if (input.selector) target.selector = input.selector;
  if (typeof input.x === "number" && typeof input.y === "number") {
    target.point = { x: input.x, y: input.y };
  }
  if (typeof input.offsetX === "number" && typeof input.offsetY === "number") {
    target.offset = { x: input.offsetX, y: input.offsetY };
  }
  if (!target.ref && !target.selector && !target.point) {
    throw new ZimReaperError("BAD_REQUEST", "target requires ref, selector, or x/y");
  }
  return target;
}

function pretty(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function structured(value: unknown): JsonRecord | undefined {
  return isRecord(value) ? value : undefined;
}

function protocolText(value: unknown): string {
  if (isRecord(value) && typeof value.text === "string") return value.text;
  return pretty(value);
}

function snapshotText(value: unknown): string {
  if (isRecord(value) && typeof value.text === "string") {
    const meta = [
      `snap=${String(value.snapshotId ?? "?")}`,
      `gen=${String(value.generation ?? "?")}`,
      value.url ? `url=${String(value.url)}` : "",
    ]
      .filter(Boolean)
      .join(" ");
    return `${meta}\n${value.text}`;
  }
  return pretty(value);
}

function tabTable(value: unknown): string {
  const tabs = Array.isArray(value)
    ? value
    : isRecord(value) && Array.isArray(value.tabs)
      ? value.tabs
      : [];
  if (tabs.length === 0) return "No tabs.";
  const rows = tabs.map((raw) => {
    const tab = isRecord(raw) ? raw : {};
    return {
      id: String(tab.tabId ?? ""),
      active: tab.active === true ? "*" : "",
      loading: tab.loading === true ? "loading" : "",
      title: String(tab.title ?? ""),
      url: String(tab.url ?? ""),
    };
  });
  const idWidth = Math.max(2, ...rows.map((row) => row.id.length));
  const titleWidth = Math.max(5, ...rows.map((row) => row.title.length));
  return [
    `${"ID".padEnd(idWidth)}  A  ${"TITLE".padEnd(titleWidth)}  URL`,
    ...rows.map(
      (row) =>
        `${row.id.padEnd(idWidth)}  ${row.active.padEnd(1)}  ${row.title.padEnd(titleWidth)}  ${row.url}`,
    ),
  ].join("\n");
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value.length > 0 ? value : undefined;
}

function providerFromEnv(): Provider {
  const kind = env("ZIMREAPER_PROVIDER") ?? "openai";
  const explicitModel = env("ZIMREAPER_MODEL");
  const model =
    explicitModel ??
    (kind.startsWith("custom:")
      ? ""
      : kind === "anthropic"
        ? (env("ANTHROPIC_MODEL") ?? "claude-sonnet-4-20250514")
        : (env("OPENAI_MODEL") ?? "gpt-4.1-mini"));
  return createConfiguredProvider({ kind, model });
}

function createConfiguredProvider(cfg: ProviderConfig): Provider {
  try {
    return createProvider(cfg);
  } catch (err) {
    const zim = ZimReaperError.from(err);
    throw new ZimReaperError(
      "UNSUPPORTED",
      `browser_task needs a configured provider (${zim.message}). Set ZIMREAPER_PROVIDER and the matching API key, or call the browser tools directly.`,
    );
  }
}

function query(
  client: ControlClient,
  q: Query,
  signal?: AbortSignal,
  tabId?: unknown,
): Promise<unknown> {
  return client.query(q, {
    ...(typeof tabId === "string" ? { tabId } : {}),
    ...(signal ? { signal } : {}),
  });
}

function makeDefinitions(client: ControlClient, opts: BrowserToolOptions): ToolDefinition[] {
  const runTask = async (args: JsonRecord, signal?: AbortSignal): Promise<ToolOutput> => {
    const task = String(args.task ?? "").trim();
    if (!task) throw new ZimReaperError("BAD_REQUEST", "browser_task requires a task");
    if (typeof args.url === "string" && args.url.length > 0) {
      await client.act(
        ActionSchema.parse({ kind: "nav.goto", url: args.url, waitUntil: "load" }),
        signal ? { signal } : undefined,
      );
    }
    const provider = opts.provider ?? (opts.providerConfig ? createConfiguredProvider(opts.providerConfig) : providerFromEnv());
    const nested = browserTools(client, { ...opts, provider }).filter(
      (tool) => tool.spec.name !== "browser_task",
    );
    const loop = new AgentLoop({
      provider,
      tools: nested,
      maxSteps: typeof args.maxSteps === "number" ? args.maxSteps : (opts.taskMaxSteps ?? 25),
    });
    const result = await loop.run(task, signal ? { signal } : {});
    return {
      text: result.text,
      structuredContent: {
        ok: result.ok,
        steps: result.steps,
        toolCalls: result.toolCalls,
        usage: result.usage,
      },
      tainted: true,
    };
  };

  return [
    {
      name: "browser_navigate",
      description:
        "Navigate the active tab to a URL and wait for the requested lifecycle event. Snapshot after navigation.",
      mutates: true,
      shape: {
        url: z.string().min(1).describe("Absolute URL to open"),
        waitUntil: z.enum(["load", "domcontentloaded", "networkidle", "commit"]).optional(),
        timeoutMs: z.number().int().positive().max(120_000).optional(),
        tabId: z.string().optional(),
      },
      async run(args, signal) {
        const res = await client.act(
          ActionSchema.parse({
            kind: "nav.goto",
            url: args.url,
            waitUntil: args.waitUntil ?? "load",
            ...(typeof args.timeoutMs === "number" ? { timeoutMs: args.timeoutMs } : {}),
          }),
          {
            ...(typeof args.tabId === "string" ? { tabId: args.tabId } : {}),
            ...(signal ? { signal } : {}),
          },
        );
        const meta = structured(res.meta) ?? {};
        const url = typeof meta.url === "string" ? meta.url : String(args.url);
        return {
          text: `Navigated to ${url}`,
          structuredContent: { url, result: res.result, meta },
        };
      },
    },
    {
      name: "browser_snapshot",
      description:
        "Read the page as compact ref-tagged text. Refs are valid only for this snapshot generation; re-snapshot after changes.",
      mutates: false,
      tainted: true,
      shape: {
        mode: z.enum(["ax", "dom", "both"]).optional(),
        maxChars: z.number().int().min(500).max(200_000).optional(),
        includeFrames: z.boolean().optional(),
        interactiveOnly: z.boolean().optional(),
        cache: z.boolean().optional(),
        tabId: z.string().optional(),
      },
      async run(args, signal) {
        const res = await query(
          client,
          QuerySchema.parse({
            kind: "page.snapshot",
            mode: args.mode ?? "ax",
            maxChars: args.maxChars ?? 12_000,
            includeFrames: args.includeFrames ?? false,
            interactiveOnly: args.interactiveOnly ?? false,
            cache: args.cache ?? true,
          }),
          signal,
          args.tabId,
        );
        return {
          text: snapshotText(res),
          structuredContent: structured(res),
          tainted: true,
        };
      },
    },
    {
      name: "browser_diff",
      description: "Show only refs and text that changed since a previous snapshot id.",
      mutates: false,
      tainted: true,
      shape: {
        since: z.string().min(1),
        maxChars: z.number().int().min(500).max(200_000).optional(),
        tabId: z.string().optional(),
      },
      async run(args, signal) {
        const res = await query(
          client,
          QuerySchema.parse({
            kind: "page.diff",
            since: args.since,
            maxChars: args.maxChars ?? 6_000,
          }),
          signal,
          args.tabId,
        );
        return { text: protocolText(res), structuredContent: structured(res), tainted: true };
      },
    },
    {
      name: "browser_click",
      description: "Click an element using a snapshot ref, CSS selector, or viewport point with a real mouse event.",
      mutates: true,
      shape: {
        ...TargetShape.shape,
        button: z.enum(["left", "right", "middle", "back", "forward"]).optional(),
        clickCount: z.number().int().min(1).max(3).optional(),
        modifiers: z.array(z.enum(["Alt", "Control", "Meta", "Shift"])).optional(),
        delayMs: z.number().int().min(0).max(2000).optional(),
        tabId: z.string().optional(),
      },
      async run(args, signal) {
        const res = await client.act(
          ActionSchema.parse({
            kind: "mouse.click",
            target: toTarget(args as TargetInput),
            button: args.button ?? "left",
            clickCount: args.clickCount ?? 1,
            modifiers: args.modifiers ?? [],
            delayMs: args.delayMs ?? 24,
          }),
          {
            ...(typeof args.tabId === "string" ? { tabId: args.tabId } : {}),
            ...(signal ? { signal } : {}),
          },
        );
        return { text: `Clicked ${pretty(res.result)}`, structuredContent: structured(res) };
      },
    },
    {
      name: "browser_type",
      description: "Type text into the focused element or a target, optionally clearing it first and submitting with Enter.",
      mutates: true,
      shape: {
        text: z.string(),
        ...TargetShape.shape,
        clearFirst: z.boolean().optional(),
        delayMs: z.number().int().min(0).max(500).optional(),
        submit: z.boolean().optional(),
        tabId: z.string().optional(),
      },
      async run(args, signal) {
        const callOpts = {
          ...(typeof args.tabId === "string" ? { tabId: args.tabId } : {}),
          ...(signal ? { signal } : {}),
        };
        const hasTargetFields = ["ref", "selector", "x", "y"].some((key) => args[key] !== undefined);
        const target = hasTargetFields ? toTarget(args as TargetInput) : undefined;
        const res = await client.act(
          ActionSchema.parse({
            kind: "key.type",
            text: args.text,
            ...(target ? { target } : {}),
            clearFirst: args.clearFirst ?? false,
            delayMs: args.delayMs ?? 8,
          }),
          callOpts,
        );
        let submitted = false;
        if (args.submit === true) {
          await client.act(
            ActionSchema.parse({ kind: "key.press", key: "Enter", modifiers: [], count: 1 }),
            callOpts,
          );
          submitted = true;
        }
        return {
          text: `Typed ${String(args.text).length} characters${submitted ? " and pressed Enter" : ""}.`,
          structuredContent: { result: res.result, submitted },
        };
      },
    },
    {
      name: "browser_press",
      description: "Press a key or chord (for example Enter, Tab, or Control+Shift+T) on the active tab.",
      mutates: true,
      shape: {
        key: z.string().optional(),
        chord: z.string().optional(),
        modifiers: z.array(z.enum(["Alt", "Control", "Meta", "Shift"])).optional(),
        count: z.number().int().min(1).max(50).optional(),
        tabId: z.string().optional(),
      },
      async run(args, signal) {
        const callOpts = {
          ...(typeof args.tabId === "string" ? { tabId: args.tabId } : {}),
          ...(signal ? { signal } : {}),
        };
        const action = args.chord
          ? ActionSchema.parse({ kind: "key.chord", chord: args.chord })
          : args.key
            ? ActionSchema.parse({
                kind: "key.press",
                key: args.key,
                modifiers: args.modifiers ?? [],
                count: args.count ?? 1,
              })
            : undefined;
        if (!action) throw new ZimReaperError("BAD_REQUEST", "browser_press requires key or chord");
        const res = await client.act(action, callOpts);
        return { text: `Pressed ${String(args.chord ?? args.key)}.`, structuredContent: structured(res) };
      },
    },
    {
      name: "browser_hover",
      description: "Move the real cursor over an element and hover for a short duration.",
      mutates: true,
      shape: {
        ...TargetShape.shape,
        durationMs: z.number().int().min(0).max(10_000).optional(),
        tabId: z.string().optional(),
      },
      async run(args, signal) {
        const res = await client.act(
          ActionSchema.parse({
            kind: "mouse.hover",
            target: toTarget(args as TargetInput),
            durationMs: args.durationMs ?? 150,
          }),
          {
            ...(typeof args.tabId === "string" ? { tabId: args.tabId } : {}),
            ...(signal ? { signal } : {}),
          },
        );
        return { text: `Hovered ${pretty(res.result)}`, structuredContent: structured(res) };
      },
    },
    {
      name: "browser_drag",
      description: "Drag from one target to another with real mouse movement.",
      mutates: true,
      shape: {
        from: TargetShape,
        to: TargetShape,
        button: z.enum(["left", "right", "middle"]).optional(),
        steps: z.number().int().min(1).max(200).optional(),
        durationMs: z.number().int().min(0).max(10_000).optional(),
        tabId: z.string().optional(),
      },
      async run(args, signal) {
        const res = await client.act(
          ActionSchema.parse({
            kind: "mouse.drag",
            from: toTarget(args.from as TargetInput),
            to: toTarget(args.to as TargetInput),
            button: args.button ?? "left",
            steps: args.steps ?? 20,
            durationMs: args.durationMs ?? 300,
          }),
          {
            ...(typeof args.tabId === "string" ? { tabId: args.tabId } : {}),
            ...(signal ? { signal } : {}),
          },
        );
        return { text: `Dragged ${pretty(res.result)}`, structuredContent: structured(res) };
      },
    },
    {
      name: "browser_scroll",
      description: "Scroll the page or a target with a real wheel event.",
      mutates: true,
      shape: {
        ...TargetShape.shape,
        deltaX: z.number().optional(),
        deltaY: z.number().optional(),
        toTop: z.boolean().optional(),
        toBottom: z.boolean().optional(),
        tabId: z.string().optional(),
      },
      async run(args, signal) {
        const target =
          args.ref || args.selector || (typeof args.x === "number" && typeof args.y === "number")
            ? toTarget(args as TargetInput)
            : undefined;
        const res = await client.act(
          ActionSchema.parse({
            kind: "page.scroll",
            ...(target ? { target } : {}),
            deltaX: args.deltaX ?? 0,
            deltaY: args.deltaY ?? 0,
            toTop: args.toTop ?? false,
            toBottom: args.toBottom ?? false,
          }),
          {
            ...(typeof args.tabId === "string" ? { tabId: args.tabId } : {}),
            ...(signal ? { signal } : {}),
          },
        );
        return { text: `Scrolled ${pretty(res.result)}`, structuredContent: structured(res) };
      },
    },
    {
      name: "browser_screenshot",
      description: "Capture the page or a clip as an image. Annotated screenshots include numbered interactive marks.",
      mutates: false,
      shape: {
        fullPage: z.boolean().optional(),
        annotate: z.boolean().optional(),
        format: z.enum(["png", "jpeg", "webp"]).optional(),
        quality: z.number().int().min(1).max(100).optional(),
        clip: z
          .object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() })
          .optional(),
        path: z.string().optional(),
        tabId: z.string().optional(),
      },
      async run(args, signal) {
        const res = await client.act(
          ActionSchema.parse({
            kind: "page.screenshot",
            fullPage: args.fullPage ?? false,
            annotate: args.annotate ?? false,
            format: args.format ?? "png",
            ...(typeof args.quality === "number" ? { quality: args.quality } : {}),
            ...(isRecord(args.clip) ? { clip: args.clip } : {}),
            ...(typeof args.path === "string" ? { path: args.path } : {}),
          }),
          {
            ...(typeof args.tabId === "string" ? { tabId: args.tabId } : {}),
            ...(signal ? { signal } : {}),
          },
        );
        return {
          text: `Screenshot captured: ${pretty(res.result)}`,
          structuredContent: structured(res),
        };
      },
    },
    {
      name: "browser_wait",
      description: "Wait for a selector, text, URL fragment, network idle, expression, or a ref to disappear.",
      mutates: false,
      shape: {
        selector: z.string().optional(),
        text: z.string().optional(),
        urlContains: z.string().optional(),
        networkIdle: z.boolean().optional(),
        expression: z.string().optional(),
        refGone: z.string().optional(),
        timeoutMs: z.number().int().positive().max(120_000).optional(),
        pollMs: z.number().int().min(25).max(2000).optional(),
        tabId: z.string().optional(),
      },
      async run(args, signal) {
        const condition: JsonRecord = {};
        for (const key of ["selector", "text", "urlContains", "networkIdle", "expression", "refGone"] as const) {
          if (args[key] !== undefined) condition[key] = args[key];
        }
        if (Object.keys(condition).length === 0) {
          throw new ZimReaperError("BAD_REQUEST", "browser_wait requires at least one condition");
        }
        const res = await client.act(
          ActionSchema.parse({
            kind: "page.wait",
            for: condition,
            timeoutMs: args.timeoutMs ?? 15_000,
            pollMs: args.pollMs ?? 100,
          }),
          {
            ...(typeof args.tabId === "string" ? { tabId: args.tabId } : {}),
            ...(signal ? { signal } : {}),
          },
        );
        return { text: `Wait satisfied: ${pretty(res.result)}`, structuredContent: structured(res) };
      },
    },
    {
      name: "browser_tabs",
      description: "List, create, close, or activate tabs. op=list/new/close/activate.",
      mutates: true,
      shape: {
        op: z.enum(["list", "new", "close", "activate"]),
        tabId: z.string().optional(),
        url: z.string().optional(),
        active: z.boolean().optional(),
        partition: z.string().optional(),
        forkFrom: z.string().optional(),
      },
      async run(args, signal) {
        if (args.op === "list") {
          const res = await query(client, QuerySchema.parse({ kind: "tab.list" }), signal, args.tabId);
          return { text: tabTable(res), structuredContent: { tabs: Array.isArray(res) ? res : [] } };
        }
        if (args.op === "new") {
          const res = await client.act(
            ActionSchema.parse({
              kind: "tab.new",
              ...(typeof args.url === "string" ? { url: args.url } : {}),
              active: args.active ?? true,
              ...(typeof args.partition === "string" ? { partition: args.partition } : {}),
              ...(typeof args.forkFrom === "string" ? { forkFrom: args.forkFrom } : {}),
            }),
            signal ? { signal } : undefined,
          );
          return { text: `Opened tab: ${pretty(res.result)}`, structuredContent: structured(res) };
        }
        if (typeof args.tabId !== "string") {
          throw new ZimReaperError("BAD_REQUEST", `browser_tabs op=${args.op} requires tabId`);
        }
        const action: Action =
          args.op === "close"
            ? ActionSchema.parse({ kind: "tab.close", tabId: args.tabId })
            : ActionSchema.parse({ kind: "tab.activate", tabId: args.tabId });
        const res = await client.act(action, signal ? { signal } : undefined);
        return {
          text: `${args.op === "close" ? "Closed" : "Activated"} tab ${args.tabId}.`,
          structuredContent: structured(res),
        };
      },
    },
    {
      name: "browser_nav",
      description: "Navigate history or reload: op=back/forward/reload.",
      mutates: true,
      shape: {
        op: z.enum(["back", "forward", "reload"]),
        ignoreCache: z.boolean().optional(),
        tabId: z.string().optional(),
      },
      async run(args, signal) {
        const action: Action =
          args.op === "reload"
            ? ActionSchema.parse({ kind: "nav.reload", ignoreCache: args.ignoreCache ?? false })
            : ActionSchema.parse({ kind: args.op === "back" ? "nav.back" : "nav.forward" });
        const res = await client.act(action, {
          ...(typeof args.tabId === "string" ? { tabId: args.tabId } : {}),
          ...(signal ? { signal } : {}),
        });
        return { text: `Navigation ${args.op} complete.`, structuredContent: structured(res) };
      },
    },
    {
      name: "browser_eval",
      description: "Evaluate a JavaScript expression in the page and return its value.",
      mutates: true,
      tainted: true,
      shape: {
        expression: z.string().min(1),
        awaitPromise: z.boolean().optional(),
        isolated: z.boolean().optional(),
        tabId: z.string().optional(),
      },
      async run(args, signal) {
        const res = await client.act(
          ActionSchema.parse({
            kind: "page.eval",
            expression: args.expression,
            awaitPromise: args.awaitPromise ?? true,
            isolated: args.isolated ?? false,
          }),
          {
            ...(typeof args.tabId === "string" ? { tabId: args.tabId } : {}),
            ...(signal ? { signal } : {}),
          },
        );
        return { text: pretty(res.result), structuredContent: structured(res), tainted: true };
      },
    },
    {
      name: "browser_extract",
      description: "Extract structured rows from repeating page elements using a row selector and field selectors.",
      mutates: false,
      tainted: true,
      shape: {
        rowSelector: z.string().min(1),
        fields: z.record(
          z.object({
            selector: z.string().optional(),
            attr: z.string().optional(),
            self: z.boolean().optional(),
          }),
        ),
        limit: z.number().int().min(1).max(500).optional(),
        tabId: z.string().optional(),
      },
      async run(args, signal) {
        const res = await query(
          client,
          QuerySchema.parse({
            kind: "page.extract",
            rowSelector: args.rowSelector,
            fields: args.fields,
            limit: args.limit ?? 100,
          }),
          signal,
          args.tabId,
        );
        return { text: pretty(res), structuredContent: structured(res), tainted: true };
      },
    },
    {
      name: "browser_network",
      description:
        "Inspect or modify network traffic: op=log/body/route/replay. route and replay are mutating.",
      mutates: true,
      tainted: true,
      shape: {
        op: z.enum(["log", "body", "route", "replay"]),
        requestId: z.string().optional(),
        part: z.enum(["request", "response"]).optional(),
        maxBytes: z.number().int().min(100).max(5_000_000).optional(),
        sinceSeq: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(1000).optional(),
        filter: z
          .object({
            urlContains: z.string().optional(),
            method: z.string().optional(),
            status: z.number().int().optional(),
            resourceType: z.string().optional(),
          })
          .optional(),
        pattern: z.string().optional(),
        mode: z.enum(["block", "mock", "pass"]).optional(),
        status: z.number().int().min(100).max(599).optional(),
        headers: z.record(z.string()).optional(),
        body: z.string().optional(),
        method: z.string().optional(),
        overrides: z
          .object({
            url: z.string().optional(),
            method: z.string().optional(),
            headers: z.record(z.string()).optional(),
            body: z.string().optional(),
          })
          .optional(),
        tabId: z.string().optional(),
      },
      async run(args, signal) {
        const callOpts = {
          ...(typeof args.tabId === "string" ? { tabId: args.tabId } : {}),
          ...(signal ? { signal } : {}),
        };
        if (args.op === "log") {
          const res = await query(
            client,
            QuerySchema.parse({
              kind: "net.log",
              sinceSeq: args.sinceSeq ?? 0,
              limit: args.limit ?? 100,
              ...(isRecord(args.filter) ? { filter: args.filter } : {}),
            }),
            signal,
            args.tabId,
          );
          return { text: pretty(res), structuredContent: structured(res), tainted: true };
        }
        if (args.op === "body") {
          if (typeof args.requestId !== "string") {
            throw new ZimReaperError("BAD_REQUEST", "browser_network op=body requires requestId");
          }
          const res = await query(
            client,
            QuerySchema.parse({
              kind: "net.body",
              requestId: args.requestId,
              part: args.part ?? "response",
              maxBytes: args.maxBytes ?? 200_000,
            }),
            signal,
            args.tabId,
          );
          return { text: pretty(res), structuredContent: structured(res), tainted: true };
        }
        if (args.op === "route") {
          if (typeof args.pattern !== "string" || typeof args.mode !== "string") {
            throw new ZimReaperError("BAD_REQUEST", "browser_network op=route requires pattern and mode");
          }
          const res = await client.act(
            ActionSchema.parse({
              kind: "net.route",
              pattern: args.pattern,
              mode: args.mode,
              ...(typeof args.status === "number" ? { status: args.status } : {}),
              ...(isRecord(args.headers) ? { headers: args.headers } : {}),
              ...(typeof args.body === "string" ? { body: args.body } : {}),
              ...(typeof args.method === "string" ? { method: args.method } : {}),
            }),
            callOpts,
          );
          return { text: `Network route applied: ${pretty(res.result)}`, structuredContent: structured(res) };
        }
        if (typeof args.requestId !== "string") {
          throw new ZimReaperError("BAD_REQUEST", "browser_network op=replay requires requestId");
        }
        const res = await client.act(
          ActionSchema.parse({
            kind: "net.replay",
            requestId: args.requestId,
            ...(isRecord(args.overrides) ? { overrides: args.overrides } : {}),
          }),
          callOpts,
        );
        return { text: `Request replayed: ${pretty(res.result)}`, structuredContent: structured(res) };
      },
    },
    {
      name: "browser_cookies",
      description: "Read, set, or clear cookies for the current tab or a URL.",
      mutates: true,
      shape: {
        op: z.enum(["get", "set", "clear"]),
        url: z.string().optional(),
        cookies: z
          .array(
            z.object({
              name: z.string(),
              value: z.string(),
              domain: z.string().optional(),
              path: z.string().optional(),
              expires: z.number().optional(),
              httpOnly: z.boolean().optional(),
              secure: z.boolean().optional(),
              sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
            }),
          )
          .optional(),
        tabId: z.string().optional(),
      },
      async run(args, signal) {
        if (args.op === "set" && !Array.isArray(args.cookies)) {
          throw new ZimReaperError("BAD_REQUEST", "browser_cookies op=set requires cookies");
        }
        const res = await client.act(
          ActionSchema.parse({
            kind: "storage.cookies",
            op: args.op,
            ...(typeof args.url === "string" ? { url: args.url } : {}),
            ...(Array.isArray(args.cookies) ? { cookies: args.cookies } : {}),
          }),
          {
            ...(typeof args.tabId === "string" ? { tabId: args.tabId } : {}),
            ...(signal ? { signal } : {}),
          },
        );
        return { text: pretty(res.result), structuredContent: structured(res) };
      },
    },
    {
      name: "browser_set_viewport",
      description: "Resize the viewport and optionally emulate a mobile device scale.",
      mutates: true,
      shape: {
        width: z.number().int().min(200).max(4096),
        height: z.number().int().min(200).max(4096),
        deviceScaleFactor: z.number().min(0.5).max(4).optional(),
        mobile: z.boolean().optional(),
        tabId: z.string().optional(),
      },
      async run(args, signal) {
        const res = await client.act(
          ActionSchema.parse({
            kind: "page.setViewport",
            width: args.width,
            height: args.height,
            deviceScaleFactor: args.deviceScaleFactor ?? 1,
            mobile: args.mobile ?? false,
          }),
          {
            ...(typeof args.tabId === "string" ? { tabId: args.tabId } : {}),
            ...(signal ? { signal } : {}),
          },
        );
        return {
          text: `Viewport set to ${String(args.width)}x${String(args.height)}.`,
          structuredContent: structured(res),
        };
      },
    },
    {
      name: "browser_fork_session",
      description: "Fork the current session into independent tabs sharing the current login state.",
      mutates: true,
      shape: {
        tabId: z.string().optional(),
        count: z.number().int().min(1).max(12).optional(),
        url: z.string().optional(),
      },
      async run(args, signal) {
        const res = await client.act(
          ActionSchema.parse({
            kind: "session.fork",
            ...(typeof args.tabId === "string" ? { tabId: args.tabId } : {}),
            count: args.count ?? 2,
            ...(typeof args.url === "string" ? { url: args.url } : {}),
          }),
          signal ? { signal } : undefined,
        );
        return { text: `Forked session: ${pretty(res.result)}`, structuredContent: structured(res) };
      },
    },
    {
      name: "browser_task",
      description:
        "Run a full autonomous browser task with the native agent loop. Requires a configured model provider.",
      mutates: true,
      tainted: true,
      shape: {
        task: z.string().min(1),
        url: z.string().optional(),
        maxSteps: z.number().int().min(1).max(100).optional(),
      },
      run: runTask,
    },
    {
      name: "browser_ask_human",
      description: "Pause and ask the human operator to take over or approve something in the browser.",
      mutates: false,
      shape: {
        reason: z.string().min(1),
        detail: z.string().optional(),
        timeoutMs: z.number().int().positive().max(600_000).optional(),
      },
      async run(args, signal) {
        const res = await client.act(
          ActionSchema.parse({
            kind: "human.request",
            reason: args.reason,
            ...(typeof args.detail === "string" ? { detail: args.detail } : {}),
            timeoutMs: args.timeoutMs ?? 120_000,
          }),
          signal ? { signal } : undefined,
        );
        return { text: `Human response: ${pretty(res.result)}`, structuredContent: structured(res) };
      },
    },
  ];
}

/** Builds the browser tool surface shared by the native loop and the MCP server. */
export function browserTools(client: ControlClient, opts: BrowserToolOptions = {}): Tool[] {
  return makeDefinitions(client, opts).map((def) => ({
    spec: {
      name: def.name,
      description: def.description,
      inputSchema: zodShapeToJsonSchema(def.shape),
      mutates: def.mutates,
      ...(def.tainted ? { tainted: true } : {}),
    },
    schema: z.object(def.shape),
    async run(args: JsonRecord, signal?: AbortSignal) {
      return def.run(args, signal);
    },
  }));
}

/** The exact MCP tool definitions, exported for the server and schema snapshot tests. */
export interface McpToolDefinition {
  name: string;
  description: string;
  shape: z.ZodRawShape;
  mutates: boolean;
  tainted?: boolean;
  run(args: JsonRecord, signal?: AbortSignal): Promise<ToolOutput>;
}

export function browserToolDefinitions(
  client: ControlClient,
  opts: BrowserToolOptions = {},
): McpToolDefinition[] {
  return makeDefinitions(client, opts).map(({ name, description, shape, mutates, tainted, run }) => ({
    name,
    description,
    shape,
    mutates,
    ...(tainted ? { tainted } : {}),
    run,
  }));
}

/**
 * Small, deterministic JSON Schema conversion for the shapes above. The tool snapshot is the
 * contract, so this deliberately supports only the constructs used by browserTools.
 */
export function zodShapeToJsonSchema(shape: z.ZodRawShape): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  const required: string[] = [];
  for (const [key, schema] of Object.entries(shape)) {
    properties[key] = zodToJsonSchema(schema);
    if (!schema.isOptional()) required.push(key);
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
    additionalProperties: false,
  };
}

function zodToJsonSchema(schema: z.ZodTypeAny): Record<string, unknown> {
  const description = schema.description;
  const withDescription = (value: Record<string, unknown>): Record<string, unknown> =>
    description ? { ...value, description } : value;

  if (schema instanceof z.ZodOptional) return zodToJsonSchema(schema.unwrap());
  if (schema instanceof z.ZodNullable) return zodToJsonSchema(schema.unwrap());
  if (schema instanceof z.ZodDefault) return zodToJsonSchema(schema.removeDefault());
  if (schema instanceof z.ZodString) return withDescription({ type: "string" });
  if (schema instanceof z.ZodNumber) return withDescription({ type: "number" });
  if (schema instanceof z.ZodBoolean) return withDescription({ type: "boolean" });
  if (schema instanceof z.ZodLiteral) return withDescription({ const: schema.value });
  if (schema instanceof z.ZodEnum) {
    return withDescription({ type: "string", enum: [...schema.options] });
  }
  if (schema instanceof z.ZodArray) {
    return withDescription({ type: "array", items: zodToJsonSchema(schema.element) });
  }
  if (schema instanceof z.ZodRecord) {
    return withDescription({ type: "object", additionalProperties: zodToJsonSchema(schema.valueSchema) });
  }
  if (schema instanceof z.ZodObject) {
    return withDescription(zodShapeToJsonSchema(schema.shape));
  }
  return withDescription({});
}

