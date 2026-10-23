import { describe, expect, it } from "vitest";

import { changeSetReadLimits } from "./change-sets.js";
import {
  TopicOverviewPatchOutputSchema,
  TopicOverviewRefreshConfigSchema,
  overviewDirtiness,
  overviewPatchBaseTokens,
  overviewPatchCitedExcerpt,
  overviewPatchParagraphsMax,
  overviewEvidenceTokens,
  patchedOverviewSupport,
  selectPatchEvidence,
  topicOverviewLimits,
  topicOverviewRefreshConfig,
  topicOverviewRefreshPriority,
  topicOverviewRefreshScore,
  validateOverviewPatch,
  type PatchEvidenceCandidate
} from "./topic-overview.js";
import { topicReadLimits } from "./topics.js";

// REFRESH's pure rules (F4 D17, T84): what is new evidence, how much a refresh matters, and the
// additive patch's validator (old text untouched, numbering continued, Divergences side by side).

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const candidate = (
  n: number,
  overrides: Partial<PatchEvidenceCandidate> = {}
): PatchEvidenceCandidate => ({
  noteId: id(n),
  title: `Note ${n}`,
  idea: `Idea ${n}.`,
  passage: `Passage ${n}.`,
  passageHash: `hash-${n}`,
  round: 0,
  centrality: 1 - n / 100,
  contentKey: `key-${n}`,
  ...overrides
});

describe("REFRESH's configuration", () => {
  it("starts from the decided values and refuses an inverted range", () => {
    expect(topicOverviewRefreshConfig).toMatchObject({
      minPlacedNotes: 3,
      openedWithinDays: 30,
      priorityMin: -100,
      priorityMax: -1
    });
    expect(topicOverviewRefreshConfig.debounceMs).toBeLessThanOrEqual(
      topicOverviewRefreshConfig.debounceMaxMs
    );
    expect(
      TopicOverviewRefreshConfigSchema.safeParse({ priorityMin: -1, priorityMax: -5 }).success
    ).toBe(false);
    expect(TopicOverviewRefreshConfigSchema.safeParse({ priorityMax: 0 }).success).toBe(false);
    expect(TopicOverviewRefreshConfigSchema.safeParse({ unknown: 1 }).success).toBe(false);
  });
});

describe("dirtiness, views and recency (D17)", () => {
  it("counts the candidates the stored overview was not written from", () => {
    const candidates = [candidate(1), candidate(2), candidate(3), candidate(4)];
    expect(overviewDirtiness(candidates, null)).toBe(1);
    expect(overviewDirtiness([], [])).toBe(0);
    const stored = [
      { noteId: id(1), contentHash: "hash-1" },
      { noteId: id(2), contentHash: "hash-2" },
      { noteId: id(3), contentHash: "hash-3" }
    ];
    expect(overviewDirtiness(candidates, stored)).toBe(0.25);
    // A note whose passage changed is new evidence again.
    expect(
      overviewDirtiness([candidate(1, { passageHash: "changed" }), candidate(2)], stored)
    ).toBe(0.5);
  });

  it("orders by dirtiness × views × recency, within REFRESH's range of priorities", () => {
    const score = (dirtiness: number, openCount: number, openedDaysAgo: number | null) =>
      topicOverviewRefreshScore({ dirtiness, openCount, openedDaysAgo });
    expect(score(0, 10, 0)).toBe(0);
    expect(score(1, 5, 0)).toBe(1);
    expect(score(1, 2, 0)).toBeGreaterThan(score(0.5, 2, 0));
    expect(score(0.5, 4, 0)).toBeGreaterThan(score(0.5, 1, 0));
    expect(score(0.5, 4, 1)).toBeGreaterThan(score(0.5, 4, 20));
    // Never opened: the floors keep it ordered by dirtiness.
    expect(score(1, 0, null)).toBeGreaterThan(score(0.5, 0, null));
    expect(score(1, 0, null)).toBeGreaterThan(0);
    expect(topicOverviewRefreshPriority(0)).toBe(-100);
    expect(topicOverviewRefreshPriority(1)).toBe(-1);
    expect(topicOverviewRefreshPriority(Number.NaN)).toBe(-100);
    expect(topicOverviewRefreshPriority(0.5)).toBe(-50);
    for (const value of [0, 0.01, 0.3, 0.99, 1, 2, -1])
      expect(topicOverviewRefreshPriority(value)).toBeLessThan(0);
  });
});

