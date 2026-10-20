/**
 * Schema-driven extraction: one Runtime.evaluate that walks repeating rows and returns
 * plain strings, so the executor never has to round-trip per field.
 */
import type { Query } from "@zimreaper/protocol";
import { ZimReaperError } from "@zimreaper/protocol";
import type { CdpSend } from "./types.js";
import { messageOf } from "./util.js";

export interface ExtractField {
  /** Selector relative to the row; omit (or set self) to read the row element itself. */
  selector?: string;
  /** Read this attribute instead of text. */
  attr?: string;
  self?: boolean;
}

export interface ExtractRowsOptions {
  rowSelector: string;
  fields: Record<string, ExtractField>;
  limit?: number;
}

export interface ExtractResult {
  rows: Record<string, string>[];
  /** Rows matched on the page, which may exceed `rows.length` when `limit` truncates. */
  count: number;
}

export type PageExtractQuery = Extract<Query, { kind: "page.extract" }>;

/** Looser than the wire type so callers may omit `self` (it defaults to false). */
export type PageExtractInput = Omit<PageExtractQuery, "fields"> & {
  fields: Record<string, ExtractField>;
};

const DEFAULT_LIMIT = 100;

const READER = `const read = (row, spec) => {
  const el = !spec || !spec.selector || spec.self ? row : row.querySelector(spec.selector);
  if (!el) return "";
  if (spec.attr) {
    const attr = el.getAttribute(spec.attr);
    return attr == null ? "" : String(attr).replace(/\\s+/g, " ").trim();
  }
  const text = typeof el.innerText === "string" ? el.innerText : el.textContent;
  return String(text == null ? "" : text).replace(/\\s+/g, " ").trim();
};`;

function buildExpression(opts: ExtractRowsOptions): string {
  const config = JSON.stringify({
    rowSelector: opts.rowSelector,
    fields: opts.fields,
    limit: opts.limit ?? DEFAULT_LIMIT,
  });
  return `(() => {
  const cfg = ${config};
  ${READER}
  try {
    const all = document.querySelectorAll(cfg.rowSelector);
    const rows = [];
    for (let i = 0; i < all.length && i < cfg.limit; i += 1) {
      const row = all[i];
      const out = {};
      for (const key of Object.keys(cfg.fields)) out[key] = read(row, cfg.fields[key]);
      rows.push(out);
    }
    return { ok: true, count: all.length, rows };
  } catch (err) {
    return { ok: false, error: String(err && err.message ? err.message : err) };
  }
})()`;
}

interface EvaluateResponse {
  result?: { value?: unknown };
  exceptionDetails?: { text?: string; exception?: { description?: string } };
}

interface ExtractPayload {
  ok?: boolean;
  error?: string;
  count?: number;
  rows?: unknown;
}

function toRows(value: unknown, keys: string[]): Record<string, string>[] {
  if (!Array.isArray(value)) {
    throw new ZimReaperError("INTERNAL", "page.extract returned a non-array result");
  }
  return value.map((entry) => {
    const source = (typeof entry === "object" && entry !== null ? entry : {}) as Record<string, unknown>;
    const row: Record<string, string> = {};
    for (const key of keys) {
      const field = source[key];
      row[key] = typeof field === "string" ? field : field === undefined || field === null ? "" : String(field);
    }
    return row;
  });
}

export async function extractRows(send: CdpSend, opts: ExtractRowsOptions): Promise<ExtractResult> {
  if (opts.rowSelector.trim() === "") {
    throw new ZimReaperError("BAD_REQUEST", "rowSelector must not be empty");
  }
  const keys = Object.keys(opts.fields);

  let response: EvaluateResponse;
  try {
    response = await send<EvaluateResponse>("Runtime.evaluate", {
      expression: buildExpression(opts),
      returnByValue: true,
      awaitPromise: false,
    });
  } catch (err) {
    throw new ZimReaperError("BACKEND_ERROR", `page.extract failed: ${messageOf(err)}`);
  }

  if (response.exceptionDetails) {
    const detail =
      response.exceptionDetails.exception?.description ?? response.exceptionDetails.text ?? "unknown";
    throw new ZimReaperError("BACKEND_ERROR", `page.extract threw: ${detail}`);
  }

  const payload = response.result?.value as ExtractPayload | undefined;
  if (!payload || typeof payload !== "object") {
    throw new ZimReaperError("INTERNAL", "page.extract returned no value");
  }
  if (payload.ok === false) {
    throw new ZimReaperError("BAD_REQUEST", `invalid rowSelector: ${payload.error ?? "unknown"}`);
  }

  const rows = toRows(payload.rows, keys);
  const count = typeof payload.count === "number" ? payload.count : rows.length;
  return { rows, count };
}

/** Adapter the core executor calls for `query page.extract`. */
export function pageExtract(send: CdpSend, query: PageExtractInput): Promise<ExtractResult> {
  return extractRows(send, {
    rowSelector: query.rowSelector,
    fields: query.fields,
    limit: query.limit,
  });
}
