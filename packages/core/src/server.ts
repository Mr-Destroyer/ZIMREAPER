import { randomBytes, timingSafeEqual } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import type {
  Action,
  AuditEntry,
  Event,
  Request,
  ResponseMeta,
  SessionInfo,
} from "@zimreaper/protocol";
import { PROTOCOL_VERSION, ZimReaperError, parseAction, parseQuery } from "@zimreaper/protocol";
import { createPerception, type Perception } from "@zimreaper/perception";
import { createPolicy, type PolicyConfig, type PolicyEngine } from "@zimreaper/policy";
import type { Backend } from "./backend.js";
import { Executor, canonicalHash, type ActionContext } from "./executor.js";
import { createLogger } from "./logger.js";

export interface ControlServerOptions {
  backend: Backend;
  /** Generated per process start when omitted; written 0600 to controlTokenPath(). */
  token?: string;
  port?: number;
  host?: string;
  artifactsDir?: string;
  policyDir?: string;
  policy?: Partial<PolicyConfig>;
  sessionId?: string;
  appVersion?: string;
  /** Injected for tests. */
  now?: () => number;
  /** Prebuilt engines, used by tests and by the Electron main process. */
  executor?: Executor;
  perception?: Perception;
  policyEngine?: PolicyEngine;
  /** Token file location; defaults to controlTokenPath(). Tests point this at a temp dir. */
  tokenPath?: string;
  /** Default per-request deadline when the frame carries no timeoutMs. */
  requestTimeoutMs?: number;
}

export interface ControlServer {
  readonly port: number;
  readonly token: string;
  readonly url: string;
  readonly sessionId: string;
  on(listener: (event: Event) => void): () => void;
  /** Resolve a parked approval (HUD, CLI). Unknown ids are ignored. */
  resolveApproval(id: string, approved: boolean): void;
  close(): Promise<void>;
}

export function controlTokenPath(): string {
  const home = process.env.HOME ?? ".";
  return `${home}/.zimreaper/control.token`;
}

export function zimReaperHome(): string {
  return process.env.ZIMREAPER_HOME ?? `${process.env.HOME ?? "."}/.zimreaper`;
}

const log = createLogger("core:server");

interface ClientState {
  socket: WebSocket;
  authorized: boolean;
  actor: string;
  alive: boolean;
}

interface PendingApproval {
  resolve: (approved: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

const LOCAL_ORIGIN = /^(https?:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d+)?|file:\/\/.*|app:\/\/.*|null)$/i;

function isAllowedOrigin(origin: string | undefined): boolean {
  // Node clients (CLI, MCP) send no Origin; browsers must be local.
  if (!origin) return true;
  return LOCAL_ORIGIN.test(origin);
}

class ControlServerImpl implements ControlServer {
  readonly token: string;
  readonly sessionId: string;
  readonly url: string;
  port = 0;

  private readonly backend: Backend;
  private readonly appVersion: string;
  private readonly artifactsDir: string;
  private readonly policyDir: string;
  private readonly policyConfig?: Partial<PolicyConfig>;
  private readonly now: () => number;
  private readonly requestTimeoutMs: number;
  private readonly startedAt: number;
  private readonly wss: WebSocketServer;
  private readonly clients = new Set<ClientState>();
  private readonly listeners = new Set<(event: Event) => void>();
  private readonly approvals = new Map<string, PendingApproval>();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly inFlight = new Map<AbortController, string>();
  private readonly unsubBackend: () => void;
  private executor?: Executor;
  private perception?: Perception;
  private policyEngine?: PolicyEngine;
  private approvalSeq = 0;
  private closed = false;

