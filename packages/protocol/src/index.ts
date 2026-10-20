/**
 * ZimReaper wire protocol — the frozen P0 contract.
 *
 * Everything crossing a process boundary (MCP -> control server -> executor -> backend)
 * is validated here. Additive optional fields only; no renames without the lead.
 */
import { z } from "zod";

export const PROTOCOL_VERSION = "0.1.0";

/* ------------------------------------------------------------------ primitives */

export const PointSchema = z.object({
  x: z.number().finite(),
  y: z.number().finite(),
});
export type Point = z.infer<typeof PointSchema>;

export const ModifierSchema = z.enum(["Alt", "Control", "Meta", "Shift"]);
export type Modifier = z.infer<typeof ModifierSchema>;

export const MouseButtonSchema = z.enum(["left", "right", "middle", "back", "forward"]);
export type MouseButton = z.infer<typeof MouseButtonSchema>;

export const RefSchema = z.string().regex(/^e\d+$/, "ref must look like e12");
export type Ref = z.infer<typeof RefSchema>;

/** A click/fill target: a snapshot ref, a CSS selector, or a raw viewport point. */
export const TargetSchema = z
  .object({
    ref: RefSchema.optional(),
    selector: z.string().min(1).optional(),
    point: PointSchema.optional(),
    /** Click offset from the resolved element's top-left. Defaults to center. */
    offset: PointSchema.optional(),
  })
  .refine((v) => v.ref !== undefined || v.selector !== undefined || v.point !== undefined, {
    message: "target requires one of ref, selector, point",
  });
export type Target = z.infer<typeof TargetSchema>;

export const WaitUntilSchema = z.enum(["load", "domcontentloaded", "networkidle", "commit"]);
export type WaitUntil = z.infer<typeof WaitUntilSchema>;

export const ScreenshotFormatSchema = z.enum(["png", "jpeg", "webp"]);

/* --------------------------------------------------------------------- actions */

const NavGoto = z.object({
  kind: z.literal("nav.goto"),
  url: z.string().min(1),
  waitUntil: WaitUntilSchema.default("load"),
  timeoutMs: z.number().int().positive().max(120_000).optional(),
  referrer: z.string().optional(),
});

const NavSimple = z.object({
  kind: z.enum(["nav.back", "nav.forward", "nav.stop"]),
});

const NavReload = z.object({
  kind: z.literal("nav.reload"),
  ignoreCache: z.boolean().default(false),
});

const TabNew = z.object({
  kind: z.literal("tab.new"),
  url: z.string().optional(),
  active: z.boolean().default(true),
  /** Named session partition; isolated cookies/storage per partition. */
  partition: z.string().optional(),
  /** Copy cookies + storage from this tab into the new one. */
  forkFrom: z.string().optional(),
});

const TabClose = z.object({ kind: z.literal("tab.close"), tabId: z.string().min(1) });
const TabActivate = z.object({ kind: z.literal("tab.activate"), tabId: z.string().min(1) });

const MouseMove = z.object({
  kind: z.literal("mouse.move"),
  to: PointSchema,
  steps: z.number().int().min(1).max(200).default(12),
  durationMs: z.number().int().min(0).max(10_000).default(120),
});

const MouseClick = z.object({
  kind: z.literal("mouse.click"),
  target: TargetSchema,
  button: MouseButtonSchema.default("left"),
  clickCount: z.number().int().min(1).max(3).default(1),
  modifiers: z.array(ModifierSchema).default([]),
  /** Delay between press and release, so sites that sniff for 0ms clicks behave. */
  delayMs: z.number().int().min(0).max(2000).default(24),
});

const MouseButtonAction = z.object({
  kind: z.enum(["mouse.down", "mouse.up"]),
  target: TargetSchema.optional(),
  button: MouseButtonSchema.default("left"),
});

