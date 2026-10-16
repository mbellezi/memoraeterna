import { describe, expect, it } from "vitest";

import { topicTreeConfigWith } from "./config.js";
import type { TopicTreeConfig, TopicTreeConfigOverrides } from "./config.js";
import { createTopicTreeEditor } from "./events.js";
import { humanPlaceItem } from "./human-ops.js";
import { createWorld, uuidOf, worldNow } from "./fixtures/placement-world.js";
import { itemKey } from "./ids.js";
import type { ItemKey } from "./ids.js";
import { setTopicLabel } from "./label.js";
import {
  applyGateResolution,
  applyNoDeciderFallback,
  awaitsGateDecision,
  commonAncestor,
  decidePlacement,
  noDeciderDecision,
  placeItem,
  resolveGate,
  topicsWithStaleStats
} from "./place.js";
import { isMovableDirectItem } from "./quality.js";
import type { PlacementContext, PlacementDecision } from "./place.js";
import { createRng } from "./rng.js";
import { invalidSecondaries } from "./secondary.js";
import {
  canonicalStateDump,
  cloneTopicTreeState,
  createTopicTreeState,
  pathOf,
  placementRecord,
  placementsOf,
  primaryPlacement,
  registerItem
} from "./state.js";
import type { TopicTreeState } from "./state.js";
import { recomputePaths, recomputeSubtree, statsDump } from "./stats.js";
import { statsDrift } from "./metrics.js";
import { createMatrix, keyedVectors, unit } from "./vectors.js";
import type { ItemVectorSource } from "./vectors.js";

const dim = 4;
const ids = {
  root: uuidOf(100),
  a: uuidOf(101),
  a1: uuidOf(102),
  a2: uuidOf(103),
  b: uuidOf(104)
};

const lenient: TopicTreeConfigOverrides = {
  // Every topic admits any cosine >= 0.15, so the tests choose outcomes with the vectors alone.
  placement: { spreadFactor: 10, spreadFloor: 0.2, ambiguityMargin: 0.05 },
  secondary: { maxScoreGap: 0.3 }
};

function vec(...values: number[]): Float32Array {
  return unit(Float32Array.from(values));
}

interface Hand {
  state: TopicTreeState;
  vectors: ItemVectorSource;
  config: TopicTreeConfig;
  members: Record<"a1" | "a2" | "b", ItemKey[]>;
  query: (name: string) => ItemKey;
  context: (record?: boolean) => PlacementContext;
}

/**
 * root ── A ── A1 (items near e1), A2 (items near e2)
 *     └── B (items near e3)
 * Query items (registered, unplaced) get the vectors passed in `queries`.
 */
function handTree(
  queries: Record<string, Float32Array> = {},
  overrides: TopicTreeConfigOverrides = lenient
): Hand {
  const config = topicTreeConfigWith(overrides);
  const memberVectors: Record<"a1" | "a2" | "b", Float32Array[]> = {
    a1: [vec(1, 0.1, 0, 0), vec(1, 0, 0.1, 0), vec(1, 0.05, 0.05, 0)],
    a2: [vec(0.1, 1, 0, 0), vec(0, 1, 0.1, 0), vec(0.05, 1, 0.05, 0)],
    b: [vec(0, 0, 1, 0.1), vec(0.1, 0, 1, 0), vec(0, 0.05, 1, 0.05)]
  };
  const keys: ItemKey[] = [];
  const rows: Float32Array[] = [];
  const members = { a1: [] as ItemKey[], a2: [] as ItemKey[], b: [] as ItemKey[] };
  let next = 1;
  for (const leaf of ["a1", "a2", "b"] as const) {
    for (const vector of memberVectors[leaf]) {
      const key = itemKey("note", uuidOf(next++));
      members[leaf].push(key);
      keys.push(key);
      rows.push(vector);
    }
  }
  const queryKeys = new Map<string, ItemKey>();
  for (const [name, vector] of Object.entries(queries)) {
    const key = itemKey("note", uuidOf(next++));
    queryKeys.set(name, key);
    keys.push(key);
    rows.push(vector);
  }
  const matrix = createMatrix(rows.length, dim);
  rows.forEach((row, index) => matrix.data.set(row, index * dim));
  const vectors = keyedVectors(matrix, keys);
  const state = createTopicTreeState({ dim, rootId: ids.root });
  keys.forEach((key, index) =>
    registerItem(state, {
      key,
      kind: "note",
      contentHash: index.toString(16).padStart(4, "0"),
      rootSource: null
    })
  );
  const editor = createTopicTreeEditor(state, { record: false });
  editor.createTopic(ids.a, ids.root);
  editor.createTopic(ids.b, ids.root);
  editor.createTopic(ids.a1, ids.a);
  editor.createTopic(ids.a2, ids.a);
  const leafIds = { a1: ids.a1, a2: ids.a2, b: ids.b };
  for (const leaf of ["a1", "a2", "b"] as const) {
    for (const key of members[leaf]) editor.placeItem(key, placementRecord(leafIds[leaf]));
  }
  recomputeSubtree(state, vectors);
  return {
    state,
    vectors,
    config,
    members,
    query: (name) => queryKeys.get(name) as ItemKey,
    context: (record = true) => ({
      state,
      vectors,
      config,
      editor: createTopicTreeEditor(state, { record }),
      now: worldNow
    })
  };
}

