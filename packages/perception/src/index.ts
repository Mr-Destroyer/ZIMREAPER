/**
 * Perception: turn raw CDP page data into a token-budgeted snapshot, stable refs, and diffs.
 * Pure functions where possible; the service wires them to a CDP sender.
 */
import type { Diff, RefInfo, Snapshot } from "@zimreaper/protocol";
import { ZimReaperError } from "@zimreaper/protocol";

export type CdpSend = <T = unknown>(method: string, params?: Record<string, unknown>) => Promise<T>;

export interface SnapshotOptions {
  mode?: "ax" | "dom" | "both";
  maxChars?: number;
  includeFrames?: boolean;
  interactiveOnly?: boolean;
  cache?: boolean;
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
}

export function createPerception(_opts: PerceptionOptions): Perception {
  throw new ZimReaperError("UNSUPPORTED", "perception not implemented yet");
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

export function buildSnapshot(_raw: RawPageData, _opts?: SnapshotOptions): Snapshot {
  throw new ZimReaperError("UNSUPPORTED", "buildSnapshot not implemented yet");
}

export function diffSnapshots(_prev: Snapshot, _next: Snapshot): Diff {
  throw new ZimReaperError("UNSUPPORTED", "diffSnapshots not implemented yet");
}

export function renderSnapshotText(_snapshot: Snapshot, _maxChars: number): string {
  throw new ZimReaperError("UNSUPPORTED", "renderSnapshotText not implemented yet");
}
