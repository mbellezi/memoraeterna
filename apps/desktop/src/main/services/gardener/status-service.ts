// The Gardener's status service (F4 D27, spec 3.8, T86): reads what the Gardener is doing and what
// holds it (the background gates, the blocked and waiting tasks, the AI lanes, the local model
// downloads, the budget, the durations of the tasks it has seen finish, the coverage of the library)
// and composes it, with the pure `composeGardenerStatus`, into one snapshot. The snapshot is read
// over IPC (`gardener.status`) and published on the event bus when it changes; a change is noticed
// from the events the app already has (jobs, budget, downloads, controls, power) and, for what ends
// without one (a breaker closing, a rate limit lifting), from a heartbeat and a timer at the time a
// hold clears. The service reads and publishes only: it never changes a task.
import type { LaneSnapshot } from "@app/ai";
import {
  createGardenerStatusRepository,
  createJobBlockerRepository,
  type BlockedJobGroup,
  type Queryable,
  type StatusCoverageCounts,
  type StatusJobEnd,
  type StatusRunningJob,
  type StatusTaskRow
} from "@app/db";
import {
  composeGardenerStatus,
  coverageShare,
  defaultGardenerStatusConfig,
  fullGardenerCoverage,
  gardenerBlockerKey,
  gardenerStatusKinds,
  idleGardenerStatus,
  sameGardenerStatus,
  stableGardenerStatus,
  type BudgetSnapshot,
  type GardenerBlocker,
  type GardenerStatusConfig,
  type GardenerStatusCoverage,
  type GardenerStatusFacts,
  type GardenerStatusSnapshot,
  type StatusLaneFacts
} from "@app/domain";

import type { AppEvent, AppEventHandler, AppEventType } from "../../../shared/app-events.js";

/** What the service reads from the database (`gardenerStatusStoreOf`; tests pass a fake). */
export interface GardenerStatusStore {
  taskCounts(types: readonly string[], scheduledWithinSeconds?: number): Promise<StatusTaskRow[]>;
  blockedGroups(): Promise<BlockedJobGroup[]>;
  runningJobs(types: readonly string[]): Promise<StatusRunningJob[]>;
  jobEnds(ids: readonly string[]): Promise<StatusJobEnd[]>;
  coverage(): Promise<StatusCoverageCounts>;
}

export function gardenerStatusStoreOf(db: Queryable): GardenerStatusStore {
  const status = createGardenerStatusRepository(db);
  const blockers = createJobBlockerRepository(db);
  return {
    taskCounts: (types, scheduledWithinSeconds) => status.taskCounts(types, scheduledWithinSeconds),
    blockedGroups: () => blockers.blockedGroups(),
    runningJobs: (types) => status.runningJobs(types),
    jobEnds: (ids) => status.jobEnds(ids),
    coverage: () => status.coverage()
  };
}

/** The distinct blockers a map of held kinds holds them by (`BackgroundGate.forKinds`). */
export function distinctHolds(held: ReadonlyMap<string, GardenerBlocker>): GardenerBlocker[] {
  const byKey = new Map<string, GardenerBlocker>();
  for (const blocker of held.values()) byKey.set(gardenerBlockerKey(blocker), blocker);
  return [...byKey.values()];
}

/** How many finished tasks the sampler keeps per kind: enough for any configured estimate. */
const keptSamples = 500;

/**
 * Durations of the tasks that ran, per kind (D27: the median of the last 50 gives the time left).
 * The jobs table keeps no start time once a job ends, so the sampler watches the running jobs: it
 * remembers when each was claimed and, once a job stops running, takes the time its row says it
 * finished (a job that did not succeed, set aside or failed, is no sample of the work). A task so
 * short that it starts and ends between two reads is never seen; the kinds that do many such tasks
 * simply have no estimate.
 */
export class JobDurationSampler {
  private readonly running = new Map<string, { type: string; startedMs: number }>();
  private readonly samples = new Map<string, number[]>();

