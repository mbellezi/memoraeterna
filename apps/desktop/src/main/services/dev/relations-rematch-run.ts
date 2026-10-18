// The driver of a relation re-match run (F3 T52b, spec 3.17). It clears the relation state, then
// releases the planned roots one at a time behind the visibility fence: a root's records are decided
// with the same call ingestion makes, its link job is queued, and the next root is released as soon
// as the root's decide step committed. It waits for the link jobs to drain and returns the summary.
// Every effect goes through `RematchPorts`, so the order of things is tested without a database.
import type { RetrievalFence } from "@app/db";

import {
  RematchFence,
  type RematchMode,
  type RematchPlan,
  type RematchRoot
} from "./relations-rematch-plan.js";
import type { ClearedCounts, RunFacts } from "./relations-rematch-state.js";
import {
  noCompositeBackfill,
  normalizedSpanMs,
  rematchSummaryFormat,
  type CompositeBackfillFacts,
  type RematchSummary,
  type RematchTimelineEntry
} from "./relations-rematch-summary.js";

export interface MatchRecordInput {
  rootId: string;
  recordId: string;
  noteIds: string[];
  /** What retrieval may see for this call: a snapshot of the fence. */
  fence: RetrievalFence;
  signal: AbortSignal;
  jobId: string;
}

export interface MatchRecordResult {
  decided: number;
  accepted: number;
  /** Set when no decider was ready, so nothing was decided (mode `ranker` waits for a ranker). */
  skipped?: string | undefined;
}

export interface CassetteFacts {
  mode: "record" | "replay";
  directory: string;
  timing?: "recorded" | undefined;
  served: number;
  recorded: number;
  misses: number;
  liveLocalMisses?: number | undefined;
  liveTokens: number;
  maxLiveTokens: number | null;
  waitedMs?: number | undefined;
  byTask: Record<
    string,
    { served: number; recorded: number; misses: number; liveLocalMisses?: number | undefined }
  >;
  missDetails: Array<{ taskType: string; key: string }>;
}

export interface RematchPorts {
  /** The key matching decides under now; null while it waits for a validated ranker. */
  deciderKey(): Promise<string | null>;
  clear(input: {
    deciderKey: string;
    scope: "all" | { rootIds: readonly string[] };
  }): Promise<ClearedCounts>;
  /** Records the background roots as matched; resolves to how many. */
  seedBackground(rootIds: readonly string[]): Promise<number>;
  /**
   * Gives the background roots' notes the match state of a library matched at arrival (the k-th vector
   * cosine, D19), so the reverse guard meets decided library notes; resolves to how many notes.
   */
  seedBackgroundNotes(rootIds: readonly string[], deciderKey: string): Promise<number>;
  /** Keeps every note's candidate list from now on (debug mode); false when it cannot be turned on. */
  recordCandidates(): Promise<boolean>;
  /**
   * The run's first step (T53f): makes sure the composite vectors of the library's hierarchy roots
   * are built (the background job `relation-composite`; discovery skips a root with none), waits
   * for it to drain, and reports what it wrote and the topic re-placements that caused.
   */
  backfillComposites(input: {
    signal: AbortSignal;
    timeoutMs: number;
    pollMs: number;
  }): Promise<CompositeBackfillFacts>;
  /** The notes of a record, in the order ingestion matches them. */
  noteIds(recordId: string): Promise<string[]>;
  /** The call the ingestion stage makes for a record's notes (`matchAtomicNotes`). */
  matchRecord(input: MatchRecordInput): Promise<MatchRecordResult>;
  /** Queues the deduplicated link job of a root, as the matching stage does. */
  enqueueLink(rootId: string): Promise<void>;
  /** Link and source-relation jobs still queued or running. */
  openLinkJobs(): Promise<number>;
  facts(since: Date): Promise<RunFacts>;
  cassette(): CassetteFacts | null;
  now(): Date;
  sleep(ms: number): Promise<void>;
  log(event: string, data?: Record<string, unknown>): void;
}

