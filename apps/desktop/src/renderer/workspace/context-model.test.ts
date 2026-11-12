import { describe, expect, it } from "vitest";
import { createTranslator } from "@app/i18n";
import type { NotePageRelation, ObjectBacklink } from "@app/domain";

import {
  answerCitations,
  appendBacklinks,
  appendRelations,
  connectionCounts,
  connectionMeta,
  stripParts,
  suggestionRouting,
  connectionRow,
  countText,
  focusedObject,
  groupBacklinks,
  groupConnections,
  groupHeadingKey,
  groupPassages,
  notePassageTarget,
  objectOfAddress,
  passageAddress,
  connectionTotal,
  isShownSourceRelation,
  readsMoreBacklinks,
  relationRole,
  resolveTab,
  sourceConnectionRow,
  suggestionVerdict,
  tabForKey,
  tabRow,
  tabShortcut,
  tabSlots
} from "./context-model";
import { defaultWorkspace, contextTabFor } from "./state";

const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const en = createTranslator("en");
const pt = createTranslator("pt-BR");

const relation = (
  n: number,
  fields: Partial<NotePageRelation> & { type: string }
): NotePageRelation =>
  ({
    id: uuid(200 + n),
    direction: "outgoing",
    directionSource: "decider",
    state: "applied",
    band: "apply",
    calibration: "frozen",
    probability: 0.9,
    vetoSource: null,
    decidedBy: null,
    typedBy: null,
    explainedBy: null,
    explanation: null,
    other: {
      id: uuid(n),
      title: `Note ${n}`,
      ideaStatement: "x",
      language: "en",
      status: "current",
      superseded: false,
      authorship: "ai",
      sourceItemId: null,
      sourceTitle: "",
      passage: null
    },
    ...fields
  }) as NotePageRelation;

describe("the tab row (priority+, A5)", () => {
  const all = ["connections", "evidence", "ask", "mentions", "graph", "history"] as const;

  it("shows Conexões, Evidência and Perguntar, the rest under Mais", () => {
    expect(tabRow(all, "connections")).toEqual({
      visible: ["connections", "evidence", "ask"],
      more: ["mentions", "graph", "history"]
    });
  });

  it("gives a chosen Mais tab the third slot, so the selected tab is always visible", () => {
    expect(tabRow(all, "graph")).toEqual({
      visible: ["connections", "evidence", "graph"],
      more: ["ask", "mentions", "history"]
    });
    expect(tabRow(all, "history").visible).toContain("history");
  });

  it("works with the tabs that exist today (no Ask or History yet)", () => {
    const built = ["connections", "evidence", "mentions", "graph"] as const;
    expect(tabRow(built, "connections")).toEqual({
      visible: ["connections", "evidence"],
      more: ["mentions", "graph"]
    });
    expect(tabRow(built, "mentions")).toEqual({
      visible: ["connections", "evidence", "mentions"],
      more: ["graph"]
    });
  });

  it("shows fewer tabs when the words do not fit, and still the selected one", () => {
    expect(tabRow(all, "connections", tabSlots.narrow).visible).toEqual([
      "connections",
      "evidence"
    ]);
    expect(tabRow(all, "connections", tabSlots.least).visible).toEqual(["connections"]);
    expect(tabRow(all, "graph", tabSlots.least).visible).toEqual(["graph"]);
    expect(tabRow(all, "graph", tabSlots.narrow).visible).toEqual(["connections", "graph"]);
  });

  it("keeps every tab in exactly one place", () => {
    for (const active of all)
      for (const slots of [3, 2, 1]) {
        const row = tabRow(all, active, slots);
        expect([...row.visible, ...row.more].sort()).toEqual([...all].sort());
      }
  });

  it("falls back to the first tab that exists", () => {
    expect(resolveTab("ask", ["connections", "evidence"])).toBe("connections");
    expect(resolveTab("evidence", ["connections", "evidence"])).toBe("evidence");
  });

  it("moves along the visible tabs with the arrows, Home and End", () => {
    const visible = ["connections", "evidence", "graph"] as const;
    expect(tabForKey(visible, "connections", "ArrowRight")).toBe("evidence");
    expect(tabForKey(visible, "graph", "ArrowRight")).toBe("connections");
    expect(tabForKey(visible, "connections", "ArrowLeft")).toBe("graph");
    expect(tabForKey(visible, "evidence", "Home")).toBe("connections");
    expect(tabForKey(visible, "evidence", "End")).toBe("graph");
    expect(tabForKey(visible, "evidence", "x")).toBeNull();
  });

  it("numbers the tabs ⌥1-⌥6 in A5's order", () => {
    expect(all.map(tabShortcut)).toEqual(["⌥1", "⌥2", "⌥3", "⌥4", "⌥5", "⌥6"]);
  });
});

