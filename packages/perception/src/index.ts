/**
 * Perception: turn raw CDP page data into a token-budgeted snapshot, stable refs, and diffs.
 * Pure functions where possible; the service wires them to a CDP sender.
 */
export type {
  AxNode,
  BBox,
  CdpSend,
  Perception,
  PerceptionOptions,
  RawPageData,
  SnapshotOptions,
} from "./types.js";

export { createPerception } from "./service.js";

export {
  axOrder,
  buildSnapshot,
  computePageHash,
  DEFAULT_MAX_CHARS,
  formatRefLine,
  isInViewport,
  MAX_REF_NODES,
  newSnapshotId,
  orderRefsForRender,
  renderSnapshotDetailed,
  renderSnapshotText,
  selectCandidates,
  textHashOf,
  truncationMarker,
} from "./snapshot.js";
export type { CandidateNode, RenderedSnapshot } from "./snapshot.js";

export { DEFAULT_DIFF_MAX_CHARS, diffSnapshots } from "./diff.js";

export { extractRows, pageExtract } from "./extract.js";
export type { ExtractField, ExtractResult, ExtractRowsOptions, PageExtractInput, PageExtractQuery } from "./extract.js";

export { buildSelectorMap } from "./selectors.js";
export type { CdpDomNode } from "./selectors.js";

export { collectRawPageData, DEFAULT_TIMEOUT_MS } from "./gather.js";
export type { GatheredPageData, GatherOptions } from "./gather.js";
