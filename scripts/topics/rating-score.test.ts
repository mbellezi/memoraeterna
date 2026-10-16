import { describe, expect, it } from "vitest";

import { ManifestFileSchema, ratingProfiles } from "./rating-core.js";
import type { ManifestFile, RatingProfile, SealedFile } from "./rating-core.js";
import {
  AnswersFileSchema,
  renderScoreMarkdown,
  renderScoreText,
  scoreRating
} from "./rating-score.js";
import type { AnswersFile } from "./rating-score.js";

const layout: readonly { profile: RatingProfile; stratum: string; level: number }[] = [
  ...Array.from({ length: 6 }, () => ({ profile: "env-c" as const, stratum: "area", level: 1 })),
  ...Array.from({ length: 6 }, () => ({ profile: "env-c" as const, stratum: "level-2", level: 2 })),
  ...Array.from({ length: 8 }, () => ({
    profile: "env-c" as const,
    stratum: "level-3-plus",
    level: 3
  })),
  ...Array.from({ length: 5 }, () => ({ profile: "env-g" as const, stratum: "leaf", level: 2 })),
  ...Array.from({ length: 5 }, () => ({ profile: "env-f" as const, stratum: "leaf", level: 2 }))
];

const sealed: SealedFile = {
  version: 1,
  seed: 20261016,
  entries: layout.map((entry, at) => ({
    key: `t${String(at + 1).padStart(2, "0")}`,
    position: at + 1,
    ...entry,
    leaf: entry.stratum === "leaf",
    subtreeNotes: 10,
    treeId: "tree",
    configHash: "hash",
    topicId: `topic-${at + 1}`,
    name: `Topic ${at + 1}`,
    nameState: "named",
    nameSource: "llm",
    nameLanguage: "pt-BR",
    memberNoteIds: []
  }))
};

/** Answers for the 30 topics: `both` rated yes/yes first, then the given leftovers. */
function answers(
  rows: readonly (readonly [boolean | null, boolean | null])[],
  notes: Record<string, string> = {}
): AnswersFile {
  const result: AnswersFile["answers"] = {};
  rows.forEach(([coerente, bemNomeado], at) => {
    const key = `t${String(at + 1).padStart(2, "0")}`;
    result[key] = { coerente, bemNomeado, notas: notes[key] ?? "" };
  });
  return { key: "memora.topicRating.abc", answers: result };
}

const yes = [true, true] as const;
const rows = (both: number, rest: readonly [boolean | null, boolean | null]) =>
  Array.from({ length: 30 }, (_, at) => (at < both ? yes : rest));

