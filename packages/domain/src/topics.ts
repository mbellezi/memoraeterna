import { z } from "zod";

import { AtomicNoteRelationTypeSchema } from "./knowledge.js";
import { withinCharacters } from "./note-page.js";

/**
 * Browser-safe topic vocabulary (F2 Topic Tree Engine, docs/plan.md 4.1). The engine itself is
 * exported only through `@app/domain/topic-tree` (main process and workers); this module holds
 * the enums, limits and push payloads that the database, IPC, preload and renderer share with it.
 * The IPC request and response contracts of the topic screens extend this module (T16).
 */

const uuid = z.string().uuid();

/** One active tree per library; a replaced tree is retired (D2: no shadow tree, no topic modes). */
export const topicTreeStatuses = ["active", "retired"] as const;
export const TopicTreeStatusSchema = z.enum(topicTreeStatuses);
export type TopicTreeStatus = z.infer<typeof TopicTreeStatusSchema>;

export const topicRoles = ["root", "topic"] as const;
export const TopicRoleSchema = z.enum(topicRoles);
export type TopicRole = z.infer<typeof TopicRoleSchema>;

/** `unnamed` topics store no title; the interface renders a localized "Unnamed topic". */
export const topicNameStates = ["named", "provisional", "unnamed"] as const;
export const TopicNameStateSchema = z.enum(topicNameStates);
export type TopicNameState = z.infer<typeof TopicNameStateSchema>;

export const topicNameSources = ["llm", "human", "tfidf"] as const;
export const TopicNameSourceSchema = z.enum(topicNameSources);
export type TopicNameSource = z.infer<typeof TopicNameSourceSchema>;

/** `human` and `pinned` topics are protected: automation never moves, renames or dissolves them. */
export const topicManagements = ["ai", "human", "pinned"] as const;
export const TopicManagementSchema = z.enum(topicManagements);
export type TopicManagement = z.infer<typeof TopicManagementSchema>;

export const topicHealthValues = ["good", "attention", "violation"] as const;
export const TopicHealthSchema = z.enum(topicHealthValues);
export type TopicHealth = z.infer<typeof TopicHealthSchema>;

/** Items placed in the tree: atomic notes and root sources (D8). */
export const topicItemKinds = ["note", "source"] as const;
export const TopicItemKindSchema = z.enum(topicItemKinds);
export type TopicItemKind = z.infer<typeof TopicItemKindSchema>;

export const topicPlacementRoles = ["primary", "secondary"] as const;
export const TopicPlacementRoleSchema = z.enum(topicPlacementRoles);
export type TopicPlacementRole = z.infer<typeof TopicPlacementRoleSchema>;

export const topicPlacementManagements = ["ai", "human"] as const;
export const TopicPlacementManagementSchema = z.enum(topicPlacementManagements);
export type TopicPlacementManagement = z.infer<typeof TopicPlacementManagementSchema>;

/** How a placement was decided (`topic_placements.decided_by`). */
export const topicPlacementDecisions = [
  "build",
  "auto",
  "gate",
  "fallback",
  "human",
  "rebuild"
] as const;
export const TopicPlacementDecisionSchema = z.enum(topicPlacementDecisions);
export type TopicPlacementDecision = z.infer<typeof TopicPlacementDecisionSchema>;

export const topicChangeSetOrigins = [
  "build",
  "place",
  "gate",
  "rebalance",
  "audit",
  "naming",
  "areas",
  "human",
  "undo",
  "rebuild"
] as const;
export const TopicChangeSetOriginSchema = z.enum(topicChangeSetOrigins);
export type TopicChangeSetOrigin = z.infer<typeof TopicChangeSetOriginSchema>;

export const topicChangeSetStatuses = ["applied", "undone", "pending_review", "dismissed"] as const;
export const TopicChangeSetStatusSchema = z.enum(topicChangeSetStatuses);
export type TopicChangeSetStatus = z.infer<typeof TopicChangeSetStatusSchema>;

export const topicChangeSetRisks = ["low", "medium", "high"] as const;
export const TopicChangeSetRiskSchema = z.enum(topicChangeSetRisks);
export type TopicChangeSetRisk = z.infer<typeof TopicChangeSetRiskSchema>;