const MouseDrag = z.object({
  kind: z.literal("mouse.drag"),
  from: TargetSchema,
  to: TargetSchema,
  button: MouseButtonSchema.default("left"),
  steps: z.number().int().min(1).max(200).default(20),
  durationMs: z.number().int().min(0).max(10_000).default(300),
});

const MouseWheel = z.object({
  kind: z.literal("mouse.wheel"),
  target: TargetSchema.optional(),
  deltaX: z.number().default(0),
  deltaY: z.number().default(0),
});

const MouseHover = z.object({
  kind: z.literal("mouse.hover"),
  target: TargetSchema,
  durationMs: z.number().int().min(0).max(10_000).default(150),
});

const KeyType = z.object({
  kind: z.literal("key.type"),
  text: z.string(),
  target: TargetSchema.optional(),
  delayMs: z.number().int().min(0).max(500).default(8),
  clearFirst: z.boolean().default(false),
});

const KeyPress = z.object({
  kind: z.literal("key.press"),
  key: z.string().min(1),
  modifiers: z.array(ModifierSchema).default([]),
  count: z.number().int().min(1).max(50).default(1),
});

const KeyChord = z.object({
  kind: z.literal("key.chord"),
  /** e.g. "Control+Shift+T", "Meta+A". Parsed left-to-right; last token is the key. */
  chord: z.string().min(1),
});

const KeyHold = z.object({
  kind: z.enum(["key.down", "key.up"]),
  key: z.string().min(1),
  modifiers: z.array(ModifierSchema).default([]),
});

const PageScroll = z.object({
  kind: z.literal("page.scroll"),
  target: TargetSchema.optional(),
  deltaX: z.number().default(0),
  deltaY: z.number().default(0),
  toTop: z.boolean().default(false),
  toBottom: z.boolean().default(false),
});

const PageScreenshot = z.object({
  kind: z.literal("page.screenshot"),
  fullPage: z.boolean().default(false),
  annotate: z.boolean().default(false),
  format: ScreenshotFormatSchema.default("png"),
  quality: z.number().int().min(1).max(100).optional(),
  clip: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }).optional(),
  /** Optional absolute path; otherwise the artifact goes to ~/.zimreaper/artifacts/<session>/. */
  path: z.string().optional(),
});

const PagePdf = z.object({
  kind: z.literal("page.pdf"),
  path: z.string().min(1),
  format: z.string().default("A4"),
  printBackground: z.boolean().default(true),
});

const PageSetViewport = z.object({
  kind: z.literal("page.setViewport"),
  width: z.number().int().min(200).max(4096),
  height: z.number().int().min(200).max(4096),
  deviceScaleFactor: z.number().min(0.5).max(4).default(1),
  mobile: z.boolean().default(false),
});

const PageEmulate = z.object({
  kind: z.literal("page.emulate"),
  userAgent: z.string().optional(),
  timezone: z.string().optional(),
  locale: z.string().optional(),
  colorScheme: z.enum(["light", "dark", "no-preference"]).optional(),
  geolocation: z
    .object({ latitude: z.number(), longitude: z.number(), accuracy: z.number().default(50) })
    .optional(),
});

const PageEval = z.object({
  kind: z.literal("page.eval"),
  expression: z.string().min(1),
  awaitPromise: z.boolean().default(true),
  /** Isolated world keeps page JS from clobbering our globals. */
  isolated: z.boolean().default(false),
});

const PageWait = z.object({
  kind: z.literal("page.wait"),
  for: z
    .object({
      selector: z.string().optional(),
      text: z.string().optional(),
      urlContains: z.string().optional(),
      networkIdle: z.boolean().optional(),
      /** Boolean JS expression polled until truthy. */
      expression: z.string().optional(),
      /** Wait until this snapshot ref disappears (e.g. a spinner). */
      refGone: RefSchema.optional(),
    })
    .refine((v) => Object.values(v).some((x) => x !== undefined), {
      message: "page.wait.for requires at least one condition",
    }),
  timeoutMs: z.number().int().positive().max(120_000).default(15_000),
  pollMs: z.number().int().min(25).max(2000).default(100),
});

