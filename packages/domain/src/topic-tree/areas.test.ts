import { describe, expect, it } from "vitest";

import {
  areaGroupingInput,
  areaGroupingSignature,
  areaShape,
  centroidSilhouette,
  judgeAreaRegroup,
  levelOneTopic,
  regroupAreas,
  silhouettePoints,
  validateAreaProposal
} from "./areas.js";
import type { AreaGroupingInput, AreaProposal, AreaShape, ValidAreaProposal } from "./areas.js";
import { topicTreeConfigWith } from "./config.js";
import { defaultTopicTreeConfig } from "./config.js";
import { applyEvents, createTopicTreeEditor, invertEvents } from "./events.js";
import { fixtureDay, fixtureNow, fixtureUuid, productState } from "./fixtures/trees.js";
import { gaussianClusters } from "./fixtures/synthetic.js";
import type { ItemKey } from "./ids.js";
import { normalizeTopicTitle } from "./ids.js";
import { checkInvariants } from "./invariants.js";
import {
  canonicalStateDump,
  cloneTopicTreeState,
  getTopic,
  isLive,
  placementRecord,
  primaryPlacement,
  walkTopics
} from "./state.js";
import type { TopicTreeState } from "./state.js";
import { recomputeSubtree } from "./stats.js";
import type { ItemVectorSource } from "./vectors.js";

// 8 groups x 4 clusters x 8 points: 32 level-2 leaves of 8 notes. The "current" Areas mix the
// groups (cluster c sits in Area c mod 8), the "true" grouping puts each group's 4 clusters
// together, which is what a good proposal looks like.
const data = gaussianClusters({
  groups: 8,
  clustersPerGroup: 4,
  pointsPerCluster: 8,
  dim: 24,
  groupSpread: 0.5,
  pointNoise: 0.25,
  seed: 11
});
const config = topicTreeConfigWith({ areas: { minLevel2Topics: 8 } });
const areaNames = [
  "Astronomia",
  "Botânica",
  "Cinema brasileiro",
  "Direito civil",
  "Economia",
  "Fotografia",
  "Geologia",
  "História antiga"
];

interface AreaWorld {
  state: TopicTreeState;
  vectors: ItemVectorSource;
  keys: ItemKey[];
  /** Leaf topic of each cluster. */
  leafOf: string[];
  /** Current Area of each index 0..7. */
  areas: string[];
  newTopicId: () => string;
}

function areaWorld(
  areaOfCluster: (cluster: number) => number = (cluster) => cluster % 8,
  offset = 0
): AreaWorld {
  const { state, keys, vectors, next } = productState(data.matrix, offset);
  const editor = createTopicTreeEditor(state, { record: false });
  const areas = Array.from({ length: 8 }, () => {
    const id = next();
    editor.createTopic(id, state.rootId);
    return id;
  });
  const clusters = Math.max(...data.clusters) + 1;
  const leafOf = Array.from({ length: clusters }, (_, cluster) => {
    const id = next();
    editor.createTopic(id, areas[areaOfCluster(cluster)] as string);
    return id;
  });
  keys.forEach((key, row) => {
    editor.placeItem(
      key,
      placementRecord(leafOf[data.clusters[row] as number] as string, { decidedBy: "build" })
    );
  });
  recomputeSubtree(state, vectors);
  return { state, vectors, keys, leafOf, areas, newTopicId: next };
}

const groupOfCluster = (cluster: number): number => {
  for (let row = 0; row < data.clusters.length; row += 1) {
    if (data.clusters[row] === cluster) return data.groups[row] as number;
  }
  throw new Error(`No row in cluster ${cluster}`);
};

/** The proposal that groups each synthetic group's clusters into one new Area. */
function trueProposal(world: AreaWorld, input: AreaGroupingInput): AreaProposal {
  const aliasOf = new Map(input.units.map((unit) => [unit.topicId, unit.alias]));
  const members = new Map<number, string[]>();
  world.leafOf.forEach((leaf, cluster) => {
    const group = groupOfCluster(cluster);
    members.set(group, [...(members.get(group) ?? []), aliasOf.get(leaf) as string]);
  });
  return {
    areas: [...members.entries()].map(([group, list]) => ({
      new: { title: areaNames[group] as string, description: `Notes about ${areaNames[group]}.` },
      members: list
    }))
  };
}