/** The complete structure-event vocabulary (`topic_structure_events.op`). */
export const topicStructureEventOps = [
  "topic.create",
  "topic.retire",
  "topic.restore",
  "topic.move",
  "topic.rename",
  "topic.describe",
  "topic.manage",
  "item.place",
  "item.unplace",
  "item.move"
] as const;
export const TopicStructureEventOpSchema = z.enum(topicStructureEventOps);
export type TopicStructureEventOp = z.infer<typeof TopicStructureEventOpSchema>;

/** `topics.status` phase: the first build of the active tree is running, or the tree is active (D39). */
export const topicsPhases = ["building", "active"] as const;
export const TopicsPhaseSchema = z.enum(topicsPhases);
export type TopicsPhase = z.infer<typeof TopicsPhaseSchema>;

/** Informative reasons the engine is waiting; never blocking. */
export const topicsBlockedReasons = [
  "no_embedding_route",
  "space_changed",
  "waiting_for_embeddings",
  "no_decider"
] as const;
export const TopicsBlockedReasonSchema = z.enum(topicsBlockedReasons);
export type TopicsBlockedReason = z.infer<typeof TopicsBlockedReasonSchema>;

/** Field limits shared by the engine, the database checks and the contracts. */
export const topicLimits = {
  titleMaxLength: 120,
  descriptionMaxLength: 400,
  aliasMaxLength: 120,
  aliasesMax: 10,
  languageMaxLength: 16,
  maxSecondaryPlacements: 2,
  changedTopicIdsMax: 200
} as const;

export const TopicTitleSchema = z.string().trim().min(1).max(topicLimits.titleMaxLength);
export const TopicDescriptionSchema = z
  .string()
  .trim()
  .min(1)
  .max(topicLimits.descriptionMaxLength);
export const TopicAliasesSchema = z
  .array(z.string().trim().min(1).max(topicLimits.aliasMaxLength))
  .max(topicLimits.aliasesMax);

/**
 * Push payload after a topic change-set commits (D15): coalesced, `topicIds` null when the change
 * is too broad to list.
 */
export const TopicsChangedEventSchema = z
  .object({
    treeId: uuid,
    generation: z.number().int().min(0),
    topicIds: z.array(uuid).max(topicLimits.changedTopicIdsMax).nullable(),
    changeSetId: uuid.nullable()
  })
  .strict();
export type TopicsChangedEvent = z.infer<typeof TopicsChangedEventSchema>;

// ---------------------------------------------------------------------------
// IPC contracts of the topic screens (T16, spec 3.7)
//
// Every request is strict and bounded, every ID is a UUID, and every text the interface shows is a
// stored name or a message key with parameters, never copy. The preload validates a request before
// it crosses the process boundary and a response before the renderer sees it; the main process
// validates both again. `topics.overview*` (T31) and the legacy switch are not part of this module,
// except the overview state that a Topic page carries.

const isoTimestamp = z.string().datetime({ offset: true });
const count = z.number().int().min(0);
const share = z.number().min(0).max(1);

/**
 * A string bounded in characters, the unit `left()` and `char_length` count in the database. Zod's
 * `max` counts UTF-16 units, so one emoji at the bound would fail a page the database cut correctly.
 */
const boundedText = (max: number, min = 0) =>
  z
    .string()
    .min(min)
    .refine((value) => withinCharacters(value, max));

