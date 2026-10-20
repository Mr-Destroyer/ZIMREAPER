import type { Action, Query } from "@zimreaper/protocol";
import { ZimReaperError } from "@zimreaper/protocol";
import type { Backend } from "./backend.js";
import type { Perception } from "@zimreaper/perception";
import type { PolicyEngine } from "@zimreaper/policy";

export interface ActionContext {
  tabId: string;
  requestId: string;
  actor: string;
  signal: AbortSignal;
}

export type ActionResult = Record<string, unknown>;

export interface ExecutorOptions {
  backend: Backend;
  perception: Perception;
  policy: PolicyEngine;
  /** ~/.zimreaper/artifacts/<sessionId> */
  artifactsDir: string;
}

/**
 * Resolves targets (ref -> box model -> viewport point), dispatches real CDP input,
 * settles the page, and maps failures to the protocol error taxonomy.
 */
export class Executor {
  constructor(_opts: ExecutorOptions) {
    throw new ZimReaperError("UNSUPPORTED", "Executor not implemented yet");
  }

  act(_action: Action, _ctx: ActionContext): Promise<ActionResult> {
    throw new ZimReaperError("UNSUPPORTED", "Executor.act not implemented yet");
  }

  query(_query: Query, _ctx: ActionContext): Promise<unknown> {
    throw new ZimReaperError("UNSUPPORTED", "Executor.query not implemented yet");
  }

  cancel(_tabId?: string): void {
    throw new ZimReaperError("UNSUPPORTED", "Executor.cancel not implemented yet");
  }
}