function valid(input: AreaGroupingInput, proposal: AreaProposal): ValidAreaProposal {
  const result = validateAreaProposal(input, proposal, config);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.proposal;
}

function regroup(world: AreaWorld, proposal: ValidAreaProposal, input: AreaGroupingInput) {
  return regroupAreas({
    state: world.state,
    vectors: world.vectors,
    config,
    input,
    proposal,
    seed: 3,
    now: fixtureNow,
    day: fixtureDay,
    newTopicId: world.newTopicId,
    changeSetId: fixtureUuid(9_000_000),
    contentLanguage: "pt-BR"
  });
}

/** I7 at every step: applies the events one by one to `state` and checks sibling titles. */
function assertUniqueTitlesAtEveryStep(
  state: TopicTreeState,
  events: Parameters<typeof applyEvents>[1]
) {
  for (const event of events) {
    applyEvents(state, [event]);
    walkTopics(state, (node) => {
      const titles = node.children
        .map((child) => getTopic(state, child).title)
        .filter((title): title is string => title !== null)
        .map(normalizeTopicTitle);
      expect(new Set(titles).size).toBe(titles.length);
    });
  }
}

describe("Areas: the grouping input", () => {
  it("aliases units in content order and keeps protected and anchored Areas fixed", () => {
    const world = areaWorld();
    const { state } = world;
    const pinned = world.areas[0] as string;
    const anchoredArea = world.areas[1] as string;
    const humanChild = getTopic(state, anchoredArea).children[0] as string;
    const editor = createTopicTreeEditor(state, { record: false });
    editor.manageTopic(pinned, "pinned");
    editor.manageTopic(humanChild, "human");
    // A level-1 leaf is a unit too.
    const leafArea = world.newTopicId();
    editor.createTopic(leafArea, state.rootId);
    editor.updatePlacement(world.keys[0] as ItemKey, 0, { topicId: leafArea });
    recomputeSubtree(state, world.vectors);

    const input = areaGroupingInput(state);
    expect(input.fixed.map((area) => [area.topicId, area.reason])).toEqual(
      expect.arrayContaining([
        [pinned, "protected"],
        [anchoredArea, "anchored"]
      ])
    );
    expect(input.fixed.find((area) => area.topicId === pinned)?.kept).toEqual(
      getTopic(state, pinned).children
    );
    expect(input.fixed.find((area) => area.topicId === anchoredArea)?.kept).toEqual([humanChild]);
    const unitIds = input.units.map((unit) => unit.topicId);
    expect(unitIds).toContain(leafArea);
    expect(unitIds).not.toContain(humanChild);
    for (const id of getTopic(state, pinned).children) expect(unitIds).not.toContain(id);
    expect(input.units.map((unit) => unit.alias)).toEqual(
      input.units.map((_, index) => `T${index + 1}`)
    );
    expect(input.fixed.map((area) => area.alias)).toEqual(["A1", "A2"]);

    // The aliases follow content, not IDs: the same tree under other UUIDs aliases alike.
    const clusterOf = (world: AreaWorld, id: string): number => world.leafOf.indexOf(id);
    const plain = areaWorld();
    const other = areaWorld(undefined, 500_000_000);
    expect(other.state.rootId).not.toBe(plain.state.rootId);
    const aliases = (world: AreaWorld) =>
      areaGroupingInput(world.state).units.map((unit) => [
        unit.alias,
        clusterOf(world, unit.topicId)
      ]);
    expect(aliases(other)).toEqual(aliases(plain));
    expect(areaGroupingSignature(input)).toBe(areaGroupingSignature(areaGroupingInput(state)));
  });
});

