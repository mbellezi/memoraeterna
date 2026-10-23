import { z } from "zod";

import { withinCharacters } from "./note-page.js";
import {
  TopicChangeSetRiskSchema,
  TopicChangeSetStatusSchema,
  TopicMessageParamsSchema,
  TopicUndoAvailabilitySchema,
  topicChangeSetStatuses,
  topicLimits,
  topicReadLimits
} from "./topics.js";

/**
 * Change-sets of every store, read through one view (F4 D10, spec 3.4). Each applied Gardener task
 * leaves a change-set in the store it changed: the topic engine's `topic_change_sets`, a relation
 * pass's `relation_match_runs` (human review and veto runs are not change-sets) and an overview
 * write's `topic_overview_versions`. The `change_sets` view unions them for reading; every store
 * keeps its own exact undo and review, behind one IPC (`changes.*`). Titles are message keys with
 * parameters, never copy; risk follows D11 (`changeSetRisk`). Browser-safe: the database, IPC,
 * preload and renderer share this module.
 */

const uuid = z.string().uuid();
const isoTimestamp = z.string().datetime({ offset: true });
const count = z.number().int().min(0);
const share = z.number().min(0).max(1);
const int = (min: number, max: number) => z.number().int().min(min).max(max);
const boundedText = (max: number, min = 0) =>
  z
    .string()
    .min(min)
    .refine((value) => withinCharacters(value, max));

/** The store a change-set lives in. */
export const changeSetKinds = ["topic", "relation", "overview"] as const;
export const ChangeSetKindSchema = z.enum(changeSetKinds);
export type ChangeSetKind = z.infer<typeof ChangeSetKindSchema>;

/** The statuses every store maps to (the topic engine's own set). */
export const changeSetStatuses = topicChangeSetStatuses;
export const ChangeSetStatusSchema = TopicChangeSetStatusSchema;
export type ChangeSetStatus = z.infer<typeof ChangeSetStatusSchema>;

export const ChangeSetRiskSchema = TopicChangeSetRiskSchema;
export type ChangeSetRisk = z.infer<typeof ChangeSetRiskSchema>;

/**
 * How an overview write changed the text (`topic_overview_versions.origin`): a full `write` (the
 * first one, or `Update`), an additive `patch` (REFRESH), a `rewrite` proposal of a full topic, and
 * the `undo` that restored an earlier version.
 */
export const overviewChangeOrigins = ["write", "patch", "rewrite", "undo"] as const;
export const OverviewChangeOriginSchema = z.enum(overviewChangeOrigins);
export type OverviewChangeOrigin = z.infer<typeof OverviewChangeOriginSchema>;

/**
 * The owner's verdict on a relation pass that waits for review (`relation_match_runs.review_status`):
 * the pass's relations already stand as suggestions, so `kept` leaves them and `dismissed` reverts
 * the pass. Null: the pass never waited for review.
 */
export const relationRunReviewStatuses = ["pending_review", "kept", "dismissed"] as const;
export const RelationRunReviewStatusSchema = z.enum(relationRunReviewStatuses);
export type RelationRunReviewStatus = z.infer<typeof RelationRunReviewStatusSchema>;

/**
 * Kinds of `gardener_findings` (D19, D29): duplicate notes, broken `memora://` links and redirect
 * chains found by AUDIT, and the `backlog` and `budget` Inbox items, stored so a dismissal persists.
 */
export const gardenerFindingKinds = [
  "duplicate",
  "broken_link",
  "redirect_chain",
  "backlog",
  "budget"
] as const;
export const GardenerFindingKindSchema = z.enum(gardenerFindingKinds);
export type GardenerFindingKind = z.infer<typeof GardenerFindingKindSchema>;

export const gardenerFindingStatuses = ["open", "dismissed", "resolved"] as const;
export const GardenerFindingStatusSchema = z.enum(gardenerFindingStatuses);
export type GardenerFindingStatus = z.infer<typeof GardenerFindingStatusSchema>;

// ---------------------------------------------------------------------------
// Typed configuration (RULES.md 1: numbers live here, with tests)

