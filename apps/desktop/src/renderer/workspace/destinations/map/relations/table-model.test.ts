import { describe, expect, it } from "vitest";
import { createTranslator } from "@app/i18n";

import { branchId, branchNotes, branchTopics, sampleBranch } from "./branch-fixtures";
import { branchListCaps, buildBranchModel } from "./branch-model";
import {
  branchNotices,
  buildRelationRows,
  groupLinks,
  moveRow,
  outsideTopics,
  revealWithin,
  selectionFromRow,
  tablePageSize,
  tabStopRow,
  tableSync,
  visibleRowCount
} from "./table-model";

const en = createTranslator("en");
const scope = { kind: "topic", id: branchTopics.fermentation } as const;
const model = (answer = sampleBranch()) =>
  buildBranchModel(answer, { scope, colourDepth: 1, t: en });

const edgeId = (name: string) => branchId(`edge:${name}`);

describe("the relation rows", () => {
  const rows = buildRelationRows(model(), en);

  it("lists every drawn relation once, with the words of its stance and its sentence", () => {
    expect(rows).toHaveLength(7);
    expect(new Set(rows.map((row) => row.id)).size).toBe(7);
    const supports = rows.find((row) => row.id === edgeId("hours-acid"))!;
    expect(supports.stance).toBe("supports");
    expect(supports.suggested).toBe(false);
    expect(supports.sentence).toContain("supports");
    expect(rows.find((row) => row.id === edgeId("kefir-kombucha"))?.suggested).toBe(true);
  });

  it("puts the most connected notes' relations first, then by the first title, the same on every read", () => {
    // The acid note has four connections: its relations lead.
    const lead = rows.slice(0, 4).map((row) => row.id);
    expect(lead).toEqual(
      expect.arrayContaining([
        edgeId("hours-acid"),
        edgeId("acid-temperature"),
        edgeId("acid-bacteria"),
        edgeId("acid-kefir")
      ])
    );
    expect(buildRelationRows(model(), en).map((row) => row.id)).toEqual(rows.map((row) => row.id));
    // Reading the edges in another order gives the same table.
    const flipped = sampleBranch();
    flipped.edges = [...flipped.edges].reverse();
    expect(buildRelationRows(model(flipped), en).map((row) => row.id)).toEqual(
      rows.map((row) => row.id)
    );
  });

  it("names each note by its title, and leaves out a relation whose note is not drawn", () => {
    const row = rows.find((entry) => entry.id === edgeId("pasteur-hours"))!;
    expect([row.first.title, row.second.title].sort()).toEqual(
      [branchNotes.hours.title, branchNotes.pasteur.title].sort()
    );
    const answer = sampleBranch();
    answer.nodes = answer.nodes.filter((node) => node.id !== branchNotes.pasteur.id);
    expect(buildRelationRows(model(answer), en).some((r) => r.id === edgeId("pasteur-hours"))).toBe(
      false
    );
  });
});

describe("the page of rows", () => {
  const many = buildRelationRows(
    model(
      sampleBranch({
        edges: Array.from({ length: 150 }, (_, index) => ({
          id: branchId(`edge:many-${index}`),
          a:
            branchNotes.acid.id < branchNotes.hours.id ? branchNotes.acid.id : branchNotes.hours.id,
          b:
            branchNotes.acid.id < branchNotes.hours.id ? branchNotes.hours.id : branchNotes.acid.id,
          type: "supports",
          stance: "supports" as const,
          band: "apply" as const
        }))
      })
    ),
    en
  );

  it("shows a page, and never fewer rows than exist", () => {
    expect(visibleRowCount(many, null, tablePageSize)).toBe(tablePageSize);
    expect(visibleRowCount(many.slice(0, 5), null, tablePageSize)).toBe(5);
  });

  it("grows to take in the selected row, so a relation picked on the canvas is always in the table", () => {
    const far = many[100]!.id;
    expect(visibleRowCount(many, far, tablePageSize)).toBe(120);
    expect(visibleRowCount(many, many[3]!.id, tablePageSize)).toBe(tablePageSize);
    expect(visibleRowCount(many, "not-a-row", tablePageSize)).toBe(tablePageSize);
  });
});