describe("the new evidence of a patch", () => {
  const stored = {
    evidence: [
      { noteId: id(1), contentHash: "hash-1" },
      { noteId: id(2), contentHash: "hash-2" }
    ],
    paragraphs: [{ text: "Notes one and two agree [1, 2]." }],
    citedExcerpts: ["Passage 1.", "Passage 2."]
  };

  it("offers only what the overview was not written from, in evidence order", () => {
    const { evidence } = selectPatchEvidence(
      [candidate(4), candidate(1), candidate(3), candidate(2, { passageHash: "edited" })],
      stored
    );
    expect(evidence.map((item) => item.noteId)).toEqual([id(2), id(3), id(4)]);
  });

  it("spends the budget minus the stored paragraphs and excerpts, and leaves room for citations", () => {
    const long = "word ".repeat(2_000);
    const big = (n: number) => candidate(n, { passage: long });
    const base = overviewPatchBaseTokens(stored.paragraphs, stored.citedExcerpts);
    expect(base).toBeGreaterThan(0);
    const { evidence, budget } = selectPatchEvidence([big(3), big(4), big(5), big(6)], stored);
    expect(budget).toBe(topicOverviewLimits.evidenceTokenBudget - base);
    const spent = evidence.reduce((total, item) => total + overviewEvidenceTokens(item), 0);
    expect(spent).toBeLessThanOrEqual(budget);
    expect(evidence.length).toBeLessThan(4);
    // A stored overview at the citation cap gets no new evidence.
    const full = {
      ...stored,
      citedExcerpts: Array.from({ length: topicReadLimits.overviewCitationsMax }, () => "x")
    };
    expect(selectPatchEvidence([candidate(9)], full).evidence).toEqual([]);
  });

  it("asks a full topic for nothing, others for at most the paragraph limit", () => {
    expect(overviewPatchParagraphsMax(0)).toBe(topicOverviewLimits.maxParagraphs);
    expect(overviewPatchParagraphsMax(9)).toBe(3);
    expect(overviewPatchParagraphsMax(topicReadLimits.overviewParagraphsMax)).toBe(0);
  });

  it("shows the stored citations as short excerpts", () => {
    expect(overviewPatchCitedExcerpt("  short\n text ")).toBe("short text");
    const cut = overviewPatchCitedExcerpt("word ".repeat(200));
    expect(Array.from(cut).length).toBeLessThanOrEqual(topicOverviewLimits.patchCitedExcerptChars);
    expect(cut.endsWith("…")).toBe(true);
  });
});

