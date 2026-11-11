import { describe, expect, it } from "vitest";

import { destinationIds, destinationRoots, navigatorDefaults } from "./destinations";
import { layoutConfig } from "./layout-config";
import {
  WorkspaceStateSchema,
  contextTabFor,
  defaultWorkspace,
  initialState,
  layout,
  localDay,
  reduce,
  stackWidth,
  workspaceLimits,
  type LayoutChrome,
  type Stack,
  type WorkspaceAction,
  type WorkspaceState
} from "./state";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const note = (n: number) => `memora://note/${uuid(n)}`;
const source = (n: number) => `memora://source/${uuid(n)}`;
const today = "2026-11-11";

const run = (state: WorkspaceState, ...actions: WorkspaceAction[]) =>
  actions.reduce((current, action) => reduce(current, action), state);
const push = (address: string, from: number): WorkspaceAction => ({
  type: "open",
  address,
  from,
  mode: "push"
});
const replace = (address: string, from: number): WorkspaceAction => ({
  type: "open",
  address,
  from,
  mode: "replace"
});
const explore = (state: WorkspaceState) => state.stacks.explore;
const addresses = (stack: Stack) => stack.panels.map((panel) => panel.history[panel.index]);
const start = () => reduce(defaultWorkspace(today), { type: "go", destination: "explore" });
/** Explore with notes 1..n pushed one after another. */
const trail = (n: number) =>
  run(start(), ...Array.from({ length: n }, (_, index) => push(note(index + 1), index - 1)));

describe("defaults", () => {
  it("starts on Home with an empty stack per destination and the default navigators", () => {
    const state = defaultWorkspace(today);
    expect(state.destination).toBe("home");
    expect(Object.keys(state.stacks)).toEqual([...destinationIds]);
    for (const destination of destinationIds)
      expect(state.stacks[destination]).toEqual({
        root: destinationRoots[destination],
        panels: [],
        focus: -1,
        closed: []
      });
    expect(state.navigator).toEqual(navigatorDefaults);
    expect(state.navigator).toMatchObject({ explore: true, library: false });
    expect(state).toMatchObject({
      context: false,
      lastHomeDay: today,
      lastHomeOpenAt: null,
      contextTab: {},
      hoist: null,
      density: "comfortable"
    });
    expect(WorkspaceStateSchema.safeParse(state).success).toBe(true);
  });
});

