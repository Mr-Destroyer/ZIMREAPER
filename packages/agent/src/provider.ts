import { ZimReaperError } from "@zimreaper/protocol";
import type {
  ChatMessage,
  CompletionRequest,
  CompletionResponse,
  Provider,
  ProviderConfig,
  ToolCall,
} from "./types.js";

const DEFAULT_OPENAI_BASE = "https://api.openai.com/v1";
const DEFAULT_ANTHROPIC_BASE = "https://api.anthropic.com";
const ANTHROPIC_VERSION = "2023-06-01";

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function numberField(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value.length > 0 ? value : undefined;
}

function requireValue(value: string | undefined, what: string): string {
  if (value === undefined || value.trim().length === 0) {
    throw new ZimReaperError("BAD_REQUEST", `missing ${what}`);
  }
  return value;
}

function trimBase(url: string): string {
  return url.replace(/\/+$/, "");
}

function customEnvPrefix(name: string): string {
  const normalized = name.toUpperCase().replace(/[^A-Z0-9]/g, "_");
  if (normalized.length === 0) {
    throw new ZimReaperError("BAD_REQUEST", "custom provider requires a name: custom:<name>");
  }
  return `ZIMREAPER_PROVIDER_${normalized}`;
}

/** Redacts credentials from any message that might be echoed by a backend. */
function safeMessage(value: string): string {
  return value.replace(/(sk-[A-Za-z0-9_-]{6,})/g, "[redacted]").slice(0, 500);
}

async function httpError(res: Response): Promise<ZimReaperError> {
  let detail = "";
  try {
    const text = await res.text();
    try {
      const parsed: unknown = JSON.parse(text);
      if (isRecord(parsed) && isRecord(parsed.error)) {
        detail = stringField(parsed.error.message) ?? "";
      } else if (isRecord(parsed)) {
        detail = stringField(parsed.message) ?? "";
      }
    } catch {
      detail = text;
    }
  } catch {
    detail = "";
  }
  const suffix = detail ? `: ${safeMessage(detail)}` : "";
  return new ZimReaperError("BACKEND_ERROR", `provider HTTP ${res.status}${suffix}`);
}

async function providerFetch(
  url: string,
  init: RequestInit,
  signal: AbortSignal | undefined,
): Promise<Response> {
  try {
    const res = await fetch(url, { ...init, signal });
    if (!res.ok) throw await httpError(res);
    return res;
  } catch (err) {
    if (err instanceof ZimReaperError) throw err;
    if (signal?.aborted || (err instanceof Error && err.name === "AbortError")) {
      throw new ZimReaperError("CANCELLED", "provider request aborted");
    }
    const message = err instanceof Error ? err.message : String(err);
    throw new ZimReaperError("BACKEND_ERROR", `provider request failed: ${safeMessage(message)}`);
  }
}

async function readText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ZimReaperError("BACKEND_ERROR", `failed reading provider response: ${safeMessage(message)}`);
  }
}

function parseJsonObject(text: string): JsonRecord {
  try {
    const parsed: unknown = JSON.parse(text);
    if (!isRecord(parsed)) {
      throw new ZimReaperError("BACKEND_ERROR", "provider returned a non-object JSON response");
    }
    return parsed;
  } catch (err) {
    if (err instanceof ZimReaperError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new ZimReaperError("BACKEND_ERROR", `invalid provider JSON: ${safeMessage(message)}`);
  }
}

export interface SseEvent {
  event?: string;
  data: string;
}

/** Parses a Server-Sent Events body without assuming an SDK or streaming implementation. */
export function parseSseEvents(body: string): SseEvent[] {
  const normalized = body.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const events: SseEvent[] = [];
  for (const block of normalized.split("\n\n")) {
    if (block.trim().length === 0) continue;
    let eventName: string | undefined;
    const dataLines: string[] = [];
    for (const line of block.split("\n")) {
      if (line.startsWith("event:")) eventName = line.slice(6).trim();
      else if (line.startsWith("data:")) dataLines.push(line.slice(5).trimStart());
    }
    if (dataLines.length > 0) {
      events.push({ ...(eventName ? { event: eventName } : {}), data: dataLines.join("\n") });
    }
  }
  return events;
}

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    const parts: string[] = [];
    for (const part of content) {
      if (typeof part === "string") parts.push(part);
      else if (isRecord(part)) {
        const text = stringField(part.text) ?? stringField(part.content);
        if (text !== undefined) parts.push(text);
      }
    }
    return parts.join("");
  }
  return "";
}

