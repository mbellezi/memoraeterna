import {
  aiLaneRuntimeConfigSchema,
  defaultAiLaneRuntimeConfig,
  type AiLaneRuntimeConfig
} from "../runtime-config.js";
import { aimdOnOutcome, aimdOnRateLimit } from "./aimd.js";
import { Lane, laneMaximum, type WaitingEntry } from "./lanes.js";
import { selectNext } from "./priority.js";
import type {
  AiPriority,
  AiScheduler,
  LaneKey,
  LaneOutcome,
  LanePermit,
  LaneReservation,
  LaneSnapshot,
  LaneTicket,
  PausableClock,
  SchedulerClock
} from "./types.js";

/** Wall time for the scheduler: a monotonic clock and timers that never keep the process alive. */
export const systemSchedulerClock: SchedulerClock = {
  now: () => performance.now(),
  setTimer: (callback, delayMs) => {
    const timer = setTimeout(callback, Math.max(0, delayMs));
    timer.unref?.();
    return timer;
  },
  clearTimer: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>)
};

/**
 * Creates the lane scheduler an `AiService` owns (F3 D29-D31). It has no module state: services
 * that must share lanes (tests that model one machine) share one instance explicitly.
 */
export function createAiScheduler(
  config: AiLaneRuntimeConfig = defaultAiLaneRuntimeConfig,
  clock: SchedulerClock = systemSchedulerClock
): AiScheduler {
  return new LaneScheduler(aiLaneRuntimeConfigSchema.parse(config), clock);
}

/**
 * The pure core: lanes with bounded, adaptive concurrency; strict P0 and aged P1-P3 selection;
 * FIFO by admission within an effective priority; no preemption. Admissions of the same tick
 * compete, because slots are handed out in a microtask.
 */
export class LaneScheduler implements AiScheduler {
  private readonly lanes = new Map<LaneKey, Lane>();
  private sequence = 0;
  private dispatchQueued = false;

  public constructor(
    private readonly config: AiLaneRuntimeConfig,
    private readonly clock: SchedulerClock = systemSchedulerClock
  ) {}

  public reserve(): LaneReservation {
    return { admittedAt: this.clock.now(), sequence: ++this.sequence };
  }

  public run<T>(ticket: LaneTicket, execute: (permit: LanePermit) => Promise<T>): Promise<T> {
    const signal = ticket.signal;
    if (signal?.aborted) return Promise.reject(signal.reason);
    const lane = this.lane(ticket);
    const reservation = ticket.reservation ?? this.reserve();
    return new Promise<T>((resolve, reject) => {
      const permit = new Permit(this, lane, ticket, reservation);
      const waited = this.wait(lane, ticket, reservation, ticket.pauses ?? []);
      waited.then(
        () => {
          permit.started(this.clock.now());
          if (signal?.aborted) {
            permit.finish();
            reject(signal.reason);
            return;
          }
          let result: Promise<T>;
          try {
            result = Promise.resolve(execute(permit));
          } catch (error) {
            result = Promise.reject(error);
          }
          // The slot is free before the caller resumes, so its telemetry runs off the lane.
          result.then(
            (value) => {
              permit.finish();
              resolve(value);
            },
            (error: unknown) => {
              permit.finish();
              reject(error);
            }
          );
        },
        (error: unknown) => reject(error)
      );
    });
  }

  public observeRateLimit(key: LaneKey, retryAt: number | null): void {
    const lane = this.lanes.get(key);
    if (!lane?.adaptive) return;
    lane.aimd = aimdOnRateLimit(lane.aimd, this.config.lanes);
    if (retryAt !== null) {
      const until = Math.min(retryAt, this.clock.now() + this.config.lanes.maxPauseMs);
      if (until > this.clock.now() && (lane.pausedUntil === null || until > lane.pausedUntil)) {
        lane.pausedUntil = until;
        if (lane.pauseTimer !== undefined) this.clock.clearTimer(lane.pauseTimer);
        lane.pauseTimer = this.clock.setTimer(() => {
          lane.pauseTimer = undefined;
          this.schedule();
        }, until - this.clock.now());
      }
    }
  }

  public observeOutcome(key: LaneKey, outcome: LaneOutcome): void {
    const lane = this.lanes.get(key);
    if (!lane?.adaptive) return;
    const before = lane.aimd.limit;
    lane.aimd = aimdOnOutcome(lane.aimd, outcome, this.config.lanes);
    if (lane.aimd.limit > before) this.schedule();
  }

  public snapshot(): LaneSnapshot[] {
    const now = this.clock.now();
    return [...this.lanes.values()].map((lane) => ({
      lane: lane.key,
      limit: lane.aimd.limit,
      maximum: lane.aimd.maximum,
      running: lane.running,
      held: lane.held,
      waiting: lane.waitingByPriority(),
      pausedForMs:
        lane.pausedUntil !== null && lane.pausedUntil > now ? lane.pausedUntil - now : null,
      successStreak: lane.aimd.streak
    }));
  }

