/**
 * The F4 lines of the soak report (T89, spec 5.2 and 5.4): the exit criteria E1-E5 computed from a
 * 7-day run's per-minute samples and ledgers, the injection ledger with its zero-bytes assertion, the
 * token budget with the drop steps, the load ledger and the relations configuration the run kept.
 * Everything here reads the run directory's records (`LoadedRun`), never the database; the report
 * and the hourly watchdog call it, and a later reading of the same samples with another predicate
 * is possible because the raw inputs are recorded.
 *
 * Each criterion is evaluated by a predicate with a version ({@link predicateVersions}); the report
 * prints them, so a number is always tied to the rule that made it.
 */
import { defaultAiLaneRuntimeConfig } from "../../packages/ai/src/runtime-config.ts";
import { compareBlockerClasses } from "../../packages/domain/src/gardener/state.ts";
import type { GardenerBlockerClass } from "../../packages/domain/src/gardener/blockers.ts";
import {
  gardenerTaskKind,
  relationMatchJobType
} from "../../packages/domain/src/gardener/kinds.ts";
import { defaultGardenerStatusConfig } from "../../packages/domain/src/gardener/status.ts";
import { defaultGardenerConfig } from "../../packages/domain/src/gardener-config.ts";
import { relationsConfig } from "../../packages/domain/src/relations-config.ts";
import {
  deriveWorkerStates,
  workerOfJob,
  workerPredicateVersion
} from "../../apps/desktop/src/main/services/dev/soak-workers.ts";
import type {
  BreakerRecord,
  ExchangeRecord,
  GroundTruthRecord,
  JobDoneRecord,
  OutcomeRecord,
  SoakEvent,
  SoakSample,
  TaskRunRecord
} from "../../apps/desktop/src/main/services/dev/soak-records.ts";
import type { Check, CheckStatus, LoadedRun } from "./report.ts";

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
const toMs = (iso: string) => Date.parse(iso);

/** The version of each rule the report evaluates; the meta of a run and the report print them. */
export const predicateVersions = {
  workerStates: workerPredicateVersion,
  e1: 1,
  e2: 1,
  // v2: a cancel counts only as a supersession; a failure an injected fault or the cap made is apart.
  e3: 2,
  // v2: (b) a window whose count never reached its cap is a review (not exercised), not a fail;
  // (c) one attempt's estimate is the window's planned estimate or the largest priced attempt.
  e4: 2,
  // v2: a provider-wait window expects its class from the first call that met it; unmet: review.
  // v3: a window's class is expected where its condition affects work (spec 3.8); a window never
  // compared is a review.
  // v4: a fault the fetch layer injected outside any window is a ground truth of its lane while the
  // product holds it (a sign-in failure until an answer or the lane-failure TTL, a rate limit's
  // pause, a breaker it opened), ranked with the windows by the product's class precedence.
  // v5: a provider problem (a window's or a lane fault's) affects only the work on its own lane: a
  // call on it, or a task whose kind's latest remote call took it (the real writer's lane before
  // any); every expectation, a window's stage too, must be compared (one outranked throughout is a
  // review); a mismatch whose sentence names a truth that affected no task says so.
  // v6: a kind whose calls were all local takes the local lane, an import takes its inline stages'
  // calls too, and only a kind with no call at all takes the real writer's lane.
  // v7: where no active truth affects work, a sentence of the class an active truth expects (its
  // own kind of condition) is an over-hold, a class mismatch, unless some reading the status may
  // take finds work that condition affects ({@link e5MayAffect}).
  e5: 7,
  // v2: the pre-soak line of a late first byte reads its call as spec 5.4 says, "aborted at the 30 s
  // bound, retried": a call that went on after the abort and ended met, or one whose attempts were spent.
  injection: 2
} as const;

function percentile(values: readonly number[], fraction: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]!;
}