describe("reduce: push and replace", () => {
  it("pushes right of the clicked panel and focuses the new one", () => {
    const state = trail(2);
    expect(addresses(explore(state))).toEqual([note(1), note(2)]);
    expect(explore(state).focus).toBe(1);
    expect(explore(state).panels.map((panel) => panel.id)).toEqual(["p1", "p2"]);
  });

  it("moves the panels right of the clicked one to the closed list", () => {
    const state = run(trail(3), push(note(9), 0));
    expect(addresses(explore(state))).toEqual([note(1), note(9)]);
    expect(explore(state).focus).toBe(1);
    // The leftmost dropped panel is the next to reopen.
    expect(explore(state).closed.map((panel) => panel.history[0])).toEqual([note(3), note(2)]);
    expect(explore(state).panels[1]?.id).toBe("p4");
  });

  it("pushes from the root, closing every panel", () => {
    const state = run(trail(2), push(note(7), -1));
    expect(addresses(explore(state))).toEqual([note(7)]);
    expect(explore(state).closed).toHaveLength(2);
  });

  it("focuses an address that is already open instead of opening it again", () => {
    const state = trail(3);
    const focused = reduce(state, push(note(1), 2));
    expect(addresses(explore(focused))).toEqual([note(1), note(2), note(3)]);
    expect(explore(focused).focus).toBe(0);
    expect(explore(focused).closed).toEqual([]);
    expect(explore(reduce(state, push(destinationRoots.explore, 2))).focus).toBe(-1);
    // Focusing the panel that already has focus changes nothing.
    expect(reduce(state, push(note(3), 1))).toBe(state);
  });

  it("replaces into the clicked panel's history and truncates its forward entries", () => {
    let state = run(trail(2), replace(note(5), 0));
    expect(addresses(explore(state))).toEqual([note(5), note(2)]);
    expect(explore(state).panels[0]).toMatchObject({ history: [note(1), note(5)], index: 1 });
    expect(explore(state).focus).toBe(0);
    state = run(state, { type: "back" }, replace(note(6), 0));
    expect(explore(state).panels[0]).toMatchObject({ history: [note(1), note(6)], index: 1 });
  });

  it("treats a replace from the root as a push", () => {
    const state = run(trail(1), replace(note(4), -1));
    expect(addresses(explore(state))).toEqual([note(4)]);
  });

  it("ignores invalid addresses and out-of-range origins", () => {
    const state = trail(2);
    expect(reduce(state, push("memora://nowhere", 0))).toBe(state);
    expect(reduce(state, push(`memora://open/source/${uuid(1)}`, 0))).toBe(state);
    expect(reduce(state, push(note(9), 2))).toBe(state);
    expect(reduce(state, push(note(9), -2))).toBe(state);
    expect(reduce(state, push(note(9), 0.5))).toBe(state);
  });

  it("opens view panels such as search, ask and import", () => {
    const state = run(start(), push("memora://search?q=x", -1), push("memora://ask", 0));
    expect(addresses(explore(state))).toEqual(["memora://search?q=x", "memora://ask"]);
  });

  it("sets a destination's root from its own view address, keeping its panels", () => {
    let state = run(trail(2), { type: "go", destination: "map" }, push(source(1), -1));
    state = reduce(state, push("memora://map/shape", 0));
    expect(state.destination).toBe("map");
    expect(state.stacks.map).toMatchObject({ root: "memora://map/shape", focus: -1 });
    expect(addresses(state.stacks.map)).toEqual([source(1)]);
    // Another destination's view goes there.
    state = reduce(state, push("memora://library?tab=questions", 0));
    expect(state.destination).toBe("library");
    expect(state.stacks.library.root).toBe("memora://library?tab=questions");
    expect(addresses(explore(state))).toEqual([note(1), note(2)]);
    // A Settings address goes to Settings; nothing opens there.
    state = reduce(state, push("memora://settings/privacy", -1));
    expect(state.destination).toBe("settings");
    expect(reduce(state, push(note(3), -1))).toBe(state);
  });
});