/** Bounds of the read contracts. */
export const topicReadLimits = {
  /** Children per `topics.tree` page. */
  childrenDefault: 100,
  childrenMax: 200,
  /** An opaque keyset cursor. */
  cursorMax: 200,
  /** Leaves listed with a `topics.tree` answer. */
  treeItemsDefault: 5,
  treeItemsMax: 50,
  /** Leaves per `topics.notes` page. */
  itemsPageDefault: 50,
  itemsPageMax: 100,
  /** Central notes on a Topic page. */
  centralNotesDefault: 6,
  centralNotesMax: 20,
  /** The longest path: the root and the depth cap (7). */
  pathMax: 8,
  subtopicsMax: 16,
  sourcesMax: 20,
  relatedTopicsMax: 8,
  /** The note title, the idea statement and a source title as shown in a list. */
  itemTitleMax: 300,
  ideaMax: 400,
  subtitleMax: 300,
  shapeDepthDefault: 4,
  shapeDepthMax: 5,
  shapeNodesMax: 2_000,
  shapeWarningsMax: 50,
  shapeChangedMax: 20,
  changeSetTopicsMax: 50,
  changeSetItemsMax: 50,
  undoBlockersMax: 10,
  /** Paragraphs and citations of an overview. */
  overviewParagraphsMax: 12,
  overviewCitationsMax: 40,
  overviewExcerptMax: 1_200
} as const;

/** The message keys of the failures the topic handlers report (`new Error(key)`). */
export const topicErrorKeys = [
  "topics.errors.stale",
  "topics.errors.cycle",
  "topics.errors.duplicateTitle",
  "topics.errors.notFound",
  "topics.errors.protected",
  /** The handler of the call has not been installed (an operation another task adds). */
  "topics.errors.unavailable"
] as const;
export const TopicErrorKeySchema = z.enum(topicErrorKeys);
export type TopicErrorKey = z.infer<typeof TopicErrorKeySchema>;

const topicName = boundedText(topicLimits.titleMaxLength, 1);

/**
 * One topic as a navigator row or an icicle cell. `items` counts the primary placements of the whole
 * subtree (notes and sources) and `directItems` those placed on the topic itself. `unsorted` counts
 * the direct items that wait for a place (docs D27: for the root every direct item; elsewhere the
 * items waiting for the gate or a split check). `title` is null for a topic that is not named yet.
 */
export const TopicNodeSummarySchema = z
  .object({
    id: uuid,
    parentId: uuid.nullable(),
    title: topicName.nullable(),
    nameState: TopicNameStateSchema,
    management: TopicManagementSchema,
    items: count,
    directItems: count,
    unsorted: count,
    children: count,
    health: TopicHealthSchema,
    /** Items placed in the subtree during the last seven days, without the first build. */
    newThisWeek: count,
    position: count,
    /** The optimistic-concurrency token of a rename or a move (`topics.mutate`). */
    updatedAt: isoTimestamp
  })
  .strict();
export type TopicNodeSummary = z.infer<typeof TopicNodeSummarySchema>;

const leafBase = {
  id: uuid,
  title: boundedText(topicReadLimits.itemTitleMax),
  /** `secondary` leaves are notes or sources that also appear here. */
  role: TopicPlacementRoleSchema,
  /** The item waits for a place (docs D27). */
  unsorted: z.boolean()
};

export const topicProvenanceValues = ["ai", "human"] as const;
export const TopicProvenanceSchema = z.enum(topicProvenanceValues);
export type TopicProvenance = z.infer<typeof TopicProvenanceSchema>;

export const TopicNoteLeafSchema = z
  .object({
    kind: z.literal("note"),
    ...leafBase,
    /** The source the note was generated from; null when it is gone. */
    sourceTitle: boundedText(topicReadLimits.itemTitleMax).nullable(),
    provenance: TopicProvenanceSchema
  })
  .strict();
export type TopicNoteLeaf = z.infer<typeof TopicNoteLeafSchema>;

export const TopicSourceLeafSchema = z
  .object({
    kind: z.literal("source"),
    ...leafBase,
    /** Notes of this source placed on the topic. */
    noteCount: count
  })
  .strict();
export type TopicSourceLeaf = z.infer<typeof TopicSourceLeafSchema>;

export const TopicItemLeafSchema = z.discriminatedUnion("kind", [
  TopicNoteLeafSchema,
  TopicSourceLeafSchema
]);
export type TopicItemLeaf = z.infer<typeof TopicItemLeafSchema>;

const cursorSchema = z.string().min(1).max(topicReadLimits.cursorMax);

