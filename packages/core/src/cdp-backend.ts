import type { Backend } from "./backend.js";
import { ZimReaperError } from "@zimreaper/protocol";

export interface CdpBackendOptions {
  /** Existing debug endpoint, e.g. http://127.0.0.1:9222 */
  endpoint?: string;
  executablePath?: string;
  userDataDir?: string;
  headless?: boolean;
  args?: string[];
  /** Default navigation timeout. */
  timeoutMs?: number;
}

/** Launch (or attach to) a Chromium and drive it over CDP. Used by tests and `zimreaper attach`. */
export async function launchCdpBackend(_opts?: CdpBackendOptions): Promise<Backend> {
  throw new ZimReaperError("UNSUPPORTED", "launchCdpBackend not implemented yet");
}

export async function connectCdpBackend(_endpoint: string): Promise<Backend> {
  throw new ZimReaperError("UNSUPPORTED", "connectCdpBackend not implemented yet");
}
