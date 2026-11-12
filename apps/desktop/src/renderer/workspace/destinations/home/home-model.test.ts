import { describe, expect, it } from "vitest";

import { uuid } from "../../../components/inbox/inbox-fixtures";
import { defaultWorkspace, initialState, reduce } from "../../state";
import { destinationRoots } from "../../destinations";
import { homeDigest } from "./home-fixtures";
import {
  arrivalRows,
  briefingClauses,
  columnAreas,
  dateLine,
  dayDistance,
  foldCrumbs,
  greetingPart,
  homeMode,
  isResumeKey,
  needRows,
  pathTitles,
  pluralForm,
  resumeActions,
  resumeTrail,
  shapeSegments,
  tooBigTopics,
  whenParts,
  type HomeData
} from "./home-model";

const now = Date.UTC(2026, 10, 11, 12, 0, 0);

const data = (
  options: Parameters<typeof homeDigest>[1] = {},
  rest: Partial<HomeData> = {}
): HomeData => ({
  digest: homeDigest(now, options),
  generating: { total: 1, ids: [uuid(101)] },
  progress: {},
  lastVisit: new Date(now - 26 * 3_600_000).toISOString(),
  topicTitles: { [uuid(12)]: "Fermentação lática" },
  readAt: now,
  ...rest
});

describe("the briefing: each clause is true only when its count is", () => {
  it("says every clause on the design's day, in reading order", () => {
    expect(briefingClauses(data()).map((clause) => clause.id)).toEqual([
      "arrivals",
      "placement",
      "generating",
      "gardener",
      "decisions"
    ]);
  });

  it("carries the counts of the digest", () => {
    const clauses = briefingClauses(data());
    expect(clauses[0]).toEqual({ id: "arrivals", sources: 3, notes: 30 });
    expect(clauses[1]).toEqual({ id: "placement", placed: 29, unplaced: 1 });
    expect(clauses[2]).toEqual({ id: "generating", count: 1 });
    expect(clauses[3]).toEqual({ id: "gardener", count: 9 });
    expect(clauses[4]).toMatchObject({ id: "decisions", count: 3 });
  });

  it("drops the arrivals and the placement when nothing arrived", () => {
    const base = data();
    const quiet: HomeData = {
      ...base,
      digest: { ...base.digest, new: homeDigest(now, { calm: true }).new }
    };
    expect(briefingClauses(quiet).map((clause) => clause.id)).toEqual([
      "generating",
      "gardener",
      "decisions"
    ]);
  });

  it("drops the generating clause when nothing generates or the read failed", () => {
    expect(
      briefingClauses(data({}, { generating: { total: 0, ids: [] } })).map((c) => c.id)
    ).not.toContain("generating");
    expect(briefingClauses(data({}, { generating: null })).map((c) => c.id)).not.toContain(
      "generating"
    );
  });

  it("drops the Jardineiro and the decisions at zero", () => {
    const base = data();
    const none: HomeData = {
      ...base,
      digest: {
        ...base.digest,
        gardener: { count: 0, top: [] },
        inbox: { total: 0, top: [] }
      }
    };
    const ids = briefingClauses(none).map((clause) => clause.id);
    expect(ids).not.toContain("gardener");
    expect(ids).not.toContain("decisions");
  });

  it("names notes that arrived for a source that came earlier", () => {
    const base = data();
    const late: HomeData = {
      ...base,
      digest: {
        ...base.digest,
        new: {
          sources: { total: 0, items: [] },
          notes: { total: 4, placed: 4, unplaced: 0, items: [] }
        }
      }
    };
    expect(briefingClauses(late).slice(0, 2)).toEqual([
      { id: "notesOnly", notes: 4 },
      { id: "placement", placed: 4, unplaced: 0 }
    ]);
  });

  it("names the canonical title of the first decision that has one", () => {
    const decision = briefingClauses(data()).find((clause) => clause.id === "decisions");
    expect(decision).toMatchObject({ top: { kind: "review" } });
    const base = data();
    const bare: HomeData = {
      ...base,
      digest: {
        ...base.digest,
        inbox: {
          total: 2,
          top: base.digest.inbox.top.map((row) => ({ ...row, item: null }))
        }
      }
    };
    expect(briefingClauses(bare).find((clause) => clause.id === "decisions")).toEqual({
      id: "decisions",
      count: 2,
      top: null
    });
  });
});