  /** Waits for a slot of the lane; resolves once the slot is counted for the caller. */
  public wait(
    lane: Lane,
    ticket: Pick<LaneTicket, "signal" | "label" | "priority">,
    reservation: LaneReservation,
    pauses: readonly PausableClock[]
  ): Promise<void> {
    const signal = ticket.signal;
    if (signal?.aborted) return Promise.reject(signal.reason);
    return new Promise<void>((resolve, reject) => {
      for (const clock of pauses) clock.pause();
      let resumed = false;
      const resume = () => {
        if (resumed) return;
        resumed = true;
        for (const clock of pauses) clock.resume();
      };
      const entry: WaitingEntry = {
        admittedAt: reservation.admittedAt,
        sequence: reservation.sequence,
        priority: ticket.priority,
        label: ticket.label,
        start: () => {
          signal?.removeEventListener("abort", onAbort);
          resume();
          resolve();
        }
      };
      const onAbort = () => {
        if (!lane.remove(entry)) return;
        resume();
        reject(signal?.reason);
      };
      lane.waiting.push(entry);
      signal?.addEventListener("abort", onAbort, { once: true });
      this.schedule();
    });
  }

  /** Gives one slot of the lane back. */
  public release(lane: Lane): void {
    lane.running = Math.max(0, lane.running - 1);
    this.schedule();
  }

  public now(): number {
    return this.clock.now();
  }

  public observe(lane: Lane, outcome: LaneOutcome): void {
    this.observeOutcome(lane.key, outcome);
  }

  public rateLimited(lane: Lane, retryAfterMs: number | null): void {
    this.observeRateLimit(
      lane.key,
      retryAfterMs === null ? null : this.clock.now() + Math.max(0, retryAfterMs)
    );
  }

  private lane(ticket: LaneTicket): Lane {
    const existing = this.lanes.get(ticket.lane);
    if (existing) return existing;
    const lane = new Lane(ticket.lane, laneMaximum(ticket.lane, ticket.remoteKind, this.config));
    this.lanes.set(ticket.lane, lane);
    return lane;
  }

  private schedule(): void {
    if (this.dispatchQueued) return;
    this.dispatchQueued = true;
    queueMicrotask(() => {
      this.dispatchQueued = false;
      for (const lane of this.lanes.values()) this.fill(lane);
    });
  }

  private fill(lane: Lane): void {
    const now = this.clock.now();
    if (lane.pausedUntil !== null) {
      if (now < lane.pausedUntil) return;
      lane.pausedUntil = null;
    }
    while (lane.running < lane.aimd.limit && lane.waiting.length > 0) {
      const index = selectNext(lane.waiting, now, this.config.aging);
      const [entry] = lane.waiting.splice(index, 1);
      lane.running += 1;
      entry!.start();
    }
  }
}

/** One execution's hold on its lane. */
class Permit implements LanePermit {
  public queueMs = 0;
  public requeueMs = 0;
  public releasedMs = 0;
  private holding = false;
  private finished = false;
  private readonly holds: Promise<unknown>[] = [];

  public constructor(
    private readonly scheduler: LaneScheduler,
    private readonly laneState: Lane,
    private readonly ticket: LaneTicket,
    private readonly reservation: LaneReservation
  ) {}

  public get lane(): LaneKey {
    return this.laneState.key;
  }

  public get priority(): AiPriority {
    return this.ticket.priority;
  }

  public get workloadClass(): LaneTicket["workloadClass"] {
    return this.ticket.workloadClass;
  }

  public started(at: number): void {
    this.holding = true;
    this.queueMs = Math.max(0, Math.round(at - this.reservation.admittedAt));
  }

  public async releaseDuring<T>(
    wait: () => Promise<T>,
    options: { pause?: readonly PausableClock[] } = {}
  ): Promise<T> {
    if (!this.holding || this.finished) return wait();
    this.holding = false;
    this.scheduler.release(this.laneState);
    const releasedAt = this.scheduler.now();
    let value: T;
    try {
      value = await wait();
    } finally {
      this.releasedMs += Math.max(0, Math.round(this.scheduler.now() - releasedAt));
    }
    const waitingAt = this.scheduler.now();
    await this.scheduler.wait(this.laneState, this.ticket, this.reservation, [
      ...(this.ticket.pauses ?? []),
      ...(options.pause ?? [])
    ]);
    this.requeueMs += Math.max(0, Math.round(this.scheduler.now() - waitingAt));
    if (this.finished) {
      this.scheduler.release(this.laneState);
    } else {
      this.holding = true;
    }
    return value;
  }

  public holdUntil(until: Promise<unknown>): void {
    this.holds.push(until.catch(() => undefined));
  }

  public observeRateLimit(retryAfterMs: number | null): void {
    this.scheduler.rateLimited(this.laneState, retryAfterMs);
  }

  public observeOutcome(outcome: LaneOutcome): void {
    this.scheduler.observe(this.laneState, outcome);
  }

  /** The execution settled: the slot goes back now, or once every hold settled. */
  public finish(): void {
    if (this.finished) return;
    this.finished = true;
    if (!this.holding) return;
    this.holding = false;
    if (this.holds.length === 0) {
      this.scheduler.release(this.laneState);
      return;
    }
    this.laneState.held += 1;
    void Promise.all(this.holds).then(() => {
      this.laneState.held -= 1;
      this.scheduler.release(this.laneState);
    });
  }
}
