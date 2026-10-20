/**
 * Deterministic replay: record what an agent did, then re-run it as a test.
 *
 * A trace is JSONL — one header line, then steps and checkpoints. Refs are session-scoped
 * (`e13` means nothing in a new tab), so every recorded target also stores the element's role,
 * accessible name and ordinal; the player re-resolves the ref by identity before acting. That
 * is the difference between a trace that only replays in the recording session and one that
 * works tomorrow.
 *
 * Divergence is a first-class outcome: when a step's recorded page hash no longer matches, the
 * player reports it instead of clicking whatever happens to be at that ref now.
 */
import { createHash } from "node:crypto";
import { appendFile, readFile, writeFile } from "node:fs/promises";
import type { Action, Snapshot } from "@zimreaper/protocol";

export const TRACE_VERSION = 1;

/** The minimum of a control client this package needs. Keeps replay free of a core dependency. */
export interface ReplayClient {
  act(action: Action, opts?: { timeoutMs?: number }): Promise<{ result: unknown }>;
  query<T = unknown>(query: { kind: string } & Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<T>;
}

/** How a ref was identified at record time, so it can be found again later. */
export interface ResolvedTarget {
  role: string;
  name: string;
  /** 0-based index among refs sharing role+name, for pages with repeated labels. */
  ordinal: number;
  selector?: string;
}

export interface TraceHeader {
  kind: "header";
  version: number;
  createdAt: string;
  url: string;
  title?: string;
  viewport?: { width: number; height: number };
  zimreaper: string;
}

export interface TraceStep {
  kind: "step";
  seq: number;
  ts: number;
  action: Action;
  ok: boolean;
  ms: number;
  /** Identity of each ref in `action`, keyed by the JSON path it appeared at. */
  resolved?: Record<string, ResolvedTarget>;
  hashBefore?: string;
  hashAfter?: string;
  urlBefore?: string;
  urlAfter?: string;
  error?: { code: string; message: string };
}

export interface TraceCheckpoint {
  kind: "checkpoint";
  seq: number;
  ts: number;
  label?: string;
  snapshotId: string;
  pageHash: string;
  url: string;
}

export type TraceLine = TraceHeader | TraceStep | TraceCheckpoint;

export interface Trace {
  header: TraceHeader;
  lines: TraceLine[];
  steps: TraceStep[];
}

export interface Divergence {
  seq: number;
  reason: "page-hash" | "url" | "target-missing" | "step-failed";
  expected?: string;
  actual?: string;
  detail?: string;
}

export interface PlayReport {
  total: number;
  passed: number;
  failed: number;
  divergences: Divergence[];
  durationMs: number;
}

/* ------------------------------------------------------------------ serialise */

export function toJSONL(lines: TraceLine[]): string {
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

export function parseTrace(text: string): Trace {
  const lines: TraceLine[] = [];
  for (const [index, raw] of text.split("\n").entries()) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new Error(`trace line ${index + 1} is not JSON`);
    }
    const kind = (parsed as { kind?: string }).kind;
    if (kind !== "header" && kind !== "step" && kind !== "checkpoint") {
      throw new Error(`trace line ${index + 1} has unknown kind ${String(kind)}`);
    }
    lines.push(parsed as TraceLine);
  }
  const header = lines.find((line): line is TraceHeader => line.kind === "header");
  if (!header) throw new Error("trace has no header line");
  if (header.version !== TRACE_VERSION) {
    throw new Error(`trace version ${header.version} is not supported (expected ${TRACE_VERSION})`);
  }
  return { header, lines, steps: lines.filter((line): line is TraceStep => line.kind === "step") };
}

/* -------------------------------------------------------------------- record */

export interface RecorderOptions {
  /** Capture a page hash before and after every step (slower, enables divergence checks). */
  verify?: boolean;
  url?: string;
  title?: string;
  viewport?: { width: number; height: number };
  version?: string;
}

/** Every `target`/`from`/`to` in an action, by JSON path, so identity can be recorded. */
export function targetPaths(action: Action): string[] {
  const paths: string[] = [];
  for (const key of ["target", "from", "to"] as const) {
    if ((action as unknown as Record<string, unknown>)[key]) paths.push(key);
  }
  return paths;
}