describe("reduce: history, close and reopen", () => {
  it("moves back and forward through the focused panel's history", () => {
    let state = run(trail(1), replace(note(2), 0), replace(note(3), 0));
    state = run(state, { type: "back" }, { type: "back" });
    expect(explore(state).panels[0]?.index).toBe(0);
    state = reduce(state, { type: "forward" });
    expect(explore(state).panels[0]?.index).toBe(1);
    const atEnd = run(state, { type: "forward" });
    expect(reduce(atEnd, { type: "forward" })).toBe(atEnd);
  });

  it("closes a panel when Back reaches its start, and Forward right after reopens it", () => {
    const state = trail(3);
    const closed = reduce(state, { type: "back" });
    expect(addresses(explore(closed))).toEqual([note(1), note(2)]);
    expect(explore(closed).focus).toBe(1);
    expect(explore(closed).forwardReopens).toBe(true);
    const reopened = reduce(closed, { type: "forward" });
    expect(addresses(explore(reopened))).toEqual([note(1), note(2), note(3)]);
    expect(explore(reopened).focus).toBe(2);
    expect(explore(reopened).panels[2]?.id).toBe("p3");
    expect(explore(reopened).forwardReopens).toBeUndefined();
  });

  it("reopens on Forward only right after the close", () => {
    // The left panel has its own forward entry; right after a close, Forward still reopens.
    let state = run(trail(1), replace(note(5), 0), { type: "back" }, push(note(2), 0));
    state = run(state, { type: "back" });
    expect(addresses(explore(state))).toEqual([note(1)]);
    expect(addresses(explore(reduce(state, { type: "forward" })))).toEqual([note(1), note(2)]);
    // After another move, Forward walks the focused panel's history instead.
    state = run(state, { type: "focus", panel: -1 }, { type: "focus", panel: 0 });
    state = reduce(state, { type: "forward" });
    expect(addresses(explore(state))).toEqual([note(5)]);
  });

  it("does nothing on Back at the root", () => {
    const state = run(trail(1), { type: "focus", panel: -1 });
    expect(reduce(state, { type: "back" })).toBe(state);
  });

  it("closes the focused panel or a given one and keeps focus on the same panel", () => {
    const state = trail(3);
    const focusedClosed = reduce(state, { type: "close" });
    expect(addresses(explore(focusedClosed))).toEqual([note(1), note(2)]);
    expect(explore(focusedClosed).focus).toBe(1);
    const leftClosed = reduce(state, { type: "close", panel: 0 });
    expect(addresses(explore(leftClosed))).toEqual([note(2), note(3)]);
    expect(explore(leftClosed).focus).toBe(1);
    const rightClosed = reduce(reduce(state, { type: "focus", panel: 0 }), {
      type: "close",
      panel: 2
    });
    expect(explore(rightClosed).focus).toBe(0);
    const lastClosed = reduce(trail(1), { type: "close" });
    expect(explore(lastClosed).focus).toBe(-1);
    expect(reduce(state, { type: "close", panel: 3 })).toBe(state);
    const atRoot = reduce(state, { type: "focus", panel: -1 });
    expect(reduce(atRoot, { type: "close" })).toBe(atRoot);
  });

  it("reopens from the closed list, most recent first, right of the focused panel", () => {
    let state = run(trail(3), push(note(9), 0));
    state = reduce(state, { type: "reopen" });
    expect(addresses(explore(state))).toEqual([note(1), note(9), note(2)]);
    expect(explore(state).focus).toBe(2);
    state = reduce(state, { type: "reopen" });
    expect(addresses(explore(state))).toEqual([note(1), note(9), note(2), note(3)]);
    expect(explore(state).closed).toEqual([]);
    expect(reduce(state, { type: "reopen" })).toBe(state);
  });

  it("focuses a reopened address that is already open instead of duplicating it", () => {
    let state = run(trail(2), { type: "close" }, push(note(2), 0));
    state = reduce(state, { type: "reopen" });
    expect(addresses(explore(state))).toEqual([note(1), note(2)]);
    expect(explore(state).focus).toBe(1);
    expect(explore(state).closed).toEqual([]);
  });

  it("keeps at most 20 closed panels, dropping the oldest", () => {
    let state = start();
    for (let n = 1; n <= 25; n += 1) state = reduce(state, push(note(n), -1));
    const closed = explore(state).closed;
    expect(closed).toHaveLength(workspaceLimits.maxClosed);
    expect(closed[0]?.history[0]).toBe(note(5));
    expect(closed.at(-1)?.history[0]).toBe(note(24));
  });

  it("bounds a panel's history, dropping the oldest entries", () => {
    let state = trail(1);
    for (let n = 2; n <= 60; n += 1) state = reduce(state, replace(note(n), 0));
    const panel = explore(state).panels[0]!;
    expect(panel.history).toHaveLength(workspaceLimits.maxHistory);
    expect(panel.history[panel.index]).toBe(note(60));
    expect(panel.history[0]).toBe(note(11));
  });
});

describe("reduce: the panel cap", () => {
  it("evicts the leftmost panel that is not focused when a 9th opens", () => {
    const eight = trail(8);
    const nine = reduce(eight, push(note(9), 7));
    expect(addresses(explore(nine))).toEqual([2, 3, 4, 5, 6, 7, 8, 9].map(note));
    expect(explore(nine).focus).toBe(7);
    expect(explore(nine).closed.map((panel) => panel.history[0])).toEqual([note(1)]);
  });

  it("never evicts the focused panel", () => {
    // Reopened from the root, the first panel is the focused one: the second goes instead.
    let state = run(trail(8), push(note(9), 7), { type: "focus", panel: -1 });
    state = reduce(state, { type: "reopen" });
    expect(addresses(explore(state))).toEqual([1, 3, 4, 5, 6, 7, 8, 9].map(note));
    expect(explore(state).focus).toBe(0);
    expect(explore(state).closed.map((panel) => panel.history[0])).toEqual([note(2)]);
  });

  it("follows a smaller cap", () => {
    let state = start();
    for (let n = 1; n <= 4; n += 1) state = reduce(state, push(note(n), n - 2), { maxPanels: 3 });
    expect(addresses(explore(state))).toEqual([note(2), note(3), note(4)]);
  });
});

