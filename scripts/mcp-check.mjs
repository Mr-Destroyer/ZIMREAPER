#!/usr/bin/env node
/**
 * Prove the MCP surface: spawn `zimreaper mcp --launch`, list tools, then drive the fixture
 * through MCP tool calls only (no direct control client).
 */
import { spawn } from "node:child_process";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const ROOT = "/home/zim/Projects/ZIMREAPER";
const PORT = "4316";
const fx = spawn(process.execPath, [path.join(ROOT, "fixtures/site/server.mjs")], {
  env: { ...process.env, PORT },
  stdio: "ignore",
});
await new Promise((r) => setTimeout(r, 700));

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(ROOT, "packages/cli/dist/bin.js"), "mcp", "--launch"],
  env: { ...process.env, ZIMREAPER_HOME: "/tmp/zr-mcp-home", ZIMREAPER_LOG: "warn" },
  stderr: "pipe",
});
const client = new Client({ name: "zimreaper-check", version: "0.0.1" });
await client.connect(transport);

const { tools } = await client.listTools();
console.log(`TOOLS ${tools.length}`);
for (const t of tools) console.log(" -", t.name);

const call = async (name, args) => {
  const res = await client.callTool({ name, arguments: args });
  const text = (res.content ?? []).filter((c) => c.type === "text").map((c) => c.text).join("\n");
  if (res.isError) throw new Error(`${name} failed: ${text}`);
  return text;
};

console.log("\n--- browser_navigate");
console.log((await call("browser_navigate", { url: `http://127.0.0.1:${PORT}/login` })).slice(0, 200));

console.log("\n--- browser_snapshot");
const snap = await call("browser_snapshot", { maxChars: 3000 });
console.log(snap.slice(0, 700));

const refOf = (text, role, re) => {
  for (const line of text.split("\n")) {
    const m = line.match(/^\[(e\d+)\]\s+(\S+)\s+"([^"]*)"/);
    if (m && m[2] === role && re.test(m[3])) return m[1];
  }
  return null;
};
const emailRef = refOf(snap, "textbox", /e-?mail/i);
const passRef = refOf(snap, "textbox", /pass/i);
const btnRef = refOf(snap, "button", /sign in/i);
console.log("\nrefs:", emailRef, passRef, btnRef);

console.log("\n--- click + type");
await call("browser_click", { ref: emailRef });
await call("browser_type", { text: "mcp@zimreaper.dev" });
await call("browser_click", { ref: passRef });
await call("browser_type", { text: "zimreaper" });
await call("browser_click", { ref: btnRef });
console.log(await call("browser_wait", { text: "Welcome,", timeoutMs: 15000 }));
const after = await call("browser_snapshot", { maxChars: 1500 });
console.log(after.split("\n").slice(0, 6).join("\n"));
console.log("\nRESULT:", /Welcome, mcp@zimreaper\.dev/.test(after) ? "PASS" : "FAIL");

await client.close();
fx.kill();
process.exit(/Welcome, mcp@zimreaper\.dev/.test(after) ? 0 : 1);