describe("decidePlacement", () => {
  it("places a clear item automatically on its leaf", () => {
    const hand = handTree();
    const decision = decidePlacement(hand.state, hand.config, vec(1, 0.02, 0, 0));
    expect(decision.kind).toBe("auto");
    expect(decision.topicId).toBe(ids.a1);
    expect(decision.margin).toBeGreaterThanOrEqual(hand.config.placement.ambiguityMargin);
    if (decision.kind !== "auto") throw new Error("expected auto");
    expect(decision.leaf.admitted).toBe(true);
    expect(decision.runnerUp?.topicId).toBe(ids.a2);
    expect(decision.leaves.map((leaf) => leaf.topicId)).toContain(ids.b);
  });

  it("gates an ambiguous item at the deepest admitted common ancestor", () => {
    const hand = handTree();
    const decision = decidePlacement(hand.state, hand.config, vec(1, 1, 0, 0));
    expect(decision.kind).toBe("gate");
    if (decision.kind !== "gate") throw new Error("expected gate");
    expect(decision.topicId).toBe(ids.a);
    expect(decision.margin).toBeLessThan(hand.config.placement.ambiguityMargin);
    expect(decision.candidates.map((candidate) => candidate.topicId).sort()).toEqual(
      [ids.a1, ids.a2, ids.b].sort()
    );
    expect(decision.candidates).toContain(decision.best);
    expect(decision.candidates[0]?.score).toBeGreaterThanOrEqual(
      decision.candidates[1]?.score as number
    );
  });

  it("keeps the best admitted leaf among the gate candidates when they are capped", () => {
    const hand = handTree({}, { ...lenient, gate: { maxCandidates: 1 } });
    const decision = decidePlacement(hand.state, hand.config, vec(1, 1, 0, 0));
    if (decision.kind !== "gate") throw new Error("expected gate");
    expect(decision.candidates).toEqual([decision.best]);
  });

  it("falls back to the root when no topic admits the item", () => {
    const hand = handTree();
    const decision = decidePlacement(hand.state, hand.config, vec(0, 0, 0, 1));
    expect(decision).toMatchObject({ kind: "unadmitted", topicId: ids.root, margin: null });
  });

  it("falls back to the deepest admitted internal topic when no leaf admits the item", () => {
    const hand = handTree({}, { ...lenient, placement: { ...lenient.placement, leafFloor: 0.9 } });
    const decision = decidePlacement(hand.state, hand.config, vec(1, 1, 0, 0));
    expect(decision).toMatchObject({ kind: "unadmitted", topicId: ids.a });
    expect(decision.leaves.every((leaf) => !leaf.admitted)).toBe(true);
  });

  it("never treats the root as a leaf", () => {
    const state = createTopicTreeState({ dim, rootId: ids.root });
    const decision = decidePlacement(state, topicTreeConfigWith(lenient), vec(1, 0, 0, 0));
    expect(decision).toMatchObject({ kind: "unadmitted", topicId: ids.root, score: 0 });
    expect(decision.leaves).toEqual([]);
  });

  it("descends from a given topic", () => {
    const hand = handTree();
    const decision = decidePlacement(hand.state, hand.config, vec(0.2, 0.1, 1, 0), {
      from: ids.a
    });
    expect([ids.a1, ids.a2, ids.a]).toContain(decision.topicId);
    expect(decision.leaves.map((leaf) => leaf.topicId)).not.toContain(ids.b);
  });

  it("mixes label similarity into the ranking but admits on the centroid cosine", () => {
    const hand = handTree();
    const query = vec(1, 0.8, 0, 0);
    expect(decidePlacement(hand.state, hand.config, query).topicId).toBe(ids.a1);
    // A2's label points at the query; with label weight 0 the label is ignored.
    setTopicLabel(hand.state, ids.a2, { vector: query, textHash: "h" });
    expect(decidePlacement(hand.state, hand.config, query).topicId).toBe(ids.a1);
    const weighted = topicTreeConfigWith({
      ...lenient,
      placement: { ...lenient.placement, labelWeight: 0.8 }
    });
    const decision = decidePlacement(hand.state, weighted, query);
    expect(decision).toMatchObject({ kind: "auto", topicId: ids.a2 });
    const a2 = decision.leaves.find((leaf) => leaf.topicId === ids.a2);
    expect(a2?.labelCosine).toBeCloseTo(1, 6);
    expect(a2?.admitted).toBe(true);
    expect(a2?.score).toBeCloseTo(0.2 * (a2?.cosine as number) + 0.8, 6);
    const a1 = decision.leaves.find((leaf) => leaf.topicId === ids.a1);
    expect(a1?.labelCosine).toBeNull();
    expect(a1?.score).toBe(a1?.cosine);
  });

  it("is read-only and rejects a vector of the wrong dimension", () => {
    const hand = handTree();
    const dump = canonicalStateDump(hand.state);
    const stats = statsDump(hand.state);
    decidePlacement(hand.state, hand.config, vec(1, 1, 1, 0));
    expect(canonicalStateDump(hand.state)).toBe(dump);
    expect(statsDump(hand.state)).toBe(stats);
    expect(() => decidePlacement(hand.state, hand.config, new Float32Array(3))).toThrow(
      /dimensions/
    );
  });

  it("finds the lowest common ancestor", () => {
    const hand = handTree();
    expect(commonAncestor(hand.state, [ids.a1, ids.a2])).toBe(ids.a);
    expect(commonAncestor(hand.state, [ids.a1, ids.b])).toBe(ids.root);
    expect(commonAncestor(hand.state, [ids.a2])).toBe(ids.a2);
  });
});