const pct = (part: number, whole: number) =>
  whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(2)} %`;

/** What the F4 checks need from the F3 analysis. */
export interface F4Context {
  /** Audit rows an injected fault explains (row id -> reason), as `injectedRows` finds them. */
  injected: ReadonlyMap<string, string>;
  /** Failed jobs an injected fault explains (job id -> reason). */
  injectedJobs: ReadonlyMap<string, string>;
}

const sortedSamples = (run: LoadedRun): SoakSample[] =>
  run.samples.toSorted((a, b) => toMs(a.at) - toMs(b.at));

const exchangesOf = (run: LoadedRun): ExchangeRecord[] =>
  run.events.filter((event): event is ExchangeRecord => event.type === "exchange");
const groundTruthOf = (run: LoadedRun): GroundTruthRecord[] =>
  run.events.filter((event): event is GroundTruthRecord => event.type === "ground_truth");
const jobsDoneOf = (run: LoadedRun): JobDoneRecord[] =>
  run.events.filter((event): event is JobDoneRecord => event.type === "job_done");
const outcomesOf = (run: LoadedRun): OutcomeRecord[] =>
  run.events.filter((event): event is OutcomeRecord => event.type === "outcome");

/** The run's own events, from the start of the run (the collector reads a little before it). */
const warmEnd = (run: LoadedRun) => toMs(run.meta.startedAt) + run.meta.warmupMs;
const runEnd = (run: LoadedRun) => {
  if (run.meta.endedAt) return toMs(run.meta.endedAt);
  const last = sortedSamples(run).at(-1);
  return last ? toMs(last.at) : toMs(run.meta.startedAt);
};

// --- E1 -----------------------------------------------------------------------------------------

/** Consecutive minutes a due task waits blocked before it counts (spec 5.2 E1). */
export const e1BlockedMinutes = 15;
/** The daily floor of contention exposure, in lane-minutes. */
export const e1ExposureFloor = 120;

const capacityOf = (): Record<string, number> => ({
  heavy: 1,
  compute: 1,
  model: 1,
  relations: relationsConfig.link.poolSize
});

type JobSample = SoakSample["jobs"][number];

interface BlockedEvent {
  jobId: string;
  type: string;
  worker: string;
  since: number;
  minutes: number;
  held: string;
}

export interface E1Result {
  events: BlockedEvent[];
  lockEvents: Array<{ at: number; waiting: number; longestMs: number }>;
  /** Contention exposure in lane-minutes, by day (0-based) and worker. */
  exposure: Array<Record<string, number>>;
  /** Waits for a worker's turn and for a running task of the same scope, in minutes, by worker. */
  queueWaits: Record<string, number[]>;
  sameScopeWaits: Record<string, number[]>;
  /** The samples the sentence used worker states from (recorded) or had derived. */
  derivedWorkerStates: boolean;
}

/**
 * E1 (predicate v1): a task is blocked by another when, for at least 15 consecutive minutes, it is due
 * (queued, `run_after` passed, no blocker set it aside), no running task shares its scope, and every
 * worker of its lane is idle (three samples in a row) or held by a task that is not executing. Contention
 * exposure counts the lane-minutes with two or more due tasks of different scopes. A lock wait of the
 * same length in `pg_locks` is a candidate event of its own.
 */
export function computeE1(run: LoadedRun): E1Result {
  const samples = sortedSamples(run);
  const capacity = capacityOf();
  const start = toMs(run.meta.startedAt);
  const sampleMinutes = run.meta.sampleIntervalMs / minute;
  const need = Math.max(1, Math.round(e1BlockedMinutes / sampleMinutes));
  const idleRun = new Map<string, number>();
  const idleNeeded = 3;
  const streak = new Map<string, { since: number; count: number; held: string }>();
  const waitStart = new Map<
    string,
    { at: number; sameScope: number; samples: number; worker: string }
  >();
  const events: BlockedEvent[] = [];
  const reported = new Set<string>();
  const exposure: Array<Record<string, number>> = [];
  const queueWaits: Record<string, number[]> = {};
  const sameScopeWaits: Record<string, number[]> = {};
  const lockEvents: E1Result["lockEvents"] = [];
  let derived = false;
  let lockReported = false;

  for (const sample of samples) {
    const at = toMs(sample.at);
    let workers = sample.workers;
    if (!workers) {
      derived = true;
      workers = deriveWorkerStates(sample, at, capacity);
    }
    const dayIndex = Math.floor((at - start) / day);
    exposure[dayIndex] ??= {};
    const byWorker = new Map<string, { idle: number; executing: number; waiting: number }>();
    for (const entry of workers) {
      const tally = byWorker.get(entry.worker) ?? { idle: 0, executing: 0, waiting: 0 };
      tally[entry.state] += 1;
      byWorker.set(entry.worker, tally);
    }
    for (const [worker, tally] of byWorker)
      idleRun.set(worker, tally.idle > 0 ? (idleRun.get(worker) ?? 0) + 1 : 0);
    const runningScopes = new Set(
      sample.jobs
        .filter((job) => job.status === "running" && job.scopeKey)
        .map((job) => job.scopeKey as string)
    );
    const due = sample.jobs.filter(
      (job): job is JobSample =>
        job.status === "queued" &&
        job.runAfter <= at &&
        !job.blockedClass &&
        workerOfJob(job) !== null
    );
    // Exposure: lane-minutes with two or more due tasks of different scopes.
    const dueByWorker = new Map<string, Set<string>>();
    for (const job of due) {
      const worker = workerOfJob(job)!;
      dueByWorker.set(
        worker,
        (dueByWorker.get(worker) ?? new Set<string>()).add(job.scopeKey ?? `unscoped:${job.id}`)
      );
    }
    for (const [worker, scopes] of dueByWorker)
      if (scopes.size >= 2)
        exposure[dayIndex]![worker] = (exposure[dayIndex]![worker] ?? 0) + sampleMinutes;

    const dueIds = new Set(due.map((job) => job.id));
    for (const job of due) {
      const worker = workerOfJob(job)!;
      const sameScope =
        job.scopeKey !== null && job.scopeKey !== undefined && runningScopes.has(job.scopeKey);
      const wait = waitStart.get(job.id) ?? { at, sameScope: 0, samples: 0, worker };
      wait.samples += 1;
      if (sameScope) wait.sameScope += 1;
      waitStart.set(job.id, wait);
      const tally = byWorker.get(worker) ?? {
        idle: capacity[worker] ?? 1,
        executing: 0,
        waiting: 0
      };
      const idleHeld = tally.idle > 0 && (idleRun.get(worker) ?? 0) >= idleNeeded;
      const heldByWaiting = tally.idle === 0 && tally.executing === 0 && tally.waiting > 0;
      const blocked = !sameScope && (idleHeld || heldByWaiting);
      if (!blocked) {
        streak.delete(job.id);
        continue;
      }
      const state = streak.get(job.id) ?? {
        since: at,
        count: 0,
        held: idleHeld ? "an idle worker" : "workers held by tasks that are not executing"
      };
      state.count += 1;
      streak.set(job.id, state);
      if (state.count >= need && !reported.has(job.id)) {
        reported.add(job.id);
        events.push({
          jobId: job.id,
          type: job.type,
          worker,
          since: state.since,
          minutes: Math.round(state.count * sampleMinutes),
          held: state.held
        });
      }
    }
    for (const id of [...streak.keys()]) if (!dueIds.has(id)) streak.delete(id);
    // A wait ends when the task starts running or leaves the queue.
    for (const [id, wait] of [...waitStart]) {
      if (dueIds.has(id)) continue;
      waitStart.delete(id);
      const minutes = (at - wait.at) / minute;
      const target = wait.sameScope * 2 >= wait.samples ? sameScopeWaits : queueWaits;
      (target[wait.worker] ??= []).push(minutes);
    }
    // `pg_locks`: a backend that waits on a lock for as long as a blocked task.
    const longest = sample.lockWaits?.longestMs ?? 0;
    if (longest >= e1BlockedMinutes * minute) {
      if (!lockReported) {
        lockReported = true;
        lockEvents.push({ at, waiting: sample.lockWaits?.waiting ?? 0, longestMs: longest });
      }
    } else lockReported = false;
  }
  return { events, lockEvents, exposure, queueWaits, sameScopeWaits, derivedWorkerStates: derived };
}

export function e1Check(run: LoadedRun): {
  check: Check;
  table: Array<Record<string, string | number>>;
} {
  const result = computeE1(run);
  const days = Math.floor((runEnd(run) - toMs(run.meta.startedAt)) / day);
  const full = result.exposure.slice(0, Math.max(days, run.samples.length > 0 ? 1 : 0));
  const perDay = full.map((row) => Object.values(row).reduce((sum, value) => sum + value, 0));
  const belowFloor = perDay.filter((total) => total < e1ExposureFloor).length;
  const events = result.events.length + result.lockEvents.length;
  const table = full.map((row, index) => ({
    day: index + 1,
    ...Object.fromEntries(
      Object.entries(row).map(([worker, value]) => [worker, Math.round(value)])
    ),
    "lane-minutes": Math.round(perDay[index] ?? 0)
  }));
  const waitLine = (title: string, waits: Record<string, number[]>) =>
    `${title}: ${
      Object.entries(waits)
        .map(
          ([worker, values]) =>
            `${worker} p50 ${percentile(values, 0.5)?.toFixed(1)} / p95 ${percentile(values, 0.95)?.toFixed(1)} min (${values.length})`
        )
        .join("; ") || "none"
    }`;
  const status: CheckStatus =
    events > 0 ? "fail" : perDay.length === 0 || belowFloor > 0 ? "review" : "pass";
  return {
    table,
    check: {
      id: "e1-blocked",
      title: "E1 blocked by another",
      bar: `0 events over the run, with contention exposure >= ${e1ExposureFloor} lane-minutes a day (below the floor E1 reads "not exercised", not passed)`,
      status,
      value:
        events > 0
          ? `${result.events.length} blocked task(s), ${result.lockEvents.length} lock wait(s) of ${e1BlockedMinutes} min`
          : perDay.length === 0
            ? "no sample yet"
            : belowFloor > 0
              ? `not exercised: ${belowFloor} of ${perDay.length} day(s) below ${e1ExposureFloor} lane-minutes (${perDay.map((total) => Math.round(total)).join(", ")})`
              : `0 events; exposure ${perDay.map((total) => Math.round(total)).join(", ")} lane-minutes a day`,
      details: [
        ...result.events
          .slice(0, 12)
          .map(
            (event) =>
              `${event.type} ${event.jobId.slice(0, 8)} (${event.worker}) due from ${new Date(event.since).toISOString()}, ${event.minutes} min, ${event.held}`
          ),
        ...result.lockEvents.map(
          (event) =>
            `${event.waiting} backend(s) waited on a lock, the longest ${Math.round(event.longestMs / minute)} min, at ${new Date(event.at).toISOString()}`
        ),
        waitLine("same-scope waits", result.sameScopeWaits),
        waitLine("queue waits", result.queueWaits),
        ...(result.derivedWorkerStates
          ? [
              "Worker states were derived from the samples' jobs and lanes (they were not recorded)."
            ]
          : [])
      ]
    }
  };
}

// --- E2 -----------------------------------------------------------------------------------------

const inputKey = (kind: string, subject: string | null) => `${kind}\u0000${subject ?? ""}`;
/** An E2 input: (kind, subject, fingerprint), the unit a quarantine applies to (D8). */
const fingerprintKey = (kind: string, subject: string, fingerprint: string | null | undefined) =>
  `${kind}\u0000${subject}\u0000${fingerprint ?? ""}`;

export function e2Check(run: LoadedRun, context: F4Context): Check {
  const all = jobsDoneOf(run);
  // Failed jobs by input, and whether an injected fault explains each. An input is a (kind,
  // subject, fingerprint) with at least one non-skipped attempt: a job cancelled before it ran made
  // none.
  const attempts = new Map<string, { failures: number; injectedFailures: number }>();
  for (const job of all) {
    if (job.outcome === "skipped" || job.subjectKey === null || job.attempts === 0) continue;
    const key = fingerprintKey(job.jobType, job.subjectKey, job.inputFingerprint);
    const entry = attempts.get(key) ?? { failures: 0, injectedFailures: 0 };
    if (job.status === "failed") {
      entry.failures += 1;
      if (context.injectedJobs.has(job.id)) entry.injectedFailures += 1;
    }
    attempts.set(key, entry);
  }
  const quarantined = new Set<string>();
  for (const outcome of outcomesOf(run)) {
    if (outcome.quarantinedAt)
      quarantined.add(fingerprintKey(outcome.kind, outcome.subjectKey, outcome.failedFingerprint));
  }
  for (const job of all)
    if (job.quarantinedAt && job.subjectKey)
      quarantined.add(fingerprintKey(job.jobType, job.subjectKey, job.inputFingerprint));
  // Inputs whose failures were all injected leave both counts.
  const excluded = (key: string) => {
    const entry = attempts.get(key);
    return entry !== undefined && entry.failures > 0 && entry.failures === entry.injectedFailures;
  };
  const inputs = [
    ...attempts.keys(),
    ...[...quarantined].filter((key) => !attempts.has(key))
  ].filter((key) => !excluded(key));
  const counted = [...quarantined].filter((key) => !excluded(key));
  const rate = inputs.length === 0 ? 0 : counted.length / inputs.length;
  return {
    id: "e2-quarantine",
    title: "E2 quarantine",
    bar: "<= 1 % of distinct (kind, subject, fingerprint) inputs with a non-skipped attempt (inputs whose failures were all injected are left out of both)",
    status: inputs.length === 0 ? "review" : rate <= 0.01 ? "pass" : "fail",
    value: `${counted.length} quarantined of ${inputs.length} input(s) = ${pct(counted.length, inputs.length)}; ${[...attempts.keys()].filter(excluded).length} injected-only input(s) left out`,
    details: counted.slice(0, 12).map((key) => key.replaceAll("\u0000", " ").trimEnd())
  };
}

// --- E3 -----------------------------------------------------------------------------------------

const deferredStatuses = new Set(["deferred", "space_changed"]);

export interface E3Row {
  kind: string;
  created: number;
  completedWithin24h: boolean;
  skippedJob: boolean;
  legacy: boolean;
  /** Failed by an injected fault or a harness-cap refusal (D3): set aside, reported apart. */
  setAside: boolean;
}

/** A cancel that completes a task (spec 5.2 E3): superseded by a dedupe merge or a source deletion. */
const supersededCauses = new Set(["merged", "source_deleted"]);

export function e3Check(
  run: LoadedRun,
  context: Pick<F4Context, "injectedJobs"> = { injectedJobs: new Map() }
): {
  check: Check;
  table: Array<Record<string, string | number>>;
} {
  const from = warmEnd(run);
  const to = runEnd(run) - day;
  const windows = run.meta.f4?.windows ?? [];
  const startMs = toMs(run.meta.startedAt);
  const done = jobsDoneOf(run);
  // A deferred job's successor (same type and subject, created after it) continues its chain.
  const groups = new Map<string, JobDoneRecord[]>();
  for (const job of done) {
    const key = inputKey(job.jobType, job.subjectKey ?? job.id);
    (groups.get(key) ?? groups.set(key, []).get(key)!).push(job);
  }
  const chainStart = new Map<string, number>();
  const chainEnd = new Map<string, number>();
  for (const group of groups.values()) {
    const ordered = group.toSorted((a, b) => toMs(a.createdAt) - toMs(b.createdAt));
    let head: JobDoneRecord | null = null;
    for (const job of ordered) {
      const start: number = head ? chainStart.get(head.id)! : toMs(job.createdAt);
      chainStart.set(job.id, start);
      if (head) chainEnd.set(head.id, toMs(job.finishedAt ?? job.createdAt));
      head = job.resultStatus && deferredStatuses.has(job.resultStatus) ? job : null;
    }
  }
  const rows: E3Row[] = [];
  const stillOpen = sortedSamples(run).at(-1)?.jobs ?? [];
  const seen = new Set<string>();
  for (const job of done) {
    seen.add(job.id);
    const created = chainStart.get(job.id) ?? toMs(job.createdAt);
    if (created < from || created > to) continue;
    // A deferred job is not the end of its chain: its successor decides.
    if (job.resultStatus && deferredStatuses.has(job.resultStatus) && chainEnd.has(job.id))
      continue;
    const ended = job.finishedAt ? toMs(job.finishedAt) : Number.POSITIVE_INFINITY;
    const completedKind =
      (job.status === "succeeded" &&
        (job.outcome === "done" ||
          job.outcome === "no_change" ||
          job.resultStatus === "pending_review")) ||
      (job.status === "canceled" && supersededCauses.has(job.cancelCause ?? ""));
    rows.push({
      kind: job.jobType,
      created,
      completedWithin24h: completedKind && ended - created <= day,
      skippedJob: job.outcome === "skipped",
      legacy: job.status === "succeeded" && job.outcome === null && job.resultStatus === null,
      setAside: job.status === "failed" && context.injectedJobs.has(job.id)
    });
  }
  // Tasks still queued or running at the end that were created in the window have not completed.
  for (const job of stillOpen) {
    if (seen.has(job.id) || job.createdAt === undefined) continue;
    if (job.createdAt < from || job.createdAt > to) continue;
    rows.push({
      kind: job.type,
      created: job.createdAt,
      completedWithin24h: false,
      skippedJob: false,
      legacy: false,
      setAside: false
    });
  }
  const counted = rows.filter((row) => !row.skippedJob && !row.legacy && !row.setAside);
  const completed = counted.filter((row) => row.completedWithin24h).length;
  const rate = counted.length === 0 ? 1 : completed / counted.length;
  const byKind = new Map<string, { total: number; done: number }>();
  for (const row of counted) {
    const tally = byKind.get(row.kind) ?? { total: 0, done: 0 };
    tally.total += 1;
    if (row.completedWithin24h) tally.done += 1;
    byKind.set(row.kind, tally);
  }
  const table = [...byKind]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([kind, tally]) => ({
      kind,
      tasks: tally.total,
      "within 24 h": tally.done,
      rate: pct(tally.done, tally.total)
    }));
  // Per blocker window: tasks that were set aside while a window was open, and how they ended.
  const delayedIn = new Map<string, Set<string>>();
  for (const sample of sortedSamples(run)) {
    const at = toMs(sample.at) - startMs;
    for (const job of sample.jobs) {
      if (!job.blockedClass) continue;
      const window = windows.find(
        (entry) =>
          at >= entry.startMinute * minute &&
          at < (entry.startMinute + entry.durationMinutes) * minute
      );
      if (window)
        (delayedIn.get(window.id) ?? delayedIn.set(window.id, new Set()).get(window.id)!).add(
          job.id
        );
    }
  }
  const doneById = new Map(done.map((job) => [job.id, job]));
  const windowTable = [...delayedIn]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([id, jobs]) => {
      const ended = [...jobs].filter((jobId) => doneById.has(jobId));
      const within = ended.filter((jobId) => {
        const job = doneById.get(jobId)!;
        return job.finishedAt !== null && toMs(job.finishedAt) - toMs(job.createdAt) <= day;
      });
      return { window: id, "tasks set aside": jobs.size, "ended within 24 h": within.length };
    });
  return {
    table: [...table, ...windowTable],
    check: {
      id: "e3-within-24h",
      title: "E3 within 24 h",
      bar: ">= 95 % of non-skipped tasks created in [warm-up end, end - 24 h] completed (done, no change, a pending review or canceled by supersession: a dedupe merge or a source deletion) within 24 h; skipped and legacy rows apart, and failures an injected fault or the harness cap explains set aside (D3)",
      status: counted.length === 0 ? "review" : rate >= 0.95 ? "pass" : "fail",
      value: `${completed} of ${counted.length} = ${pct(completed, counted.length)}; ${rows.filter((row) => row.skippedJob).length} skipped and ${rows.filter((row) => row.legacy).length} legacy apart; ${rows.filter((row) => row.setAside).length} failed by an injected fault or the harness cap set aside`,
      details: [
        ...table
          .filter((row) => row.tasks !== row["within 24 h"])
          .slice(0, 12)
          .map((row) => `${row.kind}: ${row["within 24 h"]} of ${row.tasks} within 24 h`),
        ...(to <= from
          ? ["The run is shorter than the warm-up plus 24 h: there is no window to measure yet."]
          : [])
      ]
    }
  };
}

// --- E4 -----------------------------------------------------------------------------------------

const callTokens = (row: TaskRunRecord) => (row.inputTokens ?? 0) + (row.outputTokens ?? 0);
/** The audit error of a call the RemoteBudget refused before it was sent (`RemoteBudgetRefusal`). */
const budgetRefusal = /gardener\.blocked\.cap\./u;

/**
 * The money window's fake prices (US$ per million tokens), from the plan the meta recorded; null
 * when the plan names none.
 */
function moneyPrices(run: LoadedRun): { inputUsdPerM: number; outputUsdPerM: number } | null {
  const plan = run.meta.plan as { f4?: { money?: Record<string, unknown> } } | null | undefined;
  const money = plan && typeof plan === "object" ? plan.f4?.money : undefined;
  const input = money?.inputUsdPerM;
  const output = money?.outputUsdPerM;
  return typeof input === "number" && typeof output === "number"
    ? { inputUsdPerM: input, outputUsdPerM: output }
    : null;
}

/** The real Codex lane's audit rows: the lane the meta names for the real writer. */
export function codexRows(run: LoadedRun): TaskRunRecord[] {
  const lane = run.meta.realWriter ? `remote:${run.meta.realWriter.providerConfigId}` : null;
  return lane ? run.rows.filter((row) => row.lane === lane) : [];
}

export function e4Check(run: LoadedRun): Check {
  const truths = groundTruthOf(run);
  const samples = sortedSamples(run);
  const rows = codexRows(run);
  const details: string[] = [];
  const statuses: CheckStatus[] = [];
  const largestCall = Math.max(
    0,
    ...rows.map(callTokens),
    ...samples.map((s) => s.cap?.largestCallTokens ?? 0)
  );

  // (a) The harness cap, lowered in the gate S window: the cumulative spend against the lowered cap.
  const lowered = run.events.filter(
    (event): event is Extract<SoakEvent, { type: "cap" }> =>
      event.type === "cap" && event.action === "lower"
  );
  const exhausted = run.events.some(
    (event) => event.type === "cap" && event.action === "exhausted"
  );
  const capWindow = truths.find((truth) => truth.kind === "harness_cap" && truth.phase === "start");
  if (capWindow && lowered.length > 0) {
    const lower = lowered[0]!;
    const endTruth = truths.find((truth) => truth.id === capWindow.id && truth.phase === "end");
    const until = endTruth ? toMs(endTruth.at) + 5 * minute : runEnd(run);
    const peak = Math.max(
      lower.spentTokens,
      ...samples
        .filter((s) => toMs(s.at) >= toMs(lower.at) && toMs(s.at) <= until)
        .map((s) => s.cap?.spentTokens ?? 0)
    );
    const over = peak - lower.capTokens;
    const ok = over <= largestCall;
    statuses.push(ok ? "pass" : "fail");
    details.push(
      `(a) harness cap lowered to ${lower.capTokens}: peak ${peak}, ${over > 0 ? `${over} over` : `${-over} under`} the cap; the largest call used ${largestCall} tokens`
    );
  } else {
    details.push(
      "(a) the harness-cap window did not run in this run (gate S proves it); reaching the hard cap would end the run inconclusive"
    );
    statuses.push("n/a");
  }
  if (exhausted) {
    // Part (a)'s own status, so the value's labels stay a, b, c.
    statuses[0] = "fail";
    details.push(
      "The hard harness cap was reached: the remote leg ended and the run is inconclusive."
    );
  }

  // (b) The product's mid-run Codex cap: background Codex admissions after the budget's calls are exhausted.
  const dailyCap = truths.find(
    (truth) =>
      truth.kind === "codex_daily_cap" && truth.phase === "start" && !truth.id.includes("#")
  );
  if (dailyCap) {
    const end = truths.find((truth) => truth.id === dailyCap.id && truth.phase === "end");
    const from = toMs(dailyCap.at);
    const to = end ? toMs(end.at) : runEnd(run);
    // The crossing: the first sample whose budget reads exhausted, or the window's own record of it
    // (each at the sample interval), whichever came first.
    const crossings = [
      ...samples
        .filter(
          (s) => toMs(s.at) >= from && toMs(s.at) <= to && s.budget?.callsState === "exhausted"
        )
        .slice(0, 1)
        .map((s) => toMs(s.at)),
      ...truths
        .filter(
          (truth) =>
            truth.id === `${dailyCap.id}#crossed` &&
            truth.phase === "start" &&
            toMs(truth.at) >= from &&
            toMs(truth.at) <= to
        )
        .slice(0, 1)
        .map((truth) => toMs(truth.at))
    ];
    if (crossings.length > 0) {
      const crossedAt = Math.min(...crossings);
      // A call the budget refused was never admitted: its audit row names the refusal.
      const admitted = rows.filter(
        (row) =>
          !budgetRefusal.test(row.error ?? "") &&
          toMs(row.startedAt) > crossedAt &&
          toMs(row.startedAt) <= to
      );
      const background = admitted.filter((row) => row.budgetClass === "background").length;
      const protectedCalls = admitted.filter(
        (row) =>
          row.budgetClass === "user" || row.budgetClass === "interactive" || row.priority === 0
      ).length;
      const refused = rows.filter(
        (row) =>
          budgetRefusal.test(row.error ?? "") &&
          toMs(row.startedAt) > crossedAt &&
          toMs(row.startedAt) <= to
      ).length;
      statuses.push(background <= 1 ? "pass" : "fail");
      details.push(
        `(b) the daily Codex cap was crossed at ${new Date(crossedAt).toISOString()}: ${background} background Codex call(s) admitted after it (bar <= 1), ${refused} refused by the budget; ${protectedCalls} P0 or user call(s) went on`
      );
    } else {
      // Never crossed: the calls counted (and in flight) stayed below the window's cap, so the
      // budget had nothing to hold and the bar was not exercised; reaching it without the budget
      // reading exhausted would be the cap not taking effect.
      const capCalls =
        typeof dailyCap.detail.cap === "number"
          ? dailyCap.detail.cap
          : Math.min(
              ...samples
                .filter((s) => toMs(s.at) > from && toMs(s.at) <= to && s.budget)
                .map((s) => s.budget!.capCalls)
            );
      const counted = Math.max(
        0,
        ...samples
          .filter((s) => toMs(s.at) > from && toMs(s.at) <= to && s.budget)
          .map((s) => s.budget!.usedCalls + s.budget!.reservedCalls)
      );
      const reached = Number.isFinite(capCalls) && counted >= capCalls;
      statuses.push(reached ? "fail" : "review");
      details.push(
        reached
          ? `(b) the background Codex calls counted reached the window's cap (${counted} of ${capCalls}) but the budget never read exhausted: the cap did not take effect`
          : `(b) not exercised: the background Codex calls counted reached ${counted} of the window's cap ${Number.isFinite(capCalls) ? capCalls : "?"}, so the cap was never crossed and nothing was held`
      );
    }
  } else {
    details.push("(b) the mid-run Codex cap window did not run in this run");
    statuses.push("n/a");
  }

  // (c) The money window on the priced fake: spend against the cap, and both transitions.
  const money = truths.filter((truth) => truth.kind === "money");
  if (money.length > 0) {
    const first = money.find((truth) => truth.phase === "start" && !truth.id.includes("#"));
    const end = money.find((truth) => truth.phase === "end" && !truth.id.includes("#"));
    const from = first ? toMs(first.at) : 0;
    const to = end ? toMs(end.at) : runEnd(run);
    const inWindow = samples.filter((s) => toMs(s.at) >= from && toMs(s.at) <= to && s.budget);
    const capUsd = Math.min(...inWindow.map((s) => s.budget!.capUsd));
    const spent = Math.max(0, ...inWindow.map((s) => s.budget!.spentUsd));
    // One attempt's estimate: the window's own (the cap is set from it), or the largest priced
    // background attempt in the window (the fake bills what the budget reserved for it), plus the
    // estimate its audit row kept for usage it did not report. A row's `budgetEstimateUsd` alone
    // is only that remainder (0 when the usage was reported), never an attempt's estimate.
    const planned =
      typeof first?.detail.attemptEstimateUsd === "number" ? first.detail.attemptEstimateUsd : 0;
    const prices = moneyPrices(run);
    const fakeModel = typeof first?.detail.fakeModel === "string" ? first.detail.fakeModel : null;
    const billed = run.rows
      .filter(
        (row) =>
          row.budgetClass === "background" &&
          fakeModel !== null &&
          row.modelId === fakeModel &&
          toMs(row.startedAt) >= from &&
          toMs(row.startedAt) <= to
      )
      .map(
        (row) =>
          (prices
            ? ((row.inputTokens ?? 0) * prices.inputUsdPerM +
                (row.outputTokens ?? 0) * prices.outputUsdPerM) /
              1_000_000
            : 0) + (row.budgetEstimateUsd ?? 0)
      );
    const attempt = Math.max(planned, ...billed);
    const over = spent - capUsd;
    const seen80 = money.some((truth) => truth.id.endsWith("#80") && truth.phase === "start");
    const seen100 = money.some((truth) => truth.id.endsWith("#100") && truth.phase === "start");
    const continued = money.some(
      (truth) =>
        truth.id.endsWith("#80") && truth.phase === "end" && truth.detail.continued === true
    );
    const ok = seen80 && seen100 && continued && (attempt === 0 ? over <= 0 : over <= attempt);
    statuses.push(ok ? "pass" : "fail");
    details.push(
      `(c) money window: ${seen80 ? "cap.money_80 seen" : "cap.money_80 NOT seen"}, ${continued ? "continued" : "NOT continued"}, ${seen100 ? "cap.money_100 seen" : "cap.money_100 NOT seen"}; spend ${spent.toFixed(4)} US$ against cap ${Number.isFinite(capUsd) ? capUsd.toFixed(4) : "?"} (${over > 0 ? `${over.toFixed(4)} over` : "within"}; the largest attempt estimate ${attempt.toFixed(4)})`
    );
  } else {
    details.push("(c) the money window did not run in this run");
    statuses.push("n/a");
  }
  const status: CheckStatus = statuses.includes("fail")
    ? "fail"
    : statuses.includes("review") || statuses.every((entry) => entry === "n/a")
      ? "review"
      : "pass";
  return {
    id: "e4-cap",
    title: "E4 cap within one call",
    bar: "(a) harness cap overshoot <= the largest call's tokens (a run that reaches the hard cap is inconclusive); (b) <= 1 background Codex admission after the crossing (a cap never crossed is not exercised: review); (c) money spend - cap <= one attempt's estimation error, with cap.money_80 then cap.money_100 shown",
    status,
    value:
      statuses.map((entry, index) => `${"abc"[Math.min(index, 2)]}: ${entry}`).join(", ") ||
      "not run",
    details
  };
}