describe("the mode of Home", () => {
  it("is first run when the library holds no source", () => {
    expect(homeMode(data({ firstRun: true }))).toBe("firstRun");
  });

  it("is a calm day only when nothing arrived, changed, waits or generates", () => {
    expect(homeMode(data({ calm: true }, { generating: { total: 0, ids: [] } }))).toBe("calm");
    expect(homeMode(data({ calm: true }))).toBe("brief");
    expect(homeMode(data({ calm: true }, { generating: null }))).toBe("calm");
    expect(homeMode(data())).toBe("brief");
  });
});

describe("words of time", () => {
  it("greets by the hour", () => {
    expect([5, 11, 12, 17, 18, 23].map(greetingPart)).toEqual([
      "morning",
      "morning",
      "afternoon",
      "afternoon",
      "evening",
      "evening"
    ]);
  });

  it("counts calendar days, not 24-hour spans", () => {
    expect(dayDistance(new Date(2026, 10, 10, 23, 50), new Date(2026, 10, 11, 0, 10))).toBe(1);
    expect(dayDistance(new Date(2026, 10, 11, 0, 10), new Date(2026, 10, 11, 23, 50))).toBe(0);
  });

  it("words a time as the time today and as the day and the time before", () => {
    const at = new Date(2026, 10, 11, 9, 12);
    const clock = new Date(2026, 10, 11, 15, 0);
    expect(whenParts("en", at, clock).day).toBeNull();
    expect(whenParts("pt-BR", at, clock).time).toMatch(/09:12|9:12/u);
    expect(whenParts("pt-BR", new Date(2026, 10, 10, 22, 38), clock).day).toBe("ontem");
    expect(whenParts("en", new Date(2026, 10, 10, 22, 38), clock).day).toBe("yesterday");
    expect(whenParts("pt-BR", new Date(2026, 10, 3, 18, 20), clock).day).toBe("3 de nov.");
  });

  it("writes the date line with a capital", () => {
    expect(dateLine("pt-BR", new Date(2026, 10, 11, 12))).toBe("Quarta-feira, 11 de novembro");
    expect(dateLine("en", new Date(2026, 10, 11, 12))).toBe("Wednesday, November 11");
  });

  it("picks One or Other by the locale's rule", () => {
    expect(pluralForm("en", 1)).toBe("One");
    expect(pluralForm("en", 0)).toBe("Other");
    expect(pluralForm("pt-BR", 0)).toBe("One");
    expect(pluralForm("fr", 1)).toBe("One");
  });
});

