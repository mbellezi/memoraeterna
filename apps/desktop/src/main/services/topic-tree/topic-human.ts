// Human structure operations on the cached tree (F2 T26; D28, D29): `topics.mutate` becomes the
// structure events of one `human` change-set. The pure operations (rename, move, create, pin,
// unpin, place-item) live in the domain (`human-ops.ts`); this module prepares them against the
// service's cache: it checks the optimistic-concurrency stamp, registers an item the tree does not
// hold yet, names the change-set, and settles the exact statistics of the touched paths (D7). The
// service commits the result and keeps the cache in step.
import { randomUUID } from "node:crypto";

import {
  createTopicTreeLoadRepository,
  createTopicTreeRepository,
  topicStatsWrites
} from "@app/db";
import type { PgPool, TopicStatsWrite } from "@app/db";
import type { TopicMutation, TopicUndoBlocker } from "@app/domain";
import { topicReadLimits } from "@app/domain";
import {
  TopicOperationError,
  createTopic,
  createTopicTreeEditor,
  humanPlaceItem,
  itemKey,
  moveTopic,
  pinTopic,
  recomputePaths,
  registerItem,
  renameTopic,
  topicsWithStaleStats,
  unpinTopic
} from "@app/domain/topic-tree";
import type {
  StructureEvent,
  TopicOperationErrorCode,
  TopicTreeState,
  UndoBlocker
} from "@app/domain/topic-tree";

import { noteEntries } from "./topic-cache.js";
import type { TopicTreeCache } from "./topic-cache.js";
import { liveTopics, pathsOf } from "./topic-place.js";

/** The failures a human operation reports, as message keys (`new Error(key)`). */
export const humanErrorKeys = {
  stale: "topics.errors.stale",
  cycle: "topics.errors.cycle",
  duplicateTitle: "topics.errors.duplicateTitle",
  notFound: "topics.errors.notFound",
  protected: "topics.errors.protected",
  depthCap: "topics.errors.depthCap",
  invalid: "topics.errors.invalid",
  unchanged: "topics.errors.unchanged"
} as const;
export type HumanErrorKey = (typeof humanErrorKeys)[keyof typeof humanErrorKeys];

const operationErrorKeys: Record<TopicOperationErrorCode, HumanErrorKey> = {
  notFound: humanErrorKeys.notFound,
  root: humanErrorKeys.invalid,
  cycle: humanErrorKeys.cycle,
  duplicateTitle: humanErrorKeys.duplicateTitle,
  depthCap: humanErrorKeys.depthCap,
  invalidTitle: humanErrorKeys.invalid,
  invalidLanguage: humanErrorKeys.invalid,
  invalidPosition: humanErrorKeys.invalid,
  noPrimary: humanErrorKeys.invalid,
  onPrimaryPath: humanErrorKeys.invalid,
  secondariesFull: humanErrorKeys.invalid
};

/** A refusal of the domain as the message-key error the handlers throw; null for any other error. */
export function humanOperationError(error: unknown): Error | null {
  return error instanceof TopicOperationError ? new Error(operationErrorKeys[error.code]) : null;
}

/** The view-history pin a pin or unpin change-set carries (D28): written in the same transaction. */
export interface HistoryPinEffect {
  topicId: string;
  pinned: boolean;
}

/** One prepared human change-set: events already applied to the cache, ready to commit. */
export interface HumanPreparation {
  changeSetId: string;
  events: StructureEvent[];
  titleKey: string;
  titleParams: Record<string, string | number | boolean | null>;
  summary: Record<string, unknown>;
  history: HistoryPinEffect | null;
  /** The item a placement registered with the cache, which was not in the tree before. */
  newItem: boolean;
  stats: TopicStatsWrite[];
  /** Topics whose page or counts the change may alter (the paths of the change). */
  changedTopicIds: string[];
}

/** Change-set titles (the banner and "changed today" read `topics.changeSets.human*`). */
export const humanTitleKeys = {
  rename: "topics.changeSets.humanRename",
  move: "topics.changeSets.humanMove",
  create: "topics.changeSets.humanCreate",
  pin: "topics.changeSets.humanPin",
  unpin: "topics.changeSets.humanUnpin",
  placeItem: "topics.changeSets.humanPlace"
} as const;

