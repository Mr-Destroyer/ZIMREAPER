import { readFileSync } from "node:fs";
import type { AxNode, CdpSend, RawPageData } from "../src/index.js";
import type { CdpDomNode } from "../src/selectors.js";

export function loadFixture(name: "ax-login" | "ax-table"): RawPageData {
  const url = new URL(`./fixtures/${name}.json`, import.meta.url);
  return JSON.parse(readFileSync(url, "utf8")) as RawPageData;
}

export interface FakePageState {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  scroll: { x: number; y: number; maxY: number };
  ax: AxNode[];
  boxes: Record<string, { x: number; y: number; width: number; height: number }>;
  dom?: CdpDomNode;
  /** Value returned by a non-probe Runtime.evaluate (page.extract). */
  extract?: unknown;
  /** Force Runtime.evaluate to report an exception. */
  evaluateThrows?: string;
}

export interface FakeCdp {
  send: CdpSend;
  calls: Array<{ method: string; params?: Record<string, unknown> }>;
  page: FakePageState;
}

const EMPTY_DOM: CdpDomNode = {
  nodeType: 9,
  nodeName: "#document",
  children: [{ nodeType: 1, nodeName: "HTML", backendNodeId: 1, attributes: [] }],
};

export function createFakeCdp(page: FakePageState): FakeCdp {
  const calls: Array<{ method: string; params?: Record<string, unknown> }> = [];

  const send: CdpSend = async <T = unknown>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> => {
    calls.push(params === undefined ? { method } : { method, params });

    switch (method) {
      case "Accessibility.enable":
      case "DOM.enable":
        return {} as T;

      case "Accessibility.getFullAXTree":
        return { nodes: page.ax } as T;

      case "Page.getLayoutMetrics":
        return {
          cssLayoutViewport: {
            clientWidth: page.viewport.width,
            clientHeight: page.viewport.height,
          },
          cssContentSize: {
            width: page.viewport.width,
            height: page.viewport.height + page.scroll.maxY,
          },
        } as T;

      case "Runtime.evaluate": {
        if (page.evaluateThrows) {
          return {
            exceptionDetails: { text: "Uncaught", exception: { description: page.evaluateThrows } },
          } as T;
        }
        const expression = String(params?.expression ?? "");
        if (expression.includes("scrollHeight")) {
          return {
            result: {
              value: {
                scrollX: page.scroll.x,
                scrollY: page.scroll.y,
                maxY: page.scroll.maxY,
                innerWidth: page.viewport.width,
                innerHeight: page.viewport.height,
                title: page.title,
                href: page.url,
              },
            },
          } as T;
        }
        return { result: { value: page.extract } } as T;
      }

      case "DOM.getDocument":
        return { root: page.dom ?? EMPTY_DOM } as T;

      case "DOM.getBoxModel": {
        const id = String(params?.backendNodeId ?? "");
        const box = page.boxes[id];
        if (!box) throw new Error("Could not compute box model.");
        const { x, y, width, height } = box;
        return {
          model: {
            border: [x, y, x + width, y, x + width, y + height, x, y + height],
            content: [x, y, x + width, y, x + width, y + height, x, y + height],
            width: Math.round(width),
            height: Math.round(height),
          },
        } as T;
      }

      default:
        throw new Error(`unexpected CDP method: ${method}`);
    }
  };

  return { send, calls, page };
}

/** Build a synthetic AX node; ids/backend ids are assigned by the caller. */
export function axNode(
  nodeId: string,
  role: string,
  name: string,
  backendDOMNodeId: number,
  extra: Partial<AxNode> = {},
): AxNode {
  return {
    nodeId,
    backendDOMNodeId,
    role: { value: role },
    name: { value: name },
    ...extra,
  };
}

/** A flat, grid-laid-out page with `count` nodes, for budget tests. */
export function syntheticPage(
  count: number,
  roles: { interactiveEvery: number } = { interactiveEvery: 10 },
): { ax: AxNode[]; boxes: Record<string, { x: number; y: number; width: number; height: number }> } {
  const ax: AxNode[] = [];
  const boxes: Record<string, { x: number; y: number; width: number; height: number }> = {};
  const childIds: string[] = [];

  ax.push({
    nodeId: "1",
    backendDOMNodeId: 1,
    role: { value: "RootWebArea" },
    name: { value: "Synthetic" },
    childIds,
  });

  for (let i = 0; i < count; i += 1) {
    const nodeId = String(i + 2);
    const backendNodeId = i + 2;
    const interactive = i % roles.interactiveEvery === 0;
    childIds.push(nodeId);
    ax.push(
      axNode(
        nodeId,
        interactive ? "button" : "StaticText",
        interactive ? `Action ${i}` : `Row text ${i}`,
        backendNodeId,
      ),
    );
    boxes[String(backendNodeId)] = {
      x: 8,
      y: 8 + (i % 20) * 24,
      width: 120,
      height: 20,
    };
  }

  return { ax, boxes };
}
