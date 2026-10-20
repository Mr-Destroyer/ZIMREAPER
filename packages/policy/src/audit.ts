import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { ZimReaperError, type AuditEntry } from "@zimreaper/protocol";
import type { AuditRecordInput } from "./types.js";

const AUDIT_FILE = /^\d{4}-\d{2}-\d{2}\.jsonl$/;

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function auditDate(ts: number): string {
  const date = new Date(ts);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

/** Fixed field order keeps the hash stable even if a reader reorders JSON keys. */
function canonicalEntry(entry: Omit<AuditEntry, "hash">): Omit<AuditEntry, "hash"> {
  return {
    seq: entry.seq,
    ts: entry.ts,
    actor: entry.actor,
    sessionId: entry.sessionId,
    ...(entry.tabId !== undefined ? { tabId: entry.tabId } : {}),
    ...(entry.url !== undefined ? { url: entry.url } : {}),
    kind: entry.kind,
    argsHash: entry.argsHash,
    outcome: entry.outcome,
    ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
    prevHash: entry.prevHash,
  };
}

function entryHash(entry: Omit<AuditEntry, "hash">): string {
  return sha256(`${entry.prevHash}${JSON.stringify(canonicalEntry(entry))}`);
}

function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
  return `{${entries.join(",")}}`;
}

/** Hash action args before they cross the policy boundary. Raw args never reach the log. */
export function hashArgs(args: unknown): string {
  try {
    return sha256(stableStringify(args));
  } catch (error) {
    throw new ZimReaperError("BAD_REQUEST", "action args are not hashable", {
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

function countNewlines(buffer: Buffer): number {
  let count = 0;
  for (const byte of buffer) if (byte === 0x0a) count += 1;
  return count;
}

/** Read the last `limit` non-empty lines without loading a large log from the start. */
function readLastLines(path: string, limit: number): string[] {
  if (limit <= 0) return [];
  const fd = openSync(path, "r");
  try {
    const size = statSync(path).size;
    if (size === 0) return [];
    const chunks: Buffer[] = [];
    let position = size;
    let newlines = 0;
    const chunkSize = 64 * 1024;

    while (position > 0 && newlines <= limit) {
      const readSize = Math.min(chunkSize, position);
      position -= readSize;
      const start = position > 0 ? position - 1 : position;
      const length = position + readSize - start;
      const buffer = Buffer.allocUnsafe(length);
      readSync(fd, buffer, 0, length, start);
      chunks.unshift(buffer);
      newlines += countNewlines(buffer);
    }

    const text = Buffer.concat(chunks).toString("utf8");
    const lines = text.split("\n");
    if (position > 0 && lines.length > 0) lines.shift();
    while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
    return lines.slice(-limit);
  } finally {
    closeSync(fd);
  }
}

function parseEntry(line: string, file: string): AuditEntry {
  try {
    return JSON.parse(line) as AuditEntry;
  } catch (error) {
    throw new ZimReaperError("INTERNAL", `corrupt audit entry in ${file}`, {
      details: error instanceof Error ? error.message : String(error),
    });
  }
}

export class AuditLog {
  private readonly auditDir: string;
  private readonly states = new Map<string, { seq: number; hash: string }>();

  constructor(
    dir: string,
    private readonly sessionId: string,
    private readonly now: () => number,
  ) {
    this.auditDir = join(dir, "audit");
    try {
      mkdirSync(this.auditDir, { recursive: true, mode: 0o700 });
    } catch (error) {
      throw new ZimReaperError("INTERNAL", `cannot create audit directory ${this.auditDir}`, {
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private fileFor(date: string): string {
    return join(this.auditDir, `${date}.jsonl`);
  }

  private stateFor(date: string, file: string): { seq: number; hash: string } {
    const cached = this.states.get(date);
    if (cached) return cached;
    let state = { seq: 0, hash: "0" };
    if (existsSync(file)) {
      const lines = readLastLines(file, 1);
      if (lines.length > 0) {
        const last = parseEntry(lines[0], file);
        if (typeof last.seq !== "number" || typeof last.hash !== "string") {
          throw new ZimReaperError("INTERNAL", `corrupt audit tail in ${file}`);
        }
        state = { seq: last.seq, hash: last.hash };
      }
    }
    this.states.set(date, state);
    return state;
  }

  record(input: AuditRecordInput): AuditEntry {
    const ts = input.ts ?? this.now();
    const date = auditDate(ts);
    const file = this.fileFor(date);
    const state = this.stateFor(date, file);
    const seq = state.seq + 1;
    const prevHash = state.hash;
    const withoutHash = canonicalEntry({
      ...input,
      ts,
      sessionId: input.sessionId || this.sessionId,
      seq,
      prevHash,
    });
    const entry: AuditEntry = { ...withoutHash, hash: entryHash(withoutHash) };

    try {
      const fd = openSync(file, "a", 0o600);
      try {
        const data = Buffer.from(`${JSON.stringify(entry)}\n`, "utf8");
        let offset = 0;
        while (offset < data.length) {
          offset += writeSync(fd, data, offset, data.length - offset);
        }
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    } catch (error) {
      throw new ZimReaperError("INTERNAL", `cannot append audit entry to ${file}`, {
        details: error instanceof Error ? error.message : String(error),
      });
    }

    state.seq = seq;
    state.hash = entry.hash;
    return entry;
  }

  tail(limit: number): AuditEntry[] {
    if (limit <= 0) return [];
    const files = this.files();
    const newest = files[files.length - 1];
    if (!newest) return [];
    const path = join(this.auditDir, newest);
    return readLastLines(path, limit).map((line) => parseEntry(line, path));
  }

  verifyChain(): { ok: boolean; brokenAt?: number; entries: number } {
    let entries = 0;
    for (const file of this.files()) {
      const path = join(this.auditDir, file);
      const lines = readFileSync(path, "utf8")
        .split("\n")
        .filter((line) => line.trim() !== "");
      let previousHash = "0";
      for (let index = 0; index < lines.length; index += 1) {
        entries += 1;
        const entry = parseEntry(lines[index], path);
        const withoutHash: Omit<AuditEntry, "hash"> = {
          seq: entry.seq,
          ts: entry.ts,
          actor: entry.actor,
          sessionId: entry.sessionId,
          ...(entry.tabId !== undefined ? { tabId: entry.tabId } : {}),
          ...(entry.url !== undefined ? { url: entry.url } : {}),
          kind: entry.kind,
          argsHash: entry.argsHash,
          outcome: entry.outcome,
          ...(entry.detail !== undefined ? { detail: entry.detail } : {}),
          prevHash: entry.prevHash,
        };
        const expectedSeq = index + 1;
        const valid =
          entry.seq === expectedSeq &&
          entry.prevHash === previousHash &&
          entry.hash === entryHash(withoutHash);
        if (!valid) return { ok: false, brokenAt: entries, entries };
        previousHash = entry.hash;
      }
    }
    return { ok: true, entries };
  }

  private files(): string[] {
    try {
      return readdirSync(this.auditDir)
        .filter((name) => AUDIT_FILE.test(name))
        .sort();
    } catch (error) {
      throw new ZimReaperError("INTERNAL", `cannot list audit directory ${this.auditDir}`, {
        details: error instanceof Error ? error.message : String(error),
      });
    }
  }
}
