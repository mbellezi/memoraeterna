// REBALANCE operations beyond the batch shape operations of build.ts (the sideways leaf split,
// internal split, collapse and lifts are reused from there):
//
// - merges that keep I2 when an item already has a secondary on the target: an undersized leaf
//   into a sibling or its parent, and sibling leaves at centroid cosine >= siblingMergeCosine;
// - a downward leaf split and a push-down that leave the parent, protected children and human
//   placements alone, so protected neighbours never block the repair of an AI-managed topic;
// - the re-parent of a mis-parented topic (D12) and the cleanup of secondaries that break I2;
// - absorbing the movable direct items of an internal topic (readmission below it, new leaves);
// - re-placing items of a leaf into the leaves the audit's rolling re-placement found for them.
//
// Like build.ts they only implement mechanics through the editor, so every change is an
// invertible structure event; protection, freeze, budgets and acceptance are REBALANCE policy
// (repair.ts). The classifiers at the end tell that policy what a list of events touched.
import { contentAnchor } from "./build.js";
import type { ShapeContext, ShapeOperation, ShapeOperationKind } from "./build.js";
import type { StructureEvent } from "./events.js";
import { compareStrings } from "./ids.js";
import type { ItemKey } from "./ids.js";
import { groupsOf, sphericalKMeans } from "./kmeans.js";
import { movableDirectItems } from "./quality.js";
import { deriveSeed } from "./rng.js";
import { eventTopics } from "./stability.js";
import {
  depthOf,
  getTopic,
  heightOf,
  isLive,
  isProtected,
  pathOf,
  placementsOf,
  subtreeItems
} from "./state.js";
import type { PlacementRecord, TopicTreeState } from "./state.js";
import { addItemToPath, recomputeTopic, refreshSpread, subtractItemFromPath } from "./stats.js";
import { dot, matrixFromRows } from "./vectors.js";
import type { ItemVectorSource } from "./vectors.js";

export type TopicOperationKind =
  ShapeOperationKind | "sibling-merge" | "reparent" | "secondary-cleanup" | "replace";

/** What one operation did (the ShapeOperation of build.ts with the wider kind). */
export interface TopicOperation extends Omit<ShapeOperation, "kind"> {
  kind: TopicOperationKind;
}

/** Which topics an operation may choose as a merge target (e.g. not protected, not frozen). */
export type TargetFilter = (topicId: string) => boolean;

// ---------------------------------------------------------------------------
// Statistics

/**
 * Exact N, LS and centroid for the live topics in `topicIds` and every ancestor (deepest first),
 * then fresh spreads for the listed topics. Ancestors keep their spreads: their membership did
 * not change.
 */
export function refreshTopics(
  state: TopicTreeState,
  vectors: ItemVectorSource,
  topicIds: Iterable<string>
): void {
  const listed = [...new Set(topicIds)].filter((id) => {
    const node = state.topics.get(id);
    return node !== undefined && isLive(node);
  });
  const depth = new Map<string, number>();
  for (const id of listed) {
    pathOf(state, id).forEach((topicId, index) => depth.set(topicId, index));
  }
  const ordered = [...depth.keys()].sort(
    (a, b) => (depth.get(b) as number) - (depth.get(a) as number) || compareStrings(a, b)
  );
  for (const id of ordered) recomputeTopic(state, vectors, id);
  for (const id of listed) refreshSpread(state, vectors, id);
}

function finish(
  context: ShapeContext,
  operation: Omit<TopicOperation, "clock">,
  touched: readonly string[]
): TopicOperation {
  const { state } = context;
  for (const id of touched) {
    const node = state.topics.get(id);
    if (node && isLive(node)) node.control.repairClock = state.clock;
  }
  return { ...operation, clock: state.clock };
}

// ---------------------------------------------------------------------------
// Moving items while keeping I2

/**
 * Moves an item's primary placement to `to`. A secondary placement it already has on `to` is
 * dropped first (it becomes the primary there), and `fields` patch the placement (e.g. clearing
 * needs_split_check once a REBALANCE found the item a home).
 */
export function movePrimary(
  context: ShapeContext,
  item: ItemKey,
  to: string,
  fields: Partial<Omit<PlacementRecord, "rank" | "topicId">> = {}
): void {
  const { state, editor } = context;
  const placements = placementsOf(state, item);
  const primary = placements.find((placement) => placement.rank === 0);
  if (!primary || primary.topicId === to) return;
  const duplicate = placements.find((placement) => placement.rank > 0 && placement.topicId === to);
  if (duplicate) editor.unplaceItem(item, duplicate.rank);
  const hint = context.markMoves ? { movedFromTopicId: primary.topicId, movedAt: context.now } : {};
  editor.updatePlacement(item, 0, { ...fields, ...hint, topicId: to });
}