export interface RematchRunInput {
  runId: string;
  jobId: string;
  profile: { name: string; kind: string | null };
  plan: RematchPlan;
  mode: RematchMode;
  background: "none" | "matched";
  /** `off`: no nearest-source discovery (the link runtime says so); typing and promotion run. */
  discovery: "on" | "off";
  /** `record`: the candidate lists are kept for the export (T57). */
  candidates: "off" | "record";
  digest: RematchSummary["digest"];
  lanesMode: "serial" | "product";
  /** How long the link jobs may take to drain after the last release. */
  drainTimeoutMs: number;
  drainPollMs: number;
  signal: AbortSignal;
}

const emptyCleared: ClearedCounts = {
  noteRelations: 0,
  decisions: 0,
  typings: 0,
  noteMatchState: 0,
  sourceRelations: 0,
  sourceDecisions: 0,
  sourceMatchState: 0,
  runs: 0,
  events: 0
};

const emptyFacts: RunFacts = {
  aiCalls: [],
  firstDecideAdmissionAt: null,
  lastCommitAt: null,
  noteRelations: [],
  typings: [],
  sourceRelations: [],
  linkJobs: []
};

const errorText = (error: unknown) =>
  (error instanceof Error ? error.message : String(error)).slice(0, 500);

/** Runs the plan and returns the summary; a failure or a cancellation is an outcome, not a throw. */
export async function runRematch(
  ports: RematchPorts,
  input: RematchRunInput
): Promise<RematchSummary> {
  let startedAt = ports.now();
  const elapsed = () => ports.now().getTime() - startedAt.getTime();
  const { plan } = input;
  const timeline: RematchTimelineEntry[] = [];
  let outcome: RematchSummary["outcome"];
  let failure: string | null = null;
  let deciderKey = "";
  let cleared = emptyCleared;
  let backgroundSeeded = 0;
  let backgroundNotesSeeded = 0;
  let compositeBackfill = noCompositeBackfill;
  let drainedAt: Date | null = null;
  try {
    const key = await ports.deciderKey();
    // Mode `ranker` waits for a validated ranker: with none, a run would decide nothing.
    if (!key)
      throw new Error(
        "Note matching has no validated decider yet (the ranker waits for validation)."
      );
    deciderKey = key;
    // Before the clear: a run that cannot keep its candidates stops with the library untouched.
    if (input.candidates === "record" && !(await ports.recordCandidates()))
      throw new Error(
        "The candidate lists cannot be kept: the profile has no saved app preferences to turn debug mode on in."
      );
    // Before the clear and before any release: discovery selects pairs over composite vectors, so a
    // hierarchy root with none would never be judged. The backfill drains first (T53f).
    compositeBackfill = await ports.backfillComposites({
      signal: input.signal,
      timeoutMs: input.drainTimeoutMs,
      pollMs: input.drainPollMs
    });
    ports.log("composites", {
      jobs: compositeBackfill.jobs,
      written: compositeBackfill.written,
      rebuilt: compositeBackfill.rebuilt,
      remaining: compositeBackfill.remaining,
      moved: compositeBackfill.placements.moved,
      movedWithCurrentNotes: compositeBackfill.placements.movedWithCurrentNotes
    });
    if (compositeBackfill.remaining > 0)
      throw new Error(
        `${compositeBackfill.remaining} hierarchy roots still have no composite vector after the backfill (${compositeBackfill.skipped.join(", ") || "it did not drain"}): discovery would skip them.`
      );
    // The run's clock (X3's T0 and every offset of the timeline, and the AI calls it counts) starts
    // here: the backfill's embedding calls and the topic jobs it caused are not part of the span.
    startedAt = ports.now();
    const released = plan.order.map((root) => root.id);
    const background = input.background === "matched" ? plan.others.map((root) => root.id) : [];
    cleared = await ports.clear({
      deciderKey: key,
      scope: input.background === "matched" ? { rootIds: released } : "all"
    });
    backgroundSeeded = await ports.seedBackground(background);
    backgroundNotesSeeded = await ports.seedBackgroundNotes(background, key);
    ports.log("cleared", { ...cleared, backgroundSeeded, backgroundNotesSeeded });
    // A burst sees the whole library from the start; an arrival sees the background and, one by
    // one, the roots it releases.
    const fence = new RematchFence(
      input.mode.kind === "burst" ? [...background, ...released] : background
    );
    for (const [index, root] of plan.order.entries()) {
      input.signal.throwIfAborted();
      await releaseRoot(ports, input, fence, root, index, elapsed, timeline);
    }
    ({ drainedAt, outcome } = await drain(ports, input, elapsed));
  } catch (error) {
    if (input.signal.aborted) outcome = "canceled";
    else {
      outcome = "failed";
      failure = errorText(error);
    }
    ports.log("stopped", { outcome, error: failure });
  }
  const finishedAt = ports.now();
  const facts = await ports.facts(startedAt).catch((error: unknown) => {
    ports.log("facts failed", { error: errorText(error) });
    return emptyFacts;
  });
  return summarize({
    ports,
    input,
    facts,
    timeline,
    outcome,
    failure,
    deciderKey,
    cleared,
    backgroundSeeded,
    backgroundNotesSeeded,
    compositeBackfill,
    startedAt,
    finishedAt,
    drainedAt
  });
}