function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (isRecord(raw)) return raw;
  if (typeof raw !== "string" || raw.trim().length === 0) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function mapToolCalls(value: unknown): ToolCall[] {
  if (!Array.isArray(value)) return [];
  const calls: ToolCall[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const item = value[index];
    if (!isRecord(item)) continue;
    const fn = isRecord(item.function) ? item.function : item;
    const name = stringField(fn.name);
    if (!name) continue;
    calls.push({
      id: stringField(item.id) ?? `tool_${index}_${calls.length}`,
      name,
      args: parseToolArguments(fn.arguments ?? fn.input),
    });
  }
  return calls;
}

function openAiMessages(messages: ChatMessage[]): JsonRecord[] {
  const out: JsonRecord[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      out.push({
        role: "tool",
        tool_call_id: message.toolCallId ?? "",
        content: message.content,
      });
      continue;
    }
    if (message.role === "assistant" && message.toolCalls && message.toolCalls.length > 0) {
      out.push({
        role: "assistant",
        content: message.content.length > 0 ? message.content : null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: "function",
          function: { name: call.name, arguments: JSON.stringify(call.args) },
        })),
      });
      continue;
    }
    out.push({ role: message.role, content: message.content });
  }
  return out;
}

function openAiTools(tools: CompletionRequest["tools"]): JsonRecord[] {
  return tools.map((tool) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.inputSchema,
    },
  }));
}

/** Parses a recorded/complete OpenAI chat completion (JSON or SSE). */
export function parseOpenAiResponse(body: string, contentType = ""): CompletionResponse {
  if (contentType.includes("text/event-stream") || body.trimStart().startsWith("data:")) {
    return parseOpenAiSse(body);
  }
  const root = parseJsonObject(body);
  const choices = Array.isArray(root.choices) ? root.choices : [];
  const first: unknown = choices[0];
  const choice = isRecord(first) ? first : {};
  const message = isRecord(choice.message) ? choice.message : {};
  const toolCalls = mapToolCalls(message.tool_calls);
  const text = contentToText(message.content);
  const finish = stringField(choice.finish_reason);
  const usage = isRecord(root.usage) ? root.usage : undefined;
  return {
    text,
    toolCalls,
    stopReason:
      toolCalls.length > 0 || finish === "tool_calls"
        ? "tool_use"
        : finish === "length"
          ? "length"
          : "end",
    ...(usage
      ? {
          usage: {
            inputTokens: numberField(usage.prompt_tokens) ?? 0,
            outputTokens: numberField(usage.completion_tokens) ?? 0,
          },
        }
      : {}),
  };
}

interface OpenAiSseState {
  text: string;
  calls: Map<number, { id: string; name: string; arguments: string }>;
  finish?: string;
  inputTokens: number;
  outputTokens: number;
}

function parseOpenAiSse(body: string): CompletionResponse {
  const state: OpenAiSseState = { text: "", calls: new Map(), inputTokens: 0, outputTokens: 0 };
  for (const event of parseSseEvents(body)) {
    if (event.data === "[DONE]") break;
    let chunk: JsonRecord;
    try {
      const parsed: unknown = JSON.parse(event.data);
      if (!isRecord(parsed)) continue;
      chunk = parsed;
    } catch {
      continue;
    }
    const usage = isRecord(chunk.usage) ? chunk.usage : undefined;
    if (usage) {
      state.inputTokens = numberField(usage.prompt_tokens) ?? state.inputTokens;
      state.outputTokens = numberField(usage.completion_tokens) ?? state.outputTokens;
    }
    const choices = Array.isArray(chunk.choices) ? chunk.choices : [];
    for (const rawChoice of choices) {
      if (!isRecord(rawChoice)) continue;
      const delta = isRecord(rawChoice.delta) ? rawChoice.delta : {};
      state.text += contentToText(delta.content);
      const finish = stringField(rawChoice.finish_reason);
      if (finish) state.finish = finish;
      const deltas = Array.isArray(delta.tool_calls) ? delta.tool_calls : [];
      for (const rawCall of deltas) {
        if (!isRecord(rawCall)) continue;
        const index = numberField(rawCall.index) ?? 0;
        const existing = state.calls.get(index) ?? { id: "", name: "", arguments: "" };
        const fn = isRecord(rawCall.function) ? rawCall.function : {};
        existing.id = stringField(rawCall.id) ?? existing.id;
        existing.name = stringField(fn.name) ?? existing.name;
        const argsDelta = stringField(fn.arguments);
        if (argsDelta !== undefined) existing.arguments += argsDelta;
        state.calls.set(index, existing);
      }
    }
  }
  const toolCalls: ToolCall[] = [...state.calls.entries()]
    .sort(([a], [b]) => a - b)
    .filter(([, call]) => call.name.length > 0)
    .map(([index, call]) => ({
      id: call.id || `tool_${index}`,
      name: call.name,
      args: parseToolArguments(call.arguments),
    }));
  return {
    text: state.text,
    toolCalls,
    stopReason:
      toolCalls.length > 0 || state.finish === "tool_calls"
        ? "tool_use"
        : state.finish === "length"
          ? "length"
          : "end",
    ...(state.inputTokens > 0 || state.outputTokens > 0
      ? { usage: { inputTokens: state.inputTokens, outputTokens: state.outputTokens } }
      : {}),
  };
}

