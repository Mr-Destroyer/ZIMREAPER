import { MUTATING_KINDS, type Action, type Query } from "@zimreaper/protocol";
import type {
  ClassifyState,
  OriginPolicy,
  PolicyConfig,
  PolicyContext,
  PolicyDecision,
} from "./types.js";

type Tier = OriginPolicy["tier"];

const ALWAYS_ALLOW_KINDS: ReadonlySet<Action["kind"]> = new Set<Action["kind"]>([
  "session.kill",
  "session.cancel",
  "human.request",
  "page.wait",
  "clipboard.read",
]);

const READ_ALLOWED_KINDS: ReadonlySet<Action["kind"]> = new Set<Action["kind"]>([
  "nav.goto",
  "nav.back",
  "nav.forward",
  "nav.reload",
  "nav.stop",
  "mouse.move",
  "mouse.wheel",
  "mouse.hover",
  "page.scroll",
  "page.screenshot",
  "page.wait",
  "page.pdf",
  "page.setViewport",
  "page.emulate",
  "vision.ground",
  "tab.activate",
  "net.har",
]);

const NAVIGATION_KEYS: ReadonlySet<string> = new Set([
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "PageUp",
  "PageDown",
  "Home",
  "End",
]);

const DESTRUCTIVE_ACTION_KINDS: ReadonlySet<Action["kind"]> = new Set<Action["kind"]>([
  "mouse.click",
  "dom.click",
  "dom.fill",
]);

export function isAlwaysAllowed(kind: Action["kind"]): boolean {
  return ALWAYS_ALLOW_KINDS.has(kind);
}

function allow(reason: string): PolicyDecision {
  return { verdict: "allow", reason };
}

function confirm(reason: string): PolicyDecision {
  return { verdict: "confirm", reason };
}

function block(reason: string): PolicyDecision {
  return { verdict: "block", reason };
}

function normalizeOriginKey(key: string): string {
  let value = key.trim().toLowerCase();
  const scheme = value.indexOf("://");
  if (scheme !== -1) value = value.slice(scheme + 3);
  const slash = value.indexOf("/");
  if (slash !== -1) value = value.slice(0, slash);
  return value;
}

function parseUrl(raw: string | undefined, base?: string): URL | undefined {
  if (!raw) return undefined;
  try {
    return new URL(raw, base);
  } catch {
    return undefined;
  }
}

function isHttp(url: URL): boolean {
  return url.protocol === "http:" || url.protocol === "https:";
}

function targetUrl(action: Action, ctx: PolicyContext): string | undefined {
  if (action.kind === "nav.goto") return action.url;
  if (action.kind === "tab.new" && action.url !== undefined) return action.url;
  return ctx.url;
}

/**
 * Exact host (with and without port) wins over a `*.example.com` wildcard.
 * Returns `undefined` when no configured rule matches; use `resolveOriginPolicy`
 * for the mode-dependent default.
 */
export function lookupOriginPolicy(
  url: string | undefined,
  config: PolicyConfig,
  base?: string,
): OriginPolicy | undefined {
  const parsed = parseUrl(url, base);
  if (!parsed || !isHttp(parsed)) return undefined;

  const host = parsed.hostname.toLowerCase();
  const hostWithPort = parsed.host.toLowerCase();
  const candidates = new Set<string>([hostWithPort, host]);
  if (parsed.port) candidates.add(`${host}:${parsed.port}`);
  else if (parsed.protocol === "https:") candidates.add(`${host}:443`);
  else if (parsed.protocol === "http:") candidates.add(`${host}:80`);

  const normalized = new Map<string, OriginPolicy>();
  for (const [key, policy] of Object.entries(config.origins)) {
    normalized.set(normalizeOriginKey(key), policy);
  }

  for (const candidate of candidates) {
    const exact = normalized.get(candidate);
    if (exact) return exact;
  }

  for (const [pattern, policy] of normalized) {
    if (!pattern.startsWith("*.")) continue;
    const suffix = pattern.slice(2);
    if (!suffix) continue;
    // A wildcard matches subdomains, not the apex domain.
    if (host !== suffix && host.endsWith(`.${suffix}`)) return policy;
  }
  return undefined;
}

/**
 * Unknown origins are usable in standard mode (`interact`) so an agent can fill
 * a form on a site the human just opened. Strict mode stays observe-only, and
 * permissive mode also pre-authorizes eval and uploads.
 */
export function defaultOriginPolicy(config: PolicyConfig): OriginPolicy {
  if (config.mode === "permissive") {
    return { tier: "interact", allowEval: true, allowUploads: true };
  }
  if (config.mode === "strict") return { tier: "read" };
  return { tier: "interact" };
}

export function resolveOriginPolicy(url: string | undefined, config: PolicyConfig, base?: string): OriginPolicy {
  return lookupOriginPolicy(url, config, base) ?? defaultOriginPolicy(config);
}

export function resolveOriginTier(url: string | undefined, config: PolicyConfig, base?: string): Tier {
  return resolveOriginPolicy(url, config, base).tier;
}

