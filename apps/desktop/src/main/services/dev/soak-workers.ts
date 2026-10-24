import { gardenerTaskKind } from "@app/domain";

import type { SoakSample, WorkerState } from "./soak-records.js";

/**
 * The state of each job worker at a sample (F4 T89, spec 5.2 E1): what the report needs to tell a
 * task that waits for its turn from one that is blocked by another. The job supervisor does not
 * expose its loops, so the state is derived from what the sample already holds: the running jobs
 * (the Gardener's kind table names the worker of each type) and the AI lanes (running calls, waiting
 * entries, a pause, the breaker). The inputs are in the sample, so a later predicate can read the
 * same data again; {@link workerPredicateVersion} says which one a run was evaluated with.
 *
 * A worker is `idle` when it holds no job, `executing` when its job is working (a call is running on
 * a lane it uses, or it needs no call), and `waiting` when it holds a job that makes no progress:
 * its lanes are paused by a rate limit or an open breaker, queued full behind other calls, or quiet
 * for longer than a call's gap (a retry backoff).
 */

export const workerPredicateVersion = 1;

/** The job loops: one each, the `relations` worker with a pool of slots. */
export const workerNames = ["heavy", "compute", "model", "relations"] as const;
export type WorkerName = (typeof workerNames)[number];

/** A running job with no call and no change for longer than this is between calls of a retry. */
export const retryGapMs = 90_000;

type SampleJob = SoakSample["jobs"][number];
type SampleLane = SoakSample["lanes"][number];

/** The worker that runs a job type, or null for work that runs inside another job or by itself. */
export function workerOfJob(job: Pick<SampleJob, "type" | "lane">): WorkerName | null {
  const kind = gardenerTaskKind(job.type);
  if (kind) {
    if (kind.worker === "inline" || kind.worker === "self") return null;
    return kind.worker;
  }
  // A type the kind table does not know: by its lane column.
  return job.lane === "heavy" ? "heavy" : "compute";
}

/** Whether a job type makes AI calls (so a quiet lane means it is waiting, not working). */
function callsModels(type: string): { local: boolean; remote: boolean } | null {
  const kind = gardenerTaskKind(type);
  if (!kind) return { local: true, remote: true };
  if (kind.task === "ingestion") return { local: true, remote: true };
  if (kind.generative || kind.remote || kind.routeClass !== null)
    return {
      // Local ranking and embedding take the local lane; the relations and heavy workers do both.
      local:
        !kind.remote ||
        kind.routeClass === "decide" ||
        kind.routeClass === "embed" ||
        kind.worker === "relations" ||
        kind.worker === "heavy",
      remote: kind.remote
    };
  return null;
}

const isRemote = (lane: SampleLane) => lane.lane.startsWith("remote:");
const queued = (lane: SampleLane) =>
  lane.waiting.P0 + lane.waiting.P1 + lane.waiting.P2 + lane.waiting.P3;

/** The state of one running job, from the lanes it can use. */
export function stateOfRunningJob(
  job: SampleJob,
  lanes: readonly SampleLane[],
  nowMs: number
): Pick<WorkerState, "state" | "why"> {
  const needs = callsModels(job.type);
  if (!needs) return { state: "executing" };
  const mine = lanes.filter((lane) => (isRemote(lane) ? needs.remote : needs.local));
  if (mine.some((lane) => lane.running > 0)) return { state: "executing" };
  if (mine.some((lane) => (lane.pausedForMs ?? 0) > 0)) return { state: "waiting", why: "pause" };
  if (mine.some((lane) => lane.breaker === "open" || lane.breaker === "half_open"))
    return { state: "waiting", why: "breaker" };
  if (mine.some((lane) => queued(lane) > 0)) return { state: "waiting", why: "permit" };
  // No call in flight, none queued, nothing paused: the job is between two calls, or in a backoff.
  return nowMs - job.updatedAt > retryGapMs
    ? { state: "waiting", why: "retry" }
    : { state: "executing" };
}

/**
 * Every worker's state: one entry per running job it holds and one `idle` entry per free slot.
 * `capacity` gives the slots of each worker (one, the `relations` pool aside).
 */
export function deriveWorkerStates(
  sample: Pick<SoakSample, "jobs" | "lanes">,
  nowMs: number,
  capacity: Readonly<Record<string, number>>
): WorkerState[] {
  const states: WorkerState[] = [];
  const held = new Map<string, number>();
  for (const job of sample.jobs) {
    if (job.status !== "running") continue;
    const worker = workerOfJob(job);
    if (!worker) continue;
    held.set(worker, (held.get(worker) ?? 0) + 1);
    const { state, why } = stateOfRunningJob(job, sample.lanes, nowMs);
    states.push({
      worker,
      state,
      ...(why ? { why } : {}),
      jobId: job.id,
      scopeKey: job.scopeKey ?? null
    });
  }
  for (const worker of workerNames) {
    const free = (capacity[worker] ?? 1) - (held.get(worker) ?? 0);
    for (let slot = 0; slot < free; slot += 1) states.push({ worker, state: "idle" });
  }
  return states;
}