// --- E5 -----------------------------------------------------------------------------------------

interface Transition {
  at: number;
  settleUntil: number;
  record: GroundTruthRecord;
}

/**
 * Why an expectation's class was never compared with the sentence (E5 v3; per expectation since
 * v5): the window, or that stage of it, is not exercised.
 */
export type E5NotExercisedWhy =
  /** A provider-wait window no call met: the product could not know of its fault. */
  | "unmet"
  /** Its expectation never opened (a daily cap the count never reached, a budget never at 80 %). */
  | "never_opened"
  /** Open past its settle, but no sample then held work its condition affects. */
  | "nothing_affected"
  /** It ended before a sample came after the settle of its expectation. */
  | "ended_in_settle"
  /** Every sample it was affected at went to an injected lane fault ranked above it, or its settle. */
  | "outranked_by_lane_fault"
  /** Every sample it was affected at went to another window ranked above it (or a lane fault). */
  | "outranked";

export interface E5Result {
  /** The injected lane faults outside any window, as the product holds them (E5 v4). */
  laneFaults: E5LaneFault[];
  /** Samples whose expectation was a lane fault's. */
  laneFaultChecks: number;
  /**
   * Expectations whose class was never compared: the run did not show the sentence names them.
   * `window` is the expectation's record (`g250-money#80`: a stage of a window), since E5 v5.
   */
  notExercised: Array<{ window: string; why: E5NotExercisedWhy }>;
  checked: number;
  matched: number;
  /** Samples after the settle, inside a window, where nothing its condition affects was there. */
  unaffected: Array<{ at: string; window: string }>;
  classMismatches: Array<{
    at: string;
    window: string;
    expected: string;
    seen: string;
    /**
     * The active truth (a window or a lane fault) whose class and reason the sentence named,
     * although its condition affected no task at the sample (E5 v5): spec 3.8 names a class only
     * for the work it holds, so this is the status's miss, not the oracle's.
     */
    named?: string;
    /**
     * E5 v7: no active truth affected work at the sample, and the sentence named the class of one
     * of them (`window`, `named`): an over-hold; `expected` is `none`.
     */
    overHold?: true;
  }>;
  reasonMismatches: number;
  recoveryMismatches: Array<{ at: string; window: string; seen: string }>;
  fallbackSamples: number;
  samplesWithBlocked: number;
  samplesWithStatus: number;
}

