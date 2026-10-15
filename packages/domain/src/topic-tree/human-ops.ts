// Human structure operations (plan 4.1 Ownership; T26 wires them to `topics.mutate`): rename,
// move, create, pin, unpin and place-item. Human operations go through the engine like every
// change (D9) and become structure events in a `human` change-set, so they undo like any other.
// Each operation validates everything before its first event, so a refused operation changes
// nothing, and a no-op emits no event.
//
// Protection (RULES.md: human-created, human-edited and pinned content is never changed by
// automation): a topic a human creates, renames or moves becomes `human`, pinning makes it
// `pinned` (D28), and protection is read from `management` only. Human placements carry
// `management = 'human'`; PLACE never changes them.
//
// Statistics are not touched here: callers recompute the paths of `editor.touched` (D7).
import { TopicTitleSchema, topicLimits } from "../topics.js";
import type {
  TopicManagement,
  TopicPlacementDecision,
  TopicPlacementManagement,
  TopicPlacementRole
} from "../topics.js";
import type { TopicTreeConfig } from "./config.js";
import type { TopicTreeEditor } from "./events.js";
import { sameTopicTitle } from "./ids.js";
import type { ItemKey } from "./ids.js";
import { freeSecondaryRank } from "./secondary.js";
import {
  TopicTreeStateError,
  depthOf,
  getTopic,
  heightOf,
  isLive,
  pathOf,
  placementRecord,
  placementsOf,
  subtreeItems
} from "./state.js";
import type { PlacementRecord, TopicNode, TopicTreeState } from "./state.js";

export const topicOperationErrorCodes = [
  "notFound",
  "root",
  "cycle",
  "duplicateTitle",
  "depthCap",
  "invalidTitle",
  "invalidLanguage",
  "invalidPosition",
  "noPrimary",
  "onPrimaryPath",
  "secondariesFull"
] as const;
export type TopicOperationErrorCode = (typeof topicOperationErrorCodes)[number];

/** A refused human operation; the state is unchanged. */
export class TopicOperationError extends Error {
  override readonly name = "TopicOperationError";
  constructor(
    readonly code: TopicOperationErrorCode,
    message: string
  ) {
    super(message);
  }
}

/** What a human operation needs; ShapeContext and PlacementContext satisfy it. */
export interface HumanOperationContext {
  readonly state: TopicTreeState;
  readonly config: TopicTreeConfig;
  /** Applies (and logs) every change as a structure event. */
  readonly editor: TopicTreeEditor;
}

export interface HumanNameOptions {
  /** Language of the title (BCP 47); null when unknown. */
  language?: string | null;
  /** The human change-set (`named_change_set_id`, and `created_change_set_id` on create). */
  changeSetId?: string | null;
}

function fail(code: TopicOperationErrorCode, message: string): never {
  throw new TopicOperationError(code, message);
}

function liveTopic(state: TopicTreeState, id: string): TopicNode {
  const node = state.topics.get(id);
  if (!node || !isLive(node)) fail("notFound", `Topic ${id} not found`);
  return node;
}

function nonRootTopic(state: TopicTreeState, id: string): TopicNode {
  const node = liveTopic(state, id);
  if (id === state.rootId) fail("root", "The root cannot be changed");
  return node;
}

function parseTitle(title: string): string {
  const parsed = TopicTitleSchema.safeParse(title);
  if (!parsed.success) fail("invalidTitle", "A topic title has 1 to 120 characters");
  return parsed.data;
}

function parseLanguage(language: string | null | undefined): string | null {
  if (language === null || language === undefined) return null;
  const trimmed = language.trim();
  if (trimmed.length < 1 || trimmed.length > topicLimits.languageMaxLength) {
    fail("invalidLanguage", `Invalid title language ${language}`);
  }
  return trimmed;
}

/** I7: no live sibling under `parentId` (other than `except`) has the same title. */
function assertUniqueTitle(
  state: TopicTreeState,
  parentId: string,
  title: string,
  except: string | null
): void {
  for (const childId of getTopic(state, parentId).children) {
    if (childId === except) continue;
    const sibling = getTopic(state, childId).title;
    if (sibling !== null && sameTopicTitle(sibling, title)) {
      fail("duplicateTitle", `A sibling topic is already called ${title}`);
    }
  }
}