describe("scoring the owner's rating (D20)", () => {
  it("passes at exactly 24 of 30 rated both yes", () => {
    const score = scoreRating({ sealed, answers: answers(rows(24, [true, false])) });
    expect(score.total.both).toBe(24);
    expect(score.complete).toBe(true);
    expect(score.passes).toBe(true);
    expect(score.passBar).toBe(24);
  });

  it("does not pass at 23, however high the marginals are", () => {
    const score = scoreRating({ sealed, answers: answers(rows(23, [true, false])) });
    expect(score.total.both).toBe(23);
    expect(score.total.coherentYes).toBe(30);
    expect(score.total.namedYes).toBe(23);
    expect(score.passes).toBe(false);
  });

  it("counts a topic only when both answers are yes, and reports the marginals apart", () => {
    // 10 yes/yes, 10 coherent only, 10 well named only: each marginal is 20, both is 10.
    const mixed = Array.from({ length: 30 }, (_, at): [boolean, boolean] =>
      at < 10 ? [true, true] : at < 20 ? [true, false] : [false, true]
    );
    const score = scoreRating({ sealed, answers: answers(mixed) });
    expect(score.total).toMatchObject({
      topics: 30,
      rated: 30,
      coherentYes: 20,
      namedYes: 20,
      both: 10
    });
    expect(score.passes).toBe(false);
  });

  it("splits the counts by dataset and by stratum", () => {
    // ENV-C all yes/yes (20), ENV-G 3 yes/yes, ENV-F none.
    const given = Array.from({ length: 30 }, (_, at) =>
      at < 20 || (at >= 20 && at < 23) ? yes : ([false, true] as const)
    );
    const score = scoreRating({ sealed, answers: answers(given) });
    expect(score.byProfile["env-c"]).toMatchObject({ topics: 20, both: 20, coherentYes: 20 });
    expect(score.byProfile["env-g"]).toMatchObject({
      topics: 5,
      both: 3,
      coherentYes: 3,
      namedYes: 5
    });
    expect(score.byProfile["env-f"]).toMatchObject({
      topics: 5,
      both: 0,
      coherentYes: 0,
      namedYes: 5
    });
    expect(score.total.both).toBe(23);
    expect(
      score.byStratum.map((entry) => `${entry.profile}/${entry.stratum}:${entry.tally.topics}`)
    ).toEqual([
      "env-c/area:6",
      "env-c/level-2:6",
      "env-c/level-3-plus:8",
      "env-g/leaf:5",
      "env-f/leaf:5"
    ]);
    expect(ratingProfiles.reduce((sum, profile) => sum + score.byProfile[profile].topics, 0)).toBe(
      30
    );
  });

  it("is incomplete, with no verdict, while a topic lacks an answer", () => {
    const given = rows(29, [null, null]);
    given[29] = [true, null];
    const score = scoreRating({ sealed, answers: answers(given) });
    expect(score.complete).toBe(false);
    expect(score.passes).toBeNull();
    expect(score.total.rated).toBe(29);
    expect(score.total.coherentAnswered).toBe(30);
    expect(score.total.namedAnswered).toBe(29);
    expect(renderScoreText(score)).toContain("INCOMPLETE: 1 of 30");
  });

  it("treats a missing answer as unrated", () => {
    const score = scoreRating({ sealed, answers: { key: "k", answers: {} } });
    expect(score.total).toMatchObject({ topics: 30, rated: 0, both: 0 });
    expect(score.passes).toBeNull();
  });

  it("lists the topics that did not count, with the owner's notes", () => {
    const given = rows(25, [false, true]);
    const score = scoreRating({
      sealed,
      answers: answers(given, { t27: "nome em inglês | confuso" })
    });
    expect(score.notCounted.map((entry) => entry.position)).toEqual([26, 27, 28, 29, 30]);
    expect(score.notCounted[1]?.notes).toBe("nome em inglês | confuso");
  });

  it("prints the marginals, both-yes and the verdict in plain text", () => {
    const text = renderScoreText(
      scoreRating({ sealed, answers: answers(rows(24, [true, false])) })
    );
    expect(text).toContain("Topics rated both coherent and well named: 24/30 (bar >= 24/30, D20)");
    expect(text).toContain("Coherent (marginal): 30/30");
    expect(text).toContain("Well named (marginal): 24/30");
    expect(text).toContain("ENV-C: coherent 20/20, well named 20/20, both 20/20");
    expect(text).toContain("E4 PASSES.");
    expect(
      renderScoreText(scoreRating({ sealed, answers: answers(rows(23, [true, false])) }))
    ).toContain("E4 DOES NOT PASS.");
  });

  it("writes a markdown result with the verdict, the tables and the trees' config hashes", () => {
    const manifest: ManifestFile = ManifestFileSchema.parse({
      version: 1,
      run: "seed-20261016",
      seed: 20261016,
      createdAt: "2026-10-16T12:00:00.000Z",
      sampleSize: 30,
      membersPerTopic: 8,
      passBar: 24,
      profiles: ratingProfiles.map((profile) => ({
        profile,
        label: profile.toUpperCase(),
        treeId: `tree-${profile}`,
        configHash: `hash-${profile}`,
        generation: 3,
        areasApplied: profile === "env-c",
        counts: { liveTopics: 1, named: 1, provisional: 0, unnamed: 0, byStratum: [] }
      })),
      files: {
        sample: { file: "sample.json", sha256: "a" },
        sealed: { file: "sealed.json", sha256: "b" }
      }
    });
    const markdown = renderScoreMarkdown({
      score: scoreRating({ sealed, answers: answers(rows(24, [true, false])) }),
      manifest,
      sealed,
      answersSavedAt: "2026-10-16T13:00:00.000Z"
    });
    expect(markdown).toContain("# E4 owner blind rating: PASS");
    expect(markdown).toContain("**Both yes: 24/30**");
    expect(markdown).toContain("| ENV-C | 20/20 | 20/20 | 20/20 | 20/20 |");
    expect(markdown).toContain("| **Total** | 30/30 | 24/30 | 24/30 | 30/30 |");
    expect(markdown).toContain("`hash-env-g`");
    expect(markdown).toContain("## Topics that did not count");
  });

  it("reads the answers file the eval server writes", () => {
    expect(
      AnswersFileSchema.parse({
        key: "memora.topicRating.abc",
        value: "{}",
        answers: { t01: { coerente: true, bemNomeado: null, notas: "" } },
        savedAt: "2026-10-16T13:00:00.000Z"
      }).answers.t01
    ).toEqual({ coerente: true, bemNomeado: null, notas: "" });
    expect(
      AnswersFileSchema.safeParse({ key: "k", answers: { t01: { coerente: "yes" } } }).success
    ).toBe(false);
  });
});
