import { aiRouteKeys, type JsonObject } from "@app/db";
import { generativeDecideOperations } from "@app/domain";
import { describe, expect, it } from "vitest";

import {
  applyRouteMappingPlan,
  classMapSettingKey,
  describeEffectiveRoutes,
  effectiveRouteChanges,
  legacyOperationKeys,
  legacyOperations,
  mapLegacyRoutesV1,
  planLegacyRouteMapping,
  resolveRoute,
  type ClassMapState,
  type RouteMappingFacts,
  type RouteMappingPlan,
  type RouteMappingProfile,
  type RouteMappingStore
} from "./ai-route-mapping.js";

const generative = ["text-generation", "structured-output", "summarization"];
const ranker = ["reranking", "offline", "local-files"];

function profile(name: string, overrides: Partial<RouteMappingProfile> = {}): RouteMappingProfile {
  return {
    id: name,
    status: "active",
    isDefault: false,
    modelId: `${name}-model`,
    capabilities: generative,
    providerConfigId: `${name}-provider`,
    localModelId: null,
    ...overrides
  };
}
const localRanker = (name: string) =>
  profile(name, { capabilities: ranker, providerConfigId: null, localModelId: `${name}-local` });

/** Facts from profiles, route keys to profile ids and per-(profile,key) parameters. */
function facts(
  profiles: RouteMappingProfile[],
  routes: Record<string, string>,
  parameters: Record<string, JsonObject> = {}
): RouteMappingFacts {
  return {
    profiles,
    routes: Object.entries(routes).map(([task, profileId]) => ({ task, profileId })),
    profileTasks: Object.entries(routes).map(([task, profileId]) => ({
      profileId,
      task,
      parameters: parameters[`${profileId}:${task}`] ?? {}
    }))
  };
}

const oneWriter = () =>
  facts([profile("W", { isDefault: true }), profile("E"), localRanker("R")], {
    embedding: "E",
    summarization: "W",
    "text-generation": "W",
    "structured-output": "W",
    "knowledge-graph-generation": "W",
    "atomic-note-generation": "W",
    reranking: "W",
    "class:write-fast": "W",
    "class:decide": "R"
  });
const splitWriters = () =>
  facts(["S", "T", "O", "K", "N", "G", "E"].map((name) => profile(name)).concat(localRanker("R")), {
    embedding: "E",
    summarization: "S",
    "text-generation": "T",
    "structured-output": "O",
    "knowledge-graph-generation": "K",
    "atomic-note-generation": "N",
    reranking: "G",
    "class:decide": "R"
  });
const f2ClassDiffers = () =>
  facts(["S", "O", "X", "K", "N", "E"].map((name) => profile(name)).concat(localRanker("R")), {
    embedding: "E",
    summarization: "S",
    "structured-output": "O",
    "knowledge-graph-generation": "K",
    "atomic-note-generation": "N",
    reranking: "S",
    "class:write-fast": "X",
    "class:decide": "R"
  });
const e6 = () =>
  facts(
    [
      profile("local", { providerConfigId: null, localModelId: "local-model" }),
      profile("E", { providerConfigId: null, localModelId: "embed-model" })
    ],
    {
      embedding: "E",
      summarization: "local",
      "text-generation": "local",
      "structured-output": "local",
      "knowledge-graph-generation": "local",
      "atomic-note-generation": "local",
      reranking: "local"
    }
  );
const withParameters = () =>
  facts(
    [profile("W", { isDefault: true }), profile("E")],
    {
      embedding: "E",
      summarization: "W",
      "text-generation": "W",
      "structured-output": "W",
      "knowledge-graph-generation": "W",
      "atomic-note-generation": "W",
      reranking: "W"
    },
    {
      "W:summarization": { temperature: 0.2 },
      "W:structured-output": { reasoningLevel: "off" },
      "W:knowledge-graph-generation": { maxTokens: 4000 },
      "W:atomic-note-generation": { temperature: 0 },
      "W:text-generation": { reasoningLevel: "off", maxTokens: 400 }
    }
  );
