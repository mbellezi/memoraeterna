// The first step of a relation re-match run (F3 T53f, spec 3.x "Hierarchy roots" and 3.20): the
// composite vectors of the library's hierarchy roots. Source discovery selects pairs over composite
// vectors, and a library ingested before a chapter's embedding refreshed its root holds books and
// papers with chapters and no composite of their own: discovery would never judge them, and a run
// would measure the library without them. The product builds them as the background job
// `relation-composite` (relations/composite-backfill.ts); this step makes sure it ran and has
// drained before the first root is released, and says what it did: how many composites it wrote and
// which topic re-placements they caused (3.20: composite recomputes may move a root's fallback
// vector only for roots without current placed notes, so a root with current placed notes must not
// move).
import type { Queryable } from "@app/db";

import {
  compositeBackfillJobType,
  readBackfillRoots,
  type BackfillRoot
} from "../relations/composite-backfill.js";
import type { CompositeBackfillFacts, RootPlacement } from "./relations-rematch-summary.js";

export interface CompositeBackfillStepDeps {
  pool: Queryable;
  /**
   * Queues the backfill when a hierarchy node lacks its composite, or whatever the library holds
   * with `full` (the first round: a composite gone stale is found by the pass alone); true when it
   * queued or merged.
   */
  ensure(options: { full: boolean }): Promise<boolean>;
  /** Hierarchy nodes that still lack a composite their descendants imply (0 once it has run). */
  remaining(): Promise<number>;
  now(): Date;
  sleep(ms: number): Promise<void>;
  /** When this app run started: the backfill jobs it ran (the start queued one) count. */
  since: Date;
  /**
   * The root placements as they were before the app's job supervisor started, which queues the
   * backfill: the baseline of the 3.20 comparison. A baseline read in the step itself comes after
   * the job the start queued has written composites and handed roots to PLACE, which a short
   * debounce would let move before the snapshot, hiding the moves it is to report.
   */
  placementsBefore?: readonly RootPlacementRow[];
  log(event: string, data?: Record<string, unknown>): void;
}

export interface CompositeBackfillStepOptions {
  signal: AbortSignal;
  /** How long the backfill and the placements it caused may take. */
  timeoutMs: number;
  pollMs: number;
}

/** Placements shown in the summary: the rest are counted. */
const movesShown = 25;
/** Rounds of "queue it, wait for it" before a gap that stays is reported. */
const maxRounds = 3;
/** How long the topic jobs a backfill caused may take before the run goes on without them. */
const topicJobsWaitMs = 10 * 60_000;

/** Waits until `open` has returned 0 twice in a row; false when the deadline came first. */
async function waitQuiet(
  deps: Pick<CompositeBackfillStepDeps, "now" | "sleep">,
  options: CompositeBackfillStepOptions,
  deadline: number,
  open: () => Promise<number>
): Promise<boolean> {
  let quiet = 0;
  for (;;) {
    options.signal.throwIfAborted();
    quiet = (await open()) === 0 ? quiet + 1 : 0;
    if (quiet >= 2) return true;
    if (deps.now().getTime() >= deadline) return false;
    await deps.sleep(options.pollMs);
  }
}

const countJobs = async (db: Queryable, where: string, values: unknown[] = []) =>
  Number(
    (
      await db.query<{ open: number }>(
        `select count(*)::int as open from jobs
          where (status = 'running' or (status = 'queued' and blocked_class is null)) and ${where}`,
        values
      )
    ).rows[0]?.open ?? 0
  );

/** The composite backfill jobs queued or running now. */
export const openCompositeJobs = (db: Queryable) =>
  countJobs(db, "type = $1", [compositeBackfillJobType]);

/**
 * The topic placement jobs queued or running now: the PLACE a backfilled composite hands a root to,
 * and the gate decision PLACE may ask for (a local ranker call).
 */
export const openTopicPlacementJobs = (db: Queryable) =>
  countJobs(db, "type in ('topic-place', 'topic-gate')");

interface JobFacts {
  jobs: number;
  /** What the last pass saw: every hierarchy node with a descendant composite (not a sum). */
  examined: number;
  written: number;
  rebuilt: number;
  /** What the last pass saw: nodes that already held their inputs (not a sum). */
  current: number;
  /** What the last pass saw: nodes waiting for an import (not a sum). */
  incomplete: number;
  failed: number;
  skipped: string[];
  writtenIds: string[];
}

/**
 * What the backfill jobs of this app run reported. The jobs that ran in this run are those that
 * finished, or are running, or last changed since it started: a job queued by an earlier run and
 * merged into by this one's start keeps its old creation time. What a pass wrote, rebuilt or failed
 * adds up over the jobs; what it examined, found current or left waiting is a view of the library
 * at the end of that pass, so the last pass that looked is the one reported (in drain mode the
 * start's job and the step's full round are two passes over the same nodes, and summing them would
 * double the library).
 */
