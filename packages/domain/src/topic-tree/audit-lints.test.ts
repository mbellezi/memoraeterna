import { describe, expect, it } from "vitest";

import { auditLintConfigWith, defaultAuditLintConfig } from "../gardener/lints/config.js";
import {
  compressRedirects,
  planRedirectCompression,
  replacementCandidates,
  rollingWindow,
  themeDrift
} from "./audit-lints.js";
import {
  StructureEventConflictError,
  StructureEventSchema,
  applyEvents,
  createTopicTreeEditor,
  invertEvent,
  invertEvents,
  isRedirectEvent
} from "./events.js";
import type { StructureEvent } from "./events.js";
import { createWorld, uuidOf, worldConfig } from "./fixtures/placement-world.js";
import type { World } from "./fixtures/placement-world.js";
import { setTopicLabel } from "./label.js";
import {
  canonicalStateDump,
  createTopicTreeState,
  getTopic,
  isLive,
  placementsOf
} from "./state.js";
import { changeSetBlockers } from "./undo.js";
import { unit } from "./vectors.js";

const config = defaultAuditLintConfig;
const at = "2026-10-20T12:00:00.000Z";

/** Live leaves of the world, in ID order. */
function leavesOf(world: World): string[] {
  return [...world.state.topics.values()]
    .filter((node) => isLive(node) && node.children.length === 0 && node.parentId !== null)
    .map((node) => node.id)
    .sort();
}

/** Names a topic as an LLM would, with a label vector of the given direction. */
function nameWithLabel(
  world: World,
  topicId: string,
  vector: Float32Array | null,
  fields: { nameSource?: "llm" | "human" | "tfidf"; nameState?: "named" | "provisional" } = {}
): void {
  createTopicTreeEditor(world.state, { record: false }).renameTopic(topicId, {
    title: `Name ${topicId.slice(-4)}`,
    nameState: fields.nameState ?? "named",
    nameSource: fields.nameSource ?? "llm",
    nameLanguage: "en"
  });
  if (vector) setTopicLabel(world.state, topicId, { vector: unit(vector), textHash: "h" });
}

const along = (world: World, topicId: string): Float32Array =>
  Float32Array.from(getTopic(world.state, topicId).stats.centroid);
/** A unit vector orthogonal to `vector`: a basis vector less its projection. */
function orthogonalTo(vector: Float32Array): Float32Array {
  let weakest = 0;
  vector.forEach((value, index) => {
    if (Math.abs(value) < Math.abs(vector[weakest] as number)) weakest = index;
  });
  const projection = vector[weakest] as number;
  return unit(
    Float32Array.from(vector, (value, index) => (index === weakest ? 1 : 0) - projection * value)
  );
}
const against = (world: World, topicId: string): Float32Array =>
  Float32Array.from(getTopic(world.state, topicId).stats.centroid, (value) => -value);

