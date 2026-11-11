// The typed push events (F4 D26, spec 3.9): one preload channel, `appEvents`, carries a Zod
// discriminated union. The main process publishes an event after the work it describes committed
// (`AppEventBus`), validates it before it leaves, and the preload validates it again, so a renderer
// handler only ever receives a payload that matches its type. Copy never travels in an event: names
// are stored values, everything else is a state, a count or a parameter the renderer turns into
// text through `@app/i18n`.
import {
  BudgetSnapshotSchema,
  ChangeSetRefSchema,
  GardenerStatusSnapshotSchema,
  ObjectKindSchema,
  objectAnchorKeys,
  TopicsChangedEventSchema,
  type GardenerStatusSnapshot
} from "@app/domain";
import { z } from "zod";

import {
  databaseStatusSchema,
  localModelStatusSchema,
  obsidianSyncStatusSchema,
  RelationExplanationDeltaEventSchema,
  RelationsChangedEventSchema
} from "./ipc.js";

const count = z.number().int().nonnegative();

/** The jobs that changed since the previous `job.progress`: at most this many IDs travel. */
export const appEventJobIdsMax = 50;

/**
 * Jobs of one lane by state. `blocked` counts the queued jobs a blocker set aside (D5, D7): they
 * wait for their blocker to clear and are never in `queued`.
 */
export const jobStateCountsSchema = z
  .object({
    queued: count,
    blocked: count,
    running: count,
    succeeded: count,
    failed: count,
    canceled: count
  })
  .strict();
export type JobStateCounts = z.infer<typeof jobStateCountsSchema>;

/**
 * `job.progress`: the counts of every lane by state, and the IDs of the jobs touched since the
 * previous event (newest first, a superset is fine). More than the limit sets `changedIdsTruncated`:
 * a consumer that follows single jobs reads the list again instead.
 */
export const JobProgressEventSchema = z
  .object({
    type: z.literal("job.progress"),
    lanes: z.object({ heavy: jobStateCountsSchema, light: jobStateCountsSchema }).strict(),
    changedIds: z.array(z.string().uuid()).max(appEventJobIdsMax),
    changedIdsTruncated: z.boolean()
  })
  .strict();

/** The Inbox kinds of D29, in the order the Inbox lists them. */
export const inboxEventKinds = [
  "review",
  "quarantined",
  "contradiction",
  "withdrawn",
  "duplicate",
  "obsidian_conflict",
  "budget",
  "backlog"
] as const;
export const inboxEventRisks = ["low", "medium", "high"] as const;

/**
 * `inbox.changed`: the open items by kind and by risk. Published by the Inbox service (T94); the
 * counts alone say what changed, a consumer reads the list for the items.
 */
export const InboxChangedEventSchema = z
  .object({
    type: z.literal("inbox.changed"),
    total: count,
    byKind: z.record(z.enum(inboxEventKinds), count),
    byRisk: z.record(z.enum(inboxEventRisks), count)
  })
  .strict();

/**
 * `gardener.status`: the Gardener's status (spec 3.8) when it changes. The snapshot is defined in
 * `@app/domain` (`GardenerStatusSnapshotSchema`), where the status is composed and its sentence is
 * rendered; it is read over IPC too (`gardener.status`). `params` carry the variable parts of the
 * sentence (times, names, amounts), never IDs.
 */
export { GardenerStatusSnapshotSchema, type GardenerStatusSnapshot };

export const GardenerStatusEventSchema = z
  .object({ type: z.literal("gardener.status"), status: GardenerStatusSnapshotSchema })
  .strict();

/**
 * `model.download`: one local model's install, as it moves from downloading through verifying to
 * ready or failed. Onboarding and Settings follow it instead of reading the model list on a timer.
 */
export const ModelDownloadEventSchema = z
  .object({
    type: z.literal("model.download"),
    localModelId: z.string().uuid(),
    catalogId: z.string().min(1).max(200),
    status: localModelStatusSchema,
    currentFile: z.string().max(2_000).nullable(),
    downloadedBytes: count,
    totalBytes: count,
    bytesPerSecond: count,
    etaSeconds: count.nullable(),
    /** A message key or redacted text, set when the install failed. */
    error: z.string().max(2_000).nullable()
  })
  .strict();

