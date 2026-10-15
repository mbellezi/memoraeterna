import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { topicTreeConfigWith } from "./config.js";
import type { TopicTreeConfig } from "./config.js";
import { createTopicTreeEditor } from "./events.js";
import { uuidOf, worldNow } from "./fixtures/placement-world.js";
import {
  decideWaitingItems,
  distinctTitles,
  gateCacheKeys,
  gateDeciderKey,
  gateDescriptor,
  gateNoteQuery,
  gateScores,
  gateSourceQuery,
  gateTextVersion,
  sourceCentralNotes,
  unrankedGateResolution
} from "./gate.js";
import { itemKey } from "./ids.js";
import type { ItemKey } from "./ids.js";
import { decidePlacement, placeItem, resolveGate } from "./place.js";
import {
  canonicalStateDump,
  createTopicTreeState,
  placementRecord,
  primaryPlacement,
  registerItem
} from "./state.js";
import type { TopicTreeState } from "./state.js";
import { recomputeSubtree, statsDump } from "./stats.js";
import { createMatrix, keyedVectors, unit } from "./vectors.js";
import type { ItemVectorSource } from "./vectors.js";

const sha = (text: string): string => createHash("sha256").update(text).digest("hex");
const gate = topicTreeConfigWith({}).gate;

describe("gate texts", () => {
  it("builds a note query from Title, Idea and the first body characters (Spike A)", () => {
    const query = gateNoteQuery(
      { title: "  Spaced   retrieval ", idea: "Spacing\nhelps memory.", body: "a".repeat(500) },
      gate
    );
    expect(query).toBe(
      `Title: Spaced retrieval\nIdea: Spacing helps memory.\nText: ${"a".repeat(400)}`
    );
    // Empty fields are left out; the excerpt is counted in characters, never cutting a pair.
    expect(gateNoteQuery({ title: "T", idea: null, body: "  " }, gate)).toBe("Title: T");
    const emoji = gateNoteQuery({ title: "T", idea: "", body: "😀".repeat(401) }, gate);
    expect(Array.from(emoji.split("Text: ")[1]!)).toHaveLength(400);
    expect(
      gateNoteQuery(
        { title: "T", idea: "I", body: "b".repeat(50) },
        { ...gate, queryTextMaxChars: 10 }
      )
    ).toBe("Title: T\nIdea: I\nText: bbbbbbbbbb");
  });

  it("builds a source query from its title, a catalog excerpt and distinct note titles", () => {
    const query = gateSourceQuery(
      {
        title: "Memory",
        header: '{\n  "title": "Memory",\n  "summary": "On forgetting."\n}',
        noteTitles: ["Forgetting curve", "forgetting  CURVE", "Retrieval", "Sleep", "Spacing"]
      },
      gate
    );
    expect(query).toBe(
      'Title: Memory\nAbout: { "title": "Memory", "summary": "On forgetting." }\n' +
        "Notes: Forgetting curve; Retrieval; Sleep"
    );
    expect(gateSourceQuery({ title: "Only", header: null, noteTitles: [] }, gate)).toBe(
      "Title: Only"
    );
  });

  it("describes a topic by name, description, aliases and distinct central titles", () => {
    expect(
      gateDescriptor(
        {
          title: "Curva do esquecimento",
          description: "Como a memória decai.",
          aliases: ["Esquecimento", "esquecimento"],
          examples: ["Ebbinghaus", "Ebbinghaus", "Revisão espaçada", "Sono", "Extra"]
        },
        gate
      )
    ).toBe(
      "Topic: Curva do esquecimento\nAbout: Como a memória decai.\nAlso called: Esquecimento\n" +
        "Examples: Ebbinghaus; Revisão espaçada; Sono"
    );
    // An unnamed topic is described by its members alone; one with nothing to say is not ranked.
    expect(
      gateDescriptor({ title: null, description: null, aliases: [], examples: ["A"] }, gate)
    ).toBe("Examples: A");
    expect(
      gateDescriptor({ title: null, description: null, aliases: [], examples: [] }, gate)
    ).toBeNull();
    expect(distinctTitles(["A", " a ", "Á", "B"], 5)).toEqual(["A", "B"]);
  });
});

