// ID-preserving rebuilds (plan 4.1 "Shadow rebuild", D26, D39): a fresh partition from the
// clustering worker is mapped onto the live tree so topic IDs survive, and the difference is
// emitted as ordinary structure events (one `rebuild` change-set).
//
// Matching: every live non-root topic and every partition node is a set of members (the items of
// its subtree that are both placed now and in the partition). A pair is an edge when it is a
// mutual majority (the overlap holds more than half of each side), weighted by member Jaccard;
// that graph is sparse and each topic has few edges. The matching maximizes the total Jaccard:
// exactly (Hungarian) per connected component up to rebuild.hungarianExactMaxTopics topics a
// side, greedily above (hungarian.ts). The root always maps to the root.
//
// Events, in an order that is valid at every step (and so for the repository, statement by
// statement): unmatched partition nodes are created and matched topics moved under their new
// parents in partition pre-order (a parent is final before its children move, so no cycle
// appears); then items move to their partition topic ("moved from" hints, `decided_by =
// rebuild`); secondaries that landed on their primary path are dropped (I2); last, unmatched
// topics retire bottom-up with a redirect to the deepest topic that holds a majority of their
// members (I9). A matched topic whose title would collide with a new sibling (I7) loses its AI
// title first (`unnamed`, so naming runs again); human-named and protected titles are never
// cleared. Last, a matched LLM-named topic whose members the rebuild changed, by at least
// naming.rebuildRenameDrift of the members it was named for (its naming sketch, else its members
// before the rebuild), keeps its title as a provisional one, so naming runs again at once and a
// merge never keeps a name that describes part of it. Human placements stay where they are.
// Touching protected structure, or moving more than rebuild.reviewChurnShare of the items (fresh
// ones left out, stability.ts), marks the change-set for review.
import { contentAnchor } from "./build.js";
import type { ShapeContext } from "./build.js";
import type { TopicTreeConfig } from "./config.js";
import { applyEvents, createTopicTreeEditor, invertEvents } from "./events.js";
import type { StructureEvent } from "./events.js";
import { maxWeightMatching } from "./hungarian.js";
import type { WeightedEdge } from "./hungarian.js";
import { compareStrings, normalizeTopicTitle } from "./ids.js";
import type { ItemKey } from "./ids.js";
import { mayAutoName, membershipChange, membershipDrift, membershipSketch } from "./naming.js";
import type { MembershipSketch } from "./naming.js";
import {
  dropSecondariesOnPath,
  evacuateSecondaries,
  eventsTouchProtected,
  movePrimary
} from "./operations.js";
import { eventChurn, placedItemCount } from "./stability.js";
import type { EventChurn } from "./stability.js";
import {
  getTopic,
  isLive,
  isProtected,
  pathOf,
  placementRecord,
  primaryPlacement,
  subtreeItems,
  walkTopics
} from "./state.js";
import type { TopicNode, TopicTreeState } from "./state.js";
import { recomputeSubtree } from "./stats.js";
import type { ItemVectorSource } from "./vectors.js";

/** One node of a rebuilt partition: pre-order, the root first (parent null). */
export interface RebuildPartitionNode {
  key: number;
  parent: number | null;
  items: readonly ItemKey[];
}

export class RebuildMappingError extends Error {
  override readonly name = "RebuildMappingError";
}

export interface RebuildMatch {
  key: number;
  topicId: string;
  overlap: number;
  jaccard: number;
}

export interface RebuildPlan {
  /** Topic ID of every partition key: the root, a surviving topic or a new ID. */
  topicIdOfKey: Map<number, string>;
  matched: RebuildMatch[];
  /** Partition keys that become new topics. */
  createdKeys: number[];
  /** Live non-root topics no partition node matched (they retire). */
  unmatchedTopics: string[];
  /** Every component was matched exactly (Hungarian). */
  exact: boolean;
}

function validatePartition(
  state: TopicTreeState,
  partition: readonly RebuildPartitionNode[]
): Map<number, RebuildPartitionNode> {
  const nodes = new Map<number, RebuildPartitionNode>();
  const items = new Set<ItemKey>();
  partition.forEach((node, index) => {
    if (!Number.isInteger(node.key) || nodes.has(node.key)) {
      throw new RebuildMappingError(`Invalid or duplicate partition key ${node.key}`);
    }
    if ((index === 0) !== (node.parent === null)) {
      throw new RebuildMappingError("The partition starts with its root, the only parentless node");
    }
    if (node.parent !== null && !nodes.has(node.parent)) {
      throw new RebuildMappingError(`Node ${node.key} comes before its parent ${node.parent}`);
    }
    for (const item of node.items) {
      if (items.has(item)) throw new RebuildMappingError(`Item ${item} appears twice`);
      if (!state.items.has(item)) throw new RebuildMappingError(`Item ${item} is not registered`);
      items.add(item);
    }
    nodes.set(node.key, node);
  });
  if (partition.length === 0) throw new RebuildMappingError("The partition is empty");
  return nodes;
}

