// The Gardener's status (F4 D27, spec 3.8): what the Gardener is doing, or why it is not doing it, in
// one structure the Activity pill renders as one sentence. This module is pure: the main process
// reads the facts (the gates' holds, the blocked and waiting tasks, the AI lanes, the downloads, the
// budget, the finished tasks' durations, the coverage shares) and `composeGardenerStatus` turns them
// into a {state, class, reason, params, coverage, eta, action} snapshot; `status-sentence.ts` renders
// the snapshot through `@app/i18n`. Precedence is D7's: the highest class with a task it affects
// wins (paused > no_model > cap > download > waiting > offline). The snapshot carries times, names
// and amounts, never identifiers and never call or task counts.
import { z } from "zod";

import { localMonthWindow } from "../remote-budget.js";
import {
  gardenerBlockerClasses,
  gardenerBlockerClearing,
  gardenerBlockerKey,
  gardenerBlockerReasons,
  isGardenerBlockerKey,
  type GardenerBlocker,
  type GardenerBlockerClass,
  type GardenerBlockerKey
} from "./blockers.js";
import { gardenerTaskKind, gardenerTaskKinds } from "./kinds.js";
import { nextLocalDay } from "./state.js";

const milliseconds = (min: number, max: number) => z.number().int().min(min).max(max);

/**
 * Numbers of the status (D36: typed configuration, not rules). `etaSamples`: the finished tasks of a
 * kind whose durations the estimate takes the median of; `etaMinSamples`: a kind with fewer has no
 * duration estimate (an unknown is never invented); `laneFailureTtlMs`: a provider failure older
 * than this no longer explains a wait; `modelLoadTtlMs`: a model still reported as loading after
 * this long is no longer taken to be; `scheduledWithinMs`: a task scheduled for later counts as
 * work in progress only when it is due within this long (a debounce does, the daily housekeeping
 * does not); `coverageTtlMs`: the coverage shares are read at most this
 * often; `refreshWindowMs`: the status is recomputed this long after the first notice of a burst of
 * changes; `heartbeatMs`: a status that is not idle is looked at again at least this often, so a
 * condition that ends without an event (a breaker closing, a pause passing) is noticed.
 */
export const GardenerStatusConfigSchema = z
  .object({
    etaSamples: z.number().int().min(5).max(500).default(50),
    etaMinSamples: z.number().int().min(1).max(50).default(3),
    laneFailureTtlMs: milliseconds(10_000, 86_400_000).default(900_000),
    modelLoadTtlMs: milliseconds(10_000, 86_400_000).default(600_000),
    scheduledWithinMs: milliseconds(0, 86_400_000).default(300_000),
    coverageTtlMs: milliseconds(1_000, 600_000).default(30_000),
    refreshWindowMs: milliseconds(50, 10_000).default(500),
    heartbeatMs: milliseconds(1_000, 600_000).default(30_000)
  })
  .strict()
  .refine((value) => value.etaMinSamples <= value.etaSamples, {
    message: "gardener.config.etaMinSamplesAboveSamples"
  });
export type GardenerStatusConfig = z.infer<typeof GardenerStatusConfigSchema>;
export const defaultGardenerStatusConfig: Readonly<GardenerStatusConfig> = Object.freeze(
  GardenerStatusConfigSchema.parse({})
);

export const gardenerStatusStates = ["running", "idle", "blocked", "attention"] as const;
export type GardenerStatusState = (typeof gardenerStatusStates)[number];

/**
 * What the Activity offers to do about a reason: the renderer maps an action to its handler (resume
 * the Gardener, open the Knowledge controls, the AI settings or the local models, continue past the
 * pause share, raise the cap); the label is the action's i18n key (`gardener.status.actions.<id>`).
 */
export const gardenerStatusActions = [
  "resume",
  "open_controls",
  "open_ai_settings",
  "open_local_models",
  "sign_in",
  "continue_budget",
  "raise_budget"
] as const;
export type GardenerStatusAction = (typeof gardenerStatusActions)[number];

