import type { Event } from "@zimreaper/protocol";
import type { Backend } from "./backend.js";
import type { PolicyConfig } from "@zimreaper/policy";

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
}

export interface ControlServer {
  readonly port: number;
  readonly token: string;
  readonly url: string;
  readonly sessionId: string;
  on(listener: (event: Event) => void): () => void;
  close(): Promise<void>;
}

export function controlTokenPath(): string {
  const home = process.env.HOME ?? ".";
  return `${home}/.zimreaper/control.token`;
}

export function zimReaperHome(): string {
  return process.env.ZIMREAPER_HOME ?? `${process.env.HOME ?? "."}/.zimreaper`;
}

export async function startControlServer(_opts: ControlServerOptions): Promise<ControlServer> {
  throw new Error("startControlServer not implemented yet");
}
