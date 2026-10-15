import { describe, expect, it } from "vitest";

import { splitLeaf } from "./build.js";
import { topicTreeConfigWith } from "./config.js";
import { applyEvents, createTopicTreeEditor } from "./events.js";
import type { StructureEvent, TopicTreeEditor } from "./events.js";
import { createWorld, shapeContext, uuidOf, worldNow } from "./fixtures/placement-world.js";
import type { World } from "./fixtures/placement-world.js";
import {
  TopicOperationError,
  createTopic,
  humanPlaceItem,
  moveTopic,
  pinTopic,
  renameTopic,
  unpinTopic
} from "./human-ops.js";
import type { HumanOperationContext } from "./human-ops.js";
import { itemKey } from "./ids.js";
import { checkInvariants } from "./invariants.js";
import {
  applyGateResolution,
  decidePlacement,
  placeItem,
  resolveGate,
  topicsWithStaleStats
} from "./place.js";
import type { PlacementContext } from "./place.js";
import { createRng, deriveSeed } from "./rng.js";
import type { Rng } from "./rng.js";
import { invalidSecondaries } from "./secondary.js";
import {
  canonicalStateDump,
  cloneTopicTreeState,
  createTopicTreeState,
  deletePlacement,
  getTopic,
  isLive,
  liveTopicIds,
  placementRecord,
  placementsOf,
  primaryPlacement,
  registerItem,
  unregisterItem
} from "./state.js";
import type { TopicTreeState } from "./state.js";
import { recomputePaths, recomputeSubtree, statsDump } from "./stats.js";
import { changeSetBlockers, changeSetFootprint, undoBlockers, undoChangeSet } from "./undo.js";
import type { UndoableChangeSet } from "./undo.js";
import { rowView } from "./vectors.js";

const t = (n: number): string => uuidOf(n);
const config = topicTreeConfigWith({ depth: { target: 3, cap: 4 } });
const items = [1, 2, 3].map((n) => itemKey("note", uuidOf(500 + n)));

/** root(0) ── 1 "Ciência" ── 2 "Física" ── 3 "Óptica"; 1 ── 4 "Química"; root ── 5 "Artes". */
function named(): TopicTreeState {
  const state = createTopicTreeState({ dim: 2, rootId: t(0) });
  const setup = createTopicTreeEditor(state, { record: false });
  const titles: [number, number, string][] = [
    [1, 0, "Ciência"],
    [2, 1, "Física"],
    [3, 2, "Óptica"],
    [4, 1, "Química"],
    [5, 0, "Artes"]
  ];
  for (const [id, parent, title] of titles) {
    setup.createTopic(t(id), t(parent), { title, nameState: "named", nameSource: "llm" });
  }
  items.forEach((key, index) =>
    registerItem(state, { key, kind: "note", contentHash: `h${index}`, rootSource: null })
  );
  setup.placeItem(items[0] as string, placementRecord(t(3)));
  setup.placeItem(items[1] as string, placementRecord(t(4)));
  return state;
}

/** Records change-sets the way the service does: one editor per change-set. */
class History {
  readonly log: UndoableChangeSet[] = [];
  private next = 0;
  constructor(readonly state: TopicTreeState) {}

  run(operation: (context: HumanOperationContext & { editor: TopicTreeEditor }) => void) {
    const editor = createTopicTreeEditor(this.state);
    operation({ state: this.state, config, editor });
    const changeSet: UndoableChangeSet = {
      id: t(9000 + this.next++),
      status: "applied",
      undoOf: null,
      events: [...editor.events]
    };
    this.log.push(changeSet);
    return changeSet;
  }

  later(target: UndoableChangeSet): UndoableChangeSet[] {
    return this.log.slice(this.log.indexOf(target) + 1);
  }

  undo(target: UndoableChangeSet) {
    const result = undoChangeSet(this.state, config, target, this.later(target));
    if (result.kind === "undone") {
      target.status = "undone";
      this.log.push({
        id: t(9000 + this.next++),
        status: "applied",
        undoOf: target.id,
        events: result.events
      });
    }
    return result;
  }
}

