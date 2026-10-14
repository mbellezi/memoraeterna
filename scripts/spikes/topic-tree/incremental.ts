// Incremental topic engine: beam descent with node-relative admission, ambiguity
// detection, placement on the deepest admitted node, and local repair with
// hysteresis after each change.
import type { TreeConfig } from "./config.js";
import { affectedNodes, repairAll, repairNode } from "./repair.js";
import type { RepairContext, RepairOperation } from "./repair.js";
import { TopicTree, admissionThreshold } from "./tree.js";
import { dotRowVec } from "./vectors.js";
import type { EmbeddingMatrix } from "./vectors.js";

export interface PlacementCandidate {
  nodeId: number;
  score: number;
  admitted: boolean;
  leaf: boolean;
}

export interface Placement {
  item: number;
  /** Chosen node: an admitted leaf, or the deepest admitted internal node. */
  nodeId: number;
  /** Root-to-node path at decision time. */
  path: number[];
  admittedLeaf: boolean;
  /** Chosen leaf beat its best competitor leaf by less than the ambiguity margin. */
  ambiguous: boolean;
  /** top1 - top2 between the chosen leaf and the best other leaf candidate. */
  margin: number | null;
  /** Best other leaf candidate (the runner-up), when there is one. */
  competitorId: number | null;
  /** Ambiguous and the runner-up sits under a different parent (a branch-level choice). */
  crossParentAmbiguous: boolean;
  /** Cosine to the chosen node's centroid. */
  score: number;
  candidates: PlacementCandidate[];
}

export class IncrementalTopicEngine {
  readonly tree: TopicTree;
  readonly matrix: EmbeddingMatrix;
  readonly config: TreeConfig;
  readonly operations: RepairOperation[] = [];
  private readonly dirty = new Set<number>();
  private readonly context: RepairContext;

  constructor(tree: TopicTree, matrix: EmbeddingMatrix, config: TreeConfig, seed: number) {
    this.tree = tree;
    this.matrix = matrix;
    this.config = config;
    this.context = {
      tree,
      matrix,
      config,
      seed,
      readmit: (item, from) => {
        const placement = this.place(item, from);
        return placement.nodeId === from ? null : placement.nodeId;
      }
    };
  }

  /** Engine over an empty tree (the root collects items until it splits). */
  static empty(matrix: EmbeddingMatrix, config: TreeConfig, seed: number): IncrementalTopicEngine {
    return new IncrementalTopicEngine(new TopicTree(matrix.dim), matrix, config, seed);
  }

  /** Read-only placement decision for an item, descending from `from` (default: root). */
  place(item: number, from = this.tree.rootId): Placement {
    const { tree, matrix, config } = this;
    const beam = Math.max(1, config.placement.beam);
    const start = tree.node(from);
    let frontier: PlacementCandidate[] = [
      {
        nodeId: from,
        score: start.n > 0 ? dotRowVec(matrix, item, start.centroid) : 0,
        admitted: true,
        leaf: start.children.length === 0
      }
    ];
    const terminals: PlacementCandidate[] = [];
    while (frontier.length > 0) {
      const next: PlacementCandidate[] = [];
      for (const current of frontier) {
        const node = tree.node(current.nodeId);
        if (node.children.length === 0) {
          terminals.push({ ...current, leaf: true });
          continue;
        }
        let admittedChild = false;
        for (const childId of node.children) {
          const child = tree.node(childId);
          const score = dotRowVec(matrix, item, child.centroid);
          const leaf = child.children.length === 0;
          if (score >= admissionThreshold(child, config)) {
            admittedChild = true;
            next.push({ nodeId: childId, score, admitted: true, leaf });
          } else if (leaf) {
            terminals.push({ nodeId: childId, score, admitted: false, leaf });
          }
        }
        if (!admittedChild) terminals.push({ ...current, leaf: false });
      }
      next.sort((a, b) => b.score - a.score || a.nodeId - b.nodeId);
      frontier = next.slice(0, beam);
    }

    const leaves = terminals
      .filter((candidate) => candidate.leaf)
      .sort((a, b) => b.score - a.score || a.nodeId - b.nodeId);
    const admittedLeaves = leaves.filter((candidate) => candidate.admitted);
    let chosen: PlacementCandidate;
    let admittedLeaf = false;
    if (admittedLeaves[0]) {
      chosen = admittedLeaves[0];
      admittedLeaf = true;
    } else {
      // Not admitted to any leaf: deepest admitted internal node, then best score.
      const internal = terminals
        .filter((candidate) => !candidate.leaf && candidate.admitted)
        .map((candidate) => ({ candidate, depth: tree.depthOf(candidate.nodeId) }))
        .sort(
          (a, b) =>
            b.depth - a.depth ||
            b.candidate.score - a.candidate.score ||
            a.candidate.nodeId - b.candidate.nodeId
        );
      chosen = internal[0]?.candidate ?? { nodeId: from, score: 0, admitted: true, leaf: false };
    }
    let margin: number | null = null;
    let competitorId: number | null = null;
    if (admittedLeaf) {
      const competitor = leaves.find((candidate) => candidate.nodeId !== chosen.nodeId);
      if (competitor) {
        margin = chosen.score - competitor.score;
        competitorId = competitor.nodeId;
      }
    }
    const ambiguous = margin !== null && margin < config.placement.ambiguityMargin;
    return {
      item,
      nodeId: chosen.nodeId,
      path: tree.pathOf(chosen.nodeId),
      admittedLeaf,
      ambiguous,
      margin,
      competitorId,
      crossParentAmbiguous:
        ambiguous &&
        competitorId !== null &&
        tree.node(competitorId).parent !== tree.node(chosen.nodeId).parent,
      score: chosen.score,
      candidates: terminals.sort((a, b) => b.score - a.score || a.nodeId - b.nodeId)
    };
  }

  /** Places, attaches (N and LS updated along the path) and optionally repairs. */
  insert(item: number, options: { repair?: boolean } = {}): Placement {
    if (this.tree.itemNode.has(item)) throw new Error(`Item ${item} is already placed`);
    this.tree.clock += 1;
    const placement = this.place(item);
    this.tree.addItem(placement.nodeId, item, this.matrix);
    this.dirty.add(placement.nodeId);
    if (options.repair ?? true) this.repair();
    return placement;
  }

  /** Subtracts the item along its old path and repairs. */
  remove(item: number, options: { repair?: boolean } = {}): void {
    this.tree.clock += 1;
    const nodeId = this.tree.removeItem(item, this.matrix);
    this.dirty.add(nodeId);
    if (options.repair ?? true) this.repair();
  }

  /** Local repair of dirty nodes (soft triggers respect cooldowns). */
  repair(): RepairOperation[] {
    const applied: RepairOperation[] = [];
    let budget = 10_000;
    while (this.dirty.size > 0 && budget > 0) {
      budget -= 1;
      const id = this.dirty.values().next().value as number;
      this.dirty.delete(id);
      const operation = repairNode(this.context, id, { force: false });
      if (!operation) continue;
      applied.push(operation);
      for (const affected of affectedNodes(this.tree, operation)) this.dirty.add(affected);
    }
    this.operations.push(...applied);
    return applied;
  }

  /** Full repair pass that ignores cooldowns (e.g. before a shadow comparison). */
  settle(): RepairOperation[] {
    const applied = repairAll(this.context, { force: true });
    this.operations.push(...applied);
    this.dirty.clear();
    return applied;
  }
}