describe("Areas: validation", () => {
  const world = areaWorld();
  const input = areaGroupingInput(world.state);
  const proposal = trueProposal(world, input);

  it("accepts every unit exactly once in the Area band", () => {
    const result = validateAreaProposal(input, proposal, config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.areaCount).toBe(8);
    expect(result.proposal.promoted).toEqual([]);
    expect(result.proposal.titleIssues).toEqual([]);
    const units = result.proposal.groups.flatMap((group) => group.units).sort();
    expect(units).toEqual(input.units.map((unit) => unit.topicId).sort());
  });

  it("refuses missing, duplicate and unknown topics and Areas", () => {
    const [first, second, ...rest] = proposal.areas as AreaProposal["areas"];
    const broken: AreaProposal = {
      areas: [
        { ...first!, members: [...first!.members.slice(1), "T999"] },
        { ...second!, members: [...second!.members, first!.members[1] as string] },
        { alias: "A7", members: [] },
        ...rest
      ]
    };
    const result = validateAreaProposal(input, broken, config);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    const codes = result.issues.map((issue) => issue.code).sort();
    expect(codes).toEqual(["duplicate-topic", "missing-topic", "unknown-area", "unknown-topic"]);
  });

  it("refuses an Area count outside the band and an Area above the hard fan-out", () => {
    const merged: AreaProposal = {
      areas: [
        {
          new: { title: "Tudo", description: "Everything." },
          members: input.units.map((u) => u.alias)
        }
      ]
    };
    const result = validateAreaProposal(input, merged, config);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.code).sort()).toEqual([
      "area-count",
      "area-too-large"
    ]);
    const empty = validateAreaProposal(
      input,
      {
        areas: [...proposal.areas, { new: { title: "Vazio", description: "None." }, members: [] }]
      },
      config
    );
    expect(empty.ok).toBe(false);
  });

  it("drops invalid titles and promotes an Area of one topic", () => {
    const areas = proposal.areas.map((area, index) =>
      "new" in area && index === 0
        ? { ...area, new: { title: "Miscellaneous", description: "x" } }
        : "new" in area && index === 1
          ? { ...area, new: { title: "T12", description: "y" } }
          : "new" in area && index === 2
            ? { ...area, new: { title: areaNames[3] as string, description: "z" } }
            : area
    );
    // Split one topic off group 4 into an Area of its own.
    const fourth = areas[4] as { new: { title: string; description: string }; members: string[] };
    const single = fourth.members.at(-1) as string;
    fourth.members = fourth.members.slice(0, -1);
    areas.push({ new: { title: "Sozinho", description: "Alone." }, members: [single] });
    const result = validateAreaProposal(input, { areas }, config);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.titleIssues.map((issue) => issue.code).sort()).toEqual([
      "title-generic",
      "title-identifier",
      "title-taken"
    ]);
    const unit = input.units.find((candidate) => candidate.alias === single)?.topicId;
    expect(result.proposal.promoted).toEqual([unit]);
    expect(result.proposal.areaCount).toBe(9);
  });
});