describe("resolveGate", () => {
  const gate = topicTreeConfigWith({}).gate;

  it("accepts the best candidate when its softmax probability reaches theta", () => {
    const resolution = resolveGate(
      [
        { topicId: ids.a1, logOdds: 2 },
        { topicId: ids.a2, logOdds: 0 }
      ],
      gate
    );
    const e2 = Math.exp(2);
    expect(resolution.kind).toBe("accept");
    expect(resolution.topicId).toBe(ids.a1);
    expect(resolution.probability).toBeCloseTo(e2 / (e2 + 2), 12);
    expect(resolution.noneProbability).toBeCloseTo(1 / (e2 + 2), 12);
    expect(resolution.probabilities).toHaveLength(2);
  });

  it("answers none below theta, with no candidates, and when tau dominates", () => {
    const strict = { ...gate, theta: 0.9 };
    expect(
      resolveGate(
        [
          { topicId: ids.a1, logOdds: 2 },
          { topicId: ids.a2, logOdds: 0 }
        ],
        strict
      )
    ).toMatchObject({ kind: "none", topicId: ids.a1 });
    expect(resolveGate([], gate)).toMatchObject({ kind: "none", topicId: null, probability: 0 });
    expect(
      resolveGate([{ topicId: ids.a1, logOdds: Number.NEGATIVE_INFINITY }], gate)
    ).toMatchObject({ kind: "none", noneProbability: 1 });
    expect(resolveGate([{ topicId: ids.a1, logOdds: 1 }], { ...gate, tau: 3 }).kind).toBe("none");
  });

  it("sharpens with a lower temperature and refuses invalid scores", () => {
    const scores = [
      { topicId: ids.a1, logOdds: 1 },
      { topicId: ids.a2, logOdds: 0.5 }
    ];
    const warm = resolveGate(scores, { ...gate, temperature: 2 });
    const cold = resolveGate(scores, { ...gate, temperature: 0.5 });
    expect(cold.probability).toBeGreaterThan(warm.probability);
    expect(() => resolveGate([{ topicId: ids.a1, logOdds: Number.NaN }], gate)).toThrow();
    expect(() =>
      resolveGate(
        [
          { topicId: ids.a1, logOdds: 1 },
          { topicId: ids.a1, logOdds: 2 }
        ],
        gate
      )
    ).toThrow(/Duplicate/);
  });

  it("is monotone in theta (1,000 seeded cases)", () => {
    const rng = createRng(20261015);
    let accepted = 0;
    let refused = 0;
    for (let run = 0; run < 1000; run += 1) {
      const scores = Array.from({ length: 1 + rng.int(5) }, (_, index) => ({
        topicId: uuidOf(index),
        logOdds: rng.gaussian() * 4
      }));
      const config = { ...gate, tau: rng.gaussian() * 2, temperature: 0.5 + rng.next() * 2 };
      const thetas = Array.from({ length: 6 }, () => rng.next()).sort((a, b) => a - b);
      let previous: string | null | undefined;
      let open = true;
      for (const theta of thetas) {
        const resolution = resolveGate(scores, { ...config, theta });
        if (resolution.kind === "accept") {
          // Accepting at a higher theta implies accepting the same topic at every lower one.
          expect(open).toBe(true);
          if (previous !== undefined) expect(resolution.topicId).toBe(previous);
          previous = resolution.topicId;
          accepted += 1;
        } else {
          open = false;
          refused += 1;
        }
      }
    }
    expect(accepted).toBeGreaterThan(500);
    expect(refused).toBeGreaterThan(500);
  });
});

