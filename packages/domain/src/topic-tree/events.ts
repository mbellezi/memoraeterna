// Structure events: the only way persistent topic and placement fields change (section 3.1,
// `topic_structure_events`). Every event carries the fields it touches before and after, so it
// can be checked (the state must equal `before`) and inverted exactly:
//
//   topic.create   before null -> after record (its inverse, before record -> after null, deletes)
//   topic.retire   <-> topic.restore           item.place <-> item.unplace
//   topic.move, topic.rename, topic.describe, topic.manage, item.move: before and after swap
//   topic.retire of a topic that is retired already (`isRedirectEvent`): the redirect points at
//   another topic (F4 D19 compresses redirect chains); like a move, before and after swap
//
// `invertEvents` reverses a change-set; `applyEvents` is atomic (on a failed precondition the
// applied prefix is rolled back). Statistics are derived and never part of an event: callers
// recompute the returned touched topics (stats.ts).
import { z } from "zod";

import {
  TopicManagementSchema,
  TopicNameSourceSchema,
  TopicNameStateSchema,
  TopicPlacementDecisionSchema,
  TopicPlacementManagementSchema,
  TopicTitleSchema,
  topicLimits
} from "../topics.js";
import type { TopicManagement, TopicStructureEventOp } from "../topics.js";
import { ItemKeySchema } from "./ids.js";
import type { ItemKey } from "./ids.js";
import {
  TopicTreeStateError,
  deletePlacement,
  deleteTopic,
  getLiveTopic,
  getTopic,
  insertPlacement,
  insertTopic,
  isLive,
  nextChildPosition,
  placementAt,
  placementRecordFields,
  topicRecord,
  topicRecordFields,
  updatePlacementFields,
  updateTopicFields
} from "./state.js";
import type { PlacementRecord, TopicNode, TopicRecord, TopicTreeState } from "./state.js";

const TopicIdSchema = z.string().uuid();
const ChangeSetIdSchema = z.string().uuid();
const TimestampSchema = z.string().datetime({ offset: true });
const finite = z.number().finite();

const topicFields = {
  parentId: TopicIdSchema,
  role: z.literal("topic"),
  title: TopicTitleSchema.nullable(),
  nameState: TopicNameStateSchema,
  nameSource: TopicNameSourceSchema.nullable(),
  nameLanguage: z.string().min(1).max(topicLimits.languageMaxLength).nullable(),
  namedChangeSetId: ChangeSetIdSchema.nullable(),
  description: z.string().trim().min(1).max(topicLimits.descriptionMaxLength).nullable(),
  aliases: z
    .array(z.string().trim().min(1).max(topicLimits.aliasMaxLength))
    .max(topicLimits.aliasesMax),
  management: TopicManagementSchema,
  position: z.number().int().min(0),
  retiredAt: TimestampSchema.nullable(),
  redirectTo: TopicIdSchema.nullable(),
  createdChangeSetId: ChangeSetIdSchema.nullable()
};

/** A topic record without its ID (the payload of `topic.create`). */
export const TopicCreatePayloadSchema = z
  .object(topicFields)
  .strict()
  .refine((topic) => (topic.nameState === "unnamed") === (topic.title === null), {
    message: "A topic has a title exactly when it is not unnamed"
  });
export const TopicMovePayloadSchema = z
  .object({ parentId: topicFields.parentId, position: topicFields.position })
  .strict();
export const TopicRenamePayloadSchema = z
  .object({
    title: topicFields.title,
    nameState: topicFields.nameState,
    nameSource: topicFields.nameSource,
    nameLanguage: topicFields.nameLanguage,
    namedChangeSetId: topicFields.namedChangeSetId,
    aliases: topicFields.aliases
  })
  .strict();
export const TopicDescribePayloadSchema = z
  .object({ description: topicFields.description })
  .strict();
export const TopicManagePayloadSchema = z.object({ management: topicFields.management }).strict();
export const TopicRetirementPayloadSchema = z
  .object({ retiredAt: topicFields.retiredAt, redirectTo: topicFields.redirectTo })
  .strict();
export const PlacementPayloadSchema = z
  .object({
    topicId: TopicIdSchema,
    rank: z.number().int().min(0).max(topicLimits.maxSecondaryPlacements),
    management: TopicPlacementManagementSchema,
    decidedBy: TopicPlacementDecisionSchema,
    itemFingerprint: z.string().min(1).max(200).nullable(),
    score: finite.nullable(),
    margin: finite.nullable(),
    needsGate: z.boolean(),
    needsSplitCheck: z.boolean(),
    needsVector: z.boolean(),
    movedFromTopicId: TopicIdSchema.nullable(),
    movedAt: TimestampSchema.nullable()
  })
  .strict();

