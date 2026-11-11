import { describe, expect, it } from "vitest";

import {
  TopicReleasePlan,
  TopicReleaseSettingsSchema,
  defaultTopicReleaseNotes,
  releaseMismatch,
  topicReleasePriority,
  topicReleaseSettings
} from "./topic-release.js";
import type { DivisionBoundary } from "./topic-release.js";

const first = (notes: number, t1Seen = false): DivisionBoundary => ({
  source: "first",
  notes,
  t1Seen
});
const second = (notes: number, t1Seen = false): DivisionBoundary => ({
  source: "second",
  notes,
  t1Seen
});

/** The divisions a plan releases at, for a run of boundaries. */
function releasedAt(plan: TopicReleasePlan, boundaries: DivisionBoundary[]): string[] {
  return boundaries.flatMap((boundary) => {
    const decision = plan.boundary(boundary);
    return decision.release ? [`${boundary.source}:${decision.division}`] : [];
  });
}

describe("the a2 topic release", () => {
  it("defaults to the topic bootstrap's minimum of 12 notes, released once, above every heavy priority", () => {
    expect(topicReleaseSettings()).toEqual({
      policy: "a2",
      firstSourceNotes: defaultTopicReleaseNotes,
      repeatUntilT1: false
    });
    expect(defaultTopicReleaseNotes).toBe(12);
    // Imports are queued at 0 and note embeddings at 10: the release must come before both.
    expect(topicReleasePriority).toBeGreaterThan(10);
  });

  it("releases at the first division boundary where the first source has the threshold's notes, and only there", () => {
    const plan = new TopicReleasePlan(topicReleaseSettings());
    expect(
      releasedAt(plan, [first(3), first(7), first(11), first(13), first(18), first(25)])
    ).toEqual(["first:4"]);
    expect(plan.divisionsOf("first")).toBe(6);
  });

  it("counts a boundary at exactly the threshold", () => {
    const plan = new TopicReleasePlan(topicReleaseSettings({ firstSourceNotes: 5 }));
    expect(releasedAt(plan, [first(4), first(5), first(9)])).toEqual(["first:2"]);
  });

  it("never starts a2 on the second source, and a source release makes later boundaries repeats", () => {
    const plan = new TopicReleasePlan(topicReleaseSettings());
    // The first source never reached 12 notes: no division release; its source release follows.
    expect(releasedAt(plan, [first(4), first(9)])).toEqual([]);
    plan.sourceReleased();
    expect(releasedAt(plan, [second(20), second(30)])).toEqual([]);
    expect(plan.divisionsOf("second")).toBe(2);

    const repeating = new TopicReleasePlan(topicReleaseSettings({ repeatUntilT1: true }));
    expect(releasedAt(repeating, [first(4), first(9), second(30)])).toEqual([]);
    repeating.sourceReleased();
    expect(releasedAt(repeating, [second(31), second(32, true)])).toEqual(["second:2"]);
  });

  it("with the hardening, releases again at every later boundary until T1 is seen, then stops", () => {
    const plan = new TopicReleasePlan(topicReleaseSettings({ repeatUntilT1: true }));
    expect(
      releasedAt(plan, [
        first(6),
        first(12),
        first(15),
        first(19),
        first(22, true),
        first(27),
        second(5)
      ])
    ).toEqual(["first:2", "first:3", "first:4"]);
  });

  it("does not release when T1 already stands", () => {
    const plan = new TopicReleasePlan(topicReleaseSettings({ repeatUntilT1: true }));
    expect(releasedAt(plan, [first(30, true), first(31, true)])).toEqual([]);
  });

  it("decides from what each boundary read alone: the same boundaries give the same releases", () => {
    const boundaries = [first(2), first(8), first(14), first(20), second(4), second(9)];
    const settings = topicReleaseSettings({ repeatUntilT1: true });
    expect(releasedAt(new TopicReleasePlan(settings), boundaries)).toEqual(
      releasedAt(new TopicReleasePlan(settings), boundaries)
    );
  });

  it("validates its settings: a positive whole threshold, the a2 policy, no extra member", () => {
    expect(TopicReleaseSettingsSchema.safeParse(topicReleaseSettings()).success).toBe(true);
    for (const settings of [
      { ...topicReleaseSettings(), firstSourceNotes: 0 },
      { ...topicReleaseSettings(), firstSourceNotes: 1.5 },
      { ...topicReleaseSettings(), policy: "both-imports" },
      { ...topicReleaseSettings(), extra: true }
    ])
      expect(TopicReleaseSettingsSchema.safeParse(settings).success).toBe(false);
  });
});

describe("a replay against the record's release policy", () => {
  const settings = topicReleaseSettings();

  it("accepts the same policy, threshold, repeat and the drain link runtime", () => {
    expect(releaseMismatch({ topicRelease: settings, linkRuntime: "drain" }, settings)).toBeNull();
  });

  it("refuses a record from before a2, which names neither", () => {
    expect(releaseMismatch({}, settings)).toMatch(/before the a2 topic release.*record again/su);
    expect(releaseMismatch({ topicRelease: settings }, settings)).toMatch(/record again/u);
  });

  it("names the flag that matches the record", () => {
    expect(
      releaseMismatch(
        { topicRelease: topicReleaseSettings({ firstSourceNotes: 20 }), linkRuntime: "drain" },
        settings
      )
    ).toMatch(/--topic-release-notes 20/u);
    expect(
      releaseMismatch(
        { topicRelease: topicReleaseSettings({ repeatUntilT1: true }), linkRuntime: "drain" },
        settings
      )
    ).toMatch(/replay it with --topic-release-repeat/u);
  });
});