function originLabel(url: string | undefined, base?: string): string {
  const parsed = parseUrl(url, base);
  return parsed?.host ?? parsed?.protocol ?? "unknown origin";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesDestructivePattern(text: string, pattern: string): boolean {
  const needle = pattern.trim().toLowerCase();
  if (!needle) return false;
  // Normalize selectors/camelCase so "#deleteAccount" and "#buy-now" match
  // the same words a human would see on the button.
  const haystack = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[-_]+/g, " ");
  if (/\s/.test(needle)) return haystack.includes(needle);
  // Word-ish boundaries keep "pay" from matching "repayment" while still
  // matching selectors such as "#delete-account".
  const re = new RegExp(`(^|[^a-z0-9])${escapeRegExp(needle)}([^a-z0-9]|$)`, "i");
  return re.test(haystack);
}

function destructiveText(action: Action, ctx: PolicyContext): string | undefined {
  if (action.kind === "key.press") {
    if (action.key !== "Enter") return undefined;
    return [ctx.target?.name, ctx.target?.selector].filter(Boolean).join(" ");
  }
  if (!DESTRUCTIVE_ACTION_KINDS.has(action.kind)) return undefined;
  const selector = "target" in action ? action.target?.selector : undefined;
  return [selector, ctx.target?.selector, ctx.target?.name].filter(Boolean).join(" ");
}

function destructivePattern(action: Action, ctx: PolicyContext, config: PolicyConfig): string | undefined {
  const text = destructiveText(action, ctx);
  if (!text) return undefined;
  return config.destructivePatterns.find((pattern) => matchesDestructivePattern(text, pattern));
}

function classifyAtTier(
  action: Action,
  originPolicy: OriginPolicy,
  url: string | undefined,
  base: string | undefined,
): PolicyDecision {
  const tier = originPolicy.tier;
  const origin = originLabel(url, base);

  if (tier === "transact") return allow(`origin ${origin} is tier transact; all actions allowed`);

  if (tier === "read") {
    if (READ_ALLOWED_KINDS.has(action.kind)) return allow(`read tier allows ${action.kind}`);
    if (action.kind === "key.press" && NAVIGATION_KEYS.has(action.key)) {
      return allow(`read tier allows navigation key ${action.key}`);
    }
    if (action.kind === "storage.cookies" && action.op === "get") {
      return allow("read tier allows cookie reads");
    }
    if (action.kind === "storage.local" && action.op === "get") {
      return allow("read tier allows storage reads");
    }
    return block(`origin ${origin} is tier read; ${action.kind} is mutating`);
  }

  // tier === "interact"
  if (action.kind === "page.eval" && originPolicy?.allowEval !== true) {
    return block(`origin ${origin} is tier interact; page.eval requires allowEval`);
  }
  if (action.kind === "dom.setFiles" && originPolicy?.allowUploads !== true) {
    return block(`origin ${origin} is tier interact; dom.setFiles requires allowUploads`);
  }
  return allow(`origin ${origin} is tier interact; ${action.kind} allowed`);
}

export function classify(
  action: Action,
  ctx: PolicyContext,
  config: PolicyConfig,
  state?: ClassifyState,
): PolicyDecision {
  if (ALWAYS_ALLOW_KINDS.has(action.kind)) {
    return allow(`${action.kind} is always allowed`);
  }

  const rawTarget = targetUrl(action, ctx);
  let parsedTarget: URL | undefined;
  if (rawTarget) {
    parsedTarget = parseUrl(rawTarget, ctx.url);
    if (!parsedTarget) {
      return block(`cannot parse target URL ${rawTarget}`);
    }
    if (!isHttp(parsedTarget)) {
      if (config.mode !== "permissive") {
        return block(`non-http(s) origin ${parsedTarget.protocol} is blocked`);
      }
      return allow(`permissive mode allows non-http(s) origin ${parsedTarget.protocol}`);
    }
  }

  const originPolicy = resolveOriginPolicy(rawTarget ?? ctx.url, config, ctx.url);
  const tier = originPolicy.tier;
  let decision = classifyAtTier(action, originPolicy, rawTarget ?? ctx.url, ctx.url);

  const pattern = destructivePattern(action, ctx, config);
  if (pattern && tier !== "transact" && decision.verdict !== "block") {
    const text = destructiveText(action, ctx) ?? "";
    decision = confirm(`target "${text}" matches destructive pattern "${pattern}"; confirmation required`);
  }

  if (ctx.tainted === true && MUTATING_KINDS.has(action.kind) && decision.verdict !== "block") {
    if (config.mode === "strict") {
      decision = block("tainted page content cannot trigger a mutating action in strict mode");
    } else if (config.mode === "standard") {
      decision = confirm("tainted page content requires confirmation for a mutating action");
    } else if (decision.verdict === "confirm") {
      decision = allow("permissive mode allows tainted mutating actions");
    }
  }

  if (state?.now !== undefined && state.recentActions !== undefined) {
    const cutoff = state.now - 60_000;
    const count = state.recentActions.filter((ts) => ts > cutoff).length;
    if (count >= config.maxActionsPerMinute) {
      return block(
        `rate limit: ${count} actions in the last 60s (max ${config.maxActionsPerMinute})`,
      );
    }
  }

  return decision;
}

/** Queries are read-only by construction; audit/session reads never need a gate. */
export function classifyQuery(query: Query, _ctx: PolicyContext, _config: PolicyConfig): PolicyDecision {
  return allow(`${query.kind} is a read-only query`);
}
