// A test helper: listens to `appEventPort` the way the bus does and keeps the `object.changed` refs
// the code under test published, so a writer's test can say what a commit announced and that a
// rollback announced nothing.
import type { AppEvent, ObjectChangedRef } from "../../shared/app-events.js";
import { appEventPort } from "./app-events.js";

export interface ObjectEventCapture {
  /** Every event published since the capture began (or since `clear`). */
  readonly events: AppEvent[];
  /** The refs of every `object.changed` with refs, in publishing order. */
  refs(): ObjectChangedRef[];
  clear(): void;
  /** Detaches from the port; call it in `afterEach`. */
  stop(): void;
}

export function captureObjectEvents(): ObjectEventCapture {
  const events: AppEvent[] = [];
  appEventPort.attach({ publish: (event) => void events.push(event) });
  return {
    events,
    refs: () =>
      events.flatMap((event) =>
        event.type === "object.changed" && "refs" in event ? event.refs : []
      ),
    clear: () => void events.splice(0),
    stop: () => appEventPort.detach()
  };
}