const partiallyRouted = () =>
  facts([profile("W", { isDefault: true }), profile("E")], {
    embedding: "E",
    summarization: "W"
  });
const rankerOnReranking = () =>
  facts([profile("W"), localRanker("R")], {
    summarization: "W",
    "structured-output": "W",
    reranking: "R",
    "class:decide": "R"
  });
const inactiveWriter = () =>
  facts([profile("W", { status: "inactive" }), profile("S")], {
    summarization: "S",
    "text-generation": "W",
    "atomic-note-generation": "W"
  });

const shapes: Array<[string, () => RouteMappingFacts]> = [
  ["one writer for every task", oneWriter],
  ["a different profile per task", splitWriters],
  ["an F2 class:write-fast that differs from summarization", f2ClassDiffers],
  ["E6: a local writer on every task and no ranker", e6],
  ["task parameters", withParameters],
  ["only some tasks routed", partiallyRouted],
  ["a ranker on the reranking route", rankerOnReranking],
  ["an inactive profile on routes", inactiveWriter]
];

function mapped(source: RouteMappingFacts): {
  plan: RouteMappingPlan;
  after: RouteMappingFacts;
} {
  const plan = planLegacyRouteMapping(source);
  return { plan, after: applyRouteMappingPlan(source, plan) };
}

describe("mapLegacyRoutesV1 keeps every effective model", () => {
  it.each(shapes)("%s", (_name, shape) => {
    const before = shape();
    const { after } = mapped(before);
    expect(
      effectiveRouteChanges(
        describeEffectiveRoutes(before, "legacy"),
        describeEffectiveRoutes(after, "classed")
      )
    ).toEqual([]);
  });

  it("would catch a mapping without its operation overrides", () => {
    const before = splitWriters();
    const plan = planLegacyRouteMapping(before);
    expect(plan.operationRoutes.length).toBeGreaterThan(0);
    const withoutOverrides = applyRouteMappingPlan(before, { ...plan, operationRoutes: [] });
    expect(
      effectiveRouteChanges(
        describeEffectiveRoutes(before, "legacy"),
        describeEffectiveRoutes(withoutOverrides, "classed")
      ).map((change) => change.operation)
    ).toEqual(expect.arrayContaining(["graph_atomic_notes", "relation_explanation"]));
  });

  it("is idempotent: a second run writes nothing", () => {
    for (const [, shape] of shapes) {
      const first = mapped(shape());
      expect(planLegacyRouteMapping(first.after)).toEqual({
        classRoutes: [],
        operationRoutes: []
      });
    }
  });
});

