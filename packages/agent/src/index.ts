/**
 * Provider-agnostic agent loop. Talks to any OpenAI-compatible endpoint or Anthropic
 * Messages endpoint over plain fetch/SSE; no SDK dependency, no proxy hop required.
 */
export * from "./types.js";
export { ensureRepoUpdated } from "./auto-update.js";
export type {
  AutoUpdateOptions,
  AutoUpdateResult,
  GitCommandResult,
  GitRunner,
  GitRunnerOptions,
} from "./auto-update.js";
export { AgentLoop, DEFAULT_SYSTEM_PROMPT } from "./loop.js";
export {
  createProvider,
  parseAnthropicResponse,
  parseOpenAiResponse,
  parseSseEvents,
} from "./provider.js";
export type { SseEvent } from "./provider.js";
