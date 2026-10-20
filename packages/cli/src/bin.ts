#!/usr/bin/env node
/**
 * zimreaper CLI
 *   zimreaper mcp [--port 7421] [--connect ws://127.0.0.1:7420]   run MCP over stdio
 *   zimreaper run "<task>" [--model ...] [--url ...]              autonomous loop
 *   zimreaper attach <cdp-endpoint>                                drive existing Chromium
 *   zimreaper info                                                 session + tabs
 *   zimreaper audit verify                                         check audit hash chain
 *   zimreaper replay <trace.jsonl> [--url U]                       re-run a recorded trace
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { ZimReaperError as ZimReaperErrorType } from "@zimreaper/protocol";

export const HELP = `zimreaper — agentic browser control

Usage:
  zimreaper mcp [--connect ws://127.0.0.1:PORT] [--token T] [--port N] [--launch]
  zimreaper run "<task>" [--url U] [--model M] [--provider openai|anthropic|custom:x] [--max-steps N]
  zimreaper attach <cdp-endpoint>
  zimreaper info
  zimreaper audit verify [--dir ~/.zimreaper]
  zimreaper replay <trace.jsonl> [--url U] [--continue] [--no-hash-check] [--json]
  zimreaper --help

Commands:
  mcp      Serve the browser tools over MCP stdio. Connects to a running control server,
           or starts a headless Chromium and control server in-process with --launch.
  run      Launch a headless Chromium, run one autonomous task, and print the final text.
  attach   Start a control server around an existing Chromium debug endpoint.
  info     Show the running session and its tabs.
  audit    Verify the hash-chained audit log.
  replay   Re-run a recorded trace as a test. Refs are re-bound by role and name, so a trace
           recorded yesterday still drives the right element today. Exits 1 on any divergence.

Environment:
  OPENAI_API_KEY, ANTHROPIC_API_KEY, or ZIMREAPER_API_KEY
  ZIMREAPER_PROVIDER_<NAME>_{BASE_URL,API_KEY,MODEL} for custom providers
  ZIMREAPER_HOME (default ~/.zimreaper)
`;

async function zimError(err: unknown): Promise<ZimReaperErrorType> {
  const { ZimReaperError } = await import("@zimreaper/protocol");
  return ZimReaperError.from(err);
}

/** Parses flags without a dependency. Command-specific validation happens in commands.ts. */
export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [command] = argv;
  if (!command || command === "--help" || command === "-h" || command === "help") {
    process.stdout.write(HELP);
    return 0;
  }
  try {
    const { parseArgs, runCommand } = await import("./commands.js");
    const parsed = parseArgs(argv);
    if (parsed.flags.get("help") === true) {
      process.stdout.write(HELP);
      return 0;
    }
    return await runCommand(command, parsed);
  } catch (err) {
    const zim = await zimError(err);
    process.stderr.write(`${zim.code}: ${zim.message}\n`);
    return 1;
  }
}

function isEntrypoint(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) return false;
  try {
    const current = realpathSync(fileURLToPath(import.meta.url));
    const invoked = realpathSync(resolve(entry));
    return pathToFileURL(invoked).href === pathToFileURL(current).href;
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  main()
    .then((code) => process.exit(code))
    .catch(async (err: unknown) => {
      const zim = await zimError(err);
      process.stderr.write(`${zim.code}: ${zim.message}\n`);
      process.exit(1);
    });
}