describe("theme drift", () => {
  it("lists the LLM-named topics whose label is far from their centroid, worst first", () => {
    const world = createWorld({ seed: 11 });
    const [a, b, c, d] = leavesOf(world);
    nameWithLabel(world, a as string, along(world, a as string));
    nameWithLabel(world, b as string, against(world, b as string));
    // Orthogonal to the centroid: cosine 0.
    nameWithLabel(world, c as string, orthogonalTo(along(world, c as string)));
    nameWithLabel(world, d as string, null);
    const report = themeDrift(world.state, auditLintConfigWith({ themeDrift: { minItems: 1 } }));
    expect(report.measured).toBe(3);
    expect(report.drifted.map((entry) => entry.topicId)).toEqual([b, c]);
    expect(report.drifted[0]?.cosine).toBeCloseTo(-1, 3);
    expect(report.drifted[1]?.cosine).toBeCloseTo(0, 1);
    expect(report.deferred).toBe(0);
    expect(report.percentiles?.p95).toBeCloseTo(1, 3);
    expect(report.percentiles?.p05).toBeCloseTo(-1, 3);
  });

  it("never measures a human, pinned, provisional or unlabelled name, nor a small topic", () => {
    const world = createWorld({ seed: 12 });
    const [human, pinned, provisional, small, plain] = leavesOf(world);
    nameWithLabel(world, human as string, against(world, human as string), { nameSource: "human" });
    nameWithLabel(world, pinned as string, against(world, pinned as string));
    createTopicTreeEditor(world.state, { record: false }).manageTopic(pinned as string, "pinned");
    nameWithLabel(world, provisional as string, against(world, provisional as string), {
      nameSource: "tfidf",
      nameState: "provisional"
    });
    nameWithLabel(world, small as string, against(world, small as string));
    nameWithLabel(world, plain as string, null);
    // Only the plain LLM-named, labelled topic is measured.
    const measured = themeDrift(world.state, auditLintConfigWith({ themeDrift: { minItems: 1 } }));
    expect(measured.measured).toBe(1);
    expect(measured.drifted.map((entry) => entry.topicId)).toEqual([small]);
    // A topic with fewer items than the size bar is left alone.
    const bar = getTopic(world.state, small as string).stats.n + 1;
    const strict = themeDrift(world.state, auditLintConfigWith({ themeDrift: { minItems: bar } }));
    expect(strict.measured).toBe(0);
    expect(strict.drifted).toEqual([]);
    expect(strict.percentiles).toBeNull();
  });

  it("caps the topics one audit asks for and counts the rest", () => {
    const world = createWorld({ seed: 13 });
    const leaves = leavesOf(world).slice(0, 4);
    for (const leaf of leaves) nameWithLabel(world, leaf, against(world, leaf));
    const report = themeDrift(
      world.state,
      auditLintConfigWith({ themeDrift: { minItems: 1, perRun: 3 } })
    );
    expect(report.drifted).toHaveLength(3);
    expect(report.deferred).toBe(1);
    for (const entry of report.drifted) expect(leaves).toContain(entry.topicId);
    const cosines = report.drifted.map((entry) => entry.cosine);
    expect([...cosines].sort((x, y) => x - y)).toEqual(cosines);
  });
});

describe("the rolling window", () => {
  it("is empty without items, a share or a budget", () => {
    expect(rollingWindow(0, 5, 0.01, 10)).toEqual({ start: 0, count: 0 });
    expect(rollingWindow(100, 5, 0, 10)).toEqual({ start: 0, count: 0 });
    expect(rollingWindow(100, 5, 0.01, 0)).toEqual({ start: 0, count: 0 });
  });

  it("takes the share of the items, at least one, at most the budget", () => {
    expect(rollingWindow(1000, 0, 0.01, 200).count).toBe(10);
    expect(rollingWindow(30, 0, 0.01, 200).count).toBe(1);
    expect(rollingWindow(100_000, 0, 0.01, 200).count).toBe(200);
    expect(rollingWindow(3, 0, 1, 200).count).toBe(3);
  });

  it("rolls over the whole library in total / count days", () => {
    const total = 50;
    const seen = new Set<number>();
    for (let day = 0; day < 5; day += 1) {
      const { start, count } = rollingWindow(total, 20_000 + day, 0.2, 200);
      expect(count).toBe(10);
      for (let offset = 0; offset < count; offset += 1) seen.add((start + offset) % total);
    }
    expect(seen.size).toBe(total);
  });
});