export type TopicCreatePayload = Omit<TopicRecord, "id">;
/** A move always has a parent: the root never moves. */
export type TopicMovePayload = { parentId: string; position: number };
export type TopicRenamePayload = Pick<
  TopicRecord,
  "title" | "nameState" | "nameSource" | "nameLanguage" | "namedChangeSetId" | "aliases"
>;
export type TopicDescribePayload = Pick<TopicRecord, "description">;
export type TopicManagePayload = Pick<TopicRecord, "management">;
export type TopicRetirementPayload = Pick<TopicRecord, "retiredAt" | "redirectTo">;
export type PlacementPayload = PlacementRecord;

const topicEvent = <Op extends TopicStructureEventOp, P extends z.ZodType>(op: Op, payload: P) =>
  z.object({ op: z.literal(op), topicId: TopicIdSchema, before: payload, after: payload }).strict();

const itemEvent = <Op extends TopicStructureEventOp, B extends z.ZodType, A extends z.ZodType>(
  op: Op,
  before: B,
  after: A
) =>
  z
    .object({ op: z.literal(op), item: ItemKeySchema, topicId: TopicIdSchema, before, after })
    .strict();

const TopicCreateEventSchema = z
  .object({
    op: z.literal("topic.create"),
    topicId: TopicIdSchema,
    before: TopicCreatePayloadSchema.nullable(),
    after: TopicCreatePayloadSchema.nullable()
  })
  .strict()
  .refine((event) => (event.before === null) !== (event.after === null), {
    message: "topic.create needs exactly one of before and after"
  });

/** The boundary schema of one structure event (UUID topic IDs and product item keys). */
export const StructureEventSchema = z.discriminatedUnion("op", [
  TopicCreateEventSchema,
  topicEvent("topic.retire", TopicRetirementPayloadSchema),
  topicEvent("topic.restore", TopicRetirementPayloadSchema),
  topicEvent("topic.move", TopicMovePayloadSchema),
  topicEvent("topic.rename", TopicRenamePayloadSchema),
  topicEvent("topic.describe", TopicDescribePayloadSchema),
  topicEvent("topic.manage", TopicManagePayloadSchema),
  itemEvent("item.place", z.null(), PlacementPayloadSchema),
  itemEvent("item.unplace", PlacementPayloadSchema, z.null()),
  itemEvent("item.move", PlacementPayloadSchema, PlacementPayloadSchema)
]);

export type StructureEvent =
  | {
      op: "topic.create";
      topicId: string;
      before: TopicCreatePayload | null;
      after: TopicCreatePayload | null;
    }
  | {
      op: "topic.retire";
      topicId: string;
      before: TopicRetirementPayload;
      after: TopicRetirementPayload;
    }
  | {
      op: "topic.restore";
      topicId: string;
      before: TopicRetirementPayload;
      after: TopicRetirementPayload;
    }
  | { op: "topic.move"; topicId: string; before: TopicMovePayload; after: TopicMovePayload }
  | { op: "topic.rename"; topicId: string; before: TopicRenamePayload; after: TopicRenamePayload }
  | {
      op: "topic.describe";
      topicId: string;
      before: TopicDescribePayload;
      after: TopicDescribePayload;
    }
  | { op: "topic.manage"; topicId: string; before: TopicManagePayload; after: TopicManagePayload }
  | { op: "item.place"; item: ItemKey; topicId: string; before: null; after: PlacementPayload }
  | { op: "item.unplace"; item: ItemKey; topicId: string; before: PlacementPayload; after: null }
  | {
      op: "item.move";
      item: ItemKey;
      topicId: string;
      before: PlacementPayload;
      after: PlacementPayload;
    };

/**
 * Whether the event re-points the redirect of a topic that is retired already (`topic.retire` with
 * a retirement time before and after): the compression of a redirect chain, A -> B -> C becoming
 * A -> C. The topic stays retired and no other field changes, so the stored vocabulary of
 * operations stays what it was.
 */
export function isRedirectEvent(event: StructureEvent): boolean {
  return (
    event.op === "topic.retire" && event.before.retiredAt !== null && event.after.retiredAt !== null
  );
}