describe("reduce: focus, destinations and toggles", () => {
  it("focuses a panel or the root and cycles focus with Ctrl-Tab", () => {
    let state = trail(2);
    state = reduce(state, { type: "focus", panel: 0 });
    expect(explore(state).focus).toBe(0);
    expect(reduce(state, { type: "focus", panel: 0 })).toBe(state);
    expect(reduce(state, { type: "focus", panel: 5 })).toBe(state);
    state = reduce(state, { type: "focusNext", delta: 1 });
    expect(explore(state).focus).toBe(1);
    state = reduce(state, { type: "focusNext", delta: 1 });
    expect(explore(state).focus).toBe(-1);
    state = reduce(state, { type: "focusNext", delta: -1 });
    expect(explore(state).focus).toBe(1);
    expect(reduce(start(), { type: "focusNext", delta: 1 }).stacks.explore.focus).toBe(-1);
  });

  it("go changes the destination and keeps every stack", () => {
    const state = run(trail(3), { type: "go", destination: "library" }, push(source(1), -1));
    const away = run(
      state,
      { type: "go", destination: "settings" },
      { type: "go", destination: "map" }
    );
    expect(away.destination).toBe("map");
    expect(away.stacks).toEqual(state.stacks);
    const back = reduce(away, { type: "go", destination: "explore" });
    expect(back.stacks.explore).toBe(state.stacks.explore);
    expect(reduce(back, { type: "go", destination: "explore" })).toBe(back);
  });

  it("toggles the navigator of the current destination and the context panel", () => {
    let state = start();
    state = reduce(state, { type: "toggleNavigator" });
    expect(state.navigator.explore).toBe(false);
    expect(state.navigator.library).toBe(false);
    state = reduce(state, { type: "toggleContext" });
    expect(state.context).toBe(true);
    const settings = reduce(state, { type: "go", destination: "settings" });
    expect(reduce(settings, { type: "toggleNavigator" })).toBe(settings);
  });

  it("does nothing to stacks while in Settings", () => {
    const state = reduce(trail(2), { type: "go", destination: "settings" });
    for (const action of [
      { type: "back" },
      { type: "forward" },
      { type: "close" },
      { type: "reopen" },
      { type: "focus", panel: 0 },
      { type: "focusNext", delta: 1 },
      { type: "resize", panel: 0, width: 600 },
      { type: "scroll", panel: 0, top: 200 },
      { type: "redirect", panel: 0, to: note(5) }
    ] as WorkspaceAction[])
      expect(reduce(state, action), action.type).toBe(state);
  });
});

describe("reduce: redirect and resize", () => {
  it("swaps a panel's address in its history without a new entry", () => {
    const topicA = `memora://topic/${uuid(70)}`;
    const topicB = `memora://topic/${uuid(71)}`;
    let state = run(trail(1), replace(topicA, 0), replace(note(2), 0), { type: "back" });
    state = reduce(state, { type: "redirect", panel: 0, to: topicB });
    expect(explore(state).panels[0]).toMatchObject({
      history: [note(1), topicB, note(2)],
      index: 1
    });
    expect(reduce(state, { type: "redirect", panel: 0, to: topicB })).toBe(state);
    expect(reduce(state, { type: "redirect", panel: 3, to: topicA })).toBe(state);
    expect(reduce(state, { type: "redirect", panel: 0, to: "memora://nowhere" })).toBe(state);
  });

  it("never leaves one address open in two panels", () => {
    const three = run(start(), push(source(1), -1), push(source(2), 0), push(source(3), 1));
    // Panel 0 (focused) is redirected to an address panel 2 shows: panel 0 goes, panel 2 is focused.
    let state = run(
      three,
      { type: "focus", panel: 0 },
      { type: "redirect", panel: 0, to: source(3) }
    );
    expect(addresses(explore(state))).toEqual([source(2), source(3)]);
    expect(explore(state).focus).toBe(1);
    // An unfocused panel redirected to an open address goes; the focus stays on its panel.
    state = reduce(three, { type: "redirect", panel: 0, to: source(2) });
    expect(addresses(explore(state))).toEqual([source(2), source(3)]);
    expect(explore(state).focus).toBe(1);
    // Redirected to the root's address, the panel goes and the root is focused.
    state = reduce(three, { type: "redirect", panel: 2, to: destinationRoots.explore });
    expect(addresses(explore(state))).toEqual([source(1), source(2)]);
    expect(explore(state).focus).toBe(-1);
  });

  it("does not take a pending reopen away", () => {
    let state = run(trail(2), { type: "close" });
    state = reduce(state, { type: "redirect", panel: 0, to: note(8) });
    expect(explore(state).forwardReopens).toBe(true);
  });

  it("stores a panel width, rounded and kept within bounds", () => {
    let state = trail(1);
    state = reduce(state, { type: "resize", panel: 0, width: 612.6 });
    expect(explore(state).panels[0]?.width).toBe(613);
    expect(reduce(state, { type: "resize", panel: 0, width: 613 })).toBe(state);
    expect(explore(reduce(state, { type: "resize", panel: 0, width: 10 })).panels[0]?.width).toBe(
      workspaceLimits.minPanelWidth
    );
    expect(explore(reduce(state, { type: "resize", panel: 0, width: 1e9 })).panels[0]?.width).toBe(
      workspaceLimits.maxPanelWidth
    );
    expect(reduce(state, { type: "resize", panel: 0, width: Number.NaN })).toBe(state);
    expect(reduce(state, { type: "resize", panel: -1, width: 500 })).toBe(state);
  });
});

