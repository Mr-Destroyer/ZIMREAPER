#!/usr/bin/env node
/**
 * zimreaper CLI
 *   zimreaper mcp [--port 7421] [--connect ws://127.0.0.1:7420]   run MCP over stdio
 *   zimreaper run "<task>" [--model ...] [--url ...]              autonomous loop
 *   zimreaper attach <cdp-endpoint>                                drive existing Chromium
 *   zimreaper info                                                 session + tabs
 *   zimreaper audit verify                                         check audit hash chain
 */
import { ZimReaperError } from "@zimreaper/protocol";

export async function main(argv: string[] = process.argv.slice(2)): Promise<number> {
  const [command] = argv;
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(
      [
        "zimreaper — agentic browser control",
        "",
        "  zimreaper mcp [--port N] [--connect URL]  serve MCP tools over stdio",
        "  zimreaper run \"<task>\" [--url URL]        run an autonomous task",
        "  zimreaper attach <cdp-endpoint>           drive an existing Chromium",
        "  zimreaper info                            show session and tabs",
        "  zimreaper audit verify                    verify the audit hash chain",
        "",
      ].join("\n"),
    );
    return 0;
  }
  throw new ZimReaperError("UNSUPPORTED", `command not implemented: ${command}`);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main()
    .then((code) => process.exit(code))
    .catch((err: unknown) => {
      process.stderr.write(`${ZimReaperError.from(err).code}: ${(err as Error).message}\n`);
      process.exit(1);
    });
}