const DomClick = z.object({ kind: z.literal("dom.click"), target: TargetSchema });
const DomFill = z.object({
  kind: z.literal("dom.fill"),
  target: TargetSchema,
  text: z.string(),
  clear: z.boolean().default(true),
  submit: z.boolean().default(false),
});
const DomSelect = z.object({
  kind: z.literal("dom.select"),
  target: TargetSchema,
  values: z.array(z.string()).min(1),
});
const DomCheck = z.object({
  kind: z.literal("dom.check"),
  target: TargetSchema,
  checked: z.boolean().default(true),
});
const DomSetFiles = z.object({
  kind: z.literal("dom.setFiles"),
  target: TargetSchema,
  paths: z.array(z.string()).min(1),
});
const DomScrollIntoView = z.object({
  kind: z.literal("dom.scrollIntoView"),
  target: TargetSchema,
  block: z.enum(["start", "center", "end", "nearest"]).default("center"),
});

const DialogRespond = z.object({
  kind: z.literal("dialog.respond"),
  accept: z.boolean(),
  promptText: z.string().optional(),
});

const ClipboardRead = z.object({ kind: z.literal("clipboard.read") });
const ClipboardWrite = z.object({ kind: z.literal("clipboard.write"), text: z.string() });

const NetRoute = z.object({
  kind: z.literal("net.route"),
  /** URL pattern; supports `*` wildcards and `re:` prefix for regex. */
  pattern: z.string().min(1),
  mode: z.enum(["block", "mock", "pass"]),
  status: z.number().int().min(100).max(599).optional(),
  headers: z.record(z.string()).optional(),
  body: z.string().optional(),
  method: z.string().optional(),
});
const NetUnroute = z.object({ kind: z.literal("net.unroute"), ruleId: z.string() });
const NetReplay = z.object({
  kind: z.literal("net.replay"),
  requestId: z.string(),
  overrides: z
    .object({
      url: z.string().optional(),
      method: z.string().optional(),
      headers: z.record(z.string()).optional(),
      body: z.string().optional(),
    })
    .optional(),
});
const NetHar = z.object({
  kind: z.literal("net.har"),
  action: z.enum(["start", "stop"]),
  path: z.string().optional(),
});
const NetExtraHeaders = z.object({
  kind: z.literal("net.setExtraHeaders"),
  headers: z.record(z.string()),
});

const StorageCookies = z.object({
  kind: z.literal("storage.cookies"),
  op: z.enum(["get", "set", "clear"]),
  url: z.string().optional(),
  cookies: z
    .array(
      z.object({
        name: z.string(),
        value: z.string(),
        domain: z.string().optional(),
        path: z.string().optional(),
        expires: z.number().optional(),
        httpOnly: z.boolean().optional(),
        secure: z.boolean().optional(),
        sameSite: z.enum(["Strict", "Lax", "None"]).optional(),
      }),
    )
    .optional(),
});
const StorageLocal = z.object({
  kind: z.literal("storage.local"),
  op: z.enum(["get", "set", "remove", "clear"]),
  origin: z.string().min(1),
  key: z.string().optional(),
  value: z.string().optional(),
});

const SessionFork = z.object({
  kind: z.literal("session.fork"),
  tabId: z.string().optional(),
  count: z.number().int().min(1).max(12).default(2),
  url: z.string().optional(),
});
const SessionKill = z.object({ kind: z.literal("session.kill") });
const SessionCancel = z.object({
  kind: z.literal("session.cancel"),
  tabId: z.string().optional(),
});

const HumanRequest = z.object({
  kind: z.literal("human.request"),
  reason: z.string().min(1),
  detail: z.string().optional(),
  timeoutMs: z.number().int().positive().max(600_000).default(120_000),
});