const classRank = (value: string): number => {
  const rank = compareBlockerClasses(value as GardenerBlockerClass, "offline");
  return Number.isFinite(rank) ? rank : 0;
};

/** The window a record belongs to: `g030-usage-limit#met` and `g205-only-idle#1` are parts. */
const windowOf = (id: string) => id.split("#")[0]!;

/**
 * Which work a window's condition affects, by the class it expects (spec 3.8: precedence picks the
 * highest class with a task it affects; D7, D27, T86's `composeGardenerStatus`):
 * - `standing`: a control or a cap holds every background task whether or not one waits (the
 *   gates' holds), so the sentence names it at every sample the condition holds;
 * - `lane`: a provider problem (a rate limit, a provider or network that does not answer, a failed
 *   sign-in) affects the work that uses its provider's lane: a call running or waiting on it, a
 *   remote Gardener task in progress or set aside whose calls take it, or a task an outage set
 *   aside there (E5 v5: work on another lane, or held by a cap for another lane, is not affected);
 * - `work`: a model being fetched, checked or loaded affects any Gardener task in progress;
 * - `set_aside`: a missing model, route or decider affects only the tasks it set aside (placement
 *   without a decider takes decision 19's path and waits for nothing).
 */
export type E5Exposure = "standing" | "lane" | "work" | "set_aside";

export function e5ExposureOf(expect: { class: string; reason: string }): E5Exposure {
  const key = `${expect.class}.${expect.reason}`;
  if (expect.class === "paused" || expect.class === "cap") return "standing";
  if (
    key === "waiting.provider_rate_limit" ||
    key === "waiting.provider_unavailable" ||
    key === "no_model.signin_required" ||
    expect.class === "offline"
  )
    return "lane";
  if (expect.class === "download" || expect.class === "waiting") return "work";
  return "set_aside";
}

/** A task scheduled further ahead than this is not work in progress (the status's own horizon). */
const workHorizonMs = defaultGardenerStatusConfig.scheduledWithinMs;
const providerWaitKeys: ReadonlySet<string> = new Set([
  "waiting.provider_unavailable",
  "offline.network_unreachable"
]);

/**
 * Where a provider problem is (E5 v5): its provider's lane, and the lane each task's remote calls
 * take at the sample ({@link e5Routes}); a task the run does not route is taken as on it.
 */
export interface E5Lane {
  lane: string;
  routeOf: (job: JobSample) => string | null;
}

/**
 * Whether the condition a window expects holds at the sample and affects work there (E5 v3): the
 * sentence is compared with the window's class only then. A power window's condition is read from
 * the sample's own power reading (a block of the idle window turns at its minute, and the tick that
 * records it can come up to a sample later). A provider problem whose lane is known (`on`, E5 v5)
 * affects only the calls on that lane and the tasks whose calls take it; without one, any remote
 * lane's (v3).
 */