/** `topicsChanged`, bridged (the old channel stays until F5). */
export const TreeChangedEventSchema = TopicsChangedEventSchema.extend({
  type: z.literal("tree.changed")
});

/** `relationsChanged`, bridged (the old channel stays until F5). */
export const RelationCreatedEventSchema = RelationsChangedEventSchema.extend({
  type: z.literal("relation.created")
});

/**
 * `budget.changed`: the RemoteBudget's meters moved (a call settled or was refused, the day or
 * month rolled over, the person continued past the pause share or changed the cap). The Activity
 * drawer's budget section and its "needs you" item follow it (D14, spec 3.8).
 */
export const BudgetChangedEventSchema = z
  .object({ type: z.literal("budget.changed"), budget: BudgetSnapshotSchema })
  .strict();

/**
 * `changes.changed`: one change-set of a store changed status (undone, applied or dismissed after
 * review, spec 3.4); Activity and the Inbox read it again (`changes.list`, `changes.pendingCounts`).
 */
export const ChangeSetChangedEventSchema = ChangeSetRefSchema.extend({
  type: z.literal("changes.changed")
}).strict();

/** `overview.changed`: a topic's overview was written again by an undo or an applied proposal. */
export const OverviewChangedEventSchema = z
  .object({ type: z.literal("overview.changed"), topicId: z.string().uuid() })
  .strict();

/** What a running Ask tells the person besides its answer: it answers, or waits out a rate limit. */
export const consultationStatusSchema = z.enum(["answering", "waitingForProvider"]);
export type ConsultationStatus = z.infer<typeof consultationStatusSchema>;

/** The stages of one Ask, in the order it passes through them (the last three end it). */
export const consultationStages = [
  "retrieving",
  "answering",
  "waitingForProvider",
  "done",
  "failed",
  "canceled"
] as const;
export const consultationStageSchema = z.enum(consultationStages);
export type ConsultationStage = z.infer<typeof consultationStageSchema>;

/**
 * `consultation.status` (owner Q2, F5 D14): where an Ask is, one event per stage and never folded
 * (a 0 ms window), so a wait shorter than any window still shows. Every window hears it; the
 * surface that asked keeps the events of its own request id only. `questionId` is optional while
 * the Ask that stores no Question exists; `error` is a message key or redacted text, set with
 * `failed`.
 */
export const ConsultationStatusEventSchema = z
  .object({
    type: z.literal("consultation.status"),
    requestId: z.string().uuid(),
    questionId: z.string().uuid().optional(),
    stage: consultationStageSchema,
    error: z.string().max(2_000).optional()
  })
  .strict();

/** The most paragraphs, citations and characters one streamed answer may carry. */
export const consultationDeltaLimits = {
  paragraphs: 100,
  citationsPerParagraph: 50,
  markdownCharacters: 20_000,
  addressCharacters: 400
} as const;

/** One citation of a streamed paragraph: its ordinal in the answer and the object it points at. */
export const ConsultationDeltaCitationSchema = z
  .object({
    ordinal: z.number().int().positive(),
    address: z.string().min(1).max(consultationDeltaLimits.addressCharacters),
    anchor: z.partialRecord(z.enum(objectAnchorKeys), z.string().min(1).max(200)).optional()
  })
  .strict();

/** One complete paragraph of an answer (markdown) and the citations it carries. */
export const ConsultationDeltaParagraphSchema = z
  .object({
    markdown: z.string().max(consultationDeltaLimits.markdownCharacters),
    citations: z
      .array(ConsultationDeltaCitationSchema)
      .max(consultationDeltaLimits.citationsPerParagraph)
  })
  .strict();
export type ConsultationDeltaParagraph = z.infer<typeof ConsultationDeltaParagraphSchema>;

/**
 * `consultation.delta` (F5 D14): the paragraphs written so far, whole and in order, so a missed
 * delta costs nothing (each replaces the last). `restart` says the provider retried and what was
 * shown is void. A 50 ms window per request keeps the latest.
 */
