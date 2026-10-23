// The typed push events (F4 D26, spec 3.9): one preload channel, `appEvents`, carries a Zod
// discriminated union. The main process publishes an event after the work it describes committed
// (`AppEventBus`), validates it before it leaves, and the preload validates it again, so a renderer
// handler only ever receives a payload that matches its type. Copy never travels in an event: names
// are stored values, everything else is a state, a count or a parameter the renderer turns into
// text through `@app/i18n`.
import { BudgetSnapshotSchema, ChangeSetRefSchema, TopicsChangedEventSchema } from "@app/domain";
import { z } from "zod";

import { localModelStatusSchema, RelationsChangedEventSchema } from "./ipc.js";

const count = z.number().int().nonnegative();
const share = z.number().min(0).max(1);

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

export const gardenerStateSchema = z.enum(["running", "idle", "blocked", "attention"]);
/** Blocker classes in precedence order (D7). */
export const gardenerBlockerClassSchema = z.enum([
  "paused",
  "no_model",
  "cap",
  "download",
  "waiting",
  "offline"
]);

/**
 * The Gardener's status (spec 3.8). `params` carry the variable parts of the sentence (times,
 * names, route classes), never IDs. Published by the status service (T86), which owns the
 * snapshot; the shape here is the contract its sentence is rendered from.
 */
export const GardenerStatusSnapshotSchema = z
  .object({
    state: gardenerStateSchema,
    class: gardenerBlockerClassSchema.optional(),
    reason: z.string().min(1).max(80).optional(),
    params: z.record(
      z.string().min(1).max(40),
      z.union([z.string().max(200), z.number(), z.boolean()])
    ),
    coverage: z.object({ placed: share, matched: share, overviewsFresh: share }).strict(),
    /** Time left for the work ahead, or the instant a blocker clears. */
    eta: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("duration"), seconds: count }).strict(),
        z.object({ kind: z.literal("at"), at: z.string().datetime() }).strict()
      ])
      .optional(),
    action: z.string().min(1).max(64).optional()
  })
  .strict();
export type GardenerStatusSnapshot = z.infer<typeof GardenerStatusSnapshotSchema>;

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

/**
 * `consultation.status` (owner Q2): an Ask waits out the provider's rate limit, then answers again.
 * Every window hears it; the dialog that asked keeps the events of its own request id only.
 */
export const ConsultationStatusEventSchema = z
  .object({
    type: z.literal("consultation.status"),
    requestId: z.string().uuid(),
    status: consultationStatusSchema
  })
  .strict();

export const AppEventSchema = z.discriminatedUnion("type", [
  JobProgressEventSchema,
  InboxChangedEventSchema,
  GardenerStatusEventSchema,
  ModelDownloadEventSchema,
  TreeChangedEventSchema,
  RelationCreatedEventSchema,
  BudgetChangedEventSchema,
  ChangeSetChangedEventSchema,
  OverviewChangedEventSchema,
  ConsultationStatusEventSchema
]);

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