function anthropicMessages(messages: ChatMessage[]): JsonRecord[] {
  const out: JsonRecord[] = [];
  let index = 0;
  while (index < messages.length) {
    const message = messages[index];
    if (!message) break;
    if (message.role === "tool") {
      const blocks: JsonRecord[] = [];
      while (index < messages.length) {
        const current = messages[index];
        if (!current || current.role !== "tool") break;
        blocks.push({
          type: "tool_result",
          tool_use_id: current.toolCallId ?? "",
          content: current.content,
          is_error: current.toolOk === false,
        });
        index += 1;
      }
      out.push({ role: "user", content: blocks });
      continue;
    }
    if (message.role === "assistant") {
      const blocks: JsonRecord[] = [];
      if (message.content.length > 0) blocks.push({ type: "text", text: message.content });
      for (const call of message.toolCalls ?? []) {
        blocks.push({ type: "tool_use", id: call.id, name: call.name, input: call.args });
      }
      if (blocks.length > 0) out.push({ role: "assistant", content: blocks });
      index += 1;
      continue;
    }
    if (message.role === "user") {
      out.push({ role: "user", content: message.content });
    }
    index += 1;
  }
  return out;
}

function anthropicTools(tools: CompletionRequest["tools"]): JsonRecord[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

/** Parses a recorded/complete Anthropic Messages response (JSON or SSE). */
export function parseAnthropicResponse(body: string, contentType = ""): CompletionResponse {
  if (contentType.includes("text/event-stream") || body.trimStart().startsWith("data:")) {
    return parseAnthropicSse(body);
  }
  const root = parseJsonObject(body);
  return completionFromAnthropicMessage(root);
}

function completionFromAnthropicMessage(root: JsonRecord): CompletionResponse {
  const blocks = Array.isArray(root.content) ? root.content : [];
  let text = "";
  const toolCalls: ToolCall[] = [];
  for (const block of blocks) {
    if (!isRecord(block)) continue;
    const type = stringField(block.type);
    if (type === "text") text += stringField(block.text) ?? "";
    if (type === "tool_use") {
      const name = stringField(block.name);
      if (name) {
        toolCalls.push({
          id: stringField(block.id) ?? `tool_${toolCalls.length}`,
          name,
          args: isRecord(block.input) ? block.input : {},
        });
      }
    }
  }
  const usage = isRecord(root.usage) ? root.usage : undefined;
  const stopReason = stringField(root.stop_reason);
  return {
    text,
    toolCalls,
    stopReason:
      toolCalls.length > 0 || stopReason === "tool_use"
        ? "tool_use"
        : stopReason === "max_tokens"
          ? "length"
          : "end",
    ...(usage
      ? {
          usage: {
            inputTokens: numberField(usage.input_tokens) ?? 0,
            outputTokens: numberField(usage.output_tokens) ?? 0,
          },
        }
      : {}),
  };
}

function parseAnthropicSse(body: string): CompletionResponse {
  const blocks = new Map<number, { type: string; text: string; id: string; name: string; json: string }>();
  let inputTokens = 0;
  let outputTokens = 0;
  let stopReason: string | undefined;
  for (const event of parseSseEvents(body)) {
    let data: JsonRecord;
    try {
      const parsed: unknown = JSON.parse(event.data);
      if (!isRecord(parsed)) continue;
      data = parsed;
    } catch {
      continue;
    }
    const type = stringField(data.type) ?? event.event;
    if (type === "message_start") {
      const message = isRecord(data.message) ? data.message : {};
      const usage = isRecord(message.usage) ? message.usage : {};
      inputTokens = numberField(usage.input_tokens) ?? inputTokens;
      outputTokens = numberField(usage.output_tokens) ?? outputTokens;
    } else if (type === "content_block_start") {
      const index = numberField(data.index) ?? 0;
      const block = isRecord(data.content_block) ? data.content_block : {};
      blocks.set(index, {
        type: stringField(block.type) ?? "text",
        text: stringField(block.text) ?? "",
        id: stringField(block.id) ?? "",
        name: stringField(block.name) ?? "",
        json: "",
      });
    } else if (type === "content_block_delta") {
      const index = numberField(data.index) ?? 0;
      const existing = blocks.get(index) ?? { type: "text", text: "", id: "", name: "", json: "" };
      const delta = isRecord(data.delta) ? data.delta : {};
      if (stringField(delta.type) === "input_json_delta") {
        existing.json += stringField(delta.partial_json) ?? "";
      } else {
        existing.text += stringField(delta.text) ?? "";
      }
      blocks.set(index, existing);
    } else if (type === "message_delta") {
      const usage = isRecord(data.usage) ? data.usage : {};
      outputTokens = numberField(usage.output_tokens) ?? outputTokens;
      stopReason = stringField(isRecord(data.delta) ? data.delta.stop_reason : undefined) ?? stopReason;
    }
  }
  const content = [...blocks.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, block]) => {
      if (block.type === "tool_use") {
        return {
          type: "tool_use",
          id: block.id,
          name: block.name,
          input: parseToolArguments(block.json),
        };
      }
      return { type: "text", text: block.text };
    });
  return completionFromAnthropicMessage({ content, usage: { input_tokens: inputTokens, output_tokens: outputTokens }, stop_reason: stopReason });
}