/** A failed event precondition: the state does not hold the event's `before` values. */
export class StructureEventConflictError extends Error {
  override readonly name = "StructureEventConflictError";
  constructor(
    readonly event: StructureEvent,
    readonly index: number,
    readonly reason: string
  ) {
    super(`Structure event ${index} (${event.op} on ${eventSubject(event)}) conflicts: ${reason}`);
  }
}

function eventSubject(event: StructureEvent): string {
  return "item" in event ? `${event.item} @ ${event.topicId}` : event.topicId;
}

// ---------------------------------------------------------------------------
// Payload helpers

function pick<T extends object, K extends keyof T>(value: T, keys: readonly K[]): Pick<T, K> {
  const output = {} as Pick<T, K>;
  for (const key of keys) {
    const field = value[key];
    output[key] = (Array.isArray(field) ? [...field] : field) as T[K];
  }
  return output;
}

const createFields = topicRecordFields.filter((field) => field !== "id") as Exclude<
  (typeof topicRecordFields)[number],
  "id"
>[];
const renameFields = [
  "title",
  "nameState",
  "nameSource",
  "nameLanguage",
  "namedChangeSetId",
  "aliases"
] as const;
const retirementFields = ["retiredAt", "redirectTo"] as const;

function sameValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    return (
      Array.isArray(a) &&
      Array.isArray(b) &&
      a.length === b.length &&
      a.every((value, index) => value === b[index])
    );
  }
  return a === b;
}

/** The first field where `current` differs from `expected`, or null when they agree. */
function firstDifference(current: object, expected: object): string | null {
  for (const [field, value] of Object.entries(expected)) {
    if (!sameValue((current as Record<string, unknown>)[field], value)) return field;
  }
  return null;
}

function createPayloadOf(node: TopicRecord): TopicCreatePayload {
  return pick(node, createFields);
}

function placementPayloadOf(record: PlacementRecord): PlacementPayload {
  return pick(record, placementRecordFields);
}

// ---------------------------------------------------------------------------
// Apply and invert

/** Topics whose membership or children may have changed (their statistics need a recompute). */
function touch(
  state: TopicTreeState,
  touched: Set<string>,
  ...ids: (string | null | undefined)[]
): void {
  for (const id of ids)
    if (id !== null && id !== undefined && state.topics.has(id)) touched.add(id);
}

function applyOne(
  state: TopicTreeState,
  event: StructureEvent,
  index: number,
  touched: Set<string>
): void {
  const conflict = (reason: string): never => {
    throw new StructureEventConflictError(event, index, reason);
  };
  const expect = (current: object, before: object): void => {
    const field = firstDifference(current, before);
    if (field !== null) conflict(`${field} differs`);
  };
  const topic = (id: string): TopicNode => {
    const node = state.topics.get(id);
    return node ?? conflict(`unknown topic ${id}`);
  };
  try {
    switch (event.op) {
      case "topic.create": {
        if (event.before === null && event.after !== null) {
          if (state.topics.has(event.topicId)) conflict("the topic already exists");
          insertTopic(state, { id: event.topicId, ...event.after });
          touch(state, touched, event.topicId, event.after.parentId);
        } else if (event.before !== null && event.after === null) {
          const node = topic(event.topicId);
          expect(node, event.before);
          const parentId = node.parentId;
          deleteTopic(state, event.topicId);
          touch(state, touched, parentId);
        } else {
          conflict("exactly one of before and after must be null");
        }
        return;
      }
      case "topic.retire":
      case "topic.restore": {
        const node = topic(event.topicId);
        expect(node, event.before);
        if (isRedirectEvent(event)) {
          const target = event.after.redirectTo;
          if (event.before.redirectTo === null || target === null)
            return conflict("a redirect is re-pointed from one topic to another");
          if (event.after.retiredAt !== event.before.retiredAt)
            return conflict("a redirect re-point keeps the retirement time");
          if (target === event.topicId) return conflict("a topic cannot redirect to itself");
          topic(target);
          updateTopicFields(state, event.topicId, event.after);
          return;
        }
        const retiring = event.op === "topic.retire";
        if (retiring !== (event.before.retiredAt === null && event.after.retiredAt !== null)) {
          conflict(
            retiring ? "retire must take a live topic out" : "restore must bring a topic back"
          );
        }
        if (retiring && event.after.redirectTo !== null) {
          if (event.after.redirectTo === event.topicId)
            conflict("a topic cannot redirect to itself");
          topic(event.after.redirectTo);
        }
        if (!retiring && event.after.redirectTo !== null) conflict("a live topic has no redirect");
        updateTopicFields(state, event.topicId, event.after);
        touch(state, touched, event.topicId, node.parentId);
        return;
      }
      case "topic.move": {
        const node = topic(event.topicId);
        expect(node, event.before);
        if (!isLive(node)) conflict("the topic is retired");
        getLiveTopic(state, event.after.parentId);
        updateTopicFields(state, event.topicId, event.after);
        touch(state, touched, event.topicId, event.before.parentId, event.after.parentId);
        return;
      }
      case "topic.rename":
      case "topic.describe":
      case "topic.manage": {
        const node = topic(event.topicId);
        expect(node, event.before);
        updateTopicFields(state, event.topicId, event.after);
        return;
      }
      case "item.place": {
        if (placementAt(state, event.item, event.after.rank)) conflict("the rank is taken");
        if (event.topicId !== event.after.topicId) conflict("topicId differs from the placement");
        insertPlacement(state, event.item, event.after);
        touch(state, touched, event.after.topicId);
        return;
      }
      case "item.unplace": {
        const current = placementAt(state, event.item, event.before.rank);
        if (!current) conflict("no placement at that rank");
        expect(current as PlacementRecord, event.before);
        deletePlacement(state, event.item, event.before.rank);
        touch(state, touched, event.before.topicId);
        return;
      }
      case "item.move": {
        if (event.before.rank !== event.after.rank) conflict("a move keeps the rank");
        if (event.topicId !== event.after.topicId) conflict("topicId differs from the placement");
        const current = placementAt(state, event.item, event.before.rank);
        if (!current) conflict("no placement at that rank");
        expect(current as PlacementRecord, event.before);
        updatePlacementFields(state, event.item, event.before.rank, event.after);
        touch(state, touched, event.before.topicId, event.after.topicId);
        return;
      }
    }
  } catch (error) {
    if (error instanceof StructureEventConflictError) throw error;
    if (error instanceof TopicTreeStateError) conflict(error.message);
    throw error;
  }
}