/** The action of each reason, if the person can do something about it. */
export const gardenerStatusActionOf: Readonly<
  Record<GardenerBlockerKey, GardenerStatusAction | null>
> = {
  "paused.user_pause": "resume",
  "paused.autonomy_off": "open_controls",
  "paused.only_idle_user_active": "open_controls",
  "paused.only_ac_on_battery": "open_controls",
  "no_model.no_route": "open_ai_settings",
  "no_model.model_missing": "open_local_models",
  "no_model.no_decider": "open_local_models",
  "no_model.signin_required": "sign_in",
  "no_model.space_changed": null,
  "cap.money_80": "continue_budget",
  "cap.money_100": "raise_budget",
  "cap.subscription_daily": null,
  "cap.provider_quota": null,
  "cap.feature_daily": null,
  "download.model_downloading": "open_local_models",
  "download.model_verifying": null,
  "download.model_loading": null,
  "waiting.queue": null,
  "waiting.same_scope": null,
  "waiting.provider_rate_limit": null,
  "waiting.provider_unavailable": null,
  "waiting.local_memory": null,
  "waiting.waiting_for_embeddings": null,
  "waiting.retry_backoff": null,
  "offline.network_unreachable": null
};

/**
 * The reasons only the person can clear: the status is `attention` while one holds (the Activity's
 * "needs you" items: a model to choose or install, a sign-in, the budget to continue or raise).
 */
export const gardenerStatusNeedsPerson: ReadonlySet<GardenerBlockerKey> = new Set([
  "no_model.no_route",
  "no_model.model_missing",
  "no_model.signin_required",
  "cap.money_80",
  "cap.money_100"
]);

/**
 * The ordinary waiting of healthy work: a task waits for its turn, for another task of its scope,
 * or for its next attempt. These reasons explain a non-running task only when nothing more specific
 * does (a task retrying because the network is down is explained by the network, not by the retry),
 * so they never outrank another class or a provider problem. The status stays `running` while the
 * queue and the scope explain it.
 */
const fallbackReasons: ReadonlySet<GardenerBlockerKey> = new Set([
  "waiting.retry_backoff",
  "waiting.same_scope",
  "waiting.queue"
]);
const flowReasons: ReadonlySet<GardenerBlockerKey> = new Set([
  "waiting.queue",
  "waiting.same_scope"
]);

/**
 * The order of the reasons inside `waiting` for the sentence: a provider or memory problem first,
 * then the ordinary waiting (D7 lists `queue` and `same_scope` first; here they come after the
 * specific waits, so a provider problem is never hidden behind the queue, and the retry last, so a
 * single task awaiting its next attempt does not speak for a library that is busy). The other
 * classes keep D7's order.
 */
const waitingStatusOrder = [
  "provider_rate_limit",
  "provider_unavailable",
  "local_memory",
  "waiting_for_embeddings",
  "same_scope",
  "queue",
  "retry_backoff"
] as const;

function statusRank(key: GardenerBlockerKey): number {
  const [blockerClass, reason] = key.split(".") as [GardenerBlockerClass, string];
  const classIndex = gardenerBlockerClasses.indexOf(blockerClass);
  const reasons: readonly string[] =
    blockerClass === "waiting" ? waitingStatusOrder : gardenerBlockerReasons[blockerClass];
  return classIndex * 100 + reasons.indexOf(reason);
}

const share = z.number().min(0).max(1);

/** The shares of the library each Gardener task keeps current (D27 "coverage"). */
export const GardenerStatusCoverageSchema = z
  .object({ placed: share, matched: share, overviewsFresh: share })
  .strict();
export type GardenerStatusCoverage = z.infer<typeof GardenerStatusCoverageSchema>;