/**
 * Releases one root: its notes become visible, its records are decided, its link job is queued. Its
 * timeline entry is added first, so a failure inside keeps the root in the timeline.
 */
async function releaseRoot(
  ports: RematchPorts,
  input: RematchRunInput,
  fence: RematchFence,
  root: RematchRoot,
  index: number,
  elapsed: () => number,
  timeline: RematchTimelineEntry[]
): Promise<void> {
  fence.release(root.id);
  const entry: RematchTimelineEntry = {
    index,
    rootId: root.id,
    title: root.title,
    partition: root.partition,
    records: root.records.length,
    notes: root.notes,
    releasedAtMs: elapsed(),
    decideStartedAtMs: elapsed(),
    decideCommittedAtMs: null,
    decided: 0,
    accepted: 0,
    linkEnqueuedAtMs: null,
    link: null
  };
  timeline.push(entry);
  ports.log("release", {
    index: index + 1,
    of: input.plan.order.length,
    title: root.title,
    notes: root.notes
  });
  for (const record of root.records) {
    input.signal.throwIfAborted();
    const noteIds = await ports.noteIds(record.id);
    if (noteIds.length === 0) continue;
    const result = await ports.matchRecord({
      rootId: root.id,
      recordId: record.id,
      noteIds,
      fence: fence.retrievalFence(),
      signal: input.signal,
      jobId: input.jobId
    });
    if (result.skipped)
      throw new Error(
        `Note matching skipped "${root.title}": ${result.skipped} (no decider is ready).`
      );
    entry.decided += result.decided;
    entry.accepted += result.accepted;
  }
  entry.decideCommittedAtMs = elapsed();
  // One link job per root, after its last record: what the product's discovery waits for.
  await ports.enqueueLink(root.id);
  entry.linkEnqueuedAtMs = elapsed();
}

/** Waits until no link job is queued or running, twice in a row, or until the timeout. */
async function drain(
  ports: RematchPorts,
  input: RematchRunInput,
  elapsed: () => number
): Promise<{ drainedAt: Date | null; outcome: RematchSummary["outcome"] }> {
  const deadline = elapsed() + input.drainTimeoutMs;
  let quiet = 0;
  for (;;) {
    input.signal.throwIfAborted();
    quiet = (await ports.openLinkJobs()) === 0 ? quiet + 1 : 0;
    if (quiet >= 2) return { drainedAt: ports.now(), outcome: "completed" };
    if (elapsed() >= deadline) return { drainedAt: null, outcome: "drainTimeout" };
    await ports.sleep(input.drainPollMs);
  }
}