describe("placeItem", () => {
  it("places, stays idempotent, and re-decides on a new fingerprint", () => {
    const hand = handTree({ q: vec(1, 0.02, 0, 0) });
    const item = hand.query("q");
    const context = hand.context();
    const first = placeItem(context, item, { fingerprint: "v1" });
    expect(first).toMatchObject({ kind: "placed", from: null, to: ids.a1, needsGate: false });
    expect(primaryPlacement(hand.state, item)).toMatchObject({
      topicId: ids.a1,
      decidedBy: "auto",
      itemFingerprint: "v1",
      management: "ai"
    });
    const events = context.editor.events.length;
    expect(placeItem(context, item, { fingerprint: "v1" }).kind).toBe("unchanged");
    expect(context.editor.events).toHaveLength(events);
    const again = placeItem(context, item, { fingerprint: "v2" });
    expect(again.decision?.kind).toBe("auto");
    expect(again.to).toBe(ids.a1);
    expect(primaryPlacement(hand.state, item)?.itemFingerprint).toBe("v2");
  });

  it("applies a gate decision at the ancestor with needs_gate and never creates a topic", () => {
    const hand = handTree({ q: vec(1, 1, 0, 0) });
    const context = hand.context();
    const topics = hand.state.topics.size;
    const outcome = placeItem(context, hand.query("q"));
    expect(outcome).toMatchObject({ kind: "placed", to: ids.a, needsGate: true });
    expect(primaryPlacement(hand.state, hand.query("q"))).toMatchObject({
      decidedBy: "fallback",
      needsGate: true
    });
    expect(placementsOf(hand.state, hand.query("q"))).toHaveLength(1);
    expect(hand.state.topics.size).toBe(topics);
    expect(context.editor.events.every((event) => event.op.startsWith("item."))).toBe(true);
  });

  it("adds secondaries within the score gap, off the primary path", () => {
    const hand = handTree({ q: vec(1, 0.8, 0, 0) });
    const context = hand.context();
    const outcome = placeItem(context, hand.query("q"));
    expect(outcome.decision?.kind).toBe("auto");
    const placements = placementsOf(hand.state, hand.query("q"));
    expect(placements.map((placement) => [placement.rank, placement.topicId])).toEqual([
      [0, ids.a1],
      [1, ids.a2]
    ]);
    expect(invalidSecondaries(hand.state, hand.config, hand.query("q"))).toEqual([]);
  });

  it("waits in Unsorted with needs_vector and is decided once a vector exists", () => {
    const hand = handTree();
    const item = itemKey("source", uuidOf(900));
    registerItem(hand.state, { key: item, kind: "source", contentHash: "ffff", rootSource: null });
    const context = hand.context();
    expect(placeItem(context, item)).toMatchObject({ kind: "placed", to: ids.root });
    expect(primaryPlacement(hand.state, item)).toMatchObject({
      needsVector: true,
      decidedBy: "fallback"
    });
    expect(placeItem(context, item).kind).toBe("unchanged");
    // The same item now has a vector.
    const matrix = createMatrix(hand.vectors.matrix.count + 1, dim);
    matrix.data.set(hand.vectors.matrix.data);
    matrix.data.set(vec(0, 1, 0.05, 0), hand.vectors.matrix.count * dim);
    const rows = new Map<string, number>([[item, hand.vectors.matrix.count]]);
    const vectors: ItemVectorSource = {
      matrix,
      rowOf: (key) => rows.get(key) ?? hand.vectors.rowOf(key)
    };
    const later = { ...context, vectors };
    const outcome = placeItem(later, item);
    expect(outcome).toMatchObject({ kind: "moved", from: ids.root, to: ids.a2 });
    expect(primaryPlacement(hand.state, item)).toMatchObject({
      needsVector: false,
      movedFromTopicId: null
    });
  });

  it("never re-places a human placement", () => {
    const hand = handTree({ q: vec(1, 0.02, 0, 0), r: vec(0, 1, 0.02, 0) });
    const context = hand.context();
    context.editor.placeItem(
      hand.query("q"),
      placementRecord(ids.b, { management: "human", decidedBy: "human" })
    );
    expect(placeItem(context, hand.query("q"), { force: true }).kind).toBe("protected");
    // A human secondary on the new primary path also keeps the item where it is.
    context.editor.placeItem(hand.query("r"), placementRecord(ids.b));
    context.editor.placeItem(
      hand.query("r"),
      placementRecord(ids.a, { rank: 1, management: "human", decidedBy: "human" })
    );
    const dump = canonicalStateDump(hand.state);
    expect(placeItem(context, hand.query("r"), { force: true }).kind).toBe("protected");
    expect(canonicalStateDump(hand.state)).toBe(dump);
  });

  it("records a moved-from hint only when a settled item moves", () => {
    const hand = handTree({ q: vec(0, 1, 0.02, 0) });
    const context = hand.context();
    context.editor.placeItem(hand.query("q"), placementRecord(ids.b, { itemFingerprint: "old" }));
    const outcome = placeItem(context, hand.query("q"), { fingerprint: "new" });
    expect(outcome).toMatchObject({ kind: "moved", from: ids.b, to: ids.a2 });
    expect(primaryPlacement(hand.state, hand.query("q"))).toMatchObject({
      movedFromTopicId: ids.b,
      movedAt: worldNow
    });
  });

  it("stops counting a root source once one of its notes is placed (D8)", () => {
    const hand = handTree({ note: vec(1, 0.02, 0, 0) });
    const source = itemKey("source", uuidOf(901));
    const note = hand.query("note");
    registerItem(hand.state, {
      key: source,
      kind: "source",
      contentHash: "eeee",
      rootSource: null
    });
    registerItem(hand.state, {
      key: note,
      kind: "note",
      contentHash: hand.state.items.get(note)?.contentHash as string,
      rootSource: source
    });
    const matrix = createMatrix(hand.vectors.matrix.count + 1, dim);
    matrix.data.set(hand.vectors.matrix.data);
    matrix.data.set(vec(0, 0, 1, 0.02), hand.vectors.matrix.count * dim);
    const vectors: ItemVectorSource = {
      matrix,
      rowOf: (key) => (key === source ? hand.vectors.matrix.count : hand.vectors.rowOf(key))
    };
    const context = { ...hand.context(), vectors };
    placeItem(context, source);
    expect(primaryPlacement(hand.state, source)?.topicId).toBe(ids.b);
    expect(hand.state.topics.get(ids.b)?.stats.n).toBe(4);
    placeItem(context, note);
    expect(hand.state.topics.get(ids.b)?.stats.n).toBe(3);
    expect(hand.state.topics.get(ids.root)?.stats.n).toBe(10);
    const drift = statsDrift(hand.state, vectors);
    expect(drift.maxCountError).toBe(0);
    expect(drift.maxSumError).toBeLessThan(1e-9);
  });
});