describe("change-set footprints", () => {
  it("writes the touched facets and requires the live topics it attaches to", () => {
    const state = named();
    const history = new History(state);
    const create = history.run((context) => createTopic(context, t(6), t(5), "Música"));
    expect([...changeSetFootprint(create.events).writes].sort()).toEqual(
      ["life", "parent", "name", "description", "management"]
        .map((part) => `topic:${t(6)}#${part}`)
        .sort()
    );
    expect([...changeSetFootprint(create.events).requires]).toEqual([`topic:${t(5)}#life`]);
    const place = history.run((context) =>
      humanPlaceItem(context, items[2] as string, t(6), "primary")
    );
    expect([...changeSetFootprint(place.events).writes]).toEqual([`item:${items[2]}`]);
    expect([...changeSetFootprint(place.events).requires]).toEqual([`topic:${t(6)}#life`]);
    const move = history.run((context) => moveTopic(context, t(3), t(5)));
    expect([...changeSetFootprint(move.events).writes].sort()).toEqual([
      `topic:${t(3)}#management`,
      `topic:${t(3)}#parent`
    ]);
    expect([...changeSetFootprint(move.events).requires].sort()).toEqual(
      [`topic:${t(2)}#life`, `topic:${t(3)}#life`, `topic:${t(5)}#life`].sort()
    );
  });
});