/** Nothing to keep current counts as covered. */
export const fullGardenerCoverage: Readonly<GardenerStatusCoverage> = Object.freeze({
  placed: 1,
  matched: 1,
  overviewsFresh: 1
});

/**
 * The Gardener's status (spec 3.8). `class` and `reason` name the highest hold when there is one (a
 * standing control, a blocker on a task, a provider that does not answer); `params` carry the
 * variable parts of the sentence (route class, amounts), never IDs; `eta` is the time left for the
 * work ahead or the instant a hold clears; `action` is what the person can do about it.
 */
export const GardenerStatusSnapshotSchema = z
  .object({
    state: z.enum(gardenerStatusStates),
    class: z.enum(gardenerBlockerClasses).optional(),
    reason: z.string().min(1).max(80).optional(),
    params: z.record(
      z.string().min(1).max(40),
      z.union([z.string().max(200), z.number(), z.boolean()])
    ),
    coverage: GardenerStatusCoverageSchema,
    eta: z
      .discriminatedUnion("kind", [
        z.object({ kind: z.literal("duration"), seconds: z.number().int().nonnegative() }).strict(),
        z.object({ kind: z.literal("at"), at: z.string().datetime() }).strict()
      ])
      .optional(),
    action: z.enum(gardenerStatusActions).optional()
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.class === undefined) !== (value.reason === undefined))
      context.addIssue({ code: "custom", message: "gardener.status.classWithoutReason" });
    else if (value.class !== undefined && !isGardenerBlockerKey(`${value.class}.${value.reason}`))
      context.addIssue({
        code: "custom",
        path: ["reason"],
        message: "gardener.status.unknownReason"
      });
    if ((value.state === "blocked" || value.state === "attention") && value.class === undefined)
      context.addIssue({ code: "custom", message: "gardener.status.blockedWithoutReason" });
    if (value.action !== undefined && value.class === undefined)
      context.addIssue({ code: "custom", message: "gardener.status.actionWithoutReason" });
  });
export type GardenerStatusSnapshot = z.infer<typeof GardenerStatusSnapshotSchema>;

/** The snapshot of a library with nothing to do and nothing in the way. */
export const idleGardenerStatus: Readonly<GardenerStatusSnapshot> = Object.freeze({
  state: "idle",
  params: {},
  coverage: fullGardenerCoverage
});

// ---------------------------------------------------------------------------
// Facts

/**
 * What a lane tells of the last way its provider failed (`LaneSnapshot.failure` of `@app/ai`, which
 * this package cannot import; the two lists are the same).
 */
export type StatusLaneFailureKind = "unreachable" | "unauthorized" | "unavailable";

/** One AI lane as the status reads it; `LaneSnapshot` has this shape once its waits are summed. */
export interface StatusLaneFacts {
  /** `local`, or `remote:<provider configuration>`. */
  readonly lane: string;
  readonly running: number;
  /** Entries waiting for a slot, every priority together. */
  readonly waiting: number;
  /** Milliseconds a rate limit keeps the lane paused; null when it is not paused. */
  readonly pausedForMs: number | null;
  readonly breaker: {
    readonly state: "closed" | "open" | "half_open";
    readonly reopensInMs: number | null;
  } | null;
  /** How the provider last failed and how long ago; null after a call succeeded. */
  readonly failure: { readonly kind: StatusLaneFailureKind; readonly ageMs: number } | null;
}

/** The unfinished tasks of one Gardener kind that no blocker holds. */
export interface StatusTaskFacts {
  readonly type: string;
  readonly running: number;
  /** Queued, due and free to run. */
  readonly ready: number;
  /** Queued and due, but a task of the same scope is running. */
  readonly sameScope: number;
  /** Queued for another attempt after a failed one. */
  readonly retrying: number;
  /** Queued for later (a debounce, a re-request). */
  readonly scheduled: number;
}

