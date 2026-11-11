import { describe, expect, it } from "vitest";

import {
  compareCodePoints,
  compareOmniHits,
  omniKindOrder,
  rrfK,
  rrfScore,
  type OmniRankedHit
} from "./rrf.js";

const hit = (overrides: Partial<OmniRankedHit> & Pick<OmniRankedHit, "arms">): OmniRankedHit => {
  const base = {
    address: "memora://note/00000000-0000-4000-8000-000000000001",
    kind: "note" as const,
    title: "A",
    ...overrides
  };
  return { ...base, score: overrides.score ?? rrfScore(base.arms.map(({ rank }) => rank)) };
};

describe("reciprocal rank fusion", () => {
  it("scores a hit as the sum of 1 / (60 + rank) over its arms", () => {
    expect(rrfK).toBe(60);
    expect(rrfScore([1])).toBe(1 / 61);
    expect(rrfScore([1, 3])).toBe(1 / 61 + 1 / 63);
    expect(rrfScore([])).toBe(0);
  });

  it("gives the same score whatever order the ranks arrive in", () => {
    const ranks = [7, 1, 19, 3, 12];
    const expected = rrfScore(ranks);
    expect(rrfScore([...ranks].reverse())).toBe(expected);
    expect(rrfScore([3, 19, 7, 12, 1])).toBe(expected);
  });

  it("refuses a rank that is not a positive integer", () => {
    expect(() => rrfScore([0])).toThrow(RangeError);
    expect(() => rrfScore([1.5])).toThrow(RangeError);
  });

  it("ranks a hit two arms found above one found first by a single arm", () => {
    const both = hit({
      title: "Fermentation",
      arms: [
        { arm: "title_trgm", rank: 2 },
        { arm: "fts", rank: 2 }
      ]
    });
    const single = hit({ title: "Ferment", arms: [{ arm: "title_trgm", rank: 1 }] });
    expect([single, both].sort(compareOmniHits)).toEqual([both, single]);
  });
});

describe("the deterministic tiebreak", () => {
  const address = (kind: string, n: number) =>
    `memora://${kind}/00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

  it("orders equal scores by the best arm rank", () => {
    // 1/61 + 1/70 against 1/63 + 1/66: different scores, so build two equal ones instead.
    const a = hit({ arms: [{ arm: "fts", rank: 3 }], score: 1, address: address("note", 1) });
    const b = hit({ arms: [{ arm: "fts", rank: 2 }], score: 1, address: address("note", 2) });
    expect([a, b].sort(compareOmniHits)).toEqual([b, a]);
  });

  it("then by kind: topic, source, note, entity, question", () => {
    expect(omniKindOrder).toEqual(["topic", "source", "note", "entity", "question"]);
    const arms = [{ arm: "title_trgm" as const, rank: 1 }];
    const hits = (["question", "entity", "note", "source", "topic"] as const).map((kind, n) =>
      hit({ kind, arms, title: "Same", address: address(kind, n) })
    );
    expect(hits.sort(compareOmniHits).map(({ kind }) => kind)).toEqual(omniKindOrder);
  });

  it("then by title and address, by code point", () => {
    const arms = [{ arm: "title_trgm" as const, rank: 1 }];
    const lower = hit({ arms, title: "apple", address: address("note", 1) });
    const upper = hit({ arms, title: "Banana", address: address("note", 2) });
    const accented = hit({ arms, title: "Árvore", address: address("note", 3) });
    const twin = hit({ arms, title: "apple", address: address("note", 0) });
    expect([lower, accented, upper, twin].sort(compareOmniHits)).toEqual([
      upper,
      twin,
      lower,
      accented
    ]);
  });

  it("is a total order: only the same address compares equal", () => {
    const arms = [{ arm: "ann" as const, rank: 4 }];
    const a = hit({ arms, address: address("source", 1) });
    const b = hit({
      arms,
      address: `${address("source", 1)}#passage=${address("x", 2).slice(-36)}`
    });
    expect(compareOmniHits(a, b)).toBeLessThan(0);
    expect(compareOmniHits(b, a)).toBeGreaterThan(0);
    expect(compareOmniHits(a, { ...a })).toBe(0);
  });
});

describe("code point comparison", () => {
  it("matches byte order of UTF-8, also beyond the basic plane", () => {
    expect(compareCodePoints("a", "b")).toBe(-1);
    expect(compareCodePoints("Z", "a")).toBe(-1);
    expect(compareCodePoints("ab", "a")).toBe(1);
    expect(compareCodePoints("", "")).toBe(0);
    // U+FF21 (fullwidth A) sorts before U+1F600 by code point, after it by UTF-16 unit.
    expect(compareCodePoints("Ａ", "\u{1F600}")).toBe(-1);
    expect("Ａ" < "\u{1F600}").toBe(false);
  });
});
