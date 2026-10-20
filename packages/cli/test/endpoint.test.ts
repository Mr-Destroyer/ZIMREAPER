import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { readEndpoint } from "../src/commands.js";

const savedHome = process.env.ZIMREAPER_HOME;

afterEach(() => {
  if (savedHome === undefined) delete process.env.ZIMREAPER_HOME;
  else process.env.ZIMREAPER_HOME = savedHome;
});

describe("endpoint discovery", () => {
  it("reads url and token from endpoint.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zim-cli-"));
    process.env.ZIMREAPER_HOME = dir;
    await mkdir(dir, { recursive: true });
    await writeFile(
      join(dir, "endpoint.json"),
      JSON.stringify({ url: "ws://127.0.0.1:7500", token: "tok", port: 7500 }),
    );
    await expect(readEndpoint()).resolves.toMatchObject({
      url: "ws://127.0.0.1:7500",
      token: "tok",
      port: 7500,
    });
  });

  it("returns undefined when the endpoint file is missing or malformed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "zim-cli-"));
    process.env.ZIMREAPER_HOME = dir;
    await expect(readEndpoint()).resolves.toBeUndefined();
    await writeFile(join(dir, "endpoint.json"), "{not json");
    await expect(readEndpoint()).resolves.toBeUndefined();
  });
});
