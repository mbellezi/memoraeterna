import { describe, expect, it } from "vitest";
import { createTranslator } from "@app/i18n";

import type { SearchOmniItem } from "../../../shared/ipc-search";
import { parseAddress, routeLimits } from "../route";
import { defaultWorkspace } from "../state";
import { matchCommands, resolveCommands, runCommand, type PaletteActions } from "./commands";
import {
  activate,
  askAddress,
  buildPalette,
  moreEffect,
  omniParamsFor,
  openActions,
  paletteKey,
  parsePaletteQuery,
  reconcileSelection,
  searchAllEffect,
  withPrefix,
  type BuildInput,
  type RecentEntry
} from "./palette-model";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const item = (kind: SearchOmniItem["kind"], n: number, title = `${kind} ${n}`): SearchOmniItem => ({
  address: `memora://${kind}/${uuid(n)}`,
  kind,
  title,
  arms: [{ arm: "title_trgm", rank: n }],
  score: 1 / (60 + n)
});
const en = createTranslator("en");
const state = defaultWorkspace("2026-11-11");
const commands = resolveCommands(en, state);
const recents: RecentEntry[] = [
  { address: item("topic", 1).address, kind: "topic", title: "Fermentation", pinned: true },
  { address: item("note", 2).address, kind: "note", title: "Kefir", pinned: false }
];

const build = (raw: string, items: SearchOmniItem[] = [], settled = true, extra = {}) =>
  buildPalette({
    parsed: parsePaletteQuery(raw),
    items,
    settled,
    recents,
    commands,
    ...extra
  } satisfies BuildInput);

describe("the prefix", () => {
  it("changes the mode only at the start of the box", () => {
    expect(parsePaletteQuery("> tema")).toEqual({ mode: "actions", prefix: ">", text: "tema" });
    expect(parsePaletteQuery("?why")).toEqual({ mode: "ask", prefix: "?", text: "why" });
    expect(parsePaletteQuery("#  topic ")).toEqual({ mode: "topics", prefix: "#", text: "topic" });
    expect(parsePaletteQuery("@pasteur").mode).toBe("entities");
    expect(parsePaletteQuery("what is # this?")).toEqual({
      mode: "all",
      prefix: null,
      text: "what is # this?"
    });
  });

  it("is swapped or taken off by a chip", () => {
    expect(withPrefix("ferment", "#")).toBe("# ferment");
    expect(withPrefix("# ferment", "@")).toBe("@ ferment");
    expect(withPrefix("# ferment", null)).toBe("ferment");
    expect(withPrefix("", ">")).toBe("> ");
  });

  it("asks search.omni in quick mode, narrowed for # and @, and nothing for > ? or an empty box", () => {
    expect(omniParamsFor(parsePaletteQuery("ferment"))).toMatchObject({
      query: "ferment",
      mode: "quick"
    });
    expect(omniParamsFor(parsePaletteQuery("# ferment"))?.kinds).toEqual(["topic"]);
    expect(omniParamsFor(parsePaletteQuery("@ pas"))?.kinds).toEqual(["entity"]);
    expect(omniParamsFor(parsePaletteQuery("> tema"))).toBeNull();
    expect(omniParamsFor(parsePaletteQuery("? why"))).toBeNull();
    expect(omniParamsFor(parsePaletteQuery("  "))).toBeNull();
  });
});