export const ConsultationDeltaEventSchema = z
  .object({
    type: z.literal("consultation.delta"),
    requestId: z.string().uuid(),
    questionId: z.string().uuid(),
    paragraphs: z.array(ConsultationDeltaParagraphSchema).max(consultationDeltaLimits.paragraphs),
    restart: z.boolean()
  })
  .strict();

/** The most refs one `object.changed` lists; a larger batch says only which kinds changed. */
export const objectChangedRefsMax = 200;
export const objectChangeKinds = ["created", "updated", "deleted", "moved", "relations"] as const;
export const objectChangeSchema = z.enum(objectChangeKinds);
export type ObjectChange = z.infer<typeof objectChangeSchema>;

export const ObjectChangedRefSchema = z
  .object({ kind: ObjectKindSchema, id: z.string().uuid(), change: objectChangeSchema })
  .strict();
export type ObjectChangedRef = z.infer<typeof ObjectChangedRefSchema>;

/**
 * `object.changed` (F5 D16): objects that changed after a commit. At most 200 refs travel; a
 * bigger batch is `{ overflow: true, kinds }` and a consumer reads its list again.
 */
export const ObjectChangedEventSchema = z.union([
  z
    .object({
      type: z.literal("object.changed"),
      refs: z.array(ObjectChangedRefSchema).min(1).max(objectChangedRefsMax)
    })
    .strict(),
  z
    .object({
      type: z.literal("object.changed"),
      overflow: z.literal(true),
      kinds: z.array(ObjectKindSchema).min(1).max(ObjectKindSchema.options.length)
    })
    .strict()
]);

/** `view.changed`: the topic structure or a view over it changed; a consumer reads it again. */
export const ViewChangedEventSchema = z.object({ type: z.literal("view.changed") }).strict();

/** The stores a `settings.changed` names, in the order they are listed. */
export const settingsChangedStores = [
  "app",
  "knowledge.controls",
  "ai",
  "storage",
  "obsidian"
] as const;
export const settingsChangedKeysMax = 100;

/**
 * `settings.changed`: a settings store changed. `keys` names the settings that moved; without them
 * the whole store may have (a reset), so a consumer reads it all again.
 */
export const SettingsChangedEventSchema = z
  .object({
    type: z.literal("settings.changed"),
    stores: z.array(z.enum(settingsChangedStores)).min(1).max(settingsChangedStores.length),
    keys: z.array(z.string().min(1).max(200)).min(1).max(settingsChangedKeysMax).optional()
  })
  .strict();

/** `database.status` (sticky, 0 ms): the database lifecycle, as `database.getStatus` answers it. */
export const DatabaseStatusEventSchema = databaseStatusSchema
  .extend({ type: z.literal("database.status") })
  .strict();

/** The states of one model that loads into memory and is released again. */
export const modelLoadingStates = ["loading", "ready", "released", "failed"] as const;

/** `model.loading` (sticky per model): a local model loads, is ready, is released, or failed. */
export const ModelLoadingEventSchema = z
  .object({
    type: z.literal("model.loading"),
    modelId: z.string().min(1).max(200),
    state: z.enum(modelLoadingStates)
  })
  .strict();

/** `obsidian.sync`: the vault synchronization's status, as `obsidian.getSyncStatus` answers it. */
export const ObsidianSyncEventSchema = obsidianSyncStatusSchema
  .extend({ type: z.literal("obsidian.sync") })
  .strict();

export const obsidianProjectionKinds = ["editorial", "layout", "wiki"] as const;
export const obsidianProjectionStates = ["running", "completed", "failed"] as const;

/** `obsidian.projection`: one kind of projection into the vault started, ended or failed. */
export const ObsidianProjectionEventSchema = z
  .object({
    type: z.literal("obsidian.projection"),
    kind: z.enum(obsidianProjectionKinds),
    state: z.enum(obsidianProjectionStates)
  })
  .strict();

/** `monitoring.changed`: monitoring data changed from `since` (an ISO time) on. */
export const MonitoringChangedEventSchema = z
  .object({ type: z.literal("monitoring.changed"), since: z.string().datetime() })
  .strict();

/**
 * `explanation.delta` (F3 D22, F5 D16): a relation's explanation as it is written, the whole text
 * so far; empty text voids what was shown. Coalesced to 50 ms per request.
 */
