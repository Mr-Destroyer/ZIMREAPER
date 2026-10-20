/**
 * Command implementations for the zimreaper operator CLI.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentLoop, createProvider, type AgentEvent } from "@zimreaper/agent";
import {
  ControlClient,
  connectCdpBackend,
  controlTokenPath,
  launchCdpBackend,
  startControlServer,
  zimReaperHome,
  type Backend,
  type ControlServer,
} from "@zimreaper/core";
import { browserTools, runStdio } from "@zimreaper/mcp-server";
import { AuditLog } from "@zimreaper/policy";
import { ZimReaperError, type SessionInfo, type TabInfo } from "@zimreaper/protocol";

const DEFAULT_CONTROL_PORT = 7420;
const DEFAULT_MODEL = "gpt-4.1-mini";


export interface ParsedArgs {
  positional: string[];
  flags: Map<string, string | true>;
}

const VALUE_FLAGS = new Set([
  "connect",
  "token",
  "port",
  "url",
  "model",
  "provider",
  "max-steps",
  "dir",
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags = new Map<string, string | true>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === "--") {
      positional.push(...argv.slice(index + 1));
      break;
    }
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const eq = arg.indexOf("=");
    const name = (eq >= 0 ? arg.slice(2, eq) : arg.slice(2)).trim();
    if (!name) throw new ZimReaperError("BAD_REQUEST", "empty flag");
    if (eq >= 0) {
      flags.set(name, arg.slice(eq + 1));
      continue;
    }
    if (VALUE_FLAGS.has(name)) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new ZimReaperError("BAD_REQUEST", `--${name} requires a value`);
      }
      flags.set(name, value);
      index += 1;
    } else {
      flags.set(name, true);
    }
  }
  return { positional, flags };
}

function flagString(flags: ParsedArgs["flags"], name: string): string | undefined {
  const value = flags.get(name);
  if (value === undefined) return undefined;
  if (value === true) throw new ZimReaperError("BAD_REQUEST", `--${name} requires a value`);
  return value;
}

function flagNumber(flags: ParsedArgs["flags"], name: string): number | undefined {
  const value = flagString(flags, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0 || parsed > 65_535) {
    throw new ZimReaperError("BAD_REQUEST", `--${name} must be a port number`);
  }
  return parsed;
}

function flagInt(flags: ParsedArgs["flags"], name: string): number | undefined {
  const value = flagString(flags, name);
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) {
    throw new ZimReaperError("BAD_REQUEST", `--${name} must be a positive integer`);
  }
  return parsed;
}

function connectUrl(flags: ParsedArgs["flags"]): string {
  const explicit = flagString(flags, "connect");
  if (explicit) return explicit;
  const port = flagNumber(flags, "port") ?? DEFAULT_CONTROL_PORT;
  return `ws://127.0.0.1:${port}`;
}

interface EndpointFile {
  url?: string;
  port?: number;
  token?: string;
  sessionId?: string;
  pid?: number;
}

/** Read ~/.zimreaper/endpoint.json written by the app or `zimreaper attach`. */
export async function readEndpoint(): Promise<EndpointFile | undefined> {
  try {
    const raw = await readFile(join(zimReaperHome(), "endpoint.json"), "utf8");
    const parsed = JSON.parse(raw) as EndpointFile;
    if (!parsed || typeof parsed.url !== "string" || typeof parsed.token !== "string") return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

async function resolveConnection(
  flags: ParsedArgs["flags"],
): Promise<{ url: string; token: string }> {
  const explicitUrl = flagString(flags, "connect");
  const explicitToken = flagString(flags, "token");
  if (explicitUrl && explicitToken) return { url: explicitUrl, token: explicitToken };
  const endpoint = await readEndpoint();
  const url = explicitUrl ?? endpoint?.url ?? connectUrl(flags);
  const token = explicitToken ?? endpoint?.token ?? (await readControlToken(flags));
  return { url, token };
}

async function readControlToken(flags: ParsedArgs["flags"]): Promise<string> {
  const explicit = flagString(flags, "token");
  if (explicit) return explicit;
  try {
    const token = (await readFile(controlTokenPath(), "utf8")).trim();
    if (!token) throw new Error("empty token file");
    return token;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new ZimReaperError(
      "UNAUTHORIZED",
      `cannot read control token at ${controlTokenPath()} (${message}); pass --token, start the app, or use --launch`,
    );
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function env(name: string): string | undefined {
  const value = process.env[name];
  return value !== undefined && value.length > 0 ? value : undefined;
}

export function providerSpec(flags: ParsedArgs["flags"]): { kind: string; model: string } {
  const kind = flagString(flags, "provider") ?? env("ZIMREAPER_PROVIDER") ?? "openai";
  const defaultModel = kind.startsWith("custom:")
    ? ""
    : kind === "anthropic"
      ? "claude-sonnet-4-20250514"
      : DEFAULT_MODEL;
  const model = flagString(flags, "model") ?? env("ZIMREAPER_MODEL") ?? defaultModel;
  return { kind, model };
}

function eventLine(event: AgentEvent): string | undefined {
  switch (event.kind) {
    case "step":
      return `[step ${event.step ?? "?"}]`;
    case "tool":
      return `[tool ${event.tool ?? "?"}] ${event.ok === false ? "error" : "ok"}${event.detail ? `: ${event.detail.split("\n")[0] ?? ""}` : ""}`;
    case "text":
      return event.text ? `[text] ${event.text}` : undefined;
    case "done":
      return event.ok === false ? `[done] failed` : `[done]`;
    case "error":
      return `[error] ${event.detail ?? "unknown"}`;
  }
}

function printTabs(tabs: TabInfo[]): string {
  if (tabs.length === 0) return "No tabs.";
  const rows = tabs.map((tab) => ({
    id: tab.tabId,
    active: tab.active ? "*" : "",
    loading: tab.loading ? "loading" : "",
    title: tab.title,
    url: tab.url,
  }));
  const idWidth = Math.max(2, ...rows.map((row) => row.id.length));
  const titleWidth = Math.max(5, ...rows.map((row) => row.title.length));
  return [
    `${"ID".padEnd(idWidth)}  A  ${"TITLE".padEnd(titleWidth)}  URL`,
    ...rows.map(
      (row) =>
        `${row.id.padEnd(idWidth)}  ${row.active.padEnd(1)}  ${row.title.padEnd(titleWidth)}  ${row.url}`,
    ),
  ].join("\n");
}

async function withLaunchedBackend<T>(
  fn: (backend: Backend, server: ControlServer) => Promise<T>,
  opts: { url?: string; port?: number } = {},
): Promise<T> {
  const backend = await launchCdpBackend({ headless: true });
  let server: ControlServer | undefined;
  try {
    server = await startControlServer({ backend, ...(opts.port !== undefined ? { port: opts.port } : {}) });
    if (opts.url) {
      const client = await ControlClient.connect({
        url: server.url,
        token: server.token,
        client: "cli",
      });
      try {
        await client.act({ kind: "nav.goto", url: opts.url, waitUntil: "load" });
      } finally {
        client.close();
      }
    }
    return await fn(backend, server);
  } catch (err) {
    throw ZimReaperError.from(err, "BACKEND_ERROR");
  } finally {
    if (server) await server.close().catch(() => undefined);
    await backend.close().catch(() => undefined);
  }
}

function waitForShutdown(): Promise<void> {
  if (process.stdin.isTTY) {
    return new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
  }
  if (process.stdin.readableEnded) return Promise.resolve();
  return new Promise<void>((resolve) => {
    process.stdin.once("end", resolve);
    process.stdin.once("close", resolve);
    process.once("SIGINT", resolve);
    process.once("SIGTERM", resolve);
  });
}

async function commandMcp(parsed: ParsedArgs): Promise<number> {
  const launch = parsed.flags.get("launch") === true;
  if (launch) {
    const port = flagNumber(parsed.flags, "port");
    return withLaunchedBackend(
      async (_backend, server) => {
        const client = await ControlClient.connect({
          url: server.url,
          token: server.token,
          client: "mcp",
        });
        try {
          const running = await runStdio({ client });
          try {
            await waitForShutdown();
          } finally {
            await running.close().catch(() => undefined);
          }
          return 0;
        } finally {
          client.close();
        }
      },
      port !== undefined ? { port } : {},
    );
  }
  const { url, token } = await resolveConnection(parsed.flags);
  const client = await ControlClient.connect({
    url,
    token,
    client: "mcp",
  });
  try {
    await runStdio({ client });
    await waitForShutdown();
    return 0;
  } finally {
    client.close();
  }
}

async function commandRun(parsed: ParsedArgs): Promise<number> {
  const task = parsed.positional[1];
  if (!task || task.trim().length === 0) {
    throw new ZimReaperError("BAD_REQUEST", 'run requires a task: zimreaper run "<task>"');
  }
  const { kind, model } = providerSpec(parsed.flags);
  const baseUrl = env("ZIMREAPER_BASE_URL");
  const provider = createProvider({ kind, model, ...(baseUrl ? { baseUrl } : {}) });
  const url = flagString(parsed.flags, "url");
  const maxSteps = flagInt(parsed.flags, "max-steps") ?? 25;

  return withLaunchedBackend(
    async (_backend, server) => {
      const client = await ControlClient.connect({
        url: server.url,
        token: server.token,
        client: "cli",
      });
      try {
        const loop = new AgentLoop({
          provider,
          tools: browserTools(client),
          maxSteps,
          onEvent(event) {
            const line = eventLine(event);
            if (line) process.stderr.write(`${line}\n`);
          },
        });
        const result = await loop.run(task);
        process.stdout.write(`${result.text.endsWith("\n") ? result.text : `${result.text}\n`}`);
        return result.ok ? 0 : 1;
      } finally {
        client.close();
      }
    },
    url ? { url } : {},
  );
}

async function commandAttach(parsed: ParsedArgs): Promise<number> {
  const endpoint = parsed.positional[1];
  if (!endpoint) {
    throw new ZimReaperError("BAD_REQUEST", "attach requires a CDP endpoint, e.g. http://127.0.0.1:9222");
  }
  const backend = await connectCdpBackend(endpoint);
  let server: ControlServer | undefined;
  try {
    server = await startControlServer({ backend });
    process.stdout.write(`${JSON.stringify({ url: server.url, token: server.token })}\n`);
    await new Promise<void>((resolve) => {
      process.once("SIGINT", resolve);
      process.once("SIGTERM", resolve);
    });
    return 0;
  } finally {
    if (server) await server.close().catch(() => undefined);
    await backend.close().catch(() => undefined);
  }
}

async function commandInfo(parsed: ParsedArgs): Promise<number> {
  const { url, token } = await resolveConnection(parsed.flags);
  const client = await ControlClient.connect({
    url,
    token,
    client: "cli",
  });
  try {
    const info = await client.query<SessionInfo>({ kind: "session.info" });
    const rawTabs = await client.query<unknown>({ kind: "tab.list" });
    const tabs: TabInfo[] = Array.isArray(rawTabs)
      ? (rawTabs as TabInfo[])
      : isRecord(rawTabs) && Array.isArray(rawTabs.tabs)
        ? (rawTabs.tabs as TabInfo[])
        : [];
    process.stdout.write(
      [
        `session  ${info.sessionId}`,
        `backend  ${info.backend}`,
        `policy   ${info.policyMode}`,
        `version  ${info.appVersion} (protocol ${info.protocolVersion})`,
        "",
        printTabs(tabs),
        "",
      ].join("\n"),
    );
    return 0;
  } finally {
    client.close();
  }
}

async function commandAudit(parsed: ParsedArgs): Promise<number> {
  const op = parsed.positional[1];
  if (op !== "verify") {
    throw new ZimReaperError("BAD_REQUEST", "audit supports only: verify");
  }
  const dir = flagString(parsed.flags, "dir") ?? zimReaperHome();
  const audit = new AuditLog(dir, "cli-audit-verify", Date.now);
  const result = audit.verifyChain();
  if (result.ok) {
    process.stdout.write(`audit chain ok (${result.entries} entries) in ${dir}\n`);
    return 0;
  }
  process.stderr.write(
    `INTERNAL: audit chain broken at entry ${result.brokenAt ?? "?"} (${result.entries} entries checked) in ${dir}\n`,
  );
  return 1;
}

export async function runCommand(command: string, parsed: ParsedArgs): Promise<number> {
  switch (command) {
    case "mcp":
      return commandMcp(parsed);
    case "run":
      return commandRun(parsed);
    case "attach":
      return commandAttach(parsed);
    case "info":
      return commandInfo(parsed);
    case "audit":
      return commandAudit(parsed);
    default:
      throw new ZimReaperError("BAD_REQUEST", `unknown command: ${command}; see zimreaper --help`);
  }
}