describe("Areas: the regroup", () => {
  it("applies a good grouping, keeps Area IDs by Jaccard and replays and undoes exactly", () => {
    const world = areaWorld((cluster) => (groupOfCluster(cluster) + (cluster % 2)) % 8);
    const before = cloneTopicTreeState(world.state);
    const beforeDump = canonicalStateDump(world.state);
    const input = areaGroupingInput(world.state);
    const result = regroup(world, valid(input, trueProposal(world, input)), input);
    expect(result.acceptance.accepted).toBe(true);
    expect(result.acceptance.silhouette.after).toBeGreaterThan(result.acceptance.silhouette.before);
    expect(result.protectedTouched).toBe(false);
    // Each true group shares half its topics with one current Area: all 8 IDs survive.
    expect(result.outcome.matched).toBe(8);
    expect(result.outcome.created).toEqual([]);
    expect(result.outcome.retired).toEqual([]);

    const { state } = world;
    for (const [cluster, leaf] of world.leafOf.entries()) {
      const area = levelOneTopic(state, leaf);
      expect(getTopic(state, area).title).toBe(areaNames[groupOfCluster(cluster)]);
      expect(getTopic(state, area).nameSource).toBe("llm");
      expect(getTopic(state, area).nameLanguage).toBe("pt-BR");
    }
    expect(checkInvariants(state, config, { areasActive: true }).hard).toBe(0);

    // The events replay onto the old tree and invert back to it.
    const replay = cloneTopicTreeState(before);
    assertUniqueTitlesAtEveryStep(replay, result.events);
    expect(canonicalStateDump(replay)).toBe(canonicalStateDump(state));
    applyEvents(replay, invertEvents(result.events));
    expect(canonicalStateDump(replay)).toBe(beforeDump);
  });

  it("creates and retires Areas, moving a retired Area's direct items to its successor", () => {
    const world = areaWorld();
    const { state } = world;
    // A direct item on the first Area.
    const item = world.keys[0] as ItemKey;
    createTopicTreeEditor(state, { record: false }).updatePlacement(item, 0, {
      topicId: world.areas[0] as string
    });
    recomputeSubtree(state, world.vectors);
    const input = areaGroupingInput(state);
    const proposal = trueProposal(world, input);
    // Six Areas only: two groups merge into others, so two current Areas retire.
    const areas = proposal.areas.slice(0, 6) as {
      new: { title: string; description: string };
      members: string[];
    }[];
    areas[0]!.members.push(...proposal.areas[6]!.members);
    areas[1]!.members.push(...proposal.areas[7]!.members);
    const sevenConfig = topicTreeConfigWith({ areas: { min: 6, target: 8, minLevel2Topics: 8 } });
    const checked = validateAreaProposal(input, { areas }, sevenConfig);
    expect(checked.ok).toBe(true);
    if (!checked.ok) return;
    const result = regroupAreas({
      state,
      vectors: world.vectors,
      config: sevenConfig,
      input,
      proposal: checked.proposal,
      seed: 3,
      now: fixtureNow,
      day: fixtureDay,
      newTopicId: world.newTopicId,
      changeSetId: fixtureUuid(9_000_001),
      contentLanguage: "pt-BR",
      reparent: false
    });
    expect(getTopic(state, state.rootId).children).toHaveLength(6);
    expect(result.outcome.retired.length + result.outcome.matched).toBe(8);
    for (const retired of result.outcome.retired) {
      const node = getTopic(state, retired);
      expect(isLive(node)).toBe(false);
      expect(node.redirectTo && isLive(getTopic(state, node.redirectTo))).toBe(true);
    }
    const area = primaryPlacement(state, item)?.topicId as string;
    expect(getTopic(state, area).parentId).toBe(state.rootId);
    expect(checkInvariants(state, sevenConfig, { areasActive: true }).hard).toBe(0);
  });

  it("rejects a grouping that lowers the level-2 silhouette", () => {
    const world = areaWorld((cluster) => groupOfCluster(cluster));
    const input = areaGroupingInput(world.state);
    // Rotate: cluster c goes with the clusters c+1 of other groups.
    const aliasOf = new Map(input.units.map((unit) => [unit.topicId, unit.alias]));
    const scrambled: AreaProposal = {
      areas: areaNames.map((title, area) => ({
        new: { title, description: "Mixed." },
        members: world.leafOf
          .filter((_, cluster) => cluster % 8 === area)
          .map((leaf) => aliasOf.get(leaf) as string)
      }))
    };
    const result = regroup(world, valid(input, scrambled), input);
    expect(result.acceptance.accepted).toBe(false);
    expect(result.acceptance.reasons).toContain("silhouette");
  });

  it("leaves a pinned Area untouched, and adding to it waits for review", () => {
    const world = areaWorld((cluster) => groupOfCluster(cluster));
    const { state } = world;
    const pinned = world.areas[0] as string;
    createTopicTreeEditor(state, { record: false }).manageTopic(pinned, "pinned");
    const pinnedBefore = JSON.stringify({
      ...getTopic(state, pinned),
      stats: undefined,
      control: undefined
    });
    const input = areaGroupingInput(state);
    const fixed = input.fixed[0];
    expect(fixed?.topicId).toBe(pinned);
    const units = input.units;
    // The other 28 topics regroup into 7 new Areas of 4; nothing joins the pinned Area.
    const proposal: AreaProposal = {
      areas: Array.from({ length: 7 }, (_, area) => ({
        new: { title: areaNames[area + 1] as string, description: "Area." },
        members: units.slice(area * 4, area * 4 + 4).map((unit) => unit.alias)
      }))
    };
    const untouched = regroup(world, valid(input, proposal), input);
    expect(untouched.protectedTouched).toBe(false);
    for (const event of untouched.events) expect(event.topicId).not.toBe(pinned);
    expect(
      JSON.stringify({ ...getTopic(state, pinned), stats: undefined, control: undefined })
    ).toBe(pinnedBefore);

    // Adding a topic to the pinned Area touches protected structure.
    const again = areaWorld((cluster) => groupOfCluster(cluster));
    createTopicTreeEditor(again.state, { record: false }).manageTopic(
      again.areas[0] as string,
      "pinned"
    );
    const input2 = areaGroupingInput(again.state);
    const [first, ...others] = input2.units;
    const adding: AreaProposal = {
      areas: [
        { alias: "A1", members: [first!.alias] },
        ...Array.from({ length: 7 }, (_, area) => ({
          new: { title: areaNames[area + 1] as string, description: "Area." },
          members: others.slice(area * 4, area * 4 + 4).map((unit) => unit.alias)
        })).filter((area) => area.members.length > 0)
      ]
    };
    const touched = regroup(again, valid(input2, adding), input2);
    expect(touched.protectedTouched).toBe(true);
  });

  it("keeps sibling titles unique at every step when titled topics swap Areas", () => {
    const world = areaWorld((cluster) => groupOfCluster(cluster));
    const { state } = world;
    // Two Areas each hold a topic called "Introdução"; the proposal swaps them, and a third one
    // joins one of them, where a sibling already has the name.
    const editor = createTopicTreeEditor(state, { record: false });
    const [a, b] = world.areas as [string, string];
    const inA = getTopic(state, a).children[0] as string;
    const inB = getTopic(state, b).children[0] as string;
    const extra = getTopic(state, b).children[1] as string;
    for (const id of [inA, inB]) {
      editor.renameTopic(id, { title: "Introdução", nameState: "named", nameSource: "llm" });
    }
    editor.renameTopic(extra, { title: "Introducao", nameState: "named", nameSource: "llm" });
    const before = cloneTopicTreeState(state);
    const input = areaGroupingInput(state);
    const aliasOf = new Map(input.units.map((unit) => [unit.topicId, unit.alias]));
    const membersOf = (area: string, swapOut: string, swapIn: string[]): string[] =>
      getTopic(state, area)
        .children.filter((child) => child !== swapOut && !swapIn.includes(child))
        .concat(swapIn)
        .map((id) => aliasOf.get(id) as string);
    const proposal: AreaProposal = {
      areas: world.areas.map((area, index) => ({
        new: { title: areaNames[index] as string, description: "Area." },
        members:
          area === a
            ? membersOf(a, inA, [inB, extra])
            : area === b
              ? membersOf(b, inB, [inA]).filter((alias) => alias !== aliasOf.get(extra))
              : membersOf(area, "", [])
      }))
    };
    const result = regroup(world, valid(input, proposal), input);
    expect(result.outcome.clearedTitles).toEqual([extra]);
    expect(getTopic(state, inA).title).toBe("Introdução");
    expect(getTopic(state, inB).title).toBe("Introdução");
    expect(getTopic(state, extra).title).toBeNull();
    assertUniqueTitlesAtEveryStep(before, result.events);
  });

  it("re-parents a mis-parented level-2 topic at the calibrated lambda", () => {
    const world = areaWorld((cluster) => groupOfCluster(cluster));
    const input = areaGroupingInput(world.state);
    const proposal = trueProposal(world, input);
    // Plant one topic in the wrong group.
    const [first, second] = proposal.areas as { new: unknown; members: string[] }[];
    const planted = first!.members.pop() as string;
    second!.members.push(planted);
    const defaults = topicTreeConfigWith({ areas: { minLevel2Topics: 8 } }, defaultTopicTreeConfig);
    expect(defaults.stability.churnWeight).toBe(6);
    const result = regroupAreas({
      state: world.state,
      vectors: world.vectors,
      config: defaults,
      input,
      proposal: valid(input, proposal),
      seed: 3,
      now: fixtureNow,
      day: fixtureDay,
      newTopicId: world.newTopicId,
      changeSetId: fixtureUuid(9_000_002),
      contentLanguage: "pt-BR"
    });
    const plantedId = input.units.find((unit) => unit.alias === planted)?.topicId as string;
    expect(result.reparented).toEqual([plantedId]);
    expect(result.misParented.after).toBeLessThan(result.misParented.before + 1);
    expect(result.acceptance.accepted).toBe(true);
  });
});

