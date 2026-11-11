import type { AppEventHandler, AppEventOf, AppEventType } from "../../shared/app-events";
import type { ObsidianSyncStatus } from "../../shared/ipc";
import { subscribeAppEvent, type AppEventApi } from "./app-events";

/**
 * How a card follows a status that main publishes (F5 D16): one subscription and one initial read,
 * never a timer. Kept out of the components so a test can drive each over a fake bus
 * (`fake-app-events.ts`).
 */

/** Where a follower finds `window.app`; a test hands its fake bus. */
type ApiOf = () => AppEventApi | undefined;

/** One event type a card re-reads on, with the filter that makes an event of it the card's own. */
export type ReadSource = {
  [T in AppEventType]: { type: T; when?: (event: AppEventOf<T>) => boolean };
}[AppEventType];

export interface ReadOnEvents {
  stop(): void;
  /** Reads once more, as an event would. */
  refresh(): void;
}

/**
 * Reads once when it starts and again after each event of `sources`, and hands every result to
 * `onValue`. One read is in flight at a time: events that arrive meanwhile fold into one more read
 * after it, so results arrive in order and a burst costs two reads at most. Nothing is delivered
 * after `stop`.
 */
export function readOnEvents<V>(options: {
  api: ApiOf;
  active?: boolean;
  sources: readonly ReadSource[];
  read: () => Promise<V>;
  onValue: (value: V) => void;
  onError?: (error: unknown) => void;
}): ReadOnEvents {
  const { api, active = true, sources, read, onValue, onError } = options;
  if (!active) return { stop: () => undefined, refresh: () => undefined };
  let stopped = false;
  let reading = false;
  let again = false;

  const run = (): void => {
    if (stopped) return;
    if (reading) {
      again = true;
      return;
    }
    reading = true;
    read()
      .then((value) => {
        if (!stopped) onValue(value);
      })
      .catch((error: unknown) => {
        if (!stopped) onError?.(error);
      })
      .finally(() => {
        reading = false;
        if (again) {
          again = false;
          run();
        }
      });
  };

  const stops = sources.map((source) =>
    subscribeAppEvent(true, api, source.type, ((event: AppEventOf<AppEventType>) => {
      const when = source.when as ((event: AppEventOf<AppEventType>) => boolean) | undefined;
      if (!when || when(event)) run();
    }) as AppEventHandler<typeof source.type>)
  );
  run();
  return {
    stop() {
      stopped = true;
      for (const stop of stops) stop();
    },
    refresh: run
  };
}

/** A `settings.changed` that touches one of `stores` (the event names the stores that moved). */
export const settingsTouch =
  (...stores: readonly AppEventOf<"settings.changed">["stores"][number][]) =>
  (event: AppEventOf<"settings.changed">): boolean =>
    event.stores.some((store) => stores.includes(store));

/** The sync's own `obsidian.sync` events that say a run is over (a progress tick is not a reason to read). */
export const obsidianSyncEnded = (event: AppEventOf<"obsidian.sync">): boolean =>
  event.state !== "running";

export interface ObsidianSyncApi extends AppEventApi {
  obsidian: { getSyncStatus(): Promise<ObsidianSyncStatus> };
}

/**
 * The vault synchronization's status: `obsidian.sync` carries the whole status, so each event is
 * the value. The one initial read fills the card until the first event; a read that comes back
 * after an event is older than it and is dropped.
 */
export function watchObsidianSync(
  api: () => ObsidianSyncApi | undefined,
  onStatus: (status: ObsidianSyncStatus) => void,
  onError?: (error: unknown) => void
): () => void {
  let stopped = false;
  let heard = false;
  const stop = subscribeAppEvent(true, api, "obsidian.sync", (event) => {
    const { type, ...status } = event;
    void type;
    heard = true;
    onStatus(status);
  });
  api()
    ?.obsidian.getSyncStatus()
    .then((status) => {
      if (!stopped && !heard) onStatus(status);
    })
    .catch((error: unknown) => {
      if (!stopped) onError?.(error);
    });
  return () => {
    stopped = true;
    stop();
  };
}

/** The part of `document` the Monitoring view needs to know whether the window is shown. */
export interface VisibilityHost {
  readonly hidden: boolean;
  addEventListener(type: "visibilitychange", listener: () => void): void;
  removeEventListener(type: "visibilitychange", listener: () => void): void;
}

/**
 * Calls `onChanged` when monitoring data changed (`monitoring.changed`, folded to 250 ms by the
 * bus) while `active`. A change that arrives while the window is hidden is not read then: it is
 * read once when the window is shown again (a visibility event, not a timer).
 */
export function watchMonitoringChanged(
  api: ApiOf,
  active: boolean,
  host: VisibilityHost,
  onChanged: () => void
): () => void {
  if (!active) return () => undefined;
  let missed = false;
  const shown = (): void => {
    if (host.hidden || !missed) return;
    missed = false;
    onChanged();
  };
  const stop = subscribeAppEvent(true, api, "monitoring.changed", () => {
    if (host.hidden) missed = true;
    else onChanged();
  });
  host.addEventListener("visibilitychange", shown);
  return () => {
    stop();
    host.removeEventListener("visibilitychange", shown);
  };
}
