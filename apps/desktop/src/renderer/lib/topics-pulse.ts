import { useEffect, useState } from "react";

import type { AppEventApi } from "./app-events";

/**
 * A view that shows where an object sits in the topic tree (a note's page, a source's panel) reads
 * that place again when the tree changes. The tree pushes a change for every commit, and a build
 * or a rebalance commits many in a row, so the views read once after a burst, not once per commit.
 */

/** How long after the first push of a burst the views read again. */
export const topicsPulseDelayMs = 1_000;

/** The part of `window.app` the pulse needs: the bus. It listens to `tree.changed`. */
export type TopicsPulseApi = AppEventApi;

/**
 * Calls `onPulse` once, `delayMs` after the first push of a burst; a push that arrives while that
 * wait runs is part of the same burst. Returns the function that stops listening (and the wait).
 */
export function watchTopicsChanged(
  api: () => TopicsPulseApi,
  onPulse: () => void,
  delayMs: number = topicsPulseDelayMs
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const unsubscribe = api().onAppEvent("tree.changed", () => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      onPulse();
    }, delayMs);
  });
  return () => {
    unsubscribe();
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}

/**
 * A number that grows each time the topic tree changed while the view was shown. A hidden view
 * listens to nothing: it reads again when it is shown.
 */
export function useTopicsPulse(active: boolean): number {
  const [pulse, setPulse] = useState(0);
  useEffect(() => {
    if (!active) return;
    return watchTopicsChanged(
      () => window.app,
      () => setPulse((current) => current + 1)
    );
  }, [active]);
  return pulse;
}
