import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createMcpServer } from "../src/index.js";
import { asClient, FakeControlClient } from "./fake-client.js";

describe("MCP stdio protocol round trip", () => {
  it("lists the browser tools and calls one through the SDK", async () => {
    const fake = new FakeControlClient({
      actResult: { clicked: { x: 1, y: 2 } },
      queryResult: [
        {
          tabId: "t1",
          url: "https://example.com",
          title: "Example",
          active: true,
          partition: "default",
          loading: false,
          canGoBack: false,
          canGoForward: false,
          createdAt: 1,
        },
      ],
    });
    const server = createMcpServer({ client: asClient(fake) });
    const client = new Client({ name: "test-client", version: "0.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name)).toContain("browser_snapshot");
      expect(listed.tools.map((tool) => tool.name)).toHaveLength(21);

      const clicked = await client.callTool({ name: "browser_click", arguments: { ref: "e1" } });
      expect(clicked.isError).not.toBe(true);
      expect(clicked.content).toEqual([{ type: "text", text: expect.stringContaining("Clicked") }]);
      expect(fake.calls[0]?.payload).toMatchObject({ kind: "mouse.click", target: { ref: "e1" } });

      const failed = await client.callTool({ name: "browser_tabs", arguments: { op: "close" } });
      expect(failed.isError).toBe(true);
      expect(failed.content).toEqual([{ type: "text", text: expect.stringContaining("BAD_REQUEST:") }]);
    } finally {
      await client.close();
      await server.close();
    }
  });
});