describe("rolling re-placement", () => {
  const everything = auditLintConfigWith({
    replacement: { share: 1, perRun: 10_000, candidates: 10_000, minGain: 0.1 }
  });

  /** Moves a note to a leaf away from the one PLACE would choose, as a stale placement would be. */
  function misplace(world: World): { note: string; from: string; to: string } {
    const editor = createTopicTreeEditor(world.state, { record: false });
    for (const note of world.notes) {
      const placement = placementsOf(world.state, note).find((entry) => entry.rank === 0);
      if (!placement) continue;
      const from = placement.topicId;
      const other = leavesOf(world).find(
        (leaf) =>
          leaf !== from &&
          getTopic(world.state, leaf).parentId !== getTopic(world.state, from).parentId
      );
      if (!other) continue;
      editor.updatePlacement(note, 0, { topicId: other });
      return { note, from, to: other };
    }
    throw new Error("no note to misplace");
  }

  it("finds a note that sits in a leaf another leaf now beats, and gives it back to PLACE", () => {
    const world = createWorld({ seed: 21, placedShare: 1 });
    const none = replacementCandidates(world.state, world.vectors, worldConfig, everything, 0);
    const moved = misplace(world);
    const report = replacementCandidates(world.state, world.vectors, worldConfig, everything, 0);
    expect(report.eligible).toBeGreaterThan(10);
    expect(report.sampled).toBe(report.eligible);
    const candidate = report.candidates.find((entry) => entry.item === moved.note);
    expect(candidate).toBeDefined();
    expect(candidate?.from).toBe(moved.to);
    expect(candidate?.gain).toBeGreaterThanOrEqual(0.1);
    expect(none.candidates.find((entry) => entry.item === moved.note)).toBeUndefined();
    // Worst first, and nothing was moved by the lint itself.
    const gains = report.candidates.map((entry) => entry.gain);
    expect([...gains].sort((a, b) => b - a)).toEqual(gains);
    expect(placementsOf(world.state, moved.note)[0]?.topicId).toBe(moved.to);
  });

  it("leaves human placements, unsettled items and big gains below the bar alone", () => {
    const world = createWorld({ seed: 22, placedShare: 1 });
    const { note } = misplace(world);
    const editor = createTopicTreeEditor(world.state, { record: false });
    editor.updatePlacement(note, 0, { management: "human" });
    expect(
      replacementCandidates(world.state, world.vectors, worldConfig, everything, 0).candidates.find(
        (entry) => entry.item === note
      )
    ).toBeUndefined();
    editor.updatePlacement(note, 0, { management: "ai", needsGate: true });
    expect(
      replacementCandidates(world.state, world.vectors, worldConfig, everything, 0).candidates.find(
        (entry) => entry.item === note
      )
    ).toBeUndefined();
    editor.updatePlacement(note, 0, { needsGate: false });
    const strict = auditLintConfigWith({ replacement: { ...everything.replacement, minGain: 2 } });
    expect(
      replacementCandidates(world.state, world.vectors, worldConfig, strict, 0).candidates
    ).toEqual([]);
  });

  it("decides each note once in total / sample days, deterministically", () => {
    const world = createWorld({ seed: 23, placedShare: 1 });
    const { note } = misplace(world);
    const daily = auditLintConfigWith({
      replacement: { share: 0.2, perRun: 10_000, candidates: 10_000, minGain: 0.1 }
    });
    const first = replacementCandidates(world.state, world.vectors, worldConfig, daily, 7);
    const again = replacementCandidates(world.state, world.vectors, worldConfig, daily, 7);
    expect(again).toEqual(first);
    expect(first.sampled).toBe(Math.ceil(first.eligible * 0.2));
    let found = false;
    for (let day = 0; day < 5; day += 1) {
      const report = replacementCandidates(
        world.state,
        world.vectors,
        worldConfig,
        daily,
        100 + day
      );
      if (report.candidates.some((entry) => entry.item === note)) found = true;
    }
    expect(found).toBe(true);
    const capped = replacementCandidates(
      world.state,
      world.vectors,
      worldConfig,
      auditLintConfigWith({ replacement: { ...everything.replacement, candidates: 0 } }),
      0
    );
    expect(capped.candidates).toEqual([]);
    expect(capped.deferred).toBeGreaterThan(0);
  });
});