const VisionGround = z.object({
  kind: z.literal("vision.ground"),
  description: z.string().min(1),
  /** Ground against a fresh screenshot by default. */
  screenshotPath: z.string().optional(),
});

export const ActionSchema = z.discriminatedUnion("kind", [
  NavGoto,
  NavSimple,
  NavReload,
  TabNew,
  TabClose,
  TabActivate,
  MouseMove,
  MouseClick,
  MouseButtonAction,
  MouseDrag,
  MouseWheel,
  MouseHover,
  KeyType,
  KeyPress,
  KeyChord,
  KeyHold,
  PageScroll,
  PageScreenshot,
  PagePdf,
  PageSetViewport,
  PageEmulate,
  PageEval,
  PageWait,
  DomClick,
  DomFill,
  DomSelect,
  DomCheck,
  DomSetFiles,
  DomScrollIntoView,
  DialogRespond,
  ClipboardRead,
  ClipboardWrite,
  NetRoute,
  NetUnroute,
  NetReplay,
  NetHar,
  NetExtraHeaders,
  StorageCookies,
  StorageLocal,
  SessionFork,
  SessionKill,
  SessionCancel,
  HumanRequest,
  VisionGround,
]);
export type Action = z.infer<typeof ActionSchema>;
export type ActionKind = Action["kind"];

/** Action kinds that can change external state; the policy layer gates these. */
export const MUTATING_KINDS: ReadonlySet<ActionKind> = new Set<ActionKind>([
  "nav.goto",
  "nav.back",
  "nav.forward",
  "nav.reload",
  "tab.new",
  "tab.close",
  "mouse.click",
  "mouse.down",
  "mouse.up",
  "mouse.drag",
  "mouse.wheel",
  "key.type",
  "key.press",
  "key.chord",
  "key.down",
  "key.up",
  "page.scroll",
  "page.eval",
  "dom.click",
  "dom.fill",
  "dom.select",
  "dom.check",
  "dom.setFiles",
  "dialog.respond",
  "clipboard.write",
  "net.route",
  "net.unroute",
  "net.replay",
  "net.setExtraHeaders",
  "storage.cookies",
  "storage.local",
  "session.fork",
  "session.kill",
]);

/* --------------------------------------------------------------------- queries */

const TabList = z.object({ kind: z.literal("tab.list") });

const PageSnapshot = z.object({
  kind: z.literal("page.snapshot"),
  mode: z.enum(["ax", "dom", "both"]).default("ax"),
  maxChars: z.number().int().min(500).max(200_000).default(12_000),
  includeFrames: z.boolean().default(false),
  interactiveOnly: z.boolean().default(false),
  /** Reuse the previous snapshot if the page hash is unchanged. */
  cache: z.boolean().default(true),
});

const PageDiff = z.object({
  kind: z.literal("page.diff"),
  since: z.string().min(1),
  maxChars: z.number().int().min(500).max(200_000).default(6_000),
});

const PageText = z.object({
  kind: z.literal("page.text"),
  selector: z.string().optional(),
  maxChars: z.number().int().min(100).max(200_000).default(12_000),
});

const PageHtml = z.object({
  kind: z.literal("page.html"),
  selector: z.string().optional(),
  outer: z.boolean().default(false),
  maxChars: z.number().int().min(100).max(500_000).default(50_000),
});

const DomQuery = z.object({
  kind: z.literal("dom.query"),
  selector: z.string().min(1),
  all: z.boolean().default(true),
  limit: z.number().int().min(1).max(500).default(50),
  attrs: z.array(z.string()).default([]),
});

const DomAttrs = z.object({ kind: z.literal("dom.attrs"), target: TargetSchema });

const NetLog = z.object({
  kind: z.literal("net.log"),
  sinceSeq: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).max(1000).default(100),
  filter: z
    .object({
      urlContains: z.string().optional(),
      method: z.string().optional(),
      status: z.number().int().optional(),
      resourceType: z.string().optional(),
    })
    .optional(),
});

