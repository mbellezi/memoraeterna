import { describe, expect, it } from "vitest";

import {
  buildQuerySet,
  mulberry32,
  normalizeTitle,
  omniQueryKinds,
  omniQuerySeed,
  prefixOf,
  typedPrefixes,
  type OmniQueryKind,
  type TitleSample
} from "./omni-queries.js";

const words = ["memoria", "atlas", "grafo", "teoria", "ensaio", "campo", "ponte", "rede"];
function titlesOf(kind: string, count: number): TitleSample[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `${kind}-${String(index).padStart(4, "0")}`,
    title: `${words[index % words.length]} ${kind} ${index} sobre a natureza das coisas`
  }));
}
const library = (count = 120): Record<OmniQueryKind, TitleSample[]> => ({
  source: titlesOf("source", count),
  topic: titlesOf("topic", count),
  note: titlesOf("note", count),
  entity: titlesOf("entity", count),
  question: []
});

describe("mulberry32", () => {
  it("gives the same sequence for the same seed and another for another seed", () => {
    const a = mulberry32(omniQuerySeed);
    const b = mulberry32(omniQuerySeed);
    const first = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(first);
    expect(first.every((value) => value >= 0 && value < 1)).toBe(true);
    const other = mulberry32(omniQuerySeed + 1);
    expect(Array.from({ length: 5 }, () => other())).not.toEqual(first);
  });

  it("matches the published first value of seed 1", () => {
    expect(mulberry32(1)()).toBeCloseTo(0.6270739405881613, 12);
  });
});

describe("buildQuerySet", () => {
  it("is deterministic: the same titles and seed give the same set, in any input order", () => {
    const first = buildQuerySet(library());
    expect(buildQuerySet(library())).toEqual(first);
    const reversed = Object.fromEntries(
      Object.entries(library()).map(([kind, items]) => [kind, items.toReversed()])
    );
    expect(buildQuerySet(reversed)).toEqual(first);
  });

  it("changes with the seed", () => {
    expect(buildQuerySet(library(), { seed: 1 })).not.toEqual(buildQuerySet(library()));
  });

  it("draws 50 per kind from the kinds that have titles: 200 over four kinds", () => {
    const set = buildQuerySet(library());
    expect(set).toHaveLength(200);
    for (const kind of omniQueryKinds)
      expect(set.filter((query) => query.kind === kind)).toHaveLength(kind === "question" ? 0 : 50);
    expect(new Set(set.map((query) => `${query.kind}:${query.id}`)).size).toBe(200);
  });

  it("does not move a kind's draw when another kind is empty or present", () => {
    const base = buildQuerySet(library());
    const more = buildQuerySet({ ...library(), question: titlesOf("question", 80) });
    expect(more.filter((query) => query.kind !== "question")).toEqual(base);
    expect(more.filter((query) => query.kind === "question")).toHaveLength(50);
  });

  it("takes every candidate of a small kind and nothing from an empty one", () => {
    expect(buildQuerySet({ topic: titlesOf("topic", 7) })).toHaveLength(7);
    expect(buildQuerySet({})).toEqual([]);
  });

  it("makes each query a 2-12 character prefix of its title, without a trailing space", () => {
    for (const query of buildQuerySet(library(), { seed: 7 })) {
      const length = [...query.query].length;
      expect(length).toBeGreaterThanOrEqual(2);
      expect(length).toBeLessThanOrEqual(12);
      expect(query.title.startsWith(query.query)).toBe(true);
      expect(query.query).toBe(query.query.trimEnd());
    }
  });

  it("uses every length from 2 to 12 over a large draw", () => {
    const lengths = new Set(
      buildQuerySet({ note: titlesOf("note", 400) }, { perKind: 400 }).map(
        (query) => [...query.query].length
      )
    );
    expect([...lengths].toSorted((a, b) => a - b)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
  });

  it("skips titles too short to type two characters of and normalises whitespace", () => {
    const set = buildQuerySet({
      note: [
        { id: "a", title: "x" },
        { id: "b", title: "  " },
        { id: "c", title: "  Teoria \n  dos   grafos  " }
      ]
    });
    expect(set).toHaveLength(1);
    expect(set[0]!.title).toBe("Teoria dos grafos");
  });

  it("is pinned: the first queries of a fixed library with the default seed never change", () => {
    const set = buildQuerySet(library(), { perKind: 2 });
    expect(set.map((query) => `${query.kind}|${query.id}|${query.query}`)).toEqual([
      "source|source-0050|grafo",
      "source|source-0101|ca",
      "topic|topic-0001|atlas topic",
      "topic|topic-0013|campo topi",
      "note|note-0080|memoria no",
      "note|note-0078|pon",
      "entity|entity-0018|grafo",
      "entity|entity-0113|atlas"
    ]);
  });
});

describe("prefixes", () => {
  it("takes code points and drops a trailing space", () => {
    expect(prefixOf("Teoria dos grafos", 7)).toBe("Teoria");
    expect(prefixOf("Coração", 4)).toBe("Cora");
    expect(prefixOf("𝒜𝒷𝒸d", 3)).toBe("𝒜𝒷𝒸");
    expect(normalizeTitle(" a \t b ")).toBe("a b");
  });

  it("types the query one key at a time from two characters", () => {
    expect(
      typedPrefixes({ kind: "note", id: "n", title: "Teoria dos grafos", query: "Teoria d" })
    ).toEqual(["Te", "Teo", "Teor", "Teori", "Teoria", "Teoria d"]);
    expect(typedPrefixes({ kind: "note", id: "n", title: "ab", query: "ab" })).toEqual(["ab"]);
  });
});