describe("the class routes", () => {
  it("fills each class from its legacy task and never writes class:decide", () => {
    const { plan } = mapped(splitWriters());
    const byKey = Object.fromEntries(plan.classRoutes.map((route) => [route.key, route]));
    expect(byKey["class:embed"]).toMatchObject({ profileId: "E", from: "embedding" });
    expect(byKey["class:write-fast"]).toMatchObject({ profileId: "S", from: "summarization" });
    expect(byKey["class:write-quality"]).toMatchObject({
      profileId: "N",
      from: "atomic-note-generation"
    });
    expect(byKey["class:answer"]).toMatchObject({ profileId: "T", from: "text-generation" });
    expect(plan.classRoutes.map((route) => route.key)).not.toContain("class:decide");
    expect(plan.operationRoutes.map((route) => route.key)).not.toContain("class:decide");
  });

  it("takes write-fast from structured-output when summarization is not routed", () => {
    const { plan } = mapped(
      facts([profile("O"), profile("E")], { embedding: "E", "structured-output": "O" })
    );
    expect(plan.classRoutes.find((route) => route.key === "class:write-fast")).toMatchObject({
      profileId: "O",
      from: "structured-output"
    });
  });

  it("never overwrites a class route that is set", () => {
    const source = f2ClassDiffers();
    const { plan, after } = mapped(source);
    expect(plan.classRoutes.map((route) => route.key)).not.toContain("class:write-fast");
    expect(after.routes.find((route) => route.task === "class:write-fast")?.profileId).toBe("X");
    expect(after.routes.find((route) => route.task === "class:decide")?.profileId).toBe("R");
  });

  it("copies the parameters of the legacy route to the class route's profile task", () => {
    const { plan, after } = mapped(withParameters());
    expect(plan.classRoutes.find((route) => route.key === "class:write-fast")?.parameters).toEqual({
      temperature: 0.2
    });
    expect(
      after.profileTasks.find((entry) => entry.profileId === "W" && entry.task === "class:answer")
        ?.parameters
    ).toEqual({ reasoningLevel: "off", maxTokens: 400 });
  });

  it("leaves a class unrouted when no usable legacy route exists", () => {
    const { plan } = mapped(inactiveWriter());
    const keys = plan.classRoutes.map((route) => route.key);
    expect(keys).toContain("class:write-fast");
    expect(keys).not.toContain("class:answer");
    expect(keys).not.toContain("class:write-quality");
  });

  it("skips a class the person released", () => {
    const plan = planLegacyRouteMapping(splitWriters(), ["write-quality", "answer"]);
    const keys = [...plan.classRoutes, ...plan.operationRoutes].map((route) => route.key);
    expect(keys).not.toContain("class:write-quality");
    expect(keys).not.toContain("class:answer");
    expect(keys).not.toContain("op:graph_source_chunks");
    expect(keys).not.toContain("op:atomic_note_generation");
    expect(keys).not.toContain("op:wiki-consultation");
    expect(keys).toContain("class:embed");
  });
});

describe("the operation overrides", () => {
  it("pin an operation whose task route differs from its class route", () => {
    const { plan, after } = mapped(splitWriters());
    const byKey = Object.fromEntries(plan.operationRoutes.map((route) => [route.key, route]));
    // Knowledge graph (K) differs from write-quality (N, atomic notes); explanations (T) from
    // write-fast (S, summaries); the topic callers ran on class:write-fast before, so only a
    // structured-output route that differs from it matters; Ask ran on structured-output (O).
    expect(byKey["op:graph_atomic_notes"]).toMatchObject({ profileId: "K" });
    expect(byKey["op:entity_identity_resolution"]).toMatchObject({ profileId: "K" });
    expect(byKey["op:relation_explanation"]).toMatchObject({ profileId: "T" });
    expect(byKey["op:source_relation_explanation"]).toMatchObject({ profileId: "T" });
    expect(byKey["op:wiki-consultation"]).toMatchObject({ profileId: "O" });
    expect(byKey["op:topic_name"]).toMatchObject({ profileId: "O" });
    expect(byKey["op:summary"]).toBeUndefined();
    expect(byKey["op:atomic_note_generation"]).toBeUndefined();
    expect(
      resolveRoute(after, ["op:topic_name", "class:write-fast", "structured-output"], "x")
    ).toMatchObject({ profileId: "O" });
  });

  it("write nothing when one writer serves every task", () => {
    const { plan } = mapped(oneWriter());
    expect(plan.classRoutes.map((route) => route.key).toSorted()).toEqual([
      "class:answer",
      "class:embed",
      "class:write-quality"
    ]);
    expect(plan.operationRoutes.map((route) => route.key).toSorted()).toEqual(
      generativeDecideOperations.map((operation) => `op:${operation}`).toSorted()
    );
  });

  it("keep the F2 topic callers on the class route they already used", () => {
    const { plan } = mapped(f2ClassDiffers());
    const keys = plan.operationRoutes.map((route) => route.key);
    // class:write-fast is X: the topic callers (structured-output, classed before) stay on X, but
    // summaries and the other write-fast operations of unclassed tasks keep their own models.
    expect(keys).not.toContain("op:topic_name");
    expect(keys).toContain("op:summary");
    expect(plan.operationRoutes.find((route) => route.key === "op:summary")).toMatchObject({
      profileId: "S"
    });
  });

  it("keep the parameters of the legacy route when only the parameters differ", () => {
    const { plan } = mapped(withParameters());
    const topic = plan.operationRoutes.find((route) => route.key === "op:topic_name");
    expect(topic).toMatchObject({ profileId: "W", parameters: { reasoningLevel: "off" } });
  });

  it("never overwrite an operation route that is set", () => {
    const source = splitWriters();
    const withOverride = {
      ...source,
      routes: [...source.routes, { task: "op:graph_atomic_notes", profileId: "S" }],
      profileTasks: [
        ...source.profileTasks,
        { profileId: "S", task: "op:graph_atomic_notes", parameters: {} }
      ]
    };
    const plan = planLegacyRouteMapping(withOverride);
    expect(plan.operationRoutes.map((route) => route.key)).not.toContain("op:graph_atomic_notes");
  });

  it("are listed per class for a preset to release", () => {
    expect(legacyOperationKeys(["answer"])).toEqual(["op:wiki-consultation"]);
    expect(legacyOperationKeys(["decide", "embed"])).toEqual([]);
    expect(legacyOperationKeys(["write-quality"])).toContain("op:graph_catalog_metadata_repair");
  });
});