describe("undo blockers", () => {
  it("names every later change-set that touched the same objects, and only those", () => {
    const state = named();
    const history = new History(state);
    const create = history.run((context) => createTopic(context, t(6), t(5), "Música"));
    const rename = history.run((context) => renameTopic(context, t(6), "Música popular"));
    const place = history.run((context) =>
      humanPlaceItem(context, items[2] as string, t(6), "primary")
    );
    history.run((context) => renameTopic(context, t(2), "Mecânica"));
    history.run((context) => pinTopic(context, t(5)));
    const dump = canonicalStateDump(state);
    expect(undoBlockers(state, config, create, history.later(create))).toEqual([
      { kind: "changeSet", changeSetId: rename.id, objects: [`topic:${t(6)}`] },
      { kind: "changeSet", changeSetId: place.id, objects: [`topic:${t(6)}`] }
    ]);
    expect(canonicalStateDump(state)).toBe(dump);
    // Independent change-sets do not block: the rename of 6 undoes past the pin and rename of 2.
    expect(undoBlockers(state, config, rename, history.later(rename))).toEqual([]);
    expect(canonicalStateDump(state)).toBe(dump);
    expect(history.undo(rename).kind).toBe("undone");
    expect(getTopic(state, t(6)).title).toBe("Música");
  });

  it("lets a change-set and its later undo cancel out, but not a redo", () => {
    const state = named();
    const history = new History(state);
    const first = history.run((context) => renameTopic(context, t(2), "Mecânica"));
    const second = history.run((context) => renameTopic(context, t(2), "Mecânica clássica"));
    expect(changeSetBlockers(first, history.later(first)).map((b) => b.kind)).toEqual([
      "changeSet"
    ]);
    expect(history.undo(second).kind).toBe("undone");
    expect(changeSetBlockers(first, history.later(first))).toEqual([]);
    // Undoing the undo re-applies the second rename: it blocks the first again.
    const undo = history.log[history.log.length - 1] as UndoableChangeSet;
    expect(history.undo(undo).kind).toBe("undone");
    expect(getTopic(state, t(2)).title).toBe("Mecânica clássica");
    expect(changeSetBlockers(first, history.later(first))).toEqual([
      expect.objectContaining({ kind: "changeSet", changeSetId: history.log[3]?.id })
    ]);
    // Without the undo link the pair is not recognised, which only over-blocks.
    const unlinked = history.later(first).map((changeSet) => ({ ...changeSet, undoOf: null }));
    expect(changeSetBlockers(first, unlinked).length).toBeGreaterThan(0);
  });

  it("refuses change-sets that are not applied and reports deleted items (D32)", () => {
    const state = named();
    const history = new History(state);
    const place = history.run((context) =>
      humanPlaceItem(context, items[2] as string, t(3), "primary")
    );
    expect(undoBlockers(state, config, { ...place, status: "pending_review" }, [])).toEqual([
      { kind: "notApplied", status: "pending_review" }
    ]);
    deletePlacement(state, items[2] as string, 0);
    unregisterItem(state, items[2] as string);
    expect(undoBlockers(state, config, place, [])).toEqual([
      { kind: "itemDeleted", item: items[2] }
    ]);
  });

  it("reports a cycle the inverse would make", () => {
    const state = named();
    const history = new History(state);
    const out = history.run((context) => moveTopic(context, t(2), t(0)));
    history.run((context) => moveTopic(context, t(1), t(2)));
    const dump = canonicalStateDump(state);
    const blockers = undoBlockers(state, config, out, history.later(out));
    expect(blockers).toEqual([expect.objectContaining({ kind: "conflict", code: "cycle" })]);
    expect(canonicalStateDump(state)).toBe(dump);
  });

  it("reports a duplicate sibling title, an I2 break and the depth cap", () => {
    const titles = named();
    const renames = new History(titles);
    const rename = renames.run((context) => renameTopic(context, t(2), "Mecânica"));
    renames.run((context) => renameTopic(context, t(4), "Física"));
    expect(undoBlockers(titles, config, rename, renames.later(rename))).toEqual([
      expect.objectContaining({ kind: "conflict", code: "duplicateTitle", topicId: t(2) })
    ]);

    const secondaries = named();
    const moves = new History(secondaries);
    const move = moves.run((context) => moveTopic(context, t(4), t(5)));
    moves.run((context) => humanPlaceItem(context, items[1] as string, t(1), "secondary"));
    const dump = canonicalStateDump(secondaries);
    expect(undoBlockers(secondaries, config, move, moves.later(move))).toEqual([
      expect.objectContaining({ kind: "conflict", code: "secondaryOnPrimaryPath", item: items[1] })
    ]);
    expect(canonicalStateDump(secondaries)).toBe(dump);

    const deep = named();
    const deepen = new History(deep);
    const lift = deepen.run((context) => moveTopic(context, t(3), t(5)));
    deepen.run((context) => createTopic(context, t(6), t(3), "Lentes"));
    deepen.run((context) => createTopic(context, t(7), t(6), "Vidro"));
    expect(undoBlockers(deep, config, lift, deepen.later(lift))).toEqual([
      expect.objectContaining({ kind: "conflict", code: "depthCap", topicId: t(3) })
    ]);
  });
});

// ---------------------------------------------------------------------------
// Seeded change-set sequences

interface Recorded extends UndoableChangeSet {
  kind: string;
}

interface Checkpoint {
  dump: string;
  stats: string;
}

/** Operations of a sequence step; "place" and "human-place" are drawn more often. */
const operationKinds = [
  "place",
  "place",
  "place",
  "place",
  "gate",
  "rename",
  "move",
  "create",
  "pin",
  "human-place",
  "human-place",
  "split"
] as const;

const titlePool = ["Alfa", "alfa", "Beta", "Gama", "Gâma", "Delta", "Épsilon", "Zeta"];

