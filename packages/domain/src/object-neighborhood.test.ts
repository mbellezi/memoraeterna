import { describe, expect, it } from "vitest";

import {
  ObjectNeighborhoodInputSchema,
  ObjectNeighborhoodSchema,
  chooseSecondRing,
  objectNeighborhoodLimits,
  type NeighbourCandidate
} from "./object-neighborhood.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

describe("objects.neighborhood input (R30)", () => {
  it("defaults to the notes of depth 1 and the bound of 40 nodes", () => {
    expect(ObjectNeighborhoodInputSchema.parse({ objectId: id(1) })).toEqual({
      objectId: id(1),
      objectTypes: ["note"],
      depth: 1,
      limit: 40
    });
  });

  it("is restricted to notes, depth 1 or 2 and at most 40 nodes", () => {
    const base = { objectId: id(1) };
    expect(() =>
      ObjectNeighborhoodInputSchema.parse({ ...base, objectTypes: ["source"] })
    ).toThrow();
    expect(() => ObjectNeighborhoodInputSchema.parse({ ...base, objectTypes: [] })).toThrow();
    expect(() => ObjectNeighborhoodInputSchema.parse({ ...base, depth: 3 })).toThrow();
    expect(() => ObjectNeighborhoodInputSchema.parse({ ...base, depth: 0 })).toThrow();
    expect(() => ObjectNeighborhoodInputSchema.parse({ ...base, limit: 41 })).toThrow();
    expect(() => ObjectNeighborhoodInputSchema.parse({ ...base, limit: 0 })).toThrow();
    expect(() => ObjectNeighborhoodInputSchema.parse({ ...base, extra: true })).toThrow();
    expect(() => ObjectNeighborhoodInputSchema.parse({ objectId: "nope" })).toThrow();
    expect(ObjectNeighborhoodInputSchema.parse({ ...base, depth: 2, limit: 12 })).toMatchObject({
      depth: 2,
      limit: 12
    });
  });
});

describe("objects.neighborhood answer", () => {
  const node = (n: number, depth: 0 | 1 | 2) => ({
    id: id(n),
    kind: "note" as const,
    title: `Note ${n}`,
    ideaStatement: `Idea ${n}.`,
    language: null,
    depth
  });
  const answer = {
    focus: id(1),
    depth: 1 as const,
    nodes: [node(1, 0), node(2, 1)],
    edges: [
      {
        id: id(10),
        lo: id(1),
        hi: id(2),
        direction: "lo_to_hi" as const,
        type: "supports",
        state: "suggested" as const,
        band: "suggest" as const
      }
    ],
    neighbourTotal: 1,
    truncated: false
  };

  it("accepts an answer with suggestions and keeps no score", () => {
    expect(ObjectNeighborhoodSchema.parse(answer)).toEqual(answer);
    expect(() =>
      ObjectNeighborhoodSchema.parse({
        ...answer,
        edges: [{ ...answer.edges[0], finalScore: 0.9 }]
      })
    ).toThrow();
  });

  it("refuses withdrawn and removed relations, and more nodes than the bound", () => {
    expect(() =>
      ObjectNeighborhoodSchema.parse({
        ...answer,
        edges: [{ ...answer.edges[0], state: "withdrawn" }]
      })
    ).toThrow();
    expect(() =>
      ObjectNeighborhoodSchema.parse({
        ...answer,
        nodes: Array.from({ length: objectNeighborhoodLimits.nodes + 1 }, (_, n) => node(n + 1, 1))
      })
    ).toThrow();
    expect(() => ObjectNeighborhoodSchema.parse({ ...answer, nodes: [] })).toThrow();
  });
});

describe("the second ring of a depth-2 neighbourhood", () => {
  const candidate = (
    n: number,
    seedRank: number,
    probability: number | null,
    finalScore = 0.5
  ): NeighbourCandidate => ({ id: id(n), seedRank, probability, finalScore });

  it("ranks by probability with unknown last, then score, then the seed's strength, then ID", () => {
    const ring = chooseSecondRing(
      [
        candidate(5, 1, null, 0.9),
        candidate(6, 2, 0.4),
        candidate(7, 1, 0.8),
        candidate(8, 3, 0.4, 0.7),
        candidate(9, 2, 0.4, 0.7),
        candidate(4, 1, null, 0.9)
      ],
      new Set(),
      10
    );
    expect(ring).toEqual([id(7), id(9), id(8), id(6), id(4), id(5)]);
  });

  it("never returns the focus, a chosen note or a note twice, and stops at the slots", () => {
    const ring = chooseSecondRing(
      [candidate(1, 1, 0.99), candidate(2, 1, 0.9), candidate(3, 1, 0.8), candidate(3, 2, 0.7)],
      new Set([id(1), id(2)]),
      5
    );
    expect(ring).toEqual([id(3)]);
    expect(
      chooseSecondRing(
        [candidate(3, 1, 0.9), candidate(4, 1, 0.8), candidate(5, 1, 0.7)],
        new Set(),
        2
      )
    ).toEqual([id(3), id(4)]);
    expect(chooseSecondRing([candidate(3, 1, 0.9)], new Set(), 0)).toEqual([]);
  });
});