describe("the generative-decide operations (D16, R5)", () => {
  const keys = generativeDecideOperations.map((operation) => `op:${operation}`);

  it("are written from the reranking route when it holds a generative model", () => {
    for (const [, shape] of shapes) {
      const source = shape();
      const reranking = source.routes.find((route) => route.task === "reranking");
      const holder = source.profiles.find((candidate) => candidate.id === reranking?.profileId);
      const { plan } = mapped(source);
      const written = plan.operationRoutes.map((route) => route.key);
      if (holder && holder.status === "active" && holder.providerConfigId !== null)
        expect(written).toEqual(expect.arrayContaining(keys));
    }
    const { plan } = mapped(splitWriters());
    for (const key of keys)
      expect(plan.operationRoutes.find((route) => route.key === key)).toMatchObject({
        profileId: "G",
        from: "reranking"
      });
  });

  it("include the escalation operation although nothing calls it yet", () => {
    expect(keys).toContain("op:relation_escalation");
    expect(mapped(e6()).plan.operationRoutes.map((route) => route.key)).toContain(
      "op:relation_escalation"
    );
  });

  it("stay unset when the reranking route holds a dedicated ranker or is not routed", () => {
    for (const shape of [rankerOnReranking, partiallyRouted]) {
      const written = mapped(shape()).plan.operationRoutes.map((route) => route.key);
      for (const key of keys) expect(written).not.toContain(key);
    }
  });

  it("resolve the generative writer while class:decide holds the ranker", () => {
    const { after } = mapped(oneWriter());
    for (const key of keys)
      expect(resolveRoute(after, [key, "class:decide", "reranking"], "reranking")).toMatchObject({
        profileId: "W",
        key
      });
    expect(
      resolveRoute(after, ["op:topic_gate", "class:decide", "reranking"], "reranking")
    ).toMatchObject({ profileId: "R", key: "class:decide" });
  });

  it("fail visibly rather than reach the ranker when no writer is routed", () => {
    const { after } = mapped(rankerOnReranking());
    // Unset, so the key falls through to class:decide, a ranker that cannot run the contract.
    expect(
      resolveRoute(after, ["op:note_matching_reranking", "class:decide", "reranking"], "reranking")
    ).toMatchObject({ profileId: "R", key: "class:decide" });
    expect(
      after.routes.find((route) => route.task === "op:note_matching_reranking")
    ).toBeUndefined();
  });
});

describe("the route order", () => {
  it("stays operation, then the stated class, then the task", () => {
    expect(
      aiRouteKeys("structured-output", { operation: "topic_name", workloadClass: "write-fast" })
    ).toEqual(["op:topic_name", "class:write-fast", "structured-output"]);
    expect(aiRouteKeys("structured-output", { operation: "topic_name" })).toEqual([
      "op:topic_name",
      "structured-output"
    ]);
    expect(aiRouteKeys("embedding", { workloadClass: "embed" })).toEqual([
      "class:embed",
      "embedding"
    ]);
    expect(aiRouteKeys("reranking")).toEqual(["reranking"]);
  });
});