describe("reduce: the S1 view state", () => {
  const topic = (n: number) => uuid(n);

  it("firstSource goes to Explore and pushes the Source right of its focused panel (A6)", () => {
    const home = defaultWorkspace(today);
    const state = reduce(home, { type: "firstSource", address: source(1) });
    expect(state.destination).toBe("explore");
    expect(addresses(explore(state))).toEqual([source(1)]);
    expect(explore(state).focus).toBe(0);
    for (const destination of destinationIds)
      if (destination !== "explore")
        expect(state.stacks[destination]).toBe(home.stacks[destination]);
    // Dispatched again, it focuses the open Source instead of opening it twice.
    const again = reduce(reduce(state, { type: "go", destination: "home" }), {
      type: "firstSource",
      address: source(1)
    });
    expect(again.destination).toBe("explore");
    expect(addresses(explore(again))).toEqual([source(1)]);
    // Only a Source address is a first source.
    expect(reduce(home, { type: "firstSource", address: note(1) })).toBe(home);
    expect(reduce(home, { type: "firstSource", address: "memora://library" })).toBe(home);
  });

  it("setContextTab remembers the last tab per kind over the §5.6 defaults", () => {
    let state = defaultWorkspace(today);
    expect(contextTabFor(state, "note")).toBe("connections");
    expect(contextTabFor(state, "question")).toBe("evidence");
    expect(contextTabFor(state, "entity")).toBe("ask");
    expect(contextTabFor(state, "topic")).toBe("connections");
    expect(contextTabFor(state, "source")).toBe("connections");
    expect(contextTabFor(state, "source", { sourceGenerating: true })).toBe("ask");
    state = reduce(state, { type: "setContextTab", kind: "note", tab: "graph" });
    expect(state.contextTab).toEqual({ note: "graph" });
    expect(contextTabFor(state, "note")).toBe("graph");
    expect(reduce(state, { type: "setContextTab", kind: "note", tab: "graph" })).toBe(state);
    expect(
      reduce(state, {
        type: "setContextTab",
        kind: "wiki",
        tab: "ask"
      } as unknown as WorkspaceAction)
    ).toBe(state);
    expect(
      reduce(state, {
        type: "setContextTab",
        kind: "note",
        tab: "activity"
      } as unknown as WorkspaceAction)
    ).toBe(state);
    expect(WorkspaceStateSchema.safeParse(state).success).toBe(true);
  });

  it("hoist sets and clears Explore's hoisted topic", () => {
    let state = defaultWorkspace(today);
    state = reduce(state, { type: "hoist", topicId: topic(5) });
    expect(state.hoist).toBe(topic(5));
    expect(reduce(state, { type: "hoist", topicId: topic(5) })).toBe(state);
    expect(reduce(state, { type: "hoist", topicId: "not-an-id" })).toBe(state);
    expect(WorkspaceStateSchema.safeParse(state).success).toBe(true);
    expect(reduce(state, { type: "hoist", topicId: null }).hoist).toBeNull();
  });

  it("setDensity switches the Library density", () => {
    const state = reduce(defaultWorkspace(today), { type: "setDensity", density: "compact" });
    expect(state.density).toBe("compact");
    expect(reduce(state, { type: "setDensity", density: "compact" })).toBe(state);
    expect(
      reduce(state, { type: "setDensity", density: "dense" } as unknown as WorkspaceAction)
    ).toBe(state);
  });

  it("scroll stores a panel's offset, rounded and bounded", () => {
    let state = trail(2);
    state = reduce(state, { type: "scroll", panel: 0, top: 320.4 });
    expect(explore(state).panels[0]?.scroll).toBe(320);
    expect(reduce(state, { type: "scroll", panel: 0, top: 320 })).toBe(state);
    expect(explore(reduce(state, { type: "scroll", panel: 1, top: -5 })).panels[1]?.scroll).toBe(
      undefined
    );
    expect(explore(reduce(state, { type: "scroll", panel: 1, top: 1e12 })).panels[1]?.scroll).toBe(
      workspaceLimits.maxScroll
    );
    expect(reduce(state, { type: "scroll", panel: 0, top: Number.NaN })).toBe(state);
    expect(reduce(state, { type: "scroll", panel: 5, top: 10 })).toBe(state);
    expect(WorkspaceStateSchema.safeParse(state).success).toBe(true);
  });
});

