import { describe, expect, it } from "vitest";

import { supportedLanguageCodes, translate, type MessageKey } from "@app/i18n";

import {
  ChangeSetConfigSchema,
  ChangeSetSummarySchema,
  ChangesDiffSchema,
  ChangesListInputSchema,
  ChangesReviewResultSchema,
  changeSetBlockerCodes,
  changeSetConfig,
  changeSetErrorKeys,
  overviewChangeOrigins,
  relationChangeSetKinds,
  relationRunTitleKey
} from "./change-sets.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("change-set configuration (D10, D11)", () => {
  it("starts from the spec's values", () => {
    expect(changeSetConfig).toEqual({
      risk: { mergeItemsHigh: 30, rebuildMovedShareHigh: 0.2, recentOpenDays: 7 },
      retention: { changeSetDays: 90, jobDays: 30, batchSize: 500, maxBatches: 40 }
    });
  });

  it("refuses values out of range and unknown fields", () => {
    expect(() => ChangeSetConfigSchema.parse({ risk: { rebuildMovedShareHigh: 1.5 } })).toThrow();
    expect(() => ChangeSetConfigSchema.parse({ retention: { changeSetDays: 0 } })).toThrow();
    expect(() => ChangeSetConfigSchema.parse({ retention: { keepForever: true } })).toThrow();
    expect(ChangeSetConfigSchema.parse({ retention: { changeSetDays: 30 } }).retention).toEqual({
      ...changeSetConfig.retention,
      changeSetDays: 30
    });
  });
});

describe("the changes.* contracts", () => {
  const summary = {
    kind: "relation",
    id: id(1),
    titleKey: "changes.titles.relationMatched",
    titleParams: { note: "Sleep" },
    risk: "medium",
    status: "pending_review",
    origin: "match",
    subjectId: null,
    jobId: id(2),
    at: "2026-10-23T12:00:00.123456Z",
    undoneAt: null,
    undo: "unavailable"
  };

  it("accepts a summary with microsecond times and refuses one with a non-scalar parameter", () => {
    expect(ChangeSetSummarySchema.parse(summary)).toEqual(summary);
    expect(() =>
      ChangeSetSummarySchema.parse({ ...summary, titleParams: { note: ["x"] } })
    ).toThrow();
    expect(() => ChangeSetSummarySchema.parse({ ...summary, kind: "wiki" })).toThrow();
  });

  it("bounds a page and defaults its size", () => {
    expect(ChangesListInputSchema.parse({})).toEqual({ limit: 50 });
    expect(() => ChangesListInputSchema.parse({ limit: 51 })).toThrow();
    expect(() => ChangesListInputSchema.parse({ cursor: "" })).toThrow();
  });

  it("answers a review with the status that stands, stale or blocked", () => {
    expect(ChangesReviewResultSchema.parse({ status: "dismissed" })).toEqual({
      status: "dismissed"
    });
    expect(ChangesReviewResultSchema.parse({ status: "stale" })).toEqual({ status: "stale" });
    expect(
      ChangesReviewResultSchema.parse({
        status: "blocked",
        blockers: [{ code: "later_change", changeSet: { kind: "relation", id: id(3) } }],
        more: 2
      })
    ).toMatchObject({ status: "blocked", more: 2 });
  });

  it("carries a diff of each store", () => {
    const base = { summary: { ...summary, status: "applied", undo: "available" } };
    expect(
      ChangesDiffSchema.parse({
        ...base,
        kind: "topic",
        nodes: [
          {
            id: id(4),
            change: "moved",
            existedBefore: true,
            existsAfter: true,
            parentBefore: id(5),
            parentAfter: id(6),
            titleBefore: "Naps",
            titleAfter: "Naps",
            itemsIn: 0,
            itemsOut: 0
          }
        ],
        hidden: 0
      }).kind
    ).toBe("topic");
    expect(
      ChangesDiffSchema.parse({
        ...base,
        kind: "overview",
        topic: { id: id(4), title: null },
        before: null,
        after: {
          version: 1,
          paragraphs: [{ text: "One.", citations: [1] }],
          divergences: [{ existing: "E1", new: "E2", summary: "Differs." }]
        }
      }).kind
    ).toBe("overview");
  });
});

describe("change-set copy", () => {
  const keys = [
    ...relationChangeSetKinds.map(relationRunTitleKey),
    ...overviewChangeOrigins.map((origin) => `changes.titles.overview.${origin}`),
    "changes.titles.relationMatched",
    "changes.titles.relationSuggested",
    ...changeSetBlockerCodes.map((code) => `changes.blockers.${code}`),
    ...changeSetErrorKeys
  ];

  it("has every title, blocker and error in every locale, with the same parameters", () => {
    for (const locale of supportedLanguageCodes)
      for (const key of keys) {
        const text = translate(locale, key as MessageKey, {
          values: { note: "N", source: "S", n: 2 },
          missingKeyBehavior: "throw"
        });
        expect(text, `${locale} ${key}`).not.toMatch(/\{\w+\}/u);
      }
    expect(
      translate("en", "changes.titles.relationSuggested", { values: { n: 3, source: "Book" } })
    ).toBe("3 connections suggested for “Book”");
  });
});
