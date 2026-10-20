import { describe, expect, it } from "vitest";
import { createPolicy } from "../src/index.js";
import type { ApprovalRequest } from "../src/types.js";
import { tempDir } from "./helpers.js";

describe("approval broker", () => {
  it("denies on timeout", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const policy = await createPolicy({ dir, sessionId: "approval-1", config: { approvalTimeoutMs: 15 } });
      const decision = { verdict: "confirm" as const, reason: "needs a human" };
      const approved = await policy.requestApproval(decision, { timeoutMs: 15 });
      expect(approved).toBe(false);
      expect(decision.approvalId).toBeDefined();
    } finally {
      cleanup();
    }
  });

  it("uses the configured timeout when no override is given", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const policy = await createPolicy({ dir, sessionId: "approval-2", config: { approvalTimeoutMs: 10 } });
      await expect(policy.requestApproval({ verdict: "confirm", reason: "slow human" })).resolves.toBe(false);
    } finally {
      cleanup();
    }
  });

  it("resolves an approval through the broker", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const policy = await createPolicy({ dir, sessionId: "approval-3" });
      const seen: ApprovalRequest[] = [];
      const off = policy.onApprovalRequest((request) => seen.push(request));
      const pending = policy.requestApproval(
        { verdict: "confirm", reason: "delete account" },
        { actionKind: "mouse.click", tabId: "t1", argsHash: "hash-1", timeoutMs: 5_000 },
      );

      expect(seen).toHaveLength(1);
      expect(seen[0]).toMatchObject({
        actionKind: "mouse.click",
        tabId: "t1",
        argsHash: "hash-1",
        reason: "delete account",
      });
      expect(policy.resolveApproval(seen[0].id, true)).toBe(true);
      await expect(pending).resolves.toBe(true);
      expect(policy.resolveApproval(seen[0].id, true)).toBe(false);
      off();
    } finally {
      cleanup();
    }
  });

  it("resolves a denial", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const policy = await createPolicy({ dir, sessionId: "approval-4" });
      let id = "";
      policy.onApprovalRequest((request) => {
        id = request.id;
      });
      const pending = policy.requestApproval({ verdict: "confirm", reason: "no" }, { timeoutMs: 5_000 });
      expect(policy.resolveApproval(id, false)).toBe(true);
      await expect(pending).resolves.toBe(false);
    } finally {
      cleanup();
    }
  });

  it("returns immediately for allow and block decisions", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const policy = await createPolicy({ dir, sessionId: "approval-5" });
      await expect(policy.requestApproval({ verdict: "allow", reason: "ok" })).resolves.toBe(true);
      await expect(policy.requestApproval({ verdict: "block", reason: "no" })).resolves.toBe(false);
    } finally {
      cleanup();
    }
  });

  it("survives a throwing subscriber", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const policy = await createPolicy({ dir, sessionId: "approval-6" });
      let seen = false;
      policy.onApprovalRequest(() => {
        throw new Error("hud exploded");
      });
      policy.onApprovalRequest(() => {
        seen = true;
      });
      const pending = policy.requestApproval({ verdict: "confirm", reason: "x" }, { timeoutMs: 20 });
      expect(seen).toBe(true);
      await expect(pending).resolves.toBe(false);
    } finally {
      cleanup();
    }
  });

  it("unsubscribes listeners", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const policy = await createPolicy({ dir, sessionId: "approval-7" });
      let seen = 0;
      const off = policy.onApprovalRequest(() => {
        seen += 1;
      });
      off();
      await policy.requestApproval({ verdict: "confirm", reason: "x" }, { timeoutMs: 10 });
      expect(seen).toBe(0);
    } finally {
      cleanup();
    }
  });
});
