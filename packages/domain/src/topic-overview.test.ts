import { describe, expect, it } from "vitest";

import {
  TopicOverviewCancelInputSchema,
  TopicOverviewInputSchema,
  TopicOverviewResultSchema,
  estimateOverviewTokens,
  orderOverviewCandidates,
  overviewEvidenceTokens,
  overviewExcerpt,
  overviewSentences,
  overviewSupportVerdict,
  overviewTextSegments,
  selectOverviewEvidence,
  topicOverviewLimits,
  validateOverviewOutput,
  type OverviewEvidenceCandidate
} from "./topic-overview.js";
import { topicReadLimits } from "./topics.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const candidate = (
  n: number,
  overrides: Partial<OverviewEvidenceCandidate> = {}
): OverviewEvidenceCandidate => ({
  noteId: id(n),
  title: `Note ${n}`,
  idea: `Idea ${n}.`,
  passage: `Passage ${n}.`,
  round: 0,
  centrality: 0.5,
  contentKey: `key-${n}`,
  ...overrides
});

describe("overview limits", () => {
  it("keep the evidence within what a citation can name and the paragraphs within the contract", () => {
    expect(topicOverviewLimits.maxEvidence).toBeLessThanOrEqual(
      topicReadLimits.overviewCitationsMax
    );
    expect(topicOverviewLimits.maxParagraphs).toBeLessThanOrEqual(
      topicReadLimits.overviewParagraphsMax
    );
    expect(topicOverviewLimits.maxSupportDocuments).toBeLessThanOrEqual(32);
    expect(topicOverviewLimits.supportThreshold).toBeGreaterThan(0);
    expect(topicOverviewLimits.supportThreshold).toBeLessThan(1);
  });

  it("validate strict requests", () => {
    expect(TopicOverviewInputSchema.parse({ id: id(1) })).toEqual({ id: id(1) });
    expect(TopicOverviewInputSchema.parse({ id: id(1), force: true }).force).toBe(true);
    expect(TopicOverviewInputSchema.safeParse({ id: "x" }).success).toBe(false);
    expect(TopicOverviewInputSchema.safeParse({ id: id(1), extra: 1 }).success).toBe(false);
    expect(TopicOverviewCancelInputSchema.safeParse({ id: id(1), force: true }).success).toBe(
      false
    );
  });

  it("carry a ready overview with its evidence, language and support", () => {
    const ready = {
      status: "ready",
      stale: false,
      paragraphs: [{ text: "Sleep consolidates memory [1].", citations: [1] }],
      citations: [
        {
          n: 1,
          chunkId: id(10),
          sourceSpanId: id(11),
          noteId: id(12),
          sourceId: id(13),
          sourceTitle: "Book",
          excerpt: "Passage.",
          available: true
        }
      ],
      evidence: { used: 3, total: 9 },
      writtenAt: "2026-10-16T10:00:00.000Z",
      model: "writer",
      language: "pt-BR",
      support: { status: "checking", unsupported: [] }
    };
    expect(TopicOverviewResultSchema.safeParse(ready).success).toBe(true);
    // A citation whose chunk was replaced keeps its excerpt and loses its chunk.
    const gone = {
      ...ready,
      citations: [{ n: 1, sourceTitle: "", excerpt: "x", available: false }]
    };
    expect(TopicOverviewResultSchema.safeParse(gone).success).toBe(true);
  });
});

describe("overview evidence", () => {
  it("orders the best note of every topic first, then by centrality and content, IDs last", () => {
    const ordered = orderOverviewCandidates([
      candidate(1, { round: 1, centrality: 0.99 }),
      candidate(2, { round: 0, centrality: 0.4 }),
      candidate(3, { round: 0, centrality: 0.8 }),
      candidate(4, { round: 0, centrality: 0.4, contentKey: "a" }),
      candidate(5, { round: 0, centrality: null }),
      candidate(6, { round: 0, centrality: 0.4, contentKey: "a" })
    ]);
    expect(ordered.map((item) => item.noteId)).toEqual([id(3), id(4), id(6), id(2), id(5), id(1)]);
  });

  it("takes whole items within the budget, skipping one that does not fit, never cutting", () => {
    const big = "x".repeat(3_000);
    const items = [
      candidate(1, { centrality: 0.9 }),
      candidate(2, { centrality: 0.8, passage: big }),
      candidate(3, { centrality: 0.7 })
    ];
    const budget = overviewEvidenceTokens(items[0]!) + overviewEvidenceTokens(items[2]!);
    const { evidence, tokens } = selectOverviewEvidence(items, { budget });
    expect(evidence.map((item) => item.noteId)).toEqual([id(1), id(3)]);
    expect(tokens).toBe(budget);
    expect(evidence.every((item) => item.passage === items.find((i) => i === item)?.passage)).toBe(
      true
    );
  });

  it("stops at the item cap and never takes a note twice", () => {
    const items = Array.from({ length: 30 }, (_, n) => candidate(n % 20, { contentKey: `k${n}` }));
    const { evidence } = selectOverviewEvidence(items, { maxItems: 12, budget: 1e9 });
    expect(evidence).toHaveLength(12);
    expect(new Set(evidence.map((item) => item.noteId)).size).toBe(12);
  });

  it("estimates tokens conservatively in characters, emoji counted once", () => {
    expect(estimateOverviewTokens("")).toBe(0);
    expect(estimateOverviewTokens("abc")).toBe(1);
    expect(estimateOverviewTokens("abcd")).toBe(2);
    expect(estimateOverviewTokens("😀😀😀")).toBe(1);
  });

  it("keeps a short passage as the excerpt and cuts a long one at a word", () => {
    expect(overviewExcerpt("  Short\n passage. ")).toBe("Short passage.");
    const long = overviewExcerpt("word ".repeat(400));
    expect(Array.from(long).length).toBeLessThanOrEqual(topicReadLimits.overviewExcerptMax);
    expect(long.endsWith("word…")).toBe(true);
  });
});

