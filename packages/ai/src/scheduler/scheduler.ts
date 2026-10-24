import {
  aiLaneRuntimeConfigSchema,
  defaultAiLaneRuntimeConfig,
  type AiLaneRuntimeConfig
} from "../runtime-config.js";
import { aimdOnOutcome, aimdOnRateLimit } from "./aimd.js";
import { CircuitBreaker, ProviderUnavailableError, type BreakerTransition } from "./breaker.js";
import { DutyCycleHold } from "./duty-cycle.js";
import { Lane, laneMaximum, type WaitingEntry } from "./lanes.js";
import { selectNext } from "./priority.js";
import type {
  AiPriority,
  AiScheduler,
  LaneAdmission,
  LaneFailureKind,
  LaneKey,
  LaneOutcome,
  LanePermit,
  LaneRefusal,
  LaneRefusalTarget,
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

/** What the owner of a scheduler wants to hear about; a throwing hook never fails the scheduler. */
export interface AiSchedulerHooks {
  /** A remote lane's circuit breaker changed state (F3 D32). */
  onBreakerTransition?: (lane: LaneKey, transition: BreakerTransition) => void;
  /**
   * The admission hook (F4 D7): called once for each new entry, before it waits for its lane and
   * before a half-open breaker hands it the probe. A returned error rejects the entry at once (the
   * Gardener's gates hold a background call); `undefined` or `null` admits it. A throwing hook
   * rejects the entry with what it threw. The re-wait of a running call between two attempts is no
   * new admission.
   */
  admit?: (entry: LaneAdmission) => unknown;
  /**
   * The share of the local lane background calls may take now, in (0, 1] (F4 D15): after a
   * background call of duration d, background entries wait d × (1/duty − 1). Left out, or 1, nothing
   * waits. User and interactive entries never wait for it.
   */
  backgroundDutyCycle?: () => number;
}

/**
 * Creates the lane scheduler an `AiService` owns (F3 D29-D31). It has no module state: services
 * that must share lanes (tests that model one machine) share one instance explicitly.
 */
export function createAiScheduler(
  config: AiLaneRuntimeConfig = defaultAiLaneRuntimeConfig,
  clock: SchedulerClock = systemSchedulerClock,
  hooks: AiSchedulerHooks = {}
): AiScheduler {
  return new LaneScheduler(aiLaneRuntimeConfigSchema.parse(config), clock, hooks);
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
  /** The local lane's duty-cycle hold of background entries; null without a duty cycle. */
  private readonly dutyHold: DutyCycleHold | null;

  public constructor(
    private readonly config: AiLaneRuntimeConfig,
    private readonly clock: SchedulerClock = systemSchedulerClock,
    private readonly hooks: AiSchedulerHooks = {}
  ) {
    const duty = hooks.backgroundDutyCycle;
    this.dutyHold = duty ? new DutyCycleHold(duty) : null;
  }

  public reserve(): LaneReservation {
    return { admittedAt: this.clock.now(), sequence: ++this.sequence };
  }

  public run<T>(ticket: LaneTicket, execute: (permit: LanePermit) => Promise<T>): Promise<T> {
    const signal = ticket.signal;
    if (signal?.aborted) return Promise.reject(signal.reason);
    const refusal = this.admission(ticket);
    if (refusal !== undefined) return Promise.reject(refusal);
    const lane = this.lane(ticket);
    // An open breaker fails the entry at once; a half-open one lets exactly one entry probe.
    const admission = lane.breaker?.admit(this.clock.now());
    if (admission?.kind === "refuse")
      return Promise.reject(
        new ProviderUnavailableError(lane.key, admission.retryAfterMs, {
          breaker: admission.state,
          failure: lane.failure?.kind
        })
      );
    const reservation = ticket.reservation ?? this.reserve();
    return new Promise<T>((resolve, reject) => {
      const permit = new Permit(
        this,
        lane,
        ticket,
        reservation,
        admission?.kind === "probe" ? admission.token : undefined
      );
      const waited = this.wait(lane, ticket, reservation, ticket.pauses ?? [], true);
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
        (error: unknown) => {
          permit.finish();
          reject(error);
        }
      );
    });
  }

  public refresh(): void {
    this.schedule();
  }

  public observeRateLimit(key: LaneKey, retryAt: number | null): void {
    const lane = this.lanes.get(key);
    if (!lane?.adaptive) return;
    lane.rateLimits += 1;
    lane.aimd = aimdOnRateLimit(lane.aimd, this.config.lanes);
    if (retryAt !== null) {
      const now = this.clock.now();
      const until = Math.min(retryAt, now + this.config.lanes.maxPauseMs);
      if (until > now && (lane.pausedUntil === null || until > lane.pausedUntil)) {
        lane.pausedUntil = until;
        this.armPauseTimer(lane, now);
      }
    }
  }

  public observeOutcome(key: LaneKey, outcome: LaneOutcome, failure?: LaneFailureKind): void {
    const lane = this.lanes.get(key);
    if (lane) this.record(lane, outcome, undefined, failure);
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
      successStreak: lane.aimd.streak,
      rateLimits: lane.rateLimits,
      breaker: lane.breaker?.snapshot(now) ?? null,
      failure: lane.failure
        ? { kind: lane.failure.kind, ageMs: Math.max(0, Math.round(now - lane.failure.at)) }
        : null
    }));
  }

  /** Waits for a slot of the lane; resolves once the slot is counted for the caller. */
  public wait(
    lane: Lane,
    ticket: Pick<LaneTicket, "signal" | "label" | "priority" | "workloadClass" | "budgetClass">,
    reservation: LaneReservation,
    pauses: readonly PausableClock[],
    fresh = false
  ): Promise<void> {
    const signal = ticket.signal;
    if (signal?.aborted) return Promise.reject(signal.reason);
    const refusal = lane.refusals.at(-1);
    if (refusal) return Promise.reject(refusalError(refusal, ticket));
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
        workloadClass: ticket.workloadClass,
        budgetClass: ticket.budgetClass,
        fresh,
        start: () => {
          signal?.removeEventListener("abort", onAbort);
          resume();
          resolve();
        },
        refuse: (error) => {
          signal?.removeEventListener("abort", onAbort);
          resume();
          reject(error);
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

  /** Fails the lane's waiting entries, and its new ones until the returned function lifts it. */
  public refuse(lane: Lane, refusal: LaneRefusal): () => void {
    lane.refusals.push(refusal);
    for (const entry of lane.waiting.splice(0)) entry.refuse(refusalError(refusal, entry));
    return () => {
      const index = lane.refusals.indexOf(refusal);
      if (index >= 0) lane.refusals.splice(index, 1);
    };
  }

  /** Gives one slot of the lane back. */
  public release(lane: Lane): void {
    lane.running = Math.max(0, lane.running - 1);
    this.schedule();
  }

  public now(): number {
    return this.clock.now();
  }

  /** A background call held a slot of the lane for `durationMs` until now (F4 D15). */
  public backgroundSettled(lane: Lane, durationMs: number): void {
    if (lane.key !== "local" || !this.dutyHold) return;
    this.dutyHold.settled(this.clock.now(), durationMs);
  }

  /** The admission hook's verdict on a new entry: the error to reject it with, or undefined. */
  private admission(ticket: LaneTicket): unknown {
    const admit = this.hooks.admit;
    if (!admit) return undefined;
    try {
      const refusal = admit({
        lane: ticket.lane,
        priority: ticket.priority,
        workloadClass: ticket.workloadClass,
        budgetClass: ticket.budgetClass,
        label: ticket.label,
        jobId: ticket.jobId
      });
      return refusal ?? undefined;
    } catch (error) {
      return error ?? new Error("scheduler_admission_refused");
    }
  }

  /**
   * One response's outcome on a lane; `probe` is the token of a half-open breaker's probe. A failure
   * that names how the provider failed is remembered for the status; any other response, a success
   * or a rejected request, shows the provider answers and forgets it (F4 D27).
   */
  public record(lane: Lane, outcome: LaneOutcome, probe?: number, failure?: LaneFailureKind): void {
    if (!lane.adaptive) return;
    const now = this.clock.now();
    if (outcome !== "ok" && failure !== undefined) lane.failure = { kind: failure, at: now };
    // As for the breaker, a call already running when the provider failed says nothing of the
    // present: only the probe's answer, or any answer while the breaker is closed, clears it.
    else if (
      lane.breaker === null ||
      probe !== undefined ||
      lane.breaker.snapshot(now).state === "closed"
    )
      lane.failure = null;
    const before = lane.aimd.limit;
    lane.aimd = aimdOnOutcome(lane.aimd, outcome, this.config.lanes);
    lane.breaker?.record(outcome, this.clock.now(), probe);
    if (lane.aimd.limit > before) this.schedule();
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
    if (lane.adaptive)
      lane.breaker = new CircuitBreaker(this.config.breaker, (transition) =>
        this.breakerMoved(lane, transition)
      );
    this.lanes.set(ticket.lane, lane);
    return lane;
  }

  /**
   * An opening breaker fails the entries already waiting for the lane, as it fails new ones: they
   * would otherwise run into the outage one after the other. Calls that already started, and the
   * re-wait of a call between two attempts, are left to finish.
   */
  private breakerMoved(lane: Lane, transition: BreakerTransition): void {
    if (transition.to === "open") {
      const failed = lane.waiting.filter((entry) => entry.fresh);
      for (const entry of failed) {
        lane.remove(entry);
        entry.refuse(
          new ProviderUnavailableError(lane.key, this.config.breaker.openMs, {
            breaker: "open",
            failure: lane.failure?.kind
          })
        );
      }
      lane.breaker?.countRefused(failed.length);
    }
    try {
      this.hooks.onBreakerTransition?.(lane.key, transition);
    } catch {
      // A listener never fails the scheduler.
    }
  }

  private schedule(): void {
    if (this.dispatchQueued) return;
    this.dispatchQueued = true;
    queueMicrotask(() => {
      this.dispatchQueued = false;
      for (const lane of this.lanes.values()) this.fill(lane);
    });
  }

  /** (Re)arms the timer that ends the lane's pause. */
  private armPauseTimer(lane: Lane, now: number): void {
    if (lane.pauseTimer !== undefined) this.clock.clearTimer(lane.pauseTimer);
    lane.pauseTimer = this.clock.setTimer(() => {
      lane.pauseTimer = undefined;
      this.schedule();
    }, lane.pausedUntil! - now);
  }

  private fill(lane: Lane): void {
    const now = this.clock.now();
    if (lane.pausedUntil !== null) {
      if (now < lane.pausedUntil) {
        // Timers run on the event loop's cached time and may fire before the clock reaches the
        // reset: the pause then needs a timer for what is left, or the lane would never resume.
        if (lane.pauseTimer === undefined) this.armPauseTimer(lane, now);
        return;
      }
      lane.pausedUntil = null;
    }
    const heldUntil = lane.key === "local" ? (this.dutyHold?.heldUntil() ?? null) : null;
    const held = heldUntil !== null && now < heldUntil;
    while (lane.running < lane.aimd.limit && lane.waiting.length > 0) {
      // While the duty cycle holds background entries, the slot goes to the best other entry.
      const candidates = held
        ? lane.waiting.filter((entry) => entry.budgetClass !== "background")
        : lane.waiting;
      if (candidates.length === 0) break;
      const entry = candidates[selectNext(candidates, now, this.config.aging)]!;
      lane.remove(entry);
      lane.running += 1;
      entry.start();
    }
    if (held && lane.waiting.some((entry) => entry.budgetClass === "background"))
      this.armDutyTimer(lane, heldUntil, now);
  }

  /** (Re)arms the timer that ends the duty-cycle hold of the lane's background entries. */
  private armDutyTimer(lane: Lane, until: number, now: number): void {
    if (lane.dutyTimer !== undefined) this.clock.clearTimer(lane.dutyTimer);
    lane.dutyTimer = this.clock.setTimer(() => {
      lane.dutyTimer = undefined;
      this.schedule();
    }, until - now);
  }
}

/** One execution's hold on its lane. */
class Permit implements LanePermit {
  public queueMs = 0;
  public requeueMs = 0;
  public releasedMs = 0;
  /** When the execution started on the lane; null while it never did. */
  private startedAt: number | null = null;
  private holding = false;
  private finished = false;
  private readonly holds: Promise<unknown>[] = [];
  private refusal: LaneRefusal | undefined;

  public constructor(
    private readonly scheduler: LaneScheduler,
    private readonly laneState: Lane,
    private readonly ticket: LaneTicket,
    private readonly reservation: LaneReservation,
    /** The token of the half-open breaker's probe this permit is, if it is. */
    private readonly probe?: number
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
    this.startedAt = at;
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

  public holdUntil(until: Promise<unknown>, options: { refuse?: LaneRefusal } = {}): void {
    this.holds.push(until.catch(() => undefined));
    if (options.refuse) this.refusal = options.refuse;
  }

  public observeRateLimit(retryAfterMs: number | null): void {
    this.scheduler.rateLimited(this.laneState, retryAfterMs);
  }

  public observeOutcome(outcome: LaneOutcome, failure?: LaneFailureKind): void {
    this.scheduler.record(this.laneState, outcome, this.probe, failure);
  }

  /** The execution settled: the slot goes back now, or once every hold settled. */
  public finish(): void {
    if (this.finished) return;
    this.finished = true;
    // A background call that ran holds the next background entries back by its own time (D15).
    if (this.ticket.budgetClass === "background" && this.startedAt !== null)
      this.scheduler.backgroundSettled(
        this.laneState,
        this.scheduler.now() - this.startedAt - this.releasedMs
      );
    // A probe that ended without an answer (cancelled, or it failed before any request) frees the
    // breaker for the next entry.
    if (this.probe !== undefined) this.laneState.breaker?.settleProbe(this.probe);
    if (!this.holding) return;
    this.holding = false;
    if (this.holds.length === 0) {
      this.scheduler.release(this.laneState);
      return;
    }
    this.laneState.held += 1;
    const lift = this.refusal ? this.scheduler.refuse(this.laneState, this.refusal) : undefined;
    void Promise.all(this.holds).then(() => {
      lift?.();
      this.laneState.held -= 1;
      this.scheduler.release(this.laneState);
    });
  }
}

/** The error a refusing lane fails an entry with; a throwing refusal fails it with what it threw. */
function refusalError(refusal: LaneRefusal, entry: LaneRefusalTarget): unknown {
  try {
    return refusal({
      priority: entry.priority,
      workloadClass: entry.workloadClass,
      label: entry.label
    });
  } catch (error) {
    return error;
  }
}
