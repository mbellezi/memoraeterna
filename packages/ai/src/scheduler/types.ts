import type { AiWorkloadClass } from "../contracts.js";

/** `local` (every local runtime, one call at a time) or one lane per remote provider configuration. */
export type LaneKey = "local" | `remote:${string}`;

/** What sets a remote lane's maximum: an API-key provider or a ChatGPT/Codex OAuth profile. */
export type RemoteLaneKind = "api-key" | "codex";

/**
 * P0 interactive (strict, first, never aged into); P1 an interactive import and its link job; P2
 * ingestion and linking; P3 maintenance (F3 D30).
 */
export const aiPriorities = ["P0", "P1", "P2", "P3"] as const;
export type AiPriority = (typeof aiPriorities)[number];

/** Time and timers of the scheduler, injected so tests run on a fake clock. */
export interface SchedulerClock {
  now(): number;
  setTimer(callback: () => void, delayMs: number): unknown;
  clearTimer(handle: unknown): void;
}

/** A clock that stops while its owner waits for a lane, such as a caller's `ActiveDeadline`. */
export interface PausableClock {
  pause(): void;
  resume(): void;
}

/** An admission: its time and order decide aging and FIFO, also for a retried attempt. */
export interface LaneReservation {
  readonly admittedAt: number;
  readonly sequence: number;
}

export interface LaneTicket {
  lane: LaneKey;
  /** The kind of a remote lane, which sets its maximum; ignored for the local lane. */
  remoteKind?: RemoteLaneKind | undefined;
  priority: AiPriority;
  workloadClass: AiWorkloadClass;
  /** Cancels the entry while it waits; a running execution settles on its own. */
  signal?: AbortSignal | undefined;
  /** What the entry is, for snapshots. */
  label: string;
  /** An admission reserved before the lane was known; the call's own admission otherwise. */
  reservation?: LaneReservation | undefined;
  /** Clocks that stand still while the entry waits for the lane, also when it waits again. */
  pauses?: readonly PausableClock[] | undefined;
}

export type LaneOutcome = "ok" | "transient" | "permanent";

/** A running execution's hold on a lane slot. */
export interface LanePermit {
  readonly lane: LaneKey;
  readonly priority: AiPriority;
  readonly workloadClass: AiWorkloadClass;
  /** Admission to execution start: the wait for the lane, preparation included. */
  readonly queueMs: number;
  /** Time spent waiting for the lane again after retry backoffs; excluded from deadlines. */
  readonly requeueMs: number;
  /** Time spent inside {@link LanePermit.releaseDuring} waits (retry backoffs), off the lane. */
  readonly releasedMs: number;
  /**
   * Gives the slot up while `wait` runs (a retry backoff), then waits for the lane again with the
   * original admission, so the retried attempt keeps its age. The ticket's clocks and `pause` stand
   * still from the end of `wait` until the lane is acquired again. When `wait` or the new wait
   * rejects, the permit holds no slot any more and the execution must end.
   */
  releaseDuring<T>(
    wait: () => Promise<T>,
    options?: { pause?: readonly PausableClock[] }
  ): Promise<T>;
  /** Keeps the slot after the execution settles until `until` settles (a wedged local runtime). */
  holdUntil(until: Promise<unknown>): void;
  /** A rate limit: halves a remote lane's limit and pauses it for `retryAfterMs` when stated. */
  observeRateLimit(retryAfterMs: number | null): void;
  /** One response's outcome: successes raise a remote lane's limit, transient failures reset. */
  observeOutcome(outcome: LaneOutcome): void;
}

export interface LaneSnapshot {
  readonly lane: LaneKey;
  readonly limit: number;
  readonly maximum: number;
  /** Slots in use, held ones included. */
  readonly running: number;
  /** Slots kept after their execution settled (a wedged local runtime). */
  readonly held: number;
  readonly waiting: Readonly<Record<AiPriority, number>>;
  /** Milliseconds the lane stays paused by a rate limit; null when it is not paused. */
  readonly pausedForMs: number | null;
  readonly successStreak: number;
}

export interface AiScheduler {
  /** Reserves an admission now, for a call whose lane is known only after its route is read. */
  reserve(): LaneReservation;
  /**
   * Runs `execute` once the ticket's lane grants a slot: P0 first in admission order, then the
   * lowest effective priority (with aging), FIFO within it. Nothing preempts a running call; the
   * slot is released when the execution settles, before the returned promise settles.
   */
  run<T>(ticket: LaneTicket, execute: (permit: LanePermit) => Promise<T>): Promise<T>;
  /** AIMD decrease and pause of a remote lane until `retryAt` (scheduler clock), when known. */
  observeRateLimit(lane: LaneKey, retryAt: number | null): void;
  /** AIMD increase after consecutive successes; a transient failure resets the streak. */
  observeOutcome(lane: LaneKey, outcome: LaneOutcome): void;
  snapshot(): LaneSnapshot[];
}
