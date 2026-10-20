/**
 * The stateful face of perception: one generation counter, one ref table and one
 * snapshot cache per tab. The executor resolves refs through this object, which is why
 * `invalidate` (called on navigation) has to make old refs fail loudly rather than
 * silently resolve to whatever now sits at that box.
 */
import type { Diff, RefInfo, Snapshot } from "@zimreaper/protocol";
import { ZimReaperError } from "@zimreaper/protocol";
import { diffSnapshots } from "./diff.js";
import { collectRawPageData } from "./gather.js";
import {
  buildSnapshot,
  computePageHash,
  DEFAULT_MAX_CHARS,
  renderSnapshotDetailed,
} from "./snapshot.js";
import type { Perception, PerceptionOptions, SnapshotOptions } from "./types.js";

const MAX_HISTORY = 32;

interface TabState {
  generation: number;
  current?: Snapshot;
  pageHash?: string;
  renderedMaxChars?: number;
  refs: Map<string, RefInfo>;
  history: Map<string, Snapshot>;
}

export function createPerception(opts: PerceptionOptions): Perception {
  const sendFor = opts.send;
  const now = opts.now ?? Date.now;
  const timeoutMs = opts.timeoutMs;
  const tabs = new Map<string, TabState>();

  const stateFor = (tabId: string): TabState => {
    const existing = tabs.get(tabId);
    if (existing) return existing;
    const created: TabState = { generation: 0, refs: new Map(), history: new Map() };
    tabs.set(tabId, created);
    return created;
  };

  const remember = (state: TabState, snapshot: Snapshot): void => {
    state.history.set(snapshot.snapshotId, snapshot);
    while (state.history.size > MAX_HISTORY) {
      const oldest = state.history.keys().next();
      if (oldest.done) break;
      state.history.delete(oldest.value);
    }
  };

  const snapshot = async (tabId: string, snapshotOpts: SnapshotOptions = {}): Promise<Snapshot> => {
    const state = stateFor(tabId);
    const { raw, selectors } = await collectRawPageData(sendFor(tabId), tabId, {
      interactiveOnly: snapshotOpts.interactiveOnly,
      timeoutMs,
      now,
    });

    const pageHash = computePageHash(raw);
    const maxChars = snapshotOpts.maxChars ?? DEFAULT_MAX_CHARS;
    const useCache = snapshotOpts.cache !== false;

    if (useCache && state.current && state.pageHash === pageHash) {
      const cached = state.current;
      if (state.renderedMaxChars === maxChars) return cached;
      // Same page, different budget: same snapshotId, re-rendered text.
      const rendered = renderSnapshotDetailed(cached, maxChars);
      const rerendered: Snapshot = { ...cached, text: rendered.text, truncated: rendered.truncated };
      state.renderedMaxChars = maxChars;
      state.current = rerendered;
      remember(state, rerendered);
      return rerendered;
    }

    state.generation += 1;
    const built = buildSnapshot(raw, {
      ...snapshotOpts,
      selectors,
      generation: state.generation,
    });

    state.current = built;
    state.pageHash = built.pageHash;
    state.renderedMaxChars = maxChars;
    state.refs = new Map(built.refs.map((ref) => [ref.ref, ref]));
    remember(state, built);
    return built;
  };

  const diff = async (tabId: string, since: string): Promise<Diff> => {
    const state = stateFor(tabId);
    const previous = state.history.get(since);
    if (!previous) {
      throw new ZimReaperError("NOT_FOUND", `no snapshot ${since} for tab ${tabId}`, {
        details: { known: [...state.history.keys()] },
      });
    }
    const current = state.current ?? (await snapshot(tabId));
    return diffSnapshots(previous, current);
  };

  return {
    snapshot,
    diff,
    ref(tabId: string, ref: string): RefInfo | undefined {
      return tabs.get(tabId)?.refs.get(ref);
    },
    generation(tabId: string): number {
      return tabs.get(tabId)?.generation ?? 0;
    },
    pageHash(tabId: string): string | undefined {
      return tabs.get(tabId)?.pageHash;
    },
    invalidate(tabId: string): void {
      const state = tabs.get(tabId);
      if (!state) return;
      state.current = undefined;
      state.pageHash = undefined;
      state.renderedMaxChars = undefined;
      state.refs.clear();
    },
  };
}