/** `topics.tree`: a page of the children of a topic (the root's when `parentId` is null). */
export const TopicTreeInputSchema = z
  .object({
    parentId: uuid.nullable().default(null),
    cursor: cursorSchema.optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(topicReadLimits.childrenMax)
      .default(topicReadLimits.childrenDefault),
    includeItems: z.boolean().default(false),
    itemLimit: z
      .number()
      .int()
      .min(0)
      .max(topicReadLimits.treeItemsMax)
      .default(topicReadLimits.treeItemsDefault)
  })
  .strict();
export type TopicTreeInput = z.input<typeof TopicTreeInputSchema>;

export const TopicTreeSchema = z
  .object({
    /** The tree generation this answer was read at. */
    generation: count,
    parent: TopicNodeSummarySchema,
    nodes: z.array(TopicNodeSummarySchema).max(topicReadLimits.childrenMax),
    /** The parent's own leaves (when asked), primary first, then the ones that also appear here. */
    items: z.array(TopicItemLeafSchema).max(topicReadLimits.treeItemsMax),
    /** Leaves of the parent that `items` leaves out. */
    moreItems: count,
    /** The parent's unsorted direct items. */
    unsorted: count,
    nextCursor: cursorSchema.nullable()
  })
  .strict();
export type TopicTree = z.infer<typeof TopicTreeSchema>;

export const TopicPathEntrySchema = z.object({ id: uuid, title: topicName.nullable() }).strict();
export type TopicPathEntry = z.infer<typeof TopicPathEntrySchema>;
const pathSchema = z.array(TopicPathEntrySchema).max(topicReadLimits.pathMax);

/** `topics.path`: the root-to-topic path; a retired topic resolves to its successor. */
export const TopicPathInputSchema = z.object({ id: uuid }).strict();
export type TopicPathInput = z.input<typeof TopicPathInputSchema>;
export const TopicPathSchema = z
  .object({
    resolvedId: uuid,
    redirectedFrom: uuid.nullable(),
    path: pathSchema
  })
  .strict();
export type TopicPath = z.infer<typeof TopicPathSchema>;

/** The opened topic: its summary plus what only a page shows. */
export const TopicPageTopicSchema = TopicNodeSummarySchema.extend({
  description: boundedText(topicLimits.descriptionMaxLength, 1).nullable(),
  aliases: z.array(boundedText(topicLimits.aliasMaxLength, 1)).max(topicLimits.aliasesMax),
  nameLanguage: z.string().min(1).max(topicLimits.languageMaxLength).nullable(),
  /** Mean cosine of the members to the centroid, 0..1; null while the statistics are missing. */
  coherence: share.nullable()
}).strict();
export type TopicPageTopic = z.infer<typeof TopicPageTopicSchema>;

export const TopicSubtopicSchema = z
  .object({
    id: uuid,
    title: topicName.nullable(),
    items: count,
    description: boundedText(topicLimits.descriptionMaxLength, 1).nullable(),
    health: TopicHealthSchema
  })
  .strict();
export type TopicSubtopic = z.infer<typeof TopicSubtopicSchema>;

export const TopicCentralNoteSchema = z
  .object({
    id: uuid,
    title: boundedText(topicReadLimits.itemTitleMax),
    idea: boundedText(topicReadLimits.ideaMax),
    sourceId: uuid.nullable(),
    sourceTitle: boundedText(topicReadLimits.itemTitleMax).nullable(),
    /** Relations to other current notes that are not rejected. */
    relationCount: count,
    provenance: TopicProvenanceSchema,
    /** Cosine to the centroid of the topic that holds the note; null before it was computed. */
    centrality: share.nullable(),
    /** Set while the note was moved here recently (seven days). */
    movedFrom: z
      .object({ id: uuid, title: topicName.nullable(), at: isoTimestamp })
      .strict()
      .optional()
  })
  .strict();
export type TopicCentralNote = z.infer<typeof TopicCentralNoteSchema>;

export const TopicContributingSourceSchema = z
  .object({
    id: uuid,
    title: boundedText(topicReadLimits.itemTitleMax),
    subtitle: boundedText(topicReadLimits.subtitleMax).nullable(),
    /** Notes of this source inside the topic. */
    noteCount: count
  })
  .strict();