  constructor(opts: ControlServerOptions, port: number, wss: WebSocketServer) {
    this.backend = opts.backend;
    this.token = opts.token ?? randomBytes(32).toString("hex");
    this.sessionId = opts.sessionId ?? `s${randomBytes(6).toString("hex")}`;
    this.appVersion = opts.appVersion ?? "0.1.0";
    this.artifactsDir = opts.artifactsDir ?? `${zimReaperHome()}/artifacts/${this.sessionId}`;
    this.policyDir = opts.policyDir ?? zimReaperHome();
    this.policyConfig = opts.policy;
    this.now = opts.now ?? (() => Date.now());
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 15_000;
    this.executor = opts.executor;
    this.perception = opts.perception;
    this.policyEngine = opts.policyEngine;
    this.startedAt = this.now();
    this.wss = wss;
    this.port = port;
    this.url = `ws://127.0.0.1:${port}`;
    this.unsubBackend = this.backend.on((event) => this.emit(event));
    this.wss.on("connection", (socket, request) => {
      if (!isAllowedOrigin(request.headers.origin)) {
        socket.close(1008, "forbidden origin");
        return;
      }
      this.onConnection(socket);
    });
  }

  on(listener: (event: Event) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  resolveApproval(id: string, approved: boolean): void {
    const pending = this.approvals.get(id);
    if (!pending) return;
    this.approvals.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(approved);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const controller of this.inFlight.keys()) controller.abort();
    this.inFlight.clear();
    for (const [id, pending] of this.approvals) {
      clearTimeout(pending.timer);
      pending.resolve(false);
      this.approvals.delete(id);
    }
    this.unsubBackend();
    for (const client of this.clients) {
      try {
        client.socket.close(1001, "server shutting down");
      } catch {
        client.socket.terminate();
      }
    }
    this.clients.clear();
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => resolve(), 1_000);
      this.wss.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    this.listeners.clear();
  }

  /* ------------------------------------------------------------- connection */

  private onConnection(socket: WebSocket): void {
    const client: ClientState = { socket, authorized: false, actor: "unknown", alive: true };
    this.clients.add(client);
    socket.on("message", (raw) => {
      void this.onFrame(client, raw.toString());
    });
    socket.on("close", () => {
      client.alive = false;
      this.clients.delete(client);
    });
    socket.on("error", (err: Error) => {
      log.debug("client socket error", { error: err.message });
    });
    // An unauthenticated socket gets one frame of grace, then we drop it.
    const timer = setTimeout(() => {
      if (!client.authorized) socket.close(4401, "handshake required");
    }, 10_000);
    socket.on("close", () => clearTimeout(timer));
  }

  private async onFrame(client: ClientState, raw: string): Promise<void> {
    let frame: Record<string, unknown>;
    try {
      frame = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      client.socket.close(4400, "invalid json");
      return;
    }

    if (!client.authorized) {
      this.handshake(client, frame);
      return;
    }

    const id = typeof frame.id === "string" ? frame.id : undefined;
    if (!id) {
      this.sendError(client, "0", new ZimReaperError("BAD_REQUEST", "request id required"));
      return;
    }
    const method = typeof frame.method === "string" ? frame.method : "";
    if (!["act", "query", "ping", "cancel"].includes(method)) {
      this.sendError(client, id, new ZimReaperError("BAD_REQUEST", `unknown method ${method}`));
      return;
    }
    const request = frame as unknown as Request;

    try {
      const result = await this.route(client, request);
      this.send(client, { jsonrpc: "2.0", id, ok: true, result: result.result, meta: result.meta });
    } catch (err) {
      const error = ZimReaperError.from(err);
      if (error.code === "INTERNAL") log.error("request failed", { id, method, error: error.message });
      this.sendError(client, id, error);
    }
  }

  private handshake(client: ClientState, frame: Record<string, unknown>): void {
    const params = (frame.params ?? {}) as Record<string, unknown>;
    const supplied = typeof params.token === "string" ? params.token : "";
    const id = typeof frame.id === "string" ? frame.id : "0";
    if (frame.method !== "ping" || !this.tokenMatches(supplied)) {
      client.socket.close(4401, "unauthorized");
      return;
    }
    client.authorized = true;
    client.actor = typeof params.client === "string" ? params.client : "unknown";
    this.send(client, {
      jsonrpc: "2.0",
      id,
      ok: true,
      result: {
        pong: true,
        sessionId: this.sessionId,
        protocolVersion: PROTOCOL_VERSION,
        appVersion: this.appVersion,
        backend: this.backend.name,
        serverTime: this.now(),
      },
      meta: { ms: 0, backend: this.backend.name },
    });
  }