describe("the groups", () => {
  const items = [
    item("topic", 1),
    item("topic", 2),
    item("note", 3),
    item("topic", 4),
    item("source", 5),
    item("topic", 6),
    item("topic", 7),
    item("entity", 8),
    item("question", 9)
  ];

  it("lists the best result, then topics, notes, sources and entities, questions, and Fazer last", () => {
    const view = build("ferment", items);
    expect(view.groups.map((group) => group.id)).toEqual([
      "best",
      "topic",
      "note",
      "sourceEntity",
      "question",
      "do"
    ]);
    expect(view.groups[0]?.rows[0]?.id).toBe(`result:${items[0]?.address}`);
  });

  it("shows three rows per group, with the count and the hidden rest", () => {
    const topics = build("ferment", items).groups.find((group) => group.id === "topic");
    expect(topics?.rows).toHaveLength(3);
    // The best result is not repeated: 5 topics were returned, one of them is the best result.
    expect(topics).toMatchObject({ count: 4, hidden: 1, moreKinds: ["topic"] });
    const mixed = build("ferment", items).groups.find((group) => group.id === "sourceEntity");
    expect(mixed).toMatchObject({ count: 2, hidden: 0 });
  });

  it("opens the results panel filtered to the group's kinds with 'mostrar mais'", () => {
    const parsed = parsePaletteQuery("ferment");
    const topics = build("ferment", items).groups.find((group) => group.id === "topic")!;
    expect(moreEffect(topics, parsed)).toEqual({
      type: "open",
      address: "memora://search?q=ferment&kinds=topic",
      replace: false
    });
    const mixed = build("ferment", items).groups.find((group) => group.id === "sourceEntity")!;
    expect(moreEffect(mixed, parsed)).toBeNull();
  });

  it("ends with 'Fazer': ask first, then the commands the query finds", () => {
    const view = build("theme", [item("note", 1)]);
    const doing = view.groups.at(-1)!;
    expect(doing.id).toBe("do");
    expect(doing.rows.map((row) => row.id)).toEqual(["ask", "action:theme"]);
  });

  it("says nothing was found and offers to ask or to add a source", () => {
    const view = build("zzz", []);
    expect(view.empty).toBe(true);
    expect(view.groups.map((group) => group.id)).toEqual(["do"]);
    expect(view.rows.map((row) => row.id)).toEqual(["ask", "action:add-source"]);
    // Still waiting for the answer: not empty yet.
    expect(build("zzz", [], false).empty).toBe(false);
  });

  it("shows recents, pins and suggested actions for an empty box, and no ranking line", () => {
    const view = build("");
    expect(view.groups.map((group) => group.id)).toEqual(["recent", "pinned", "do"]);
    expect(view.groups[2]?.rows.every((row) => row.type === "action")).toBe(true);
    expect(view.empty).toBe(false);
  });

  it("adds the recents that hold a single typed character", () => {
    const view = build("k", [item("note", 2, "Kefir")]);
    expect(view.groups.map((group) => group.id).slice(0, 2)).toEqual(["recent", "best"]);
    // Two characters: the recents are gone.
    expect(build("ke", [item("note", 2, "Kefir")]).groups.map((group) => group.id)).not.toContain(
      "recent"
    );
  });

  it("lists every command for '>' and the question for '?'", () => {
    expect(build("> ").rows.length).toBe(commands.length);
    expect(build("> theme").rows.map((row) => row.id)).toEqual(["action:theme"]);
    expect(build("? why do ferments keep").rows).toEqual([
      { type: "ask", id: "ask", question: "why do ferments keep" }
    ]);
    expect(build("? ").rows).toEqual([]);
  });

  it("lists all topics for '#' without a best result", () => {
    const view = build("# fer", [item("topic", 1), item("topic", 2)]);
    expect(view.groups.map((group) => group.id)).toEqual(["topic"]);
    expect(view.rows).toHaveLength(2);
  });

  it("keeps the selected row while it is listed, else the first", () => {
    const rows = build("ferment", items).rows;
    expect(reconcileSelection(rows[3]?.id ?? null, rows)).toBe(rows[3]?.id);
    expect(reconcileSelection("gone", rows)).toBe(rows[0]?.id);
    expect(reconcileSelection(null, [])).toBeNull();
  });
});

describe("the keys", () => {
  const key = (init: Partial<Parameters<typeof paletteKey>[0]>) =>
    paletteKey({
      key: "Enter",
      metaKey: false,
      ctrlKey: false,
      shiftKey: false,
      altKey: false,
      ...init
    });

  it("opens beside on Enter, in the panel on Option-Enter, the results panel on Shift-Enter", () => {
    expect(key({})).toEqual({ type: "activate", how: "beside" });
    expect(key({ altKey: true })).toEqual({ type: "activate", how: "here" });
    expect(key({ shiftKey: true })).toEqual({ type: "searchAll" });
  });

  it("leaves Space, arrows, Cmd-Enter and a composing Enter alone", () => {
    expect(key({ key: " " })).toBeNull();
    expect(key({ key: "ArrowDown" })).toBeNull();
    expect(key({ metaKey: true })).toBeNull();
    expect(key({ isComposing: true })).toBeNull();
    expect(key({ shiftKey: true, altKey: true })).toBeNull();
  });

  it("turns a row into what Enter does: open (replacing for Option), run, or a Question panel", () => {
    const rows = build("theme", [item("note", 1)]).rows;
    const note = rows.find((row) => row.type === "result")!;
    expect(activate(note, "beside")).toEqual({
      type: "open",
      address: item("note", 1).address,
      replace: false
    });
    expect(activate(note, "here")).toMatchObject({ replace: true });
    expect(
      activate(
        rows.find((row) => row.type === "action")!,
        "beside"
      )
    ).toEqual({
      type: "run",
      commandId: "theme"
    });
    expect(
      activate(
        rows.find((row) => row.type === "ask")!,
        "beside"
      )
    ).toEqual({
      type: "open",
      address: "memora://ask?q=theme",
      replace: false
    });
  });

  it("cuts a question longer than an address accepts instead of opening nothing", () => {
    for (const filler of ["a", "ç", "😀"]) {
      const effect = activate(
        { type: "ask", id: "ask", question: filler.repeat(routeLimits.maxTextLength + 500) },
        "beside"
      );
      expect(effect).toMatchObject({ type: "open" });
      const address = effect.type === "open" ? effect.address : "";
      expect(parseAddress(address)).not.toBeNull();
      expect(askAddress("short")).toBe("memora://ask?q=short");
    }
  });

  it("opens the results panel for the box, narrowed by its prefix, and not for > or ?", () => {
    expect(searchAllEffect(parsePaletteQuery("pH do chucrute"))).toEqual({
      type: "open",
      address: "memora://search?q=pH%20do%20chucrute",
      replace: false
    });
    expect(searchAllEffect(parsePaletteQuery("@ pas"))).toMatchObject({
      address: "memora://search?q=pas&kinds=entity"
    });
    expect(searchAllEffect(parsePaletteQuery("> theme"))).toBeNull();
    expect(searchAllEffect(parsePaletteQuery("? why"))).toBeNull();
    expect(searchAllEffect(parsePaletteQuery("   "))).toBeNull();
  });
});