  /** Records the jobs that stopped running since the last call; `ends` tells how each ended. */
  public async observe(
    running: readonly StatusRunningJob[],
    nowMs: number,
    ends: (ids: readonly string[]) => Promise<StatusJobEnd[]>
  ): Promise<void> {
    const current = new Set(running.map((job) => job.id));
    const stopped = [...this.running].filter(([id]) => !current.has(id));
    for (const job of running)
      if (!this.running.has(job.id))
        this.running.set(job.id, { type: job.type, startedMs: job.lockedAt?.getTime() ?? nowMs });
    if (stopped.length === 0) return;
    for (const [id] of stopped) this.running.delete(id);
    for (const end of await ends(stopped.map(([id]) => id))) {
      const started = stopped.find(([id]) => id === end.id)?.[1];
      if (!started || end.status !== "succeeded" || !end.finishedAt) continue;
      this.add(started.type, end.finishedAt.getTime() - started.startedMs);
    }
  }

  /** Adds one duration in milliseconds. */
  public add(type: string, durationMs: number): void {
    if (!Number.isFinite(durationMs) || durationMs < 0) return;
    const list = this.samples.get(type) ?? [];
    list.push(durationMs);
    if (list.length > keptSamples) list.splice(0, list.length - keptSamples);
    this.samples.set(type, list);
  }

  public durations(): Record<string, readonly number[]> {
    return Object.fromEntries(this.samples);
  }
}

export interface GardenerStatusServiceOptions {
  /** The store of the current database; null while there is none. */
  store: () => GardenerStatusStore | null;
  /** The blockers the global gates hold the Gardener kinds by now (pause, autonomy, idle, AC, caps). */
  gateHolds: () => ReadonlyArray<GardenerBlocker>;
  /** The budget's meters now (`RemoteBudget.snapshot`); null when it cannot be read. */
  budget: () => Promise<Pick<BudgetSnapshot, "money"> | null>;
  /** The AI lanes now (`AiService.laneSnapshots`). */
  lanes: () => ReadonlyArray<
    Pick<LaneSnapshot, "lane" | "running" | "waiting" | "pausedForMs" | "breaker" | "failure">
  >;
  /** The statuses of the installed local models (`LocalModelService.listStatuses`). */
  models: () => Promise<ReadonlyArray<{ status: string }>>;
  /** Sends the snapshot to the windows (`gardener.status` on the event bus). */
  publish: (event: Extract<AppEvent, { type: "gardener.status" }>) => void;
  /** The bus the service follows: job progress, the budget's meters and model downloads. */
  events?: {
    subscribe<T extends AppEventType>(type: T, handler: AppEventHandler<T>): () => void;
  };
  /** Other things whose change changes the status: the Knowledge controls, the power signals. */
  signals?: ReadonlyArray<(listener: () => void) => () => void>;
  config?: GardenerStatusConfig;
  /** Wall clock in milliseconds. */
  now?: () => number;
  timers?: {
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
  };
  logger?: Pick<Console, "warn">;
}

