import { describe, expect, it } from "vitest";

import {
  drawsGraph,
  initialRelationsView,
  relationsViewForKey,
  relationsViewReducer,
  type RelationsViewState
} from "./relations-view";

describe("the Relations section's view", () => {
  it("opens on the list, which is also the text alternative of the graph", () => {
    expect(initialRelationsView).toEqual({ view: "list", graphUnavailable: false });
    expect(drawsGraph({ tabs: true, state: initialRelationsView })).toBe(false);
  });

  it("switches between the list and the graph", () => {
    const graph = relationsViewReducer(initialRelationsView, { type: "choose", view: "graph" });
    expect(graph).toEqual({ view: "graph", graphUnavailable: false });
    expect(drawsGraph({ tabs: true, state: graph })).toBe(true);
    expect(relationsViewReducer(graph, { type: "choose", view: "list" }).view).toBe("list");
    // Choosing what is already shown changes nothing, not even the state's identity.
    expect(relationsViewReducer(graph, { type: "choose", view: "graph" })).toBe(graph);
  });

  it("falls back to the list for good when this window cannot draw the graph", () => {
    const graph: RelationsViewState = { view: "graph", graphUnavailable: false };
    const fallback = relationsViewReducer(graph, { type: "unavailable" });
    expect(fallback).toEqual({ view: "list", graphUnavailable: true });
    expect(relationsViewReducer(fallback, { type: "choose", view: "graph" })).toBe(fallback);
    expect(drawsGraph({ tabs: true, state: { view: "graph", graphUnavailable: true } })).toBe(
      false
    );
    // The list stays reachable.
    expect(relationsViewReducer(fallback, { type: "choose", view: "list" })).toBe(fallback);
  });

  it("draws nothing without the tabs: a page with no shown relation has no graph to choose", () => {
    expect(drawsGraph({ tabs: false, state: { view: "graph", graphUnavailable: false } })).toBe(
      false
    );
  });

  it("moves between the tabs with the arrows, Home and End and ignores other keys", () => {
    expect(relationsViewForKey("ArrowLeft")).toBe("list");
    expect(relationsViewForKey("Home")).toBe("list");
    expect(relationsViewForKey("ArrowRight")).toBe("graph");
    expect(relationsViewForKey("End")).toBe("graph");
    expect(relationsViewForKey("Enter")).toBeNull();
    expect(relationsViewForKey("a")).toBeNull();
  });
});