describe("redirect compression", () => {
  const rootId = uuidOf(0);
  const [a, b, c, d, e] = [1, 2, 3, 4, 5].map(uuidOf) as [string, string, string, string, string];

  /** a -> b -> c -> d (live), and e retired straight to d. */
  function chained() {
    const state = createTopicTreeState({ dim: 4, rootId });
    const editor = createTopicTreeEditor(state, { record: false });
    for (const id of [a, b, c, d, e]) editor.createTopic(id, rootId);
    editor.retireTopic(c, d, at);
    editor.retireTopic(b, c, at);
    editor.retireTopic(a, b, at);
    editor.retireTopic(e, d, at);
    return state;
  }

  it("plans a re-point for each retired topic that passes through another retired one", () => {
    const plan = planRedirectCompression(chained(), config);
    expect(plan.chains).toEqual([
      { topicId: a, from: b, to: d, hops: 3 },
      { topicId: b, from: c, to: d, hops: 2 }
    ]);
    expect(plan.report.direct).toBe(2);
    expect(plan.deferred).toBe(0);
    const capped = planRedirectCompression(
      chained(),
      auditLintConfigWith({ links: { compressPerRun: 1 } })
    );
    expect(capped.chains).toHaveLength(1);
    expect(capped.deferred).toBe(1);
  });

  it("compresses through the engine's events, and undoes them exactly", () => {
    const state = chained();
    const before = canonicalStateDump(state);
    const events = compressRedirects(state, planRedirectCompression(state, config).chains);
    expect(events).toHaveLength(2);
    for (const event of events) {
      expect(StructureEventSchema.parse(event)).toEqual(event);
      expect(isRedirectEvent(event)).toBe(true);
      expect(event.op).toBe("topic.retire");
    }
    expect(getTopic(state, a).redirectTo).toBe(d);
    expect(getTopic(state, b).redirectTo).toBe(d);
    expect(getTopic(state, a).retiredAt).toBe(at);
    expect(planRedirectCompression(state, config).chains).toEqual([]);
    applyEvents(state, invertEvents(events));
    expect(canonicalStateDump(state)).toBe(before);
    // Replaying the same events on the original state gives the compressed one again.
    applyEvents(state, events);
    expect(getTopic(state, a).redirectTo).toBe(d);
  });

  it("is its own inverse, and an ordinary retirement is not a re-point", () => {
    const state = chained();
    const [event] = compressRedirects(state, [{ topicId: a, from: b, to: d, hops: 3 }]) as [
      StructureEvent
    ];
    expect(invertEvent(event)).toMatchObject({
      op: "topic.retire",
      topicId: a,
      before: { retiredAt: at, redirectTo: d },
      after: { retiredAt: at, redirectTo: b }
    });
    const live = createTopicTreeState({ dim: 4, rootId });
    const editor = createTopicTreeEditor(live);
    editor.createTopic(a, rootId);
    editor.retireTopic(a, rootId, at);
    const retire = editor.events.at(-1) as StructureEvent;
    expect(isRedirectEvent(retire)).toBe(false);
    expect(invertEvent(retire).op).toBe("topic.restore");
  });

  it("refuses a re-point that is stale, self-referential, to nothing or from a live topic", () => {
    const state = chained();
    const repoint = (
      topicId: string,
      before: { retiredAt: string | null; redirectTo: string | null },
      after: { retiredAt: string | null; redirectTo: string | null }
    ): StructureEvent => ({ op: "topic.retire", topicId, before, after });
    // The before values must hold.
    expect(() =>
      applyEvents(state, [
        repoint(a, { retiredAt: at, redirectTo: c }, { retiredAt: at, redirectTo: d })
      ])
    ).toThrow(StructureEventConflictError);
    // Not to itself, not to an unknown topic, not from or to a missing redirect.
    expect(() =>
      applyEvents(state, [
        repoint(a, { retiredAt: at, redirectTo: b }, { retiredAt: at, redirectTo: a })
      ])
    ).toThrow(StructureEventConflictError);
    expect(() =>
      applyEvents(state, [
        repoint(a, { retiredAt: at, redirectTo: b }, { retiredAt: at, redirectTo: uuidOf(99) })
      ])
    ).toThrow(StructureEventConflictError);
    expect(() =>
      applyEvents(state, [
        repoint(a, { retiredAt: at, redirectTo: b }, { retiredAt: at, redirectTo: null })
      ])
    ).toThrow(StructureEventConflictError);
    // A live topic is retired by an ordinary event, not re-pointed.
    expect(() =>
      applyEvents(state, [
        repoint(d, { retiredAt: null, redirectTo: null }, { retiredAt: at, redirectTo: null })
      ])
    ).not.toThrow();
    expect(getTopic(state, a).redirectTo).toBe(b);
  });

  it("blocks the undo of a compression once a later change writes the topic it names", () => {
    const state = chained();
    const events = compressRedirects(state, [{ topicId: a, from: b, to: d, hops: 3 }]);
    const target = { id: "cs-compress", status: "applied" as const, undoOf: null, events };
    const retireD: StructureEvent = {
      op: "topic.retire",
      topicId: d,
      before: { retiredAt: null, redirectTo: null },
      after: { retiredAt: at, redirectTo: e }
    };
    const later = { id: "cs-later", status: "applied" as const, undoOf: null, events: [retireD] };
    expect(changeSetBlockers(target, [])).toEqual([]);
    expect(changeSetBlockers(target, [later])).toEqual([
      { kind: "changeSet", changeSetId: "cs-later", objects: [`topic:${d}`] }
    ]);
  });
});