const NetBody = z.object({
  kind: z.literal("net.body"),
  requestId: z.string().min(1),
  part: z.enum(["request", "response"]).default("response"),
  maxBytes: z.number().int().min(100).max(5_000_000).default(200_000),
});

const AuditTail = z.object({ kind: z.literal("audit.tail"), limit: z.number().int().min(1).max(500).default(50) });
const SessionInfo = z.object({ kind: z.literal("session.info") });
const PolicyGet = z.object({ kind: z.literal("policy.get") });
const VaultList = z.object({ kind: z.literal("vault.list") });
const PageExtract = z.object({
  kind: z.literal("page.extract"),
  /** CSS selector for repeating rows/cards. */
  rowSelector: z.string().min(1),
  fields: z.record(
    z.object({
      selector: z.string().optional(),
      attr: z.string().optional(),
      /** Use the row's own text when no selector is given. */
      self: z.boolean().default(false),
    }),
  ),
  limit: z.number().int().min(1).max(500).default(100),
});

export const QuerySchema = z.discriminatedUnion("kind", [
  TabList,
  PageSnapshot,
  PageDiff,
  PageText,
  PageHtml,
  DomQuery,
  DomAttrs,
  NetLog,
  NetBody,
  AuditTail,
  SessionInfo,
  PolicyGet,
  VaultList,
  PageExtract,
]);
export type Query = z.infer<typeof QuerySchema>;
export type QueryKind = Query["kind"];

/* --------------------------------------------------------------------- results */

export const TabInfoSchema = z.object({
  tabId: z.string(),
  url: z.string(),
  title: z.string(),
  active: z.boolean(),
  partition: z.string(),
  loading: z.boolean(),
  canGoBack: z.boolean(),
  canGoForward: z.boolean(),
  createdAt: z.number(),
});
export type TabInfo = z.infer<typeof TabInfoSchema>;

export const RefInfoSchema = z.object({
  ref: RefSchema,
  role: z.string(),
  name: z.string(),
  bbox: z.object({ x: z.number(), y: z.number(), width: z.number(), height: z.number() }),
  selector: z.string().optional(),
  backendNodeId: z.number().optional(),
  value: z.string().optional(),
  textHash: z.string(),
  generation: z.number(),
});
export type RefInfo = z.infer<typeof RefInfoSchema>;

export const SnapshotSchema = z.object({
  snapshotId: z.string(),
  tabId: z.string(),
  url: z.string(),
  title: z.string(),
  generation: z.number(),
  viewport: z.object({ width: z.number(), height: z.number() }),
  scroll: z.object({ x: z.number(), y: z.number(), maxY: z.number() }),
  /** Compact, token-budgeted text representation handed to the model. */
  text: z.string(),
  refs: z.array(RefInfoSchema),
  truncated: z.boolean(),
  pageHash: z.string(),
  createdAt: z.number(),
});
export type Snapshot = z.infer<typeof SnapshotSchema>;

export const DiffSchema = z.object({
  snapshotId: z.string(),
  since: z.string(),
  added: z.array(RefInfoSchema),
  removed: z.array(RefInfoSchema),
  changed: z.array(z.object({ ref: RefSchema, before: z.string(), after: z.string() })),
  text: z.string(),
  pageHashChanged: z.boolean(),
});
export type Diff = z.infer<typeof DiffSchema>;

export const NetEntrySchema = z.object({
  seq: z.number(),
  requestId: z.string(),
  tabId: z.string(),
  url: z.string(),
  method: z.string(),
  resourceType: z.string(),
  status: z.number().optional(),
  mimeType: z.string().optional(),
  requestHeaders: z.record(z.string()).optional(),
  responseHeaders: z.record(z.string()).optional(),
  encodedBytes: z.number().optional(),
  startedAt: z.number(),
  finishedAt: z.number().optional(),
  error: z.string().optional(),
});
export type NetEntry = z.infer<typeof NetEntrySchema>;