/** Maps partition nodes to live topics (see the module comment). Does not change the state. */
export function planRebuild(
  state: TopicTreeState,
  partition: readonly RebuildPartitionNode[],
  config: TopicTreeConfig,
  newTopicId: () => string
): RebuildPlan {
  const nodes = validatePartition(state, partition);
  const rootKey = (partition[0] as RebuildPartitionNode).key;

  // Old side: live non-root topics in content-anchor order (D22).
  const oldTopics: string[] = [];
  walkTopics(state, (node) => {
    if (node.id !== state.rootId) oldTopics.push(node.id);
  });
  const anchors = new Map(oldTopics.map((id) => [id, contentAnchor(state, id)]));
  oldTopics.sort(
    (a, b) =>
      compareStrings(anchors.get(a) as string, anchors.get(b) as string) || compareStrings(a, b)
  );
  const oldIndex = new Map(oldTopics.map((id, index) => [id, index]));
  // New side: non-root partition nodes in partition order.
  const newKeys = partition.slice(1).map((node) => node.key);
  const newIndex = new Map(newKeys.map((key, index) => [key, index]));
  const newPath = (key: number): number[] => {
    const path: number[] = [];
    for (let current: number | null = key; current !== null && current !== rootKey;) {
      path.push(newIndex.get(current) as number);
      current = (nodes.get(current) as RebuildPartitionNode).parent;
    }
    return path;
  };

  const oldSize = new Float64Array(oldTopics.length);
  const newSize = new Float64Array(newKeys.length);
  const overlap = new Map<number, number>();
  for (const node of partition) {
    const path = newPath(node.key);
    for (const item of node.items) {
      const placement = primaryPlacement(state, item);
      if (!placement || !state.topics.has(placement.topicId)) continue;
      const topic = getTopic(state, placement.topicId);
      if (!isLive(topic)) continue;
      const oldPath = pathOf(state, placement.topicId)
        .filter((id) => id !== state.rootId)
        .map((id) => oldIndex.get(id) as number);
      for (const o of oldPath) oldSize[o] = (oldSize[o] as number) + 1;
      for (const n of path) newSize[n] = (newSize[n] as number) + 1;
      for (const o of oldPath) {
        for (const n of path) {
          const key = o * newKeys.length + n;
          overlap.set(key, (overlap.get(key) ?? 0) + 1);
        }
      }
    }
  }

  const edges: WeightedEdge[] = [];
  for (const [key, shared] of overlap) {
    const left = Math.floor(key / newKeys.length);
    const right = key % newKeys.length;
    const a = oldSize[left] as number;
    const b = newSize[right] as number;
    if (shared * 2 <= a || shared * 2 <= b) continue; // not a mutual majority
    edges.push({ left, right, weight: shared / (a + b - shared) });
  }
  edges.sort((x, y) => x.left - y.left || x.right - y.right);
  const matching = maxWeightMatching(oldTopics.length, newKeys.length, edges, {
    exactMaxNodes: config.rebuild.hungarianExactMaxTopics
  });

  const topicIdOfKey = new Map<number, string>([[rootKey, state.rootId]]);
  const matched: RebuildMatch[] = [];
  const createdKeys: number[] = [];
  newKeys.forEach((key, index) => {
    const left = matching.rightToLeft[index] as number;
    if (left >= 0) {
      const topicId = oldTopics[left] as string;
      const shared = overlap.get(left * newKeys.length + index) ?? 0;
      const a = oldSize[left] as number;
      const b = newSize[index] as number;
      topicIdOfKey.set(key, topicId);
      matched.push({ key, topicId, overlap: shared, jaccard: shared / (a + b - shared) });
    } else {
      topicIdOfKey.set(key, newTopicId());
      createdKeys.push(key);
    }
  });
  const unmatchedTopics = oldTopics
    .filter((_, index) => (matching.leftToRight[index] as number) < 0)
    .sort(compareStrings);
  return { topicIdOfKey, matched, createdKeys, unmatchedTopics, exact: matching.exact };
}

// ---------------------------------------------------------------------------
// Applying a plan