describe("Areas: acceptance", () => {
  const shape = (fields: Partial<AreaShape>): AreaShape => ({
    meanDepth: 3,
    fanOutInTarget: 0.85,
    internalTopics: 10,
    singleChildTopics: 0,
    areas: 9,
    ...fields
  });
  const judge = (before: AreaShape, after: AreaShape, silhouette = { before: 0.1, after: 0.1 }) =>
    judgeAreaRegroup(
      { silhouette, shape: { before, after }, hard: { before: new Set(), after: new Set() } },
      config
    );

  it("holds the E2 bars that held and does not let missed ones get worse", () => {
    expect(judge(shape({}), shape({ fanOutInTarget: 0.8 })).accepted).toBe(true);
    expect(judge(shape({}), shape({ fanOutInTarget: 0.79 })).reasons).toEqual(["fan-out"]);
    expect(judge(shape({ fanOutInTarget: 0.7 }), shape({ fanOutInTarget: 0.72 })).accepted).toBe(
      true
    );
    expect(judge(shape({ fanOutInTarget: 0.7 }), shape({ fanOutInTarget: 0.69 })).accepted).toBe(
      false
    );
    expect(judge(shape({ meanDepth: 4.4 }), shape({ meanDepth: 4.6 })).reasons).toEqual([
      "mean-depth"
    ]);
    expect(judge(shape({}), shape({ singleChildTopics: 1 })).reasons).toEqual(["single-child"]);
    expect(judge(shape({}), shape({ areas: 17 })).reasons).toEqual(["area-count"]);
  });

  it("accepts a silhouette within the tolerance", () => {
    const tolerance = config.areas.silhouetteTolerance;
    expect(judge(shape({}), shape({}), { before: 0.2, after: 0.2 - tolerance / 2 }).accepted).toBe(
      true
    );
    expect(
      judge(shape({}), shape({}), { before: 0.2, after: 0.2 - tolerance * 2 }).reasons
    ).toEqual(["silhouette"]);
  });

  it("scores separated groups near 1 and a singleton 0", () => {
    const world = areaWorld((cluster) => groupOfCluster(cluster));
    const points = silhouettePoints(world.state);
    expect(points).toHaveLength(32);
    const good = centroidSilhouette(world.state, points, (id) => levelOneTopic(world.state, id));
    const mixed = centroidSilhouette(world.state, points, (id) => String(points.indexOf(id) % 8));
    expect(good).toBeGreaterThan(0.3);
    expect(mixed).toBeLessThan(good);
    expect(centroidSilhouette(world.state, points, () => "one")).toBe(0);
    expect(areaShape(world.state, config)).toMatchObject({ areas: 8, singleChildTopics: 0 });
  });
});