export function e5Affected(
  sample: SoakSample,
  expect: { class: string; reason: string },
  on?: E5Lane | null
): boolean {
  const key = `${expect.class}.${expect.reason}`;
  const at = toMs(sample.at);
  const power = sample.power;
  if (key === "paused.only_idle_user_active" && power)
    return (
      (power.idleMs ?? (power.active ? 0 : Number.POSITIVE_INFINITY)) <
      defaultGardenerConfig.power.onlyIdleAfterMs
    );
  if (key === "paused.only_ac_on_battery" && power) return power.onBattery;
  const exposure = e5ExposureOf(expect);
  if (exposure === "standing") return true;
  const setAside = (job: JobSample) => Boolean(job.blockedClass);
  const keyOfJob = (job: JobSample) => `${job.blockedClass}.${job.blockedReason}`;
  // On the problem's lane: a task the run does not route is taken as on it.
  const routed = (job: JobSample) => !on || (on.routeOf(job) ?? on.lane) === on.lane;
  // A task the condition set aside is affected whatever the family.
  if (sample.jobs.some((job) => setAside(job) && keyOfJob(job) === key && routed(job))) return true;
  if (exposure === "set_aside") return false;
  const inProgress = (job: JobSample) =>
    !setAside(job) &&
    (job.status === "running" || (job.status === "queued" && job.runAfter <= at + workHorizonMs));
  const gardenerWork = (job: JobSample) =>
    Boolean(gardenerTaskKind(job.type)?.gardener) && (setAside(job) || inProgress(job));
  if (exposure === "work") return sample.jobs.some(gardenerWork);
  // `lane`: a call on its lane, remote Gardener work that takes it, or a task an outage set aside.
  const laneBusy = sample.lanes.some(
    (entry) =>
      (on ? entry.lane === on.lane : entry.lane !== "local") &&
      entry.running + entry.waiting.P0 + entry.waiting.P1 + entry.waiting.P2 + entry.waiting.P3 > 0
  );
  return (
    laneBusy ||
    sample.jobs.some(
      (job) =>
        routed(job) &&
        ((gardenerWork(job) && Boolean(gardenerTaskKind(job.type)?.remote)) ||
          (setAside(job) && providerWaitKeys.has(keyOfJob(job))))
    )
  );
}

/**
 * The kinds whose lanes the status does not read (docs/f4-decisions.md, "A lane's problem holds
 * only the work on that lane"): a link job and a catalog header, whose embedding and graph calls
 * are not on their class route, and an import. It counts them on every remote lane, and MATCH too
 * while it waits for a decider.
 */
const laneUnreadKinds: ReadonlySet<string> = new Set([
  "relation-link",
  "catalog-header",
  "ingestion"
]);

/**
 * Whether a condition could affect work by any reading the status may take (E5 v7), the generous
 * side of {@link e5Affected}, which E5 compares with: besides what that counts, a task queued for
 * another attempt at any time ahead (the status counts every retrying task, not only those due within
 * its horizon); for a model check, an import an outage set aside (it waits too); on a lane, a task of
 * a kind whose lanes the status does not read, and MATCH while a decider is missing
 * (`decidersMissing`), whatever lane their calls took. A sentence that names such a condition where
 * none of this holds named a class for no task (spec 3.8: the highest class with a task it affects).
 */
export function e5MayAffect(
  sample: SoakSample,
  expect: { class: string; reason: string },
  on: E5Lane | null,
  decidersMissing: boolean
): boolean {
  const at = toMs(sample.at);
  const retrying = (job: JobSample) =>
    job.status === "queued" && !job.blockedClass && job.attempts > 0 && job.runAfter > at;
  const generous = {
    ...sample,
    jobs: sample.jobs.map((job) => (retrying(job) ? { ...job, runAfter: at } : job))
  };
  const unread = (job: JobSample) =>
    laneUnreadKinds.has(job.type) || (decidersMissing && job.type === relationMatchJobType);
  const anyLane = on
    ? { lane: on.lane, routeOf: (job: JobSample) => (unread(job) ? on.lane : on.routeOf(job)) }
    : null;
  if (e5Affected(generous, expect, anyLane)) return true;
  return (
    e5ExposureOf(expect) === "work" &&
    sample.jobs.some(
      (job) =>
        Boolean(job.blockedClass) &&
        providerWaitKeys.has(`${job.blockedClass}.${job.blockedReason}`)
    )
  );
}

/** The lane a provider's calls take in the run: `remote:<config>`; null when the run does not name it. */
function providerLane(run: LoadedRun, provider: string): string | null {
  const configId =
    run.meta.providers.find((entry) => entry.provider === provider)?.providerConfigId ??
    (run.meta.realWriter?.provider === provider ? run.meta.realWriter.providerConfigId : null);
  return configId ? `remote:${configId}` : null;
}

/**
 * The lane a task's calls take at a time (E5 v5), from the run's own audit rows: the lane of the
 * latest remote call a task of its kind made by then (the soak routes a kind's calls to one provider
 * at a time; the money window moves the explanations to the priced fake, then back), the real
 * writer's lane before its first. v6: a kind whose calls were all local (the label embeddings on the
 * local embedder, MATCH on the local ranker) takes `local`; an import's calls are its own and its
 * inline stages' (each stage is a job of its own beside it); a kind with no call at all takes the
 * real writer's lane, the soak's route for remote work. Null when the run names no writer.
 */
export function e5Routes(
  run: LoadedRun
): (job: Pick<JobSample, "type">, at: number) => string | null {
  const typeOf = new Map<string, string>();
  for (const sample of run.samples) for (const job of sample.jobs) typeOf.set(job.id, job.type);
  for (const event of run.events)
    if ((event.type === "job_done" || event.type === "job_failure") && !typeOf.has(event.id))
      typeOf.set(event.id, event.jobType);
  const calls = new Map<string, Array<{ at: number; lane: string }>>();
  /** The kinds that made a call on any lane. */
  const called = new Set<string>();
  for (const row of run.rows) {
    const type = row.jobId ? typeOf.get(row.jobId) : undefined;
    if (!type || !row.lane) continue;
    const kinds = gardenerTaskKind(type)?.worker === "inline" ? [type, "ingestion"] : [type];
    for (const kind of kinds) {
      called.add(kind);
      if (!row.lane.startsWith("remote:")) continue;
      const list = calls.get(kind) ?? [];
      list.push({ at: toMs(row.startedAt), lane: row.lane });
      calls.set(kind, list);
    }
  }
  for (const list of calls.values()) list.sort((a, b) => a.at - b.at);
  const writer =
    run.meta.realWriter?.providerConfigId ??
    (run.meta.providers.length === 1 ? run.meta.providers[0]!.providerConfigId : null);
  const fallback = writer ? `remote:${writer}` : null;
  return (job, time) => {
    const list = calls.get(job.type);
    if (!list) return called.has(job.type) ? "local" : fallback;
    // The last call that started at or before `time` (binary search: a week of rows).
    let low = 0;
    let high = list.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if (list[middle]!.at <= time) low = middle + 1;
      else high = middle;
    }
    return low > 0 ? list[low - 1]!.lane : fallback;
  };
}

/** The lane of each window whose provider the run names, from the exchanges it injected (E5 v5). */
function windowLanes(run: LoadedRun): Map<string, string> {
  const lanes = new Map<string, string>();
  for (const exchange of exchangesOf(run)) {
    if (!exchange.window || lanes.has(exchange.window)) continue;
    const lane = providerLane(run, exchange.provider);
    if (lane) lanes.set(exchange.window, lane);
  }
  return lanes;
}

/** How a remote lane remembers its provider's last failure (`LaneFailureKind` of `@app/ai`). */
type LaneFailure = "unauthorized" | "unreachable" | "unavailable";

/**
 * What one exchange tells its lane (`providerFailureKind` of `@app/ai` on the error the call met):
 * a refused credential, an unknown host, a refused connection, a 5xx or a deadline the client met (a
 * late first byte, a stall) name how the provider failed; any other answer (a rate limit, a rejected
 * request, an answer the consumer refuses) shows that it answers. A forwarded answer (`none`, 2xx)
 * is recorded at its headers: the call's own audit row tells when its stream, and so the lane's
 * success, ended.
 */
function exchangeFailure(exchange: ExchangeRecord): LaneFailure | "answer" | null {
  if (exchange.outcome === "server_stopped") return null;
  if (exchange.kind === "enotfound") return "unreachable";
  if (["refused", "stall", "late_first_byte"].includes(exchange.kind)) return "unavailable";
  if (exchange.status === 401 || exchange.status === 403) return "unauthorized";
  if (exchange.status >= 500) return "unavailable";
  if (exchange.kind === "none" && exchange.status >= 200 && exchange.status < 300) return null;
  return "answer";
}

/**
 * A fault the fetch layer injected outside any window, while the product holds it (E5 v4): the
 * status reads a lane's last failure for `laneFailureTtlMs`, its rate-limit pause and its breaker
 * (`composeGardenerStatus`), so a random fault is as much a ground truth as a window, on its lane.
 */
export interface E5LaneFault {
  /** `fault-<kind>#<seq>`: the injected exchange behind it. */
  id: string;
  /** The remote lane its provider's calls take; null when the run does not name it. */
  lane: string | null;
  from: number;
  until: number;
  expect: { class: string; reason: string };
}

/**
 * The status follows a lane without an event, from its heartbeat (`heartbeatMs`) while something is
 * held: a sample within two heartbeats of a lane fault's start or end may show either side.
 */
export const e5LaneSettleMs = 2 * defaultGardenerStatusConfig.heartbeatMs;

/**
 * The lane faults of a run (E5 v4), as the product holds them. Per provider, the lane's failure is
 * replayed from its exchanges and the successes of its audit rows (`Scheduler.record`): a failure
 * that names its kind replaces the last one; any other answer forgets it unless the breaker is open
 * (half-open, the answer is the probe's). From an injected exchange outside any window:
 * - a refused credential holds `no_model.signin_required` until it is forgotten or replaced, at
 *   most the status's `laneFailureTtlMs`, whatever the breaker;
 * - a 429 pauses the lane for its Retry-After, at most `maxPauseMs`: `waiting.provider_rate_limit`;
 * - a breaker it opened (the lane's failure when the breaker left `closed`) holds
 *   `offline.network_unreachable` for an unknown host, else `waiting.provider_unavailable`, until
 *   the breaker closes. A single 5xx, refusal or deadline with the breaker closed holds nothing.
 * A window's own exchanges are the window's ground truth, with its settles.
 */