describe("reduce: homeOpened", () => {
  it("records when Home was opened and its local day", () => {
    const state = reduce(
      defaultWorkspace("2026-11-10"),
      { type: "homeOpened", at: "2026-11-11T08:30:00+00:00" },
      { maxPanels: 8, timeZone: "Europe/London" }
    );
    expect(state.lastHomeOpenAt).toBe("2026-11-11T08:30:00.000Z");
    expect(state.lastHomeDay).toBe("2026-11-11");
    expect(WorkspaceStateSchema.safeParse(state).success).toBe(true);
    expect(reduce(state, { type: "homeOpened", at: "yesterday" })).toBe(state);
  });
});

describe("initialState: the Home rule", () => {
  const london = { timeZone: "Europe/London" };
  const saved = (lastHomeDay: string) => ({
    ...run(trail(2), { type: "toggleContext" }),
    lastHomeDay
  });

  it("opens Home on first run", () => {
    const state = initialState(new Date("2026-11-11T09:00:00Z"), null, london);
    expect(state).toEqual(defaultWorkspace("2026-11-11"));
  });

  it("restores the last place on a later start the same local day", () => {
    const persisted = JSON.parse(JSON.stringify(saved("2026-11-11"))) as unknown;
    const state = initialState(new Date("2026-11-11T23:59:59Z"), persisted, london);
    expect(state.destination).toBe("explore");
    expect(state).toEqual(persisted);
  });

  it("opens Home on the first start of a new local day and keeps the stacks", () => {
    const persisted = saved("2026-11-11");
    const state = initialState(new Date("2026-11-12T00:00:01Z"), persisted, london);
    expect(state.destination).toBe("home");
    expect(state.lastHomeDay).toBe("2026-11-12");
    expect(state.stacks).toEqual(persisted.stacks);
    expect(state.context).toBe(true);
  });

  it("uses the local day, not the UTC day, in summer time", () => {
    // 23:30 UTC on 1 July is 00:30 on 2 July in London (BST, UTC+1).
    const now = new Date("2026-07-01T23:30:00Z");
    expect(localDay(now, "Europe/London")).toBe("2026-07-02");
    expect(initialState(now, saved("2026-07-01"), london).destination).toBe("home");
    expect(initialState(now, saved("2026-07-02"), london).destination).toBe("explore");
    // Across the October change back to GMT: 00:30 UTC on 25 October is 01:30 BST, then GMT.
    expect(localDay(new Date("2026-10-24T23:30:00Z"), "Europe/London")).toBe("2026-10-25");
    expect(localDay(new Date("2026-10-25T23:30:00Z"), "Europe/London")).toBe("2026-10-25");
    expect(localDay(new Date("2026-10-26T00:00:00Z"), "Europe/London")).toBe("2026-10-26");
  });

  it("falls back to the defaults when the persisted value does not validate", () => {
    const now = new Date("2026-11-11T09:00:00Z");
    const valid = saved("2026-11-11");
    const broken: unknown[] = [
      undefined,
      "text",
      [],
      { ...valid, version: 0 },
      { ...valid, version: 2 },
      { ...valid, extra: true },
      { ...valid, destination: "wiki" },
      { ...valid, lastHomeDay: "11/11/2026" },
      { ...valid, lastHomeOpenAt: "noon" },
      { ...valid, stacks: { ...valid.stacks, explore: { ...valid.stacks.explore, focus: 2 } } },
      {
        ...valid,
        stacks: { ...valid.stacks, explore: { ...valid.stacks.explore, root: "memora://home" } }
      },
      {
        ...valid,
        stacks: {
          ...valid.stacks,
          explore: {
            ...valid.stacks.explore,
            panels: [{ id: "p1", history: ["memora://nowhere"], index: 0 }]
          }
        }
      },
      {
        ...valid,
        stacks: {
          ...valid.stacks,
          explore: {
            ...valid.stacks.explore,
            panels: [{ id: "p1", history: [note(1)], index: 1 }]
          }
        }
      },
      {
        ...valid,
        stacks: {
          ...valid.stacks,
          explore: {
            ...valid.stacks.explore,
            panels: [
              { id: "p1", history: [note(1)], index: 0 },
              { id: "p1", history: [note(2)], index: 0 }
            ]
          }
        }
      }
    ];
    for (const persisted of broken)
      expect(initialState(now, persisted, london), JSON.stringify(persisted)).toEqual(
        defaultWorkspace("2026-11-11")
      );
  });

  it("falls back to the system zone when the zone is unknown", () => {
    const now = new Date("2026-11-11T12:00:00Z");
    expect(localDay(now, "Nowhere/Invalid")).toBe(localDay(now));
  });
});