describe("the selection sync", () => {
  const rows = buildRelationRows(model(), en);

  it("selects the row of a relation chosen on the canvas and reveals it", () => {
    const sync = tableSync(rows, { type: "edge", id: edgeId("yeast-kombucha") });
    expect(sync.selectedRowId).toBe(edgeId("yeast-kombucha"));
    expect(sync.connectedRowIds.size).toBe(0);
    expect(sync.revealRowId).toBe(edgeId("yeast-kombucha"));
  });

  it("marks every row of a note chosen on the canvas, and selects none", () => {
    const sync = tableSync(rows, { type: "node", id: branchNotes.acid.id });
    expect(sync.selectedRowId).toBeNull();
    expect([...sync.connectedRowIds].sort()).toEqual(
      [
        edgeId("hours-acid"),
        edgeId("acid-temperature"),
        edgeId("acid-bacteria"),
        edgeId("acid-kefir")
      ].sort()
    );
    expect(sync.connectedRowIds.has(sync.revealRowId!)).toBe(true);
  });

  it("marks nothing for no choice, a relation that is gone or a note with no relation", () => {
    for (const item of [
      null,
      { type: "edge" as const, id: "gone" },
      { type: "node" as const, id: "alone" }
    ]) {
      const sync = tableSync(rows, item);
      expect(sync.selectedRowId).toBeNull();
      expect(sync.connectedRowIds.size).toBe(0);
      expect(sync.revealRowId).toBeNull();
    }
  });

  it("answers a row's click with the relation, and a second click on the same row clears it", () => {
    const id = edgeId("hours-acid");
    expect(selectionFromRow(id, null)).toEqual({ type: "edge", id });
    expect(selectionFromRow(id, { type: "node", id: branchNotes.acid.id })).toEqual({
      type: "edge",
      id
    });
    expect(selectionFromRow(id, { type: "edge", id })).toBeNull();
  });

  it("round-trips: what a row selects is what the table then shows selected", () => {
    for (const row of rows) {
      const chosen = selectionFromRow(row.id, null);
      expect(tableSync(rows, chosen).selectedRowId).toBe(row.id);
    }
  });
});

describe("the table's keyboard", () => {
  it("moves by one, to the ends and by a page, and stops at the ends instead of wrapping", () => {
    expect(moveRow(10, 3, "ArrowDown")).toBe(4);
    expect(moveRow(10, 3, "ArrowUp")).toBe(2);
    expect(moveRow(10, 9, "ArrowDown")).toBe(9);
    expect(moveRow(10, 0, "ArrowUp")).toBe(0);
    expect(moveRow(10, 5, "Home")).toBe(0);
    expect(moveRow(10, 5, "End")).toBe(9);
    expect(moveRow(100, 5, "PageDown")).toBe(13);
    expect(moveRow(10, 5, "PageDown")).toBe(9);
    expect(moveRow(100, 5, "PageUp")).toBe(0);
  });

  it("enters from either end, ignores other keys and has nowhere to go with no row", () => {
    expect(moveRow(10, null, "ArrowDown")).toBe(0);
    expect(moveRow(10, null, "ArrowUp")).toBe(9);
    expect(moveRow(10, 2, "a")).toBeNull();
    expect(moveRow(10, 2, "Enter")).toBeNull();
    expect(moveRow(0, null, "ArrowDown")).toBeNull();
  });

  it("holds one tab stop: the selected row, else the first", () => {
    const rows = buildRelationRows(model(), en);
    expect(tabStopRow(rows, null)).toBe(0);
    expect(tabStopRow(rows, rows[3]!.id)).toBe(3);
    expect(tabStopRow(rows, "gone")).toBe(0);
    expect(tabStopRow([], null)).toBe(-1);
  });
});

