/**
 * Resilient CSS paths from the CDP DOM tree.
 *
 * Selectors are the *fallback* target for the executor (refs win), so the goal is a
 * path that survives a re-render: prefer a unique id, else tag + a hand-written class
 * + `:nth-of-type` up to five levels.
 */
import { escapeCssIdent, isStableClassToken } from "./util.js";

export interface CdpDomNode {
  nodeId?: number;
  backendNodeId?: number;
  nodeType: number;
  nodeName: string;
  nodeValue?: string;
  attributes?: string[];
  children?: CdpDomNode[];
  shadowRoots?: CdpDomNode[];
  contentDocument?: CdpDomNode;
  pseudoType?: string;
}

const MAX_SELECTOR_DEPTH = 5;
const DEFAULT_SELECTOR_NODES = 6000;

interface ElementRecord {
  tag: string;
  id?: string;
  classes: string[];
  backendNodeId?: number;
  parent?: ElementRecord;
  kids: ElementRecord[];
  index: number;
  sameTagCount: number;
}

/** backendNodeId (as a string key) -> CSS selector. */
export function buildSelectorMap(
  root: CdpDomNode,
  limit = DEFAULT_SELECTOR_NODES,
): Record<string, string> {
  const elements = flatten(root, limit);
  assignSiblingIndices(elements);

  const idCounts = new Map<string, number>();
  for (const el of elements) {
    if (el.id) idCounts.set(el.id, (idCounts.get(el.id) ?? 0) + 1);
  }

  const map: Record<string, string> = {};
  for (const el of elements) {
    if (el.backendNodeId === undefined || el.backendNodeId <= 0) continue;
    map[String(el.backendNodeId)] = selectorFor(el, idCounts);
  }
  return map;
}

function flatten(root: CdpDomNode, limit: number): ElementRecord[] {
  const elements: ElementRecord[] = [];
  const stack: Array<{ node: CdpDomNode; parent?: ElementRecord }> = [{ node: root }];
  while (stack.length > 0 && elements.length < limit) {
    const entry = stack.pop();
    if (!entry) break;
    const { node, parent } = entry;
    if (node.pseudoType !== undefined) continue;

    const kids = childNodesOf(node);
    if (node.nodeType !== 1) {
      for (let i = kids.length - 1; i >= 0; i -= 1) {
        const child = kids[i];
        if (child) stack.push({ node: child, parent });
      }
      continue;
    }

    const record: ElementRecord = {
      tag: node.nodeName.toLowerCase(),
      id: attributeOf(node, "id") ?? undefined,
      classes: (attributeOf(node, "class") ?? "").split(/\s+/).filter(Boolean),
      backendNodeId: node.backendNodeId,
      parent,
      kids: [],
      index: 1,
      sameTagCount: 1,
    };
    elements.push(record);
    if (parent) parent.kids.push(record);
    for (let i = kids.length - 1; i >= 0; i -= 1) {
      const child = kids[i];
      if (child) stack.push({ node: child, parent: record });
    }
  }
  return elements;
}

function assignSiblingIndices(elements: ElementRecord[]): void {
  const byParent = new Map<ElementRecord | undefined, Map<string, ElementRecord[]>>();
  for (const el of elements) {
    let tagGroups = byParent.get(el.parent);
    if (!tagGroups) {
      tagGroups = new Map<string, ElementRecord[]>();
      byParent.set(el.parent, tagGroups);
    }
    const list = tagGroups.get(el.tag);
    if (list) list.push(el);
    else tagGroups.set(el.tag, [el]);
  }
  for (const tagGroups of byParent.values()) {
    for (const list of tagGroups.values()) {
      list.forEach((el, i) => {
        el.index = i + 1;
        el.sameTagCount = list.length;
      });
    }
  }
}

function selectorFor(el: ElementRecord, idCounts: Map<string, number>): string {
  const parts: string[] = [];
  let current: ElementRecord | undefined = el;
  let depth = 0;
  while (current && depth < MAX_SELECTOR_DEPTH) {
    if (current.id && (idCounts.get(current.id) ?? 0) === 1) {
      parts.unshift(`#${escapeCssIdent(current.id)}`);
      break;
    }
    if (current.tag === "html" || current.tag === "body") {
      parts.unshift(current.tag);
      break;
    }
    const cls = current.classes.find(isStableClassToken);
    let segment = current.tag;
    if (cls) segment += `.${escapeCssIdent(cls)}`;
    if (!cls || current.index > 1) segment += `:nth-of-type(${current.index})`;
    parts.unshift(segment);
    current = current.parent;
    depth += 1;
  }
  return parts.join(" > ");
}

function childNodesOf(node: CdpDomNode): CdpDomNode[] {
  const kids: CdpDomNode[] = [];
  if (node.children) kids.push(...node.children);
  if (node.shadowRoots) kids.push(...node.shadowRoots);
  if (node.contentDocument) kids.push(node.contentDocument);
  return kids;
}

function attributeOf(node: CdpDomNode, name: string): string | undefined {
  const attrs = node.attributes;
  if (!attrs) return undefined;
  for (let i = 0; i + 1 < attrs.length; i += 2) {
    if (attrs[i] === name) return attrs[i + 1];
  }
  return undefined;
}
