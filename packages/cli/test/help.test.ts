import { execFile } from "node:child_process";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { HELP } from "../src/bin.js";

const execFileAsync = promisify(execFile);

const COMMANDS = ["mcp", "run", "attach", "info", "audit verify"];

// Nested Node script execution is blocked in the Codex sandbox (child exits 0 with no
// output), so exec assertions are skipped there but run normally in CI/dev machines.
const nestedOutputWorks =
  spawnSync(process.execPath, ["-e", "process.stdout.write('ok')"], { encoding: "utf8" }).stdout === "ok";
const sandboxed = process.env.CODEX_SANDBOX === "1" || !nestedOutputWorks;

function expectCommandSurface(text: string): void {
  for (const command of COMMANDS) expect(text).toContain(command);
  expect(text).toContain("--connect");
  expect(text).toContain("--max-steps");
  expect(text).toContain("--dir");
}

describe("zimreaper --help", () => {
  it("renders every operator command in the help text", () => {
    expectCommandSurface(HELP);
  });

  it.skipIf(sandboxed)("prints help from the built binary", async () => {
    const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
    const { stdout } = await execFileAsync(process.execPath, [bin, "--help"]);
    expectCommandSurface(stdout);
  });

  it.skipIf(sandboxed)("rejects unknown commands with a ZimReaperError code and exit 1", async () => {
    const bin = fileURLToPath(new URL("../dist/bin.js", import.meta.url));
    await expect(execFileAsync(process.execPath, [bin, "nope"])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining("BAD_REQUEST:"),
    });
  });
});