  private tokenMatches(supplied: string): boolean {
    const a = Buffer.from(supplied);
    const b = Buffer.from(this.token);
    if (a.length !== b.length) return false;
    return timingSafeEqual(a, b);
  }

  /* ---------------------------------------------------------------- routing */

  private async route(
    client: ClientState,
    request: Request,
  ): Promise<{ result: unknown; meta: ResponseMeta }> {
    const started = this.now();
    switch (request.method) {
      case "ping":
        return { result: { pong: true, sessionId: this.sessionId }, meta: { ms: 0 } };
      case "cancel": {
        const params = (request.params ?? {}) as { tabId?: string };
        const tabId = params.tabId ?? request.tabId;
        const cancelled = this.cancel(tabId);
        return { result: { cancelled }, meta: { ms: this.now() - started } };
      }
      case "act": {
        const action = parseAction(request.params);
        return this.act(client, request, action);
      }
      case "query": {
        const query = parseQuery(request.params);
        if (query.kind === "session.info") {
          return { result: await this.sessionInfo(), meta: { ms: this.now() - started, backend: this.backend.name } };
        }
        const tabId = request.tabId ?? this.backend.activeTabId() ?? (await this.backend.listTabs())[0]?.tabId;
        if (!tabId) throw new ZimReaperError("NO_TARGET", "no tabs open");
        const executor = await this.getExecutor();
        const controller = new AbortController();
        const result = await this.withDeadline(
          executor.query(query, this.context(tabId, request.id, client.actor, controller.signal)),
          request.timeoutMs ?? this.requestTimeoutMs,
          () => controller.abort(),
        );
        const tab = await this.backend.getTab(tabId).catch(() => undefined);
        return {
          result,
          meta: { tabId, url: tab?.url, ms: this.now() - started, backend: this.backend.name },
        };
      }
      default:
        throw new ZimReaperError("BAD_REQUEST", `unknown method ${request.method}`);
    }
  }