/** Queued tasks of one kind that one blocker holds. */
export interface StatusBlockedFacts {
  readonly type: string;
  readonly blockerClass: string;
  readonly reason: string;
  readonly count: number;
  /** The earliest `run_after` of the group, epoch milliseconds. */
  readonly earliestRunAfterMs: number | null;
}

/** The local models being fetched, checked or loaded now. */
export interface StatusDownloadFacts {
  readonly downloading: boolean;
  readonly verifying: boolean;
  readonly loading: boolean;
  /** Seconds the download that finishes last still needs, when known. */
  readonly etaSeconds: number | null;
}

export interface StatusBudgetFacts {
  readonly spentUsd: number;
  readonly capUsd: number;
}

export interface GardenerStatusFacts {
  readonly nowMs: number;
  /**
   * What the global gates hold work by now: pause, autonomy Off, only idle, only on AC, and the
   * budget's cap (`BackgroundGate.forKinds`, distinct). A standing hold counts whether or not a
   * task waits behind it: it answers "why is it not running?" for work that has not arrived yet.
   */
  readonly gateHolds: ReadonlyArray<Pick<GardenerBlocker, "class" | "reason" | "clearsAt">>;
  readonly tasks: readonly StatusTaskFacts[];
  readonly blocked: readonly StatusBlockedFacts[];
  readonly lanes: readonly StatusLaneFacts[];
  readonly downloads: StatusDownloadFacts;
  readonly budget: StatusBudgetFacts | null;
  /** Durations of finished tasks in milliseconds per kind, oldest first. */
  readonly durations: Readonly<Record<string, readonly number[]>>;
  readonly coverage: GardenerStatusCoverage;
}

/** The Gardener kinds whose tasks the status counts. */
export const gardenerStatusKinds: readonly string[] = Object.values(gardenerTaskKinds)
  .filter((kind) => kind.gardener)
  .map((kind) => kind.type)
  .sort();

// ---------------------------------------------------------------------------
// Composition

type ParamValue = string | number | boolean;

interface Hold {
  key: GardenerBlockerKey;
  params: Record<string, ParamValue>;
  /** Epoch milliseconds when it clears by itself, when known. */
  clearsAt: number | null;
  /** Seconds left, when the hold is a download that reports them. */
  etaSeconds: number | null;
}

const roundMoney = (value: number) => Math.round(value * 100) / 100;

/** A share kept below 1 until it is complete, rounded down to a whole percent. */
export function coverageShare(done: number, total: number): number {
  if (!(total > 0)) return 1;
  const value = done / total;
  return value >= 1 ? 1 : Math.max(0, Math.floor(value * 100) / 100);
}

function medianMs(values: readonly number[], samples: number): number {
  const sorted = values
    .slice(-samples)
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((left, right) => left - right);
  if (sorted.length === 0) return 0;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[middle]! : (sorted[middle - 1]! + sorted[middle]!) / 2;
}

/** Rounds a duration so the status changes when the sentence would: 30 s, then 1 min, then 5 min. */
export function quantizeEtaSeconds(seconds: number): number {
  const value = Math.max(0, seconds);
  if (value < 120) return Math.round(value / 30) * 30;
  if (value < 3_600) return Math.round(value / 60) * 60;
  return Math.round(value / 300) * 300;
}

/**
 * The time left for the work ahead (D27): per kind, the median duration of its last tasks times the
 * tasks ahead of it (running, ready, waiting for a scope, retrying or scheduled), the kinds of one
 * worker one after another and the workers side by side, so the estimate is the busiest worker's.
 * Null when no work is ahead or a kind with work ahead has too few finished tasks to tell.
 */