function ordinalOf(snapshot: Snapshot, ref: string, role: string, name: string): number {
  const peers = snapshot.refs.filter((r) => r.role === role && r.name === name);
  return Math.max(0, peers.findIndex((r) => r.ref === ref));
}

export class TraceRecorder {
  private readonly lines: TraceLine[] = [];
  private seq = 0;

  constructor(
    private readonly client: ReplayClient,
    private readonly options: RecorderOptions = {},
  ) {}

  get steps(): TraceStep[] {
    return this.lines.filter((line): line is TraceStep => line.kind === "step");
  }

  get linesOut(): TraceLine[] {
    return [...this.lines];
  }

  async start(): Promise<TraceHeader> {
    const snapshot = await this.client.query<Snapshot>({ kind: "page.snapshot" });
    const header: TraceHeader = {
      kind: "header",
      version: TRACE_VERSION,
      createdAt: new Date().toISOString(),
      url: this.options.url ?? snapshot.url,
      title: this.options.title ?? snapshot.title,
      viewport: this.options.viewport ?? snapshot.viewport,
      zimreaper: this.options.version ?? "0.1.0",
    };
    this.lines.push(header);
    this.lines.push({
      kind: "checkpoint",
      seq: this.seq++,
      ts: Date.now(),
      label: "start",
      snapshotId: snapshot.snapshotId,
      pageHash: snapshot.pageHash,
      url: snapshot.url,
    });
    return header;
  }

  /** Run one action through the client and append it to the trace. */
  async step(action: Action, opts: { timeoutMs?: number } = {}): Promise<{ result: unknown }> {
    let resolved: Record<string, ResolvedTarget> | undefined;
    let hashBefore: string | undefined;
    let urlBefore: string | undefined;

    if (this.options.verify || targetPaths(action).length > 0) {
      const snapshot = await this.client.query<Snapshot>({ kind: "page.snapshot" });
      hashBefore = snapshot.pageHash;
      urlBefore = snapshot.url;
      resolved = {};
      for (const key of targetPaths(action)) {
        const target = (action as unknown as Record<string, { ref?: string }>)[key];
        if (!target?.ref) continue;
        const ref = snapshot.refs.find((r) => r.ref === target.ref);
        if (!ref) continue;
        resolved[key] = {
          role: ref.role,
          name: ref.name,
          ordinal: ordinalOf(snapshot, ref.ref, ref.role, ref.name),
          selector: ref.selector,
        };
      }
      if (Object.keys(resolved).length === 0) resolved = undefined;
    }

    const started = Date.now();
    let ok = true;
    let error: TraceStep["error"];
    let result: unknown;
    try {
      ({ result } = await this.client.act(action, opts));
    } catch (err) {
      ok = false;
      const shaped = err as { code?: string; message?: string };
      error = { code: shaped.code ?? "UNKNOWN", message: shaped.message ?? String(err) };
      result = undefined;
    }
    const ms = Date.now() - started;

    let hashAfter: string | undefined;
    let urlAfter: string | undefined;
    if (this.options.verify) {
      try {
        const snapshot = await this.client.query<Snapshot>({ kind: "page.snapshot" });
        hashAfter = snapshot.pageHash;
        urlAfter = snapshot.url;
      } catch {
        /* navigation in flight: leave the after-state unrecorded */
      }
    }

    this.lines.push({
      kind: "step",
      seq: this.seq++,
      ts: Date.now(),
      action,
      ok,
      ms,
      resolved,
      hashBefore,
      hashAfter,
      urlBefore,
      urlAfter,
      error,
    });
    if (!ok) {
      const shaped = error ?? { code: "UNKNOWN", message: "step failed" };
      const wrapped = new Error(`step ${this.seq - 1} failed: ${shaped.code} ${shaped.message}`);
      (wrapped as Error & { code?: string }).code = shaped.code;
      throw wrapped;
    }
    return { result };
  }

