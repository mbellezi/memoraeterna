import { describe, expect, it } from "vitest";

import {
  RatingSampleError,
  assembleRating,
  drawProfileTopics,
  indexTopics,
  ratingConfig,
  ratingProfiles
} from "./rating-core.js";
import type { ProfileDraw, RatingProfile } from "./rating-core.js";
import { buildFixture } from "./rating-fixture.js";

const seed = 20261016;
const bases: Record<RatingProfile, number> = { "env-c": 0, "env-g": 1_000_000, "env-f": 2_000_000 };

function fixtures() {
  return Object.fromEntries(
    ratingProfiles.map((profile) => [
      profile,
      buildFixture({ profile, base: bases[profile], configHash: `hash-of-${profile}` })
    ])
  ) as Record<RatingProfile, ReturnType<typeof buildFixture>>;
}

function drawAll(sampleSeed: number): { draws: ProfileDraw[]; made: ReturnType<typeof fixtures> } {
  const made = fixtures();
  return {
    made,
    draws: ratingProfiles.map((profile) => drawProfileTopics(made[profile].snapshot, sampleSeed))
  };
}

describe("the E4 sampling rules", () => {
  it("asks for 30 topics: 6 Areas, 6 level-2 and 8 deeper from ENV-C, 5 leaves from ENV-G and ENV-F", () => {
    const counts = new Map<string, number>();
    for (const rule of ratingConfig.strata) {
      counts.set(rule.profile, (counts.get(rule.profile) ?? 0) + rule.count);
    }
    expect(Object.fromEntries(counts)).toEqual({ "env-c": 20, "env-g": 5, "env-f": 5 });
    expect(ratingConfig.sampleSize).toBe(30);
    expect(ratingConfig.membersPerTopic).toBe(8);
    expect(ratingConfig.passBar).toBe(24);
  });
});