export type TopicContributingSource = z.infer<typeof TopicContributingSourceSchema>;

export const TopicRelatedTopicSchema = z
  .object({ id: uuid, title: topicName.nullable(), relationCount: count })
  .strict();
export type TopicRelatedTopic = z.infer<typeof TopicRelatedTopicSchema>;

/** Whether a change can be undone: nothing known blocks it, a later change does, or it never can. */
export const topicUndoAvailabilityValues = ["available", "blocked", "unavailable"] as const;
export const TopicUndoAvailabilitySchema = z.enum(topicUndoAvailabilityValues);
export type TopicUndoAvailability = z.infer<typeof TopicUndoAvailabilitySchema>;

/** Message-key parameters: scalars only, so they cross every boundary unchanged. */
export const TopicMessageParamsSchema = z.record(
  z.string().min(1).max(60),
  z.union([z.string().max(300), z.number(), z.boolean(), z.null()])
);
export type TopicMessageParams = z.infer<typeof TopicMessageParamsSchema>;

export const TopicLastChangeSchema = z
  .object({
    changeSetId: uuid,
    titleKey: z.string().min(1).max(200),
    titleParams: TopicMessageParamsSchema,
    at: isoTimestamp,
    undo: TopicUndoAvailabilitySchema
  })
  .strict();
export type TopicLastChange = z.infer<typeof TopicLastChangeSchema>;

/** The overview of a topic (T31 writes it on open); the page carries its state, never a model call. */
export const TopicOverviewCitationSchema = z
  .object({
    n: z.number().int().min(1).max(topicReadLimits.overviewCitationsMax),
    /** The cited passage; absent once its chunk was replaced (the stored excerpt stays readable). */
    chunkId: uuid.optional(),
    sourceSpanId: uuid.optional(),
    noteId: uuid.optional(),
    /** The source the passage belongs to; absent when it is gone. */
    sourceId: uuid.optional(),
    sourceTitle: boundedText(topicReadLimits.itemTitleMax),
    excerpt: boundedText(topicReadLimits.overviewExcerptMax),
    /** The passage still belongs to the current version of its source. */
    available: z.boolean()
  })
  .strict();
export type TopicOverviewCitation = z.infer<typeof TopicOverviewCitationSchema>;

export const TopicOverviewStateSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("absent"),
      /** An overview can be written now (a writer route is ready and the topic has notes). */
      canWrite: z.boolean(),
      reasonKey: z.string().min(1).max(200).optional()
    })
    .strict(),
  z.object({ status: z.literal("writing") }).strict(),
  z
    .object({
      status: z.literal("ready"),
      /** The members changed since it was written. */
      stale: z.boolean(),
      paragraphs: z
        .array(
          z
            .object({
              text: z.string().min(1).max(4_000),
              citations: z.array(z.number().int().min(1)).max(topicReadLimits.overviewCitationsMax)
            })
            .strict()
        )
        .max(topicReadLimits.overviewParagraphsMax),
      citations: z.array(TopicOverviewCitationSchema).max(topicReadLimits.overviewCitationsMax),
      /** The notes it was written from, of the notes the topic held then (the page states both). */
      evidence: z.object({ used: count, total: count }).strict(),
      writtenAt: isoTimestamp,
      model: z.string().min(1).max(200),
      /** The content language it is written in (BCP 47). */
      language: z.string().min(1).max(16),
      support: z
        .object({
          /** `checking` while the ranker check that follows the writing runs (it never blocks it). */
          status: z.enum(["verified", "partial", "unchecked", "checking"]),
          /** Paragraph indexes the support check could not verify. */
          unsupported: z.array(z.number().int().min(0)).max(topicReadLimits.overviewParagraphsMax),
          /** Sentences the ranker checked and those a cited passage supports. */
          sentences: z.object({ checked: count, supported: count }).strict().optional()
        })
        .strict()
    })
    .strict(),
  z.object({ status: z.literal("failed"), messageKey: z.string().min(1).max(200) }).strict()
]);
export type TopicOverviewState = z.infer<typeof TopicOverviewStateSchema>;