export function e5LaneFaults(run: LoadedRun): E5LaneFault[] {
  const ttlMs = defaultGardenerStatusConfig.laneFailureTtlMs;
  const exchanges = exchangesOf(run);
  const faults: E5LaneFault[] = [];
  const outside = (exchange: ExchangeRecord) => exchange.injected && !exchange.window;
  for (const provider of new Set(exchanges.map((exchange) => exchange.provider))) {
    const lane = providerLane(run, provider);
    const breakers = run.events
      .filter((event): event is BreakerRecord => event.type === "breaker" && event.lane === lane)
      .toSorted((a, b) => toMs(a.at) - toMs(b.at));
    const breakerAt = (time: number) =>
      breakers.findLast((record) => toMs(record.at) <= time)?.to ?? "closed";
    const own = exchanges.filter((exchange) => exchange.provider === provider);
    const outcomes = [
      ...own.map((exchange) => ({
        at: toMs(exchange.endedAt),
        what: exchangeFailure(exchange),
        exchange
      })),
      ...run.rows
        .filter(
          (row) =>
            row.status === "succeeded" &&
            row.finishedAt !== null &&
            (lane ? row.lane === lane : row.provider === provider)
        )
        .map((row) => ({ at: toMs(row.finishedAt!), what: "answer" as const, exchange: null }))
    ]
      .filter((outcome) => outcome.what !== null)
      .toSorted((a, b) => a.at - b.at);
    // The lane's failure, replayed: each one from its exchange until it is forgotten or replaced.
    const failures: Array<{
      kind: LaneFailure;
      at: number;
      until: number;
      exchange: ExchangeRecord;
    }> = [];
    let current: (typeof failures)[number] | null = null;
    const forget = (time: number) => {
      if (current) failures.push({ ...current, until: Math.min(time, current.at + ttlMs) });
      current = null;
    };
    for (const outcome of outcomes) {
      if (outcome.what === "answer") {
        if (breakerAt(outcome.at) !== "open") forget(outcome.at);
        continue;
      }
      forget(outcome.at);
      current = {
        kind: outcome.what!,
        at: outcome.at,
        until: outcome.at,
        exchange: outcome.exchange!
      };
    }
    forget(runEnd(run));
    for (const failure of failures)
      if (
        failure.kind === "unauthorized" &&
        outside(failure.exchange) &&
        failure.until > failure.at
      )
        faults.push({
          id: `fault-unauthorized#${failure.exchange.seq}`,
          lane,
          from: failure.at,
          until: failure.until,
          expect: { class: "no_model", reason: "signin_required" }
        });
    for (const exchange of own)
      if (outside(exchange) && exchange.status === 429 && exchange.retryAfterSeconds !== null) {
        const from = toMs(exchange.endedAt);
        const pauseMs = Math.min(
          exchange.retryAfterSeconds * 1_000,
          defaultAiLaneRuntimeConfig.lanes.maxPauseMs
        );
        if (pauseMs > 0)
          faults.push({
            id: `fault-${exchange.kind}#${exchange.seq}`,
            lane,
            from,
            until: from + pauseMs,
            expect: { class: "waiting", reason: "provider_rate_limit" }
          });
      }
    // A breaker that left `closed` while the lane's last failure was a fault outside any window.
    for (const [index, record] of breakers.entries()) {
      if (record.from !== "closed" || record.to === "closed") continue;
      const opened = toMs(record.at);
      const cause = failures.findLast((failure) => failure.at <= opened);
      // A sign-in failure outranks the breaker in the status: it is its own fault above.
      if (!cause || cause.until < opened || cause.kind === "unauthorized") continue;
      if (!outside(cause.exchange)) continue;
      const closed = breakers.slice(index + 1).find((next) => next.to === "closed");
      faults.push({
        id: `fault-${cause.exchange.kind}#${cause.exchange.seq}`,
        lane,
        from: opened,
        until: closed ? toMs(closed.at) : runEnd(run),
        expect:
          cause.kind === "unreachable"
            ? { class: "offline", reason: "network_unreachable" }
            : { class: "waiting", reason: "provider_unavailable" }
      });
    }
  }
  return faults.toSorted((a, b) => a.from - b.from);
}

/**
 * E5 (predicate v6). (ii): after the settle that follows every ground-truth transition (the latest
 * `settleUntil` so far), the sentence's class equals the highest-precedence class an active window
 * expects among those whose condition affects work at the sample ({@link e5Affected}); a sample
 * where none does is counted apart (`unaffected`), since the status names a class only for the
 * work it holds (spec 3.8). With no window active, the sentence is not the class of a window that
 * ended in the last 30 minutes. An expectation (a window, or a stage of one such as
 * `g250-money#80`) whose class was never compared is not exercised (review), with why.
 * v4: an injected lane fault ({@link e5LaneFaults}) is one more active ground truth, on its lane,
 * from {@link e5LaneSettleMs} after it starts until it ends; within that settle of its start or of
 * its end, a sample whose expectation it would outrank is not judged, and after it the sentence is
 * not its class for 30 minutes, like a window's.
 * v5: a provider problem, a window's or a lane fault's, affects only the work on its provider's
 * lane ({@link E5Lane}, {@link e5Routes}); a class mismatch whose sentence names an active truth
 * that affected no task says which (`named`).
 * v6: a kind whose calls were all local is on the local lane, as the product reads it.
 * v7: where no active truth affects work, the sentence must not name the class of one of them for
 * its own kind of condition (a provider problem, a model check, a missing model or decider): such a
 * sample is an over-hold, a class mismatch with `named`, unless {@link e5MayAffect} finds work that
 * condition could affect or a lane fault of that class is within its settle; it exercises no window.
 * (i): a sample with a task set aside by a blocker whose sentence names no class (or is the generic
 * one) is a fallback.
 */
