import type { JobRecord } from "@app/db";
import {
  blockerClearAt,
  defaultGardenerConfig,
  gardenerBlockerClearing,
  gardenerBlockerKey,
  gardenerBlockerKeys,
  gardenerKindPolicies,
  gardenerReasonsClearedBy,
  gardenerTimeClearedReasons,
  type GardenerBlocker,
  type GardenerBlockerKey,
  type GardenerClearingEvent,
  type GardenerConfig
} from "@app/domain";

import type { BackgroundGate } from "./background-gate.js";

/** The blocker writes the service needs (`createJobBlockerRepository` over the 0060 columns). */
export interface JobBlockerStore {
  stampGateBlocks(
    stamps: ReadonlyArray<{ type: string; blocker: Pick<GardenerBlocker, "class" | "reason"> }>,
    gateReasons: readonly GardenerBlockerKey[]
  ): Promise<number>;
  clearBlocks(input: {
    reasons: readonly GardenerBlockerKey[];
    dueOnly?: boolean;
    exceptTypes?: readonly string[];
  }): Promise<{ cleared: number; types: string[] }>;
  blockTask(input: {
    jobId: string;
    blocker: Pick<GardenerBlocker, "class" | "reason">;
    runAfter?: Date | null;
    dedupeKey?: string | null;
  }): Promise<boolean>;
}

/** What the service listens to: the controls and the machine's activity and power. */
export interface BlockerSignals {
  /** Calls the listener with the names of the controls that changed. */
  subscribeControls(listener: (changed: readonly string[]) => void): () => void;
  subscribePower(listener: () => void): () => void;
  /** Reads the controls again when the database changed (a restore, a reset). */
  refreshControls(): Promise<unknown>;
}

export interface BlockerServiceOptions {
  /** The store of the current database; null while there is none. */
  store: () => JobBlockerStore | null;
  gate: BackgroundGate;
  signals: BlockerSignals;
  /** Wakes the workers of these job types: rows were cleared or set free. */
  wake: (types: readonly string[]) => void;
  /** The generation of the AI configuration: a move means routes, sign-ins or models changed. */
  routesGeneration?: () => number;
  config?: GardenerConfig;
  /** Wall clock. */
  now?: () => Date;
  timers?: {
    setInterval(callback: () => void, ms: number): unknown;
    clearInterval(handle: unknown): void;
  };
  logger?: Pick<Console, "warn">;
}

const systemTimers = {
  setInterval: (callback: () => void, ms: number) => {
    const handle = setInterval(callback, ms);
    handle.unref?.();
    return handle;
  },
  clearInterval: (handle: unknown) => clearInterval(handle as ReturnType<typeof setInterval>)
};

/** Every Gardener kind: the types the gates can hold. */
const gardenerKinds = Object.keys(gardenerKindPolicies).sort();