/** Counts of the relations touching the topic's most central notes, by type (unknown types count as `related`). */
export const TopicRelationStancesSchema = z
  .object({
    supports: count,
    contrasts: count,
    extends: count,
    similar_to: count,
    depends_on: count,
    clarifies: count,
    mentions: count,
    related: count
  })
  .strict();
export type TopicRelationStances = z.infer<typeof TopicRelationStancesSchema>;

/** The relation types a stance count covers, in the vocabulary of the notes. */
export const topicRelationStanceTypes = AtomicNoteRelationTypeSchema.options;

/** `topics.page`: everything a Topic page renders in one read-only answer, without AI. */
export const TopicPageInputSchema = z
  .object({
    id: uuid,
    noteLimit: z
      .number()
      .int()
      .min(1)
      .max(topicReadLimits.centralNotesMax)
      .default(topicReadLimits.centralNotesDefault)
  })
  .strict();
export type TopicPageInput = z.input<typeof TopicPageInputSchema>;

export const TopicPageSchema = z
  .object({
    generation: count,
    topic: TopicPageTopicSchema,
    redirectedFrom: uuid.nullable(),
    path: pathSchema,
    counts: z.object({ notes: count, sources: count, subtopics: count }).strict(),
    subtopics: z.array(TopicSubtopicSchema).max(topicReadLimits.subtopicsMax),
    centralNotes: z.array(TopicCentralNoteSchema).max(topicReadLimits.centralNotesMax),
    /** Notes of the topic that `centralNotes` leaves out. */
    moreNotes: count,
    sources: z.array(TopicContributingSourceSchema).max(topicReadLimits.sourcesMax),
    relatedTopics: z.array(TopicRelatedTopicSchema).max(topicReadLimits.relatedTopicsMax),
    relationStances: TopicRelationStancesSchema,
    lastChange: TopicLastChangeSchema.nullable(),
    overview: TopicOverviewStateSchema
  })
  .strict();
export type TopicPage = z.infer<typeof TopicPageSchema>;

/**
 * `topics.notes`: leaves of a topic in pages. `direct` lists the topic's own placements (primary
 * first, then the ones that also appear there); `subtree` lists the primary placements of the whole
 * subtree. `kind: "note"` leaves sources out.
 */
export const topicItemScopes = ["direct", "subtree"] as const;
export const topicItemKindFilters = ["all", "note"] as const;
export const TopicNotesInputSchema = z
  .object({
    id: uuid,
    cursor: cursorSchema.optional(),
    limit: z
      .number()
      .int()
      .min(1)
      .max(topicReadLimits.itemsPageMax)
      .default(topicReadLimits.itemsPageDefault),
    scope: z.enum(topicItemScopes).default("direct"),
    kind: z.enum(topicItemKindFilters).default("all")
  })
  .strict();
export type TopicNotesInput = z.input<typeof TopicNotesInputSchema>;

export const TopicNotesSchema = z
  .object({
    items: z.array(TopicItemLeafSchema).max(topicReadLimits.itemsPageMax),
    nextCursor: cursorSchema.nullable()
  })
  .strict();
export type TopicNotes = z.infer<typeof TopicNotesSchema>;

export const TopicChangeSetSummarySchema = z
  .object({
    id: uuid,
    origin: TopicChangeSetOriginSchema,
    status: TopicChangeSetStatusSchema,
    titleKey: z.string().min(1).max(200),
    titleParams: TopicMessageParamsSchema,
    risk: TopicChangeSetRiskSchema,
    /** When it was applied; the proposal time while it is still pending review. */
    at: isoTimestamp,
    undo: TopicUndoAvailabilitySchema
  })
  .strict();
export type TopicChangeSetSummary = z.infer<typeof TopicChangeSetSummarySchema>;

/** `topics.shape`: the whole tree (or one branch) as a flat list of cells with the shape verdict. */
export const TopicShapeInputSchema = z
  .object({
    rootId: uuid.nullable().default(null),
    depth: z
      .number()
      .int()
      .min(1)
      .max(topicReadLimits.shapeDepthMax)
      .default(topicReadLimits.shapeDepthDefault),
    nodeLimit: z
      .number()
      .int()
      .min(1)
      .max(topicReadLimits.shapeNodesMax)
      .default(topicReadLimits.shapeNodesMax)
  })
  .strict();
