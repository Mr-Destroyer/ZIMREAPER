import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createProvider,
  parseAnthropicResponse,
  parseOpenAiResponse,
  parseSseEvents,
} from "../src/index.js";

const fixture = (name: string): Promise<string> =>
  readFile(fileURLToPath(new URL(`./fixtures/${name}`, import.meta.url)), "utf8");

describe("provider response parsing", () => {
  it("parses a recorded OpenAI chat completion and maps tool calls", async () => {
    const parsed = parseOpenAiResponse(await fixture("openai-chat.json"), "application/json");
    expect(parsed.text).toBe("Opening the page.");
    expect(parsed.stopReason).toBe("tool_use");
    expect(parsed.toolCalls).toEqual([
      { id: "call_1", name: "browser_navigate", args: { url: "https://example.com" } },
    ]);
    expect(parsed.usage).toEqual({ inputTokens: 120, outputTokens: 18 });
  });

  it("parses a recorded OpenAI SSE stream including split tool arguments", async () => {
    const parsed = parseOpenAiResponse(await fixture("openai-stream.sse"), "text/event-stream");
    expect(parsed.text).toBe("Opening the page.");
    expect(parsed.stopReason).toBe("tool_use");
    expect(parsed.toolCalls).toEqual([
      { id: "call_1", name: "browser_navigate", args: { url: "https://example.com" } },
    ]);
    expect(parsed.usage).toEqual({ inputTokens: 120, outputTokens: 18 });
  });

  it("parses a recorded Anthropic Messages response", async () => {
    const parsed = parseAnthropicResponse(await fixture("anthropic-messages.json"), "application/json");
    expect(parsed.text).toBe("I will snapshot the page.");
    expect(parsed.stopReason).toBe("tool_use");
    expect(parsed.toolCalls).toEqual([
      { id: "toolu_1", name: "browser_snapshot", args: { maxChars: 8000 } },
    ]);
    expect(parsed.usage).toEqual({ inputTokens: 90, outputTokens: 24 });
  });

  it("parses a recorded Anthropic SSE stream", async () => {
    const parsed = parseAnthropicResponse(await fixture("anthropic-stream.sse"), "text/event-stream");
    expect(parsed.text).toBe("I will snapshot the page.");
    expect(parsed.toolCalls).toEqual([
      { id: "toolu_1", name: "browser_snapshot", args: { maxChars: 8000 } },
    ]);
    expect(parsed.usage).toEqual({ inputTokens: 90, outputTokens: 24 });
  });

  it("ignores SSE comments and joins multi-line data", () => {
    const events = parseSseEvents(": ping\n\nevent: x\ndata: one\ndata: two\n\n");
    expect(events).toEqual([{ event: "x", data: "one\ntwo" }]);
  });
});

describe("createProvider", () => {
  it("reads custom provider settings from ZIMREAPER_PROVIDER_<NAME>_*", () => {
    process.env.ZIMREAPER_PROVIDER_LOCAL_BASE_URL = "http://127.0.0.1:9999/v1";
    process.env.ZIMREAPER_PROVIDER_LOCAL_API_KEY = "test-key";
    process.env.ZIMREAPER_PROVIDER_LOCAL_MODEL = "local-model";
    try {
      const provider = createProvider({ kind: "custom:local", model: "" });
      expect(provider.name).toBe("custom:local");
      expect(provider.model).toBe("local-model");
    } finally {
      delete process.env.ZIMREAPER_PROVIDER_LOCAL_BASE_URL;
      delete process.env.ZIMREAPER_PROVIDER_LOCAL_API_KEY;
      delete process.env.ZIMREAPER_PROVIDER_LOCAL_MODEL;
    }
  });

  it("rejects unknown provider kinds", () => {
    expect(() => createProvider({ kind: "mystery", model: "m" })).toThrowError(/unknown provider/);
  });
});
