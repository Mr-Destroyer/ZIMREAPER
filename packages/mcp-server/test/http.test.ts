import { createServer } from "node:net";
import { describe, expect, it } from "vitest";
import { runHttp } from "../src/index.js";
import { asClient, FakeControlClient } from "./fake-client.js";

async function canListen(): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer();
    probe.once("error", () => resolve(false));
    probe.listen(0, "127.0.0.1", () => probe.close(() => resolve(true)));
  });
}

describe("runHttp", () => {
  it("serves health on localhost and protects the MCP path with a random token", async () => {
    if (!(await canListen())) {
      console.warn("skipping runHttp test: sandbox does not permit listening on 127.0.0.1");
      return;
    }
    const running = await runHttp({
      client: asClient(new FakeControlClient()),
      port: 0,
      host: "127.0.0.1",
    });
    try {
      expect(running.port).toBeGreaterThan(0);
      expect(running.path).toMatch(/^\/mcp\/[a-f0-9]{48}$/);

      const health = await fetch(`http://127.0.0.1:${running.port}/health`);
      expect(health.status).toBe(200);
      expect(await health.json()).toEqual({ ok: true, name: "zimreaper" });

      const wrong = await fetch(`http://127.0.0.1:${running.port}/mcp`);
      expect(wrong.status).toBe(404);
      const wrongBody = (await wrong.json()) as { error: { code: string } };
      expect(wrongBody.error.code).toBe("NOT_FOUND");

      const root = await fetch(`http://127.0.0.1:${running.port}/`);
      expect(root.status).toBe(404);
    } finally {
      await running.close();
    }
  });
});
