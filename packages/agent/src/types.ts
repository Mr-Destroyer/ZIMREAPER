export type ChatRole = "system" | "user" | "assistant" | "tool";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  toolCallId?: string;
  /** False when the corresponding tool result is an error. */
  toolOk?: boolean;
  toolCalls?: ToolCall[];
  /** Marks content that originated from a page (untrusted). */
  tainted?: boolean;
}

export interface ToolSpec {
  name: string;
  description: string;
  /** JSON Schema object handed to the model provider. */
  inputSchema: Record<string, unknown>;
  /** True when the tool can change external state; used by the taint guard. */
  mutates?: boolean;
  /** True when the tool returns page-derived content that must be tainted. */
  tainted?: boolean;
}

export interface ToolCall {
  id: string;
  name: string;
  args: Record<string, unknown>;
}

export interface ToolResult {
  callId: string;
  ok: boolean;
  content: string;
  tainted?: boolean;
}

/** Structural subset of a Zod schema, kept dependency-free in this module. */
export interface ToolArgsValidator {
  safeParse(input: unknown):
    | { success: true; data: unknown }
    | { success: false; error: { issues: ReadonlyArray<{ message?: string }> } };
}

export interface Tool {
  spec: ToolSpec;
  /** Optional argument validator; when present the loop parses args before calling run. */
  schema?: ToolArgsValidator;
  run(args: Record<string, unknown>, signal?: AbortSignal): Promise<unknown>;
}

export interface CompletionRequest {
  system: string;
  messages: ChatMessage[];
  tools: ToolSpec[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
}

export interface CompletionResponse {
  text: string;
  toolCalls: ToolCall[];
  stopReason: "end" | "tool_use" | "length" | "error";
  usage?: { inputTokens: number; outputTokens: number };
}

export interface Provider {
  name: string;
  model: string;
  complete(req: CompletionRequest): Promise<CompletionResponse>;
}

export interface ProviderConfig {
  /** "openai" | "anthropic" | "custom:<name>" */
  kind: string;
  baseUrl?: string;
  apiKey?: string;
  model: string;
  headers?: Record<string, string>;
}

export interface AgentEvent {
  kind: "step" | "tool" | "text" | "done" | "error";
  step?: number;
  text?: string;
  tool?: string;
  ok?: boolean;
  detail?: string;
}

export interface AgentLoopOptions {
  provider: Provider;
  tools: Tool[];
  maxSteps?: number;
  systemPrompt?: string;
  onEvent?: (event: AgentEvent) => void;
}

export interface AgentRunResult {
  ok: boolean;
  text: string;
  steps: number;
  toolCalls: number;
  usage: { inputTokens: number; outputTokens: number };
  transcript: ChatMessage[];
}