/** Topic IDs and item keys an event mentions (the independent object view of a change-set). */
function objectsOf(events: readonly StructureEvent[]): Set<string> {
  const output = new Set<string>();
  const topic = (id: string | null | undefined): void => {
    if (id) output.add(`topic:${id}`);
  };
  for (const event of events) {
    topic(event.topicId);
    if ("item" in event) {
      output.add(`item:${event.item}`);
      topic(event.before?.topicId);
      topic(event.after?.topicId);
    } else if (event.op === "topic.create") {
      topic(event.after?.parentId ?? event.before?.parentId);
      topic(event.after?.redirectTo ?? event.before?.redirectTo);
    } else if (event.op === "topic.move") {
      topic(event.before.parentId);
      topic(event.after.parentId);
    } else if (event.op === "topic.retire" || event.op === "topic.restore") {
      topic(event.before.redirectTo);
      topic(event.after.redirectTo);
    }
  }
  return output;
}

/** Facet pairs that must always block (an independent partial oracle of the footprint rule). */
function mustBlock(target: readonly StructureEvent[], later: readonly StructureEvent[]): boolean {
  const items = (events: readonly StructureEvent[]) =>
    new Set(events.flatMap((event) => ("item" in event ? [event.item] : [])));
  const laterItems = items(later);
  if ([...items(target)].some((item) => laterItems.has(item))) return true;
  const created = target.filter((event) => event.op === "topic.create").map((e) => e.topicId);
  const mentioned = objectsOf(later);
  if (created.some((id) => mentioned.has(`topic:${id}`))) return true;
  const same = new Set(
    target.filter((event) => !("item" in event)).map((event) => `${event.op}:${event.topicId}`)
  );
  return later.some((event) => !("item" in event) && same.has(`${event.op}:${event.topicId}`));
}

interface SequenceStats {
  changeSets: number;
  decisions: Record<string, number>;
  refused: number;
  undone: number;
  blockedChecks: number;
  unblockedChecks: number;
}

/**
 * Recomputing only the paths of topicsWithStaleStats gives the same statistics as a full exact
 * recompute (D7, D8); the full recompute is then kept, as the service does after a change-set.
 */
function expectExactPaths(
  state: TopicTreeState,
  vectors: World["vectors"],
  events: readonly StructureEvent[]
): void {
  const partial = cloneTopicTreeState(state);
  recomputePaths(partial, vectors, topicsWithStaleStats(partial, events));
  recomputeSubtree(state, vectors);
  expect(statsDump(partial)).toBe(statsDump(state));
}

function pick<T>(rng: Rng, values: readonly T[]): T | undefined {
  return values.length > 0 ? values[rng.int(values.length)] : undefined;
}

