import { useEffect, useSyncExternalStore } from "react";

import {
  inboxCountStoreOf,
  navigatorTreeStoreOf,
  type NavigatorTree,
  type Read
} from "./shell-stores";

/** `window.app`, or nothing where there is no window (a server render). */
const appOf = () => (typeof window === "undefined" ? undefined : window.app);

interface ShellStore<T> {
  subscribe(listener: () => void): () => void;
  getSnapshot(): Read<T>;
  retain(): () => void;
  retry(): void;
}

function useShellStore<T>(store: ShellStore<T>, enabled: boolean): Read<T> & { retry(): void } {
  // `retain` returns what lets go, which is what an effect cleans up with.
  useEffect(() => (enabled ? store.retain() : undefined), [store, enabled]);
  const read = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return { ...read, retry: () => store.retry() };
}

/**
 * How many items wait in the Inbox, for the rail's badge: read once and kept by `inbox.changed`.
 * `enabled` is false until the library is open, so nothing is asked before the database is ready.
 */
export function useInboxCount(enabled = true): Read<number> & { retry(): void } {
  return useShellStore(inboxCountStoreOf(appOf()), enabled);
}

/** The top level of the topic tree, for the navigator host; `tree.changed` refreshes it. */
export function useNavigatorTree(enabled = true): Read<NavigatorTree> & { retry(): void } {
  return useShellStore(navigatorTreeStoreOf(appOf()), enabled);
}
