import { describe, expect, it } from "vitest";
import { parseArgs, providerSpec } from "../src/commands.js";

describe("CLI argument parsing", () => {
  it("parses commands, positional task text, and flags", () => {
    const parsed = parseArgs([
      "run",
      "click the button",
      "--url=https://example.com",
      "--max-steps",
      "5",
      "--provider",
      "anthropic",
    ]);
    expect(parsed.positional).toEqual(["run", "click the button"]);
    expect(parsed.flags.get("url")).toBe("https://example.com");
    expect(parsed.flags.get("max-steps")).toBe("5");
    expect(parsed.flags.get("provider")).toBe("anthropic");
  });

  it("rejects a value flag with no value", () => {
    expect(() => parseArgs(["run", "x", "--max-steps"])).toThrowError(/requires a value/);
  });

  it("leaves the model empty for custom providers so the env model is used", () => {
    const spec = providerSpec(new Map([["provider", "custom:local"]]));
    expect(spec).toEqual({ kind: "custom:local", model: "" });
  });

  it("uses provider-specific default models", () => {
    expect(providerSpec(new Map([["provider", "anthropic"]])).model).toContain("claude");
    expect(providerSpec(new Map()).model).toBe("gpt-4.1-mini");
  });
});