/** Marks an AI topic as human-managed (protected); pinned and human topics stay as they are. */
function protect(editor: TopicTreeEditor, id: string): number {
  if (getTopic(editor.state, id).management !== "ai") return 0;
  editor.manageTopic(id, "human");
  return 1;
}

function differs(current: PlacementRecord, patch: Partial<PlacementRecord>): boolean {
  return Object.entries(patch).some(
    ([field, value]) => (current as unknown as Record<string, unknown>)[field] !== value
  );
}

/** Renames a topic; it becomes human-named (never renamed by naming) and protected. */
export function renameTopic(
  context: HumanOperationContext,
  topicId: string,
  title: string,
  options: HumanNameOptions = {}
): number {
  const { state, editor } = context;
  const node = nonRootTopic(state, topicId);
  const clean = parseTitle(title);
  const language = parseLanguage(options.language);
  assertUniqueTitle(state, node.parentId as string, clean, topicId);
  const after = {
    title: clean,
    nameState: "named" as const,
    nameSource: "human" as const,
    nameLanguage: language,
    namedChangeSetId: options.changeSetId ?? null
  };
  let events = 0;
  if (
    node.title !== after.title ||
    node.nameState !== after.nameState ||
    node.nameSource !== after.nameSource ||
    node.nameLanguage !== after.nameLanguage ||
    node.namedChangeSetId !== after.namedChangeSetId
  ) {
    editor.renameTopic(topicId, after);
    events += 1;
  }
  return events + protect(editor, topicId);
}

/**
 * Moves a topic under another live topic (last child unless `position` is given). Refuses a cycle,
 * a duplicate sibling title and a subtree that would cross the depth cap. Secondary placements
 * that the move would put on their item's primary path are removed in the same change (I2). The
 * moved topic becomes protected.
 */
export function moveTopic(
  context: HumanOperationContext,
  topicId: string,
  parentId: string,
  options: { position?: number } = {}
): number {
  const { state, config, editor } = context;
  const node = nonRootTopic(state, topicId);
  liveTopic(state, parentId);
  const { position } = options;
  if (position !== undefined && !(Number.isInteger(position) && position >= 0)) {
    fail("invalidPosition", `Invalid position ${position}`);
  }
  const newPath = pathOf(state, parentId);
  if (newPath.includes(topicId)) fail("cycle", `Moving ${topicId} under ${parentId} makes a cycle`);
  if (node.parentId === parentId && (position === undefined || position === node.position)) {
    return 0;
  }
  if (node.parentId !== parentId && node.title !== null) {
    assertUniqueTitle(state, parentId, node.title, topicId);
  }
  if (depthOf(state, parentId) + 1 + heightOf(state, topicId) > config.depth.cap) {
    fail("depthCap", `Moving ${topicId} under ${parentId} crosses the depth cap`);
  }
  const onNewPath = new Set(newPath);
  let events = 0;
  for (const item of subtreeItems(state, topicId)) {
    for (const placement of [...placementsOf(state, item)]) {
      if (placement.rank > 0 && onNewPath.has(placement.topicId)) {
        editor.unplaceItem(item, placement.rank);
        events += 1;
      }
    }
  }
  editor.moveTopic(topicId, parentId, position);
  events += 1;
  return events + protect(editor, topicId);
}

/** Creates a human topic (protected, human-named) as the last child of a live topic. */
export function createTopic(
  context: HumanOperationContext,
  topicId: string,
  parentId: string,
  title: string,
  options: HumanNameOptions = {}
): number {
  const { state, config, editor } = context;
  if (state.topics.has(topicId)) throw new TopicTreeStateError(`Topic ${topicId} already exists`);
  liveTopic(state, parentId);
  const clean = parseTitle(title);
  const language = parseLanguage(options.language);
  assertUniqueTitle(state, parentId, clean, null);
  if (depthOf(state, parentId) + 1 > config.depth.cap) {
    fail("depthCap", `A topic under ${parentId} crosses the depth cap`);
  }
  editor.createTopic(topicId, parentId, {
    title: clean,
    nameState: "named",
    nameSource: "human",
    nameLanguage: language,
    namedChangeSetId: options.changeSetId ?? null,
    management: "human",
    createdChangeSetId: options.changeSetId ?? null
  });
  return 1;
}