describe("the model's answer", () => {
  it("renumbers citations by first appearance, markers and lists alike", () => {
    const result = validateOverviewOutput(
      {
        paragraphs: [
          { text: "Sleep  consolidates memory [3]. Naps help [5, 3].", citations: [3, 5] },
          { text: "Retrieval strengthens recall [E1-2].", citations: ["2"] }
        ]
      },
      5
    );
    expect(result).toEqual({
      ok: true,
      overview: {
        paragraphs: [
          { text: "Sleep consolidates memory [1]. Naps help [1, 2].", citations: [1, 2] },
          { text: "Retrieval strengthens recall [3, 4].", citations: [3, 4] }
        ],
        cited: [3, 5, 1, 2]
      }
    });
  });

  it("accepts a fenced-free JSON object and a paragraph that cites only through its list", () => {
    const result = validateOverviewOutput(
      { paragraphs: [{ text: "Tides follow the moon.", citations: [2] }] },
      2
    );
    expect(result.ok && result.overview).toEqual({
      paragraphs: [{ text: "Tides follow the moon.", citations: [1] }],
      cited: [2]
    });
  });

  it("refuses citations outside the evidence, uncited paragraphs, markup and too many paragraphs", () => {
    const outside = validateOverviewOutput(
      { paragraphs: [{ text: "Claim [7].", citations: [7] }] },
      3
    );
    expect(outside.ok).toBe(false);
    expect(!outside.ok && outside.errors.join(" ")).toContain("[7]");
    const uncited = validateOverviewOutput({ paragraphs: [{ text: "Claim.", citations: [] }] }, 3);
    expect(!uncited.ok && uncited.errors[0]).toContain("cites no evidence");
    const markup = validateOverviewOutput(
      { paragraphs: [{ text: "<b>Claim</b> [1]", citations: [1] }] },
      3
    );
    expect(!markup.ok && markup.errors[0]).toContain("markup");
    const many = validateOverviewOutput(
      {
        paragraphs: Array.from({ length: topicOverviewLimits.maxParagraphs + 1 }, () => ({
          text: "Claim [1].",
          citations: [1]
        }))
      },
      3
    );
    expect(many.ok).toBe(false);
    expect(validateOverviewOutput("not json", 3).ok).toBe(false);
    expect(validateOverviewOutput({ paragraphs: [] }, 3).ok).toBe(false);
    const zero = validateOverviewOutput({ paragraphs: [{ text: "Claim [0].", citations: [] }] }, 3);
    expect(zero.ok).toBe(false);
  });
});

describe("text segments and the support check", () => {
  it("splits a paragraph into text and citation markers, leaving unknown markers as text", () => {
    expect(overviewTextSegments("A [1]. B [1, 2] and [9].", (n) => n <= 2)).toEqual([
      { kind: "text", text: "A " },
      { kind: "citation", numbers: [1] },
      { kind: "text", text: ". B " },
      { kind: "citation", numbers: [1, 2] },
      { kind: "text", text: " and [9]." }
    ]);
    expect(overviewTextSegments("No markers.")).toEqual([{ kind: "text", text: "No markers." }]);
  });

  it("checks each sentence against the passages it cites, or its paragraph's", () => {
    const sentences = overviewSentences([
      {
        text: "Sleep consolidates memories at night [1]. Short naps, e.g. at noon, also help.[2] It matters.",
        citations: [1, 2]
      },
      { text: "Tides follow the moon twice a day [3].", citations: [3] }
    ]);
    expect(sentences).toEqual([
      { paragraph: 0, text: "Sleep consolidates memories at night.", citations: [1] },
      {
        paragraph: 0,
        text: "Short naps, e.g. at noon, also help. It matters.",
        citations: [2]
      },
      { paragraph: 1, text: "Tides follow the moon twice a day.", citations: [3] }
    ]);
  });

  it("verifies an overview whose every sentence is supported, and lists the paragraphs that are not", () => {
    const sentences = [{ paragraph: 0 }, { paragraph: 0 }, { paragraph: 2 }];
    expect(overviewSupportVerdict(sentences, [0.9, 0.6, 0.7])).toEqual({
      status: "verified",
      unsupported: [],
      sentences: { checked: 3, supported: 3 }
    });
    expect(overviewSupportVerdict(sentences, [0.9, 0.1, 0.2])).toEqual({
      status: "partial",
      unsupported: [0, 2],
      sentences: { checked: 3, supported: 1 }
    });
  });
});
