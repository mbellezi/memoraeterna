import { AiProviderError } from "../provider-error.js";
import type { AiLaneRuntimeConfig } from "../runtime-config.js";
import type { LaneFailureKind, LaneKey, LaneOutcome } from "./types.js";

/**
 * The circuit breaker of one remote lane (F3 D32). `closed` counts consecutive transient failures;
 * the threshold opens it. `open` fails new entries fast until `openMs` passed, then `half_open`
 * admits one probe: its success closes the breaker, a transient failure opens it again. Running
 * calls are never touched, and a breaker belongs to one lane, so other lanes cannot be affected.
 *
 * Pure: time is passed in, and the open period ends lazily at the next question rather than on a
 * timer, so a fake clock drives every transition.
 */
export type BreakerState = "closed" | "open" | "half_open";

export type BreakerConfig = AiLaneRuntimeConfig["breaker"];

export type BreakerTransitionReason =
  /** The failure threshold was reached. */
  | "failures"
  /** The open period ended; the next entry is the probe. */
  | "elapsed"
  /** The probe failed transiently. */
  | "probe_failed"
  /** The probe got an answer. */
  | "probe_answered";

export interface BreakerTransition {
  readonly from: BreakerState;
  readonly to: BreakerState;
  readonly reason: BreakerTransitionReason;
  /** When it happened on the scheduler clock; the end of the open period for `elapsed`. */
  readonly at: number;
}

/** What a breaker says of a new entry. */
export type BreakerAdmission =
  | { readonly kind: "admit" }
  /** The entry is the one probe of a half-open breaker; its outcomes carry `token`. */
  | { readonly kind: "probe"; readonly token: number }
  /**
   * The entry is failed fast: `open` while the open period runs (`retryAfterMs` = until the next
   * entry may probe), `half_open` while the probe is out (its answer decides).
   */
  | {
      readonly kind: "refuse";
      readonly retryAfterMs: number;
      readonly state: "open" | "half_open";
    };

export interface BreakerSnapshot {
  readonly state: BreakerState;
  readonly consecutiveFailures: number;
  /** Milliseconds until the open period ends; null unless the breaker is open. */
  readonly reopensInMs: number | null;
  /** Times the breaker opened since the lane was created. */
  readonly opened: number;
  /** Entries failed fast since the lane was created. */
  readonly refused: number;
}

/**
 * The error of an entry a breaker fails fast. A transient provider error, so a job waits for the
 * probe's answer instead of failing (F4 D7); `retryAfterMs` says how long the breaker stays shut,
 * so a retry does not come back sooner. `breaker` says whether the open period runs (`open`: the
 * next entry after it probes) or a probe is out (`half_open`: its answer decides); `failure` is how
 * the lane's provider last failed (F4 D27), so an unreachable network is told from a provider that
 * does not answer.
 */
export class ProviderUnavailableError extends AiProviderError {
  public readonly lane: LaneKey;
  public readonly breaker: "open" | "half_open";
  public readonly failure: LaneFailureKind | undefined;

  public constructor(
    lane: LaneKey,
    retryAfterMs: number,
    detail: { breaker?: "open" | "half_open"; failure?: LaneFailureKind | undefined } = {}
  ) {
    super("errors.ai.providerUnavailable", {
      kind: "network",
      transient: true,
      code: "provider_unavailable",
      retryAfterMs: Math.max(0, Math.ceil(retryAfterMs))
    });
    this.name = "ProviderUnavailableError";
    this.lane = lane;
    this.breaker = detail.breaker ?? "open";
    this.failure = detail.failure;
  }
}

export class CircuitBreaker {
  private state: BreakerState = "closed";
  private failures = 0;
  private openUntil = 0;
  private opened = 0;
  private refused = 0;
  /** The token of the probe in flight; null when a half-open breaker waits for one. */
  private probe: number | null = null;
  private tokens = 0;

  public constructor(
    private readonly config: BreakerConfig,
    private readonly onTransition: (transition: BreakerTransition) => void = () => undefined
  ) {}

  /** Decides a new entry of the lane at `now`. */
  public admit(now: number): BreakerAdmission {
    this.advance(now);
    if (this.state === "closed") return { kind: "admit" };
    if (this.state === "half_open" && this.probe === null) {
      this.probe = ++this.tokens;
      return { kind: "probe", token: this.probe };
    }
    this.refused += 1;
    // While a probe is out, the wait is at most one more open period (it reopens on a failure).
    if (this.state === "open")
      return { kind: "refuse", retryAfterMs: this.openUntil - now, state: "open" };
    return { kind: "refuse", retryAfterMs: this.config.openMs, state: "half_open" };
  }

  /** Counts entries the scheduler failed fast that were already waiting when the breaker opened. */
  public countRefused(entries: number): void {
    this.refused += entries;
  }

  /**
   * One response's outcome. A transient failure counts toward the threshold; an answer (success or
   * a permanent failure, which proves the provider is up) resets it. While the breaker is open or
   * half-open only the probe's outcome counts: a call that was already running says nothing about
   * the present.
   */
  public record(outcome: LaneOutcome, now: number, probe?: number): void {
    this.advance(now);
    if (this.state === "closed") {
      if (outcome !== "transient") {
        this.failures = 0;
        return;
      }
      this.failures += 1;
      if (this.failures >= this.config.failureThreshold) this.open(now, "failures");
      return;
    }
    if (this.state !== "half_open" || probe === undefined || probe !== this.probe) return;
    this.probe = null;
    if (outcome === "transient") this.open(now, "probe_failed");
    else this.close(now);
  }

  /**
   * The probe's execution ended, or its wait was cancelled, without an outcome to judge (the caller
   * aborted): the next entry may be the probe instead. Does nothing for an outdated token.
   */
  public settleProbe(token: number): void {
    if (this.state === "half_open" && this.probe === token) this.probe = null;
  }

  public snapshot(now: number): BreakerSnapshot {
    this.advance(now);
    return {
      state: this.state,
      consecutiveFailures: this.failures,
      reopensInMs: this.state === "open" ? Math.max(0, this.openUntil - now) : null,
      opened: this.opened,
      refused: this.refused
    };
  }

  private advance(now: number): void {
    if (this.state === "open" && now >= this.openUntil)
      this.move("half_open", "elapsed", this.openUntil);
  }

  private open(now: number, reason: BreakerTransitionReason): void {
    this.opened += 1;
    this.openUntil = now + this.config.openMs;
    this.move("open", reason, now);
  }

  private close(now: number): void {
    this.failures = 0;
    this.move("closed", "probe_answered", now);
  }

  private move(to: BreakerState, reason: BreakerTransitionReason, at: number): void {
    const from = this.state;
    this.state = to;
    this.onTransition({ from, to, reason, at });
  }
}
