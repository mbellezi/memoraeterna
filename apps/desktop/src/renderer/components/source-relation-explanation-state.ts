import type { SourceRelationView } from "@app/domain";

import { notePageTiming, type ExplanationState } from "./note-page/note-page-model";

/**
 * A source relation's evidence opens one row at a time. The explanation is asked for only once the
 * row stayed open for the same dwell as a Note page card, so opening and closing at once asks for
 * nothing; Retry asks at once. Closing the row forgets the request (and cancels it). The component
 * owns the timer; `dwell` says when to run it.
 */
export interface SourceRelationOpenState {
  open: string | null;
  dwell: { id: string; delayMs: number } | null;
  /** The open row that stayed open for the dwell: its explanation may be asked for. */
  explain: string | null;
}

export type SourceRelationOpenEvent =
  | { type: "open"; id: string }
  | { type: "close"; id: string }
  | { type: "dwell" }
  /** A deliberate request on the open row (Retry) asks at once, without the dwell. */
  | { type: "explainNow"; id: string }
  | { type: "reset" };

export const initialSourceRelationOpenState: SourceRelationOpenState = {
  open: null,
  dwell: null,
  explain: null
};

export function sourceRelationOpenReducer(
  state: SourceRelationOpenState,
  event: SourceRelationOpenEvent
): SourceRelationOpenState {
  switch (event.type) {
    case "open":
      return state.open === event.id
        ? state
        : {
            open: event.id,
            dwell: { id: event.id, delayMs: notePageTiming.explainDwellMs },
            explain: null
          };
    case "close":
      return state.open === event.id ? initialSourceRelationOpenState : state;
    case "dwell":
      return state.dwell !== null && state.dwell.id === state.open
        ? { ...state, dwell: null, explain: state.open }
        : state;
    case "explainNow":
      return state.open === event.id && state.explain !== event.id
        ? { ...state, dwell: null, explain: event.id }
        : state;
    case "reset":
      return initialSourceRelationOpenState;
  }
}

/** An explanation written during this view, before the list is read again. */
export interface WrittenSourceExplanation {
  text: string;
  writtenBy: string;
}

/** What a relation shows as its explanation. */
export type SourceRelationExplanationView =
  /** Prose stored by the earlier matcher: shown as it is, never written again. */
  | { kind: "stored"; text: string }
  | { kind: "written"; text: string; writtenBy: string }
  | { kind: "writing" }
  | { kind: "unavailable" }
  | { kind: "failed"; noModel: boolean }
  /** Nothing yet: it is asked for once the relation stays open. */
  | { kind: "none" };

export function sourceRelationExplanationView(
  relation: Pick<SourceRelationView, "explanation" | "writtenExplanation">,
  written: WrittenSourceExplanation | undefined,
  state: ExplanationState | undefined
): SourceRelationExplanationView {
  if (relation.explanation) return { kind: "stored", text: relation.explanation };
  const shown = written ?? relation.writtenExplanation;
  if (shown) return { kind: "written", text: shown.text, writtenBy: shown.writtenBy };
  if (state?.status === "writing") return { kind: "writing" };
  if (state?.status === "unavailable") return { kind: "unavailable" };
  if (state?.status === "failed") return { kind: "failed", noModel: state.kind === "noModel" };
  return { kind: "none" };
}

/** Whether an open relation asks for its explanation: none is stored or written, and it is not gone. */
export function asksForSourceExplanation(
  relation: Pick<SourceRelationView, "explanation" | "writtenExplanation"> | undefined,
  written: WrittenSourceExplanation | undefined,
  state: ExplanationState | undefined
): boolean {
  return (
    relation !== undefined &&
    !relation.explanation &&
    !relation.writtenExplanation &&
    written === undefined &&
    state?.status !== "unavailable"
  );
}

/**
 * A short reading of what the relation rests on, for rows decided without prose: the first current
 * evidence pair (any evidence when none is current).
 */
export function sourceRelationExcerpt(
  relation: Pick<SourceRelationView, "evidence">
): { source: string; target: string } | null {
  const evidence = relation.evidence.find((item) => item.current) ?? relation.evidence[0];
  return evidence ? { source: evidence.sourceExcerpt, target: evidence.targetExcerpt } : null;
}