export type TopicShapeInput = z.input<typeof TopicShapeInputSchema>;

export const TopicShapeNodeSchema = z
  .object({
    id: uuid,
    parentId: uuid.nullable(),
    /** 0 for the requested root. */
    depth: count,
    title: topicName.nullable(),
    management: TopicManagementSchema,
    items: count,
    directItems: count,
    children: count,
    health: TopicHealthSchema,
    newThisWeek: count,
    coherence: share.nullable()
  })
  .strict();
export type TopicShapeNode = z.infer<typeof TopicShapeNodeSchema>;

export const TopicShapeWarningSchema = z
  .object({
    topicId: uuid.nullable(),
    /** A message-key suffix: an invariant reason (`single-child`) or `pending-review`. */
    code: z.string().min(1).max(80),
    params: TopicMessageParamsSchema,
    changeSetId: uuid.nullable(),
    /** A proposal that waits for the owner (docs D29). */
    pendingReview: z.boolean()
  })
  .strict();
export type TopicShapeWarning = z.infer<typeof TopicShapeWarningSchema>;

export const TopicShapeSchema = z
  .object({
    generation: count,
    summary: z
      .object({
        /** Primary placements below the requested root. */
        items: count,
        /** Live topics below the requested root, the root excluded. */
        topics: count,
        /** Mean depth of the items below the requested root. */
        meanDepth: z.number().min(0),
        /** Share of the placed items that a walk from the root reaches. */
        reachable: share,
        /** Share of the items that wait for a place (docs D27). */
        unsortedShare: share,
        /** Items waiting for a vector, reported apart from the unsorted share. */
        needsVector: count,
        soft: count,
        hard: count
      })
      .strict(),
    nodes: z.array(TopicShapeNodeSchema).max(topicReadLimits.shapeNodesMax),
    /** More cells exist than `nodes` lists (the depth or the node limit cut them). */
    truncated: z.boolean(),
    warnings: z.array(TopicShapeWarningSchema).max(topicReadLimits.shapeWarningsMax),
    changedToday: z.array(TopicChangeSetSummarySchema).max(topicReadLimits.shapeChangedMax)
  })
  .strict();
export type TopicShape = z.infer<typeof TopicShapeSchema>;

/** `topics.changeSets.get`: a textual before and after of one change-set. */
export const TopicChangeSetInputSchema = z.object({ id: uuid }).strict();
export type TopicChangeSetInput = z.input<typeof TopicChangeSetInputSchema>;

const changeSetTopicSchema = z
  .object({ id: uuid, title: topicName.nullable(), parentTitle: topicName.nullable() })
  .strict();
const changeSetItemSchema = z
  .object({
    kind: TopicItemKindSchema,
    id: uuid,
    title: boundedText(topicReadLimits.itemTitleMax),
    topicId: uuid.nullable(),
    topicTitle: topicName.nullable()
  })
  .strict();
const changeSetSideSchema = z
  .object({
    topics: z.array(changeSetTopicSchema).max(topicReadLimits.changeSetTopicsMax),
    items: z.array(changeSetItemSchema).max(topicReadLimits.changeSetItemsMax)
  })
  .strict();
export const TopicChangeSetSchema = z
  .object({
    summary: TopicChangeSetSummarySchema,
    before: changeSetSideSchema,
    after: changeSetSideSchema,
    /** The change-set touched more topics or items than the two sides list. */
    truncated: z.boolean()
  })
  .strict();
export type TopicChangeSet = z.infer<typeof TopicChangeSetSchema>;

