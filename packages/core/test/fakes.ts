import { createHash } from "node:crypto";
import type {
  AuditEntry,
  Diff,
  Event,
  NetEntry,
  RefInfo,
  Snapshot,
  TabInfo,
} from "@zimreaper/protocol";
import { ZimReaperError } from "@zimreaper/protocol";
import type {
  Backend,
  BackendCapabilities,
  BackendListener,
  CdpEventListener,
  CreateTabOptions,
} from "../src/backend.js";
import type { Perception, SnapshotOptions } from "@zimreaper/perception";
import type { PolicyConfig, PolicyContext, PolicyDecision, PolicyEngine, Verdict } from "@zimreaper/policy";

export interface RecordedCall {
  tabId: string;
  method: string;
  params: Record<string, unknown>;
}

type ResponseMap = (method: string, params: Record<string, unknown>) => unknown;

const QUAD = [100, 200, 300, 200, 300, 260, 100, 260];

function defaultResponse(method: string, params: Record<string, unknown>): unknown {
  switch (method) {
    case "DOM.getBoxModel":
      return { model: { content: QUAD, width: 200, height: 60 } };
    case "DOM.getDocument":
      return { root: { nodeId: 1 } };
    case "DOM.querySelector":
      return { nodeId: 7 };
    case "DOM.describeNode":
      return { node: { backendNodeId: 42 } };
    case "DOM.resolveNode":
      return { object: { objectId: "obj-1" } };
    case "Runtime.callFunctionOn":
      return { result: { value: true } };
    case "Page.getLayoutMetrics":
      return {
        cssLayoutViewport: { clientWidth: 1280, clientHeight: 800 },
        cssContentSize: { width: 1280, height: 2000 },
      };
    case "Page.captureScreenshot":
      return { data: Buffer.from("fake-png-bytes").toString("base64") };
    case "Page.navigate":
      return { frameId: "F1" };
    case "Page.getFrameTree":
      return { frameTree: { frame: { id: "F1" } } };
    case "Page.createIsolatedWorld":
      return { executionContextId: 3 };
    case "Runtime.evaluate": {
      const expression = String(params.expression ?? "");
      if (expression.includes("location.href")) {
        return { result: { value: { url: "https://example.test/", title: "Example" } } };
      }
      if (expression.includes("readyState")) return { result: { value: "complete" } };
      if (expression.includes("getBoundingClientRect")) {
        return { result: { value: { x: 100, y: 200, width: 200, height: 60 } } };
      }
      if (expression.includes("Boolean(document.querySelector")) return { result: { value: true } };
      if (expression.includes("scrollY")) {
        return { result: { value: { x: 0, y: 120, maxY: 1200 } } };
      }
      return { result: { value: null } };
    }
    case "Network.getCookies":
      return { cookies: [{ name: "sid", value: "abc", domain: "example.test", path: "/" }] };
    case "DOMStorage.getDOMStorageItems":
      return { entries: [["token", "t-1"]] };
    default:
      return {};
  }
}

/** In-memory backend that records every CDP verb the executor emits. */
export class FakeBackend implements Backend {
  readonly name = "fake";
  readonly calls: RecordedCall[] = [];
  readonly tabs = new Map<string, TabInfo>();
  responseFor?: ResponseMap;
  /** Artificial latency per method, so tests can observe overlap. */
  delayFor?: (method: string) => number;
  beforeRespond?: (method: string, params: Record<string, unknown>) => void;
  afterRespond?: (method: string) => void;
  private active?: string;
  private readonly listeners = new Set<BackendListener>();
  private readonly cdpListeners = new Set<CdpEventListener>();

  constructor() {
    this.addTab("t1", "https://example.test/");
  }

  addTab(tabId: string, url: string): TabInfo {
    const info: TabInfo = {
      tabId,
      url,
      title: "Example",
      active: true,
      partition: "default",
      loading: false,
      canGoBack: false,
      canGoForward: false,
      createdAt: Date.now(),
    };
    this.tabs.set(tabId, info);
    this.active = tabId;
    return info;
  }

  capabilities(): BackendCapabilities {
    return {
      name: "fake",
      tabs: true,
      screenshots: true,
      network: true,
      frames: true,
      domains: ["Page", "Runtime", "Network", "DOM", "Accessibility", "Log", "Fetch"],
    };
  }

  async listTabs(): Promise<TabInfo[]> {
    return [...this.tabs.values()];
  }

  async getTab(tabId: string): Promise<TabInfo | undefined> {
    return this.tabs.get(tabId);
  }

  async createTab(opts: CreateTabOptions = {}): Promise<TabInfo> {
    const tabId = `t${this.tabs.size + 1}`;
    const info = this.addTab(tabId, opts.url ?? "about:blank");
    this.emit({ kind: "tab.created", tab: info });
    return info;
  }

  async closeTab(tabId: string): Promise<void> {
    this.tabs.delete(tabId);
    this.emit({ kind: "tab.closed", tabId });
  }

  async activateTab(tabId: string): Promise<void> {
    this.active = tabId;
    this.emit({ kind: "tab.activated", tabId });
  }

  activeTabId(): string | undefined {
    return this.active;
  }

