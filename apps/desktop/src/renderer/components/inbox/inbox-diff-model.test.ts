import { describe, expect, it } from "vitest";

import type { OverviewDiffSide, RelationDiffItem } from "@app/domain";
import { createTranslator, supportedLanguageCodes } from "@app/i18n";

import { overviewDiffView, relationDiffRows, topicDiffRows } from "./inbox-diff-model";
import { topicDiff, uuid } from "./inbox-fixtures";

const en = createTranslator("en");

describe("the topic diff as rows", () => {
  const diff = topicDiff();
  if (diff.kind !== "topic") throw new Error("fixture");
  const rows = topicDiffRows(en, diff.nodes);

  it("indents each topic under its parent, the library root first", () => {
    expect(rows.map((row) => [row.name, row.depth])).toEqual([
      ["Whole library", 0],
      ["Naps", 1],
      ["Sleep", 1],
      ["Unnamed topic", 2]
    ]);
  });

  it("says what happened to each topic as a word, with where it went and what it was called", () => {
    expect(rows.map((row) => row.changeLabel)).toEqual(["Unchanged", "Moved", "Renamed", "Added"]);
    expect(rows[1]?.detail).toBe("from “Rest” to “Whole library”");
    expect(rows[2]?.detail).toBe("was “Rest”");
    expect(rows[3]?.detail).toBeNull();
  });

  it("counts the placements moved in and out for the language", () => {
    expect(rows[1]?.items).toBe("4 in, 1 out");
    expect(rows[0]?.items).toBeNull();
    expect(
      topicDiffRows(createTranslator("pt-BR"), [{ ...diff.nodes[1]!, itemsIn: 1234 }])[0]?.items
    ).toContain("1.234");
  });

  it("never shows an ID, in any language", () => {
    for (const locale of supportedLanguageCodes)
      for (const row of topicDiffRows(createTranslator(locale), diff.nodes))
        expect(
          JSON.stringify([row.name, row.changeLabel, row.detail, row.items]),
          locale
        ).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/u);
  });

  it("copes with a cycle or a parent that is not listed", () => {
    const loop = [
      { ...diff.nodes[1]!, id: uuid(7), parentBefore: uuid(8), parentAfter: uuid(8) },
      { ...diff.nodes[1]!, id: uuid(8), parentBefore: uuid(7), parentAfter: uuid(7) },
      { ...diff.nodes[2]!, id: uuid(9), parentBefore: uuid(404), parentAfter: uuid(404) }
    ];
    const result = topicDiffRows(en, loop);
    expect(result.every((row) => row.depth <= 64)).toBe(true);
    expect(result[2]?.depth).toBe(0);
  });
});

describe("the relation diff as rows", () => {
  const relation = (overrides: Partial<RelationDiffItem> = {}): RelationDiffItem => ({
    relationKind: "note",
    relationId: uuid(1),
    change: "created",
    events: ["created"],
    from: { id: uuid(2), title: "Caffeine" },
    to: { id: uuid(3), title: null },
    before: null,
    after: { status: "pending_review", band: "suggest", type: "supports" },
    ...overrides
  });

  it("names both ends, the type and the change", () => {
    const [row] = relationDiffRows(en, [relation()]);
    expect(row).toMatchObject({
      change: "created",
      changeLabel: "Created",
      between: "“Caffeine” and “Untitled”",
      type: "supports"
    });
  });

  it("falls back to the earlier type, and says when there is none", () => {
    expect(
      relationDiffRows(en, [
        relation({
          after: null,
          before: { status: null, band: null, type: "extends" },
          change: "removed"
        })
      ])[0]
    ).toMatchObject({ changeLabel: "Removed", type: "extends" });
    expect(
      relationDiffRows(en, [relation({ after: { status: null, band: null, type: null } })])[0]?.type
    ).toBe("No type yet");
  });

  it("has a word for every change in every language", () => {
    for (const locale of supportedLanguageCodes)
      for (const change of ["created", "removed", "changed"] as const)
        expect(
          relationDiffRows(createTranslator(locale), [relation({ change })])[0]?.changeLabel,
          `${locale} ${change}`
        ).not.toMatch(/\[\[missing/u);
  });
});

describe("the overview diff", () => {
  const side = (
    version: number,
    texts: string[],
    divergences = [] as OverviewDiffSide["divergences"]
  ): OverviewDiffSide => ({
    version,
    paragraphs: texts.map((text) => ({ text, citations: [1] })),
    divergences
  });

  it("gives both texts and only the Divergences the change adds", () => {
    const old = { existing: "E1", new: "E2", summary: "Older disagreement" };
    const added = { existing: "E3", new: "E9", summary: "Naps help versus hurt" };
    const view = overviewDiffView(en, {
      topic: { title: "Sleep" },
      before: side(1, ["One."], [old]),
      after: side(2, ["One.", "Two."], [old, added])
    });
    expect(view.topic).toBe("Sleep");
    expect(view.before).toEqual({ version: 1, paragraphs: ["One."] });
    expect(view.after?.paragraphs).toEqual(["One.", "Two."]);
    expect(view.divergences).toEqual(["Paragraphs E3 and E9: Naps help versus hurt"]);
  });

  it("copes with a side that does not exist yet and a topic that is not named", () => {
    const view = overviewDiffView(en, {
      topic: { title: null },
      before: null,
      after: side(1, ["First."])
    });
    expect(view).toMatchObject({ topic: "Unnamed topic", before: null, divergences: [] });
  });
});