describe("topicsWithStaleStats", () => {
  it("adds the root source's path when a note's first primary placement stops it counting (D8)", () => {
    const hand = handTree({ note: vec(1, 0.02, 0, 0) });
    const source = itemKey("source", uuidOf(902));
    const note = hand.query("note");
    registerItem(hand.state, {
      key: source,
      kind: "source",
      contentHash: "dddd",
      rootSource: null
    });
    registerItem(hand.state, {
      key: note,
      kind: "note",
      contentHash: hand.state.items.get(note)?.contentHash as string,
      rootSource: source
    });
    const matrix = createMatrix(hand.vectors.matrix.count + 1, dim);
    matrix.data.set(hand.vectors.matrix.data);
    matrix.data.set(vec(0, 0, 1, 0.02), hand.vectors.matrix.count * dim);
    const vectors: ItemVectorSource = {
      matrix,
      rowOf: (key) => (key === source ? hand.vectors.matrix.count : hand.vectors.rowOf(key))
    };
    const setup = createTopicTreeEditor(hand.state, { record: false });
    setup.placeItem(source, placementRecord(ids.b));
    recomputeSubtree(hand.state, vectors);
    // A human placement changes no statistics in memory: the caller recomputes.
    const editor = createTopicTreeEditor(hand.state);
    humanPlaceItem({ state: hand.state, config: hand.config, editor }, note, ids.a1, "primary");
    const stale = topicsWithStaleStats(hand.state, editor.events);
    expect(stale).toEqual([ids.a1, ids.b].sort());
    const touchedOnly = cloneTopicTreeState(hand.state);
    recomputePaths(touchedOnly, vectors, editor.touched);
    const partial = cloneTopicTreeState(hand.state);
    recomputePaths(partial, vectors, stale);
    recomputeSubtree(hand.state, vectors);
    expect(statsDump(partial)).toBe(statsDump(hand.state));
    expect(statsDump(touchedOnly)).not.toBe(statsDump(hand.state));
  });

  it("covers moved, created and retired topics' parents", () => {
    const hand = handTree();
    const editor = createTopicTreeEditor(hand.state);
    editor.moveTopic(ids.a2, ids.root);
    editor.createTopic(uuidOf(950), ids.b);
    editor.retireTopic(uuidOf(950), ids.b, worldNow);
    expect(topicsWithStaleStats(hand.state, editor.events)).toEqual(
      [ids.root, ids.a, ids.a2, ids.b].sort()
    );
  });
});