export function workEtaSeconds(
  facts: Pick<GardenerStatusFacts, "tasks" | "durations">,
  config: Pick<GardenerStatusConfig, "etaSamples" | "etaMinSamples"> = defaultGardenerStatusConfig
): number | null {
  const perWorker = new Map<string, number>();
  let any = false;
  for (const task of facts.tasks) {
    const ahead = task.running + task.ready + task.sameScope + task.retrying + task.scheduled;
    if (ahead === 0) continue;
    const samples = facts.durations[task.type] ?? [];
    if (samples.length < config.etaMinSamples) return null;
    any = true;
    const worker = gardenerTaskKind(task.type)?.worker ?? task.type;
    perWorker.set(
      worker,
      (perWorker.get(worker) ?? 0) + (medianMs(samples, config.etaSamples) * ahead) / 1000
    );
  }
  if (!any) return null;
  return quantizeEtaSeconds(Math.max(...perWorker.values()));
}

/** The class of AI work a missing route names for these blocked tasks (`no_route {routeClass}`). */
function routeClassOf(types: readonly string[]): string {
  for (const type of types) {
    const routeClass = gardenerTaskKind(type)?.routeClass;
    if (routeClass) return routeClass;
  }
  return "embed";
}

/** The key of a stored blocker; one this version does not know waits like an unexplained queue wait. */
const keyOf = (blockerClass: string, reason: string): GardenerBlockerKey => {
  const key = `${blockerClass}.${reason}`;
  return isGardenerBlockerKey(key) ? key : "waiting.queue";
};

function addHold(holds: Map<GardenerBlockerKey, Hold>, next: Hold): void {
  const held = holds.get(next.key);
  if (!held) {
    holds.set(next.key, next);
    return;
  }
  // The earliest clearing time, and every parameter either source knows.
  held.clearsAt =
    held.clearsAt === null
      ? next.clearsAt
      : next.clearsAt === null
        ? held.clearsAt
        : Math.min(held.clearsAt, next.clearsAt);
  held.etaSeconds = held.etaSeconds ?? next.etaSeconds;
  held.params = { ...next.params, ...held.params };
}

/** When a cap clears by itself, if it does: a day's at the next local midnight, a month's at its end. */
function capClearsAt(key: GardenerBlockerKey, nowMs: number): number | null {
  if (key === "cap.subscription_daily" || key === "cap.feature_daily")
    return nextLocalDay(new Date(nowMs)).getTime();
  if (key === "cap.money_100") return localMonthWindow(new Date(nowMs)).end.getTime();
  return null;
}

/**
 * Composes the status from the facts (D27, spec 3.8). Holds come from the gates (standing), the
 * blocked tasks, the provider lanes and the downloads (each only while work is affected) and from
 * the ordinary waiting of queued tasks; the highest by class precedence names the status.
 */
