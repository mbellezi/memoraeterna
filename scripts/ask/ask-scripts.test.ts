import { consultationCandidatesSql } from "@app/db";
import { describe, expect, it } from "vitest";

import {
  compareCandidates,
  largestSignalDifference,
  percentile,
  summarize,
  type CandidateRow
} from "./bench-lib.js";
import {
  contentWords,
  createRandom,
  phraseOf,
  pickWeighted,
  questionOf,
  stripAccents,
  type QuestionKind,
  type QuestionPools
} from "./combos.js";
import { legacyCandidatesSql } from "./legacy-candidates.js";

const row = (overrides: CandidateRow = {}): CandidateRow => ({
  rootId: "r",
  chunkId: "c1",
  sourceItemId: "s",
  documentId: "d",
  sourceSpanId: null,
  contentHash: "h",
  excerpt: "text",
  sourceTitle: "Title",
  chunkIndex: 0,
  documentCreatedAt: new Date("2026-10-01T00:00:00Z"),
  locator: null,
  total: 2,
  text: 0.1,
  title: 0,
  concept: 0,
  note: 0.25,
  entity: 0,
  relation: 0,
  ...overrides
});

describe("the candidates measurement statistics", () => {
  it("takes the nearest-rank percentile", () => {
    const values = Array.from({ length: 100 }, (_, index) => index + 1);
    expect(percentile(values, 50)).toBe(50);
    expect(percentile(values, 95)).toBe(95);
    expect(percentile(values, 99)).toBe(99);
    expect(percentile([7], 95)).toBe(7);
    expect(percentile([], 95)).toBeNaN();
    expect(summarize([4, 1, 3, 2])).toMatchObject({ count: 4, min: 1, max: 4, p50: 2, mean: 2.5 });
  });

  it("calls two result lists identical only when passages, order and every signal agree to 1e-9", () => {
    const base = [row(), row({ chunkId: "c2", text: 0.2 })];
    expect(compareCandidates(base, structuredClone(base))).toEqual([]);
    const near = [row({ text: 0.1 + 5e-10 }), row({ chunkId: "c2", text: 0.2 })];
    expect(compareCandidates(base, near)).toEqual([]);
    expect(largestSignalDifference(base, near)).toBeCloseTo(5e-10, 12);
    expect(compareCandidates(base, [row({ text: 0.1 + 2e-9 }), base[1]!])).toEqual([
      { position: 0, field: "text", expected: 0.1, actual: 0.1 + 2e-9 }
    ]);
    // A reordered list, a missing row, another total and another excerpt each differ.
    expect(compareCandidates(base, [base[1]!, base[0]!]).map((d) => d.field)).toContain("chunkId");
    expect(compareCandidates(base, [base[0]!])).toEqual([
      { position: -1, field: "length", expected: 2, actual: 1 }
    ]);
    expect(compareCandidates(base, [row({ total: 3 }), base[1]!])[0]).toMatchObject({
      field: "total"
    });
    expect(compareCandidates(base, [row({ excerpt: "other" }), base[1]!])[0]).toMatchObject({
      field: "excerpt"
    });
  });
});