describe("the patch's answer", () => {
  const numbering = { existingCitations: 3, newEvidence: 4, maxParagraphs: 3 };

  it("continues the stored numbering in order of first use, markers and Divergences alike", () => {
    const result = validateOverviewPatch(
      {
        paragraphs: ["A new idea  [5].", "More [E4, 7] beside the old point [2]."],
        divergences: [
          { existing: "E2", new: "E5", summary: "The new study found the opposite." },
          { existing: "3", new: "e6", summary: " Uncited  but contradicting. " }
        ]
      },
      numbering
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.patch.paragraphs).toEqual([
      { text: "A new idea [4].", citations: [4] },
      { text: "More [5, 6] beside the old point [2].", citations: [2, 5, 6] }
    ]);
    // Citation 4 is new item 2 (E5), 5 is new item 1 (E4), 6 is new item 4 (E7), 7 new item 3 (E6).
    expect(result.patch.cited).toEqual([2, 1, 4, 3]);
    expect(result.patch.divergences).toEqual([
      { existing: "E2", new: "E4", summary: "The new study found the opposite." },
      { existing: "E3", new: "E7", summary: "Uncited but contradicting." }
    ]);
  });

  it("accepts no new paragraph (no change)", () => {
    expect(validateOverviewPatch({ paragraphs: [], divergences: [] }, numbering)).toEqual({
      ok: true,
      patch: { paragraphs: [], cited: [], divergences: [] }
    });
  });

  it("refuses what would touch or merely repeat the stored text, and names it for the repair", () => {
    const errors = (output: unknown, options = numbering) => {
      const result = validateOverviewPatch(output, options);
      return result.ok ? [] : result.errors;
    };
    expect(errors({ paragraphs: "text" })).toEqual(["The answer is not the JSON shape asked for."]);
    expect(errors({ paragraphs: ["Only old [1, 2]."], divergences: [] })).toEqual([
      "New paragraph 1 cites no new evidence; cite the new item (4 to 7) it adds."
    ]);
    expect(errors({ paragraphs: ["Out of range [9]."], divergences: [] })).toEqual([
      "New paragraph 1 cites [9], which is not in the evidence (the evidence is numbered 1 to 7).",
      "New paragraph 1 cites no new evidence; cite the new item (4 to 7) it adds."
    ]);
    expect(errors({ paragraphs: ["<b>Bold</b> [4]."], divergences: [] })).toEqual([
      "New paragraph 1 contains markup; write plain text."
    ]);
    expect(errors({ paragraphs: ["  "], divergences: [] })).toEqual(["New paragraph 1 is empty."]);
    expect(
      errors({ paragraphs: ["One [4].", "Two [5].", "Three [6].", "Four [7]."], divergences: [] })
    ).toEqual(["Write at most 3 new paragraphs (the answer has 4)."]);
    expect(
      errors({
        paragraphs: ["One [4]."],
        divergences: [{ existing: "E5", new: "E2", summary: "Backwards." }]
      })
    ).toEqual([
      'Divergence 1 names "E5" as existing; use one of E1 to E3.',
      'Divergence 1 names "E2" as new; use one of E4 to E7.'
    ]);
    expect(
      errors({
        paragraphs: ["One [4]."],
        divergences: [{ existing: "E1", new: "E4", summary: " " }]
      })
    ).toEqual(["Divergence 1 has no summary."]);
    expect(
      errors({
        paragraphs: ["One [4]."],
        divergences: [{ existing: "E1", new: "E4", summary: "x".repeat(700) }]
      })
    ).toEqual([
      `Divergence 1 is longer than ${changeSetReadLimits.divergenceSummaryMax} characters.`
    ]);
    expect(
      errors(
        {
          paragraphs: ["One [4]."],
          divergences: [{ existing: "E1", new: "E4", summary: "Too many." }]
        },
        { ...numbering, existingDivergences: changeSetReadLimits.divergencesMax }
      )
    ).toEqual(["Name at most 0 divergences."]);
    // The citations of the whole overview stay within the contract.
    expect(
      errors(
        { paragraphs: ["One [40] and [41]."], divergences: [] },
        { existingCitations: 39, newEvidence: 2, maxParagraphs: 3 }
      )
    ).toEqual(["Cite at most 1 new evidence items in all."]);
  });

  it("is a strict wire contract with every member required", () => {
    expect(TopicOverviewPatchOutputSchema.safeParse({ paragraphs: [] }).success).toBe(false);
    expect(
      TopicOverviewPatchOutputSchema.safeParse({ paragraphs: [], divergences: [] }).success
    ).toBe(true);
  });
});

describe("the support of a patched overview", () => {
  const verified = {
    status: "verified" as const,
    unsupported: [],
    sentences: { checked: 4, supported: 4 }
  };

  it("keeps the old verdict and marks the new paragraphs unchecked until they are checked", () => {
    expect(patchedOverviewSupport(verified, null)).toEqual({ ...verified, status: "partial" });
    expect(patchedOverviewSupport({ status: "unchecked", unsupported: [] }, null)).toEqual({
      status: "unchecked",
      unsupported: []
    });
  });

  it("adds the new sentences' verdict to the old one", () => {
    expect(
      patchedOverviewSupport(verified, {
        status: "verified",
        unsupported: [],
        sentences: { checked: 2, supported: 2 }
      })
    ).toEqual({ status: "verified", unsupported: [], sentences: { checked: 6, supported: 6 } });
    expect(
      patchedOverviewSupport(
        { status: "partial", unsupported: [0], sentences: { checked: 3, supported: 2 } },
        { status: "partial", unsupported: [2], sentences: { checked: 2, supported: 1 } }
      )
    ).toEqual({ status: "partial", unsupported: [0, 2], sentences: { checked: 5, supported: 3 } });
    // Old paragraphs never checked: verified new ones make it partly verified, never verified.
    expect(
      patchedOverviewSupport(
        { status: "unchecked", unsupported: [] },
        { status: "verified", unsupported: [], sentences: { checked: 2, supported: 2 } }
      )
    ).toEqual({ status: "partial", unsupported: [], sentences: { checked: 2, supported: 2 } });
  });
});
