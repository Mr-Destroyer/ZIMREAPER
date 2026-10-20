/**
 * Policy: origin trust tiers, action classification, human approval, hash-chained audit.
 * Deterministic and side-effect free except for the append-only audit log.
 *
 * Control-server integration:
 *
 *   const policy = await createPolicy({ dir: zimReaperHome(), sessionId });
 *   policy.onApprovalRequest((request) => hud.emit("approval.requested", request));
 *   const decision = policy.preflight(action, { url, actor, tainted });
 *   if (decision.verdict === "confirm") {
 *     const approved = await policy.requestApproval(decision, { actionKind: action.kind, argsHash });
 *     if (!approved) throw new ZimReaperError("NEEDS_HUMAN", "approval denied or timed out");
 *   }
 *   policy.record({ ts, actor, sessionId, kind: action.kind, argsHash, outcome: "ok" });
 *
 * `record` accepts only `argsHash`; callers must hash args with `hashArgs` and must
 * never pass raw action arguments. `verifyChain()` re-reads every daily file.
 */
import { ZimReaperError } from "@zimreaper/protocol";
import type { Action, AuditEntry } from "@zimreaper/protocol";
import { ApprovalBroker } from "./approvals.js";
import { AuditLog } from "./audit.js";
import { classify, isAlwaysAllowed } from "./classify.js";
import { clonePolicyConfig, loadPolicy, mergePolicyConfig } from "./config.js";
import type {
  ApprovalRequest,
  AuditRecordInput,
  PolicyConfig,
  PolicyContext,
  PolicyDecision,
  PolicyEngine,
  PolicyOptions,
} from "./types.js";

export * from "./types.js";
export { defaultPolicyConfig, loadPolicy, mergePolicyConfig, clonePolicyConfig } from "./config.js";
export {
  classify,
  classifyQuery,
  resolveOriginTier,
  resolveOriginPolicy,
  defaultOriginPolicy,
  lookupOriginPolicy,
  isAlwaysAllowed,
} from "./classify.js";
export { AuditLog, auditDate, hashArgs } from "./audit.js";
export { ApprovalBroker } from "./approvals.js";
export { createFileVault } from "./vault.js";
export type { FileVaultOptions } from "./vault.js";

export async function createPolicy(opts: PolicyOptions): Promise<PolicyEngine> {
  if (!opts.dir) throw new ZimReaperError("BAD_REQUEST", "policy dir is required");
  if (!opts.sessionId) throw new ZimReaperError("BAD_REQUEST", "sessionId is required");

  const loaded = loadPolicy(opts.dir);
  const config: PolicyConfig = mergePolicyConfig(loaded, opts.config);
  const now = opts.now ?? Date.now;
  const audit = new AuditLog(opts.dir, opts.sessionId, now);
  const approvals = new ApprovalBroker(config.approvalTimeoutMs, now);
  let recent: number[] = [];

  return {
    preflight(action: Action, ctx: PolicyContext): PolicyDecision {
      const at = now();
      recent = recent.filter((ts) => at - ts < 60_000);
      const decision = classify(action, ctx, config, { now: at, recentActions: recent });
      if (!isAlwaysAllowed(action.kind)) recent.push(at);
      return decision;
    },

    record(entry: AuditRecordInput): AuditEntry {
      return audit.record(entry);
    },

    tail(limit: number): AuditEntry[] {
      return audit.tail(limit);
    },

    verifyChain(): { ok: boolean; brokenAt?: number; entries: number } {
      return audit.verifyChain();
    },

    config(): PolicyConfig {
      return clonePolicyConfig(config);
    },

    requestApproval(decision: PolicyDecision, meta = {}): Promise<boolean> {
      return approvals.request(decision, meta);
    },

    resolveApproval(id: string, approved: boolean): boolean {
      return approvals.resolve(id, approved);
    },

    onApprovalRequest(cb: (request: ApprovalRequest) => void): () => void {
      return approvals.on(cb);
    },
  };
}