describe("the lists around the table", () => {
  it("lists the lines between groups, the heaviest first, by the legend's names", () => {
    const links = groupLinks(model());
    expect(links.map((link) => link.weight)).toEqual([2, 1]);
    expect(links[0]!.first).not.toBe("");
    expect(links[0]!.second).not.toBe("");
    // A group the canvas does not draw has no line.
    const answer = sampleBranch();
    answer.superEdges = [{ a: branchId("topic:gone"), b: branchTopics.lactic, weight: 9 }];
    expect(groupLinks(model(answer))).toEqual([]);
  });

  it("lists the topics outside the branch, the most connected first, and drops an empty count", () => {
    const answer = sampleBranch({
      outside: [
        { topicId: branchId("topic:a"), title: "A", edgeCount: 1 },
        { topicId: branchId("topic:b"), title: "B", edgeCount: 5 },
        { topicId: branchId("topic:c"), title: "C", edgeCount: 0 },
        { topicId: branchId("topic:d"), title: "", edgeCount: 1 }
      ]
    });
    const titles = outsideTopics(model(answer)).map((topic) => topic.title);
    expect(titles).toEqual(["B", "A", "Untitled topic"]);
  });
});

describe("what the read left out", () => {
  const list = (count: number) =>
    Array.from({ length: count }, (_, index) => ({
      topicId: branchId(`topic:o${index}`),
      title: `T${index}`,
      edgeCount: 1
    }));

  it("says nothing for a complete read", () => {
    const built = model();
    expect(built.outsideCapped).toBe(false);
    expect(built.superEdgesCapped).toBe(false);
    expect(branchNotices(built)).toEqual([]);
  });

  it("tells a truncated read from the lists' own caps, which the read never flags", () => {
    expect(branchNotices(model(sampleBranch({ truncated: true })))).toEqual(["truncated"]);
    const outside = model(sampleBranch({ outside: list(branchListCaps.outside) }));
    expect(outside.truncated).toBe(false);
    expect(outside.outsideCapped).toBe(true);
    expect(branchNotices(outside)).toEqual([]);
    const short = model(sampleBranch({ outside: list(branchListCaps.outside - 1) }));
    expect(short.outsideCapped).toBe(false);
    const lines = model(
      sampleBranch({
        superEdges: Array.from({ length: branchListCaps.superEdges }, (_, index) => ({
          a: branchTopics.lactic,
          b: branchId(`topic:s${index}`),
          weight: 1
        }))
      })
    );
    expect(lines.superEdgesCapped).toBe(true);
    expect(branchNotices(lines)).toEqual(["groupLines"]);
    expect(
      branchNotices(model(sampleBranch({ truncated: true, outside: list(branchListCaps.outside) })))
    ).toEqual(["truncated"]);
  });
});

describe("revealWithin", () => {
  // A box whose content starts at the box's top edge; its header covers the first 30 px.
  const box = (scrollTop: number) => ({
    scrollTop,
    clientTop: 1,
    clientHeight: 200,
    getBoundingClientRect: () => ({ top: 100 })
  });
  const row = (top: number, bottom: number) => ({ getBoundingClientRect: () => ({ top, bottom }) });

  it("moves only the box's own scrollTop, and never asks the page to scroll", () => {
    const scrolled: string[] = [];
    const target = { ...row(400, 440), scrollIntoView: () => scrolled.push("page") };
    const scroller = box(0);
    revealWithin(scroller, target);
    expect(scrolled).toEqual([]);
    expect(scroller.scrollTop).toBe(440 - (100 + 1 + 200));
  });

  it("scrolls up past a sticky header, and leaves a row in view where it is", () => {
    const up = box(80);
    revealWithin(up, row(110, 150), 30);
    expect(up.scrollTop).toBe(80 - (101 + 30 - 110));
    const still = box(80);
    revealWithin(still, row(150, 190), 30);
    expect(still.scrollTop).toBe(80);
  });
});