/** `topic.manage` events of a change-set that pinned or unpinned a topic, for its undo. */
export function historyEffectsOfUndo(events: readonly StructureEvent[]): HistoryPinEffect[] {
  const effects: HistoryPinEffect[] = [];
  for (const event of events) {
    if (event.op !== "topic.manage") continue;
    const was = event.before.management === "pinned";
    const is = event.after.management === "pinned";
    // Undoing a pin unpins the history entry; undoing an unpin pins it again.
    if (is && !was) effects.push({ topicId: event.topicId, pinned: false });
    else if (was && !is) effects.push({ topicId: event.topicId, pinned: true });
  }
  return effects;
}

/** The contract's blockers of an undo (bounded), from the engine's. */
export function undoBlockersOf(blockers: readonly UndoBlocker[]): TopicUndoBlocker[] {
  return blockers.slice(0, topicReadLimits.undoBlockersMax).map((blocker): TopicUndoBlocker => {
    switch (blocker.kind) {
      case "changeSet":
        return {
          kind: "changeSet",
          changeSetId: blocker.changeSetId,
          objects: blocker.objects.slice(0, 20).map((object) => object.slice(0, 120))
        };
      case "itemDeleted":
        return { kind: "itemDeleted", item: blocker.item.slice(0, 120) };
      case "notApplied":
        return { kind: "notApplied", status: blocker.status };
      case "conflict":
        return {
          kind: "conflict",
          code: blocker.code,
          topicId: blocker.topicId,
          item: blocker.item === null ? null : blocker.item.slice(0, 120),
          reason: blocker.reason.slice(0, 300)
        };
    }
  });
}

/**
 * Exact statistics of every path a list of applied events touched, in the cache (D7): what a
 * change-set commits with its events. Returns the statistics and the topics whose pages change.
 */
export function settleStats(
  cache: TopicTreeCache,
  events: readonly StructureEvent[],
  touched: Iterable<string>
): { stats: TopicStatsWrite[]; changedTopicIds: string[] } {
  const { state, vectors } = cache;
  const stale = liveTopics(state, [...topicsWithStaleStats(state, events), ...touched]);
  recomputePaths(state, vectors, stale);
  const changedTopicIds = pathsOf(state, stale);
  return { stats: topicStatsWrites(state, vectors, changedTopicIds), changedTopicIds };
}

export interface HumanInput {
  pool: PgPool;
  cache: TopicTreeCache;
  mutation: TopicMutation;
  /** The ID the new change-set will have (events may name it: `named_change_set_id`). */
  changeSetId: string;
  newTopicId: () => string;
}

const titleOf = (state: TopicTreeState, id: string): string | null =>
  state.topics.get(id)?.title ?? null;

/** A rename or a move is made from a stamp; a topic that changed since is refused (`stale`). */
async function checkStamp(
  input: HumanInput,
  topicId: string,
  expectedUpdatedAt: string
): Promise<void> {
  const stamps = await createTopicTreeRepository(input.pool).topicStamps(input.cache.tree.id, [
    topicId
  ]);
  const stamp = stamps.get(topicId);
  if (!stamp || stamp.retired) throw new Error(humanErrorKeys.notFound);
  if (stamp.updatedAt.getTime() !== Date.parse(expectedUpdatedAt)) {
    throw new Error(humanErrorKeys.stale);
  }
}

/**
 * Registers an item the tree does not hold yet (a note still waiting for its place, or a root
 * source) so a person can place it: the owner must exist, a note must be current and a source must
 * be a root. Returns whether the item was added.
 */
