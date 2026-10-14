import { summarize, type Distribution } from "./stats.js";

/** Shape metrics of a parent-pointer forest. All functions are pure. */

export interface TreeNode {
  readonly id: string;
  readonly parentId: string | null;
}

export interface TreeShape {
  readonly nodes: number;
  /** Nodes without a parent plus nodes whose parent is not among the given nodes. */
  readonly roots: number;
  /** Nodes whose parent id points outside the given set (for example an archived parent). */
  readonly danglingParents: number;
  /** Nodes that no root reaches because their parent chain loops. */
  readonly unreachable: number;
  readonly maxDepth: number;
  /** Node count per depth; depth 0 is a root. */
  readonly byDepth: Readonly<Record<number, number>>;
  readonly depth: Distribution | null;
  readonly internalNodes: number;
  readonly leaves: number;
  /** Children per internal node. */
  readonly fanOut: Distribution | null;
}

export function treeShape(nodes: readonly TreeNode[]): TreeShape {
  const ids = new Set(nodes.map((node) => node.id));
  const children = new Map<string, string[]>();
  const roots: string[] = [];
  let danglingParents = 0;
  for (const node of nodes) {
    if (node.parentId !== null && ids.has(node.parentId)) {
      const siblings = children.get(node.parentId);
      if (siblings) siblings.push(node.id);
      else children.set(node.parentId, [node.id]);
    } else {
      if (node.parentId !== null) danglingParents += 1;
      roots.push(node.id);
    }
  }

  const depths: number[] = [];
  const byDepth: Record<number, number> = {};
  let frontier = roots;
  let level = 0;
  const seen = new Set<string>();
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const id of frontier) {
      if (seen.has(id)) continue;
      seen.add(id);
      depths.push(level);
      byDepth[level] = (byDepth[level] ?? 0) + 1;
      for (const child of children.get(id) ?? []) next.push(child);
    }
    frontier = next;
    level += 1;
  }

  const fanOuts = [...children].filter(([id]) => seen.has(id)).map(([, list]) => list.length);
  return {
    nodes: nodes.length,
    roots: roots.length,
    danglingParents,
    unreachable: nodes.length - seen.size,
    maxDepth: depths.reduce((deepest, value) => Math.max(deepest, value), 0),
    byDepth,
    depth: summarize(depths),
    internalNodes: fanOuts.length,
    leaves: seen.size - fanOuts.length,
    fanOut: summarize(fanOuts)
  };
}