/** Drops secondary placements that now lie on their item's primary path (I2). */
export function dropSecondariesOnPath(context: ShapeContext, items: Iterable<ItemKey>): void {
  const { state, editor } = context;
  for (const item of items) {
    const placements = placementsOf(state, item);
    const primary = placements.find((placement) => placement.rank === 0);
    if (!primary) continue;
    const path = new Set(pathOf(state, primary.topicId));
    for (const secondary of placements.filter((placement) => placement.rank > 0)) {
      if (path.has(secondary.topicId)) editor.unplaceItem(item, secondary.rank);
    }
  }
}

/**
 * Drops the secondary placements of a topic's direct items that break I2: those on the item's
 * primary path, and those beyond secondary.max (highest ranks first).
 */
export function dropInvalidSecondaries(
  context: ShapeContext,
  topicId: string
): TopicOperation | null {
  const { state, config, editor } = context;
  const node = getTopic(state, topicId);
  const path = new Set(pathOf(state, topicId));
  let dropped = 0;
  for (const item of [...node.items]) {
    const secondaries = placementsOf(state, item).filter((placement) => placement.rank > 0);
    const invalid = secondaries.filter((placement) => path.has(placement.topicId));
    const valid = secondaries.filter((placement) => !path.has(placement.topicId));
    const excess = valid.slice(config.secondary.max);
    for (const placement of [...invalid, ...excess]) {
      editor.unplaceItem(item, placement.rank);
      dropped += 1;
    }
  }
  if (dropped === 0) return null;
  return finish(
    context,
    { kind: "secondary-cleanup", topicId, created: [], retired: [], movedItems: 0 },
    []
  );
}

/**
 * Moves the secondary placements of a topic about to retire to `to`, or drops them where `to`
 * would break I2 (already placed there, or on the item's primary path).
 */
export function evacuateSecondaries(context: ShapeContext, from: string, to: string): void {
  const { state, editor } = context;
  for (const item of [...getTopic(state, from).secondaryItems]) {
    const placements = placementsOf(state, item);
    const secondary = placements.find((placement) => placement.topicId === from);
    if (!secondary) continue;
    const primary = placements.find((placement) => placement.rank === 0);
    const blocked =
      placements.some((placement) => placement.topicId === to) ||
      (primary !== undefined && pathOf(state, primary.topicId).includes(to));
    if (blocked) editor.unplaceItem(item, secondary.rank);
    else editor.updatePlacement(item, secondary.rank, { topicId: to });
  }
}

// ---------------------------------------------------------------------------
// Merges

/**
 * Moves every direct item of leaf `leafId` to `targetId` (a sibling leaf or the parent) and
 * retires the leaf with a redirect to it.
 */
export function mergeLeafInto(
  context: ShapeContext,
  leafId: string,
  targetId: string,
  kind: TopicOperationKind = "merge"
): TopicOperation | null {
  const { state, vectors } = context;
  const leaf = getTopic(state, leafId);
  if (leaf.parentId === null || leaf.children.length > 0 || !isLive(leaf)) return null;
  const parentId = leaf.parentId;
  const target = getTopic(state, targetId);
  if (!isLive(target) || targetId === leafId) return null;
  if (targetId !== parentId && (target.parentId !== parentId || target.children.length > 0)) {
    return null;
  }
  const items = [...leaf.items];
  for (const item of items) movePrimary(context, item, targetId);
  evacuateSecondaries(context, leafId, targetId);
  context.editor.retireTopic(leafId, targetId, context.now);
  refreshTopics(state, vectors, targetId === parentId ? [parentId] : [targetId, parentId]);
  return finish(
    context,
    {
      kind: items.length === 0 ? "dissolve" : kind,
      topicId: leafId,
      created: [],
      retired: [leafId],
      movedItems: items.length
    },
    [targetId, parentId]
  );
}

/**
 * A leaf below leaf.min merges into its most similar eligible sibling leaf when the result stays
 * at or below repair.mergeMaxSize, otherwise into its parent; an empty leaf dissolves.
 */