  private async act(
    client: ClientState,
    request: Request,
    action: Action,
  ): Promise<{ result: unknown; meta: ResponseMeta }> {
    const started = this.now();
    const tabId = request.tabId ?? this.backend.activeTabId() ?? (await this.backend.listTabs())[0]?.tabId;
    if (!tabId) throw new ZimReaperError("NO_TARGET", "no tabs open");
    const url = (await this.backend.getTab(tabId).catch(() => undefined))?.url;
    const argsHash = canonicalHash(action);
    const policy = await this.getPolicy();
    const decision = policy.preflight(action, { url, actor: client.actor });

    if (decision.verdict === "block") {
      this.record({ actor: client.actor, tabId, url, kind: action.kind, argsHash, outcome: "block", detail: decision.reason });
      throw new ZimReaperError("BLOCKED_BY_POLICY", decision.reason, { details: { kind: action.kind } });
    }

    if (decision.verdict === "confirm") {
      const approvalId = decision.approvalId ?? `ap${++this.approvalSeq}`;
      this.emit({
        kind: "approval.requested",
        id: approvalId,
        tabId,
        actionKind: action.kind,
        reason: decision.reason,
      });
      const approved = await this.awaitApproval(approvalId, policy.config().approvalTimeoutMs);
      this.emit({ kind: "approval.resolved", id: approvalId, approved });
      if (!approved) {
        this.record({
          actor: client.actor,
          tabId,
          url,
          kind: action.kind,
          argsHash,
          outcome: "block",
          detail: `approval ${approvalId} denied or timed out`,
        });
        throw new ZimReaperError("NEEDS_HUMAN", `${action.kind} requires human approval: ${decision.reason}`, {
          details: { approvalId, kind: action.kind },
        });
      }
    }

    this.emit(this.actionEvent("action.started", { id: request.id, tabId, actionKind: action.kind }));
    const executor = await this.getExecutor();
    const controller = new AbortController();
    this.inFlight.set(controller, tabId);
    try {
      const ctx = this.context(tabId, request.id, client.actor, controller.signal);
      const result = await this.withDeadline(
        this.enqueue(tabId, () => executor.act(action, ctx)),
        request.timeoutMs ?? this.requestTimeoutMs,
        () => controller.abort(),
      );
      const ms = this.now() - started;
      this.emit(this.actionEvent("action.finished", { id: request.id, tabId, actionKind: action.kind, ok: true, ms }));
      const after = await this.backend.getTab(tabId).catch(() => undefined);
      this.record({
        actor: client.actor,
        tabId,
        url: after?.url ?? url,
        kind: action.kind,
        argsHash,
        outcome: "ok",
      });
      return {
        result,
        meta: { tabId, url: after?.url ?? url, ms, backend: this.backend.name },
      };
    } catch (err) {
      const error = ZimReaperError.from(err);
      const ms = this.now() - started;
      this.emit(
        this.actionEvent("action.finished", { id: request.id, tabId, actionKind: action.kind, ok: false, ms }),
      );
      this.record({
        actor: client.actor,
        tabId,
        url,
        kind: action.kind,
        argsHash,
        outcome: "error",
        detail: `${error.code}: ${error.message}`,
      });
      throw error;
    } finally {
      this.inFlight.delete(controller);
    }
  }

  private context(tabId: string, requestId: string, actor: string, signal: AbortSignal): ActionContext {
    return { tabId, requestId, actor, signal };
  }

  /**
   * `action.*` events carry the event discriminator in `kind` and the action's kind in
   * `actionKind` — the two cannot share a field.
   */
  private actionEvent(
    kind: "action.started",
    payload: { id: string; tabId?: string; actionKind: string },
  ): Event;
  private actionEvent(
    kind: "action.finished",
    payload: { id: string; tabId?: string; actionKind: string; ok: boolean; ms: number },
  ): Event;
  private actionEvent(
    kind: "action.started" | "action.finished",
    payload: { id: string; tabId?: string; actionKind: string; ok?: boolean; ms?: number },
  ): Event {
    return kind === "action.started"
      ? { kind, id: payload.id, tabId: payload.tabId, actionKind: payload.actionKind }
      : {
          kind,
          id: payload.id,
          tabId: payload.tabId,
          actionKind: payload.actionKind,
          ok: payload.ok ?? false,
          ms: payload.ms ?? 0,
        };
  }

  private cancel(tabId?: string): number {
    let cancelled = 0;
    for (const [controller, controllerTab] of this.inFlight) {
      if (tabId && controllerTab !== tabId) continue;
      controller.abort();
      cancelled += 1;
    }
    cancelled += this.executor?.cancel(tabId) ?? 0;
    return cancelled;
  }

  /** One FIFO chain per tab: mutating actions on the same tab never interleave. */
  private enqueue<T>(tabId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(tabId) ?? Promise.resolve();
    const run = previous.then(task, task);
    this.queues.set(
      tabId,
      run.then(
        () => undefined,
        () => undefined,
      ),
    );
    return run;
  }

