// The Obsidian projections tell the windows through the bus when a kind of projection into the vault
// starts, ends or fails (F5 D16, spec 3.7). The old channels keep their own senders until T125.
import { obsidianProjectionKinds, obsidianProjectionStates } from "../../shared/app-events.js";
import { appEventPort } from "./app-events.js";

export type ObsidianProjectionKind = (typeof obsidianProjectionKinds)[number];
export type ObsidianProjectionState = (typeof obsidianProjectionStates)[number];

const pausedMessage = "obsidianWiki.errors.paused";
const isPaused = (error: unknown) => error instanceof Error && error.message === pausedMessage;

export function publishObsidianProjection(
  kind: ObsidianProjectionKind,
  state: ObsidianProjectionState
): void {
  appEventPort.publish({ type: "obsidian.projection", kind, state });
}

/**
 * Runs one projection step and publishes `running` before it and `completed` or `failed` after it,
 * whatever it returns or throws. `endState` lets a step that continues in a next page stay `running`.
 * A step that stops on purpose (a layout migration, a paused or disabled sync, an aborted lane
 * throws `obsidianWiki.errors.paused`) is not over: it resumes later, so it stays `running`.
 */
export async function trackObsidianProjection<T>(
  kind: ObsidianProjectionKind,
  run: () => Promise<T>,
  endState: (result: T) => ObsidianProjectionState = () => "completed"
): Promise<T> {
  publishObsidianProjection(kind, "running");
  try {
    const result = await run();
    publishObsidianProjection(kind, endState(result));
    return result;
  } catch (error) {
    publishObsidianProjection(kind, isPaused(error) ? "running" : "failed");
    throw error;
  }
}