describe("the question and scope combinations", () => {
  const pools: QuestionPools = {
    chunks: [
      {
        sourceItemId: "a",
        content: "A fotossíntese converte luz em açúcar. Água e memória, ação!"
      },
      { sourceItemId: "b", content: "Plain passage about neural networks and gradient descent." }
    ],
    ideas: ["Photosynthesis turns light into sugar in plants"],
    titles: ["Fotossíntese e Água"],
    entities: ["Fotossíntese"]
  };
  const kinds: QuestionKind[] = [
    "passage-words",
    "idea",
    "title",
    "title-folded",
    "entity",
    "natural",
    "accent-stripped",
    "stop-words",
    "no-match",
    "punctuation"
  ];

  it("draws the same sequence from the same seed", () => {
    const [a, b, c] = [createRandom(7), createRandom(7), createRandom(8)];
    const sequence = (random: () => number) => Array.from({ length: 5 }, random);
    expect(sequence(a)).toEqual(sequence(b));
    expect(sequence(createRandom(7))).not.toEqual(sequence(c));
    expect(sequence(createRandom(1)).every((value) => value >= 0 && value < 1)).toBe(true);
  });

  it("picks by weight and never an item of weight zero", () => {
    const random = createRandom(3);
    const drawn = new Set(
      Array.from({ length: 300 }, () =>
        pickWeighted(random, [
          ["a", 1],
          ["never", 0],
          ["b", 3]
        ] as const)
      )
    );
    expect([...drawn].toSorted()).toEqual(["a", "b"]);
  });

  it("reads the words and phrases of a text", () => {
    expect(contentWords("The cat; the CAT sat on 2 mats, y ação.")).toEqual(["mats", "ação"]);
    expect(contentWords("ab abc abcd", 3)).toEqual(["abc", "abcd"]);
    expect(stripAccents("Fotossíntese, ação, ÁGUA")).toBe("Fotossintese, acao, AGUA");
    const phrase = phraseOf(createRandom(5), "uno dos tres cuatro cinco seis", 3);
    expect("uno dos tres cuatro cinco seis").toContain(phrase);
    expect(phrase.split(" ")).toHaveLength(3);
    expect(phraseOf(createRandom(5), "solo dos", 4)).toBe("solo dos");
  });

  it("makes a question of every kind, the same way for the same seed", () => {
    for (const kind of kinds) {
      const first = questionOf(createRandom(11), kind, pools, () => true);
      expect(first.length, kind).toBeGreaterThan(0);
      expect(
        questionOf(createRandom(11), kind, pools, () => true),
        kind
      ).toBe(first);
    }
    expect(questionOf(createRandom(2), "title", pools, () => true)).toBe("Fotossíntese e Água");
    expect(questionOf(createRandom(2), "title-folded", pools, () => true)).toBe(
      "FOTOSSINTESE E AGUA"
    );
    expect(questionOf(createRandom(2), "entity", pools, () => true)).toBe("Fotossíntese");
    expect(questionOf(createRandom(2), "accent-stripped", pools, () => true)).not.toMatch(
      /\p{M}|ç|ã/u
    );
  });

  it("quotes only the passages of the scope when it holds some, any passage otherwise", () => {
    const only = (id: string) => id === "b";
    for (let seed = 1; seed <= 20; seed += 1)
      expect(questionOf(createRandom(seed), "passage-words", pools, only)).toMatch(
        /^(plain|passage|about|neural|networks|and|gradient|descent| )+$/u
      );
    expect(questionOf(createRandom(1), "passage-words", pools, () => false).length).toBeGreaterThan(
      0
    );
  });
});

describe("the statement as it ran before the stored vectors", () => {
  it("is the product statement with the per-row text, title, note and entity expressions put back", () => {
    for (const stored of ["search_tsv", "ask_tsv", "title_ranks", "entity_ranks"])
      expect(legacyCandidatesSql).not.toContain(stored);
    expect(legacyCandidatesSql).toContain("to_tsvector('simple',unaccent(c.content))");
    expect(legacyCandidatesSql).toContain(
      "to_tsvector('simple',unaccent(n.idea_statement||' '||n.body_markdown))"
    );
    expect(legacyCandidatesSql).toContain(
      "from entity_mentions m join entities e on e.id=m.entity_id"
    );
    expect(consultationCandidatesSql).toContain("c.search_tsv");
    expect(consultationCandidatesSql).toContain("n.ask_tsv");
    // Everything else is the product's own: the scope, concepts, relations, ordering and limit.
    for (const shared of [
      "concept_ranks",
      "relation_ranks",
      "limit 200",
      "count(*) over()::int as total"
    ]) {
      expect(legacyCandidatesSql).toContain(shared);
      expect(consultationCandidatesSql).toContain(shared);
    }
  });
});
