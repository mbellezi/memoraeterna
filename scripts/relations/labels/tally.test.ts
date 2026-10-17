import { describe, expect, it } from "vitest";

import type { Answer, Sealed } from "./common.ts";
import { renderPass } from "./render.ts";
import { sampleLabelSet } from "./sample.ts";
import {
  fleissKappa,
  labelFixture,
  labelFixtureSchema,
  parseAnswers,
  tally,
  tallyItem,
  voteOf,
  type Vote
} from "./tally.ts";
import { testRenderSources, testWorld } from "./test-world.ts";

const yes = (type: string, direction: string | null = null): Answer => ({
  id: "x",
  related: "yes",
  type,
  direction
});
const no: Answer = { id: "x", related: "no", type: null, direction: null };
const votes = (...answers: Array<Answer | undefined>): Vote[] =>
  answers.map((answer) => voteOf(answer, "lo"));

describe("one judge's vote", () => {
  it("maps A->B and B->A to the sorted pair through the page's A/B order", () => {
    expect(voteOf(yes("supports", "A->B"), "lo").direction).toBe("lo_to_hi");
    expect(voteOf(yes("supports", "A->B"), "hi").direction).toBe("hi_to_lo");
    expect(voteOf(yes("extends", "B->A"), "lo").direction).toBe("hi_to_lo");
    expect(voteOf(yes("extends", "B->A"), "hi").direction).toBe("lo_to_hi");
    expect(voteOf(yes("same_as"), "hi").direction).toBe("symmetric");
  });

  it("keeps a valid related answer when its type or direction is invalid, and says why", () => {
    const badType = voteOf(yes("similar_to"), "lo");
    expect([badType.related, badType.type]).toEqual([true, null]);
    expect(badType.problems[0]).toMatch(/write vocabulary/u);
    const badDirection = voteOf(yes("supports", "both"), "lo");
    expect([badDirection.type, badDirection.direction]).toEqual(["supports", null]);
    expect(voteOf(undefined, "lo").problems).toEqual(["missing"]);
    expect(voteOf({ ...no, type: "supports" }, "lo")).toMatchObject({ related: false, type: null });
  });
});

describe("the majority per question", () => {
  it("takes the related majority and, among the yes answers, the type and direction majorities", () => {
    const result = tallyItem(
      votes(yes("supports", "A->B"), yes("supports", "A->B"), yes("extends", "B->A")),
      3
    );
    expect(result.related).toMatchObject({ majority: true, unanimous: true });
    expect(result.type).toMatchObject({ majority: "supports", unanimous: false });
    expect(result.direction).toMatchObject({ majority: "lo_to_hi" });
  });

  it("leaves a type with three different answers unresolved", () => {
    const result = tallyItem(
      votes(yes("supports", "A->B"), yes("extends", "A->B"), yes("clarifies", "A->B")),
      3
    );
    expect(result.related.majority).toBe(true);
    expect(result.type.majority).toBeNull();
    expect(result.direction.majority).toBeNull();
  });

  it("leaves two different types beside a no unresolved, and gives no type to a no majority", () => {
    expect(
      tallyItem(votes(yes("supports", "A->B"), yes("extends", "A->B"), no), 3).type.majority
    ).toBeNull();
    const negative = tallyItem(votes(no, no, yes("supports", "A->B")), 3);
    expect([
      negative.related.majority,
      negative.type.majority,
      negative.direction.majority
    ]).toEqual([false, null, null]);
    expect(negative.related.unanimous).toBe(false);
  });

  it("takes the direction among the judges of the majority type, a tie unresolved", () => {
    expect(
      tallyItem(votes(yes("supports", "A->B"), yes("supports", "B->A"), no), 3).direction.majority
    ).toBeNull();
    expect(
      tallyItem(votes(yes("supports", "A->B"), yes("supports", "B->A"), yes("supports", "B->A")), 3)
        .direction.majority
    ).toBe("hi_to_lo");
    expect(tallyItem(votes(yes("contradicts"), yes("contradicts"), no), 3).direction.majority).toBe(
      "symmetric"
    );
  });

  it("needs more than half of the panel: a missing answer can leave a tie", () => {
    const tie = tallyItem(votes(yes("supports", "A->B"), no, undefined), 3);
    expect(tie.related.majority).toBeNull();
    expect(tie.related.unanimous).toBe(false);
    expect(tallyItem(votes(no, no, undefined), 3).related).toMatchObject({
      majority: false,
      unanimous: false
    });
  });
});

