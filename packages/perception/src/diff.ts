/**
 * Snapshot diffing: what appeared, vanished, or changed since the last look.
 *
 * This is the token saver — a loop that re-reads a 12k snapshot every step is paying
 * for the whole page to learn one row changed.
 */
import type { Diff, RefInfo, Snapshot } from "@zimreaper/protocol";
import { formatRefLine, truncationMarker } from "./snapshot.js";
import { quote } from "./util.js";

export const DEFAULT_DIFF_MAX_CHARS = 6_000;

interface ChangedRef {
  ref: string;
  before: string;
  after: string;
}

function identityKey(ref: RefInfo): string {
  return `${ref.role}\u0000${ref.name}\u0000${ref.selector ?? ""}`;
}

function boxKey(ref: RefInfo): string {
  const { x, y, width, height } = ref.bbox;
  return `${x},${y},${width}x${height}`;
}

/**
 * before/after are self-describing ("value \"a\"" / "name \"Next\""), because the wire
 * Diff has no field for *what* changed.
 */
function describeChange(before: RefInfo, after: RefInfo): { before: string; after: string } {
  if ((before.value ?? "") !== (after.value ?? "")) {
    return {
      before: `value ${quote(before.value ?? "", 80)}`,
      after: `value ${quote(after.value ?? "", 80)}`,
    };
  }
  if (before.name !== after.name) {
    return { before: `name ${quote(before.name)}`, after: `name ${quote(after.name)}` };
  }
  if (before.role !== after.role) {
    return { before: `role ${before.role}`, after: `role ${after.role}` };
  }
  return { before: `box ${boxKey(before)}`, after: `box ${boxKey(after)}` };
}

function renderChange(change: ChangedRef): string {
  const split = change.before.indexOf(" ");
  if (split <= 0) return `~ [${change.ref}] ${change.before} -> ${change.after}`;
  const label = change.before.slice(0, split);
  const beforeValue = change.before.slice(split + 1);
  const afterValue = change.after.startsWith(`${label} `)
    ? change.after.slice(label.length + 1)
    : change.after;
  return `~ [${change.ref}] ${label} ${beforeValue} -> ${afterValue}`;
}

function bucketBy<T>(items: readonly T[], keyOf: (item: T) => string): Map<string, T[]> {
  const buckets = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const list = buckets.get(key);
    if (list) list.push(item);
    else buckets.set(key, [item]);
  }
  return buckets;
}

export function diffSnapshots(
  prev: Snapshot,
  next: Snapshot,
  maxChars: number = DEFAULT_DIFF_MAX_CHARS,
): Diff {
  const matchedPrev = new Set<RefInfo>();
  const matchedNext = new Set<RefInfo>();
  const changed: ChangedRef[] = [];

  // Pass 1: same role + name + selector is the same element, whatever its ref number.
  const byIdentity = bucketBy(prev.refs, identityKey);
  for (const ref of next.refs) {
    const candidate = byIdentity.get(identityKey(ref))?.shift();
    if (!candidate) continue;
    matchedPrev.add(candidate);
    matchedNext.add(ref);
    if (candidate.textHash !== ref.textHash) {
      const description = describeChange(candidate, ref);
      changed.push({ ref: ref.ref, before: description.before, after: description.after });
    }
  }

  // Pass 2: identical content, different identity (moved in the DOM, renamed selector).
  const byHash = bucketBy(
    prev.refs.filter((ref) => !matchedPrev.has(ref)),
    (ref) => ref.textHash,
  );
  for (const ref of next.refs) {
    if (matchedNext.has(ref)) continue;
    const candidate = byHash.get(ref.textHash)?.shift();
    if (!candidate) continue;
    matchedPrev.add(candidate);
    matchedNext.add(ref);
  }

  // Pass 3: same role + same CSS selector is the same element whose label changed
  // (a table cell flipping from "Pending" to "Shipped", a counter ticking over).
  const bySelector = bucketBy(
    prev.refs.filter((ref) => !matchedPrev.has(ref) && ref.selector !== undefined && ref.selector !== ""),
    (ref) => `${ref.role}\u0000${ref.selector ?? ""}`,
  );
  for (const ref of next.refs) {
    if (matchedNext.has(ref) || ref.selector === undefined || ref.selector === "") continue;
    const candidate = bySelector.get(`${ref.role}\u0000${ref.selector}`)?.shift();
    if (!candidate) continue;
    matchedPrev.add(candidate);
    matchedNext.add(ref);
    const description = describeChange(candidate, ref);
    changed.push({ ref: ref.ref, before: description.before, after: description.after });
  }

  const added = next.refs.filter((ref) => !matchedNext.has(ref));
  const removed = prev.refs.filter((ref) => !matchedPrev.has(ref));
  const pageHashChanged = prev.pageHash !== next.pageHash;

  const header =
    `diff snap=${prev.snapshotId}->${next.snapshotId}` +
    `  +${added.length} -${removed.length} ~${changed.length}` +
    `  pageHash=${pageHashChanged ? "changed" : "same"}`;

  const lines: string[] = [
    ...added.map((ref) => `+ ${formatRefLine(ref)}`),
    ...removed.map((ref) => `- ${formatRefLine(ref)}`),
    ...changed.map(renderChange),
  ];

  let used = header.length;
  const shown: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i] as string;
    const remaining = lines.length - i - 1;
    const reserve = remaining > 0 ? truncationMarker(remaining).length + 1 : 0;
    if (used + 1 + line.length + reserve > maxChars) break;
    used += 1 + line.length;
    shown.push(line);
  }
  const dropped = lines.length - shown.length;
  const parts = [header, ...shown];
  if (dropped > 0) parts.push(truncationMarker(dropped));

  return {
    snapshotId: next.snapshotId,
    since: prev.snapshotId,
    added,
    removed,
    changed,
    text: parts.join("\n"),
    pageHashChanged,
  };
}