export const ExplanationDeltaEventSchema = RelationExplanationDeltaEventSchema.extend({
  type: z.literal("explanation.delta")
}).strict();

/** `import.progress`: how far one import run is through its current file. */
export const ImportProgressEventSchema = z
  .object({
    type: z.literal("import.progress"),
    runId: z.string().min(1).max(200),
    fileIndex: count,
    fraction: z.number().min(0).max(1)
  })
  .strict();

/** Every event with one shape per type; `object.changed` has two and is added beside it. */
const SingleShapeEventSchema = z.discriminatedUnion("type", [
  JobProgressEventSchema,
  InboxChangedEventSchema,
  GardenerStatusEventSchema,
  ModelDownloadEventSchema,
  TreeChangedEventSchema,
  RelationCreatedEventSchema,
  BudgetChangedEventSchema,
  ChangeSetChangedEventSchema,
  OverviewChangedEventSchema,
  ConsultationStatusEventSchema,
  ConsultationDeltaEventSchema,
  ViewChangedEventSchema,
  SettingsChangedEventSchema,
  DatabaseStatusEventSchema,
  ModelLoadingEventSchema,
  ObsidianSyncEventSchema,
  ObsidianProjectionEventSchema,
  MonitoringChangedEventSchema,
  ExplanationDeltaEventSchema,
  ImportProgressEventSchema
]);

/**
 * The whole contract. `object.changed` is `{ refs } | { overflow, kinds }`, two shapes under one
 * type, which a discriminated union on `type` cannot hold, so it joins as a plain union.
 */
export const AppEventSchema = z.union([SingleShapeEventSchema, ObjectChangedEventSchema]);

export type AppEvent = z.infer<typeof AppEventSchema>;
export type AppEventType = AppEvent["type"];
export type AppEventOf<T extends AppEventType> = Extract<AppEvent, { type: T }>;
export type AppEventHandler<T extends AppEventType> = (event: AppEventOf<T>) => void;

export type JobProgressEvent = AppEventOf<"job.progress">;
export type ModelDownloadEvent = AppEventOf<"model.download">;

/**
 * Where the dispatcher listens: `attach` starts delivering raw payloads and returns what stops it.
 * The preload wires it to the one `appEvents` IPC channel.
 */
export interface AppEventWire {
  attach(deliver: (payload: unknown) => void): () => void;
}

export interface AppEventDispatcher {
  subscribe<T extends AppEventType>(type: T, handler: AppEventHandler<T>): () => void;
}

/** A handler that throws must not stop the others, and must not vanish: it surfaces on its own turn. */
function rethrowLater(error: unknown): void {
  setTimeout(() => {
    throw error;
  }, 0);
}

/**
 * The renderer side of the bus. One wire listener serves every subscription (attached with the
 * first, detached with the last); each payload is validated again and an invalid one is dropped, so
 * a handler only ever sees an event of the type it asked for.
 */
export function createAppEventDispatcher(
  wire: AppEventWire,
  onHandlerError: (error: unknown) => void = rethrowLater
): AppEventDispatcher {
  const handlers = new Map<AppEventType, Set<(event: AppEvent) => void>>();
  let detach: (() => void) | null = null;

  const deliver = (payload: unknown): void => {
    const parsed = AppEventSchema.safeParse(payload);
    if (!parsed.success) return;
    for (const handler of [...(handlers.get(parsed.data.type) ?? [])]) {
      try {
        handler(parsed.data);
      } catch (error) {
        onHandlerError(error);
      }
    }
  };

  return {
    subscribe(type, handler) {
      // One entry per subscription, so the same function subscribed twice unsubscribes separately.
      const entry = (event: AppEvent): void => (handler as (event: AppEvent) => void)(event);
      let set = handlers.get(type);
      if (!set) handlers.set(type, (set = new Set()));
      set.add(entry);
      detach ??= wire.attach(deliver);
      return () => {
        const current = handlers.get(type);
        if (!current?.delete(entry)) return;
        if (current.size === 0) handlers.delete(type);
        if (handlers.size === 0) {
          detach?.();
          detach = null;
        }
      };
    }
  };
}
