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

describe("provider HTTP mapping", () => {
  it("posts an OpenAI chat completion with tools and maps HTTP failures", async () => {
    const originalFetch = globalThis.fetch;
    const saved = { base: process.env.OPENAI_BASE_URL, key: process.env.OPENAI_API_KEY };
    delete process.env.OPENAI_BASE_URL;
    delete process.env.OPENAI_API_KEY;
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      if (calls.length === 1) {
        return new Response(JSON.stringify({ choices: [{ message: { content: "done" }, finish_reason: "stop" }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: { message: "bad key sk-secret123456" } }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const provider = createProvider({ kind: "openai", model: "gpt-test", apiKey: "test-key" });
      const ok = await provider.complete({
        system: "system",
        messages: [{ role: "user", content: "hi" }],
        tools: [{ name: "t", description: "d", inputSchema: { type: "object" } }],
      });
      expect(ok.text).toBe("done");
      const first = calls[0];
      expect(first?.url).toBe("https://api.openai.com/v1/chat/completions");
      const headers = first?.init?.headers as Record<string, string>;
      expect(headers.authorization).toBe("Bearer test-key");
      const body = JSON.parse(String(first?.init?.body)) as {
        messages: Array<{ role: string }>;
        tools: Array<{ function: { name: string } }>;
        stream: boolean;
      };
      expect(body.messages[0]?.role).toBe("system");
      expect(body.tools[0]?.function.name).toBe("t");
      expect(body.stream).toBe(false);

      await expect(
        provider.complete({ system: "s", messages: [], tools: [] }),
      ).rejects.toMatchObject({ code: "BACKEND_ERROR" });
      await expect(
        provider.complete({ system: "s", messages: [], tools: [] }),
      ).rejects.not.toThrow(/sk-secret123456/);
    } finally {
      globalThis.fetch = originalFetch;
      if (saved.base !== undefined) process.env.OPENAI_BASE_URL = saved.base;
      if (saved.key !== undefined) process.env.OPENAI_API_KEY = saved.key;
    }
  });

  it("posts Anthropic messages with tool_result blocks and the API version header", async () => {
    const originalFetch = globalThis.fetch;
    const saved = { base: process.env.ANTHROPIC_BASE_URL, key: process.env.ANTHROPIC_API_KEY };
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_API_KEY;
    let captured: { url: string; init?: RequestInit } | undefined;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      captured = { url: String(input), init };
      return new Response(JSON.stringify({ content: [{ type: "text", text: "ok" }], stop_reason: "end_turn" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const provider = createProvider({ kind: "anthropic", model: "claude-test", apiKey: "a-key" });
      await provider.complete({
        system: "system",
        messages: [
          { role: "user", content: "do" },
          { role: "assistant", content: "", toolCalls: [{ id: "tu1", name: "snap", args: {} }] },
          { role: "tool", toolCallId: "tu1", toolOk: false, content: "BAD_REQUEST: nope" },
        ],
        tools: [{ name: "snap", description: "d", inputSchema: { type: "object" } }],
      });
      expect(captured?.url).toBe("https://api.anthropic.com/v1/messages");
      const headers = captured?.init?.headers as Record<string, string>;
      expect(headers["x-api-key"]).toBe("a-key");
      expect(headers["anthropic-version"]).toBe("2023-06-01");
      const body = JSON.parse(String(captured?.init?.body)) as {
        system: string;
        tools: Array<{ input_schema: unknown }>;
        messages: Array<{ role: string; content: unknown }>;
      };
      expect(body.system).toBe("system");
      expect(body.tools[0]?.input_schema).toEqual({ type: "object" });
      const toolResult = body.messages[2]?.content as Array<{ type: string; is_error: boolean }>;
      expect(toolResult[0]).toMatchObject({ type: "tool_result", is_error: true });
    } finally {
      globalThis.fetch = originalFetch;
      if (saved.base !== undefined) process.env.ANTHROPIC_BASE_URL = saved.base;
      if (saved.key !== undefined) process.env.ANTHROPIC_API_KEY = saved.key;
    }
  });
});

describe("custom provider env", () => {
  it("uses the custom model env in the request body", async () => {
    const originalFetch = globalThis.fetch;
    const saved = {
      base: process.env.ZIMREAPER_PROVIDER_ENVTEST_BASE_URL,
      key: process.env.ZIMREAPER_PROVIDER_ENVTEST_API_KEY,
      model: process.env.ZIMREAPER_PROVIDER_ENVTEST_MODEL,
    };
    process.env.ZIMREAPER_PROVIDER_ENVTEST_BASE_URL = "http://127.0.0.1:9/v1";
    process.env.ZIMREAPER_PROVIDER_ENVTEST_API_KEY = "custom-key";
    process.env.ZIMREAPER_PROVIDER_ENVTEST_MODEL = "custom-model";
    let body: { model?: string } | undefined;
    globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
      body = JSON.parse(String(init?.body)) as { model?: string };
      return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    try {
      const provider = createProvider({ kind: "custom:envtest", model: "" });
      await provider.complete({ system: "s", messages: [{ role: "user", content: "hi" }], tools: [] });
      expect(body?.model).toBe("custom-model");
    } finally {
      globalThis.fetch = originalFetch;
      for (const [key, value] of Object.entries({
        ZIMREAPER_PROVIDER_ENVTEST_BASE_URL: saved.base,
        ZIMREAPER_PROVIDER_ENVTEST_API_KEY: saved.key,
        ZIMREAPER_PROVIDER_ENVTEST_MODEL: saved.model,
      })) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
  });
});