describe("applyGateResolution", () => {
  function gated(): { hand: Hand; context: PlacementContext; decision: PlacementDecision } {
    const hand = handTree({ q: vec(1, 1, 0, 0) });
    const context = hand.context();
    placeItem(context, hand.query("q"));
    const row = hand.vectors.rowOf(hand.query("q")) as number;
    const decision = decidePlacement(
      hand.state,
      hand.config,
      hand.vectors.matrix.data.subarray(row * dim, (row + 1) * dim)
    );
    return { hand, context, decision };
  }

  it("moves an accepted item to the chosen leaf, with secondaries among the candidates", () => {
    const { hand, context, decision } = gated();
    if (decision.kind !== "gate") throw new Error("expected gate");
    const resolution = resolveGate(
      [
        { topicId: ids.a2, logOdds: 4 },
        { topicId: ids.a1, logOdds: -1 }
      ],
      hand.config.gate
    );
    const outcome = applyGateResolution(context, hand.query("q"), resolution, {
      candidates: decision.leaves
    });
    expect(outcome).toMatchObject({ kind: "moved", from: ids.a, to: ids.a2, needsGate: false });
    const placements = placementsOf(hand.state, hand.query("q"));
    expect(placements[0]).toMatchObject({
      decidedBy: "gate",
      needsGate: false,
      needsSplitCheck: false,
      movedFromTopicId: null
    });
    expect(placements.slice(1).map((placement) => placement.topicId)).toContain(ids.a1);
    expect(invalidSecondaries(hand.state, hand.config, hand.query("q"))).toEqual([]);
    const drift = statsDrift(hand.state, hand.vectors);
    expect(drift.maxSumError).toBeLessThan(1e-9);
  });

  it("flags a refused item for a split check and leaves it at the ancestor", () => {
    const { hand, context } = gated();
    const outcome = applyGateResolution(
      context,
      hand.query("q"),
      resolveGate([{ topicId: ids.a1, logOdds: -5 }], hand.config.gate)
    );
    expect(outcome).toMatchObject({ kind: "updated", to: ids.a, needsGate: false });
    expect(primaryPlacement(hand.state, hand.query("q"))).toMatchObject({
      topicId: ids.a,
      needsGate: false,
      needsSplitCheck: true
    });
  });

  it("is stale when the item no longer waits or the topic is no longer a leaf", () => {
    const { hand, context } = gated();
    const accept = resolveGate([{ topicId: ids.a, logOdds: 5 }], hand.config.gate);
    expect(applyGateResolution(context, hand.query("q"), accept).kind).toBe("stale");
    const settled = handTree({ q: vec(1, 0.02, 0, 0) });
    const settledContext = settled.context();
    placeItem(settledContext, settled.query("q"));
    expect(applyGateResolution(settledContext, settled.query("q"), accept).kind).toBe("stale");
  });
});