export const AuditEntrySchema = z.object({
  seq: z.number(),
  ts: z.number(),
  actor: z.string(),
  sessionId: z.string(),
  tabId: z.string().optional(),
  url: z.string().optional(),
  kind: z.string(),
  argsHash: z.string(),
  outcome: z.enum(["allow", "confirm", "block", "ok", "error", "kill"]),
  detail: z.string().optional(),
  prevHash: z.string(),
  hash: z.string(),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export const SessionInfoSchema = z.object({
  sessionId: z.string(),
  protocolVersion: z.string(),
  appVersion: z.string(),
  backend: z.string(),
  capabilities: z.array(z.string()),
  startedAt: z.number(),
  activeTabId: z.string().optional(),
  policyMode: z.enum(["permissive", "standard", "strict"]),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;

/* ---------------------------------------------------------------------- events */

const ev = <K extends string, T extends z.ZodRawShape>(kind: K, shape: T) =>
  z.object({ kind: z.literal(kind), ...shape });

export const EventSchema = z.discriminatedUnion("kind", [
  ev("tab.created", { tab: TabInfoSchema }),
  ev("tab.closed", { tabId: z.string() }),
  ev("tab.activated", { tabId: z.string() }),
  ev("tab.updated", { tabId: z.string(), url: z.string(), title: z.string(), loading: z.boolean() }),
  ev("nav.committed", { tabId: z.string(), url: z.string() }),
  ev("nav.loaded", { tabId: z.string(), url: z.string(), status: z.number().optional() }),
  ev("console.message", { tabId: z.string(), level: z.string(), text: z.string() }),
  ev("net.request", { tabId: z.string(), entry: NetEntrySchema }),
  ev("net.response", { tabId: z.string(), entry: NetEntrySchema }),
  ev("net.failed", { tabId: z.string(), entry: NetEntrySchema }),
  ev("dialog.opened", {
    tabId: z.string(),
    type: z.string(),
    message: z.string(),
    defaultPrompt: z.string().optional(),
  }),
  ev("download.started", { tabId: z.string(), url: z.string(), filename: z.string() }),
  ev("download.finished", { tabId: z.string(), path: z.string(), state: z.string() }),
  ev("action.started", { id: z.string(), tabId: z.string().optional(), kind: z.string() }),
  ev("action.finished", {
    id: z.string(),
    tabId: z.string().optional(),
    kind: z.string(),
    ok: z.boolean(),
    ms: z.number(),
  }),
  ev("human.input", { tabId: z.string(), inputKind: z.enum(["mouse", "keyboard", "wheel", "other"]) }),
  ev("human.released", { tabId: z.string() }),
  ev("agent.status", {
    state: z.enum(["idle", "working", "blocked", "paused"]),
    detail: z.string().optional(),
  }),
  ev("approval.requested", {
    id: z.string(),
    tabId: z.string().optional(),
    actionKind: z.string(),
    reason: z.string(),
    screenshotPath: z.string().optional(),
  }),
  ev("approval.resolved", { id: z.string(), approved: z.boolean() }),
  ev("audit.entry", { entry: AuditEntrySchema }),
]);
export type Event = z.infer<typeof EventSchema>;

/* -------------------------------------------------------------------- envelope */

export const ErrorCodeSchema = z.enum([
  "BAD_REQUEST",
  "UNAUTHORIZED",
  "NOT_FOUND",
  "STALE_REF",
  "NO_TARGET",
  "TIMEOUT",
  "NAV_FAILED",
  "TAB_CLOSED",
  "BLOCKED_BY_POLICY",
  "NEEDS_HUMAN",
  "CANCELLED",
  "BACKEND_ERROR",
  "UNSUPPORTED",
  "INTERNAL",
]);
export type ErrorCode = z.infer<typeof ErrorCodeSchema>;

export const RequestSchema = z.object({
  jsonrpc: z.literal("2.0").default("2.0"),
  id: z.string().min(1),
  method: z.enum(["act", "query", "ping", "cancel"]),
  params: z.unknown(),
  tabId: z.string().optional(),
  timeoutMs: z.number().int().positive().max(600_000).optional(),
});
export type Request = z.infer<typeof RequestSchema>;

export const ResponseMetaSchema = z.object({
  tabId: z.string().optional(),
  url: z.string().optional(),
  ms: z.number(),
  snapshotId: z.string().optional(),
  backend: z.string().optional(),
});
export type ResponseMeta = z.infer<typeof ResponseMetaSchema>;

export const ResponseSchema = z.object({
  jsonrpc: z.literal("2.0").default("2.0"),
  id: z.string(),
  ok: z.boolean(),
  result: z.unknown().optional(),
  error: z
    .object({
      code: ErrorCodeSchema,
      message: z.string(),
      details: z.unknown().optional(),
      retryable: z.boolean().optional(),
    })
    .optional(),
  meta: ResponseMetaSchema.optional(),
});
export type Response = z.infer<typeof ResponseSchema>;

/** Server -> client push frame. */
export const EventFrameSchema = z.object({
  jsonrpc: z.literal("2.0").default("2.0"),
  method: z.literal("event"),
  params: EventSchema,
});
export type EventFrame = z.infer<typeof EventFrameSchema>;

/* -------------------------------------------------------------------- helpers */

export class ZimReaperError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  readonly retryable: boolean;

  constructor(code: ErrorCode, message: string, opts: { details?: unknown; retryable?: boolean } = {}) {
    super(message);
    this.name = "ZimReaperError";
    this.code = code;
    this.details = opts.details;
    this.retryable = opts.retryable ?? false;
  }

  toJSON() {
    return { code: this.code, message: this.message, details: this.details, retryable: this.retryable };
  }

  static from(err: unknown, fallback: ErrorCode = "INTERNAL"): ZimReaperError {
    if (err instanceof ZimReaperError) return err;
    if (err instanceof z.ZodError) {
      return new ZimReaperError("BAD_REQUEST", "invalid request", { details: err.issues });
    }
    const message = err instanceof Error ? err.message : String(err);
    return new ZimReaperError(fallback, message);
  }
}

export function parseAction(input: unknown): Action {
  const parsed = ActionSchema.safeParse(input);
  if (!parsed.success) {
    throw new ZimReaperError("BAD_REQUEST", `invalid action: ${parsed.error.issues[0]?.message ?? "unknown"}`, {
      details: parsed.error.issues,
    });
  }
  return parsed.data;
}

export function parseQuery(input: unknown): Query {
  const parsed = QuerySchema.safeParse(input);
  if (!parsed.success) {
    throw new ZimReaperError("BAD_REQUEST", `invalid query: ${parsed.error.issues[0]?.message ?? "unknown"}`, {
      details: parsed.error.issues,
    });
  }
  return parsed.data;
}

/** Parse "Control+Shift+T" into modifiers + key. */
export function parseChord(chord: string): { key: string; modifiers: Modifier[] } {
  const parts = chord.split("+").map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) throw new ZimReaperError("BAD_REQUEST", "empty chord");
  const key = parts.pop() as string;
  const modifiers: Modifier[] = [];
  for (const raw of parts) {
    const norm = raw.toLowerCase();
    const m: Modifier | undefined =
      norm === "ctrl" || norm === "control"
        ? "Control"
        : norm === "alt" || norm === "option"
          ? "Alt"
          : norm === "meta" || norm === "cmd" || norm === "command" || norm === "super"
            ? "Meta"
            : norm === "shift"
              ? "Shift"
              : undefined;
    if (!m) throw new ZimReaperError("BAD_REQUEST", `unknown modifier: ${raw}`);
    modifiers.push(m);
  }
  return { key, modifiers };
}

export type { z };