export interface RebuildInput {
  state: TopicTreeState;
  vectors: ItemVectorSource;
  config: TopicTreeConfig;
  partition: readonly RebuildPartitionNode[];
  newTopicId: () => string;
  /** Timestamp of retirements and "moved from" hints. */
  now: string;
  /** Items opened recently: their churn counts stability.recentChurnWeight times. */
  recentItems?: ReadonlySet<ItemKey>;
  /** Fresh items (stability.freshHours): no churn, and not part of the review share. */
  freshItems?: ReadonlySet<ItemKey>;
  /** Compute the change-set and restore the state (for a change-set that waits for review). */
  dryRun?: boolean;
  /**
   * The members an LLM-named topic had when it was named (the sketch its naming change-set
   * recorded), or null when not known; then its members before the rebuild stand in.
   */
  namedSketch?: (topicId: string) => MembershipSketch | null;
}

export interface RebuildResult {
  plan: RebuildPlan;
  /** The change-set (origin `rebuild`), valid against the state before the call. */
  events: StructureEvent[];
  retired: { topicId: string; redirectTo: string }[];
  /** AI-named topics whose title was cleared to avoid a sibling collision (to be named again). */
  unnamed: string[];
  /**
   * Matched LLM-named topics whose members changed by naming.rebuildRenameDrift or more: their
   * title is now provisional, so they are named again.
   */
  renamed: string[];
  /** Unmatched topics kept live because protected structure blocked emptying them. */
  kept: string[];
  /** Partition items left where they were (human placements). */
  keptItems: ItemKey[];
  churn: EventChurn;
  /** Share of placed items whose primary path changed. */
  movedShare: number;
  /** The same share without fresh items: what the review threshold is compared with. */
  establishedShare: number;
  review: { largeShare: boolean; protectedTouched: boolean; required: boolean };
}

function canClearTitle(node: TopicNode): boolean {
  return node.title !== null && !isProtected(node) && node.nameSource !== "human";
}

/** A topic named by the model that automation may name again (step 4 of the module comment). */
function isNamedByModel(node: TopicNode): boolean {
  return mayAutoName(node) && node.nameState === "named" && node.nameSource === "llm";
}

/**
 * The deepest topic whose subtree holds a strict majority of `members` (items at their current
 * primary topic, counted at their nearest ancestor in `final`); null when `members` is empty.
 */
function majorityHolder(
  state: TopicTreeState,
  members: readonly ItemKey[],
  final: ReadonlySet<string>
): string | null {
  if (members.length === 0) return null;
  const counts = new Map<string, number>();
  for (const item of members) {
    const placement = primaryPlacement(state, item);
    if (!placement) continue;
    for (const id of pathOf(state, placement.topicId)) {
      if (final.has(id)) counts.set(id, (counts.get(id) ?? 0) + 1);
    }
  }
  let best: string | null = null;
  let bestDepth = -1;
  for (const [id, count] of counts) {
    if (count * 2 <= members.length) continue;
    const depth = pathOf(state, id).length;
    if (depth > bestDepth) {
      best = id;
      bestDepth = depth;
    }
  }
  return best;
}

