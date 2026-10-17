import type { JobRecord, JsonObject } from "@app/db";

/**
 * The light lane's three workers. `compute` runs the light jobs that make no model call and `model`
 * the topic jobs that do, so a job waiting for the AI slot never holds up placement or projection.
 * `relations` runs the link jobs of relations v2 (F3 D24): they type and judge on their own AI
 * lanes, so they never wait behind a topic model call, nor hold one up.
 */
export type LightWorker = "compute" | "model" | "relations";

export const lightWorkers: readonly LightWorker[] = ["compute", "model", "relations"];

export interface LightJobExecutor {
  /** True when the job calls a model; it then runs on the `model` worker, else on `compute`. */
  needsModel: boolean;
  /** A worker of its own instead (the `relations` worker of the link jobs, D24). */
  worker?: LightWorker;
  /** While true the type is not claimed: its queued jobs wait, none is dropped (D23 barrier). */
  held?: () => boolean;
  execute: (job: JobRecord, signal: AbortSignal) => Promise<JsonObject>;
  /**
   * Called once a job has ended for good without a result: failed with no attempt left, or
   * canceled. The work the job owned (the runs a link job completes) is settled here.
   */
  ended?: (job: JobRecord, error: unknown, canceled: boolean) => Promise<void>;
}

/** Light job types and their executors; a type runs in the light lane only. */
export type LightJobRegistry = Readonly<Record<string, LightJobExecutor>>;

/** The worker a light job type runs on. */
export function lightWorkerOf(executor: LightJobExecutor): LightWorker {
  return executor.worker ?? (executor.needsModel ? "model" : "compute");
}

/** Splits the registry into the workers' disjoint type sets, in name order. */
export function lightWorkerTypes(
  registry: LightJobRegistry
): Readonly<Record<LightWorker, readonly string[]>> {
  const types: Record<LightWorker, string[]> = { compute: [], model: [], relations: [] };
  for (const type of Object.keys(registry).sort()) types[lightWorkerOf(registry[type]!)].push(type);
  return types;
}

export interface JobLoopOptions {
  /** Claims and runs at most one job; resolves true when it ran one. */
  pass: () => Promise<boolean>;
  /** Runs after a pass that found nothing to do. */
  onIdle?: () => Promise<void>;
  pollIntervalMs: number;
  onError: (error: unknown) => void;
}

/**
 * One worker: one pass at a time, the next pass at once after a pass that ran a job, otherwise
 * after the poll interval. A wake during a pass is kept for the moment that pass ends.
 */
export class JobLoop {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private drainPromise: Promise<void> | null = null;
  private nextDelay: number | null = null;
  private active = false;
  private working = false;

  public constructor(private readonly options: JobLoopOptions) {}

  /** True while a pass runs and after a pass that ran a job, until a pass finds nothing. */
  public get busy(): boolean {
    return this.working;
  }

  public start(): void {
    this.active = true;
    this.schedule(0);
  }

  /** Stops scheduling at once and resolves when the pass in progress, if any, has ended. */
  public async stop(): Promise<void> {
    this.active = false;
    this.nextDelay = null;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    await this.drainPromise;
  }

  /** Resolves when the pass in progress, if any, has ended. */
  public async settled(): Promise<void> {
    await this.drainPromise;
  }

  public wake(): void {
    this.schedule(0);
  }

  private schedule(delay: number): void {
    if (!this.active) return;
    if (this.drainPromise) {
      this.nextDelay = Math.min(this.nextDelay ?? delay, delay);
      return;
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.drainPromise = this.drain()
        .catch((error: unknown) => this.options.onError(error))
        .finally(() => {
          this.drainPromise = null;
          const next = this.nextDelay;
          this.nextDelay = null;
          if (next !== null) this.schedule(next);
        });
    }, delay);
  }

  private async drain(): Promise<void> {
    if (!this.active) return;
    let delay = this.options.pollIntervalMs;
    this.working = true;
    try {
      let ranJob = false;
      try {
        ranJob = await this.options.pass();
      } finally {
        this.working = ranJob;
      }
      if (ranJob) delay = 0;
      else await this.options.onIdle?.();
    } finally {
      // A failed admission, database read or idle cleanup must not stop polling.
      this.schedule(delay);
    }
  }
}