export function composeGardenerStatus(
  facts: GardenerStatusFacts,
  config: GardenerStatusConfig = defaultGardenerStatusConfig
): GardenerStatusSnapshot {
  const { nowMs } = facts;
  const gardenerTasks = facts.tasks.filter((task) => gardenerTaskKind(task.type)?.gardener);
  const gardenerBlocked = facts.blocked.filter(
    (group) => gardenerTaskKind(group.type)?.gardener && group.count > 0
  );
  const running = gardenerTasks.reduce((sum, task) => sum + task.running, 0);
  const waitingTasks = gardenerTasks.reduce(
    (sum, task) => sum + task.ready + task.sameScope + task.retrying + task.scheduled,
    0
  );
  const blockedTasks = gardenerBlocked.reduce((sum, group) => sum + group.count, 0);
  const pending = waitingTasks + blockedTasks;
  const anyWork = pending + running > 0;
  const remoteWork =
    gardenerTasks
      .filter((task) => gardenerTaskKind(task.type)?.remote)
      .reduce(
        (sum, task) =>
          sum + task.running + task.ready + task.sameScope + task.retrying + task.scheduled,
        0
      ) +
    gardenerBlocked
      .filter((group) => gardenerTaskKind(group.type)?.remote)
      .reduce((sum, group) => sum + group.count, 0);

  const holds = new Map<GardenerBlockerKey, Hold>();

  // The global gates: standing holds.
  for (const gate of facts.gateHolds) {
    const key = gardenerBlockerKey(gate);
    const params: Record<string, ParamValue> = {};
    if ((key === "cap.money_80" || key === "cap.money_100") && facts.budget) {
      params.spentUsd = roundMoney(facts.budget.spentUsd);
      params.capUsd = roundMoney(facts.budget.capUsd);
    }
    addHold(holds, {
      key,
      params,
      clearsAt: typeof gate.clearsAt === "number" ? gate.clearsAt : capClearsAt(key, nowMs),
      etaSeconds: null
    });
  }

  // Blocked tasks: each group's blocker, the time it clears when the reason is time-bound.
  const blockedByKey = new Map<GardenerBlockerKey, StatusBlockedFacts[]>();
  for (const group of gardenerBlocked) {
    const key = keyOf(group.blockerClass, group.reason);
    const groups = blockedByKey.get(key) ?? [];
    groups.push(group);
    blockedByKey.set(key, groups);
  }
  for (const [key, groups] of blockedByKey) {
    const earliest = groups
      .map((group) => group.earliestRunAfterMs)
      .filter((value): value is number => typeof value === "number" && value > nowMs)
      .sort((left, right) => left - right)[0];
    const timeBound = gardenerBlockerClearing[key].atRunAfter && earliest !== undefined;
    const params: Record<string, ParamValue> = {};
    if (key === "no_model.no_route") params.routeClass = routeClassOf(groups.map((g) => g.type));
    addHold(holds, {
      key,
      params,
      clearsAt: timeBound ? earliest : capClearsAt(key, nowMs),
      etaSeconds: null
    });
  }

  // The provider lanes: a rate limit, a provider that does not answer, an unreachable network, a
  // sign-in that failed. Only while work could be using the lane.
  for (const lane of facts.lanes) {
    if (lane.lane === "local") continue;
    if (lane.running + lane.waiting === 0 && remoteWork === 0) continue;
    const failure =
      lane.failure && lane.failure.ageMs <= config.laneFailureTtlMs ? lane.failure.kind : null;
    const breakerNotClosed = lane.breaker !== null && lane.breaker.state !== "closed";
    if (lane.pausedForMs !== null && lane.pausedForMs > 0)
      addHold(holds, {
        key: "waiting.provider_rate_limit",
        params: {},
        clearsAt: nowMs + lane.pausedForMs,
        etaSeconds: null
      });
    if (failure === "unauthorized")
      addHold(holds, {
        key: "no_model.signin_required",
        params: {},
        clearsAt: null,
        etaSeconds: null
      });
    else if (failure === "unreachable" && breakerNotClosed)
      addHold(holds, {
        key: "offline.network_unreachable",
        params: {},
        clearsAt: null,
        etaSeconds: null
      });
    else if (breakerNotClosed)
      addHold(holds, {
        key: "waiting.provider_unavailable",
        params: {},
        clearsAt:
          lane.breaker?.state === "open" && lane.breaker.reopensInMs !== null
            ? nowMs + lane.breaker.reopensInMs
            : null,
        etaSeconds: null
      });
  }

  // The local models being fetched, checked or loaded, while work waits for models.
  if (anyWork) {
    const { downloads } = facts;
    if (downloads.downloading)
      addHold(holds, {
        key: "download.model_downloading",
        params: {},
        clearsAt: null,
        etaSeconds: downloads.etaSeconds
      });
    if (downloads.verifying)
      addHold(holds, {
        key: "download.model_verifying",
        params: {},
        clearsAt: null,
        etaSeconds: null
      });
    if (downloads.loading)
      addHold(holds, {
        key: "download.model_loading",
        params: {},
        clearsAt: null,
        etaSeconds: null
      });
    // A model that is arriving explains the tasks that wait for it: the download is the answer.
    if (downloads.downloading || downloads.verifying || downloads.loading) {
      holds.delete("no_model.model_missing");
      holds.delete("no_model.no_decider");
    }
  }

  // The ordinary waiting of tasks no blocker holds.
  const sameScope = gardenerTasks.reduce((sum, task) => sum + task.sameScope, 0);
  const retrying = gardenerTasks.reduce((sum, task) => sum + task.retrying, 0);
  const ready = gardenerTasks.reduce((sum, task) => sum + task.ready + task.scheduled, 0);
  if (retrying > 0)
    addHold(holds, { key: "waiting.retry_backoff", params: {}, clearsAt: null, etaSeconds: null });
  if (sameScope > 0)
    addHold(holds, { key: "waiting.same_scope", params: {}, clearsAt: null, etaSeconds: null });
  if (ready > 0)
    addHold(holds, { key: "waiting.queue", params: {}, clearsAt: null, etaSeconds: null });

  const ranked = (candidates: Hold[]) =>
    candidates.sort((left, right) => statusRank(left.key) - statusRank(right.key))[0];
  const all = [...holds.values()];
  const top =
    ranked(all.filter((candidate) => !fallbackReasons.has(candidate.key))) ??
    ranked(all.filter((candidate) => fallbackReasons.has(candidate.key)));

  let state: GardenerStatusState;
  if (top && gardenerStatusNeedsPerson.has(top.key)) state = "attention";
  else if (running > 0) state = "running";
  else if (top && flowReasons.has(top.key)) state = "running";
  else if (pending > 0) state = top ? "blocked" : "running";
  else state = "idle";

  const coverage = GardenerStatusCoverageSchema.parse(facts.coverage);
  const snapshot: GardenerStatusSnapshot = { state, params: {}, coverage };

  if (top) {
    const [blockerClass, reason] = top.key.split(".") as [GardenerBlockerClass, string];
    snapshot.class = blockerClass;
    snapshot.reason = reason;
    snapshot.params = Object.fromEntries(
      Object.entries(top.params).sort(([a], [b]) => a.localeCompare(b))
    );
    const action = gardenerStatusActionOf[top.key];
    if (action) snapshot.action = action;
  }

  // The time left: when a hold clears, when a download finishes, or the work ahead.
  if (top && top.clearsAt !== null && top.clearsAt > nowMs) {
    snapshot.eta = { kind: "at", at: new Date(top.clearsAt).toISOString() };
  } else if (top && top.etaSeconds !== null) {
    snapshot.eta = { kind: "duration", seconds: quantizeEtaSeconds(top.etaSeconds) };
  } else if ((!top || flowReasons.has(top.key) || top.key === "waiting.retry_backoff") && anyWork) {
    const seconds = workEtaSeconds({ tasks: gardenerTasks, durations: facts.durations }, config);
    if (seconds !== null) snapshot.eta = { kind: "duration", seconds };
  }

  return GardenerStatusSnapshotSchema.parse(snapshot);
}

/**
 * A new reading with the previous time kept when it only drifted: the instant a hold clears is
 * computed from clocks that differ by a few milliseconds from one reading to the next, which must
 * not read as a change (the status is published when it changes).
 */
export function stableGardenerStatus(
  previous: GardenerStatusSnapshot | null,
  next: GardenerStatusSnapshot,
  toleranceMs = 2_000
): GardenerStatusSnapshot {
  if (previous?.eta?.kind !== "at" || next.eta?.kind !== "at") return next;
  if (Math.abs(Date.parse(previous.eta.at) - Date.parse(next.eta.at)) > toleranceMs) return next;
  return { ...next, eta: previous.eta };
}

/** Whether two snapshots say the same thing (the status is published when this is false). */
export function sameGardenerStatus(
  left: GardenerStatusSnapshot | null,
  right: GardenerStatusSnapshot
): boolean {
  return left !== null && JSON.stringify(left) === JSON.stringify(right);
}