export const ChangeSetConfigSchema = z
  .object({
    /** D11 start values *(cal.)*; moved shares below the rebuild bar use the topic tree config. */
    risk: z
      .object({
        /** A merge moving more items than this is always reviewed. */
        mergeItemsHigh: int(1, 1_000_000).default(30),
        /** A rebuild re-pathing more than this share of the items is always reviewed. */
        rebuildMovedShareHigh: share.default(0.2),
        /** A rename of a topic the owner opened within this many days is medium risk. */
        recentOpenDays: int(1, 365).default(7)
      })
      .strict()
      .prefault({}),
    /** D10 and spec 3.1 Retention *(cal.)*. */
    retention: z
      .object({
        /** Applied or undone change-sets older than this are pruned with their events. */
        changeSetDays: int(1, 3_650).default(90),
        /** Succeeded and canceled jobs older than this are pruned. */
        jobDays: int(1, 3_650).default(30),
        /** Rows a pruning statement removes at most, so one transaction stays short. */
        batchSize: int(1, 100_000).default(500),
        /** Pruning statements one retention job runs at most per store; the next job continues. */
        maxBatches: int(1, 10_000).default(40)
      })
      .strict()
      .prefault({})
  })
  .strict();
export type ChangeSetConfig = z.infer<typeof ChangeSetConfigSchema>;
export type ChangeSetRiskConfig = ChangeSetConfig["risk"];

/** The defaults, as typed configuration. */
export const changeSetConfig: ChangeSetConfig = ChangeSetConfigSchema.parse({});

/** Bounds of the `changes.*` contracts. */
export const changeSetReadLimits = {
  pageDefault: 50,
  pageMax: 50,
  cursorMax: 200,
  originMax: 40,
  blockersMax: 20,
  /** Topics a structural diff lists (deeper levels are summarized), and relations a pass diff lists. */
  diffNodesMax: 200,
  diffRelationsMax: 200,
  diffEventsPerRelationMax: 12,
  /** Paragraphs and divergences of an overview diff side. */
  overviewParagraphsMax: topicReadLimits.overviewParagraphsMax,
  divergencesMax: topicReadLimits.overviewCitationsMax,
  divergenceSummaryMax: 600
} as const;

// ---------------------------------------------------------------------------
// changes.list

/**
 * One change-set as every surface lists it (Activity, Inbox). `subjectId` is what it changed: the
 * tree of a topic change-set, the source of a relation pass (null for a library-wide pass) and the
 * topic of an overview write. `at` is when it was made (proposed, for a pending review).
 */
export const ChangeSetSummarySchema = z
  .object({
    kind: ChangeSetKindSchema,
    id: uuid,
    titleKey: z.string().min(1).max(200),
    titleParams: TopicMessageParamsSchema,
    risk: ChangeSetRiskSchema,
    status: ChangeSetStatusSchema,
    /** The store's own origin: a topic origin, a relation pass kind or an overview origin. */
    origin: z.string().min(1).max(changeSetReadLimits.originMax),
    subjectId: uuid.nullable(),
    jobId: uuid.nullable(),
    at: isoTimestamp,
    undoneAt: isoTimestamp.nullable(),
    undo: TopicUndoAvailabilitySchema
  })
  .strict();
export type ChangeSetSummary = z.infer<typeof ChangeSetSummarySchema>;

/** Newest first, by kind, status or risk; `cursor` continues a page. */
export const ChangesListInputSchema = z
  .object({
    kind: ChangeSetKindSchema.optional(),
    status: ChangeSetStatusSchema.optional(),
    risk: ChangeSetRiskSchema.optional(),
    cursor: z.string().min(1).max(changeSetReadLimits.cursorMax).optional(),
    limit: int(1, changeSetReadLimits.pageMax).default(changeSetReadLimits.pageDefault)
  })
  .strict();
export type ChangesListInput = z.input<typeof ChangesListInputSchema>;

export const ChangesListSchema = z
  .object({
    items: z.array(ChangeSetSummarySchema).max(changeSetReadLimits.pageMax),
    nextCursor: z.string().min(1).max(changeSetReadLimits.cursorMax).nullable()
  })
  .strict();
export type ChangesList = z.infer<typeof ChangesListSchema>;

/** Change-sets that wait for the owner, per store and risk (the Inbox badge). */
export const ChangesPendingCountsSchema = z
  .object({
    total: count,
    byKind: z.object({ topic: count, relation: count, overview: count }).strict(),
    byRisk: z.object({ low: count, medium: count, high: count }).strict()
  })
  .strict();