async function ensureItem(
  input: HumanInput,
  kind: "note" | "source",
  id: string
): Promise<{ key: string; added: boolean }> {
  const { cache } = input;
  const key = itemKey(kind, id);
  if (cache.state.items.has(key)) return { key, added: false };
  const loader = createTopicTreeLoadRepository(input.pool);
  if (kind === "note") {
    const owners = await loader.itemOwners({ noteIds: [id] });
    const owner = owners.notes.get(id);
    if (!owner?.current) throw new Error(humanErrorKeys.notFound);
    const vectors = await loader.loadItemVectors(cache.space, [{ kind: "note", id }]);
    const entry = noteEntries(vectors, owners.notes).get(key);
    if (!entry) throw new Error(humanErrorKeys.notFound);
    registerItem(cache.state, { key, ...entry.info });
    if (entry.vector) cache.vectors.set(key, entry.vector);
    return { key, added: true };
  }
  const owners = await loader.itemOwners({ sourceIds: [id] });
  const owner = owners.sources.get(id);
  if (owner?.rootSourceId !== id) throw new Error(humanErrorKeys.notFound);
  registerItem(cache.state, {
    key,
    kind: "source",
    contentHash: owner.contentHash ?? "",
    rootSource: null
  });
  return { key, added: true };
}

/**
 * Applies one human operation to the cache and returns the change-set to commit. Every refusal
 * (a stamp that moved, a cycle, a duplicate title, an item or topic that is gone) throws an error
 * whose message is a `topics.errors.*` key; the caller drops the cache then, whatever was touched.
 */
export async function prepareHumanOperation(input: HumanInput): Promise<HumanPreparation> {
  const { cache, mutation, changeSetId } = input;
  const { state, config } = cache;
  const editor = createTopicTreeEditor(state);
  const context = { state, config, editor };
  const options = { changeSetId };
  let titleKey: string = humanTitleKeys.rename;
  let titleParams: HumanPreparation["titleParams"] = {};
  let history: HistoryPinEffect | null = null;
  let newItem = false;
  try {
    switch (mutation.op) {
      case "rename": {
        await checkStamp(input, mutation.id, mutation.expectedUpdatedAt);
        const node = state.topics.get(mutation.id);
        const from = titleOf(state, mutation.id);
        // The same name again is no change: it keeps the change-set that gave the name.
        const same =
          node?.title === mutation.title.trim() &&
          node.nameState === "named" &&
          node.nameSource === "human";
        renameTopic(context, mutation.id, mutation.title, {
          changeSetId: same ? node.namedChangeSetId : changeSetId
        });
        titleKey = humanTitleKeys.rename;
        titleParams = { from, to: titleOf(state, mutation.id) };
        break;
      }
      case "move": {
        await checkStamp(input, mutation.id, mutation.expectedUpdatedAt);
        moveTopic(context, mutation.id, mutation.parentId, {
          ...(mutation.position === undefined ? {} : { position: mutation.position })
        });
        titleKey = humanTitleKeys.move;
        titleParams = {
          topic: titleOf(state, mutation.id),
          parent: titleOf(state, mutation.parentId)
        };
        break;
      }
      case "create": {
        const topicId = input.newTopicId();
        createTopic(context, topicId, mutation.parentId, mutation.title, options);
        titleKey = humanTitleKeys.create;
        titleParams = { title: titleOf(state, topicId), parent: titleOf(state, mutation.parentId) };
        break;
      }
      case "pin":
      case "unpin": {
        const pinning = mutation.op === "pin";
        if (pinning) pinTopic(context, mutation.id);
        else unpinTopic(context, mutation.id);
        titleKey = pinning ? humanTitleKeys.pin : humanTitleKeys.unpin;
        titleParams = { topic: titleOf(state, mutation.id) };
        history = { topicId: mutation.id, pinned: pinning };
        break;
      }
      case "placeItem": {
        const item = await ensureItem(input, mutation.item.kind, mutation.item.id.toLowerCase());
        newItem = item.added;
        humanPlaceItem(context, item.key, mutation.topicId, mutation.role);
        titleKey = humanTitleKeys.placeItem;
        titleParams = { topic: titleOf(state, mutation.topicId), role: mutation.role };
        break;
      }
    }
  } catch (error) {
    throw humanOperationError(error) ?? error;
  }
  if (editor.events.length === 0) throw new Error(humanErrorKeys.unchanged);
  const events = [...editor.events];
  const { stats, changedTopicIds } = settleStats(cache, events, editor.touched);
  return {
    changeSetId,
    events,
    titleKey,
    titleParams,
    summary: { op: mutation.op, ...(history ? { viewHistory: history } : {}) },
    history,
    newItem,
    stats,
    changedTopicIds
  };
}

/** A fresh ID for a topic or a change-set (injected in tests). */
export const randomId = (): string => randomUUID();