function runSequence(world: World, seed: number, totals: SequenceStats): void {
  const rng = createRng(deriveSeed(seed, "sequence"));
  const state = cloneTopicTreeState(world.state);
  const initial = cloneTopicTreeState(state);
  let nextTopic = 500;
  const sequenceWorld = { ...world, state, newTopicId: () => uuidOf(2_000_000 + nextTopic++) };
  const log: Recorded[] = [];
  const checkpoints: Checkpoint[] = [];
  const checkpoint = (): Checkpoint => ({
    dump: canonicalStateDump(state),
    stats: statsDump(state)
  });
  checkpoints.push(checkpoint());
  const steps = 4 + rng.int(7);
  for (let step = 0; step < steps; step += 1) {
    const editor = createTopicTreeEditor(state);
    const context: PlacementContext & HumanOperationContext = {
      state,
      vectors: world.vectors,
      config: world.config,
      editor,
      now: worldNow
    };
    const topics = liveTopicIds(state);
    const nonRoot = topics.filter((id) => id !== state.rootId);
    const before = canonicalStateDump(state);
    const topicCount = state.topics.size;
    const kind = operationKinds[rng.int(operationKinds.length)] as (typeof operationKinds)[number];
    try {
      if (kind === "place") {
        const unplaced = world.items.filter((item) => !primaryPlacement(state, item));
        const placed = world.items.filter((item) => primaryPlacement(state, item));
        const count = 1 + rng.int(3);
        for (let index = 0; index < count; index += 1) {
          const fresh = rng.next() < 0.7;
          const item = pick(rng, fresh ? unplaced : placed);
          if (!item) continue;
          const outcome = placeItem(context, item, {
            fingerprint: fresh ? "v1" : `v${seed}:${step}`
          });
          const decision = outcome.decision?.kind ?? outcome.kind;
          totals.decisions[decision] = (totals.decisions[decision] ?? 0) + 1;
        }
      } else if (kind === "gate") {
        const waiting = world.items.filter((item) => primaryPlacement(state, item)?.needsGate);
        const item = pick(rng, waiting);
        const row = item === undefined ? undefined : world.vectors.rowOf(item);
        if (item !== undefined && row !== undefined) {
          const decision = decidePlacement(state, world.config, rowView(world.vectors.matrix, row));
          if (decision.kind === "gate") {
            const resolution = resolveGate(
              decision.candidates.map((candidate) => ({
                topicId: candidate.topicId,
                logOdds: rng.gaussian() * 3 - 1.5
              })),
              world.config.gate
            );
            totals.decisions[`gate-${resolution.kind}`] =
              (totals.decisions[`gate-${resolution.kind}`] ?? 0) + 1;
            applyGateResolution(context, item, resolution, { candidates: decision.leaves });
          }
        }
      } else if (kind === "rename") {
        const id = pick(rng, nonRoot);
        if (id) renameTopic(context, id, pick(rng, titlePool) as string, { language: "pt-BR" });
      } else if (kind === "move") {
        const id = pick(rng, nonRoot);
        const parent = pick(rng, topics);
        if (id && parent) moveTopic(context, id, parent);
      } else if (kind === "create") {
        createTopic(
          context,
          sequenceWorld.newTopicId(),
          pick(rng, topics) as string,
          pick(rng, titlePool) as string
        );
      } else if (kind === "pin") {
        const id = pick(rng, nonRoot);
        if (id) {
          if (getTopic(state, id).management === "pinned") unpinTopic(context, id);
          else pinTopic(context, id);
        }
      } else if (kind === "human-place") {
        const item = pick(rng, world.items);
        const topic = pick(rng, topics);
        if (item && topic) {
          humanPlaceItem(context, item, topic, rng.next() < 0.5 ? "primary" : "secondary");
        }
      } else {
        const leaf = nonRoot
          .filter((id) => getTopic(state, id).children.length === 0)
          .sort((a, b) => getTopic(state, b).items.length - getTopic(state, a).items.length)[0];
        if (leaf && getTopic(state, leaf).items.length > world.config.leaf.max) {
          splitLeaf(shapeContext(sequenceWorld, editor, seed), leaf);
        }
      }
    } catch (error) {
      if (!(error instanceof TopicOperationError)) throw error;
      totals.refused += 1;
      expect(editor.events).toHaveLength(0);
      expect(canonicalStateDump(state)).toBe(before);
      continue;
    }
    if (editor.events.length === 0) {
      expect(canonicalStateDump(state)).toBe(before);
      continue;
    }
    if (kind === "place" || kind === "gate") {
      // A lone item never creates a topic.
      expect(state.topics.size).toBe(topicCount);
      expect(editor.events.every((event) => event.op.startsWith("item."))).toBe(true);
    }
    expectExactPaths(state, world.vectors, editor.events);
    const report = checkInvariants(state, world.config, {
      expectedItems: world.items.filter((item) => primaryPlacement(state, item))
    });
    const broken = report.violations.filter(
      (violation) => violation.severity === "hard" && !["I3", "I4"].includes(violation.code)
    );
    expect(broken).toEqual([]);
    const overfull = world.items.filter(
      (item) =>
        placementsOf(state, item).length > 3 ||
        invalidSecondaries(state, world.config, item).length > 0
    );
    expect(overfull).toEqual([]);
    log.push({
      id: uuidOf(3_000_000 + step),
      status: "applied",
      undoOf: null,
      events: [...editor.events],
      kind
    });
    checkpoints.push(checkpoint());
  }
  totals.changeSets += log.length;
  if (log.length === 0) return;

  // Soundness of the blockers: with none, undo equals replaying the history without the target.
  if (log.length >= 2) {
    const index = rng.int(log.length - 1);
    const target = log[index] as Recorded;
    const later = log.slice(index + 1);
    const trial = cloneTopicTreeState(state);
    const dump = canonicalStateDump(trial);
    const blockers = undoBlockers(trial, world.config, target, later);
    expect(canonicalStateDump(trial)).toBe(dump);
    if (blockers.length === 0) {
      totals.unblockedChecks += 1;
      expect(undoChangeSet(trial, world.config, target, later).kind).toBe("undone");
      const replay = cloneTopicTreeState(initial);
      for (const changeSet of log) {
        if (changeSet !== target) applyEvents(replay, changeSet.events);
      }
      expect(canonicalStateDump(trial)).toBe(canonicalStateDump(replay));
    } else {
      totals.blockedChecks += 1;
      const targetObjects = objectsOf(target.events);
      for (const blocker of blockers) {
        if (blocker.kind !== "changeSet") continue;
        const changeSet = later.find((candidate) => candidate.id === blocker.changeSetId);
        expect(changeSet).toBeDefined();
        expect(blocker.objects.every((object) => targetObjects.has(object))).toBe(true);
      }
    }
    // Every later change-set that shares an item, uses a created topic, or repeats a topic edit
    // is named.
    const named = new Set(
      blockers.flatMap((blocker) => (blocker.kind === "changeSet" ? [blocker.changeSetId] : []))
    );
    for (const changeSet of later) {
      if (mustBlock(target.events, changeSet.events)) expect(named.has(changeSet.id)).toBe(true);
    }
  }

  // Undoing the last k change-sets in reverse restores the earlier state byte for byte.
  const k = 1 + rng.int(log.length);
  const history: UndoableChangeSet[] = [...log];
  for (let index = log.length - 1; index >= log.length - k; index -= 1) {
    const target = log[index] as Recorded;
    const later = history.slice(history.indexOf(target) + 1);
    const result = undoChangeSet(state, world.config, target, later);
    expect(result.kind).toBe("undone");
    if (result.kind !== "undone") return;
    target.status = "undone";
    history.push({
      id: uuidOf(4_000_000 + index),
      status: "applied",
      undoOf: target.id,
      events: result.events
    });
    expectExactPaths(state, world.vectors, result.events);
    totals.undone += 1;
  }
  const earlier = checkpoints[log.length - k] as Checkpoint;
  expect(canonicalStateDump(state)).toBe(earlier.dump);
  expect(statsDump(state)).toBe(earlier.stats);
  expect([...state.topics.values()].filter((node) => isLive(node) && node.control.dirty)).toEqual(
    []
  );
}

describe("seeded change-set sequences (1,000)", () => {
  it("undo is exact, blockers are sound, and PLACE keeps I2 without creating topics", () => {
    const worlds = Array.from({ length: 8 }, (_, index) => createWorld({ seed: 100 + index }));
    const totals: SequenceStats = {
      changeSets: 0,
      decisions: {},
      refused: 0,
      undone: 0,
      blockedChecks: 0,
      unblockedChecks: 0
    };
    for (let sequence = 0; sequence < 1000; sequence += 1) {
      runSequence(worlds[sequence % worlds.length] as World, 20261015 + sequence, totals);
    }
    // Coverage: every kind of decision, refusals, and both blocker outcomes occurred.
    for (const kind of ["auto", "gate", "unadmitted", "gate-accept", "gate-none"]) {
      expect(totals.decisions[kind] ?? 0).toBeGreaterThan(20);
    }
    expect(totals.refused).toBeGreaterThan(100);
    expect(totals.undone).toBeGreaterThan(1000);
    expect(totals.blockedChecks).toBeGreaterThan(50);
    expect(totals.unblockedChecks).toBeGreaterThan(100);
    expect(totals.changeSets).toBeGreaterThan(4000);
  });
});