export function invertEvent(event: StructureEvent): StructureEvent {
  switch (event.op) {
    case "topic.create":
      return {
        op: "topic.create",
        topicId: event.topicId,
        before: event.after,
        after: event.before
      };
    case "topic.retire":
      // A re-point of a redirect is its own inverse, as a move is.
      if (isRedirectEvent(event)) return { ...event, before: event.after, after: event.before };
      return {
        op: "topic.restore",
        topicId: event.topicId,
        before: event.after,
        after: event.before
      };
    case "topic.restore":
      return {
        op: "topic.retire",
        topicId: event.topicId,
        before: event.after,
        after: event.before
      };
    case "topic.move":
    case "topic.rename":
    case "topic.describe":
    case "topic.manage":
      return { ...event, before: event.after, after: event.before } as StructureEvent;
    case "item.place":
      return {
        op: "item.unplace",
        item: event.item,
        topicId: event.after.topicId,
        before: event.after,
        after: null
      };
    case "item.unplace":
      return {
        op: "item.place",
        item: event.item,
        topicId: event.before.topicId,
        before: null,
        after: event.before
      };
    case "item.move":
      return {
        op: "item.move",
        item: event.item,
        topicId: event.before.topicId,
        before: event.after,
        after: event.before
      };
  }
}

/** The events that undo `events`: each inverted, in reverse order. */
export function invertEvents(events: readonly StructureEvent[]): StructureEvent[] {
  return [...events].reverse().map(invertEvent);
}

export interface AppliedEvents {
  /** Live topics whose membership or children changed (recompute their paths). */
  touchedTopics: string[];
}

/**
 * Applies events in order, all or nothing: when an event's precondition fails, the events already
 * applied are rolled back and a StructureEventConflictError names the failing event.
 */
export function applyEvents(
  state: TopicTreeState,
  events: readonly StructureEvent[]
): AppliedEvents {
  const touched = new Set<string>();
  let applied = 0;
  try {
    for (const event of events) {
      applyOne(state, event, applied, touched);
      applied += 1;
    }
  } catch (error) {
    const rollback = invertEvents(events.slice(0, applied));
    rollback.forEach((event, index) => applyOne(state, event, index, new Set()));
    throw error;
  }
  return {
    touchedTopics: [...touched].filter((id) => state.topics.has(id) && isLive(getTopic(state, id)))
  };
}

// ---------------------------------------------------------------------------
// Editor: builds events from the current state, applies them and logs them

