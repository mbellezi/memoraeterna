import type { BudgetClass } from "@app/domain";

import type { AiWorkloadClass } from "../contracts.js";
import type { BreakerSnapshot } from "./breaker.js";

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

/**
 * Whose call it is (F4 D14, D15): `user` (an import the user started, with its own link job),
 * `background` (the Gardener) or `interactive` (the user waits for the answer). The local lane's duty
 * cycle and the Gardener's gates hold background calls only, whatever their priority: P2 also
 * carries ordinary user imports, which never wait for them. Unstated, a call is not background.
 * One definition: the RemoteBudget's `BudgetClass` (`@app/domain`), which meters the same calls.
 */
export type AiBudgetClass = BudgetClass;

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
  /** Whose call it is; the duty cycle and the admission hook read it (F4 D15). */
  budgetClass?: AiBudgetClass | undefined;
  /** The persisted job the call works for, so a refused admission can be told to its job. */
  jobId?: string | undefined;
}

/** What the admission hook sees of a new entry. */
export type LaneAdmission = Pick<
  LaneTicket,
  "lane" | "priority" | "workloadClass" | "budgetClass" | "label" | "jobId"
>;

export type LaneOutcome = "ok" | "transient" | "permanent";

/** What a refusing lane knows of an entry it fails. */
export type LaneRefusalTarget = Pick<LaneTicket, "priority" | "workloadClass" | "label">;

/** The error a refusing lane fails an entry with. */
export type LaneRefusal = (entry: LaneRefusalTarget) => unknown;

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
  /**
   * Keeps the slot after the execution settles until `until` settles (a wedged local runtime). With
   * `refuse`, the lane meanwhile fails the entries waiting for it and every new one with the error
   * `refuse` makes, so no call waits silently, its deadline paused, behind a runtime that may never
   * stop (C11).
   */
  holdUntil(until: Promise<unknown>, options?: { refuse?: LaneRefusal }): void;
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
  /** Rate limits (429s and stated resets) the lane observed since it was created. */
  readonly rateLimits: number;
  /** The circuit breaker of a remote lane (F3 D32); null for the local lane, which has none. */
  readonly breaker: BreakerSnapshot | null;
}

export interface AiScheduler {
  /** Reserves an admission now, for a call whose lane is known only after its route is read. */
  reserve(): LaneReservation;
  /**
   * Runs `execute` once the ticket's lane grants a slot: P0 first in admission order, then the
   * lowest effective priority (with aging), FIFO within it. Nothing preempts a running call; the
   * slot is released when the execution settles, before the returned promise settles. An open
   * circuit breaker rejects a remote lane's new entries at once with a `ProviderUnavailableError`.
   */
  run<T>(ticket: LaneTicket, execute: (permit: LanePermit) => Promise<T>): Promise<T>;
  /**
   * Hands free slots out again after a condition outside the scheduler changed, such as the duty
   * cycle of background calls (the user went idle).
   */
  refresh(): void;
  /** AIMD decrease and pause of a remote lane until `retryAt` (scheduler clock), when known. */
  observeRateLimit(lane: LaneKey, retryAt: number | null): void;
  /**
   * AIMD increase after consecutive successes (a transient failure resets the streak), and the
   * circuit breaker's count of consecutive transient failures of a remote lane.
   */
  observeOutcome(lane: LaneKey, outcome: LaneOutcome): void;
  snapshot(): LaneSnapshot[];
}
