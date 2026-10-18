import type { ObjectNeighborhood } from "@app/domain";

export type Load =
  { status: "loading" } | { status: "error" } | { status: "ready"; answer: ObjectNeighborhood };

/**
 * A read made while a graph is shown: none, one in flight for the depth the person asked for, or one
 * that failed (the graph on screen is the last answer, and the notice offers the read again).
 */
export type Reread = "idle" | "pending" | "failed";

/**
 * How the Note page's relation graph reads its answer (F3 D43), apart from React and the window so
 * each step can be tested. The rules it keeps:
 *
 *   - the graph on screen stays until the next answer arrives, and a failed reread keeps it;
 *   - what is asked for goes back to what is drawn when a read fails, so the depth toggle, which
 *     says what is drawn, can be pressed again and a later push does not change the depth on its own;
 *   - every ask (a depth, a Retry) grows `request`, so asking for the same thing again reads again;
 *   - a read that failed is not repeated by a page that is shown again: only another request, or
 *     another revision of the page's relations, reads.
 */
export interface ReadState {
  load: Load;
  reread: Reread;
  /** The depth the next read asks for. */
  wanted: 1 | 2;
  /** Grows with every ask. */
  request: number;
  /** The read (note, revision and request) that failed last; null before any failure. */
  failedKey: string | null;
  /** The depth the failed read asked for, for the notice's Retry. */
  failedDepth: 1 | 2;
}

export const initialReadState: ReadState = {
  load: { status: "loading" },
  reread: "idle",
  wanted: 1,
  request: 0,
  failedKey: null,
  failedDepth: 1
};

export type ReadEvent =
  | { type: "depth"; depth: 1 | 2 }
  | { type: "retry" }
  | { type: "retryReread" }
  | { type: "started" }
  | { type: "answered"; key: string; answer: ObjectNeighborhood | null }
  | { type: "failed"; key: string };

export function readReducer(state: ReadState, event: ReadEvent): ReadState {
  switch (event.type) {
    case "depth":
      return { ...state, wanted: event.depth, request: state.request + 1 };
    case "retry":
      return { ...state, load: { status: "loading" }, request: state.request + 1 };
    case "retryReread":
      return { ...state, wanted: state.failedDepth, request: state.request + 1 };
    case "started":
      if (state.load.status !== "ready") return { ...state, load: { status: "loading" } };
      return { ...state, reread: state.wanted === state.load.answer.depth ? "idle" : "pending" };
    case "answered": {
      if (!event.answer)
        return { ...state, load: { status: "error" }, reread: "idle", failedKey: event.key };
      const shown = state.load.status === "ready" ? state.load.answer : null;
      // The same answer again changes nothing: the graph is not drawn twice.
      const same = shown !== null && JSON.stringify(shown) === JSON.stringify(event.answer);
      return {
        ...state,
        load: same ? state.load : { status: "ready", answer: event.answer },
        reread: "idle",
        wanted: event.answer.depth
      };
    }
    case "failed": {
      if (state.load.status !== "ready")
        return { ...state, load: { status: "error" }, reread: "idle", failedKey: event.key };
      return {
        ...state,
        reread: "failed",
        wanted: state.load.answer.depth,
        failedKey: event.key,
        failedDepth: state.wanted
      };
    }
  }
}

/** The key of a read: the note, the page's revision of its relations and the request. */
export function readKey(noteId: string, revision: number, request: number): string {
  return `${noteId}:${revision}:${request}`;
}

/** Whether a shown, active page reads now: not while the read it asks for is the one that failed. */
export function shouldRead(failedKey: string | null, key: string): boolean {
  return failedKey !== key;
}