describe("the legacy operation table", () => {
  it("names each operation once, with a class that suits its task", () => {
    const names = legacyOperations.map((entry) => entry.operation);
    expect(new Set(names).size).toBe(names.length);
    for (const entry of legacyOperations) {
      if (entry.task === "reranking") expect(entry.class).toBe("decide");
      if (entry.task === "knowledge-graph-generation" || entry.task === "atomic-note-generation")
        expect(entry.class).toBe("write-quality");
      if (entry.task === "summarization") expect(entry.class).toBe("write-fast");
      expect(entry.task).not.toBe("embedding");
    }
  });
});

describe("mapLegacyRoutesV1 on a store", () => {
  function memoryStore(source: RouteMappingFacts, stored: ClassMapState | null = null) {
    let current = source;
    let state = stored;
    const writes: RouteMappingPlan[] = [];
    const store: RouteMappingStore = {
      read: async () => ({ facts: current, state }),
      write: async (plan, next) => {
        writes.push(plan);
        current = applyRouteMappingPlan(current, plan);
        state = next;
      }
    };
    return { store, writes, facts: () => current, state: () => state };
  }
  const at = () => new Date("2026-10-17T10:00:00.000Z");

  it("writes the plan and records the keys it wrote", async () => {
    const memory = memoryStore(splitWriters());
    const result = await mapLegacyRoutesV1(memory.store, at);
    expect(result.classRoutes).toEqual(
      expect.arrayContaining(["class:embed", "class:write-fast", "class:write-quality"])
    );
    expect(memory.state()).toMatchObject({
      version: 1,
      mappedAt: "2026-10-17T10:00:00.000Z",
      classRoutes: result.classRoutes,
      operationRoutes: result.operationRoutes,
      releasedClasses: []
    });
    expect(classMapSettingKey).toBe("ai.routes.classMap.v1");
  });

  it("writes nothing the second time and keeps its record", async () => {
    const memory = memoryStore(splitWriters());
    await mapLegacyRoutesV1(memory.store, at);
    const recorded = memory.state();
    const again = await mapLegacyRoutesV1(memory.store, () => new Date("2027-01-01T00:00:00Z"));
    expect(again).toEqual({ classRoutes: [], operationRoutes: [] });
    expect(memory.writes).toHaveLength(1);
    expect(memory.state()).toEqual(recorded);
  });

  it("merges what a later run writes into the record", async () => {
    const memory = memoryStore(partiallyRouted());
    const first = await mapLegacyRoutesV1(memory.store, at);
    expect(first.classRoutes).toEqual(expect.arrayContaining(["class:embed", "class:write-fast"]));
    // A profile is added later: the answer task now has a route.
    const grown = memory.facts();
    const store = memoryStore(
      {
        ...grown,
        routes: [...grown.routes, { task: "text-generation", profileId: "W" }],
        profileTasks: [
          ...grown.profileTasks,
          { profileId: "W", task: "text-generation", parameters: {} }
        ]
      },
      memory.state()
    );
    const second = await mapLegacyRoutesV1(store.store, at);
    expect(second.classRoutes).toEqual(["class:answer"]);
    expect(store.state()?.classRoutes).toEqual(
      expect.arrayContaining([...first.classRoutes, "class:answer"])
    );
  });

  it("leaves a released class alone", async () => {
    const state: ClassMapState = {
      version: 1,
      mappedAt: at().toISOString(),
      classRoutes: [],
      operationRoutes: [],
      releasedClasses: ["embed", "write-fast", "write-quality", "answer", "decide"]
    };
    const memory = memoryStore(splitWriters(), state);
    expect(await mapLegacyRoutesV1(memory.store, at)).toEqual({
      classRoutes: [],
      operationRoutes: []
    });
    expect(memory.writes).toHaveLength(0);
  });
});