export type ChangesPendingCounts = z.infer<typeof ChangesPendingCountsSchema>;

// ---------------------------------------------------------------------------
// changes.undo and changes.review

export const ChangeSetRefSchema = z.object({ kind: ChangeSetKindSchema, id: uuid }).strict();
export type ChangeSetRef = z.infer<typeof ChangeSetRefSchema>;

/**
 * Why an undo (or a dismissal that reverts) cannot run, as the interface words it:
 * `later_change` a later change-set (`changeSet`) changed the same objects; `item_deleted` an
 * object it changed is gone; `changed_since` an object changed without a change-set (a human
 * verdict, an edit); `not_applied` it is not applied (pending, dismissed or already undone);
 * `not_undoable` it never can be (a build, an undo, a first overview); `newer_version` the overview
 * was written again since; `run_open` the relation pass is still running; `conflict` the tree
 * refused the inverse.
 */
export const changeSetBlockerCodes = [
  "later_change",
  "item_deleted",
  "changed_since",
  "not_applied",
  "not_undoable",
  "newer_version",
  "run_open",
  "conflict"
] as const;
export const ChangeSetBlockerCodeSchema = z.enum(changeSetBlockerCodes);
export type ChangeSetBlockerCode = z.infer<typeof ChangeSetBlockerCodeSchema>;

export const ChangeSetBlockerSchema = z
  .object({ code: ChangeSetBlockerCodeSchema, changeSet: ChangeSetRefSchema.nullable() })
  .strict();
export type ChangeSetBlocker = z.infer<typeof ChangeSetBlockerSchema>;

export const ChangesUndoInputSchema = ChangeSetRefSchema;
export type ChangesUndoInput = z.input<typeof ChangesUndoInputSchema>;

export const ChangesUndoResultSchema = z.discriminatedUnion("status", [
  z.object({ status: z.literal("undone"), kind: ChangeSetKindSchema, id: uuid }).strict(),
  z
    .object({
      status: z.literal("blocked"),
      blockers: z.array(ChangeSetBlockerSchema).min(1).max(changeSetReadLimits.blockersMax),
      /** Blockers beyond the ones listed. */
      more: count
    })
    .strict()
]);
export type ChangesUndoResult = z.infer<typeof ChangesUndoResultSchema>;

export const changeSetVerdicts = ["apply", "dismiss"] as const;
export const ChangesReviewInputSchema = z
  .object({ kind: ChangeSetKindSchema, id: uuid, verdict: z.enum(changeSetVerdicts) })
  .strict();
export type ChangesReviewInput = z.input<typeof ChangesReviewInputSchema>;

/**
 * The status that stands after the verdict (a second verdict answers the first one's). `stale`: an
 * overview proposal whose base was written again since; it stays pending until it is proposed
 * again. `blocked`: dismissing a relation pass needs its revert, which something blocks.
 */
export const ChangesReviewResultSchema = z.discriminatedUnion("status", [
  z.object({ status: ChangeSetStatusSchema }).strict(),
  z.object({ status: z.literal("stale") }).strict(),
  z
    .object({
      status: z.literal("blocked"),
      blockers: z.array(ChangeSetBlockerSchema).min(1).max(changeSetReadLimits.blockersMax),
      more: count
    })
    .strict()
]);
export type ChangesReviewResult = z.infer<typeof ChangesReviewResultSchema>;

// ---------------------------------------------------------------------------
// changes.diff (bounded, for the icicle diff and its table alternative)

const topicTitle = boundedText(topicLimits.titleMaxLength, 1);
const itemTitle = boundedText(topicReadLimits.itemTitleMax);

/**
 * One topic of a structural diff. `parentBefore`/`parentAfter` and the titles give the two trees;
 * a topic the change-set created has no `before` side and one it retired no `after` side.
 * `changed`: its description or management changed; `items`: only placements moved in or out.
 * `context` topics are ancestors shown so the affected subtree hangs from the root.
 */
export const topicDiffChanges = [
  "added",
  "removed",
  "moved",
  "renamed",
  "changed",
  "items",
  "context"
] as const;
export type TopicDiffChange = (typeof topicDiffChanges)[number];
export const TopicDiffNodeSchema = z
  .object({
    id: uuid,
    change: z.enum(topicDiffChanges),
    existedBefore: z.boolean(),
    existsAfter: z.boolean(),
    parentBefore: uuid.nullable(),
    parentAfter: uuid.nullable(),
    titleBefore: topicTitle.nullable(),
    titleAfter: topicTitle.nullable(),
    /** Primary placements the change-set moved into and out of the topic. */
    itemsIn: count,
    itemsOut: count
  })
  .strict();