describe("Retomar", () => {
  it("offers the three latest objects that still exist, oldest first", () => {
    const digest = homeDigest(now);
    expect(resumeTrail(digest).map((entry) => entry.kind)).toEqual(["source", "topic", "note"]);
    const gone = {
      ...digest,
      continue: digest.continue.map((entry, index) =>
        index === 0 ? { ...entry, summary: null } : entry
      )
    };
    expect(resumeTrail(gone).map((entry) => entry.kind)).toEqual(["source", "topic"]);
  });

  it("goes to Explore and pushes each object right of the last, the newest on top", () => {
    const workspace = defaultWorkspace("2026-11-11");
    const addresses = resumeTrail(homeDigest(now)).map((entry) => entry.address);
    const actions = resumeActions(workspace, addresses);
    expect(actions[0]).toEqual({ type: "go", destination: "explore" });
    let state = workspace;
    for (const action of actions) state = reduce(state, action);
    expect(state.destination).toBe("explore");
    expect(state.stacks.explore.panels.map((panel) => panel.history[0])).toEqual(addresses);
    expect(state.stacks.explore.focus).toBe(2);
  });

  it("focuses an object that is already open instead of opening it twice", () => {
    const addresses = resumeTrail(homeDigest(now)).map((entry) => entry.address);
    let state = defaultWorkspace("2026-11-11");
    for (const action of resumeActions(state, addresses)) state = reduce(state, action);
    const again = resumeActions(state, addresses);
    let after = state;
    for (const action of again) after = reduce(after, action);
    expect(after.stacks.explore.panels).toHaveLength(3);
  });

  it("answers Enter only from Home itself", () => {
    const key = (over: Partial<Parameters<typeof isResumeKey>[0]> = {}) =>
      isResumeKey({
        key: "Enter",
        metaKey: false,
        ctrlKey: false,
        altKey: false,
        shiftKey: false,
        defaultPrevented: false,
        target: { tagName: "BODY" },
        ...over
      });
    expect(key()).toBe(true);
    expect(key({ target: { tagName: "INPUT" } })).toBe(false);
    expect(key({ target: { tagName: "BUTTON" } })).toBe(false);
    expect(key({ target: { tagName: "A" } })).toBe(false);
    expect(key({ target: { tagName: "DIV", isContentEditable: true } })).toBe(false);
    expect(key({ metaKey: true })).toBe(false);
    expect(key({ shiftKey: true })).toBe(false);
    expect(key({ defaultPrevented: true })).toBe(false);
    expect(key({ key: "Space" })).toBe(false);
  });
});

describe("the Shape strip", () => {
  it("gives each root a share of the notes and marks a topic that is too big", () => {
    const segments = shapeSegments(homeDigest(now).shape);
    expect(segments.map((segment) => segment.title)).toEqual([
      "Ciências da vida",
      "Nutrição",
      "Planejamento urbano",
      "Teoria musical",
      "História da ciência"
    ]);
    expect(segments.reduce((sum, segment) => sum + segment.share, 0)).toBeCloseTo(1, 6);
    expect(segments.filter((segment) => segment.tooBig).map((segment) => segment.title)).toEqual([
      "Nutrição"
    ]);
  });

  it("counts the topics too big anywhere in the tree, not only the roots drawn", () => {
    const base = homeDigest(now).shape;
    // Every root healthy, one subtopic two levels down in violation.
    const deep = {
      ...base,
      outOfBounds: 1,
      roots: base.roots.map((root) => ({ ...root, health: "good" as const }))
    };
    expect(shapeSegments(deep).some((segment) => segment.tooBig)).toBe(false);
    expect(tooBigTopics(deep)).toBe(1);
    // One root and two deeper topics in violation: all three count.
    expect(tooBigTopics({ ...base, outOfBounds: 3 })).toBe(3);
    // The roots' own violations are the floor.
    expect(tooBigTopics({ ...base, outOfBounds: 0 })).toBe(1);
    expect(tooBigTopics({ ...deep, outOfBounds: 0 })).toBe(0);
  });

  it("splits evenly when no root has notes", () => {
    const shape = {
      ...homeDigest(now).shape,
      roots: [
        { id: uuid(1), title: "A", notes: 0, topics: 5, health: "good" as const },
        { id: uuid(2), title: "B", notes: 0, topics: 1, health: "good" as const }
      ]
    };
    expect(shapeSegments(shape).map((segment) => segment.share)).toEqual([0.5, 0.5]);
  });
});