/** Plans the rebuild and applies it to `input.state` through structure events (see module). */
export function applyRebuild(input: RebuildInput): RebuildResult {
  const { state, vectors, config, partition, now } = input;
  const plan = planRebuild(state, partition, config, input.newTopicId);
  const editor = createTopicTreeEditor(state);
  const context: ShapeContext = {
    state,
    vectors,
    config,
    seed: 0,
    editor,
    newTopicId: input.newTopicId,
    now,
    markMoves: true
  };
  const nodes = new Map(partition.map((node) => [node.key, node]));
  const final = new Set(plan.topicIdOfKey.values());
  const created = new Set(plan.createdKeys.map((key) => plan.topicIdOfKey.get(key) as string));
  const inPartition = new Set(partition.flatMap((node) => node.items));
  const membersBefore = new Map<string, ItemKey[]>();
  for (const id of plan.unmatchedTopics) {
    membersBefore.set(
      id,
      subtreeItems(state, id).filter((item) => inPartition.has(item))
    );
  }
  // The members of the matched LLM-named topics before the rebuild (step 4).
  const namedBefore = new Map<string, MembershipSketch>();
  for (const match of plan.matched) {
    const node = getTopic(state, match.topicId);
    if (isNamedByModel(node)) namedBefore.set(node.id, membershipSketch(state, node.id));
  }
  const unnamed: string[] = [];
  let protectedConflict = false;

  // 1. Topics: create and move in pre-order.
  for (const node of partition.slice(1)) {
    const topicId = plan.topicIdOfKey.get(node.key) as string;
    const parentId = plan.topicIdOfKey.get(
      (nodes.get(node.key) as RebuildPartitionNode).parent as number
    ) as string;
    if (created.has(topicId)) {
      editor.createTopic(topicId, parentId);
      continue;
    }
    const topic = getTopic(state, topicId);
    if (topic.parentId === parentId) continue;
    if (topic.title !== null) {
      const key = normalizeTopicTitle(topic.title);
      const clash = getTopic(state, parentId).children.find(
        (other) =>
          other !== topicId &&
          getTopic(state, other).title !== null &&
          normalizeTopicTitle(getTopic(state, other).title as string) === key
      );
      if (clash !== undefined) {
        // Prefer the title of a topic that retires anyway, then the moving one's, then the other.
        const other = getTopic(state, clash);
        const retiring = plan.unmatchedTopics.includes(clash);
        const victim =
          retiring && canClearTitle(other)
            ? clash
            : canClearTitle(topic)
              ? topicId
              : canClearTitle(other)
                ? clash
                : null;
        if (victim === null) {
          protectedConflict = true;
          continue;
        }
        editor.renameTopic(victim, {
          title: null,
          nameState: "unnamed",
          nameSource: null,
          nameLanguage: null,
          namedChangeSetId: null,
          aliases: []
        });
        unnamed.push(victim);
      }
    }
    editor.moveTopic(topicId, parentId);
  }

  // 2. Items.
  const keptItems: ItemKey[] = [];
  for (const node of partition) {
    const target = plan.topicIdOfKey.get(node.key) as string;
    for (const item of node.items) {
      const primary = primaryPlacement(state, item);
      if (!primary) {
        editor.placeItem(item, placementRecord(target, { decidedBy: "rebuild" }));
        continue;
      }
      if (primary.topicId === target) continue;
      if (primary.management === "human") {
        keptItems.push(item);
        continue;
      }
      movePrimary(context, item, target, {
        decidedBy: "rebuild",
        needsGate: false,
        needsSplitCheck: false
      });
    }
  }
  dropSecondariesOnPath(
    context,
    [...state.placements.entries()]
      .filter(([, placements]) => placements.length > 1)
      .map(([item]) => item)
  );

  // 3. Unmatched topics retire bottom-up.
  const unmatched = new Set(plan.unmatchedTopics);
  const postOrder: string[] = [];
  walkTopics(state, (node) => {
    if (unmatched.has(node.id)) postOrder.push(node.id);
  });
  postOrder.reverse();
  const retired: { topicId: string; redirectTo: string }[] = [];
  const kept: string[] = [];
  for (const id of postOrder) {
    const node = getTopic(state, id);
    if (node.children.length > 0) {
      kept.push(id);
      continue;
    }
    const redirectTo =
      majorityHolder(state, membersBefore.get(id) ?? [], final) ??
      nearestFinalAncestor(state, id, final);
    for (const item of [...node.items]) movePrimary(context, item, redirectTo);
    evacuateSecondaries(context, id, redirectTo);
    editor.retireTopic(id, redirectTo, now);
    retired.push({ topicId: id, redirectTo });
  }

  // 4. Matched topics whose members changed past naming.rebuildRenameDrift are named again.
  const renamed: string[] = [];
  for (const [topicId, before] of namedBefore) {
    const node = getTopic(state, topicId);
    if (!isNamedByModel(node)) continue; // its title was cleared in step 1
    const after = membershipSketch(state, topicId);
    if (membershipDrift(before, after) === 0) continue; // the rebuild left its members alone
    const then = input.namedSketch?.(topicId) ?? before;
    if (membershipChange(then, after) < config.naming.rebuildRenameDrift) continue;
    editor.renameTopic(topicId, { nameState: "provisional" });
    renamed.push(topicId);
  }

  recomputeSubtree(state, vectors);
  const events = [...editor.events];
  const churn = eventChurn(state, events, config, input.recentItems, input.freshItems);
  const total = placedItemCount(state);
  const movedShare = total > 0 ? churn.items.length / total : 0;
  const establishedShare = total > 0 ? (churn.items.length - churn.fresh) / total : 0;
  const protectedTouched =
    protectedConflict || kept.length > 0 || eventsTouchProtected(state, events);
  const largeShare = establishedShare > config.rebuild.reviewChurnShare;
  if (input.dryRun) {
    applyEvents(state, invertEvents(events));
    recomputeSubtree(state, vectors);
  }
  return {
    plan,
    events,
    retired,
    unnamed,
    renamed,
    kept,
    keptItems,
    churn,
    movedShare,
    establishedShare,
    review: { largeShare, protectedTouched, required: largeShare || protectedTouched }
  };
}

function nearestFinalAncestor(
  state: TopicTreeState,
  id: string,
  final: ReadonlySet<string>
): string {
  const path = pathOf(state, id);
  for (let index = path.length - 2; index >= 0; index -= 1) {
    const ancestor = path[index] as string;
    if (final.has(ancestor)) return ancestor;
  }
  return state.rootId;
}