function makeOpenAiProvider(cfg: ProviderConfig, name: string): Provider {
  const base = trimBase(cfg.baseUrl ?? env("OPENAI_BASE_URL") ?? DEFAULT_OPENAI_BASE);
  const apiKey = requireValue(
    cfg.apiKey ?? (name === "openai" ? env("OPENAI_API_KEY") : undefined) ?? env("ZIMREAPER_API_KEY"),
    `${name} API key (set ${name.toUpperCase()}_API_KEY or ZIMREAPER_API_KEY)`,
  );
  const model = requireValue(cfg.model, `${name} model`);
  return {
    name,
    model,
    async complete(req: CompletionRequest): Promise<CompletionResponse> {
      const res = await providerFetch(
        `${base}/chat/completions`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${apiKey}`,
            ...(cfg.headers ?? {}),
          },
          body: JSON.stringify({
            model,
            messages: [{ role: "system", content: req.system }, ...openAiMessages(req.messages)],
            tools: openAiTools(req.tools),
            tool_choice: "auto",
            temperature: req.temperature,
            max_tokens: req.maxTokens,
            stream: false,
          }),
        },
        req.signal,
      );
      const body = await readText(res);
      return parseOpenAiResponse(body, res.headers.get("content-type") ?? "");
    },
  };
}

function makeAnthropicProvider(cfg: ProviderConfig): Provider {
  const base = trimBase(cfg.baseUrl ?? env("ANTHROPIC_BASE_URL") ?? DEFAULT_ANTHROPIC_BASE);
  const apiKey = requireValue(
    cfg.apiKey ?? env("ANTHROPIC_API_KEY") ?? env("ZIMREAPER_API_KEY"),
    "Anthropic API key (set ANTHROPIC_API_KEY or ZIMREAPER_API_KEY)",
  );
  const model = requireValue(cfg.model, "Anthropic model");
  return {
    name: "anthropic",
    model,
    async complete(req: CompletionRequest): Promise<CompletionResponse> {
      const res = await providerFetch(
        `${base}/v1/messages`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-api-key": apiKey,
            "anthropic-version": ANTHROPIC_VERSION,
            ...(cfg.headers ?? {}),
          },
          body: JSON.stringify({
            model,
            system: req.system,
            messages: anthropicMessages(req.messages),
            tools: anthropicTools(req.tools),
            temperature: req.temperature,
            max_tokens: req.maxTokens ?? 4096,
          }),
        },
        req.signal,
      );
      const body = await readText(res);
      return parseAnthropicResponse(body, res.headers.get("content-type") ?? "");
    },
  };
}

function makeCustomProvider(cfg: ProviderConfig, customName: string): Provider {
  const prefix = customEnvPrefix(customName);
  const baseUrl = requireValue(cfg.baseUrl ?? env(`${prefix}_BASE_URL`), `${prefix}_BASE_URL`);
  const apiKey = requireValue(
    cfg.apiKey ?? env(`${prefix}_API_KEY`) ?? env("ZIMREAPER_API_KEY"),
    `${prefix}_API_KEY or ZIMREAPER_API_KEY`,
  );
  const model = requireValue(cfg.model || env(`${prefix}_MODEL`) || "", `${prefix}_MODEL`);
  return makeOpenAiProvider(
    { ...cfg, kind: "openai", baseUrl, apiKey, model },
    `custom:${customName}`,
  );
}

export function createProvider(cfg: ProviderConfig): Provider {
  const kind = cfg.kind.trim().toLowerCase();
  if (kind === "openai") return makeOpenAiProvider(cfg, "openai");
  if (kind === "anthropic") return makeAnthropicProvider(cfg);
  if (kind.startsWith("custom:")) {
    const customName = cfg.kind.slice("custom:".length).trim();
    if (!customName) throw new ZimReaperError("BAD_REQUEST", "custom provider requires custom:<name>");
    return makeCustomProvider(cfg, customName);
  }
  throw new ZimReaperError("UNSUPPORTED", `unknown provider kind: ${cfg.kind}`);
}