export function mergeUndersizedLeaf(
  context: ShapeContext,
  leafId: string,
  eligible: TargetFilter = () => true
): TopicOperation | null {
  const { state, config } = context;
  const leaf = getTopic(state, leafId);
  if (leaf.parentId === null || leaf.children.length > 0) return null;
  const size = leaf.items.length;
  if (size >= config.leaf.min) return null;
  let target = leaf.parentId;
  let best = Number.NEGATIVE_INFINITY;
  if (size > 0) {
    for (const siblingId of getTopic(state, leaf.parentId).children) {
      const sibling = getTopic(state, siblingId);
      if (siblingId === leafId || sibling.children.length > 0 || !eligible(siblingId)) continue;
      if (sibling.items.length + size > config.repair.mergeMaxSize) continue;
      const similarity = dot(sibling.stats.centroid, leaf.stats.centroid);
      if (similarity > best) {
        best = similarity;
        target = siblingId;
      }
    }
  }
  return mergeLeafInto(context, leafId, target, "merge");
}

/** Merges two sibling leaves: the smaller (then the later content anchor) into the other. */
export function mergeSiblingLeaves(
  context: ShapeContext,
  a: string,
  b: string
): TopicOperation | null {
  const { state } = context;
  const left = getTopic(state, a);
  const right = getTopic(state, b);
  if (left.parentId === null || left.parentId !== right.parentId || a === b) return null;
  const order =
    left.items.length - right.items.length ||
    compareStrings(contentAnchor(state, b), contentAnchor(state, a)) ||
    compareStrings(b, a);
  const [source, target] = order <= 0 ? [a, b] : [b, a];
  return mergeLeafInto(context, source, target, "sibling-merge");
}

// ---------------------------------------------------------------------------
// Re-parent (D12 mis-parent audit)

/** Moves a topic under a new parent (an uncle), dropping secondaries that land on the path. */
export function reparentTopic(
  context: ShapeContext,
  topicId: string,
  newParentId: string
): TopicOperation | null {
  const { state, vectors } = context;
  const node = getTopic(state, topicId);
  if (node.parentId === null || node.parentId === newParentId) return null;
  const target = getTopic(state, newParentId);
  if (!isLive(target) || pathOf(state, newParentId).includes(topicId)) return null;
  const oldParent = node.parentId;
  context.editor.moveTopic(topicId, newParentId);
  dropSecondariesOnPath(context, subtreeItems(state, topicId));
  refreshTopics(state, vectors, [oldParent, newParentId, topicId]);
  return finish(
    context,
    {
      kind: "reparent",
      topicId,
      created: [],
      retired: [],
      movedItems: subtreeItems(state, topicId).length
    },
    [topicId, oldParent, newParentId]
  );
}

// ---------------------------------------------------------------------------
// Push-down around protected children

/**
 * Fan-out overflow: groups the children of a topic under new intermediate topics (balanced
 * spherical k-means over their centroids, as the batch push-down), the topic keeping its ID.
 * Protected children, and children whose subtree would cross depth.cap, stay where they are, so
 * a protected child never blocks the repair of its AI-managed parent.
 */
export function pushDownAround(context: ShapeContext, topicId: string): TopicOperation | null {
  const { state, config } = context;
  const node = getTopic(state, topicId);
  if (node.children.length <= config.fanOut.max) return null;
  const depth = depthOf(state, topicId);
  const children = node.children.filter(
    (child) =>
      !isProtected(getTopic(state, child)) && depth + 2 + heightOf(state, child) <= config.depth.cap
  );
  if (children.length < 2 * config.fanOut.min) return null;
  const groupCount = Math.min(
    config.fanOut.targetMax,
    Math.max(2, Math.round(children.length / config.repair.pushDownGroupSize))
  );
  const indices = children.map((_, index) => index);
  const result = sphericalKMeans(
    matrixFromRows(
      children.map((child) => getTopic(state, child).stats.centroid),
      false
    ),
    indices,
    {
      k: groupCount,
      seed: deriveSeed(context.seed, `push:${seedLabelOf(context, topicId)}:${state.clock}`),
      maxIterations: config.kmeans.maxIterations,
      weights: children.map((child) => getTopic(state, child).stats.n),
      minSize: config.fanOut.min,
      maxSize: config.fanOut.max
    }
  );
  const created: string[] = [];
  for (const group of groupsOf(result, indices)) {
    if (group.length < 2) continue;
    const intermediate = context.newTopicId();
    context.editor.createTopic(intermediate, topicId);
    for (const index of group) context.editor.moveTopic(children[index] as string, intermediate);
    created.push(intermediate);
  }
  if (created.length === 0) return null;
  refreshTopics(state, context.vectors, [topicId, ...created]);
  return finish(context, { kind: "push-down", topicId, created, retired: [], movedItems: 0 }, [
    topicId,
    ...created
  ]);
}

// ---------------------------------------------------------------------------
// Absorb movable direct items

function seedLabelOf(context: ShapeContext, topicId: string): string {
  return context.seedLabel ? context.seedLabel(topicId) : contentAnchor(context.state, topicId);
}

