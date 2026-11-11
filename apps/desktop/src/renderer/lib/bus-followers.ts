import type { AppEventOf } from "../../shared/app-events";
import { subscribeAppEvent, type AppEventApi } from "./app-events";

/**
 * What a view does with the bus events it follows, kept out of the component so a test can drive
 * it over a fake bus (`fake-app-events.ts`). Every event goes to every window, so each follower
 * keeps the filter that makes an event its own.
 */

/** Where a follower finds `window.app`; a test hands its fake bus. */
type ApiOf = () => AppEventApi | undefined;

/**
 * The text of one relation explanation as it is written, for one request only: the deltas of a
 * canceled request or of another card on the same relation are not this request's.
 */
export function watchExplanationDelta(
  api: ApiOf,
  request: { requestId: string; relationId: string },
  onText: (text: string) => void
): () => void {
  return subscribeAppEvent(true, api, "explanation.delta", (event) => {
    if (event.requestId !== request.requestId || event.relationId !== request.relationId) return;
    onText(event.text);
  });
}

/**
 * The progress of the import this view started: `runId` is read at each event, because the view
 * starts a new run (and ends it) while it stays mounted. Another window's run, an earlier run and
 * an event while no run is shown are not this view's.
 */
export function watchImportProgress(
  api: ApiOf,
  active: boolean,
  runId: () => string | null,
  onProgress: (event: AppEventOf<"import.progress">) => void
): () => void {
  return subscribeAppEvent(active, api, "import.progress", (event) => {
    if (event.runId !== runId()) return;
    onProgress(event);
  });
}

/** The view history changed (an open, a pin, a clear): a shown list reads it again. */
export function watchViewHistoryChanged(
  api: ApiOf,
  active: boolean,
  onChanged: () => void
): () => void {
  return subscribeAppEvent(active, api, "view.changed", () => onChanged());
}