function summarize(context: {
  ports: RematchPorts;
  input: RematchRunInput;
  facts: RunFacts;
  timeline: RematchTimelineEntry[];
  outcome: RematchSummary["outcome"];
  failure: string | null;
  deciderKey: string;
  cleared: ClearedCounts;
  backgroundSeeded: number;
  backgroundNotesSeeded: number;
  compositeBackfill: CompositeBackfillFacts;
  startedAt: Date;
  finishedAt: Date;
  drainedAt: Date | null;
}): RematchSummary {
  const { input, facts, startedAt } = context;
  const since = (date: Date | null) =>
    date === null ? null : Math.max(0, date.getTime() - startedAt.getTime());
  const linkJobsOf = new Map<string, RunFacts["linkJobs"]>();
  for (const job of facts.linkJobs)
    if (job.rootId) linkJobsOf.set(job.rootId, [...(linkJobsOf.get(job.rootId) ?? []), job]);
  const timeline = context.timeline.map((entry): RematchTimelineEntry => {
    const jobs = linkJobsOf.get(entry.rootId);
    if (!jobs?.length) return entry;
    const starts = jobs.flatMap((job) => (job.startedAt ? [job.startedAt.getTime()] : []));
    const ends = jobs.flatMap((job) => (job.finishedAt ? [job.finishedAt.getTime()] : []));
    const last = jobs.at(-1)!;
    return {
      ...entry,
      link: {
        jobs: jobs.length,
        status: last.status,
        startedAtMs: starts.length ? Math.max(0, Math.min(...starts) - startedAt.getTime()) : null,
        finishedAtMs:
          ends.length === jobs.length ? Math.max(0, Math.max(...ends) - startedAt.getTime()) : null,
        error: jobs.find((job) => job.error)?.error ?? null
      }
    };
  });
  const decided = timeline.reduce((sum, entry) => sum + entry.decided, 0);
  const t0Ms = since(facts.firstDecideAdmissionAt);
  const t1Ms = since(facts.lastCommitAt);
  const rawMs = t0Ms !== null && t1Ms !== null && t1Ms >= t0Ms ? t1Ms - t0Ms : null;
  const cassette = context.ports.cassette();
  const byStatus: Record<string, number> = {};
  for (const job of facts.linkJobs) byStatus[job.status] = (byStatus[job.status] ?? 0) + 1;
  return {
    format: rematchSummaryFormat,
    version: 1,
    runId: input.runId,
    outcome: context.outcome,
    error: context.failure,
    mode: input.mode.kind,
    order:
      input.mode.kind === "burst"
        ? null
        : input.mode.order.kind === "manifest"
          ? { kind: "manifest", seed: null }
          : { kind: "seeded", seed: input.mode.order.seed },
    background: input.background,
    discovery: input.discovery,
    candidates: input.candidates,
    lanes: { mode: input.lanesMode },
    profile: input.profile,
    startedAt: startedAt.toISOString(),
    finishedAt: context.finishedAt.toISOString(),
    drainedAt: context.drainedAt?.toISOString() ?? null,
    digest: input.digest,
    deciderKey: context.deciderKey,
    cleared: context.cleared,
    backgroundSeeded: context.backgroundSeeded,
    backgroundNotesSeeded: context.backgroundNotesSeeded,
    compositeBackfill: context.compositeBackfill,
    plan: {
      released: input.plan.order.length,
      background: input.plan.others.length,
      withoutNotes: input.plan.withoutNotes.length,
      notes: input.plan.order.reduce((sum, root) => sum + root.notes, 0)
    },
    timeline,
    clock: {
      t0Ms,
      t1Ms,
      rawMs,
      notesReleased: decided,
      normalized200Ms: normalizedSpanMs(rawMs, decided)
    },
    matching: {
      decided,
      accepted: timeline.reduce((sum, entry) => sum + entry.accepted, 0)
    },
    cassette: cassette
      ? {
          mode: cassette.mode,
          directory: cassette.directory,
          timing: cassette.timing ?? null,
          served: cassette.served,
          recorded: cassette.recorded,
          misses: cassette.misses,
          liveLocalMisses: cassette.liveLocalMisses ?? 0,
          liveTokens: cassette.liveTokens,
          maxLiveTokens: cassette.maxLiveTokens,
          waitedMs: cassette.waitedMs ?? 0,
          byTask: Object.fromEntries(
            Object.entries(cassette.byTask).map(([task, value]) => [
              task,
              {
                served: value.served,
                recorded: value.recorded,
                misses: value.misses,
                ...(value.liveLocalMisses === undefined
                  ? {}
                  : { liveLocalMisses: value.liveLocalMisses })
              }
            ])
          ),
          missDetails: cassette.missDetails.slice(0, 20)
        }
      : null,
    aiCalls: facts.aiCalls,
    noteRelations: facts.noteRelations,
    typings: facts.typings,
    sourceRelations: facts.sourceRelations,
    linkJobs: {
      total: facts.linkJobs.length,
      byStatus,
      failures: facts.linkJobs
        .filter((job) => job.status === "failed" || job.error)
        .slice(0, 10)
        .map((job) => ({ rootId: job.rootId, error: job.error ?? "failed" }))
    }
  };
}
