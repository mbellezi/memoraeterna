import { useEffect, useState } from "react";

import type { AppEventApi } from "./app-events";

/**
 * A page that lists a note's relations reads them again when they changed (F3 3.19): a link job
 * committed new ones, an explanation withdrew one, the owner kept or removed one. The main process
 * publishes the notes whose relations changed on the bus, already coalesced, as `relation.created`
 * and as `object.changed` with the change `relations`; a page listens only for its own note and
 * reads once after a burst, never on a timer.
 */

/** How long after the first push for the note of a burst the page reads again. */
export const relationsPulseDelayMs = 500;

/** The part of `window.app` the pulse needs: the bus. */
export type RelationsPulseApi = AppEventApi;

/**
 * Calls `onPulse` once, `delayMs` after the first push that names `noteId`; a push that arrives
 * while that wait runs is part of the same burst, and a push about other notes changes nothing.
 * Returns the function that stops listening (and the wait).
 */
export function watchRelationsChanged(
  api: () => RelationsPulseApi,
  noteId: string,
  onPulse: () => void,
  delayMs: number = relationsPulseDelayMs
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const pulse = () => {
    if (timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      onPulse();
    }, delayMs);
  };
  const bus = api();
  const stops = [
    bus.onAppEvent("relation.created", (event) => {
      if (event.noteIds.includes(noteId)) pulse();
    }),
    bus.onAppEvent("object.changed", (event) => {
      // An overflow lists no ids: every open note page reads again, once.
      if ("overflow" in event) {
        if (event.kinds.includes("note")) pulse();
      } else if (
        event.refs.some(
          (ref) => ref.kind === "note" && ref.id === noteId && ref.change === "relations"
        )
      )
        pulse();
    })
  ];
  return () => {
    for (const stop of stops) stop();
    if (timer !== null) clearTimeout(timer);
    timer = null;
  };
}

/**
 * A number that grows each time the relations of `noteId` changed while the view was shown. A
 * hidden view listens to nothing: it reads again when it is shown.
 */
export function useRelationsPulse(active: boolean, noteId: string): number {
  const [pulse, setPulse] = useState(0);
  useEffect(() => {
    if (!active) return;
    return watchRelationsChanged(
      () => window.app,
      noteId,
      () => setPulse((current) => current + 1)
    );
  }, [active, noteId]);
  return pulse;
}
