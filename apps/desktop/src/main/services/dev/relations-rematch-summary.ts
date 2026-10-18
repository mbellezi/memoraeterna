// The run summary of a relation re-match (F3 T52b, spec 3.17): a JSON file the harness writes when a
// run ends and `scripts/relations/rematch-report.ts` turns into the timeline and the numbers of
// X1 and X3. Everything here is data: no database, no clock.
import { z } from "zod";

export const rematchSummaryFormat = "memora-relations-rematch";

const count = z.number().int().nonnegative();
const milliseconds = z.number().int().nonnegative();
const timestamp = z.string().datetime();
const digest = z.object({ notes: count, sha256: z.string().regex(/^[0-9a-f]{64}$/u) }).strict();

export const RematchTimelineEntrySchema = z
  .object({
    index: count,
    rootId: z.string().min(1),
    title: z.string(),
    partition: z.string().nullable(),
    records: count,
    /** Notes the plan expected to match. */
    notes: count,
    /** Milliseconds since the run started. */
    releasedAtMs: milliseconds,
    decideStartedAtMs: milliseconds,
    decideCommittedAtMs: milliseconds.nullable(),
    decided: count,
    accepted: count,
    linkEnqueuedAtMs: milliseconds.nullable(),
    /** The root's link jobs, from the job table: the first one's start and the last one's end. */
    link: z
      .object({
        jobs: count,
        status: z.string().nullable(),
        startedAtMs: milliseconds.nullable(),
        finishedAtMs: milliseconds.nullable(),
        error: z.string().nullable()
      })
      .strict()
      .nullable()
  })
  .strict();
export type RematchTimelineEntry = z.infer<typeof RematchTimelineEntrySchema>;

const aiCallsSchema = z
  .object({
    taskType: z.string(),
    workloadClass: z.string().nullable(),
    lane: z.string().nullable(),
    calls: count,
    replayed: count,
    failed: count,
    repairs: count,
    inputTokens: count,
    outputTokens: count,
    durationMs: z.object({ total: count, p50: count, p95: count }).strict(),
    requeueMs: z.object({ p50: count, p95: count }).strict()
  })
  .strict();

const clearedSchema = z
  .object({
    noteRelations: count,
    decisions: count,
    typings: count,
    noteMatchState: count,
    sourceRelations: count,
    sourceDecisions: count,
    sourceMatchState: count,
    runs: count,
    events: count
  })
  .strict();

/**
 * The cassette's counters for the whole app run: they include the local embeddings of the composite
 * backfill, which runs at the app's start (`byTask.embedding`), although the run's clock and its AI
 * call counts start after that step. A miss the backfill had shows here, with its key.
 */
const cassetteSchema = z
  .object({
    mode: z.enum(["record", "replay"]),
    directory: z.string(),
    timing: z.literal("recorded").nullable(),
    served: count,
    recorded: count,
    misses: count,
    liveLocalMisses: count,
    /** Input plus output tokens of the live remote calls. */
    liveTokens: count,
    maxLiveTokens: count.nullable(),
    waitedMs: count,
    byTask: z.record(
      z.string(),
      z
        .object({
          served: count,
          recorded: count,
          misses: count,
          liveLocalMisses: count.optional()
        })
        .strict()
    ),
    missDetails: z.array(z.object({ taskType: z.string(), key: z.string() }).loose())
  })
  .strict();

const rootPlacementSchema = z.object({ topicId: z.string(), needsVector: z.boolean() }).strict();
export type RootPlacement = z.infer<typeof rootPlacementSchema>;

/**
 * The first step of a run (T53f): the composite vectors of hierarchy roots that had none, built by
 * the background job `relation-composite` before the first root is released, and the topic
 * re-placements they caused (3.20: a root with current placed notes must not move).
 */
export const compositeBackfillSchema = z
  .object({
    /** Backfill jobs this app run ran (the start queues one when the library has a gap). */
    jobs: count,
    /**
     * Hierarchy nodes with a descendant composite in the route's space, as the last pass saw them
     * (not a sum over the jobs: the start's job and the step's full round look at the same nodes).
     */
    examined: count,
    /** Composites written over all the jobs: built where there was none, rebuilt where stale. */
    written: count,
    rebuilt: count,
    /** Of the nodes the last pass examined, those whose composite already held its inputs. */
    current: count,
    /**
     * Of the nodes the last pass examined, those that wait for the import that builds them: a
     * descendant has no composite yet (the last descendant to embed builds it), or an ingestion run
     * is still working in their tree.
     */
    incomplete: count,
    failed: count,
    /** Why a job wrote nothing (no embedding space, no model routed, the space changed). */
    skipped: z.array(z.string()),
    /** Hierarchy nodes that still lack a composite their descendants imply: 0 in a usable run. */
    remaining: count,
    waitedMs: milliseconds,
    placements: z
      .object({
        /** Root sources of the written nodes. */
        backfilledRoots: count,
        /** Of those, roots with current placed notes: they keep their notes' vector. */
        withCurrentNotes: count,
        /** Of those, roots whose primary placement changed once PLACE ran. */
        moved: count,
        /** Moved roots that have current placed notes: must be 0 (3.20). */
        movedWithCurrentNotes: count,
        /** Topic placement or gate jobs still open when the step gave up waiting: 0 normally. */
        topicJobsOpen: count,
        moves: z.array(
          z
            .object({
              rootId: z.string(),
              title: z.string(),
              hasCurrentNotes: z.boolean(),
              before: rootPlacementSchema.nullable(),
              after: rootPlacementSchema.nullable()
            })
            .strict()
        )
      })
      .strict()
  })
  .strict();
