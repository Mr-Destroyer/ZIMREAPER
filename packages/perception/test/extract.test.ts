import { describe, expect, it } from "vitest";
import { extractRows, pageExtract } from "../src/index.js";
import { createFakeCdp } from "./helpers.js";
import type { FakePageState } from "./helpers.js";

function fakeWith(overrides: Partial<FakePageState>) {
  return createFakeCdp({
    url: "https://example.com/orders",
    title: "Orders",
    viewport: { width: 1024, height: 768 },
    scroll: { x: 0, y: 0, maxY: 0 },
    ax: [],
    boxes: {},
    ...overrides,
  });
}

describe("extractRows", () => {
  it("runs one evaluate and maps every field to a string", async () => {
    const fake = fakeWith({
      extract: {
        ok: true,
        count: 250,
        rows: [
          { order: "A-1001", total: "$42.00", status: "Shipped" },
          { order: "A-1002", total: "", status: "Pending" },
        ],
      },
    });

    const result = await extractRows(fake.send, {
      rowSelector: "table#orders tbody tr",
      fields: {
        order: { selector: "td:nth-child(1)" },
        total: { selector: "td:nth-child(2)" },
        status: { selector: "td:nth-child(3)" },
      },
      limit: 100,
    });

    expect(result.count).toBe(250);
    expect(result.rows).toEqual([
      { order: "A-1001", total: "$42.00", status: "Shipped" },
      { order: "A-1002", total: "", status: "Pending" },
    ]);

    const evaluateCalls = fake.calls.filter((call) => call.method === "Runtime.evaluate");
    expect(evaluateCalls).toHaveLength(1);
    const expression = String(evaluateCalls[0]?.params?.expression ?? "");
    expect(expression).toContain("table#orders tbody tr");
    expect(expression).toContain("td:nth-child(2)");
    expect(evaluateCalls[0]?.params?.returnByValue).toBe(true);
  });

  it("fills missing fields with empty strings", async () => {
    const fake = fakeWith({ extract: { ok: true, count: 1, rows: [{ order: "A-1" }] } });
    const result = await extractRows(fake.send, {
      rowSelector: "tr",
      fields: { order: { self: true }, total: { selector: "td.price" } },
    });
    expect(result.rows).toEqual([{ order: "A-1", total: "" }]);
    expect(result.count).toBe(1);
  });

  it("maps an invalid selector to BAD_REQUEST", async () => {
    const fake = fakeWith({ extract: { ok: false, error: "not a valid selector" } });
    await expect(
      extractRows(fake.send, { rowSelector: "tr[", fields: { a: { self: true } } }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("maps a page exception to BACKEND_ERROR", async () => {
    const fake = fakeWith({ evaluateThrows: "TypeError: document is undefined" });
    await expect(
      extractRows(fake.send, { rowSelector: "tr", fields: { a: { self: true } } }),
    ).rejects.toMatchObject({ code: "BACKEND_ERROR" });
  });

  it("rejects a malformed payload", async () => {
    const fake = fakeWith({ extract: { ok: true, count: 1, rows: "nope" } });
    await expect(
      extractRows(fake.send, { rowSelector: "tr", fields: { a: { self: true } } }),
    ).rejects.toMatchObject({ code: "INTERNAL" });
  });

  it("wires the protocol query shape", async () => {
    const fake = fakeWith({ extract: { ok: true, count: 1, rows: [{ title: "Widget" }] } });
    const result = await pageExtract(fake.send, {
      kind: "page.extract",
      rowSelector: ".card",
      fields: { title: { selector: "h2" } },
      limit: 25,
    });
    expect(result.rows).toEqual([{ title: "Widget" }]);
    const expression = String(
      fake.calls.find((call) => call.method === "Runtime.evaluate")?.params?.expression ?? "",
    );
    expect(expression).toContain('"limit":25');
  });
});