const systemTimers = {
  setTimeout: (callback: () => void, ms: number) => {
    const handle = setTimeout(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearTimeout: (handle: unknown) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

/** The lane facts the pure status reads, from the scheduler's snapshot. */
export function laneFactsOf(
  lane: ReturnType<GardenerStatusServiceOptions["lanes"]>[number]
): StatusLaneFacts {
  return {
    lane: lane.lane,
    running: lane.running,
    waiting: Object.values(lane.waiting).reduce((sum, count) => sum + count, 0),
    pausedForMs: lane.pausedForMs,
    breaker: lane.breaker
      ? { state: lane.breaker.state, reopensInMs: lane.breaker.reopensInMs }
      : null,
    failure: lane.failure ?? null
  };
}

export class GardenerStatusService {
  private readonly config: GardenerStatusConfig;
  private readonly now: () => number;
  private readonly timers: NonNullable<GardenerStatusServiceOptions["timers"]>;
  private readonly sampler = new JobDurationSampler();
  private readonly downloads = new Map<string, { status: string; etaSeconds: number | null }>();
  private embeddingLoadingSince: number | null = null;
  private coverageCache: { at: number; value: GardenerStatusCoverage } | null = null;
  private last: GardenerStatusSnapshot | null = null;
  private lastAt = 0;
  private reading: Promise<GardenerStatusSnapshot> | null = null;
  private again = false;
  private touchTimer: unknown = undefined;
  private armTimer: unknown = undefined;
  private unsubscribe: Array<() => void> = [];
  private disposed = false;

  public constructor(private readonly options: GardenerStatusServiceOptions) {
    this.config = options.config ?? defaultGardenerStatusConfig;
    this.now = options.now ?? Date.now;
    this.timers = options.timers ?? systemTimers;
  }

  /** Follows the bus and the signals; every change asks for one coalesced recompute. */
  public start(): void {
    if (this.unsubscribe.length > 0 || this.disposed) return;
    const touch = () => this.touch();
    const { events, signals } = this.options;
    if (events)
      this.unsubscribe.push(
        events.subscribe("job.progress", touch),
        events.subscribe("budget.changed", touch),
        events.subscribe("model.download", (event) => this.noteDownload(event))
      );
    for (const signal of signals ?? []) this.unsubscribe.push(signal(touch));
    this.touch();
  }

  public stop(): void {
    this.disposed = true;
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
    if (this.touchTimer !== undefined) this.timers.clearTimeout(this.touchTimer);
    if (this.armTimer !== undefined) this.timers.clearTimeout(this.armTimer);
    this.touchTimer = undefined;
    this.armTimer = undefined;
  }

  /** The status now: the last one when it is newer than the refresh window, else a new reading. */
  public async snapshot(): Promise<GardenerStatusSnapshot> {
    if (this.last && this.now() - this.lastAt < this.config.refreshWindowMs) return this.last;
    return this.refresh();
  }

  /** The status as last read, without reading; null before the first reading. */
  public current(): GardenerStatusSnapshot | null {
    return this.last;
  }

  /** Something that changes the status changed: recompute once, soon, however many notices come. */
  public touch(): void {
    if (this.disposed || this.touchTimer !== undefined) return;
    this.touchTimer = this.timers.setTimeout(() => {
      this.touchTimer = undefined;
      void this.refresh();
    }, this.config.refreshWindowMs);
  }

  /** A local model's install moved (`model.download`): its time left explains the wait for it. */
  public noteDownload(event: Extract<AppEvent, { type: "model.download" }>): void {
    if (event.status === "downloading" || event.status === "verifying")
      this.downloads.set(event.localModelId, {
        status: event.status,
        etaSeconds: event.status === "downloading" ? event.etaSeconds : null
      });
    else this.downloads.delete(event.localModelId);
    this.touch();
  }

  /** The local embedder is loading into memory, or stopped (`aiLocalEmbeddingLoadStatus`). */
  public noteEmbeddingLoad(state: "loading" | "ready" | "failed"): void {
    this.embeddingLoadingSince = state === "loading" ? this.now() : null;
    this.touch();
  }

  /** Reads the status again now; one reading at a time, one more if a notice came during it. */
  public refresh(): Promise<GardenerStatusSnapshot> {
    if (this.reading) {
      this.again = true;
      return this.reading;
    }
    const reading = (async () => {
      try {
        do {
          this.again = false;
          this.accept(await this.compose());
        } while (this.again && !this.disposed);
      } catch (error) {
        this.options.logger?.warn("The Gardener status could not be read", error);
      }
      return this.last ?? { ...idleGardenerStatus, params: {} };
    })().finally(() => {
      this.reading = null;
    });
    this.reading = reading;
    return reading;
  }

  private accept(reading: GardenerStatusSnapshot): void {
    const next = stableGardenerStatus(this.last, reading);
    const changed = !sameGardenerStatus(this.last, next);
    this.last = next;
    this.lastAt = this.now();
    if (changed && !this.disposed) {
      try {
        this.options.publish({ type: "gardener.status", status: next });
      } catch (error) {
        this.options.logger?.warn("The Gardener status could not be published", error);
      }
    }
    this.arm(next);
  }

  /**
   * Looks again later when the status depends on time: at the time a hold clears, and on the
   * heartbeat while something is happening or held. An idle library with nothing in the way waits
   * for the next event.
   */
  private arm(snapshot: GardenerStatusSnapshot): void {
    if (this.armTimer !== undefined) this.timers.clearTimeout(this.armTimer);
    this.armTimer = undefined;
    if (this.disposed) return;
    const active = snapshot.state !== "idle" || snapshot.class !== undefined;
    let delay = active ? this.config.heartbeatMs : null;
    if (snapshot.eta?.kind === "at") {
      const until = Date.parse(snapshot.eta.at) - this.now() + 1_000;
      delay = delay === null ? until : Math.min(delay, until);
    }
    if (delay === null) return;
    this.armTimer = this.timers.setTimeout(
      () => {
        this.armTimer = undefined;
        void this.refresh();
      },
      Math.max(1_000, delay)
    );
  }

  private async coverage(
    store: GardenerStatusStore,
    nowMs: number
  ): Promise<GardenerStatusCoverage> {
    if (this.coverageCache && nowMs - this.coverageCache.at < this.config.coverageTtlMs)
      return this.coverageCache.value;
    const counts = await store.coverage();
    const value: GardenerStatusCoverage = {
      placed: coverageShare(counts.placedNotes, counts.notes),
      matched: coverageShare(counts.matchedNotes, counts.notes),
      overviewsFresh: coverageShare(counts.freshOverviews, counts.overviews)
    };
    this.coverageCache = { at: nowMs, value };
    return value;
  }

  private async compose(): Promise<GardenerStatusSnapshot> {
    const store = this.options.store();
    const nowMs = this.now();
    if (!store) {
      this.coverageCache = null;
      return { ...idleGardenerStatus, params: {}, coverage: { ...fullGardenerCoverage } };
    }
    const [tasks, blocked, running, budget, models] = await Promise.all([
      store.taskCounts(gardenerStatusKinds, this.config.scheduledWithinMs / 1_000),
      store.blockedGroups(),
      store.runningJobs(gardenerStatusKinds),
      this.options.budget().catch(() => null),
      this.options.models().catch(() => [])
    ]);
    await this.sampler.observe(running, nowMs, (ids) => store.jobEnds(ids));
    const coverage = await this.coverage(store, nowMs);
    const etas = [...this.downloads.values()]
      .map((download) => download.etaSeconds)
      .filter((seconds): seconds is number => seconds !== null);
    const facts: GardenerStatusFacts = {
      nowMs,
      gateHolds: this.options.gateHolds(),
      tasks,
      blocked: blocked.map((group) => ({
        type: group.type,
        blockerClass: group.blockerClass,
        reason: group.reason,
        count: group.count,
        earliestRunAfterMs: group.earliestRunAfter.getTime()
      })),
      lanes: this.options.lanes().map(laneFactsOf),
      downloads: {
        downloading:
          models.some((model) => model.status === "downloading") ||
          [...this.downloads.values()].some((download) => download.status === "downloading"),
        verifying:
          models.some((model) => model.status === "verifying") ||
          [...this.downloads.values()].some((download) => download.status === "verifying"),
        loading:
          this.embeddingLoadingSince !== null &&
          nowMs - this.embeddingLoadingSince < this.config.modelLoadTtlMs,
        etaSeconds: etas.length > 0 ? Math.max(...etas) : null
      },
      budget: budget ? { spentUsd: budget.money.spentUsd, capUsd: budget.money.capUsd } : null,
      durations: this.sampler.durations(),
      coverage
    };
    return composeGardenerStatus(facts, this.config);
  }
}
