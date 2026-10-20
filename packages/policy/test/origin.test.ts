import { describe, expect, it } from "vitest";
import { classify, lookupOriginPolicy, resolveOriginTier } from "../src/classify.js";
import { defaultPolicyConfig } from "../src/config.js";
import type { PolicyConfig } from "../src/types.js";
import { click, ctx } from "./helpers.js";

function config(origins: PolicyConfig["origins"], mode: PolicyConfig["mode"] = "standard"): PolicyConfig {
  const value = defaultPolicyConfig();
  value.mode = mode;
  value.origins = origins;
  return value;
}

describe("origin tier lookup", () => {
  it("matches an exact host", () => {
    expect(resolveOriginTier("https://example.com/page", config({ "example.com": { tier: "interact" } }))).toBe(
      "interact",
    );
  });

  it("matches an exact host with a port", () => {
    const cfg = config({ "127.0.0.1:4310": { tier: "interact" } });
    expect(resolveOriginTier("http://127.0.0.1:4310/login", cfg)).toBe("interact");
  });

  it("normalizes protocol-prefixed config keys", () => {
    const cfg = config({ "https://example.com": { tier: "transact" } });
    expect(resolveOriginTier("https://example.com/page", cfg)).toBe("transact");
  });

  it("matches a config key with the default port", () => {
    const cfg = config({ "example.com:443": { tier: "interact" } });
    expect(resolveOriginTier("https://example.com/page", cfg)).toBe("interact");
  });

  it("matches wildcard subdomains", () => {
    const cfg = config({ "*.example.com": { tier: "transact" } });
    expect(resolveOriginTier("https://api.example.com/v1", cfg)).toBe("transact");
    expect(resolveOriginTier("https://a.b.example.com/v1", cfg)).toBe("transact");
  });

  it("does not let a wildcard match the apex domain", () => {
    const cfg = config({ "*.example.com": { tier: "transact" } });
    expect(resolveOriginTier("https://example.com/", cfg)).toBe("read");
  });

  it("does not match unrelated suffixes", () => {
    const cfg = config({ "*.example.com": { tier: "transact" } });
    expect(resolveOriginTier("https://notexample.com/", cfg)).toBe("read");
  });

  it("prefers an exact host over a wildcard", () => {
    const cfg = config({
      "*.example.com": { tier: "read" },
      "api.example.com": { tier: "transact" },
    });
    expect(resolveOriginTier("https://api.example.com/", cfg)).toBe("transact");
    expect(resolveOriginTier("https://www.example.com/", cfg)).toBe("read");
  });

  it("defaults unknown origins by mode", () => {
    expect(resolveOriginTier("https://unknown.test/", config({}, "standard"))).toBe("read");
    expect(resolveOriginTier("https://unknown.test/", config({}, "strict"))).toBe("read");
    expect(resolveOriginTier("https://unknown.test/", config({}, "permissive"))).toBe("interact");
  });

  it("returns the full origin policy, including flags", () => {
    const cfg = config({ "example.com": { tier: "interact", allowEval: true, allowUploads: true } });
    expect(lookupOriginPolicy("https://example.com/", cfg)).toEqual({
      tier: "interact",
      allowEval: true,
      allowUploads: true,
    });
  });

  it("ignores non-http origins", () => {
    expect(lookupOriginPolicy("file:///tmp/page.html", config({}))).toBeUndefined();
  });

  it("treats unparseable URLs as unknown", () => {
    expect(resolveOriginTier("not a url", config({}, "standard"))).toBe("read");
    expect(resolveOriginTier("not a url", config({}, "permissive"))).toBe("interact");
  });

  it("applies wildcard tiers during classification", () => {
    const cfg = config({ "*.example.com": { tier: "transact" } });
    expect(classify(click(), ctx("https://api.example.com/"), cfg).verdict).toBe("allow");
    expect(classify(click(), ctx("https://example.com/"), cfg).verdict).toBe("block");
  });
});