describe("the no-decider fallback (owner decision 19)", () => {
  function gated(): { hand: Hand; context: PlacementContext } {
    const hand = handTree({ q: vec(1, 1, 0, 0) });
    const context = hand.context();
    placeItem(context, hand.query("q"));
    expect(primaryPlacement(hand.state, hand.query("q"))?.needsGate).toBe(true);
    return { hand, context };
  }

  it("treats a gated item as the gate's none: movable at its ancestor, marked fallback-none", () => {
    const { hand, context } = gated();
    const q = hand.query("q");
    const before = statsDump(hand.state);
    const outcome = applyNoDeciderFallback(context, q);
    expect(outcome).toMatchObject({ kind: "updated", to: ids.a, needsGate: false, events: 1 });
    expect(primaryPlacement(hand.state, q)).toMatchObject({
      topicId: ids.a,
      decidedBy: noDeciderDecision,
      needsGate: false,
      needsSplitCheck: true,
      movedFromTopicId: null
    });
    expect(placementsOf(hand.state, q)).toHaveLength(1);
    // Flags never change statistics, and REBALANCE may now move the item (quality.ts).
    expect(statsDump(hand.state)).toEqual(before);
    expect(isMovableDirectItem(hand.state, q)).toBe(true);
    expect(awaitsGateDecision(primaryPlacement(hand.state, q))).toBe(true);
    // Applied once: the item no longer waits with needs_gate.
    expect(applyNoDeciderFallback(context, q).kind).toBe("stale");
  });

  it("is stale for a settled item and protected for a human placement", () => {
    const settled = handTree({ q: vec(1, 0.02, 0, 0) });
    const settledContext = settled.context();
    placeItem(settledContext, settled.query("q"));
    expect(applyNoDeciderFallback(settledContext, settled.query("q")).kind).toBe("stale");
    const human = handTree({ q: vec(1, 1, 0, 0) });
    humanPlaceItem(human.context(), human.query("q"), ids.a1, "primary");
    expect(applyNoDeciderFallback(human.context(), human.query("q")).kind).toBe("protected");
  });

  it("lets a ranker decide a fallback item again, wherever REBALANCE moved it", () => {
    const { hand, context } = gated();
    const q = hand.query("q");
    applyNoDeciderFallback(context, q);
    // Accepted: the ranker's leaf, decided by the gate.
    const accept = resolveGate([{ topicId: ids.a2, logOdds: 4 }], hand.config.gate);
    expect(applyGateResolution(context, q, accept)).toMatchObject({ kind: "moved", to: ids.a2 });
    expect(primaryPlacement(hand.state, q)).toMatchObject({
      decidedBy: "gate",
      needsSplitCheck: false
    });
    expect(awaitsGateDecision(primaryPlacement(hand.state, q))).toBe(false);

    // "None" for an item REBALANCE grouped into a new leaf: it keeps that leaf, no longer marked.
    const grouped = gated();
    const item = grouped.hand.query("q");
    applyNoDeciderFallback(grouped.context, item);
    grouped.context.editor.createTopic(uuidOf(200), ids.a);
    grouped.context.editor.updatePlacement(item, 0, {
      topicId: uuidOf(200),
      needsSplitCheck: false
    });
    recomputeSubtree(grouped.hand.state, grouped.hand.vectors);
    const none = resolveGate([{ topicId: ids.a1, logOdds: -5 }], grouped.hand.config.gate);
    expect(applyGateResolution(grouped.context, item, none)).toMatchObject({
      kind: "updated",
      to: uuidOf(200)
    });
    expect(primaryPlacement(grouped.hand.state, item)).toMatchObject({
      topicId: uuidOf(200),
      decidedBy: "fallback",
      needsSplitCheck: false
    });

    // "None" for an item still above the leaves: a plain new-topic candidate (needs_split_check).
    const waiting = gated();
    const above = waiting.hand.query("q");
    applyNoDeciderFallback(waiting.context, above);
    expect(applyGateResolution(waiting.context, above, none)).toMatchObject({ to: ids.a });
    expect(primaryPlacement(waiting.hand.state, above)).toMatchObject({
      decidedBy: "fallback",
      needsSplitCheck: true
    });
    expect(awaitsGateDecision(primaryPlacement(waiting.hand.state, above))).toBe(false);
  });
});