  private async withDeadline<T>(promise: Promise<T>, ms: number, onTimeout: () => void): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        onTimeout();
        reject(new ZimReaperError("TIMEOUT", `request timed out after ${ms}ms`, { retryable: true }));
      }, ms);
    });
    try {
      return await Promise.race([promise, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private awaitApproval(id: string, timeoutMs: number): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => {
        this.approvals.delete(id);
        resolve(false);
      }, timeoutMs);
      this.approvals.set(id, { resolve, timer });
    });
  }

  /* ----------------------------------------------------------------- engines */

  private async getPolicy(): Promise<PolicyEngine> {
    if (this.policyEngine) return this.policyEngine;
    this.policyEngine = await createPolicy({
      dir: this.policyDir,
      sessionId: this.sessionId,
      ...(this.policyConfig ? { config: this.policyConfig } : {}),
      now: this.now,
    });
    return this.policyEngine;
  }

  private async getExecutor(): Promise<Executor> {
    if (this.executor) return this.executor;
    const policy = await this.getPolicy();
    const perception =
      this.perception ??
      createPerception({
        send: (tabId) => (method, params) => this.backend.send(tabId, method, params),
      });
    this.executor = new Executor({
      backend: this.backend,
      perception,
      policy,
      artifactsDir: this.artifactsDir,
      now: this.now,
    });
    return this.executor;
  }

  private async sessionInfo(): Promise<SessionInfo> {
    const policy = await this.getPolicy().catch(() => undefined);
    return {
      sessionId: this.sessionId,
      protocolVersion: PROTOCOL_VERSION,
      appVersion: this.appVersion,
      backend: this.backend.name,
      capabilities: this.backend.capabilities().domains,
      startedAt: this.startedAt,
      activeTabId: this.backend.activeTabId(),
      policyMode: policy?.config().mode ?? "standard",
    };
  }

  private record(entry: {
    actor: string;
    tabId?: string;
    url?: string;
    kind: string;
    argsHash: string;
    outcome: AuditEntry["outcome"];
    detail?: string;
  }): void {
    if (!this.policyEngine) return;
    try {
      const record = this.policyEngine.record({
        ts: this.now(),
        actor: entry.actor,
        sessionId: this.sessionId,
        tabId: entry.tabId,
        url: entry.url,
        kind: entry.kind,
        argsHash: entry.argsHash,
        outcome: entry.outcome,
        detail: entry.detail,
      });
      this.emit({ kind: "audit.entry", entry: record });
    } catch (err) {
      log.warn("audit record failed", { error: String(err) });
    }
  }

  /* ------------------------------------------------------------------ frames */

  private emit(event: Event): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        log.warn("listener threw", { error: String(err) });
      }
    }
    const frame = JSON.stringify({ jsonrpc: "2.0", method: "event", params: event });
    for (const client of this.clients) {
      if (!client.authorized) continue;
      try {
        client.socket.send(frame);
      } catch {
        client.alive = false;
      }
    }
  }

  private send(client: ClientState, frame: Record<string, unknown>): void {
    try {
      client.socket.send(JSON.stringify(frame));
    } catch (err) {
      log.debug("send failed", { error: String(err) });
    }
  }

  private sendError(client: ClientState, id: string, error: ZimReaperError): void {
    this.send(client, {
      jsonrpc: "2.0",
      id,
      ok: false,
      error: {
        code: error.code,
        message: error.message,
        details: error.details,
        retryable: error.retryable,
      },
    });
  }
}

async function writeTokenFile(path: string, token: string): Promise<void> {
  try {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${token}\n`, { mode: 0o600 });
  } catch (err) {
    log.warn("cannot write control token", { path, error: String(err) });
  }
}

export async function startControlServer(opts: ControlServerOptions): Promise<ControlServer> {
  const host = opts.host ?? "127.0.0.1";
  const wss = new WebSocketServer({ host, port: opts.port ?? 0 });
  await new Promise<void>((resolve, reject) => {
    wss.once("listening", () => resolve());
    wss.once("error", (err: Error) =>
      reject(new ZimReaperError("INTERNAL", `control server failed to listen: ${err.message}`)),
    );
  });
  const address = wss.address();
  const port = typeof address === "object" && address ? address.port : 0;
  const server = new ControlServerImpl(opts, port, wss);
  await writeTokenFile(opts.tokenPath ?? controlTokenPath(), server.token);
  log.info("control server listening", { port, sessionId: server.sessionId });
  return server;
}
