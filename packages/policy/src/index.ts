/**
 * Policy: origin trust tiers, action classification, human approval, hash-chained audit.
 * Deterministic and side-effect free except for the append-only audit log.
 */
import type { Action, AuditEntry } from "@zimreaper/protocol";
import { ZimReaperError } from "@zimreaper/protocol";

export type Verdict = "allow" | "confirm" | "block";
export type PolicyMode = "permissive" | "standard" | "strict";

export interface OriginPolicy {
  /** read = observe only; interact = forms/nav; transact = pay/send/delete/publish. */
  tier: "read" | "interact" | "transact";
  allowEval?: boolean;
  allowUploads?: boolean;
  allowDownloads?: boolean;
}

export interface PolicyConfig {
  mode: PolicyMode;
  origins: Record<string, OriginPolicy>;
  /** Extra CSS-selector/name heuristics that mark an element destructive. */
  destructivePatterns: string[];
  approvalTimeoutMs: number;
  maxActionsPerMinute: number;
}

export interface PolicyContext {
  url?: string;
  actor: string;
  /** True when the model's rationale quotes page-derived text. */
  tainted?: boolean;
}

export interface PolicyDecision {
  verdict: Verdict;
  reason: string;
  /** Present when verdict is confirm. */
  approvalId?: string;
}

export interface PolicyEngine {
  preflight(action: Action, ctx: PolicyContext): PolicyDecision;
  record(entry: Omit<AuditEntry, "seq" | "prevHash" | "hash">): AuditEntry;
  tail(limit: number): AuditEntry[];
  verifyChain(): { ok: boolean; brokenAt?: number; entries: number };
  config(): PolicyConfig;
}

export interface PolicyOptions {
  /** Directory for policy.json + audit/*.jsonl, normally ~/.zimreaper. */
  dir: string;
  sessionId: string;
  config?: Partial<PolicyConfig>;
  now?: () => number;
}

export function createPolicy(_opts: PolicyOptions): Promise<PolicyEngine> {
  throw new ZimReaperError("UNSUPPORTED", "policy not implemented yet");
}

export function defaultPolicyConfig(): PolicyConfig {
  return {
    mode: "standard",
    origins: {},
    destructivePatterns: [
      "pay",
      "purchase",
      "buy now",
      "place order",
      "send",
      "delete",
      "remove",
      "publish",
      "post",
      "transfer",
      "authorize",
      "grant access",
    ],
    approvalTimeoutMs: 120_000,
    maxActionsPerMinute: 240,
  };
}

export function classify(_action: Action, _ctx: PolicyContext, _config: PolicyConfig): PolicyDecision {
  throw new ZimReaperError("UNSUPPORTED", "classify not implemented yet");
}
