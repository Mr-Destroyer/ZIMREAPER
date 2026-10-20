import type { ApprovalMeta, ApprovalRequest, PolicyDecision } from "./types.js";

interface PendingApproval {
  request: ApprovalRequest;
  finish: (approved: boolean) => void;
}

/**
 * In-process approval broker. The HUD subscribes with `on`, the control server
 * resolves with `resolveApproval`. Timeouts deny by default.
 */
export class ApprovalBroker {
  private sequence = 0;
  private readonly pending = new Map<string, PendingApproval>();
  private readonly listeners = new Set<(request: ApprovalRequest) => void>();

  constructor(
    private readonly defaultTimeoutMs: number,
    private readonly now: () => number,
  ) {}

  request(decision: PolicyDecision, meta: ApprovalMeta = {}): Promise<boolean> {
    if (decision.verdict === "allow") return Promise.resolve(true);
    if (decision.verdict === "block") return Promise.resolve(false);

    const id =
      decision.approvalId !== undefined && !this.pending.has(decision.approvalId)
        ? decision.approvalId
        : `ap-${++this.sequence}`;
    decision.approvalId = id;
    const timeoutMs = Math.max(1, meta.timeoutMs ?? this.defaultTimeoutMs);
    const request: ApprovalRequest = {
      id,
      requestedAt: this.now(),
      actionKind: meta.actionKind ?? "unknown",
      reason: decision.reason,
      timeoutMs,
      ...(meta.tabId !== undefined ? { tabId: meta.tabId } : {}),
      ...(meta.screenshotPath !== undefined ? { screenshotPath: meta.screenshotPath } : {}),
      ...(meta.argsHash !== undefined ? { argsHash: meta.argsHash } : {}),
    };

    return new Promise<boolean>((resolve) => {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let settled = false;
      const finish = (approved: boolean): void => {
        if (settled) return;
        settled = true;
        if (timer !== undefined) clearTimeout(timer);
        this.pending.delete(id);
        resolve(approved);
      };

      timer = setTimeout(() => finish(false), timeoutMs);
      this.pending.set(id, { request, finish });

      for (const listener of [...this.listeners]) {
        try {
          listener(request);
        } catch {
          // A broken HUD subscriber must not strand the approval.
        }
      }
    });
  }

  resolve(id: string, approved: boolean): boolean {
    const pending = this.pending.get(id);
    if (!pending) return false;
    pending.finish(approved);
    return true;
  }

  on(cb: (request: ApprovalRequest) => void): () => void {
    this.listeners.add(cb);
    return () => {
      this.listeners.delete(cb);
    };
  }
}