/** Balanced k-means groups of items (content-key order in, largest group first out). */
export function partitionItems(
  context: ShapeContext,
  items: readonly ItemKey[],
  k: number,
  label: string
): ItemKey[][] {
  const { config, state, vectors } = context;
  if (k <= 1) return [[...items]];
  const withVector: ItemKey[] = [];
  const rows: number[] = [];
  const withoutVector: ItemKey[] = [];
  for (const item of items) {
    const row = vectors.rowOf(item);
    if (row === undefined) withoutVector.push(item);
    else {
      withVector.push(item);
      rows.push(row);
    }
  }
  if (rows.length < 2) return [[...items]];
  const result = sphericalKMeans(vectors.matrix, rows, {
    k,
    seed: deriveSeed(context.seed, `${label}:${state.clock}`),
    maxIterations: config.kmeans.maxIterations,
    tolerance: config.kmeans.tolerance,
    minSize: Math.max(config.leaf.min, Math.floor((0.4 * rows.length) / k)),
    maxSize: config.leaf.max
  });
  const groups = groupsOf(result, withVector).sort((x, y) => y.length - x.length);
  groups[0]?.push(...withoutVector);
  return groups;
}

/**
 * Splits an oversized leaf downward: its AI-placed items form new child leaves (balanced
 * spherical k-means, as the batch split) and the leaf becomes their parent, keeping its place;
 * human placements stay as its direct items. Unlike the sideways split it never touches the
 * parent, so it also works under a full or protected parent. Not beyond depth.cap.
 */
export function splitLeafDownward(context: ShapeContext, leafId: string): TopicOperation | null {
  const { state, config, vectors } = context;
  const leaf = getTopic(state, leafId);
  const size = leaf.items.length;
  if (size <= config.leaf.max || leaf.children.length > 0 || leaf.parentId === null) return null;
  if (depthOf(state, leafId) + 1 > config.depth.cap) return null;
  const movable = leaf.items.filter(
    (item) =>
      placementsOf(state, item).find((placement) => placement.rank === 0)?.management === "ai"
  );
  const k = Math.max(
    2,
    Math.round(movable.length / config.leaf.target),
    Math.ceil(movable.length / config.leaf.max),
    Math.min(config.fanOut.targetMin, Math.floor(movable.length / config.leaf.min))
  );
  const groups = partitionItems(context, movable, k, `split:${seedLabelOf(context, leafId)}`);
  if (groups.length < 2) return null;
  const created: string[] = [];
  for (const group of groups) {
    const childId = context.newTopicId();
    context.editor.createTopic(childId, leafId);
    for (const item of group) movePrimary(context, item, childId);
    created.push(childId);
  }
  refreshTopics(state, vectors, [leafId, ...created]);
  return finish(
    context,
    { kind: "leaf-split", topicId: leafId, created, retired: [], movedItems: movable.length },
    [leafId, ...created]
  );
}

/**
 * Movable direct items of an internal topic (quality.ts: not waiting for the gate or a vector,
 * not placed by a human) are re-admitted below it through `context.readmit` when it finds them a
 * place; with `formLeaves`, enough leftovers (repair.directItemsSplitAt) form new leaf children.
 * A lone item never creates a topic. Moved items lose `needs_split_check`.
 */
export function absorbMovableItems(
  context: ShapeContext,
  topicId: string,
  options: { formLeaves: boolean }
): TopicOperation | null {
  const { state, vectors, config } = context;
  const node = getTopic(state, topicId);
  if (node.children.length === 0) return null;
  const touched = new Set<string>([topicId]);
  let moved = 0;
  if (context.readmit) {
    for (const item of movableDirectItems(state, node)) {
      const target = context.readmit(item, topicId);
      if (target === null || target === topicId || !state.topics.has(target)) continue;
      if (!isLive(getTopic(state, target)) || !pathOf(state, target).includes(topicId)) continue;
      subtractItemFromPath(state, vectors, item, topicId);
      movePrimary(context, item, target, { needsSplitCheck: false });
      addItemToPath(state, vectors, item, target);
      touched.add(target);
      moved += 1;
    }
  }
  const created: string[] = [];
  const remaining = movableDirectItems(state, node);
  if (options.formLeaves && remaining.length >= config.repair.directItemsSplitAt) {
    const k = Math.max(
      1,
      Math.round(remaining.length / config.leaf.target),
      Math.ceil(remaining.length / config.leaf.max)
    );
    // The same room rule as the batch absorb: never grow the root past fanOut.max this way.
    const room =
      node.children.length + k <= config.fanOut.max ||
      (node.parentId !== null && depthOf(state, topicId) + 2 <= config.depth.cap);
    if (room) {
      const label = `absorb:${seedLabelOf(context, topicId)}`;
      for (const group of partitionItems(context, remaining, k, label)) {
        const leafId = context.newTopicId();
        context.editor.createTopic(leafId, topicId);
        for (const item of group) movePrimary(context, item, leafId, { needsSplitCheck: false });
        created.push(leafId);
        moved += group.length;
      }
    }
  }
  if (moved === 0) return null;
  refreshTopics(state, vectors, [...touched, ...created]);
  return finish(
    context,
    { kind: "absorb-direct", topicId, created, retired: [], movedItems: moved },
    [topicId, ...created]
  );
}