/** Pins a topic (D28): `management = 'pinned'`; the view-history pin is the service's. */
export function pinTopic(context: HumanOperationContext, topicId: string): number {
  const node = nonRootTopic(context.state, topicId);
  if (node.management === "pinned") return 0;
  context.editor.manageTopic(topicId, "pinned");
  return 1;
}

/**
 * Unpins a topic. It returns to `restore`, the management it had before the pin when the caller
 * knows it (from the pin's change-set); the default `human` keeps it protected.
 */
export function unpinTopic(
  context: HumanOperationContext,
  topicId: string,
  options: { restore?: Exclude<TopicManagement, "pinned"> } = {}
): number {
  const node = nonRootTopic(context.state, topicId);
  if (node.management !== "pinned") return 0;
  context.editor.manageTopic(topicId, options.restore ?? "human");
  return 1;
}

/**
 * Places an item by hand, as its primary or as an "also in" secondary, on a live non-root topic.
 * A primary placement removes the secondaries on its new path (I2). A secondary needs a primary,
 * stays off the primary path, takes the lowest free rank or replaces the AI secondary with the
 * highest rank. The placement becomes `human`: automation never changes it.
 */
export function humanPlaceItem(
  context: HumanOperationContext,
  item: ItemKey,
  topicId: string,
  role: TopicPlacementRole
): number {
  const { state, config, editor } = context;
  if (!state.items.has(item)) fail("notFound", `Item ${item} not found`);
  liveTopic(state, topicId);
  if (topicId === state.rootId) fail("root", "Items are placed in Unsorted by the engine only");
  const placements = placementsOf(state, item).map((placement) => ({ ...placement }));
  const primary = placements.find((placement) => placement.rank === 0);
  const management: TopicPlacementManagement = "human";
  const decidedBy: TopicPlacementDecision = "human";
  const human = {
    management,
    decidedBy,
    score: null,
    margin: null,
    needsGate: false,
    needsSplitCheck: false,
    needsVector: false
  };

  if (role === "primary") {
    const path = new Set(pathOf(state, topicId));
    let events = 0;
    for (const placement of placements) {
      if (placement.rank > 0 && path.has(placement.topicId)) {
        editor.unplaceItem(item, placement.rank);
        events += 1;
      }
    }
    const fields = { ...human, topicId, movedFromTopicId: null, movedAt: null };
    if (!primary) {
      editor.placeItem(item, placementRecord(topicId, { ...fields, rank: 0 }));
      events += 1;
    } else if (differs(primary, fields)) {
      editor.updatePlacement(item, 0, fields);
      events += 1;
    }
    return events;
  }

  if (!primary) fail("noPrimary", `Item ${item} has no primary placement`);
  if (pathOf(state, primary.topicId).includes(topicId)) {
    fail("onPrimaryPath", `Topic ${topicId} is on the primary path of ${item}`);
  }
  const existing = placements.find(
    (placement) => placement.rank > 0 && placement.topicId === topicId
  );
  if (existing) {
    if (!differs(existing, human)) return 0;
    editor.updatePlacement(item, existing.rank, human);
    return 1;
  }
  const rank = freeSecondaryRank(state, config, item);
  if (rank !== null) {
    editor.placeItem(item, placementRecord(topicId, { ...human, rank }));
    return 1;
  }
  const replaceable = placements
    .filter((placement) => placement.rank > 0 && placement.management === "ai")
    .sort((a, b) => b.rank - a.rank)[0];
  if (!replaceable) fail("secondariesFull", `Item ${item} has no free secondary placement`);
  editor.updatePlacement(item, replaceable.rank, { ...human, topicId });
  return 1;
}