export function computeE5(run: LoadedRun): E5Result {
  const samples = sortedSamples(run);
  const truths = groundTruthOf(run).toSorted((a, b) => toMs(a.at) - toMs(b.at));
  const transitions: Transition[] = truths.map((record) => ({
    at: toMs(record.at),
    settleUntil: toMs(record.settleUntil),
    record
  }));
  const laneFaults = e5LaneFaults(run);
  const routes = e5Routes(run);
  const lanesOfWindows = windowLanes(run);
  const result: E5Result = {
    laneFaults,
    laneFaultChecks: 0,
    notExercised: [],
    checked: 0,
    matched: 0,
    unaffected: [],
    classMismatches: [],
    reasonMismatches: 0,
    recoveryMismatches: [],
    fallbackSamples: 0,
    samplesWithBlocked: 0,
    samplesWithStatus: 0
  };
  // By expectation record (`g250-money#80` apart from `g250-money#100`).
  const compared = new Set<string>();
  const openPastSettle = new Set<string>();
  /** What took the samples an expectation was affected at but not compared at. */
  const outrankedBy = new Map<string, Set<"lane_fault" | "window">>();
  const outrank = (id: string, by: "lane_fault" | "window") =>
    outrankedBy.set(id, (outrankedBy.get(id) ?? new Set()).add(by));
  const byPrecedence = (a: { expect: { class: string } }, b: { expect: { class: string } }) =>
    classRank(a.expect.class) - classRank(b.expect.class);
  const keyOf = (expect: { class: string; reason: string }) => `${expect.class}.${expect.reason}`;
  /**
   * A sentence names a truth's own kind of condition: its class, read the same way (E5 v7). E5
   * compares classes: a usage limit's sentence may be `waiting.provider_unavailable` once the
   * breaker opens, never `waiting.queue`.
   */
  const namesKindOf = (
    seen: { class: string; reason: string } | null,
    expect: { class: string; reason: string }
  ) => seen !== null && seen.class === expect.class && e5ExposureOf(seen) === e5ExposureOf(expect);
  for (const sample of samples) {
    const at = toMs(sample.at);
    const status = sample.status;
    if (status !== null && status !== undefined) result.samplesWithStatus += 1;
    // (i) a task set aside needs a (class, reason) sentence.
    if (sample.jobs.some((job) => job.blockedClass)) {
      result.samplesWithBlocked += 1;
      if (status && (status.fallback === true || !status.class || !status.reason))
        result.fallbackSamples += 1;
    }
    // (ii) after the settle of every transition so far.
    if (!status) continue;
    const happened = transitions.filter((entry) => entry.at <= at);
    if (happened.length > 0 && at < Math.max(...happened.map((entry) => entry.settleUntil)))
      continue;
    const active = new Map<string, GroundTruthRecord>();
    for (const entry of happened) {
      if (entry.record.phase === "start") active.set(entry.record.id, entry.record);
      else active.delete(entry.record.id);
    }
    const expecting = [...active.values()].filter((record) => record.expect);
    for (const record of expecting) openPastSettle.add(record.id);
    // A provider problem's lane, with the lane each task's calls take now (E5 v5).
    const routeOf = (job: JobSample) => routes(job, at);
    const on = (lane: string | null | undefined): E5Lane | null =>
      lane ? { lane, routeOf } : null;
    const windowOn = (record: GroundTruthRecord) =>
      e5ExposureOf(record.expect!) === "lane" ? on(lanesOfWindows.get(windowOf(record.id))) : null;
    // The lane faults the status may hold now: settled ones are expected, the others not judged.
    const openFaults = laneFaults.filter(
      (fault) => fault.from <= at && at < fault.until + e5LaneSettleMs
    );
    const settled = (fault: E5LaneFault) => at >= fault.from + e5LaneSettleMs && at < fault.until;
    const holding = openFaults.filter((fault) => e5Affected(sample, fault.expect, on(fault.lane)));
    const affecting = expecting.filter((record) =>
      e5Affected(sample, record.expect!, windowOn(record))
    );
    // Windows first: of two truths of one class, the window is the one compared.
    const candidates = [
      ...affecting.map((record) => ({ id: record.id, expect: record.expect!, window: true })),
      ...holding.filter(settled).map((fault) => ({ ...fault, window: false }))
    ];
    if (candidates.length > 0) {
      const top = candidates.toSorted(byPrecedence)[0]!;
      // A fault in its settle that would outrank the expectation: either reading may be right.
      if (holding.some((fault) => !settled(fault) && byPrecedence(fault, top) < 0)) {
        for (const record of affecting) outrank(record.id, "lane_fault");
        continue;
      }
      for (const record of affecting)
        if (record.id !== top.id) outrank(record.id, top.window ? "window" : "lane_fault");
      if (top.window) compared.add(top.id);
      else result.laneFaultChecks += 1;
      result.checked += 1;
      if (status.class === top.expect.class) {
        result.matched += 1;
        if (status.reason !== top.expect.reason) result.reasonMismatches += 1;
      } else {
        // The sentence named a truth active now whose condition affected no task here.
        const seenExpect =
          status.class && status.reason ? { class: status.class, reason: status.reason } : null;
        const idle = [
          ...expecting
            .filter((record) => !affecting.includes(record))
            .map((record) => ({ name: record.id, expect: record.expect! })),
          ...openFaults
            .filter((fault) => !holding.includes(fault))
            .map((fault) => ({
              name: `${fault.id} on ${fault.lane ?? "its lane"}`,
              expect: fault.expect
            }))
        ];
        const named = idle.find((truth) => namesKindOf(seenExpect, truth.expect))?.name;
        result.classMismatches.push({
          at: sample.at,
          window: top.id,
          expected: keyOf(top.expect),
          seen: `${status.class ?? "none"}.${status.reason ?? "none"} (${status.state})`,
          ...(named ? { named } : {})
        });
      }
      continue;
    }
    // v7: no active truth affects work here. A sentence of the class one of them expects, for its
    // own kind of condition (a provider problem, a model check, a missing model or decider), holds
    // work that condition does not affect (spec 3.8: an over-hold), unless a reading the status may
    // take finds such work, or a lane fault of that class is in its settle (either may be right).
    const shown =
      status.class && status.reason ? { class: status.class, reason: status.reason } : null;
    const decidersMissing =
      expecting.some((record) => keyOf(record.expect!) === "no_model.no_decider") ||
      sample.jobs.some(
        (job) => job.blockedClass === "no_model" && job.blockedReason === "no_decider"
      );
    const overHeld =
      shown && !openFaults.some((fault) => !settled(fault) && fault.expect.class === shown.class)
        ? [
            ...expecting.map((record) => ({
              id: record.id,
              name: record.id,
              expect: record.expect!,
              on: windowOn(record)
            })),
            ...openFaults.filter(settled).map((fault) => ({
              id: fault.id,
              name: `${fault.id} on ${fault.lane ?? "its lane"}`,
              expect: fault.expect,
              on: on(fault.lane)
            }))
          ].find(
            (truth) =>
              // A control or a cap holds whether or not work waits (a power window by its reading).
              e5ExposureOf(truth.expect) !== "standing" &&
              namesKindOf(shown, truth.expect) &&
              !e5MayAffect(sample, truth.expect, truth.on, decidersMissing) &&
              !e5MayAffect(sample, shown, truth.on, decidersMissing)
          )
        : undefined;
    if (overHeld) {
      result.checked += 1;
      result.classMismatches.push({
        at: sample.at,
        window: overHeld.id,
        expected: "none",
        seen: `${status.class}.${status.reason} (${status.state})`,
        named: overHeld.name,
        overHold: true
      });
      continue;
    }
    if (expecting.length > 0) {
      const top = expecting.toSorted(
        (a, b) => classRank(a.expect!.class) - classRank(b.expect!.class)
      )[0]!;
      result.unaffected.push({ at: sample.at, window: top.id });
      continue;
    }
    // Nothing is expected: the sentence must have left the class of a window or a lane fault that
    // just ended, unless a lane fault of that class may still hold it.
    const ended = [
      ...happened
        .filter((entry) => entry.record.phase === "end" && at - entry.at <= 30 * minute)
        .map((entry) => truths.find((t) => t.id === entry.record.id && t.phase === "start"))
        .filter((record): record is GroundTruthRecord => Boolean(record?.expect))
        .map((record) => ({ id: record.id, expect: record.expect! })),
      ...laneFaults.filter(
        (fault) => fault.until + e5LaneSettleMs <= at && at - fault.until <= 30 * minute
      )
    ];
    const seen = `${status.class}.${status.reason}`;
    for (const record of ended)
      if (
        seen === keyOf(record.expect) &&
        !openFaults.some((fault) => keyOf(fault.expect) === seen)
      )
        result.recoveryMismatches.push({ at: sample.at, window: record.id, seen });
  }
  // Every window that expects a class and started, and each of its expectations (a stage such as
  // `g250-money#80` apart from `#100`), must have been compared at least once.
  const started = new Set(
    truths
      .filter((record) => record.phase === "start" && record.id === windowOf(record.id))
      .map((record) => record.id)
  );
  const expectingWindows = new Set([
    ...(run.meta.f4?.windows ?? []).filter((window) => window.expect).map((window) => window.id),
    ...truths
      .filter((record) => record.expect || record.detail?.met === false)
      .map((record) => windowOf(record.id))
  ]);
  for (const window of [...expectingWindows].sort()) {
    if (!started.has(window)) continue;
    const records = truths.filter((record) => windowOf(record.id) === window);
    const expectations = [
      ...new Set(
        records
          .filter((record) => record.phase === "start" && record.expect)
          .map((record) => record.id)
      )
    ];
    if (expectations.some((id) => compared.has(id))) {
      // Compared at least once; a stage of it that never was is not exercised on its own.
    } else if (records.some((record) => record.phase === "end" && record.detail?.met === false)) {
      result.notExercised.push({ window, why: "unmet" });
      continue;
    } else if (expectations.length === 0) {
      result.notExercised.push({ window, why: "never_opened" });
      continue;
    }
    for (const id of expectations.toSorted()) {
      if (compared.has(id)) continue;
      const by = outrankedBy.get(id);
      const why: E5NotExercisedWhy = by
        ? by.has("window")
          ? "outranked"
          : "outranked_by_lane_fault"
        : openPastSettle.has(id)
          ? "nothing_affected"
          : "ended_in_settle";
      result.notExercised.push({ window: id, why });
    }
  }
  return result;
}

const notExercisedText: Record<E5NotExercisedWhy, string> = {
  unmet: "no call met its fault, so its class was not checked",
  never_opened: "its expectation never opened, so its class was not checked",
  nothing_affected:
    "no sample after its settle held work its condition affects, so its class was not checked",
  ended_in_settle: "it ended inside the settle of its expectation, so its class was not checked",
  outranked_by_lane_fault:
    "every sample after its settle that it affected went to an injected lane fault ranked above it, so its class was not checked",
  outranked:
    "every sample after its settle that it affected went to another window ranked above it (or to a lane fault), so its class was not checked"
};

export function e5Check(run: LoadedRun): Check {
  const result = computeE5(run);
  const noStatus = result.samplesWithStatus === 0;
  const failing =
    result.fallbackSamples > 0 ||
    result.classMismatches.length > 0 ||
    result.recoveryMismatches.length > 0;
  const named = result.classMismatches.filter((row) => row.named).length;
  const group = (rows: Array<{ window: string }>) => {
    const counts = new Map<string, number>();
    for (const row of rows) counts.set(row.window, (counts.get(row.window) ?? 0) + 1);
    return [...counts].map(([window, count]) => `${window}: ${count}`);
  };
  return {
    id: "e5-status",
    title: "E5 status coverage",
    bar: "(i) 0 samples with a task set aside whose sentence is a fallback; (ii) 100 % of the samples after the settle of every transition show the class the highest-precedence active ground truth expects among the windows whose condition affects work at the sample (a control or a cap always; a provider problem the work on its own lane: a call on it, a remote task whose calls take it; a model check any Gardener work; a missing decider the tasks it set aside; a provider-wait window from the first call that met its fault), and where none affects work no sentence of an active truth's class for its kind of condition; every window and every stage of one compared at least once",
    status: noStatus
      ? "review"
      : failing
        ? "fail"
        : result.notExercised.length > 0
          ? "review"
          : "pass",
    value: noStatus
      ? "no status sample was recorded: the run had no status service"
      : `(i) ${result.fallbackSamples} fallback sample(s) of ${result.samplesWithBlocked} with a task set aside; (ii) ${result.matched} of ${result.checked} = ${pct(result.matched, result.checked)}, ${result.recoveryMismatches.length} recovery mismatch(es), ${result.reasonMismatches} reason difference(s) at a right class; ${result.unaffected.length} sample(s) in a window with no work its condition affects; ${result.notExercised.length} window(s) or stage(s) not exercised`,
    details: [
      ...result.notExercised.map(
        ({ window, why }) => `${window}: ${notExercisedText[why]} (not exercised)`
      ),
      ...result.classMismatches
        .slice(0, 10)
        .map((row) =>
          row.overHold
            ? `${row.at}: no active truth affected a task, yet the sentence was ${row.seen}, the class of ${row.named}, whose condition affected no task at the sample (an over-hold, E5 v7)`
            : `${row.at}: ${row.window} expected ${row.expected}, the sentence was ${row.seen}${row.named ? `, the class of ${row.named}, whose condition affected no task at the sample` : ""}`
        ),
      ...group(result.classMismatches).map((line) => `class mismatches in ${line}`),
      ...(named > 0
        ? [
            `${named} class mismatch(es) name an active truth whose condition affected no task at the sample: spec 3.8 names the highest class with an affected task, so the status, not the oracle, missed (E5 v5, v7)`
          ]
        : []),
      ...group(result.unaffected).map(
        (line) => `samples with no work the condition affects (not compared) in ${line}`
      ),
      ...result.recoveryMismatches
        .slice(0, 6)
        .map((row) => `${row.at}: still ${row.seen} after ${row.window} ended`),
      ...(result.laneFaults.length > 0
        ? [
            `injected lane faults outside any window, held as the product holds them (E5 v4): ${result.laneFaults.length} (${[
              ...Map.groupBy(
                result.laneFaults,
                (fault) => `${fault.expect.class}.${fault.expect.reason}`
              )
            ]
              .map(([key, faults]) => `${key} ${faults.length}`)
              .join(", ")}); ${result.laneFaultChecks} sample(s) compared with one`
          ]
        : [])
    ]
  };
}

// --- The injection ledger -----------------------------------------------------------------------