describe("layout (A1)", () => {
  const stackOf = (count: number, focus = count - 1): Stack => ({
    root: destinationRoots.explore,
    panels: Array.from({ length: count }, (_, index) => ({
      id: `p${index + 1}`,
      history: [note(index + 1)],
      index: 0
    })),
    focus,
    closed: []
  });
  const on: LayoutChrome = { navigator: true, context: true };
  const noNavigator: LayoutChrome = { navigator: false, context: true };
  const bare: LayoutChrome = { navigator: false, context: false };
  /** F full, c compact, s spine, m a spine inside the "+N" spine; root first. */
  const modes = (stack: Stack, width: number, chrome: LayoutChrome = on) =>
    layout(stack, width, undefined, chrome)
      .map((item) =>
        item.mode === "full" ? "F" : item.mode === "compact" ? "c" : item.merged ? "m" : "s"
      )
      .join("");
  /** The top panel's width under the result. */
  const topWidth = (stack: Stack, width: number, chrome: LayoutChrome = on) => {
    const items = layout(stack, width, undefined, chrome);
    const tier = width >= 1440 ? 240 : width >= 1180 ? 224 : 216;
    const merged = items.filter((item) => item.merged).length;
    const spines =
      items.filter((item) => item.mode === "spine" && !item.merged).length + (merged > 0 ? 1 : 0);
    const compact = items.some((item) => item.mode === "compact") ? tier : 0;
    return stackWidth(width, chrome) - compact - spines * 40;
  };

  it("takes the stack width from the window less the rail, navigator and context panel", () => {
    // 960: compact tier, context as a 40 px strip.
    expect(stackWidth(960, on)).toBe(960 - 64 - 224 - 40);
    expect(stackWidth(960, noNavigator)).toBe(960 - 64 - 40);
    expect(stackWidth(960, bare)).toBe(960 - 64);
    // 1280: docked context.
    expect(stackWidth(1280, on)).toBe(1280 - 72 - 256 - 304);
    expect(stackWidth(1440, on)).toBe(1440 - 72 - 272 - 320);
    expect(stackWidth(1440, bare)).toBe(1440 - 72);
  });

  it("shows the root alone in full", () => {
    for (const width of [960, 1280, 1440])
      expect(layout(stackOf(0), width)).toEqual([{ panel: -1, mode: "full" }]);
  });

  it("at 960 keeps the top at 552 with two spines and merges older spines", () => {
    expect([1, 2, 3, 4, 5, 6, 7, 8].map((count) => modes(stackOf(count), 960))).toEqual([
      "sF",
      "ssF",
      "mmsF",
      "mmmsF",
      "mmmmsF",
      "mmmmmsF",
      "mmmmmmsF",
      "mmmmmmmsF"
    ]);
    for (let count = 2; count <= 8; count += 1)
      expect(topWidth(stackOf(count), 960)).toBe(layoutConfig.topMinAtWindowMin);
    // 999 still bends the floor; 1000 does not.
    expect(modes(stackOf(3), 999)).toBe("mmsF");
    expect(topWidth(stackOf(2), 1000)).toBe(592);
  });

  it("at 960 without the navigator shows the previous panel compact from an 848 px stack", () => {
    expect(stackWidth(960, noNavigator)).toBeGreaterThanOrEqual(848);
    expect([1, 2, 3, 4, 8].map((count) => modes(stackOf(count), 960, noNavigator))).toEqual([
      "cF",
      "scF",
      "sscF",
      // Two spines and the compact panel would leave the top 520 < 552: the previous folds first.
      "ssssF",
      "mmssssssF"
    ]);
    // Without the strip either, the stack is 896.
    expect(modes(stackOf(4), 960, bare)).toBe("ssscF");
  });

  it("at 1280 keeps the top at 568 with two spines and the context docked", () => {
    expect([1, 2, 3, 5, 8].map((count) => modes(stackOf(count), 1280))).toEqual([
      "sF",
      "ssF",
      "mmsF",
      "mmmmsF",
      "mmmmmmmsF"
    ]);
    for (const count of [2, 3, 5, 8]) expect(topWidth(stackOf(count), 1280)).toBe(568);
    // Without the navigator the stack is 904 ≥ 848: the previous panel shows while the top keeps 568.
    expect([1, 2, 3, 4].map((count) => modes(stackOf(count), 1280, noNavigator))).toEqual([
      "cF",
      "scF",
      "sscF",
      "ssssF"
    ]);
    // At 1200 (narrow tier, context strip) the stack is 832 < 848: the previous panel is a spine.
    expect(stackWidth(1200, on)).toBe(832);
    expect(modes(stackOf(2), 1200, on)).toBe("ssF");
  });

  it("at 1440 shows the previous panel only from an 848 px stack and merges past 6 spines", () => {
    // 776 px with the navigator and the docked context: no compact panel.
    expect([1, 3, 5, 6, 8].map((count) => modes(stackOf(count), 1440))).toEqual([
      "sF",
      "sssF",
      "sssssF",
      "mmssssF",
      "mmmmssssF"
    ]);
    for (const count of [5, 6, 8])
      expect(topWidth(stackOf(count), 1440)).toBeGreaterThanOrEqual(568);
    // Bare, 1368 px: the previous panel is compact and the spines past 6 merge into "+N".
    expect([1, 2, 7, 8].map((count) => modes(stackOf(count), 1440, bare))).toEqual([
      "cF",
      "scF",
      "sssssscF",
      "msssssscF"
    ]);
    expect(layout(stackOf(8), 1440, undefined, bare)[0]).toEqual({
      panel: -1,
      mode: "spine",
      merged: true
    });
    expect(topWidth(stackOf(8), 1440, bare)).toBe(1368 - 240 - 7 * 40);
  });

  it("keeps panels right of the top as spines and the root as the top when focused", () => {
    expect(modes(stackOf(5, 2), 1440, bare)).toBe("sscFss");
    expect(modes(stackOf(5, -1), 1440, bare)).toBe("Fsssss");
    expect(modes(stackOf(5, 0), 1440, bare)).toBe("cFssss");
  });

  it("honours an explicit floor", () => {
    expect(modes(stackOf(3), 1280, on)).toBe("mmsF");
    expect(layout(stackOf(3), 1280, 400, on).map((item) => item.mode)).toEqual([
      "spine",
      "spine",
      "spine",
      "full"
    ]);
  });
});

describe("limits", () => {
  it("keeps the calibrated workspace numbers", () => {
    expect(workspaceLimits).toMatchObject({
      maxPanels: 8,
      maxClosed: 20,
      minPanelWidth: 216
    });
  });
});
