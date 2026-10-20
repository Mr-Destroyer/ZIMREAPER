import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { auditDate, createPolicy, hashArgs } from "../src/index.js";
import { tempDir } from "./helpers.js";

const DAY = 24 * 60 * 60 * 1000;

describe("audit chain", () => {
  it("verifies a 50-entry chain and tails the newest entries", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const base = Date.UTC(2026, 0, 15, 12, 0, 0);
      const policy = await createPolicy({ dir, sessionId: "audit-1", now: () => base });
      for (let i = 1; i <= 50; i += 1) {
        policy.record({
          ts: base + i * 1_000,
          actor: "agent",
          sessionId: "audit-1",
          kind: "mouse.click",
          argsHash: hashArgs({ i }),
          outcome: "ok",
          detail: `entry-${i}`,
        });
      }

      expect(policy.verifyChain()).toEqual({ ok: true, entries: 50 });
      expect(policy.tail(5).map((entry) => entry.seq)).toEqual([46, 47, 48, 49, 50]);

      const file = join(dir, "audit", `${auditDate(base)}.jsonl`);
      expect(existsSync(file)).toBe(true);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const lines = readFileSync(file, "utf8").trim().split("\n");
      expect(lines).toHaveLength(50);
      const first = JSON.parse(lines[0]) as { seq: number; prevHash: string };
      const last = JSON.parse(lines[49]) as { seq: number };
      expect(first.seq).toBe(1);
      expect(first.prevHash).toBe("0");
      expect(last.seq).toBe(50);
    } finally {
      cleanup();
    }
  });

  it("detects a one-byte tamper", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const base = Date.UTC(2026, 0, 15, 12, 0, 0);
      const policy = await createPolicy({ dir, sessionId: "audit-2", now: () => base });
      for (let i = 1; i <= 50; i += 1) {
        policy.record({
          ts: base + i * 1_000,
          actor: "agent",
          sessionId: "audit-2",
          kind: "mouse.click",
          argsHash: hashArgs({ i }),
          outcome: "ok",
          detail: `entry-${i}`,
        });
      }
      const file = join(dir, "audit", `${auditDate(base)}.jsonl`);
      const original = readFileSync(file, "utf8");
      const tampered = original.replace('"detail":"entry-25"', '"detail":"entry-26"');
      expect(tampered).not.toBe(original);
      writeFileSync(file, tampered);

      const result = policy.verifyChain();
      expect(result.ok).toBe(false);
      expect(result.brokenAt).toBe(25);
    } finally {
      cleanup();
    }
  });

  it("resets seq and prevHash for a new daily file", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const dayOne = Date.UTC(2026, 0, 15, 12, 0, 0);
      const dayTwo = dayOne + DAY;
      const policy = await createPolicy({ dir, sessionId: "audit-3", now: () => dayOne });
      const entry = (ts: number, detail: string) =>
        policy.record({
          ts,
          actor: "agent",
          sessionId: "audit-3",
          kind: "page.wait",
          argsHash: hashArgs({ detail }),
          outcome: "allow",
          detail,
        });

      const first = entry(dayOne, "day-one");
      const second = entry(dayTwo, "day-two");
      const third = entry(dayTwo + 1_000, "day-two-b");

      expect(first.seq).toBe(1);
      expect(first.prevHash).toBe("0");
      expect(second.seq).toBe(1);
      expect(second.prevHash).toBe("0");
      expect(third.seq).toBe(2);
      expect(third.prevHash).toBe(second.hash);
      expect(policy.verifyChain()).toEqual({ ok: true, entries: 3 });
      expect(policy.tail(1)[0]?.detail).toBe("day-two-b");
    } finally {
      cleanup();
    }
  });

  it("handles an empty log", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const policy = await createPolicy({ dir, sessionId: "audit-4" });
      expect(policy.verifyChain()).toEqual({ ok: true, entries: 0 });
      expect(policy.tail(10)).toEqual([]);
    } finally {
      cleanup();
    }
  });

  it("hashes args order-independently", () => {
    expect(hashArgs({ b: 1, a: 2 })).toBe(hashArgs({ a: 2, b: 1 }));
    expect(hashArgs({ a: 1 })).not.toBe(hashArgs({ a: 2 }));
    expect(hashArgs({ a: undefined, b: 1 })).toBe(hashArgs({ b: 1 }));
  });
});