export function injectionCheck(run: LoadedRun): {
  check: Check;
  table: Array<Record<string, string | number>>;
} {
  const provider = "openai-codex";
  const mine = exchangesOf(run).filter((exchange) => exchange.provider === provider);
  const injected = mine.filter((exchange) => exchange.injected);
  const untagged = injected.filter((exchange) => exchange.tag !== "soak-injected");
  const forwarded = injected.filter(
    (exchange) => exchange.kind !== "stall" && (exchange.forwardedBytes ?? 0) > 0
  );
  const stallNotForwarded = injected.filter(
    (exchange) => exchange.kind === "stall" && (exchange.forwardedBytes ?? 0) === 0
  );
  const kinds = new Map<string, ExchangeRecord[]>();
  for (const exchange of injected)
    (kinds.get(exchange.kind) ?? kinds.set(exchange.kind, []).get(exchange.kind)!).push(exchange);
  const table = [...kinds]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([kind, list]) => ({
      kind,
      exchanges: list.length,
      "bytes forwarded": list.reduce((sum, entry) => sum + (entry.forwardedBytes ?? 0), 0),
      "forwarded (must be 0 but a stall)": list.filter((entry) => (entry.forwardedBytes ?? 0) > 0)
        .length,
      synthetic: list.filter((entry) => entry.synthetic === true).length
    }));
  const problems = untagged.length + forwarded.length + stallNotForwarded.length;
  return {
    table,
    check: {
      id: "injection-ledger",
      title: "Injection ledger",
      bar: "every injected exchange is tagged soak-injected; 0 bytes of its request reach the provider for every injected exchange but a stall",
      status: mine.length === 0 ? "n/a" : problems > 0 ? "fail" : "pass",
      value: `${injected.length} injected of ${mine.length} Codex exchange(s); ${forwarded.length} forwarded when they must not be, ${untagged.length} untagged; bodies are synthetic shapes built from our parser's patterns (${injected.filter((entry) => entry.synthetic === true).length} synthetic)`,
      details: [
        ...forwarded
          .slice(0, 8)
          .map(
            (entry) =>
              `${entry.kind} #${entry.seq} at ${entry.startedAt} forwarded ${entry.forwardedBytes} byte(s)`
          ),
        ...untagged
          .slice(0, 8)
          .map((entry) => `${entry.kind} #${entry.seq} carries no soak-injected tag`),
        ...stallNotForwarded.slice(0, 4).map((entry) => `stall #${entry.seq} forwarded no request`)
      ]
    }
  };
}

// --- The token budget ---------------------------------------------------------------------------

export function tokensCheck(run: LoadedRun): {
  check: Check;
  table: Array<Record<string, string | number>>;
} {
  const rows = codexRows(run);
  const f4 = run.meta.f4;
  const start = toMs(run.meta.startedAt);
  const used = rows.map((row) => ({
    day: Math.floor((toMs(row.startedAt) - start) / day),
    tokens: callTokens(row),
    known: row.inputTokens !== null && row.inputTokens !== undefined
  }));
  const total = used.reduce((sum, row) => sum + row.tokens, 0);
  const unknown = used.filter((row) => !row.known).length;
  const byDay = new Map<number, number>();
  for (const row of used) byDay.set(row.day, (byDay.get(row.day) ?? 0) + row.tokens);
  const lastCap = sortedSamples(run).at(-1)?.cap;
  const drops = run.events.filter(
    (event): event is Extract<SoakEvent, { type: "drop_step" }> => event.type === "drop_step"
  );
  const exhausted = run.events.some(
    (event) => event.type === "cap" && event.action === "exhausted"
  );
  const days = Math.max(1, (runEnd(run) - start) / day);
  const table = [...byDay]
    .toSorted(([a], [b]) => a - b)
    .map(([index, tokens]) => ({
      day: index + 1,
      "Codex tokens": tokens,
      "planned a day": f4
        ? Math.round(f4.codex.expected / Math.max(1, run.meta.durationMs / day))
        : "-"
    }));
  // Every drop step taken is the floor: the orchestrator asks the owner while the run goes on.
  const status: CheckStatus = !f4
    ? "n/a"
    : exhausted || total > f4.codex.cap
      ? "fail"
      : drops.some((entry) => entry.step === 5)
        ? "review"
        : "pass";
  return {
    table,
    check: {
      id: "tokens",
      title: "Tokens and cap",
      bar: "Codex tokens stay under the harness cap by reservation; the run that reaches it is inconclusive; drop steps are reported",
      status,
      value: f4
        ? `${total} tokens in ${rows.length} Codex call(s) (${unknown} without a count) against ${f4.codex.expected} expected and a cap of ${f4.codex.cap}; ${(total / days).toFixed(0)} a day; harness cap spent ${lastCap?.spentTokens ?? "-"}; ${drops.length} drop step(s)`
        : "no Codex budget in this run",
      details: [
        ...drops.map(
          (entry) =>
            `drop step ${entry.step} at ${entry.at}: ${entry.note ?? ""} (${entry.spentTokens} spent + ${entry.projectedTokens} projected > ${entry.capTokens})`
        ),
        ...(exhausted ? ["The hard cap was reached: the run is inconclusive, not passed."] : [])
      ]
    }
  };
}

// --- Load ledger and relations ------------------------------------------------------------------

export function loadCheck(run: LoadedRun): {
  check: Check;
  table: Array<Record<string, string | number>>;
} {
  const samples = sortedSamples(run).filter((sample) => sample.load);
  const start = toMs(run.meta.startedAt);
  const byDay = new Map<
    number,
    { max1m: number; warn: number; critical: number; samples: number; top: Map<string, number> }
  >();
  for (const sample of samples) {
    const index = Math.floor((toMs(sample.at) - start) / day);
    const tally = byDay.get(index) ?? {
      max1m: 0,
      warn: 0,
      critical: 0,
      samples: 0,
      top: new Map()
    };
    const load = sample.load!;
    tally.samples += 1;
    tally.max1m = Math.max(tally.max1m, load.loadAverage[0]);
    if (load.memoryPressure === "warn") tally.warn += 1;
    if (load.memoryPressure === "critical") tally.critical += 1;
    for (const process of load.top)
      if (process.cpuPercent >= 50)
        tally.top.set(process.command, (tally.top.get(process.command) ?? 0) + 1);
    byDay.set(index, tally);
  }
  const table = [...byDay]
    .toSorted(([a], [b]) => a - b)
    .map(([index, tally]) => ({
      day: index + 1,
      "max load (1 min)": tally.max1m,
      "pressure warn": tally.warn,
      "pressure critical": tally.critical,
      "busy outside processes (>= 50 % CPU, minutes)":
        [...tally.top].map(([command, count]) => `${command} ${count}`).join(", ") || "none"
    }));
  const critical = [...byDay.values()].reduce((sum, tally) => sum + tally.critical, 0);
  return {
    table,
    check: {
      id: "load-ledger",
      title: "Load ledger",
      bar: "information: tells an agent's test run or build from a defect of the product when a stop check fires (D2, D38)",
      status: samples.length === 0 ? "n/a" : critical > 0 ? "review" : "pass",
      value:
        samples.length === 0
          ? "no load sample was recorded"
          : `${samples.length} sample(s); memory pressure critical in ${critical}; the busiest outside processes are listed by day`,
      details: []
    }
  };
}

export function relationsLine(run: LoadedRun): string | null {
  const relations = run.meta.relations;
  if (!relations) return null;
  const judge = relations.sourceJudge
    ? `source judge ${relations.sourceJudge.mode} (at most ${relations.sourceJudge.maxPairsPerCall} pairs a call)`
    : "source judge not recorded";
  return `Relations configuration kept by the run: source discovery neighbours ${relations.discoveryNeighbours} (the knob that sets them is refused in a soak), ${judge}, note decider mode ${relations.judgeMode ?? "not stored (the routes derive it)"}.`;
}

// --- Gate S assertions for the real lane --------------------------------------------------------

export interface GateSAssertion {
  kind: string;
  occurrences: number;
  detail: string;
  status: CheckStatus;
}

/** The kinds the fetch layer adds to F3's: each ends as the product's parser and deadlines say. */
export function gateSAssertions(run: LoadedRun): GateSAssertion[] {
  const rows = codexRows(run);
  const injected = exchangesOf(run).filter(
    (entry) => entry.provider === "openai-codex" && entry.injected
  );
  const near = (exchange: ExchangeRecord) =>
    rows.filter(
      (row) =>
        toMs(row.startedAt) - 1_000 <= toMs(exchange.endedAt) &&
        (row.finishedAt ? toMs(row.finishedAt) : toMs(row.startedAt) + row.durationMs) + 1_000 >=
          toMs(exchange.startedAt)
    );
  const out: GateSAssertion[] = [];
  const check = (kind: string, pattern: RegExp, expectPermanent: boolean, describe: string) => {
    const list = injected.filter((entry) => entry.kind === kind);
    const ended = list.filter((entry) =>
      near(entry).some((row) => row.status !== "succeeded" && pattern.test(row.error ?? ""))
    );
    out.push({
      kind,
      occurrences: list.length,
      detail: `${ended.length} of ${list.length} ended as ${describe}${expectPermanent ? " (not retried)" : ""}`,
      status: list.length > 0 && ended.length === list.length ? "pass" : "fail"
    });
  };
  check("unauthorized", /401|unauthor|authentication|soak-injected/iu, true, "a permanent 401");
  check("context_overflow", /context|exceed|soak-injected/iu, true, "a permanent context overflow");
  check("usage_limit", /429|usage|rate|limit|soak-injected/iu, false, "a transient usage limit");
  check("refused", /ECONNREFUSED|fetch failed|network|connection/iu, false, "a transport failure");
  check("enotfound", /ENOTFOUND|fetch failed|network|connection/iu, false, "a transport failure");
  return out;
}

// --- Assembly -----------------------------------------------------------------------------------

export interface F4Report {
  checks: Check[];
  tables: {
    exposure: Array<Record<string, string | number>>;
    e3: Array<Record<string, string | number>>;
    injection: Array<Record<string, string | number>>;
    tokens: Array<Record<string, string | number>>;
    load: Array<Record<string, string | number>>;
  };
  gateS: GateSAssertion[];
  relations: string | null;
  predicates: Record<string, number>;
}

/** Every F4 line of the report for a run that has them (a plan with an `f4` section). */
export function f4Report(run: LoadedRun, context: F4Context): F4Report | null {
  if (!run.meta.f4) return null;
  const e1 = e1Check(run);
  const e3 = e3Check(run, context);
  const injection = injectionCheck(run);
  const tokens = tokensCheck(run);
  const load = loadCheck(run);
  return {
    checks: [
      e1.check,
      e2Check(run, context),
      e3.check,
      e4Check(run),
      e5Check(run),
      injection.check,
      tokens.check,
      load.check
    ],
    tables: {
      exposure: e1.table,
      e3: e3.table,
      injection: injection.table,
      tokens: tokens.table,
      load: load.table
    },
    gateS: gateSAssertions(run),
    relations: relationsLine(run),
    predicates: { ...predicateVersions }
  };
}
