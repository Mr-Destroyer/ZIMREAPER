/**
 * Snapshot construction: AX tree -> ordered, boxed, hashed refs -> token-budgeted text.
 *
 * Everything here is pure over RawPageData. The service gathers that data over CDP;
 * the tests feed it hand-written fixtures.
 */
import type { RefInfo, Snapshot } from "@zimreaper/protocol";
import type { AxNode, RawPageData, SnapshotOptions } from "./types.js";
import { quote, shortHash } from "./util.js";

export const DEFAULT_MAX_CHARS = 12_000;
/** One snapshot never resolves more boxes than this; the tail is noise, not signal. */
export const MAX_REF_NODES = 400;

const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  "button",
  "checkbox",
  "combobox",
  "disclosuretriangle",
  "fileuploadbutton",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textarea",
  "textbox",
  "togglebutton",
  "treeitem",
]);

const VALUE_ROLES: ReadonlySet<string> = new Set([
  "combobox",
  "searchbox",
  "slider",
  "spinbutton",
  "textbox",
]);

const TEXT_ROLES: ReadonlySet<string> = new Set([
  "alert",
  "blockquote",
  "caption",
  "cell",
  "code",
  "columnheader",
  "definition",
  "description",
  "heading",
  "label",
  "listitem",
  "note",
  "paragraph",
  "rowheader",
  "status",
  "term",
  "text",
  "tooltip",
]);

/** Containers and duplicates: walking them produces refs nobody can act on. */
const SKIP_ROLES: ReadonlySet<string> = new Set([
  "generic",
  "ignored",
  "inlinetextbox",
  "linebreak",
  "listmarker",
  "none",
  "presentation",
  "rootwebarea",
  "scrollbar",
  "webarea",
]);

const TEXT_LINE_MAX = 120;
const NAME_MAX = 120;

export interface CandidateNode {
  node: AxNode;
  /** Pre-order position in the AX tree, i.e. DOM order. */
  order: number;
  role: string;
  name: string;
  value?: string;
  interactive: boolean;
  backendNodeId: number;
}

export interface RenderedSnapshot {
  text: string;
  truncated: boolean;
}

/* ------------------------------------------------------------------ structure */

function roleOf(node: AxNode): string {
  const raw = node.role?.value;
  if (typeof raw !== "string") return "";
  const role = raw.toLowerCase();
  return role === "statictext" ? "text" : role;
}

function nameOf(node: AxNode): string {
  const raw = node.name?.value;
  return typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
}

function valueOf(node: AxNode): string | undefined {
  const raw: unknown = node.value?.value;
  if (raw === undefined || raw === null) return undefined;
  return typeof raw === "string" ? raw : String(raw);
}

/** Pre-order AX traversal. getFullAXTree is usually ordered, but not guaranteed. */
export function axOrder(ax: AxNode[]): AxNode[] {
  const byId = new Map<string, AxNode>();
  for (const node of ax) byId.set(node.nodeId, node);
  const childOf = new Map<string, string>();
  for (const node of ax) {
    for (const childId of node.childIds ?? []) {
      if (!childOf.has(childId)) childOf.set(childId, node.nodeId);
    }
  }

  const out: AxNode[] = [];
  const seen = new Set<string>();
  const stack: AxNode[] = ax.filter((node) => !childOf.has(node.nodeId)).reverse();
  const pushChildren = (node: AxNode): void => {
    const childIds = node.childIds ?? [];
    for (let i = childIds.length - 1; i >= 0; i -= 1) {
      const childId = childIds[i];
      const child = childId ? byId.get(childId) : undefined;
      if (child && !seen.has(child.nodeId)) stack.push(child);
    }
  };

  while (stack.length > 0) {
    const node = stack.pop();
    if (!node || seen.has(node.nodeId)) continue;
    seen.add(node.nodeId);
    out.push(node);
    pushChildren(node);
  }
  // Orphans (nodes whose parent id never appeared) still get a chance to be seen.
  for (const node of ax) {
    if (seen.has(node.nodeId)) continue;
    seen.add(node.nodeId);
    out.push(node);
    pushChildren(node);
  }
  return out;
}

function axIndex(ax: AxNode[]): { byId: Map<string, AxNode>; parentOf: Map<string, string> } {
  const byId = new Map<string, AxNode>();
  const parentOf = new Map<string, string>();
  for (const node of ax) byId.set(node.nodeId, node);
  for (const node of ax) {
    for (const childId of node.childIds ?? []) {
      if (!parentOf.has(childId)) parentOf.set(childId, node.nodeId);
    }
  }
  return { byId, parentOf };
}

/**
 * Text nodes frequently lack a backendDOMNodeId of their own; their nearest ancestor
 * with one still gives us a usable box to scroll/click toward.
 */