export async function readCompositeJobFacts(db: Queryable, since: Date): Promise<JobFacts> {
  const rows = await db.query<{ status: string; result: Record<string, unknown> | null }>(
    `select status::text as status, result from jobs
      where type = $1 and coalesce(finished_at, locked_at, updated_at) > $2
      order by coalesce(finished_at, locked_at, updated_at), id`,
    [compositeBackfillJobType, since]
  );
  const facts: JobFacts = {
    jobs: rows.rows.length,
    examined: 0,
    written: 0,
    rebuilt: 0,
    current: 0,
    incomplete: 0,
    failed: 0,
    skipped: [],
    writtenIds: []
  };
  const num = (value: unknown) => (typeof value === "number" && Number.isFinite(value) ? value : 0);
  for (const row of rows.rows) {
    if (row.status === "failed" || row.status === "canceled") facts.failed += 1;
    const result = row.result ?? {};
    if (typeof result.examined === "number") {
      facts.examined = num(result.examined);
      facts.current = num(result.current);
      facts.incomplete = num(result.incomplete);
    }
    facts.written += num(result.written);
    facts.rebuilt += num(result.rebuilt);
    facts.failed += num(result.failed);
    if (typeof result.skipped === "string") facts.skipped.push(result.skipped);
    if (typeof result.stopped === "string") facts.skipped.push(result.stopped);
    if (Array.isArray(result.writtenIds))
      for (const id of result.writtenIds) if (typeof id === "string") facts.writtenIds.push(id);
  }
  return facts;
}

/** A root source's primary placement in the active topic tree, and whether it has current placed notes. */
export type RootPlacementRow = BackfillRoot;

/** Every root source with its primary placement, or only the roots of the sources in `rootsOf`. */
export const readRootPlacements = readBackfillRoots;

const samePlacement = (a: RootPlacement | null, b: RootPlacement | null): boolean =>
  a === null || b === null ? a === b : a.topicId === b.topicId && a.needsVector === b.needsVector;

/**
 * The roots among `rootIds` whose primary placement differs from before the backfill, and how many
 * of them have current placed notes (which must not move: their vector comes from their notes).
 */
export function diffRootPlacements(
  before: readonly RootPlacementRow[],
  after: readonly RootPlacementRow[],
  rootIds: ReadonlySet<string>,
  topicJobsOpen = 0
): CompositeBackfillFacts["placements"] {
  const earlier = new Map(before.map((row) => [row.rootId, row.placement]));
  const roots = after.filter((row) => rootIds.has(row.rootId));
  const moves = roots.flatMap((row) => {
    const was = earlier.get(row.rootId) ?? null;
    return samePlacement(was, row.placement)
      ? []
      : [
          {
            rootId: row.rootId,
            title: row.title,
            hasCurrentNotes: row.hasCurrentNotes,
            before: was,
            after: row.placement
          }
        ];
  });
  return {
    backfilledRoots: roots.length,
    withCurrentNotes: roots.filter((row) => row.hasCurrentNotes).length,
    moved: moves.length,
    movedWithCurrentNotes: moves.filter((move) => move.hasCurrentNotes).length,
    topicJobsOpen,
    moves: moves.slice(0, movesShown)
  };
}

/**
 * Makes sure the composite backfill ran and drained, then reports what it wrote and the topic
 * re-placements it caused. Queues the job (the app's start queued it already when the library had
 * a missing composite: a queued or running job is waited for, never doubled; the first round
 * queues a pass over every hierarchy node so a stale composite is rebuilt too), waits until no
 * backfill job is open, and repeats while a gap stays, up to three rounds. A gap that stays after
 * that is reported in `remaining`: the caller stops the run, since discovery would skip those roots.
 * The topic placements the written composites handed to PLACE are waited for too, and compared with
 * the placements of the same roots before the step.
 */
export async function runCompositeBackfillStep(
  deps: CompositeBackfillStepDeps,
  options: CompositeBackfillStepOptions
): Promise<CompositeBackfillFacts> {
  const startedAt = deps.now().getTime();
  const deadline = startedAt + options.timeoutMs;
  const before = deps.placementsBefore ?? (await readRootPlacements(deps.pool));
  let remaining = 0;
  for (let round = 0; round < maxRounds; round += 1) {
    const queued = await deps.ensure({ full: round === 0 });
    await waitQuiet(deps, options, deadline, () => openCompositeJobs(deps.pool));
    remaining = await deps.remaining();
    deps.log("composite backfill", { round: round + 1, queued, remaining });
    if (remaining === 0 || deps.now().getTime() >= deadline) break;
  }
  const facts = await readCompositeJobFacts(deps.pool, deps.since);
  // The roots of the written nodes had their composite handed to PLACE (a root with current placed
  // notes keeps its notes' vector and stays where it is): wait for those placements and the gate
  // they may ask for, so none of it runs inside the measured span, then compare.
  const topicDeadline = Math.min(deadline, deps.now().getTime() + topicJobsWaitMs);
  const topicDrained = await waitQuiet(deps, options, topicDeadline, () =>
    openTopicPlacementJobs(deps.pool)
  );
  const topicJobsOpen = topicDrained ? 0 : await openTopicPlacementJobs(deps.pool);
  const written = await readRootPlacements(deps.pool, facts.writtenIds);
  const placements = diffRootPlacements(
    before,
    await readRootPlacements(deps.pool),
    new Set(written.map((row) => row.rootId)),
    topicJobsOpen
  );
  return {
    jobs: facts.jobs,
    examined: facts.examined,
    written: facts.written,
    rebuilt: facts.rebuilt,
    current: facts.current,
    incomplete: facts.incomplete,
    failed: facts.failed,
    skipped: [...new Set(facts.skipped)],
    remaining,
    waitedMs: Math.max(0, deps.now().getTime() - startedAt),
    placements
  };
}