export type TopicDiffNode = z.infer<typeof TopicDiffNodeSchema>;

export const relationDiffChanges = ["created", "removed", "changed"] as const;
const relationSide = z
  .object({
    status: z.string().min(1).max(40).nullable(),
    band: z.string().min(1).max(40).nullable(),
    type: z.string().min(1).max(60).nullable()
  })
  .strict();
const relationEnd = z.object({ id: uuid.nullable(), title: itemTitle.nullable() }).strict();
export const RelationDiffItemSchema = z
  .object({
    relationKind: z.enum(["note", "source"]),
    relationId: uuid.nullable(),
    change: z.enum(relationDiffChanges),
    /** The pass's events on the relation, in order. */
    events: z.array(z.string().min(1).max(40)).max(changeSetReadLimits.diffEventsPerRelationMax),
    from: relationEnd,
    to: relationEnd,
    before: relationSide.nullable(),
    after: relationSide.nullable()
  })
  .strict();
export type RelationDiffItem = z.infer<typeof RelationDiffItemSchema>;

export const OverviewDivergenceSchema = z
  .object({
    existing: z.string().min(1).max(8),
    new: z.string().min(1).max(8),
    summary: boundedText(changeSetReadLimits.divergenceSummaryMax, 1)
  })
  .strict();
export type OverviewDivergence = z.infer<typeof OverviewDivergenceSchema>;

const overviewSide = z
  .object({
    version: count,
    paragraphs: z
      .array(
        z
          .object({
            text: z.string().min(1).max(4_000),
            citations: z.array(z.number().int().min(1)).max(topicReadLimits.overviewCitationsMax)
          })
          .strict()
      )
      .max(changeSetReadLimits.overviewParagraphsMax),
    divergences: z.array(OverviewDivergenceSchema).max(changeSetReadLimits.divergencesMax)
  })
  .strict();
export type OverviewDiffSide = z.infer<typeof overviewSide>;

export const ChangesDiffInputSchema = ChangeSetRefSchema;
export type ChangesDiffInput = z.input<typeof ChangesDiffInputSchema>;

export const ChangesDiffSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("topic"),
      summary: ChangeSetSummarySchema,
      nodes: z.array(TopicDiffNodeSchema).max(changeSetReadLimits.diffNodesMax),
      /** Topics the change-set touched beyond the ones listed (deeper levels summarized). */
      hidden: count
    })
    .strict(),
  z
    .object({
      kind: z.literal("relation"),
      summary: ChangeSetSummarySchema,
      relations: z.array(RelationDiffItemSchema).max(changeSetReadLimits.diffRelationsMax),
      hidden: count
    })
    .strict(),
  z
    .object({
      kind: z.literal("overview"),
      summary: ChangeSetSummarySchema,
      topic: z.object({ id: uuid, title: topicTitle.nullable() }).strict(),
      before: overviewSide.nullable(),
      after: overviewSide.nullable()
    })
    .strict()
]);
export type ChangesDiff = z.infer<typeof ChangesDiffSchema>;

/** The message keys of the failures the changes handlers report (`new Error(key)`). */
export const changeSetErrorKeys = [
  "changes.errors.notFound",
  "changes.errors.invalidCursor",
  /** No database, or the store's handler is not installed. */
  "changes.errors.unavailable"
] as const;
export const ChangeSetErrorKeySchema = z.enum(changeSetErrorKeys);
export type ChangeSetErrorKey = z.infer<typeof ChangeSetErrorKeySchema>;

/**
 * The relation pass kinds that are change-sets: every pass but the human review and veto ones
 * (`relation_match_runs.kind`; the `change_sets` view leaves those out).
 */
export const relationChangeSetKinds = [
  "match",
  "link",
  "type",
  "promote",
  "discover",
  "reconcile",
  "retype"
] as const;

/** The default title key of a relation pass that recorded none (passes written before F4). */
export const relationRunTitleKey = (kind: string): string => `changes.titles.relation.${kind}`;