describe("the default tab per kind (design record §5.6)", () => {
  it("opens a note on Conexões, a question on Evidência, an entity on Perguntar", () => {
    const state = { contextTab: {} };
    expect(contextTabFor(state, "note")).toBe("connections");
    expect(contextTabFor(state, "topic")).toBe("connections");
    expect(contextTabFor(state, "source")).toBe("connections");
    expect(contextTabFor(state, "question")).toBe("evidence");
    expect(contextTabFor(state, "entity")).toBe("ask");
    expect(contextTabFor(state, "source", { sourceGenerating: true })).toBe("ask");
  });

  it("remembers the last tab chosen for each kind", () => {
    expect(contextTabFor({ contextTab: { note: "graph" } }, "note")).toBe("graph");
    expect(contextTabFor({ contextTab: { note: "graph" } }, "topic")).toBe("connections");
  });
});

describe("the focused object", () => {
  it("is the address of the focused panel, anchor left out", () => {
    expect(objectOfAddress(`memora://source/${uuid(1)}#passage=${uuid(2)}`)).toEqual({
      kind: "source",
      id: uuid(1),
      address: `memora://source/${uuid(1)}`
    });
    expect(objectOfAddress("memora://library")).toBeNull();
  });

  it("is none on the root, on a view panel and in Settings", () => {
    const state = defaultWorkspace("2026-11-12");
    expect(focusedObject(state)).toBeNull();
    const stack = state.stacks.explore;
    const withNote = {
      ...state,
      destination: "explore" as const,
      stacks: {
        ...state.stacks,
        explore: {
          ...stack,
          focus: 0,
          panels: [{ id: "a", history: [`memora://note/${uuid(3)}`], index: 0 }]
        }
      }
    };
    expect(focusedObject(withNote)?.kind).toBe("note");
    const view = {
      ...withNote,
      stacks: {
        ...withNote.stacks,
        explore: { ...stack, focus: 0, panels: [{ id: "a", history: ["memora://ask"], index: 0 }] }
      }
    };
    expect(focusedObject(view)).toBeNull();
    expect(focusedObject({ ...withNote, destination: "settings" })).toBeNull();
  });
});

describe("counted nouns", () => {
  it("bind the number to the noun with a no-break space, in the locale's plural", () => {
    expect(countText(pt, "connections", 1)).toBe("1 conexão");
    expect(countText(pt, "connections", 5)).toBe("5 conexões");
    expect(countText(en, "suggestions", 1)).toBe("1 suggestion");
    expect(countText(en, "passages", 0)).toBe("0 passages");
  });
});