describe("the columns", () => {
  it("keeps the Inbox rows by risk and then in the digest's order", () => {
    const rows = homeDigest(now).inbox.top;
    const shuffled = [rows[2]!, rows[0]!, rows[1]!];
    expect(needRows(shuffled).map((row) => row.risk)).toEqual(["high", "medium", "low"]);
  });

  it("reads the arrivals with their path, their notes and whether they generate", () => {
    const rows = arrivalRows(data({}, { progress: { [uuid(101)]: { done: 7, estimate: 18 } } }));
    expect(rows.map((row) => row.title)).toEqual([
      "Ruas completas: lições de duas cidades andinas",
      "Ritmo e síncope no choro",
      "Kefir e kombucha em casa"
    ]);
    expect(rows.map((row) => row.generating)).toEqual([true, false, false]);
    expect(rows[0]?.progress).toEqual({ done: 7, estimate: 18 });
    expect(rows[1]?.crumbs).toEqual(["Teoria musical", "Ritmo"]);
    expect(rows.map((row) => row.notes)).toEqual([7, 9, 14]);
  });

  it("leaves out the tree's untitled root and any untitled segment", () => {
    const object = homeDigest(now).new.sources.items[2]!.object;
    expect(pathTitles(object)).toEqual([
      "Ciências da vida",
      "Microbiologia",
      "Fermentação",
      "Fermentação lática"
    ]);
  });

  it("folds a long path to its last crumbs under a leading ellipsis", () => {
    expect(foldCrumbs(["A", "B"])).toEqual({ folded: false, shown: ["A", "B"] });
    expect(foldCrumbs(["A", "B", "C", "D"])).toEqual({ folded: true, shown: ["C", "D"] });
  });
});

describe("the grid areas", () => {
  it("is `need gard arr` over `need gard back` at full width", () => {
    expect(columnAreas(["need", "gard", "arr", "back"], false)).toEqual([
      ["need", "gard", "arr"],
      ["need", "gard", "back"]
    ]);
  });

  it("is `need arr` over `gard back` at the compact tier", () => {
    expect(columnAreas(["need", "gard", "arr", "back"], true)).toEqual([
      ["need", "arr"],
      ["gard", "back"]
    ]);
  });

  it("closes up over a section that is not shown", () => {
    expect(columnAreas(["need", "arr"], false)).toEqual([["need", "arr"]]);
    expect(columnAreas(["gard", "back"], false)).toEqual([["gard", "back"]]);
    expect(columnAreas(["need", "gard", "arr"], false)).toEqual([["need", "gard", "arr"]]);
    expect(columnAreas(["need", "gard", "back"], true)).toEqual([
      ["need", "gard"],
      ["back", "back"]
    ]);
    expect(columnAreas(["back"], true)).toEqual([["back", "back"]]);
  });
});

describe("the Home rule", () => {
  const monday = new Date(2026, 10, 9, 8, 0);
  const tuesday = new Date(2026, 10, 10, 8, 0);

  it("starts on Home at first run", () => {
    expect(initialState(monday, null).destination).toBe("home");
  });

  it("starts on Home at the first open of a new local day and keeps the last place the same day", () => {
    let state = initialState(monday, null);
    state = reduce(state, { type: "go", destination: "library" });
    expect(initialState(monday, JSON.parse(JSON.stringify(state))).destination).toBe("library");
    expect(initialState(tuesday, JSON.parse(JSON.stringify(state))).destination).toBe("home");
  });

  it("goes to Explore with the Source pushed when the first source is chosen", () => {
    const state = reduce(initialState(monday, null), {
      type: "firstSource",
      address: `memora://source/${uuid(7)}`
    });
    expect(state.destination).toBe("explore");
    expect(state.stacks.explore.panels.map((panel) => panel.history[0])).toEqual([
      `memora://source/${uuid(7)}`
    ]);
    expect(state.stacks.explore.focus).toBe(0);
    expect(state.stacks.home.root).toBe(destinationRoots.home);
  });

  it("refuses a first source that is not a source", () => {
    const state = initialState(monday, null);
    expect(reduce(state, { type: "firstSource", address: `memora://note/${uuid(7)}` })).toBe(state);
  });

  it("remembers when Home was opened, and the day", () => {
    const at = new Date(2026, 10, 10, 9, 30).toISOString();
    const state = reduce(initialState(monday, null), { type: "homeOpened", at });
    expect(state.lastHomeOpenAt).toBe(at);
    expect(state.lastHomeDay).toBe("2026-11-10");
  });
});
