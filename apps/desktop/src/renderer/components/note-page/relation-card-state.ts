import { notePageTiming } from "./note-page-model";

/**
 * The relation evidence card, as a pure reducer: it opens at once on keyboard focus and after a
 * short delay on hover, stays open while the pointer or focus is on its row, closes with Escape
 * (until both pointer and focus have left the row) and only one card is open at a time. A card
 * asks for its explanation only once it has stayed open on the same row for a dwell, so a
 * pass-through hover or a tab past asks for nothing. The component owns the timers; `pending` and
 * `dwell` say which ones to run.
 */
export interface CardState {
  open: string | null;
  pending: { action: "open" | "close"; id: string; delayMs: number } | null;
  pointerOver: string | null;
  focusWithin: string | null;
  suppressed: string | null;
  /** The open card that stayed open for the dwell: its explanation may be asked for. */
  explain: string | null;
  dwell: { id: string; delayMs: number } | null;
}

export type CardEvent =
  | { type: "pointerEnter"; id: string }
  | { type: "pointerLeave"; id: string }
  | { type: "focusIn"; id: string }
  | { type: "focusOut"; id: string }
  | { type: "escape" }
  | { type: "timer" }
  | { type: "dwell" }
  /** A deliberate request on the open card (Retry) asks at once, without the dwell. */
  | { type: "explainNow"; id: string }
  | { type: "reset" };

export const initialCardState: CardState = {
  open: null,
  pending: null,
  pointerOver: null,
  focusWithin: null,
  suppressed: null,
  explain: null,
  dwell: null
};

/**
 * Escape closes an open card wherever focus is (a card opened by hover holds none), except while
 * typing or when something closer already handled the key.
 */
export function escapeClosesCard(event: {
  key: string;
  defaultPrevented: boolean;
  target: unknown;
}): boolean {
  if (event.key !== "Escape" || event.defaultPrevented) return false;
  const target = event.target as { tagName?: unknown; isContentEditable?: unknown } | null;
  if (typeof target !== "object" || target === null) return true;
  if (target.isContentEditable === true) return false;
  return !["INPUT", "TEXTAREA", "SELECT"].includes(String(target.tagName).toUpperCase());
}

/** Every change of the open card restarts the dwell; closing it forgets the explanation request. */
export function cardReducer(state: CardState, event: CardEvent): CardState {
  if (event.type === "dwell")
    return state.dwell !== null && state.dwell.id === state.open
      ? { ...state, dwell: null, explain: state.open }
      : state;
  if (event.type === "explainNow")
    return state.open === event.id && state.explain !== event.id
      ? { ...state, dwell: null, explain: event.id }
      : state;
  const next = transition(state, event);
  if (next.open === state.open) return next;
  return {
    ...next,
    explain: null,
    dwell: next.open === null ? null : { id: next.open, delayMs: notePageTiming.explainDwellMs }
  };
}

/** A suppressed row is released once neither the pointer nor focus is on it. */
function release(state: CardState): CardState {
  const id = state.suppressed;
  return id !== null && state.pointerOver !== id && state.focusWithin !== id
    ? { ...state, suppressed: null }
    : state;
}

function transition(
  state: CardState,
  event: Exclude<CardEvent, { type: "dwell" | "explainNow" }>
): CardState {
  switch (event.type) {
    case "focusIn": {
      const next = { ...state, focusWithin: event.id };
      if (state.suppressed === event.id) return { ...next, pending: null };
      return release({ ...next, open: event.id, pending: null });
    }
    case "focusOut": {
      if (state.focusWithin !== event.id) return state;
      const next = release({ ...state, focusWithin: null });
      if (next.open === event.id && next.pointerOver !== event.id)
        return { ...next, open: null, pending: null };
      return next;
    }
    case "pointerEnter": {
      const next = release({ ...state, pointerOver: event.id });
      if (next.suppressed === event.id) return { ...next, pending: null };
      if (next.open === event.id) return { ...next, pending: null };
      // Moving on from an open card that nothing holds switches at once.
      if (next.open !== null && next.focusWithin !== next.open)
        return { ...next, open: event.id, pending: null };
      return {
        ...next,
        pending: { action: "open", id: event.id, delayMs: notePageTiming.cardOpenDelayMs }
      };
    }
    case "pointerLeave": {
      if (state.pointerOver !== event.id) return state;
      const next = release({ ...state, pointerOver: null });
      if (next.open === event.id && next.focusWithin !== event.id)
        return {
          ...next,
          pending: { action: "close", id: event.id, delayMs: notePageTiming.cardCloseDelayMs }
        };
      return next.pending?.id === event.id && next.pending.action === "open"
        ? { ...next, pending: null }
        : next;
    }
    case "escape":
      if (state.open === null) return state;
      return { ...state, open: null, pending: null, suppressed: state.open };
    case "timer": {
      const pending = state.pending;
      if (!pending) return state;
      const next = { ...state, pending: null };
      if (pending.action === "open")
        return next.pointerOver === pending.id && next.suppressed !== pending.id
          ? { ...next, open: pending.id }
          : next;
      return next.open === pending.id &&
        next.pointerOver !== pending.id &&
        next.focusWithin !== pending.id
        ? { ...next, open: null }
        : next;
    }
    case "reset":
      return initialCardState;
  }
}