  async send<T = unknown>(
    tabId: string,
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<T> {
    this.calls.push({ tabId, method, params });
    this.beforeRespond?.(method, params);
    const latency = this.delayFor?.(method) ?? 0;
    if (latency > 0) await new Promise((resolve) => setTimeout(resolve, latency));
    this.afterRespond?.(method);
    if (this.responseFor) {
      const custom = this.responseFor(method, params);
      if (custom !== undefined) return custom as T;
    }
    return defaultResponse(method, params) as T;
  }

  on(listener: BackendListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onCdp(listener: CdpEventListener): () => void {
    this.cdpListeners.add(listener);
    return () => this.cdpListeners.delete(listener);
  }

  async close(): Promise<void> {
    this.listeners.clear();
    this.cdpListeners.clear();
  }

  emit(event: Event): void {
    for (const listener of this.listeners) listener(event);
  }

  emitCdp(tabId: string, method: string, params: Record<string, unknown>): void {
    for (const listener of this.cdpListeners) listener(tabId, method, params);
  }

  callsFor(method: string, predicate?: (params: Record<string, unknown>) => boolean): RecordedCall[] {
    return this.calls.filter(
      (call) => call.method === method && (!predicate || predicate(call.params)),
    );
  }

  lastCall(method: string, predicate?: (params: Record<string, unknown>) => boolean): RecordedCall | undefined {
    const matches = this.callsFor(method, predicate);
    return matches[matches.length - 1];
  }

  methods(): string[] {
    return this.calls.map((call) => call.method);
  }
}

export class FakePerception implements Perception {
  readonly refs = new Map<string, RefInfo>();
  generationValue = 1;
  private snapshots = new Map<string, Snapshot>();

  setRef(
    ref: string,
    opts: {
      backendNodeId?: number;
      selector?: string;
      role?: string;
      name?: string;
      bbox?: { x: number; y: number; width: number; height: number };
    } = {},
  ): RefInfo {
    const info: RefInfo = {
      ref,
      role: opts.role ?? "button",
      name: opts.name ?? "Submit",
      bbox: opts.bbox ?? { x: 100, y: 200, width: 200, height: 60 },
      textHash: `hash-${ref}`,
      generation: this.generationValue,
      ...(opts.backendNodeId !== undefined ? { backendNodeId: opts.backendNodeId } : {}),
      ...(opts.selector !== undefined ? { selector: opts.selector } : {}),
    };
    this.refs.set(ref, info);
    return info;
  }

  ref(_tabId: string, ref: string): RefInfo | undefined {
    return this.refs.get(ref);
  }

  generation(_tabId: string): number {
    return this.generationValue;
  }

  pageHash(_tabId: string): string | undefined {
    return "page-hash";
  }

  invalidate(_tabId: string): void {
    this.snapshots.clear();
  }

  async snapshot(tabId: string, _opts?: SnapshotOptions): Promise<Snapshot> {
    const snapshot: Snapshot = {
      snapshotId: `snap-${tabId}`,
      tabId,
      url: "https://example.test/",
      title: "Example",
      generation: this.generationValue,
      viewport: { width: 1280, height: 800 },
      scroll: { x: 0, y: 0, maxY: 0 },
      text: "page: Example",
      refs: [...this.refs.values()],
      truncated: false,
      pageHash: "page-hash",
      createdAt: Date.now(),
    };
    this.snapshots.set(tabId, snapshot);
    return snapshot;
  }

  async diff(_tabId: string, since: string): Promise<Diff> {
    throw new ZimReaperError("UNSUPPORTED", `diff not implemented in fake (${since})`);
  }
}

const TEST_POLICY: PolicyConfig = {
  mode: "standard",
  origins: {},
  destructivePatterns: [],
  approvalTimeoutMs: 2_000,
  maxActionsPerMinute: 240,
};

/** Policy engine double: verdict is a mutable field so tests can flip it. */
export class FakePolicy implements PolicyEngine {
  verdict: Verdict = "allow";
  reason = "test policy";
  readonly entries: AuditEntry[] = [];
  private chainHash = "0".repeat(64);

  preflight(_action: unknown, _ctx: PolicyContext): PolicyDecision {
    return { verdict: this.verdict, reason: this.reason };
  }

  record(entry: Omit<AuditEntry, "seq" | "prevHash" | "hash">): AuditEntry {
    const prevHash = this.chainHash;
    const body = { ...entry, seq: this.entries.length + 1, prevHash };
    const hash = createHash("sha256").update(JSON.stringify(body)).digest("hex");
    const record: AuditEntry = { ...body, hash };
    this.chainHash = hash;
    this.entries.push(record);
    return record;
  }

  tail(limit: number): AuditEntry[] {
    return this.entries.slice(-limit);
  }

  verifyChain(): { ok: boolean; brokenAt?: number; entries: number } {
    return { ok: true, entries: this.entries.length };
  }

  config(): PolicyConfig {
    return TEST_POLICY;
  }
}

/** Networks entries helper for net.log / net.replay tests. */
export function fakeNetEntry(overrides: Partial<NetEntry> = {}): NetEntry {
  return {
    seq: 1,
    requestId: "req-1",
    tabId: "t1",
    url: "https://example.test/api/items",
    method: "GET",
    resourceType: "XHR",
    status: 200,
    startedAt: Date.now(),
    ...overrides,
  };
}
