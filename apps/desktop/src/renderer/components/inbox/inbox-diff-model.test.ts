import { describe, expect, it } from "vitest";

import type { OverviewDiffSide, RelationDiffItem } from "@app/domain";
import { createTranslator, supportedLanguageCodes } from "@app/i18n";

import { overviewDiffView, relationDiffRows } from "./inbox-diff-model";
import { uuid } from "./inbox-fixtures";

const en = createTranslator("en");

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