function resolveBackendId(
  node: AxNode,
  byId: Map<string, AxNode>,
  parentOf: Map<string, string>,
): number | undefined {
  let current: AxNode | undefined = node;
  for (let hops = 0; hops < 8 && current; hops += 1) {
    const id = current.backendDOMNodeId;
    if (typeof id === "number" && id > 0) return id;
    const parentId = parentOf.get(current.nodeId);
    current = parentId === undefined ? undefined : byId.get(parentId);
  }
  return undefined;
}

/**
 * Pick the nodes worth resolving boxes for. Interactive nodes are collected first so a
 * 400-node cap can never be spent entirely on body text.
 */
export function selectCandidates(
  ax: AxNode[],
  opts: { interactiveOnly?: boolean; limit?: number } = {},
): CandidateNode[] {
  const limit = opts.limit ?? MAX_REF_NODES;
  const ordered = axOrder(ax);
  const { byId, parentOf } = axIndex(ax);
  const interactive: CandidateNode[] = [];
  const text: CandidateNode[] = [];
  const seenBackend = new Set<number>();

  const collect = (wantInteractive: boolean): void => {
    ordered.forEach((node, order) => {
      if (node.ignored === true) return;
      const role = roleOf(node);
      if (role === "" || SKIP_ROLES.has(role)) return;
      const isInteractive = INTERACTIVE_ROLES.has(role);
      if (isInteractive !== wantInteractive) return;
      if (!isInteractive && !TEXT_ROLES.has(role)) return;
      const name = nameOf(node);
      if (!isInteractive && name === "") return;
      if (!isInteractive && opts.interactiveOnly === true) return;

      const backendNodeId = resolveBackendId(node, byId, parentOf);
      if (backendNodeId === undefined || seenBackend.has(backendNodeId)) return;
      seenBackend.add(backendNodeId);

      const value = VALUE_ROLES.has(role) ? valueOf(node) : undefined;
      const candidate: CandidateNode = {
        node,
        order,
        role,
        name,
        interactive: isInteractive,
        backendNodeId,
        ...(value !== undefined ? { value } : {}),
      };
      (isInteractive ? interactive : text).push(candidate);
    });
  };

  collect(true);
  collect(false);
  return [...interactive, ...text].slice(0, limit);
}

/* ---------------------------------------------------------------- page hashing */

export function computePageHash(raw: RawPageData): string {
  const interactiveNames: string[] = [];
  for (const node of axOrder(raw.ax)) {
    if (node.ignored === true) continue;
    const role = roleOf(node);
    if (!INTERACTIVE_ROLES.has(role)) continue;
    interactiveNames.push(`${role}:${nameOf(node)}`);
  }
  const signature = [
    raw.url,
    raw.title,
    `${raw.scroll.x},${raw.scroll.y}`,
    String(raw.scroll.maxY),
    String(raw.ax.length),
    shortHash(interactiveNames.join("|"), 10),
  ].join("|");
  return shortHash(signature, 16);
}

export function textHashOf(role: string, name: string, value?: string): string {
  return shortHash(`${role}|${name}|${value ?? ""}`, 12);
}

export function newSnapshotId(): string {
  const random = Math.random().toString(36).slice(2, 8).padEnd(5, "0");
  const stamp = Date.now().toString(36).slice(-4);
  return `s${random}${stamp}`;
}

/* --------------------------------------------------------------------- boxes */

interface Box {
  x: number;
  y: number;
  width: number;
  height: number;
}

function normalizeBox(box: Box): Box | undefined {
  const values = [box.x, box.y, box.width, box.height];
  if (values.some((v) => !Number.isFinite(v))) return undefined;
  if (box.width <= 0 || box.height <= 0) return undefined;
  return {
    x: Math.round(box.x),
    y: Math.round(box.y),
    width: Math.max(1, Math.round(box.width)),
    height: Math.max(1, Math.round(box.height)),
  };
}

/**
 * CDP box-model quads are viewport-relative (the same space Input.dispatchMouseEvent
 * uses), so "is this in the document" has to add the scroll offset back.
 */
function isInDocument(box: Box, raw: RawPageData): boolean {
  const documentHeight = raw.scroll.maxY + raw.viewport.height;
  const documentX = box.x + raw.scroll.x;
  const documentY = box.y + raw.scroll.y;
  if (documentX < -4) return false;
  if (documentY < -4) return false;
  return documentY <= documentHeight + 4;
}

/* ------------------------------------------------------------------ snapshot */

