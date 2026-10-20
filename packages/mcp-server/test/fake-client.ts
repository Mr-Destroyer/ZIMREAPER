import type { ControlClient, CallOptions } from "@zimreaper/core";
import type { Action, Event, Query, ResponseMeta } from "@zimreaper/protocol";

export interface RecordedCall {
  method: "act" | "query";
  payload: Action | Query;
  opts?: CallOptions;
}

export class FakeControlClient {
  readonly calls: RecordedCall[] = [];
  readonly actResult: unknown;
  readonly queryResult: unknown;

  constructor(opts: { actResult?: unknown; queryResult?: unknown } = {}) {
    this.actResult = opts.actResult ?? { ok: true };
    this.queryResult = opts.queryResult ?? [];
  }

  async act(action: Action, opts?: CallOptions): Promise<{ result: unknown; meta?: ResponseMeta }> {
    this.calls.push({ method: "act", payload: action, ...(opts ? { opts } : {}) });
    return { result: this.actResult, meta: { ms: 1 } };
  }

  async query<T = unknown>(query: Query, opts?: CallOptions): Promise<T> {
    this.calls.push({ method: "query", payload: query, ...(opts ? { opts } : {}) });
    return this.queryResult as T;
  }

  on(_listener: (event: Event) => void): () => void {
    return () => undefined;
  }

  close(): void {}
}

export const asClient = (fake: FakeControlClient): ControlClient => fake as unknown as ControlClient;