describe("Fleiss' kappa", () => {
  it("matches the textbook example (Fleiss 1971 as tabulated on Wikipedia: 0.210)", () => {
    const table = [
      [0, 0, 0, 0, 14],
      [0, 2, 6, 4, 2],
      [0, 0, 3, 5, 6],
      [0, 3, 9, 2, 0],
      [2, 2, 8, 1, 1],
      [7, 7, 0, 0, 0],
      [3, 2, 6, 3, 0],
      [2, 5, 3, 2, 2],
      [6, 5, 2, 1, 0],
      [0, 2, 2, 3, 7]
    ];
    const ratings = table.map((row) =>
      Object.fromEntries(row.map((count, index) => [`c${index}`, count]))
    );
    expect(fleissKappa(ratings)!).toBeCloseTo(0.21, 3);
  });

  it("is 1 for full agreement over both categories and null with no chance disagreement", () => {
    expect(fleissKappa([{ yes: 3 }, { no: 3 }])).toBeCloseTo(1, 12);
    expect(fleissKappa([{ yes: 3 }, { yes: 3 }])).toBeNull();
    expect(fleissKappa([])).toBeNull();
  });
});

function renderedWorld() {
  const world = testWorld();
  const set = sampleLabelSet(world.input);
  const { sealed } = renderPass(set, testRenderSources(world, set), {
    labelSetSha256: "x",
    directory: "d"
  });
  return { set, sealed };
}

/** Judges that call pool items with s >= 3.3 related (as "supports", A->B), the third dissenting on some. */
function answersFor(
  sealed: Sealed,
  dissent: (index: number) => boolean
): Array<{ name: string; answers: Answer[] }> {
  return ["judge-1", "judge-2", "judge-3"].map((name, judge) => ({
    name,
    answers: sealed.items.map((item, index) => {
      const related = (item.score ?? 0) >= 3.3 !== (judge === 2 && dissent(index));
      return related
        ? { id: item.itemId, related: "yes", type: "supports", direction: "A->B" }
        : { id: item.itemId, related: "no", type: null, direction: null };
    })
  }));
}