describe("a note's connections", () => {
  it("reads the role of a relation from the open note", () => {
    expect(relationRole({ type: "extends", direction: "outgoing" })).toBe("out");
    expect(relationRole({ type: "extends", direction: "incoming" })).toBe("in");
    expect(relationRole({ type: "extends", direction: "unknown" })).toBe("linked");
    expect(relationRole({ type: "contradicts", direction: "unknown" })).toBe("mutual");
  });

  it("groups by stance in the legend's order with the design record's headings", () => {
    const { groups, suggestions } = groupConnections([
      relation(1, { type: "depends_on" }),
      relation(2, { type: "supports", direction: "incoming" }),
      relation(3, { type: "supports", direction: "incoming" }),
      relation(4, { type: "extends" }),
      relation(5, { type: "example_of" }),
      relation(6, { type: "supports", direction: "incoming", state: "suggested", probability: 0.5 })
    ]);
    expect(groups.map((group) => group.headingKey)).toEqual([
      "contextPanel.connections.groups.supportsIn",
      "contextPanel.connections.groups.extendsOut",
      "contextPanel.connections.groups.dependsOnOut",
      "contextPanel.connections.groups.exampleOfOut"
    ]);
    expect(groups[0]?.rows.map((row) => row.title)).toEqual(["Note 2", "Note 3"]);
    expect(suggestions.map((row) => row.title)).toEqual(["Note 6"]);
    expect(en(groups[0]!.headingKey)).toBe("Notes that support this one");
    expect(pt(groups[0]!.headingKey)).toBe("Apoiam esta nota");
    expect(pt(groups[1]!.headingKey)).toBe("Esta nota estende");
  });

  it("has a heading for every stance and role", () => {
    for (const stance of [
      "supports",
      "contradicts",
      "extends",
      "depends_on",
      "example_of",
      "related"
    ] as const)
      for (const role of ["in", "out", "linked", "mutual"] as const)
        expect(pt(groupHeadingKey(stance, role))).not.toMatch(/^contextPanel\./);
  });

  it("counts connections and suggestions apart", () => {
    expect(
      connectionCounts([{ state: "applied" }, { state: "kept" }, { state: "suggested" }])
    ).toEqual({ connections: 2, suggestions: 1 });
  });

  it("never hides or reorders a relation by its confidence (D11)", () => {
    const { groups } = groupConnections([
      relation(1, { type: "supports", direction: "incoming", probability: 0.2 }),
      relation(2, { type: "supports", direction: "incoming", probability: 0.99 }),
      relation(3, { type: "supports", direction: "incoming", probability: null })
    ]);
    expect(groups[0]?.rows.map((row) => row.title)).toEqual(["Note 1", "Note 2", "Note 3"]);
  });

  describe("the meta line", () => {
    const words = (row: ReturnType<typeof connectionRow>) =>
      connectionMeta(row).map((key) => pt(key));

    it("says the Gardener and a confidence word for an applied relation", () => {
      expect(words(connectionRow(relation(1, { type: "supports", probability: 0.91 })))).toEqual([
        "Jardineiro",
        "confiança alta"
      ]);
      expect(words(connectionRow(relation(1, { type: "supports", probability: 0.7 })))).toEqual([
        "Jardineiro",
        "confiança média"
      ]);
    });

    it("says the person kept a kept relation", () => {
      expect(words(connectionRow(relation(1, { type: "supports", state: "kept" })))).toEqual([
        "você manteve"
      ]);
    });

    it("says also in the Inbox for a suggestion below the high band, and decide whenever for the rest", () => {
      const low = connectionRow(
        relation(1, { type: "supports", state: "suggested", probability: 0.64 })
      );
      expect(low.routesToInbox).toBe(true);
      expect(words(low)).toEqual(["Jardineiro", "confiança média"]);
      expect(pt(suggestionRouting(low))).toBe("também na Caixa de entrada");
      const high = connectionRow(
        relation(1, { type: "supports", state: "suggested", probability: 0.92 })
      );
      expect(high.routesToInbox).toBe(false);
      expect(words(high)).toEqual(["Jardineiro", "confiança alta"]);
      expect(pt(suggestionRouting(high))).toBe("decida quando quiser");
    });

    it("words a null probability as unknown, routes it, and never invents a number", () => {
      const unknown = connectionRow(
        relation(1, { type: "supports", state: "suggested", probability: null })
      );
      expect(unknown.confidence).toBe("unknown");
      expect(unknown.routesToInbox).toBe(true);
      expect(words(unknown)).toContain("confiança desconhecida");
    });

    it("routes a contradiction however sure it is", () => {
      const row = connectionRow(
        relation(1, { type: "contradicts", state: "suggested", probability: 0.99 })
      );
      expect(row.routesToInbox).toBe(true);
    });
  });

  it("appends a page once per relation", () => {
    const first = [relation(1, { type: "supports" }), relation(2, { type: "supports" })];
    const next = [relation(2, { type: "supports" }), relation(3, { type: "supports" })];
    expect(appendRelations(first, next).map((item) => item.other.title)).toEqual([
      "Note 1",
      "Note 2",
      "Note 3"
    ]);
  });

  it("answers `a` with keep and Backspace with remove, and nothing with a modifier", () => {
    expect(suggestionVerdict({ key: "a" })).toBe("keep");
    expect(suggestionVerdict({ key: "Backspace" })).toBe("remove");
    expect(suggestionVerdict({ key: "a", metaKey: true })).toBeNull();
    expect(suggestionVerdict({ key: "x" })).toBeNull();
  });
});

describe("a source's connections", () => {
  it("names the other source and how it is linked", () => {
    const row = sourceConnectionRow(
      {
        id: uuid(9),
        sourceItemId: uuid(1),
        targetSourceItemId: uuid(2),
        sourceTitle: "A",
        targetTitle: "B",
        relationType: "extends",
        confidence: null,
        suggested: true,
        status: "pending_review"
      },
      uuid(2)
    );
    expect(row).toMatchObject({
      address: `memora://source/${uuid(1)}`,
      title: "A",
      stance: "extends",
      state: "suggested",
      confidence: "unknown"
    });
  });
});

describe("how many connections a note has", () => {
  const rows = [{ state: "applied" }, { state: "suggested" }, { state: "kept" }] as never[];

  it("counts the rows when all are loaded", () => {
    expect(connectionTotal(rows, { hasMore: false, total: 3 })).toBe(2);
  });

  it("counts the total of the read, less the suggestions, while rows are still to load", () => {
    // The strip says what the heading says: 57 in all, not the 20 loaded.
    expect(connectionTotal(rows, { hasMore: true, total: 57 })).toBe(56);
    expect(connectionTotal(rows, { hasMore: true, total: null })).toBe(2);
  });
});

