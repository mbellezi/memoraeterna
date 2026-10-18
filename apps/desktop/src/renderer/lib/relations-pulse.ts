import { useEffect, useState } from "react";

/**
 * A page that lists a note's relations reads them again when they changed (F3 3.19): a link job
 * committed new ones, an explanation withdrew one, the owner kept or removed one. The main process
 * pushes the notes whose relations changed, already coalesced; a page listens only for its own
 * note and reads once after a burst, never on a timer.
 */

/** How long after the first push for the note of a burst the page reads again. */
export const relationsPulseDelayMs = 500;

export interface RelationsPulseApi {
  subscribeChanged(listener: (event: { noteIds: readonly string[] }) => void): () => void;
}

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
  const unsubscribe = api().subscribeChanged((event) => {
    if (timer !== null || !event.noteIds.includes(noteId)) return;
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
 * A number that grows each time the relations of `noteId` changed while the view was shown. A
 * hidden view listens to nothing: it reads again when it is shown.
 */
export function useRelationsPulse(active: boolean, noteId: string): number {
  const [pulse, setPulse] = useState(0);
  useEffect(() => {
    if (!active) return;
    return watchRelationsChanged(
      () => window.app.relations,
      noteId,
      () => setPulse((current) => current + 1)
    );
  }, [active, noteId]);
  return pulse;
}