describe("indexing a profile's tree", () => {
  it("keeps the live part reachable from the root, with depths and subtree note counts", () => {
    const { snapshot, ineligible } = buildFixture({ profile: "env-c" });
    const index = indexTopics(snapshot);
    const root = [...index.values()].find((entry) => entry.depth === 0);
    expect(root?.topic.role).toBe("root");
    expect(index.has(ineligible.retired)).toBe(false);
    expect(index.has(ineligible.orphan)).toBe(false);
    // 24 level-4 leaves of 12 notes + 24 level-3 notes + 3 notes under each of the unnamed and provisional topics.
    expect(root?.notes).toBe(24 * 12 + 24 + 3 + 3);
    const depths = new Set([...index.values()].map((entry) => entry.depth));
    expect([...depths].sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it("needs exactly one live root", () => {
    const { snapshot } = buildFixture({ profile: "env-c" });
    expect(() => indexTopics({ ...snapshot, topics: snapshot.topics.slice(1) })).toThrow(
      RatingSampleError
    );
  });
});

describe("drawing a profile", () => {
  it("is deterministic for a seed and changes with another", () => {
    const first = drawAll(seed);
    const again = drawAll(seed);
    expect(again.draws).toEqual(first.draws);
    const other = drawAll(seed + 1);
    const ids = (draws: ProfileDraw[]): string[] =>
      draws.flatMap((draw) => draw.topics.map((topic) => topic.topicId));
    expect(ids(other.draws)).not.toEqual(ids(first.draws));
  });

  it("picks the right levels and counts from ENV-C", () => {
    const { draws } = drawAll(seed);
    const envC = draws.find((draw) => draw.profile === "env-c") as ProfileDraw;
    expect(envC.topics).toHaveLength(20);
    const byStratum = (stratum: string) => envC.topics.filter((topic) => topic.stratum === stratum);
    expect(byStratum("area").map((topic) => topic.level)).toEqual([1, 1, 1, 1, 1, 1]);
    expect(byStratum("level-2").map((topic) => topic.level)).toEqual([2, 2, 2, 2, 2, 2]);
    const deep = byStratum("level-3-plus");
    expect(deep).toHaveLength(8);
    expect(deep.every((topic) => topic.level >= 3)).toBe(true);
    expect(new Set(envC.topics.map((topic) => topic.topicId)).size).toBe(20);
    // Levels 3 and deeper hold both internal topics and leaves; the stratum does not ask for leaves.
    expect(deep.some((topic) => !topic.leaf)).toBe(true);
  });

  it("picks 5 leaves from each of ENV-G and ENV-F", () => {
    const { draws } = drawAll(seed);
    for (const profile of ["env-g", "env-f"] as const) {
      const draw = draws.find((candidate) => candidate.profile === profile) as ProfileDraw;
      expect(draw.topics).toHaveLength(5);
      expect(draw.topics.every((topic) => topic.leaf && topic.stratum === "leaf")).toBe(true);
    }
  });

  it("never picks the root, an unnamed, provisional, retired or empty topic, or one below a retired parent", () => {
    for (const sampleSeed of [1, 2, 3, seed, 99]) {
      const { draws, made } = drawAll(sampleSeed);
      for (const draw of draws) {
        const { snapshot, ineligible } = made[draw.profile];
        const rootId = snapshot.topics.find((topic) => topic.role === "root")?.id;
        const banned = new Set([rootId, ...Object.values(ineligible)]);
        for (const topic of draw.topics) {
          expect(banned.has(topic.topicId)).toBe(false);
          expect(topic.title.length).toBeGreaterThan(0);
          expect(topic.nameState).toBe("named");
        }
      }
    }
  });

  it("reports what each tree holds, including the topics it left out", () => {
    const { draws } = drawAll(seed);
    const envC = draws.find((draw) => draw.profile === "env-c") as ProfileDraw;
    expect(envC.counts).toMatchObject({ provisional: 1, unnamed: 1 });
    expect(envC.counts.byStratum).toEqual([
      { stratum: "area", eligible: 6, picked: 6 },
      { stratum: "level-2", eligible: 12, picked: 6 },
      { stratum: "level-3-plus", eligible: 48, picked: 8 }
    ]);
  });

  it("draws members from the subtree's primary placements only, at most 8, from live topics", () => {
    const { draws, made } = drawAll(seed);
    for (const draw of draws) {
      const { snapshot, hiddenNote } = made[draw.profile];
      const index = indexTopics(snapshot);
      const parentOf = new Map(snapshot.topics.map((topic) => [topic.id, topic.parentId]));
      const topicOfNote = new Map(snapshot.placements.map((p) => [p.noteId, p.topicId]));
      for (const topic of draw.topics) {
        expect(topic.memberIds.length).toBeGreaterThan(0);
        expect(topic.memberIds.length).toBeLessThanOrEqual(8);
        expect(new Set(topic.memberIds).size).toBe(topic.memberIds.length);
        for (const noteId of topic.memberIds) {
          expect(noteId).not.toBe(hiddenNote);
          let at: string | null | undefined = topicOfNote.get(noteId);
          while (at && at !== topic.topicId) at = parentOf.get(at);
          expect(at).toBe(topic.topicId);
          expect(index.has(topicOfNote.get(noteId) as string)).toBe(true);
        }
      }
    }
  });

  it("shows every note when the topic has fewer than 8", () => {
    const fixture = buildFixture({ profile: "env-g", base: 5_000_000 });
    const sparse = {
      ...fixture.snapshot,
      placements: fixture.snapshot.placements.filter((_, at) => at % 5 === 0)
    };
    const draw = drawProfileTopics(sparse, seed, {
      ...ratingConfig,
      strata: [
        { profile: "env-g", stratum: "leaf", count: 1, minLevel: 1, maxLevel: null, leafOnly: true }
      ]
    });
    const only = draw.topics[0];
    expect(only?.subtreeNotes).toBeGreaterThan(0);
    expect(only?.subtreeNotes).toBeLessThan(8);
    expect(only?.memberIds).toHaveLength(only?.subtreeNotes ?? -1);
  });

  it("fails clearly when a stratum has too few eligible topics", () => {
    const fixture = buildFixture({ profile: "env-c", areas: 3 });
    expect(() => drawProfileTopics(fixture.snapshot, seed)).toThrow(
      /ENV-C has 3 eligible area topics .* and 6 are needed/u
    );
  });
});

describe("assembling the run", () => {
  function assemble(sampleSeed: number) {
    const { draws, made } = drawAll(sampleSeed);
    return assembleRating({
      seed: sampleSeed,
      draws,
      details: {
        "env-c": made["env-c"].details,
        "env-g": made["env-g"].details,
        "env-f": made["env-f"].details
      }
    });
  }

  it("shuffles the 30 topics together and splits the page's data from the sealed map", () => {
    const { sample, sealed } = assemble(seed);
    expect(sample.topics).toHaveLength(30);
    expect(sample.topics.map((topic) => topic.key)).toEqual(
      Array.from({ length: 30 }, (_, at) => `t${String(at + 1).padStart(2, "0")}`)
    );
    expect(sealed.entries.map((entry) => entry.key)).toEqual(sample.topics.map((t) => t.key));
    const profiles = sealed.entries.map((entry) => entry.profile);
    expect(profiles.filter((profile) => profile === "env-c")).toHaveLength(20);
    expect(profiles.filter((profile) => profile === "env-g")).toHaveLength(5);
    expect(profiles.filter((profile) => profile === "env-f")).toHaveLength(5);
    // Shuffled together: the profiles are not in blocks.
    expect(profiles.slice(0, 20)).not.toEqual(profiles.filter((profile) => profile === "env-c"));
    expect(new Set(sealed.entries.map((entry) => entry.topicId)).size).toBe(30);
  });

  it("is deterministic for a seed, in order and in members", () => {
    expect(assemble(seed)).toEqual(assemble(seed));
    expect(assemble(seed + 1).sealed.entries.map((e) => e.topicId)).not.toEqual(
      assemble(seed).sealed.entries.map((e) => e.topicId)
    );
  });

  it("records each profile's tree, config_hash and counts", () => {
    const { profiles } = assemble(seed);
    expect(profiles.map((profile) => [profile.profile, profile.label, profile.configHash])).toEqual(
      [
        ["env-c", "ENV-C", "hash-of-env-c"],
        ["env-g", "ENV-G", "hash-of-env-g"],
        ["env-f", "ENV-F", "hash-of-env-f"]
      ]
    );
    expect(profiles.every((profile) => profile.generation === 7 && profile.areasApplied)).toBe(
      true
    );
    const sealed = assemble(seed).sealed;
    expect(
      new Set(sealed.entries.filter((e) => e.profile === "env-g").map((e) => e.configHash))
    ).toEqual(new Set(["hash-of-env-g"]));
  });

  it("puts only the name, description, aliases and members on the page's side", () => {
    const { sample } = assemble(seed);
    for (const topic of sample.topics) {
      expect(Object.keys(topic).sort()).toEqual([
        "aliases",
        "description",
        "key",
        "members",
        "name"
      ]);
      expect(topic.members.length).toBeGreaterThan(0);
      for (const member of topic.members) {
        expect(Object.keys(member).sort()).toEqual(["idea", "source", "title"]);
      }
    }
    expect(sample.topics.some((topic) => topic.aliases.length > 0)).toBe(true);
  });

  it("skips a member that is no longer readable and fails when none is left", () => {
    const { draws, made } = drawAll(seed);
    const details = {
      "env-c": new Map(made["env-c"].details),
      "env-g": made["env-g"].details,
      "env-f": made["env-f"].details
    };
    const drawn = draws[0]?.topics[0];
    const gone = drawn?.memberIds[0] as string;
    details["env-c"].delete(gone);
    const parts = assembleRating({ seed, draws, details });
    const entry = parts.sealed.entries.find((candidate) => candidate.topicId === drawn?.topicId);
    expect(entry?.memberNoteIds).toHaveLength((drawn?.memberIds.length ?? 0) - 1);
    expect(entry?.memberNoteIds).not.toContain(gone);
    expect(() =>
      assembleRating({
        seed,
        draws,
        details: { "env-c": new Map(), "env-g": details["env-g"], "env-f": details["env-f"] }
      })
    ).toThrow(/no readable notes/u);
  });

  it("needs the three profiles and a full sample", () => {
    const { draws, made } = drawAll(seed);
    const details = {
      "env-c": made["env-c"].details,
      "env-g": made["env-g"].details,
      "env-f": made["env-f"].details
    };
    expect(() => assembleRating({ seed, draws: draws.slice(0, 2), details })).toThrow(
      RatingSampleError
    );
    const short = draws.map((draw) => ({ ...draw, topics: draw.topics.slice(1) }));
    expect(() => assembleRating({ seed, draws: short, details })).toThrow(/needed/u);
  });

  it("tidies member text: one line, bounded", () => {
    const { draws, made } = drawAll(seed);
    const noteId = draws[0]?.topics[0]?.memberIds[0] as string;
    const details = {
      "env-c": new Map(made["env-c"].details),
      "env-g": made["env-g"].details,
      "env-f": made["env-f"].details
    };
    details["env-c"].set(noteId, {
      title: "  Two\n\nlines  ",
      idea: `${"palavra ".repeat(200)}fim`,
      sourceTitle: ""
    });
    const { sample, sealed } = assembleRating({ seed, draws, details });
    const at = sealed.entries.findIndex((entry) => entry.memberNoteIds.includes(noteId));
    const member =
      sample.topics[at]?.members[sealed.entries[at]?.memberNoteIds.indexOf(noteId) ?? 0];
    expect(member?.title).toBe("Two lines");
    expect(member?.idea.length).toBeLessThanOrEqual(ratingConfig.ideaLimit);
    expect(member?.idea.endsWith("…")).toBe(true);
    expect(member?.source).toBe("");
  });
});