/** The local day and month of a time, for the daily and monthly rollovers. */
function localDay(date: Date): string {
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * The blocked rows' lifecycle (F4 D7, R18): it stamps the rows of the kinds a global gate holds
 * (their claim already leaves them out), clears exactly the rows of a reason when its clearing
 * event comes (resume, a control or the power changing, routes or a model ready, a download
 * settled, the day or month rolling over, a reset time passing, the network back) and, at
 * startup, re-gates every blocked row before the workers start, so no row stays blocked by a
 * condition that ended while the app was closed. It never burns an attempt: a per-task block
 * gives the claim's attempt back.
 */
export class BlockerService {
  private readonly config: GardenerConfig;
  private readonly now: () => Date;
  private readonly timers: NonNullable<BlockerServiceOptions["timers"]>;
  private queue: Promise<unknown> = Promise.resolve();
  private timer: unknown = undefined;
  private unsubscribe: Array<() => void> = [];
  private day: string;
  private month: string;
  private routesSeen: number | undefined;

  public constructor(private readonly options: BlockerServiceOptions) {
    this.config = options.config ?? defaultGardenerConfig;
    this.now = options.now ?? (() => new Date());
    this.timers = options.timers ?? systemTimers;
    const today = localDay(this.now());
    this.day = today;
    this.month = today.slice(0, 7);
    this.routesSeen = options.routesGeneration?.();
  }

  /** Listens to the controls and the power signals, and ticks every `tickMs`. */
  public start(): void {
    if (this.timer !== undefined) return;
    this.unsubscribe = [
      this.options.signals.subscribeControls((changed) => void this.controlsChanged(changed)),
      this.options.signals.subscribePower(() => void this.notify("power_changed"))
    ];
    this.timer = this.timers.setInterval(() => void this.tick(), this.config.blockers.tickMs);
  }

  public stop(): void {
    if (this.timer !== undefined) this.timers.clearInterval(this.timer);
    this.timer = undefined;
    for (const unsubscribe of this.unsubscribe.splice(0)) unsubscribe();
  }

  /**
   * The controls changed: the monthly cap clears money-capped rows (`cap_changed`); any other
   * control clears the rows of the reasons it holds by (`controls_changed`). A pause, an autonomy
   * or a power option toggled never sets a money-capped task free.
   */
  private async controlsChanged(changed: readonly string[]): Promise<void> {
    if (changed.includes("monthlyCapUsd")) await this.notify("cap_changed");
    if (changed.some((field) => field !== "monthlyCapUsd")) await this.notify("controls_changed");
  }

  /**
   * The startup re-gate (D7), before the workers start: rows held by a gate are kept only while
   * it still holds them; time-bound waits are kept until their `run_after`; every other blocked row
   * is set free, so its task meets its blocker again if the condition still holds (its event may
   * have come while the app was closed). Then the held kinds' rows are stamped.
   */
  public regate(): Promise<void> {
    return this.serial(async (store) => {
      await this.options.signals.refreshControls();
      const evaluated = new Set(this.options.gate.evaluatedReasons());
      const eventOnly = gardenerBlockerKeys.filter(
        (key) => !evaluated.has(key) && !gardenerBlockerClearing[key].atRunAfter
      );
      const freed = await store.clearBlocks({ reasons: eventOnly });
      const due = await store.clearBlocks({
        reasons: gardenerTimeClearedReasons.filter((key) => !evaluated.has(key)),
        dueOnly: true
      });
      const gated = await this.reconcileWith(store);
      this.wake([...freed.types, ...due.types, ...gated]);
    });
  }

  /**
   * Re-gates the rows the gates evaluate: clears the rows of reasons that hold nothing any more,
   * then stamps the queued rows of the kinds held now.
   */
  public reconcile(): Promise<void> {
    return this.serial(async (store) => this.wake(await this.reconcileWith(store)));
  }

  /**
   * A clearing event (D7): clears exactly the rows of its reasons, except those a gate still holds
   * by that reason, then re-gates. Never throws.
   */
  public notify(event: GardenerClearingEvent): Promise<void> {
    return this.serial(async (store) => {
      const active = this.options.gate.activeReasons(gardenerKinds);
      const reasons = gardenerReasonsClearedBy(event).filter((key) => !active.has(key));
      const cleared = await store.clearBlocks({ reasons });
      const gated = await this.reconcileWith(store);
      this.wake([...cleared.types, ...gated]);
    });
  }

  /**
   * One tick: the controls read again when the database changed, the day and month rollovers,
   * a moved AI configuration, the time-bound waits whose `run_after` passed, and a re-gate that
   * stamps rows queued since the last one.
   */
  public async tick(): Promise<void> {
    try {
      await this.options.signals.refreshControls();
    } catch (error) {
      this.options.logger?.warn("The Knowledge controls could not be read", error);
    }
    const today = localDay(this.now());
    if (today.slice(0, 7) !== this.month) {
      this.month = today.slice(0, 7);
      await this.notify("month_rollover");
    }
    if (today !== this.day) {
      this.day = today;
      await this.notify("day_rollover");
    }
    const routes = this.options.routesGeneration?.();
    if (routes !== this.routesSeen) {
      this.routesSeen = routes;
      await this.notify("routes_changed");
    }
    await this.serial(async (store) => {
      const due = await store.clearBlocks({ reasons: gardenerTimeClearedReasons, dueOnly: true });
      const gated = await this.reconcileWith(store);
      this.wake([...due.types, ...gated]);
    });
  }

  /**
   * Returns a task that met a blocker after its claim to the queue (D7), its attempt given back
   * and the dedupe key its claim took restored (merged into a queued duplicate that holds it now);
   * it runs again once the blocker clears: at `clearsAt` when known, at the next probe for a
   * time-bound wait, else on the reason's clearing event, with the task model's recheck
   * (`blockerClearAt`) as the bound when that event never comes.
   */
  public async blockTask(job: JobRecord, blocker: GardenerBlocker): Promise<boolean> {
    const store = this.options.store();
    if (!store) return false;
    const key = gardenerBlockerKey(blocker);
    const now = this.now();
    const runAfter =
      typeof blocker.clearsAt === "number" && blocker.clearsAt > now.getTime()
        ? new Date(blocker.clearsAt)
        : gardenerBlockerClearing[key].atRunAfter
          ? new Date(now.getTime() + this.config.blockers.recheckMs)
          : blockerClearAt(blocker, now);
    return store.blockTask({
      jobId: job.id,
      blocker,
      runAfter,
      dedupeKey: job.claimedDedupeKey ?? job.dedupeKey
    });
  }

  private async reconcileWith(store: JobBlockerStore): Promise<string[]> {
    const gate = this.options.gate;
    const evaluated = gate.evaluatedReasons();
    const active = gate.activeReasons(gardenerKinds);
    const cleared = await store.clearBlocks({
      reasons: evaluated.filter((key) => !active.has(key))
    });
    const held = gate.forKinds(gardenerKinds);
    await store.stampGateBlocks(
      [...held].map(([type, blocker]) => ({ type, blocker })),
      evaluated
    );
    return cleared.types;
  }

  private wake(types: readonly string[]): void {
    if (types.length === 0) return;
    try {
      this.options.wake([...new Set(types)].sort());
    } catch (error) {
      this.options.logger?.warn("The job workers could not be woken", error);
    }
  }

  /** Runs one store operation after the previous one; a failure is logged, never thrown. */
  private serial(work: (store: JobBlockerStore) => Promise<void>): Promise<void> {
    const next = this.queue.then(async () => {
      const store = this.options.store();
      if (!store) return;
      try {
        await work(store);
      } catch (error) {
        this.options.logger?.warn("Blocked background tasks could not be updated", error);
      }
    });
    this.queue = next;
    return next;
  }
}