export interface TopicTreeEditor {
  readonly state: TopicTreeState;
  /** Events applied so far (empty when the editor does not record). */
  readonly events: StructureEvent[];
  /** Topics touched so far (see AppliedEvents). */
  readonly touched: Set<string>;
  apply(event: StructureEvent): void;
  /** Creates an unnamed AI topic as the last child of `parentId` unless fields say otherwise. */
  createTopic(
    id: string,
    parentId: string,
    fields?: Partial<Omit<TopicCreatePayload, "parentId" | "role">>
  ): TopicNode;
  moveTopic(id: string, parentId: string, position?: number): void;
  retireTopic(id: string, redirectTo: string | null, at: string): void;
  /** Points the redirect of a retired topic at another topic (redirect chains, F4 D19). */
  redirectTopic(id: string, redirectTo: string): void;
  restoreTopic(id: string): void;
  renameTopic(id: string, fields: Partial<TopicRenamePayload>): void;
  describeTopic(id: string, description: string | null): void;
  manageTopic(id: string, management: TopicManagement): void;
  placeItem(item: ItemKey, placement: PlacementRecord): void;
  unplaceItem(item: ItemKey, rank: number): void;
  updatePlacement(
    item: ItemKey,
    rank: number,
    fields: Partial<Omit<PlacementRecord, "rank">>
  ): void;
}

export function createTopicTreeEditor(
  state: TopicTreeState,
  options: { record?: boolean } = {}
): TopicTreeEditor {
  const record = options.record ?? true;
  const events: StructureEvent[] = [];
  const touched = new Set<string>();
  let count = 0;
  const apply = (event: StructureEvent): void => {
    applyOne(state, event, count, touched);
    count += 1;
    if (record) events.push(event);
  };
  const topic = (id: string): TopicNode => getTopic(state, id);
  return {
    state,
    events,
    touched,
    apply,
    createTopic(id, parentId, fields = {}) {
      const after = createPayloadOf(
        topicRecord(id, parentId, {
          position: nextChildPosition(state, parentId),
          ...fields,
          role: "topic"
        })
      );
      apply({ op: "topic.create", topicId: id, before: null, after });
      return topic(id);
    },
    moveTopic(id, parentId, position) {
      const node = topic(id);
      if (node.parentId === null) throw new TopicTreeStateError("The root cannot move");
      const before = { parentId: node.parentId, position: node.position };
      const after = { parentId, position: position ?? nextChildPosition(state, parentId) };
      apply({ op: "topic.move", topicId: id, before, after });
    },
    retireTopic(id, redirectTo, at) {
      const before = pick(topic(id), retirementFields);
      apply({ op: "topic.retire", topicId: id, before, after: { retiredAt: at, redirectTo } });
    },
    redirectTopic(id, redirectTo) {
      const before = pick(topic(id), retirementFields);
      apply({
        op: "topic.retire",
        topicId: id,
        before,
        after: { retiredAt: before.retiredAt, redirectTo }
      });
    },
    restoreTopic(id) {
      const before = pick(topic(id), retirementFields);
      apply({
        op: "topic.restore",
        topicId: id,
        before,
        after: { retiredAt: null, redirectTo: null }
      });
    },
    renameTopic(id, fields) {
      const before = pick(topic(id), renameFields);
      apply({ op: "topic.rename", topicId: id, before, after: { ...before, ...fields } });
    },
    describeTopic(id, description) {
      const before = { description: topic(id).description };
      apply({ op: "topic.describe", topicId: id, before, after: { description } });
    },
    manageTopic(id, management) {
      const before = { management: topic(id).management };
      apply({ op: "topic.manage", topicId: id, before, after: { management } });
    },
    placeItem(item, placement) {
      const after = placementPayloadOf(placement);
      apply({ op: "item.place", item, topicId: after.topicId, before: null, after });
    },
    unplaceItem(item, rank) {
      const current = placementAt(state, item, rank);
      if (!current) throw new TopicTreeStateError(`Item ${item} has no placement at rank ${rank}`);
      const before = placementPayloadOf(current);
      apply({ op: "item.unplace", item, topicId: before.topicId, before, after: null });
    },
    updatePlacement(item, rank, fields) {
      const current = placementAt(state, item, rank);
      if (!current) throw new TopicTreeStateError(`Item ${item} has no placement at rank ${rank}`);
      const before = placementPayloadOf(current);
      const after = { ...before, ...fields, rank };
      apply({ op: "item.move", item, topicId: after.topicId, before, after });
    }
  };
}
