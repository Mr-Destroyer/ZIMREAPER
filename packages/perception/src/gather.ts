/**
 * The only part of perception that talks to a browser: one gather pass per snapshot.
 *
 * Order matters for latency: the AX tree, layout metrics, page probe and DOM tree are
 * independent, so they go out together; boxes are resolved afterwards because we only
 * know which nodes are candidates once the AX tree is in.
 */
import { ZimReaperError } from "@zimreaper/protocol";
import { buildSelectorMap } from "./selectors.js";
import type { CdpDomNode } from "./selectors.js";
import { MAX_REF_NODES, selectCandidates } from "./snapshot.js";
import type { AxNode, BBox, CdpSend, RawPageData } from "./types.js";
import { mapLimit, messageOf, withDeadline } from "./util.js";

export const DEFAULT_TIMEOUT_MS = 15_000;
const BOX_CONCURRENCY = 24;
const DEFAULT_SELECTOR_NODES = 6000;

export interface GatherOptions {
  interactiveOnly?: boolean;
  timeoutMs?: number;
  selectorLimit?: number;
  now?: () => number;
}

export interface GatheredPageData {
  raw: RawPageData;
  /** backendNodeId -> CSS selector; empty when the DOM domain was unavailable. */
  selectors: Record<string, string>;
}

interface LayoutMetrics {
  cssLayoutViewport?: { clientWidth: number; clientHeight: number };
  cssContentSize?: { width: number; height: number };
  layoutViewport?: { clientWidth: number; clientHeight: number };
  contentSize?: { width: number; height: number };
}

interface Probe {
  scrollX?: number;
  scrollY?: number;
  maxY?: number;
  title?: string;
  href?: string;
  innerWidth?: number;
  innerHeight?: number;
}

interface EvaluateResponse {
  result?: { value?: unknown };
  exceptionDetails?: { text?: string };
}

const PAGE_PROBE = `(() => {
  const de = document.documentElement;
  const body = document.body;
  const scrollHeight = Math.max(de ? de.scrollHeight : 0, body ? body.scrollHeight : 0);
  return {
    scrollX: Math.round(window.scrollX || 0),
    scrollY: Math.round(window.scrollY || 0),
    maxY: Math.max(0, Math.round(scrollHeight - window.innerHeight)),
    innerWidth: Math.round(window.innerWidth || 0),
    innerHeight: Math.round(window.innerHeight || 0),
    title: document.title || "",
    href: location.href || "",
  };
})()`;

async function cdp<T>(
  send: CdpSend,
  method: string,
  params: Record<string, unknown> | undefined,
  timeoutMs: number,
): Promise<T> {
  try {
    return await withDeadline(send<T>(method, params), timeoutMs, method);
  } catch (err) {
    if (err instanceof ZimReaperError) throw err;
    throw new ZimReaperError("BACKEND_ERROR", `${method} failed: ${messageOf(err)}`, {
      retryable: true,
    });
  }
}

function finite(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function readProbe(response: EvaluateResponse | undefined): Probe {
  const value = response?.result?.value;
  if (typeof value !== "object" || value === null) return {};
  return value as Probe;
}

function quadToBox(quad: readonly number[] | undefined): BBox | undefined {
  if (!quad || quad.length < 8) return undefined;
  const xs: number[] = [];
  const ys: number[] = [];
  for (let i = 0; i + 1 < quad.length; i += 2) {
    const x = quad[i];
    const y = quad[i + 1];
    if (typeof x !== "number" || typeof y !== "number") return undefined;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return undefined;
    xs.push(x);
    ys.push(y);
  }
  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY };
}

async function fetchBoxes(
  send: CdpSend,
  backendNodeIds: readonly number[],
  timeoutMs: number,
): Promise<Record<string, BBox>> {
  const unique = [...new Set(backendNodeIds)];
  const boxes: Record<string, BBox> = {};
  await mapLimit(unique, BOX_CONCURRENCY, async (backendNodeId) => {
    try {
      const response = await cdp<{ model?: { border?: number[]; content?: number[] } }>(
        send,
        "DOM.getBoxModel",
        { backendNodeId },
        timeoutMs,
      );
      const box = quadToBox(response.model?.border ?? response.model?.content);
      if (box) boxes[String(backendNodeId)] = box;
    } catch {
      // Detached, hidden or virtualized nodes have no box: they cannot be acted on,
      // so dropping them is correct rather than fatal.
    }
  });
  return boxes;
}

export async function collectRawPageData(
  send: CdpSend,
  tabId: string,
  opts: GatherOptions = {},
): Promise<GatheredPageData> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = opts.now ?? Date.now;

  await cdp(send, "Accessibility.enable", undefined, timeoutMs);
  // DOM is only needed for selector fallbacks; a failure there must not kill a snapshot.
  const domReady = await cdp(send, "DOM.enable", undefined, timeoutMs).then(
    () => true,
    () => false,
  );

  const [axTree, metrics, probeResponse, document] = await Promise.all([
    cdp<{ nodes?: AxNode[] }>(send, "Accessibility.getFullAXTree", {}, timeoutMs),
    cdp<LayoutMetrics>(send, "Page.getLayoutMetrics", {}, timeoutMs).catch(() => undefined),
    cdp<EvaluateResponse>(
      send,
      "Runtime.evaluate",
      { expression: PAGE_PROBE, returnByValue: true, awaitPromise: false },
      timeoutMs,
    ).catch(() => undefined),
    domReady
      ? cdp<{ root?: CdpDomNode }>(send, "DOM.getDocument", { depth: -1, pierce: true }, timeoutMs).catch(
          () => undefined,
        )
      : Promise.resolve(undefined),
  ]);

  const ax = Array.isArray(axTree.nodes) ? axTree.nodes : [];
  const probe = readProbe(probeResponse);

  const viewport = {
    width: Math.round(
      finite(metrics?.cssLayoutViewport?.clientWidth, finite(probe.innerWidth, 0)),
    ),
    height: Math.round(
      finite(metrics?.cssLayoutViewport?.clientHeight, finite(probe.innerHeight, 0)),
    ),
  };
  const contentHeight = finite(
    metrics?.cssContentSize?.height,
    finite(metrics?.contentSize?.height, 0),
  );
  const maxY = finite(
    probe.maxY,
    Math.max(0, Math.round(contentHeight - viewport.height)),
  );
  const scroll = {
    x: Math.round(finite(probe.scrollX, 0)),
    y: Math.round(finite(probe.scrollY, 0)),
    maxY: Math.round(maxY),
  };

  const candidates = selectCandidates(ax, {
    interactiveOnly: opts.interactiveOnly,
    limit: MAX_REF_NODES,
  });
  const boxes = await fetchBoxes(
    send,
    candidates.map((candidate) => candidate.backendNodeId),
    timeoutMs,
  );

  const root = document?.root;
  const selectors = root ? buildSelectorMap(root, opts.selectorLimit ?? DEFAULT_SELECTOR_NODES) : {};

  return {
    raw: {
      tabId,
      url: typeof probe.href === "string" ? probe.href : "",
      title: typeof probe.title === "string" ? probe.title : "",
      viewport,
      scroll,
      ax,
      boxes,
      now: now(),
    },
    selectors,
  };
}