describe("gate cache keys", () => {
  const candidates = [
    { topicId: uuidOf(3), descriptor: "Topic: Sleep" },
    { topicId: uuidOf(1), descriptor: "Topic: Retrieval" },
    { topicId: uuidOf(2), descriptor: null }
  ];

  it("orders candidates by content key and keys the call by content alone (D22)", () => {
    const keys = gateCacheKeys("Title: Q", candidates, sha);
    const hashes = keys.candidates.map((candidate) => candidate.descriptorHash);
    expect([...hashes].sort()).toEqual(hashes);
    expect(keys.itemHash).toBe(sha(`${gateTextVersion}\nTitle: Q`));
    // The same content under fresh IDs and in another order makes the same call and keys.
    const renamed = gateCacheKeys(
      "Title: Q",
      [...candidates].reverse().map((candidate, index) => ({
        ...candidate,
        topicId: uuidOf(100 + index)
      })),
      sha
    );
    expect(renamed.itemHash).toBe(keys.itemHash);
    expect(renamed.descriptorSetHash).toBe(keys.descriptorSetHash);
    expect(renamed.candidates.map((candidate) => candidate.descriptor)).toEqual(
      keys.candidates.map((candidate) => candidate.descriptor)
    );
    // Another descriptor changes the set; identical descriptors fall back to the topic ID.
    expect(
      gateCacheKeys("Title: Q", [{ ...candidates[0]!, descriptor: "Topic: Naps" }], sha)
        .descriptorSetHash
    ).not.toBe(gateCacheKeys("Title: Q", [candidates[0]!], sha).descriptorSetHash);
    const twins = gateCacheKeys(
      "Title: Q",
      [
        { topicId: uuidOf(9), descriptor: "Same" },
        { topicId: uuidOf(4), descriptor: "Same" }
      ],
      sha
    );
    expect(twins.candidates.map((candidate) => candidate.topicId)).toEqual([uuidOf(4), uuidOf(9)]);
  });

  it("names the decider by artifact and instruction, within the column bound", () => {
    const identity = {
      runtime: "mlx",
      repository: "Qwen/Qwen3-Reranker-0.6B",
      revision: "e61197ed45024b0ed8a2d74b80b4d909f1255473",
      quantization: "bf16",
      instruction: "Given a note, retrieve the topic it belongs to."
    };
    const key = gateDeciderKey(identity, sha);
    expect(key).toContain("ranker:mlx:Qwen/Qwen3-Reranker-0.6B@e61197ed");
    expect(key.length).toBeLessThanOrEqual(300);
    expect(gateDeciderKey({ ...identity, instruction: "Other" }, sha)).not.toBe(key);
    expect(gateDeciderKey({ ...identity, runtime: "gguf" }, sha)).not.toBe(key);
    expect(
      gateDeciderKey({ ...identity, repository: "x".repeat(500) }, sha).length
    ).toBeLessThanOrEqual(300);
  });

  it("feeds the D10 rule only the candidates the ranker scored", () => {
    const scores = gateScores([
      { topicId: uuidOf(1), logOdds: 3 },
      { topicId: uuidOf(2), logOdds: null },
      { topicId: uuidOf(3), logOdds: -1 }
    ]);
    expect(scores).toEqual([
      { topicId: uuidOf(1), logOdds: 3 },
      { topicId: uuidOf(3), logOdds: -1 }
    ]);
    expect(resolveGate(scores, gate)).toMatchObject({ kind: "accept", topicId: uuidOf(1) });
    expect(unrankedGateResolution()).toMatchObject({ kind: "none", topicId: null });
  });
});

// ---------------------------------------------------------------------------
// Decisions of waiting items

const dim = 4;
const ids = { root: uuidOf(100), a: uuidOf(101), a1: uuidOf(102), a2: uuidOf(103), b: uuidOf(104) };
const vec = (...values: number[]) => unit(Float32Array.from(values));

interface Hand {
  state: TopicTreeState;
  vectors: ItemVectorSource;
  config: TopicTreeConfig;
  key: (name: string) => ItemKey;
}

/**
 * root ── A ── A1 (near e1), A2 (near e2)
 *     └── B (near e3)
 * plus named query notes of one root source (registered, unplaced) and the source itself.
 */