  async checkpoint(label?: string): Promise<void> {
    const snapshot = await this.client.query<Snapshot>({ kind: "page.snapshot" });
    this.lines.push({
      kind: "checkpoint",
      seq: this.seq++,
      ts: Date.now(),
      label,
      snapshotId: snapshot.snapshotId,
      pageHash: snapshot.pageHash,
      url: snapshot.url,
    });
  }

  toJSONL(): string {
    return toJSONL(this.lines);
  }

  async save(path: string): Promise<void> {
    await writeFile(path, this.toJSONL(), "utf8");
  }

  async appendTo(path: string): Promise<void> {
    await appendFile(path, this.toJSONL(), "utf8");
  }
}

/* ---------------------------------------------------------------------- play */

export interface PlayerOptions {
  /** Compare recorded page hashes before each step. Default true. */
  checkHashes?: boolean;
  /** Abort on the first divergence. Default true. */
  stopOnDivergence?: boolean;
  /** Called after every step, for progress output. */
  onStep?: (step: TraceStep, report: PlayReport) => void;
}

export class TracePlayer {
  constructor(
    private readonly client: ReplayClient,
    private readonly trace: Trace,
    private readonly options: PlayerOptions = {},
  ) {}

  private async snapshot(): Promise<Snapshot> {
    return this.client.query<Snapshot>({ kind: "page.snapshot" });
  }

  /** Find the ref that plays the same role as the recorded one. */
  private resolve(snapshot: Snapshot, target: ResolvedTarget): string | undefined {
    const peers = snapshot.refs.filter((r) => r.role === target.role && r.name === target.name);
    return (peers[target.ordinal] ?? peers[0])?.ref;
  }

  async play(): Promise<PlayReport> {
    const started = Date.now();
    const report: PlayReport = {
      total: this.trace.steps.length,
      passed: 0,
      failed: 0,
      divergences: [],
      durationMs: 0,
    };
    const checkHashes = this.options.checkHashes ?? true;
    const stop = this.options.stopOnDivergence ?? true;

    for (const step of this.trace.steps) {
      const action = structuredClone(step.action) as Action;

      // Re-bind every recorded ref to whatever carries the same identity now.
      if (step.resolved) {
        const needsSnapshot = Object.keys(step.resolved).length > 0;
        const snapshot = needsSnapshot ? await this.snapshot() : undefined;
        if (snapshot && checkHashes && step.hashBefore && snapshot.pageHash !== step.hashBefore) {
          report.divergences.push({
            seq: step.seq,
            reason: "page-hash",
            expected: step.hashBefore,
            actual: snapshot.pageHash,
            detail: `before ${step.action.kind}`,
          });
          if (stop) break;
        }
        for (const [key, target] of Object.entries(step.resolved)) {
          const ref = snapshot ? this.resolve(snapshot, target) : undefined;
          if (!ref) {
            report.divergences.push({
              seq: step.seq,
              reason: "target-missing",
              expected: `${target.role} "${target.name}" #${target.ordinal}`,
              detail: `before ${step.action.kind}`,
            });
            if (stop) break;
            continue;
          }
          (action as unknown as Record<string, { ref?: string }>)[key] = {
            ...(action as unknown as Record<string, { ref?: string }>)[key],
            ref,
          };
        }
      }

      try {
        await this.client.act(action, { timeoutMs: 30_000 });
        report.passed += 1;
      } catch (err) {
        report.failed += 1;
        const shaped = err as { code?: string; message?: string };
        report.divergences.push({
          seq: step.seq,
          reason: "step-failed",
          expected: "ok",
          actual: shaped.code ?? "UNKNOWN",
          detail: shaped.message ?? String(err),
        });
        if (stop) {
          this.options.onStep?.(step, report);
          break;
        }
      }
      this.options.onStep?.(step, report);
    }

    report.durationMs = Date.now() - started;
    return report;
  }
}

/** Stable hash of a trace body, for pinning fixtures in CI. */
export function traceHash(trace: Trace): string {
  const body = trace.lines
    .filter((line) => line.kind === "step")
    .map((line) => JSON.stringify((line as TraceStep).action))
    .join("\n");
  return createHash("sha256").update(body).digest("hex").slice(0, 16);
}

export async function loadTrace(path: string): Promise<Trace> {
  return parseTrace(await readFile(path, "utf8"));
}
