import { useEffect } from "react";

import type { AppEventHandler, AppEventType } from "../../shared/app-events";
import { useStableCallback } from "./stable-callback";

/**
 * A view listens to the typed push events (F4 D26) only while it is shown: a hidden view subscribes
 * to nothing and reads again when it is shown (`rules/frontend.md`). The preload validates every
 * payload before a handler sees it.
 */

/** The part of `window.app` a subscription needs. */
export interface AppEventApi {
  onAppEvent<T extends AppEventType>(type: T, handler: AppEventHandler<T>): () => void;
}

/**
 * Subscribes while `active`, and does nothing at all while it is not: the API is not even asked
 * for. Returns what stops listening.
 */
export function subscribeAppEvent<T extends AppEventType>(
  active: boolean,
  api: () => AppEventApi | undefined,
  type: T,
  handler: AppEventHandler<T>
): () => void {
  if (!active) return () => undefined;
  const unsubscribe = api()?.onAppEvent(type, handler);
  return () => unsubscribe?.();
}

/**
 * Listens to one event type until the returned function is called, outside React (a store, a
 * controller). The handler receives the payload type that the type's schema describes
 * (`AppEventOf<T>`); the preload has validated it. Does nothing, and returns a no-op, where
 * `window.app` does not exist (a test, a renderer outside Electron).
 */
export function subscribe<T extends AppEventType>(
  type: T,
  handler: AppEventHandler<T>
): () => void {
  return subscribeAppEvent(
    true,
    () => (typeof window === "undefined" ? undefined : window.app),
    type,
    handler
  );
}

/**
 * Calls `handler` for each event of `type` while the component is mounted and `active` (a view that
 * stays mounted while hidden passes whether it is shown). A new handler on each render does not
 * resubscribe.
 */
export function useAppEvent<T extends AppEventType>(
  type: T,
  handler: AppEventHandler<T>,
  active = true
): void {
  const stable = useStableCallback(handler);
  useEffect(
    () => subscribeAppEvent(active, () => window.app, type, stable),
    [active, type, stable]
  );
}