describe("PLACE on a seeded world", () => {
  it("is deterministic for the same input order and keeps I2", () => {
    for (const seed of [1, 2, 3, 4, 5]) {
      const world = createWorld({ seed });
      const runs = [0, 1].map(() => {
        const state = cloneTopicTreeState(world.state);
        const context: PlacementContext = {
          state,
          vectors: world.vectors,
          config: world.config,
          editor: createTopicTreeEditor(state),
          now: worldNow
        };
        const order = createRng(seed).shuffle([...world.pending]);
        const decisions = order.map((item) => {
          const outcome = placeItem(context, item, { fingerprint: "v1" });
          return `${outcome.kind}:${outcome.decision?.kind ?? "-"}:${outcome.to}`;
        });
        return {
          decisions,
          dump: canonicalStateDump(state),
          stats: statsDump(state),
          events: JSON.stringify(context.editor.events),
          state
        };
      });
      const [first, second] = runs as [(typeof runs)[0], (typeof runs)[0]];
      expect(second.decisions).toEqual(first.decisions);
      expect(second.dump).toBe(first.dump);
      expect(second.stats).toBe(first.stats);
      expect(second.events).toBe(first.events);
      expect(first.state.topics.size).toBe(world.state.topics.size);
      for (const item of world.items) {
        expect(placementsOf(first.state, item).length).toBeLessThanOrEqual(3);
        expect(invalidSecondaries(first.state, world.config, item)).toEqual([]);
        const primary = primaryPlacement(first.state, item);
        if (primary) expect(pathOf(first.state, primary.topicId)[0]).toBe(first.state.rootId);
      }
      // In-memory statistics stay within rounding of the exact recompute (D7).
      expect(statsDrift(first.state, world.vectors).maxSumError).toBeLessThan(1e-6);
      expect(statsDrift(first.state, world.vectors).maxCountError).toBe(0);
    }
  });
});
