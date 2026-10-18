/**
 * Which view of the Relations section is shown (F3 D43): the list (the default and the text
 * alternative of the graph) or the graph. When the window cannot draw WebGL the graph falls back to
 * the list for good: its tab stays but cannot be chosen, and the section says why.
 */
export type RelationsView = "list" | "graph";

export interface RelationsViewState {
  view: RelationsView;
  graphUnavailable: boolean;
}

export type RelationsViewEvent = { type: "choose"; view: RelationsView } | { type: "unavailable" };

export const initialRelationsView: RelationsViewState = { view: "list", graphUnavailable: false };

export function relationsViewReducer(
  state: RelationsViewState,
  event: RelationsViewEvent
): RelationsViewState {
  if (event.type === "unavailable") return { view: "list", graphUnavailable: true };
  if (event.view === "graph" && state.graphUnavailable) return state;
  return event.view === state.view ? state : { ...state, view: event.view };
}

/** The tab key's move: the arrows and Home and End choose between the two tabs. */
export function relationsViewForKey(key: string): RelationsView | null {
  if (key === "ArrowLeft" || key === "Home") return "list";
  if (key === "ArrowRight" || key === "End") return "graph";
  return null;
}

/**
 * Whether the graph is drawn: it needs the tabs (a page with shown relations), the graph tab chosen
 * and a window that can draw it.
 */
export function drawsGraph(input: { tabs: boolean; state: RelationsViewState }): boolean {
  return input.tabs && input.state.view === "graph" && !input.state.graphUnavailable;
}