function handTree(queries: Record<string, Float32Array>): Hand {
  const config = topicTreeConfigWith({
    placement: { spreadFactor: 10, spreadFloor: 0.2, ambiguityMargin: 0.05 },
    secondary: { maxScoreGap: 0.3 }
  });
  const members = {
    a1: [vec(1, 0.1, 0, 0), vec(1, 0, 0.1, 0), vec(1, 0.05, 0.05, 0)],
    a2: [vec(0.1, 1, 0, 0), vec(0, 1, 0.1, 0), vec(0.05, 1, 0.05, 0)],
    b: [vec(0, 0, 1, 0.1), vec(0.1, 0, 1, 0), vec(0, 0.05, 1, 0.05)]
  };
  const source = itemKey("source", uuidOf(500));
  const keys: ItemKey[] = [];
  const rows: Float32Array[] = [];
  const named = new Map<string, ItemKey>();
  let next = 1;
  const leafKeys: Record<string, ItemKey[]> = { a1: [], a2: [], b: [] };
  for (const leaf of ["a1", "a2", "b"] as const) {
    for (const vector of members[leaf]) {
      const key = itemKey("note", uuidOf(next++));
      leafKeys[leaf]!.push(key);
      keys.push(key);
      rows.push(vector);
    }
  }
  for (const [name, vector] of Object.entries(queries)) {
    const key = itemKey("note", uuidOf(next++));
    named.set(name, key);
    keys.push(key);
    rows.push(vector);
  }
  keys.push(source);
  rows.push(vec(1, 1, 0, 0));
  const matrix = createMatrix(rows.length, dim);
  rows.forEach((row, index) => matrix.data.set(row, index * dim));
  const vectors = keyedVectors(matrix, keys);
  const state = createTopicTreeState({ dim, rootId: ids.root });
  keys.forEach((key, index) => {
    const query = [...named.values()].includes(key);
    registerItem(state, {
      key,
      kind: key === source ? "source" : "note",
      contentHash: index.toString(16).padStart(4, "0"),
      rootSource: query ? source : null
    });
  });
  const editor = createTopicTreeEditor(state, { record: false });
  editor.createTopic(ids.a, ids.root);
  editor.createTopic(ids.b, ids.root);
  editor.createTopic(ids.a1, ids.a);
  editor.createTopic(ids.a2, ids.a);
  const leafIds = { a1: ids.a1, a2: ids.a2, b: ids.b };
  for (const leaf of ["a1", "a2", "b"] as const)
    for (const key of leafKeys[leaf]!) editor.placeItem(key, placementRecord(leafIds[leaf]));
  recomputeSubtree(state, vectors);
  return {
    state,
    vectors,
    config,
    key: (name) => (name === "source" ? source : (named.get(name) as ItemKey))
  };
}

describe("decideWaitingItems", () => {
  it("decides a waiting item as PLACE did, and leaves the statistics bit-equal", () => {
    const hand = handTree({ q: vec(1, 0.95, 0, 0), clear: vec(1, 0.02, 0, 0) });
    const editor = createTopicTreeEditor(hand.state);
    const context = {
      state: hand.state,
      vectors: hand.vectors,
      config: hand.config,
      editor,
      now: worldNow
    };
    const q = hand.key("q");
    // PLACE decides the new item from a tree without it, and parks it at A with needs_gate.
    const before = decidePlacement(
      hand.state,
      hand.config,
      hand.vectors.matrix.data.subarray(
        hand.vectors.rowOf(q)! * dim,
        (hand.vectors.rowOf(q)! + 1) * dim
      )
    );
    expect(before.kind).toBe("gate");
    const placed = placeItem(context, q, { fingerprint: "fp-q" });
    expect(placed).toMatchObject({ to: ids.a, needsGate: true });
    recomputeSubtree(hand.state, hand.vectors);
    const stats = statsDump(hand.state);
    const dump = canonicalStateDump(hand.state);

    // The gate decides it again without its own vector in A's statistics: the same decision.
    const decisions = decideWaitingItems(hand.state, hand.vectors, hand.config, [q]);
    const again = decisions.get(q)!;
    expect(again.kind).toBe("gate");
    if (again.kind !== "gate" || before.kind !== "gate") throw new Error("expected gate");
    expect(again.candidates.map((candidate) => candidate.topicId)).toEqual(
      before.candidates.map((candidate) => candidate.topicId)
    );
    expect(again.topicId).toBe(before.topicId);
    for (const [index, candidate] of again.candidates.entries()) {
      expect(candidate.score).toBeCloseTo(before.candidates[index]!.score, 6);
    }
    expect(statsDump(hand.state)).toBe(stats);
    expect(canonicalStateDump(hand.state)).toBe(dump);
    expect(primaryPlacement(hand.state, q)).toMatchObject({ topicId: ids.a, needsGate: true });
  });

  it("leaves out items without a placement or a vector", () => {
    const hand = handTree({ q: vec(1, 0.95, 0, 0) });
    expect(decideWaitingItems(hand.state, hand.vectors, hand.config, [hand.key("q")]).size).toBe(0);
    expect(() =>
      decideWaitingItems(hand.state, hand.vectors, hand.config, [itemKey("note", uuidOf(9999))])
    ).toThrow();
  });

  it("lists a source's notes nearest its vector first", () => {
    const hand = handTree({ far: vec(0, 0, 1, 0), near: vec(1, 1, 0, 0), mid: vec(1, 0, 0, 0) });
    expect(sourceCentralNotes(hand.state, hand.vectors, hand.key("source"), 2)).toEqual([
      hand.key("near"),
      hand.key("mid")
    ]);
    expect(sourceCentralNotes(hand.state, hand.vectors, hand.key("source"), 0)).toEqual([]);
  });
});
