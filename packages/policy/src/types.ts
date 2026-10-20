import type { Action, AuditEntry } from "@zimreaper/protocol";

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
  /**
   * Resolved target metadata, when the executor knows it. `classify` can only
   * see `action.target.selector` on its own, so a ref target's accessible name
   * must be supplied here for destructive-element heuristics.
   */
  target?: { name?: string; selector?: string };
}

export interface PolicyDecision {
  verdict: Verdict;
  reason: string;
  /** Present when verdict is confirm. */
  approvalId?: string;
}

/** Rolling-window state for the rate-limit rule. */
export interface ClassifyState {
  now?: number;
  /** Timestamps (ms) of recently attempted actions. */
  recentActions?: readonly number[];
}

export interface ApprovalMeta {
  tabId?: string;
  actionKind?: string;
  screenshotPath?: string;
  timeoutMs?: number;
  /** Hashed args only; raw action args must never enter an approval or audit record. */
  argsHash?: string;
}

export interface ApprovalRequest {
  id: string;
  requestedAt: number;
  actionKind: string;
  reason: string;
  tabId?: string;
  screenshotPath?: string;
  argsHash?: string;
  timeoutMs: number;
}

export type AuditRecordInput = Omit<AuditEntry, "seq" | "prevHash" | "hash">;

export interface PolicyEngine {
  preflight(action: Action, ctx: PolicyContext): PolicyDecision;
  record(entry: AuditRecordInput): AuditEntry;
  tail(limit: number): AuditEntry[];
  verifyChain(): { ok: boolean; brokenAt?: number; entries: number };
  config(): PolicyConfig;
  /** Park a CONFIRM decision until a human answers or the timeout denies it. */
  requestApproval(decision: PolicyDecision, meta?: ApprovalMeta): Promise<boolean>;
  /** Returns false when the id is unknown or already settled. */
  resolveApproval(id: string, approved: boolean): boolean;
  onApprovalRequest(cb: (request: ApprovalRequest) => void): () => void;
}

export interface PolicyOptions {
  /** Directory for policy.json + audit/*.jsonl, normally ~/.zimreaper. */
  dir: string;
  sessionId: string;
  config?: Partial<PolicyConfig>;
  now?: () => number;
}

/**
 * Credential store seam. The Electron shell can swap the file-backed
 * implementation for one built on safeStorage without changing callers.
 */
export interface Vault {
  /** Names only; never values. */
  list(): Promise<string[]>;
  get(name: string): Promise<string | undefined>;
  set(name: string, value: string): Promise<void>;
  remove(name: string): Promise<boolean>;
}

export type { Action, AuditEntry };
