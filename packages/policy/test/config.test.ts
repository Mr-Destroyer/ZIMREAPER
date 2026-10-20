import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ZimReaperError } from "@zimreaper/protocol";
import {
  createPolicy,
  defaultPolicyConfig,
  loadPolicy,
  mergePolicyConfig,
} from "../src/index.js";
import { tempDir } from "./helpers.js";

describe("policy config", () => {
  it("writes defaults on first run with mode 0600", () => {
    const { dir, cleanup } = tempDir();
    try {
      const config = loadPolicy(dir);
      expect(config).toEqual(defaultPolicyConfig());
      const path = join(dir, "policy.json");
      expect(existsSync(path)).toBe(true);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(path, "utf8")).mode).toBe("standard");
    } finally {
      cleanup();
    }
  });

  it("deep-merges a partial file over defaults", () => {
    const { dir, cleanup } = tempDir();
    try {
      writeFileSync(
        join(dir, "policy.json"),
        JSON.stringify({
          mode: "strict",
          origins: {
            "example.com": { tier: "interact", allowEval: true },
            "*.test.dev": { tier: "transact" },
          },
          approvalTimeoutMs: 5_000,
        }),
      );
      const config = loadPolicy(dir);
      const defaults = defaultPolicyConfig();
      expect(config.mode).toBe("strict");
      expect(config.origins["example.com"]).toEqual({ tier: "interact", allowEval: true });
      expect(config.origins["*.test.dev"]).toEqual({ tier: "transact" });
      expect(config.approvalTimeoutMs).toBe(5_000);
      expect(config.maxActionsPerMinute).toBe(defaults.maxActionsPerMinute);
      expect(config.destructivePatterns).toEqual(defaults.destructivePatterns);
    } finally {
      cleanup();
    }
  });

  it("defaults an origin without a tier to read", () => {
    const { dir, cleanup } = tempDir();
    try {
      writeFileSync(
        join(dir, "policy.json"),
        JSON.stringify({ origins: { "example.com": { allowEval: true } } }),
      );
      expect(loadPolicy(dir).origins["example.com"]).toEqual({ tier: "read", allowEval: true });
    } finally {
      cleanup();
    }
  });

  it("rejects invalid JSON and invalid shapes", () => {
    const { dir, cleanup } = tempDir();
    try {
      const path = join(dir, "policy.json");
      writeFileSync(path, "{not json");
      expect(() => loadPolicy(dir)).toThrow(ZimReaperError);

      writeFileSync(path, JSON.stringify({ mode: "yolo" }));
      try {
        loadPolicy(dir);
        throw new Error("expected loadPolicy to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(ZimReaperError);
        expect((error as ZimReaperError).code).toBe("BAD_REQUEST");
      }
    } finally {
      cleanup();
    }
  });

  it("merges createPolicy overrides without rewriting the file", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const policy = await createPolicy({
        dir,
        sessionId: "config-1",
        config: { mode: "permissive", origins: { "example.com": { tier: "transact" } } },
      });
      expect(policy.config().mode).toBe("permissive");
      expect(policy.config().origins["example.com"]?.tier).toBe("transact");
      expect(loadPolicy(dir).mode).toBe("standard");
    } finally {
      cleanup();
    }
  });

  it("returns a defensive copy from config()", async () => {
    const { dir, cleanup } = tempDir();
    try {
      const policy = await createPolicy({ dir, sessionId: "config-2" });
      const copy = policy.config();
      copy.mode = "permissive";
      copy.origins["example.com"] = { tier: "transact" };
      expect(policy.config().mode).toBe("standard");
      expect(policy.config().origins["example.com"]).toBeUndefined();
    } finally {
      cleanup();
    }
  });

  it("merges origin flags field by field", () => {
    const base = defaultPolicyConfig();
    base.origins["example.com"] = { tier: "read", allowEval: false };
    const merged = mergePolicyConfig(base, { origins: { "example.com": { tier: "interact" } } });
    expect(merged.origins["example.com"]).toEqual({ tier: "interact", allowEval: false });
  });

  it("requires a dir and sessionId", async () => {
    await expect(createPolicy({ dir: "", sessionId: "x" })).rejects.toBeInstanceOf(ZimReaperError);
    await expect(createPolicy({ dir: "/tmp/zim-policy-test", sessionId: "" })).rejects.toBeInstanceOf(
      ZimReaperError,
    );
  });
});
