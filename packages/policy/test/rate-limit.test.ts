import { describe, expect, it } from "vitest";
import { createPolicy } from "../src/index.js";
import { classify } from "../src/classify.js";
import { configFor, ctx, pageScreenshot, sessionKill, tempDir } from "./helpers.js";

describe("rate limiting", () => {
  it("blocks when the rolling window is full", () => {
    const config = configFor("example.com", "interact");
    config.maxActionsPerMinute = 3;
    const now = 1_000_000;
    const decision = classify(pageScreenshot(), ctx("https://example.com/"), config, {
      now,
      recentActions: [now - 1_000, now - 2_000, now - 3_000],
    });
    expect(decision.verdict).toBe("block");
    expect(decision.reason).toContain("rate limit");
  });

  it("allows below the limit", () => {
    const config = configFor("example.com", "interact");
    config.maxActionsPerMinute = 3;
    const now = 1_000_000;
    const decision = classify(pageScreenshot(), ctx("https://example.com/"), config, {
      now,
      recentActions: [now - 1_000, now - 2_000],
    });
    expect(decision.verdict).toBe("allow");
  });

  it("ignores timestamps older than 60 seconds", () => {
    const config = configFor("example.com", "interact");
    config.maxActionsPerMinute = 2;
    const now = 1_000_000;
    const decision = classify(pageScreenshot(), ctx("https://example.com/"), config, {
      now,
      recentActions: [now - 61_000, now - 62_000, now - 1_000],
    });
    expect(decision.verdict).toBe("allow");
  });

  it("counts preflight attempts in the engine", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const policy = await createPolicy({
        dir,
        sessionId: "rate-1",
        config: { maxActionsPerMinute: 2, origins: { "example.com": { tier: "interact" } } },
      });
      const context = ctx("https://example.com/");
      expect(policy.preflight(pageScreenshot(), context).verdict).toBe("allow");
      expect(policy.preflight(pageScreenshot(), context).verdict).toBe("allow");
      const third = policy.preflight(pageScreenshot(), context);
      expect(third.verdict).toBe("block");
      expect(third.reason).toContain("rate limit");
    } finally {
      cleanup();
    }
  });

  it("does not count always-allowed actions", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const policy = await createPolicy({
        dir,
        sessionId: "rate-2",
        config: { maxActionsPerMinute: 1, origins: { "example.com": { tier: "interact" } } },
      });
      const context = ctx("https://example.com/");
      for (let i = 0; i < 5; i += 1) {
        expect(policy.preflight(sessionKill(), context).verdict).toBe("allow");
      }
      expect(policy.preflight(pageScreenshot(), context).verdict).toBe("allow");
      expect(policy.preflight(pageScreenshot(), context).verdict).toBe("block");
    } finally {
      cleanup();
    }
  });

  it("rolls the window forward with the injected clock", async () => {
    const { dir, cleanup } = tempDir();
    try {
      let now = 1_000_000;
      const policy = await createPolicy({
        dir,
        sessionId: "rate-3",
        now: () => now,
        config: { maxActionsPerMinute: 2, origins: { "example.com": { tier: "interact" } } },
      });
      const context = ctx("https://example.com/");
      expect(policy.preflight(pageScreenshot(), context).verdict).toBe("allow");
      expect(policy.preflight(pageScreenshot(), context).verdict).toBe("allow");
      expect(policy.preflight(pageScreenshot(), context).verdict).toBe("block");
      now += 61_000;
      expect(policy.preflight(pageScreenshot(), context).verdict).toBe("allow");
    } finally {
      cleanup();
    }
  });
});
