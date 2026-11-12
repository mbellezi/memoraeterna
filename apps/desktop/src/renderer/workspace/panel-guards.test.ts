import { afterEach, describe, expect, it, vi } from "vitest";

import { guardedMove, guardsAtRisk, panelKey, setDrawnProbe, setPanelGuard } from "./panel-guards";
import { stackView } from "./PanelStack";
import { defaultWorkspace, reduce, type WorkspaceAction, type WorkspaceState } from "./state";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const note = (n: number) => `memora://note/${uuid(n)}`;

/** Explore with `addresses` pushed one beside the other, the last focused. */
function explore(...addresses: string[]): WorkspaceState {
  let state = reduce(defaultWorkspace("2026-11-12"), { type: "go", destination: "explore" });
  addresses.forEach((address, index) => {
    state = reduce(state, { type: "open", address, from: index - 1, mode: "push" });
  });
  return state;
}

const keyOf = (state: WorkspaceState, index: number) =>
  panelKey("explore", state.stacks.explore.panels[index]!.id);

/** The host's probe: the panels `stackView` draws full or compact at a window width. */
function probeAt(width: number, navigator: boolean) {
  return setDrawnProbe((state) => {
    const keys = new Set<string>();
    if (state.destination === "settings") return keys;
    const stack = state.stacks[state.destination];
    for (const item of stackView(stack, width, { navigator, context: false }).items) {
      const panel = stack.panels[item.panel];
      if (panel && !item.merged && item.mode !== "spine")
        keys.add(panelKey(state.destination, panel.id));
    }
    return keys;
  });
}

const open = (state: WorkspaceState, address: string): WorkspaceAction => ({
  type: "open",
  address,
  from: state.stacks.explore.focus,
  mode: "push"
});

let off: (() => void) | null = null;
const keys: string[] = [];
afterEach(() => {
  off?.();
  off = null;
  for (const key of keys.splice(0)) setPanelGuard(key, null);
});
const guarded = (key: string) => {
  const guard = vi.fn();
  setPanelGuard(key, guard);
  keys.push(key);
  return guard;
};

describe("a move that would unmount a panel with unsaved work asks first", () => {
  it("asks when the panel closes, and not when another one does", () => {
    const state = explore(note(1), note(2));
    const guard = guarded(keyOf(state, 0));
    expect(guardsAtRisk(state, reduce(state, { type: "close", panel: 1 }))).toEqual([]);
    expect(guardsAtRisk(state, reduce(state, { type: "close", panel: 0 }))).toEqual([guard]);
  });

  it("asks when Back or a replace changes the address the panel shows", () => {
    let state = explore(note(1));
    state = reduce(state, { type: "open", address: note(3), from: 0, mode: "replace" });
    const guard = guarded(keyOf(state, 0));
    expect(guardsAtRisk(state, reduce(state, { type: "back" }))).toEqual([guard]);
    expect(
      guardsAtRisk(
        state,
        reduce(state, { type: "open", address: note(5), from: 0, mode: "replace" })
      )
    ).toEqual([guard]);
  });

  it("asks when the layout folds the panel into a spine, not while it stays compact", () => {
    off = probeAt(1440, false);
    let state = explore(note(1));
    const guard = guarded(keyOf(state, 0));
    // Beside a second panel at 1440 px the first stays compact: its page is mounted, its draft kept.
    expect(guardsAtRisk(state, reduce(state, open(state, note(2))))).toEqual([]);
    state = reduce(state, open(state, note(2)));
    // A third makes it a spine: the page unmounts.
    expect(guardsAtRisk(state, reduce(state, open(state, note(3))))).toEqual([guard]);
  });

  it("asks at 960 px with the navigator, where the previous panel is a spine at once", () => {
    off = probeAt(960, true);
    const state = explore(note(1));
    const guard = guarded(keyOf(state, 0));
    expect(guardsAtRisk(state, reduce(state, open(state, note(2))))).toEqual([guard]);
  });

  it("leaves moves that touch no panel alone", () => {
    off = probeAt(960, true);
    const state = explore(note(1));
    guarded(keyOf(state, 0));
    expect(guardsAtRisk(state, reduce(state, { type: "scroll", panel: 0, top: 40 }))).toEqual([]);
    expect(guardsAtRisk(state, reduce(state, { type: "go", destination: "library" }))).toEqual([]);
    expect(guardsAtRisk(state, reduce(state, { type: "toggleContext" }))).toEqual([]);
  });

  it("holds the move until the person lets it go, and drops it when they keep editing", () => {
    off = probeAt(960, true);
    const base = explore(note(1));
    const guard = guarded(keyOf(base, 0));
    const proceed = vi.fn();
    guardedMove(base, open(base, note(2)), proceed);
    expect(guard).toHaveBeenCalledOnce();
    // Keep editing: the guard never calls `go`, so nothing runs.
    expect(proceed).not.toHaveBeenCalled();
    guard.mockImplementationOnce((go: () => void) => go());
    guardedMove(base, open(base, note(2)), proceed);
    expect(proceed).toHaveBeenCalledOnce();
  });

  it("runs the move at once when no guard is at risk", () => {
    const base = explore(note(1));
    const proceed = vi.fn();
    guardedMove(base, { type: "close", panel: 0 }, proceed);
    expect(proceed).toHaveBeenCalledOnce();
  });

  it("asks several panels one after the other when one move would lose them all", () => {
    off = probeAt(960, true);
    const base = explore(note(1), note(2));
    const first = guarded(keyOf(base, 0));
    const second = guarded(keyOf(base, 1));
    const order: string[] = [];
    first.mockImplementation((go: () => void) => {
      order.push("first");
      go();
    });
    second.mockImplementation((go: () => void) => {
      order.push("second");
      go();
    });
    const dispatch = vi.fn(() => order.push("dispatch"));
    // Closing the second panel loses only that panel: only its guard is asked.
    guardedMove(base, { type: "close", panel: 1 }, dispatch);
    expect(order).toEqual(["second", "dispatch"]);
  });
});
