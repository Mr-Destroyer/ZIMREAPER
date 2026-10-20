/**
 * Public types for the perception package. The CDP-facing shapes (AxNode, RawPageData)
 * are deliberately dumb: `buildSnapshot` is pure over them so every rule below is
 * unit-testable without a browser.
 */
import type { Diff, RefInfo, Snapshot } from "@zimreaper/protocol";

export type CdpSend = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;

export interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface SnapshotOptions {
  mode?: "ax" | "dom" | "both";
  maxChars?: number;
  includeFrames?: boolean;
  interactiveOnly?: boolean;
  cache?: boolean;
  /**
   * backendNodeId -> CSS selector, gathered from the DOM tree by the service.
   * Passed in (rather than living on RawPageData) so `buildSnapshot` stays pure.
   */
  selectors?: Readonly<Record<string, string>>;
  /** Generation counter to stamp on refs; the service owns the real counter. */
  generation?: number;
  /** Fixed snapshot id, for deterministic goldens. Defaults to a random base36 id. */
  snapshotId?: string;
}

export interface Perception {
  snapshot(tabId: string, opts?: SnapshotOptions): Promise<Snapshot>;
  diff(tabId: string, since: string): Promise<Diff>;
  ref(tabId: string, ref: string): RefInfo | undefined;
  generation(tabId: string): number;
  pageHash(tabId: string): string | undefined;
  invalidate(tabId: string): void;
}

export interface PerceptionOptions {
  /** Returns a CDP sender bound to one tab. */
  send: (tabId: string) => CdpSend;
  now?: () => number;
  /** Deadline applied to every CDP round-trip during a gather. Default 15s. */
  timeoutMs?: number;
}

/** Minimal AX node shape we consume from Accessibility.getFullAXTree. */
export interface AxNode {
  nodeId: string;
  backendDOMNodeId?: number;
  role?: { value: string };
  name?: { value: string };
  value?: { value: string };
  description?: { value: string };
  ignored?: boolean;
  childIds?: string[];
  properties?: Array<{ name: string; value?: { value: unknown } }>;
}

export interface RawPageData {
  tabId: string;
  url: string;
  title: string;
  viewport: { width: number; height: number };
  scroll: { x: number; y: number; maxY: number };
  ax: AxNode[];
  boxes: Record<string, { x: number; y: number; width: number; height: number }>;
  now: number;
}