export function buildSnapshot(raw: RawPageData, opts: SnapshotOptions = {}): Snapshot {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const generation = opts.generation ?? 1;
  const selectors = opts.selectors ?? {};

  const candidates = selectCandidates(raw.ax, { interactiveOnly: opts.interactiveOnly })
    .slice()
    .sort((a, b) => a.order - b.order);

  const refs: RefInfo[] = [];
  const seenText = new Set<string>();

  for (const candidate of candidates) {
    const rawBox = raw.boxes[String(candidate.backendNodeId)];
    if (!rawBox) continue;
    const box = normalizeBox(rawBox);
    if (!box || !isInDocument(box, raw)) continue;

    if (!candidate.interactive) {
      // A heading and its StaticText child (or two text nodes sharing a wrapper) render
      // the same words at the same place; one ref is enough.
      const dedupe = `${candidate.name}\u0000${box.x},${box.y},${box.width},${box.height}`;
      if (seenText.has(dedupe)) continue;
      seenText.add(dedupe);
    }

    const selector = selectors[String(candidate.backendNodeId)];
    refs.push({
      ref: `e${refs.length + 1}`,
      role: candidate.role,
      name: candidate.name,
      bbox: box,
      selector,
      backendNodeId: candidate.backendNodeId,
      value: candidate.value,
      textHash: textHashOf(candidate.role, candidate.name, candidate.value),
      generation,
    });
  }

  const snapshot: Snapshot = {
    snapshotId: opts.snapshotId ?? newSnapshotId(),
    tabId: raw.tabId,
    url: raw.url,
    title: raw.title,
    generation,
    viewport: { width: raw.viewport.width, height: raw.viewport.height },
    scroll: { x: raw.scroll.x, y: raw.scroll.y, maxY: raw.scroll.maxY },
    text: "",
    refs,
    truncated: false,
    pageHash: computePageHash(raw),
    createdAt: raw.now,
  };

  const rendered = renderSnapshotDetailed(snapshot, maxChars);
  snapshot.text = rendered.text;
  snapshot.truncated = rendered.truncated;
  return snapshot;
}

/* ----------------------------------------------------------------- rendering */

export function isInViewport(
  ref: RefInfo,
  viewport: { width: number; height: number },
): boolean {
  const { x, y, width, height } = ref.bbox;
  return x + width > 0 && y + height > 0 && x < viewport.width && y < viewport.height;
}

/** Interactive-in-viewport, interactive-offscreen, text-in-viewport, then the rest. */
export function orderRefsForRender(
  refs: readonly RefInfo[],
  viewport: { width: number; height: number },
): RefInfo[] {
  const buckets: RefInfo[][] = [[], [], [], []];
  for (const ref of refs) {
    const interactive = INTERACTIVE_ROLES.has(ref.role);
    const inView = isInViewport(ref, viewport);
    const bucket = interactive ? (inView ? 0 : 1) : inView ? 2 : 3;
    buckets[bucket].push(ref);
  }
  return buckets.flat();
}

export function formatRefLine(ref: RefInfo): string {
  const name = quote(ref.name, NAME_MAX);
  const value = ref.value !== undefined ? ` value=${quote(ref.value, 80)}` : "";
  const { x, y, width, height } = ref.bbox;
  return `[${ref.ref}] ${ref.role} ${name}${value} @(${x},${y}) ${width}x${height}`;
}

function snapshotHeader(snapshot: Snapshot): string {
  return (
    `page: ${quote(snapshot.title, 200)}  url=${snapshot.url}` +
    `  viewport=${snapshot.viewport.width}x${snapshot.viewport.height}` +
    `  scroll=${snapshot.scroll.y}/${snapshot.scroll.maxY}  snap=${snapshot.snapshotId}`
  );
}

export function truncationMarker(dropped: number): string {
  return `… (+${dropped} more refs, truncated — raise maxChars or scroll)`;
}

/** How many whole lines fit, reserving room for the truncation marker. */
function fitLines(lines: readonly string[], headerLength: number, maxChars: number): number {
  let used = headerLength;
  let count = 0;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const remaining = lines.length - i - 1;
    const reserve = remaining > 0 ? truncationMarker(remaining).length + 1 : 0;
    if (used + 1 + line.length + reserve > maxChars) break;
    used += 1 + line.length;
    count = i + 1;
  }
  return count;
}

export function renderSnapshotDetailed(
  snapshot: Snapshot,
  maxChars: number = DEFAULT_MAX_CHARS,
): RenderedSnapshot {
  const header = snapshotHeader(snapshot);
  const lines = orderRefsForRender(snapshot.refs, snapshot.viewport).map(formatRefLine);
  const budget = Math.max(0, Math.floor(maxChars));
  const shown = fitLines(lines, header.length, budget);
  const dropped = lines.length - shown;
  const parts = [header, ...lines.slice(0, shown)];
  if (dropped > 0) parts.push(truncationMarker(dropped));
  return { text: parts.join("\n"), truncated: dropped > 0 };
}

export function renderSnapshotText(snapshot: Snapshot, maxChars: number = DEFAULT_MAX_CHARS): string {
  return renderSnapshotDetailed(snapshot, maxChars).text;
}