describe("the tally of a pass", () => {
  it("counts labels and positives per pool and stratum, and the agreement per question", () => {
    const { sealed } = renderedWorld();
    const result = tally(
      sealed,
      answersFor(sealed, (index) => index % 4 === 0)
    );
    const high = result.strata.filter((row) => row.stratum >= 3 && row.items > 0);
    const low = result.strata.filter((row) => row.stratum < 3 && row.items > 0);
    expect(high.every((row) => row.positiveShare === 1)).toBe(true);
    expect(low.every((row) => row.positiveShare === 0)).toBe(true);
    expect(result.strata.reduce((sum, row) => sum + row.items, 0)).toBe(
      sealed.items.filter((item) => item.pool !== null).length
    );
    expect(result.unresolved).toEqual({ related: 0, type: 0, direction: 0 });
    const dissenting = sealed.items.filter((_, index) => index % 4 === 0).length;
    expect(result.agreement.related.items).toBe(sealed.items.length);
    expect(result.agreement.related.unanimous).toBe(sealed.items.length - dissenting);
    expect(result.agreement.related.kappa).toBeGreaterThan(0);
    expect(result.agreement.related.kappa).toBeLessThan(1);
    expect(result.judges.map((judge) => judge.missing)).toEqual([0, 0, 0]);
    const item = result.items.find((candidate) => candidate.related.majority === true)!;
    const sealedItem = sealed.items.find((candidate) => candidate.itemId === item.itemId)!;
    expect(item.direction.majority).toBe(sealedItem.shownA === "lo" ? "lo_to_hi" : "hi_to_lo");
  });

  it("refuses an unknown or twice-answered item and reports a short panel", () => {
    const { sealed } = renderedWorld();
    const judges = answersFor(sealed, () => false);
    expect(() =>
      tally(sealed, [{ name: "judge-1", answers: [{ id: "999-01", related: "no" }] }])
    ).toThrow(/unknown item id/u);
    const twice = [{ ...judges[0]!, answers: [...judges[0]!.answers, judges[0]!.answers[0]!] }];
    expect(() => tally(sealed, twice)).toThrow(/answered twice/u);
    expect(tally(sealed, judges.slice(0, 2)).problems[0]).toMatch(
      /2 answer files for a panel of 3/u
    );
  });

  it("writes the fixture with ids, content hashes and majority labels only", () => {
    const { sealed } = renderedWorld();
    const result = tally(
      sealed,
      answersFor(sealed, () => false)
    );
    const fixture = labelFixture(result, sealed);
    expect(labelFixtureSchema.parse(fixture).items).toHaveLength(sealed.items.length);
    const text = JSON.stringify(fixture);
    expect(text).not.toMatch(/Title of|Idea |Overview of/u);
    const entry = fixture.items.find((candidate) => candidate.related === true)!;
    expect(entry).toMatchObject({ type: "supports", votes: { yes: 3, no: 0 }, unanimous: true });
    expect(["lo_to_hi", "hi_to_lo"]).toContain(entry.direction);
    const pooled = sealed.items.find((item) => item.split !== null)!;
    expect(fixture.items.find((item) => item.pairId === pooled.pairId)).toMatchObject({
      group: pooled.group,
      split: pooled.split
    });
  });

  it("counts the split per pool and stratum and refuses held-out fit labels or a crossing group", () => {
    const { sealed } = renderedWorld();
    const result = tally(
      sealed,
      answersFor(sealed, () => false)
    );
    const pooled = sealed.items.filter((item) => item.split !== null);
    expect(result.splits.reduce((sum, row) => sum + row.items, 0)).toBe(pooled.length);
    expect(
      result.splits.filter((row) => row.split === "fit").reduce((sum, row) => sum + row.items, 0)
    ).toBe(pooled.filter((item) => item.split === "fit").length);
    const fit = pooled.find((item) => item.split === "fit")!;
    const heldOut: Sealed = {
      ...sealed,
      items: sealed.items.map((item) =>
        item === fit
          ? { ...item, library: "fixture", partitions: ["tuning", "holdout"] as [string, string] }
          : item
      )
    };
    expect(() => labelFixture(result, heldOut)).toThrow(/outside the tuning partition/u);
    const other = pooled.find((item) => item.split === "eval")!;
    const crossing: Sealed = {
      ...sealed,
      items: sealed.items.map((item) => (item === other ? { ...item, group: fit.group } : item))
    };
    expect(() => labelFixture(result, crossing)).toThrow(/crosses the splits/u);
  });

  it("checks a pass's consistency items against the panel's labels", () => {
    const { sealed } = renderedWorld();
    const passSealed: Sealed = {
      ...sealed,
      pass: "freeze",
      items: sealed.items.slice(0, 4).map((item) => ({
        ...item,
        sets: [{ set: "consistency", subpool: null, basis: null, anchor: null }]
      }))
    };
    const reference = new Map(passSealed.items.map((item, index) => [item.pairId, index !== 0]));
    const answers = ["judge-1", "judge-2", "judge-3"].map((name) => ({
      name,
      answers: passSealed.items.map((item) => ({
        id: item.itemId,
        related: "yes" as const,
        type: "same_as",
        direction: null
      }))
    }));
    expect(tally(passSealed, answers, 3, reference).consistency).toEqual({
      items: 4,
      compared: 4,
      agreeing: 3
    });
  });
});

describe("answer files", () => {
  it("read a JSON array, an answers object or JSON lines", () => {
    const line = { id: "001-01", related: "no", type: null, direction: null };
    expect(parseAnswers(JSON.stringify([line]), "j")).toHaveLength(1);
    expect(
      parseAnswers(JSON.stringify({ answers: [line, { ...line, id: "001-02" }] }), "j")
    ).toHaveLength(2);
    expect(
      parseAnswers(`${JSON.stringify(line)}\n${JSON.stringify({ ...line, id: "001-02" })}\n`, "j")
    ).toHaveLength(2);
    expect(() => parseAnswers('[{"id": "001-01", "related": "maybe"}]', "j")).toThrow(/malformed/u);
    expect(() => parseAnswers("not json", "j")).toThrow(/not valid JSON/u);
  });
});
