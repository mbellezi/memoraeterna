import type { AiLaneRuntimeConfig } from "../runtime-config.js";
import type { LaneOutcome } from "./types.js";

/** The adaptive limit of a remote lane: additive increase, multiplicative decrease (F3 D29). */
export interface AimdState {
  readonly limit: number;
  readonly maximum: number;
  /** Consecutive successful responses since the last change or transient failure. */
  readonly streak: number;
}

type AimdConfig = Pick<
  AiLaneRuntimeConfig["lanes"],
  "minimum" | "increaseAfterSuccesses" | "decreaseFactor"
>;

export function initialAimd(maximum: number): AimdState {
  return { limit: maximum, maximum, streak: 0 };
}

/** A 429, `Retry-After` or stated reset: the limit is multiplied by the factor, never below the minimum. */
export function aimdOnRateLimit(state: AimdState, config: AimdConfig): AimdState {
  const minimum = Math.min(config.minimum, state.maximum);
  return {
    ...state,
    limit: Math.max(minimum, Math.floor(state.limit * config.decreaseFactor)),
    streak: 0
  };
}

/**
 * One response's outcome. Successes count up to `increaseAfterSuccesses` and then raise the limit by
 * one, up to the maximum; a transient failure resets the count; a permanent failure (an invalid
 * request) says nothing about capacity and leaves it.
 */
export function aimdOnOutcome(
  state: AimdState,
  outcome: LaneOutcome,
  config: AimdConfig
): AimdState {
  if (outcome === "transient") return { ...state, streak: 0 };
  if (outcome === "permanent") return state;
  const streak = state.streak + 1;
  if (streak < config.increaseAfterSuccesses) return { ...state, streak };
  return { ...state, limit: Math.min(state.maximum, state.limit + 1), streak: 0 };
}