/** `topics.mutate` (T26): one human operation, applied through the engine as one change-set. */
export const TopicMutationSchema = z.discriminatedUnion("op", [
  z
    .object({
      op: z.literal("rename"),
      id: uuid,
      title: TopicTitleSchema,
      expectedUpdatedAt: isoTimestamp
    })
    .strict(),
  z
    .object({
      op: z.literal("move"),
      id: uuid,
      parentId: uuid,
      position: z.number().int().min(0).optional(),
      expectedUpdatedAt: isoTimestamp
    })
    .strict(),
  z.object({ op: z.literal("create"), parentId: uuid, title: TopicTitleSchema }).strict(),
  z.object({ op: z.literal("pin"), id: uuid }).strict(),
  z.object({ op: z.literal("unpin"), id: uuid }).strict(),
  z
    .object({
      op: z.literal("placeItem"),
      item: z.object({ kind: TopicItemKindSchema, id: uuid }).strict(),
      topicId: uuid,
      role: TopicPlacementRoleSchema
    })
    .strict()
]);
export type TopicMutation = z.infer<typeof TopicMutationSchema>;

export const TopicMutationResultSchema = z
  .object({ changeSetId: uuid, generation: count })
  .strict();
export type TopicMutationResult = z.infer<typeof TopicMutationResultSchema>;

/** `topics.undo` (T26). */
export const TopicUndoInputSchema = z.object({ changeSetId: uuid }).strict();
export type TopicUndoInput = z.input<typeof TopicUndoInputSchema>;

export const TopicUndoBlockerSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("changeSet"),
      changeSetId: uuid,
      /** The shared objects (`topic:<id>`, `item:<key>`). */
      objects: z.array(z.string().min(1).max(120)).max(20)
    })
    .strict(),
  z.object({ kind: z.literal("itemDeleted"), item: z.string().min(1).max(120) }).strict(),
  z.object({ kind: z.literal("notApplied"), status: TopicChangeSetStatusSchema }).strict(),
  z
    .object({
      kind: z.literal("conflict"),
      code: z.string().min(1).max(60),
      topicId: uuid.nullable(),
      item: z.string().min(1).max(120).nullable(),
      reason: z.string().max(300)
    })
    .strict()
]);
export type TopicUndoBlocker = z.infer<typeof TopicUndoBlockerSchema>;

export const TopicUndoResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("undone"),
      /** The `undo` change-set that records the inverse. */
      changeSetId: uuid,
      generation: count
    })
    .strict(),
  z
    .object({
      status: z.literal("blocked"),
      blockers: z.array(TopicUndoBlockerSchema).max(topicReadLimits.undoBlockersMax)
    })
    .strict()
]);
export type TopicUndoResult = z.infer<typeof TopicUndoResultSchema>;

/** `topics.review` (T26): applies or dismisses a proposal that waits for the owner (docs D29). */
export const TopicReviewInputSchema = z
  .object({ changeSetId: uuid, decision: z.enum(["apply", "dismiss"]) })
  .strict();
export type TopicReviewInput = z.input<typeof TopicReviewInputSchema>;
export const TopicReviewResultSchema = z.object({ status: TopicChangeSetStatusSchema }).strict();
export type TopicReviewResult = z.infer<typeof TopicReviewResultSchema>;

/** `topics.status`: where the engine is, never a blocker (the interface shows one quiet line). */
export const TopicsStatusSchema = z
  .object({
    phase: TopicsPhaseSchema,
    blocked: TopicsBlockedReasonSchema.optional(),
    counts: z
      .object({
        /** Current notes and root sources. */
        items: count,
        placed: count,
        pending: count,
        needsGate: count
      })
      .strict(),
    /** The day's budget of background topic AI calls is used up (D34). */
    dailyCapReached: z.boolean().optional(),
    /** With `space_changed`: the notes a re-embedding would cover. */
    reembedNotes: count.optional()
  })
  .strict();
export type TopicsStatus = z.infer<typeof TopicsStatusSchema>;

/** `topics.reembed` (T19b): re-embeds the library after the embedding space changed (D26). */
export const TopicReembedInputSchema = z.object({ confirm: z.literal(true) }).strict();
export type TopicReembedInput = z.input<typeof TopicReembedInputSchema>;
export const TopicReembedResultSchema = z.object({ queued: count }).strict();
export type TopicReembedResult = z.infer<typeof TopicReembedResultSchema>;