describe("which source relations a source's connections list", () => {
  const base = {
    sourceItemId: uuid(1),
    targetSourceItemId: uuid(2),
    status: "pending_review" as const,
    current: true
  };

  it("leaves out the removed ones and the ones whose evidence is gone", () => {
    expect(isShownSourceRelation(base, uuid(1))).toBe(true);
    expect(isShownSourceRelation({ ...base, status: "accepted" }, uuid(2))).toBe(true);
    expect(isShownSourceRelation({ ...base, status: "rejected" }, uuid(1))).toBe(false);
    expect(isShownSourceRelation({ ...base, current: false }, uuid(1))).toBe(false);
  });

  it("leaves out a relation between two of a container's children", () => {
    // The container is uuid(9): neither end is it, so no end is its counterpart.
    expect(isShownSourceRelation(base, uuid(9))).toBe(false);
  });
});

describe("backlinks", () => {
  const item = (via: ObjectBacklink["via"], n: number, extra: Partial<ObjectBacklink> = {}) =>
    ({ from: `memora://note/${uuid(n)}`, via, ...extra }) as ObjectBacklink;

  it("groups by via in the order asked for and leaves the others out", () => {
    const groups = groupBacklinks(
      [
        item("question_citation", 1),
        item("relation", 2),
        item("overview_citation", 3),
        item("question_citation", 4)
      ],
      ["overview_citation", "question_citation"]
    );
    expect(groups.map((group) => [group.via, group.items.length])).toEqual([
      ["overview_citation", 1],
      ["question_citation", 2]
    ]);
  });

  it("appends a page without repeating a link", () => {
    const first = [item("mention", 1), item("mention", 2)];
    expect(appendBacklinks(first, [item("mention", 2), item("mention", 3)])).toHaveLength(3);
  });

  it("keeps reading while a page of what it shows is missing, a few requests at most", () => {
    expect(readsMoreBacklinks({ found: 0, hasNext: true, requests: 1 })).toBe(true);
    expect(readsMoreBacklinks({ found: 20, hasNext: true, requests: 1 })).toBe(false);
    expect(readsMoreBacklinks({ found: 0, hasNext: false, requests: 1 })).toBe(false);
    expect(readsMoreBacklinks({ found: 0, hasNext: true, requests: 6 })).toBe(false);
  });

  it("groups a source's backlinks as the passages they cite", () => {
    const anchor = `passage=${uuid(40)}`;
    const { passages, unanchored } = groupPassages([
      item("evidence", 1, { anchor, snippet: "the words" }),
      item("evidence", 2, { anchor }),
      { from: `memora://question/${uuid(5)}`, via: "question_citation", anchor } as ObjectBacklink,
      { from: `memora://question/${uuid(6)}`, via: "question_citation" } as ObjectBacklink,
      item("source_relation", 7)
    ]);
    expect(passages).toEqual([{ anchor, snippet: "the words", notes: 2, questions: 1 }]);
    expect(unanchored).toBe(1);
    expect(passageAddress(uuid(1), anchor)).toBe(`memora://source/${uuid(1)}#${anchor}`);
  });
});

describe("evidence", () => {
  it("opens a note's passage in its source, the source alone for an earlier version, nowhere when gone", () => {
    const base = { sourceItemId: uuid(1), chunkId: uuid(2) };
    expect(notePassageTarget({ ...base, current: true, sourceAvailable: true })).toBe(
      `memora://source/${uuid(1)}#passage=${uuid(2)}`
    );
    expect(notePassageTarget({ ...base, current: false, sourceAvailable: true })).toBe(
      `memora://source/${uuid(1)}`
    );
    expect(notePassageTarget({ ...base, current: true, sourceAvailable: false })).toBeNull();
  });

  it("lists the latest answer's citations once per number, in order, with their anchors", () => {
    const citation = (ordinal: number, anchor?: { passage: string }, extra = {}) => ({
      ordinal,
      address: `memora://source/${uuid(ordinal)}`,
      ...(anchor ? { anchor } : {}),
      unavailable: false,
      stale: false,
      ...extra
    });
    const answers = [
      { paragraphs: [{ citations: [citation(1)] }] },
      {
        paragraphs: [
          { citations: [citation(2, { passage: uuid(40) }), citation(1)] },
          {
            citations: [citation(2, { passage: uuid(40) }), citation(3, undefined, { stale: true })]
          }
        ]
      }
    ];
    const list = answerCitations(answers);
    expect(list.map((entry) => entry.number)).toEqual([1, 2, 3]);
    expect(list[1]?.address).toBe(`memora://source/${uuid(2)}#passage=${uuid(40)}`);
    expect(list[2]?.stale).toBe(true);
    expect(answerCitations([])).toEqual([]);
  });
});

describe("the strip's words", () => {
  it("names the tab and its count, and leaves out a count that is zero or not known", () => {
    expect(stripParts("Conexões", 5)).toEqual(["Conexões", "5"]);
    expect(stripParts("Conexões", 0)).toEqual(["Conexões"]);
    expect(stripParts("Conexões", null)).toEqual(["Conexões"]);
  });
});