describe("where an opened row goes", () => {
  const address = item("note", 1).address;

  it("pushes right of the focused panel, or replaces it", () => {
    const base = defaultWorkspace("2026-11-11");
    expect(openActions(base, address, false)).toEqual([
      { type: "open", address, from: base.stacks.home.focus, mode: "push" }
    ]);
    expect(openActions(base, address, true)[0]).toMatchObject({ mode: "replace" });
  });

  it("goes onto Explore's stack from Settings", () => {
    const settings = { ...defaultWorkspace("2026-11-11"), destination: "settings" as const };
    const actions = openActions(settings, address, false);
    expect(actions[0]).toEqual({ type: "go", destination: "explore" });
    expect(actions[1]).toMatchObject({ type: "open", from: settings.stacks.explore.focus });
  });
});

describe("the commands", () => {
  it("find a command by its label or an English keyword, accents ignored", () => {
    const pt = resolveCommands(createTranslator("pt-BR"), state);
    expect(matchCommands(pt, "tema").map((command) => command.id)).toContain("theme");
    expect(matchCommands(pt, "theme").map((command) => command.id)).toContain("theme");
    expect(matchCommands(pt, "inicio").map((command) => command.id)).toContain("go-home");
    expect(matchCommands(pt, "zzz")).toEqual([]);
  });

  it("show a shortcut only when one exists", () => {
    const find = (id: string) => commands.find((command) => command.id === id);
    expect(find("go-map")?.shortcut).toBe("⌘5");
    expect(find("theme")?.shortcut).toBeUndefined();
  });

  it("offer hoist only when the focused panel is a topic, and unhoist only when hoisted", () => {
    const ids = (workspace: typeof state) =>
      resolveCommands(en, workspace).map((command) => command.id);
    expect(ids(state)).not.toContain("hoist");
    expect(ids(state)).not.toContain("unhoist");
    const topic = `memora://topic/${uuid(5)}`;
    const explore = {
      ...state,
      destination: "explore" as const,
      stacks: {
        ...state.stacks,
        explore: {
          ...state.stacks.explore,
          focus: 0,
          panels: [{ id: "p1", history: [topic], index: 0 }]
        }
      }
    };
    expect(ids(explore)).toContain("hoist");
    expect(ids({ ...explore, hoist: uuid(5) })).toContain("unhoist");
    expect(ids({ ...explore, hoist: uuid(5) })).not.toContain("hoist");
  });

  it("run through the actions they are given, and refuse one that is not available", () => {
    const dispatched: unknown[] = [];
    const calls: string[] = [];
    const actions: PaletteActions = {
      go: (place) => calls.push(`go:${place}`),
      dispatch: (action) => dispatched.push(action),
      addSource: () => calls.push("add"),
      toggleTheme: () => calls.push("theme"),
      toggleFocusMode: () => calls.push("focus")
    };
    expect(runCommand("go-map", state, actions)).toBe(true);
    expect(runCommand("theme", state, actions)).toBe(true);
    expect(runCommand("toggle-context", state, actions)).toBe(true);
    expect(runCommand("hoist", state, actions)).toBe(false);
    expect(runCommand("nope", state, actions)).toBe(false);
    expect(calls).toEqual(["go:map", "theme"]);
    expect(dispatched).toEqual([{ type: "toggleContext" }]);
  });
});
