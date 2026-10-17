import type { LanePermit } from "./types.js";

const permits = new WeakMap<AbortSignal, LanePermit>();

/**
 * Attaches a running execution's lane permit to the signal its adapter receives, so the remote
 * retry loop can sleep off the lane and report rate limits without the adapters carrying it. The
 * signal must be the execution's own (one per call), never one shared between calls.
 */
export function bindLanePermit(signal: AbortSignal, permit: LanePermit): void {
  permits.set(signal, permit);
}

/** The lane permit of the execution a signal belongs to, if the call runs on the scheduler. */
export function lanePermitOf(signal: AbortSignal | undefined): LanePermit | undefined {
  return signal ? permits.get(signal) : undefined;
}