export type CompositeBackfillFacts = z.infer<typeof compositeBackfillSchema>;

/** The facts of a run that did not get as far as the backfill (and of summaries that predate it). */
export const noCompositeBackfill: CompositeBackfillFacts = {
  jobs: 0,
  examined: 0,
  written: 0,
  rebuilt: 0,
  current: 0,
  incomplete: 0,
  failed: 0,
  skipped: [],
  remaining: 0,
  waitedMs: 0,
  placements: {
    backfilledRoots: 0,
    withCurrentNotes: 0,
    moved: 0,
    movedWithCurrentNotes: 0,
    topicJobsOpen: 0,
    moves: []
  }
};

/**
 * What the run recorded about the catalog-header refresh (T53h): a measurement run switches it off
 * (the refresh calls the embedding and graph models for headers a recording does not hold) and
 * counts the `catalog-header` jobs the app run queued, which must be 0. `unknown` in a summary that
 * predates it.
 */
export const catalogHeadersSchema = z
  .object({
    refresh: z.enum(["on", "off", "unknown"]),
    reason: z.string().nullable(),
    jobs: count
  })
  .strict();
export type CatalogHeadersFacts = z.infer<typeof catalogHeadersSchema>;
export const unknownCatalogHeaders: CatalogHeadersFacts = {
  refresh: "unknown",
  reason: null,
  jobs: 0
};

export const RematchSummarySchema = z
  .object({
    format: z.literal(rematchSummaryFormat),
    version: z.literal(1),
    runId: z.string().min(1),
    /** `completed`: every root was released and every link job drained. */
    outcome: z.enum(["completed", "failed", "canceled", "drainTimeout"]),
    error: z.string().nullable(),
    mode: z.enum(["arrival", "burst"]),
    order: z
      .object({ kind: z.enum(["manifest", "seeded"]), seed: z.number().int().nullable() })
      .strict()
      .nullable(),
    background: z.enum(["none", "matched"]),
    /** T57's M1 knobs: nearest-source discovery (off judges no source) and candidate recording. */
    discovery: z.enum(["on", "off"]).default("on"),
    candidates: z.enum(["off", "record"]).default("off"),
    lanes: z.object({ mode: z.enum(["serial", "product"]) }).strict(),
    profile: z.object({ name: z.string(), kind: z.string().nullable() }).strict(),
    startedAt: timestamp,
    finishedAt: timestamp,
    /** When no link job was left; null when the run ended before. */
    drainedAt: timestamp.nullable(),
    digest: z.object({ expected: digest, actual: digest }).strict(),
    deciderKey: z.string(),
    cleared: clearedSchema,
    backgroundSeeded: count,
    /** Background notes given the match state of a library matched at arrival (0 in older summaries). */
    backgroundNotesSeeded: count.default(0),
    /** The composite vectors the run built before its first release (none in older summaries). */
    compositeBackfill: compositeBackfillSchema.default(noCompositeBackfill),
    /** The catalog-header refresh the run switched off, and the jobs it nevertheless saw (T53h). */
    catalogHeaders: catalogHeadersSchema.default(unknownCatalogHeaders),
    plan: z
      .object({ released: count, background: count, withoutNotes: count, notes: count })
      .strict(),
    timeline: z.array(RematchTimelineEntrySchema),
    /**
     * X3's clock: T0 is the admission of the first decide call, T1 the commit of the last relation,
     * typing, veto or source relation; W normalizes the span to 200 notes.
     */
    clock: z
      .object({
        t0Ms: milliseconds.nullable(),
        t1Ms: milliseconds.nullable(),
        rawMs: milliseconds.nullable(),
        notesReleased: count,
        normalized200Ms: milliseconds.nullable()
      })
      .strict(),
    matching: z.object({ decided: count, accepted: count }).strict(),
    cassette: cassetteSchema.nullable(),
    aiCalls: z.array(aiCallsSchema),
    noteRelations: z.array(
      z
        .object({
          status: z.string(),
          band: z.string().nullable(),
          relationType: z.string().nullable(),
          vetoSource: z.string().nullable(),
          count
        })
        .strict()
    ),
    typings: z.array(z.object({ relationType: z.string(), count }).strict()),
    sourceRelations: z.array(z.object({ origin: z.string(), status: z.string(), count }).strict()),
    linkJobs: z
      .object({
        total: count,
        byStatus: z.record(z.string(), count),
        failures: z.array(z.object({ rootId: z.string().nullable(), error: z.string() }).strict())
      })
      .strict()
  })
  .strict();
export type RematchSummary = z.infer<typeof RematchSummarySchema>;

/** X3's W: the span from T0 to T1 normalized to 200 notes, or null when it is not defined. */
export function normalizedSpanMs(rawMs: number | null, notesReleased: number): number | null {
  if (rawMs === null || notesReleased <= 0) return null;
  return Math.round((rawMs * 200) / notesReleased);
}