// ---------------------------------------------------------------------------
// Re-placement (F4 D19 (4))

/** An item the audit's rolling re-placement found a better leaf for. */
export interface MisplacedItem {
  item: ItemKey;
  /** The leaf PLACE would choose now. */
  to: string;
}

/**
 * Moves items of leaf `leafId` to the leaves the audit found for them. An item moves only while
 * it is still where the audit saw it, placed by automation and settled, and its target is still a
 * live leaf the policy may use (`eligible`); the others stay. Acceptance is REBALANCE's: the
 * trial measures dQ and churn and the soft rules decide.
 */
export function replaceItems(
  context: ShapeContext,
  leafId: string,
  moves: readonly MisplacedItem[],
  eligible: TargetFilter = () => true
): TopicOperation | null {
  const { state, vectors } = context;
  const leaf = getTopic(state, leafId);
  if (!isLive(leaf) || leaf.parentId === null || leaf.children.length > 0) return null;
  const touched = new Set<string>([leafId]);
  const moved: ItemKey[] = [];
  for (const { item, to } of moves) {
    const primary = placementsOf(state, item).find((placement) => placement.rank === 0);
    if (!primary || primary.topicId !== leafId) continue;
    if (primary.management !== "ai" || primary.needsGate || primary.needsVector) continue;
    const target = state.topics.get(to);
    if (!target || !isLive(target) || target.children.length > 0 || target.parentId === null)
      continue;
    if (to === leafId || !eligible(to)) continue;
    movePrimary(context, item, to, { needsSplitCheck: false });
    touched.add(to);
    moved.push(item);
  }
  if (moved.length === 0) return null;
  dropSecondariesOnPath(context, moved);
  refreshTopics(state, vectors, [...touched]);
  return finish(
    context,
    { kind: "replace", topicId: leafId, created: [], retired: [], movedItems: moved.length },
    [...touched]
  );
}

// ---------------------------------------------------------------------------
// What a list of events touched

/**
 * The events change protected structure: they name a human or pinned topic (as subject, parent,
 * redirect or item topic) or move or remove a human placement. Such a change is a proposal
 * (pending_review), never automatic.
 */
export function eventsTouchProtected(
  state: TopicTreeState,
  events: readonly StructureEvent[]
): boolean {
  for (const event of events) {
    for (const id of eventTopics(event)) {
      const node = state.topics.get(id);
      if (node && isProtected(node)) return true;
    }
    if ((event.op === "item.move" || event.op === "item.unplace") && event.before) {
      if (event.before.management === "human") return true;
    }
  }
  return false;
}

/** The events name a frozen topic (recently opened or edited, stability.ts). */
export function eventsTouchFrozen(
  state: TopicTreeState,
  events: readonly StructureEvent[]
): boolean {
  for (const event of events) {
    for (const id of eventTopics(event)) if (state.topics.get(id)?.control.frozen) return true;
  }
  return false;
}

/**
 * The events are an Area-level change (D12): they change the set of level-1 topics (create,
 * retire or move a child of the root) or move a topic from one level-1 topic to another (Area
 * regrouping). Once Areas exist such a change is a proposal.
 */
export function eventsAreAreaLevel(
  state: TopicTreeState,
  events: readonly StructureEvent[]
): boolean {
  const root = state.rootId;
  const isArea = (id: string): boolean => state.topics.get(id)?.parentId === root;
  for (const event of events) {
    switch (event.op) {
      case "topic.create":
        if (event.after?.parentId === root || event.before?.parentId === root) return true;
        break;
      case "topic.retire":
      case "topic.restore":
        if (isArea(event.topicId)) return true;
        break;
      case "topic.move":
        if (event.before.parentId === root || event.after.parentId === root) return true;
        if (
          event.before.parentId !== event.after.parentId &&
          isArea(event.before.parentId) &&
          isArea(event.after.parentId)
        ) {
          return true;
        }
        break;
      default:
        break;
    }
  }
  return false;
}
