import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  identityGroupFor,
  promptDefinition,
  type CanonicalMatchingSettings,
  type KnowledgeGraphGenerationOutput
} from "@app/domain";
import type { PgPool } from "@app/db";

import type { DefaultAiTaskResult } from "./ai-service.js";
import { createEntityIdentityResolver } from "./entity-identity-resolution.js";
import { captureObjectEvents, type ObjectEventCapture } from "./object-events-fixture.js";
import { changedPromptIdentity } from "./prompt-runtime.js";
import {
  createRelationTypeResolver,
  type IdentityGroupRecord
} from "./relation-type-resolution.js";

// An in-memory catalog: commits keep the fingerprint keys, so a second resolver resumes from them.
const fake = vi.hoisted(() => {
  type Stored = {
    id: string;
    type: string;
    canonicalName: string;
    aliases: string[];
    identityDescription: string;
  };
  type Type = { id: string; predicate: string; definition: string };
  const state = {
    keys: new Map<string, string>(),
    entities: [] as Stored[],
    revision: 0,
    nextId: 0,
    aliases: new Map<string, Type>(),
    types: [] as Type[]
  };
  const uuid = () => `00000000-0000-4000-8000-${String(++state.nextId).padStart(12, "0")}`;
  const entities = {
    findResolved: async (fingerprints: string[]) =>
      new Map(
        fingerprints
          .filter((fingerprint) => state.keys.has(fingerprint))
          .map((fingerprint) => [fingerprint, state.keys.get(fingerprint)!])
      ),
    revision: async () => String(state.revision),
    missingVectors: async () => [],
    saveVector: async () => undefined,
    // A stored entity of the same type and name is a candidate.
    candidates: async (input: { type: string; names: string[] }) =>
      state.entities
        .filter(
          (entity) =>
            entity.type === input.type &&
            input.names.some((name) => name.toLowerCase() === entity.canonicalName.toLowerCase())
        )
        .map((entity) => ({ ...entity, score: 0.95 })),
    commit: vi.fn(
      async (
        decisions: Array<{
          key: string;
          fingerprint: string;
          type: string;
          canonicalName: string;
          identityDescription: string;
          target: { id: string } | { key: string } | null;
        }>,
        revision: string
      ) => {
        if (revision !== String(state.revision)) return null;
        const resolved = new Map<string, string>();
        for (const decision of decisions) {
          let entityId = decision.target
            ? "id" in decision.target
              ? decision.target.id
              : resolved.get(decision.target.key)
            : undefined;
          if (!entityId) {
            entityId = uuid();
            state.entities.push({
              id: entityId,
              type: decision.type,
              canonicalName: decision.canonicalName,
              aliases: [],
              identityDescription: decision.identityDescription
            });
          }
          if (state.keys.has(decision.fingerprint)) throw new Error("duplicate fingerprint");
          state.keys.set(decision.fingerprint, entityId);
          resolved.set(decision.key, entityId);
        }
        state.revision += 1;
        return resolved;
      }
    )
  };
  const types = {
    findExact: async (predicates: string[]) =>
      new Map(
        predicates
          .filter((predicate) => state.aliases.has(predicate))
          .map((predicate) => [predicate, state.aliases.get(predicate)!])
      ),
    revision: async () => state.aliases.size,
    missingVectors: async () => [],
    saveVector: async () => undefined,
    candidates: async () => state.types.map((type) => ({ ...type, score: 0.95 })),
    commit: vi.fn(
      async (
        decisions: Array<{
          predicate: string;
          definition: string;
          target: { id: string } | { predicate: string } | null;
        }>,
        revision: number
      ) => {
        if (revision !== state.aliases.size) return null;
        const resolved = new Map<string, Type>();
        for (const decision of decisions) {
          const target = decision.target;
          const type = target
            ? "id" in target
              ? state.types.find((stored) => stored.id === target.id)!
              : resolved.get(target.predicate)!
            : { id: uuid(), predicate: decision.predicate, definition: decision.definition };
          if (!target) state.types.push(type);
          state.aliases.set(decision.predicate, type);
          resolved.set(decision.predicate, type);
        }
        return resolved;
      }
    )
  };
  return { state, entities, types };
});
vi.mock("@app/db", async (original) => ({
  ...(await original<object>()),
  createEntityIdentityRepository: () => fake.entities,
  createRelationTypeRepository: () => fake.types
}));

const sourceItemId = "00000000-0000-4000-8000-0000000000aa";
const chunk = (index: number) =>
  `00000000-0000-4000-8000-1000000000${String(index).padStart(2, "0")}`;
const person = (
  key: string,
  name: string,
  batch: number
): KnowledgeGraphGenerationOutput["entities"][number] => ({
  key,
  type: "Person",
  canonicalName: name,
  aliases: [],
  identityDescription: `${name}, described in the supplied passage.`,
  confidence: 0.9,
  evidenceChunkIds: [chunk(batch)]
});
const relation = (
  predicate: string,
  batch: number
): KnowledgeGraphGenerationOutput["relations"][number] => ({
  subjectEntityKey: "e1",
  objectEntityKey: "e2",
  predicate,
  definition: `The subject ${predicate.replaceAll("_", " ")} the object.`,
  displayLabel: predicate,
  confidence: 0.9,
  evidenceChunkIds: [chunk(batch)]
});
/** `count` people over `batches` batches of equal size, named "Person 0".. in document order. */
const people = (count: number, batches: number): KnowledgeGraphGenerationOutput[] =>
  Array.from({ length: batches }, (_unused, batch) => ({
    entities: Array.from({ length: count / batches }, (_none, index) =>
      person(`e${index + 1}`, `Person ${batch * (count / batches) + index}`, batch)
    ),
    relations: []
  }));
/** Stores one entity per name, so every extracted person of that name has a candidate. */
const storePeople = (count: number) => {
  for (let index = 0; index < count; index++)
    fake.state.entities.push({
      id: `00000000-0000-4000-8000-2000000000${String(index).padStart(2, "0")}`,
      type: "Person",
      canonicalName: `Person ${index}`,
      aliases: [],
      identityDescription: `Person ${index}, stored before.`
    });
};

type Row = [string, string, string, string[]];
const rowsOf = (prompt: string): Row[] => JSON.parse(prompt.split("\n").at(-1)!).relations;
/** A writer that answers every row with `choose` (null: a new identity) and embeds by text. */
const writer = (
  choose: (row: Row) => string | null = () => null,
  fail?: (call: number) => boolean
) => {
  const dimensions = new Map<string, number>();
  let calls = 0;
  const runDefaultTask = vi.fn(
    async (task: string, input: string): Promise<DefaultAiTaskResult> => {
      const base = {
        providerId: "test",
        modelId: "model",
        runtime: "remote" as const,
        durationMs: 1,
        aiTaskRunId: "00000000-0000-4000-8000-0000000000ff",
        profileId: "00000000-0000-4000-8000-0000000000fe",
        outputLanguage: "en"
      };
      if (task === "embedding") {
        // A distinct axis per text: only a shared name makes an in-group candidate.
        if (!dimensions.has(input)) dimensions.set(input, dimensions.size % 256);
        const vector = Array<number>(256).fill(0);
        vector[dimensions.get(input)!] = 1;
        return { ...base, taskType: "embedding", output: vector, embeddingSpaceKey: "space" };
      }
      calls += 1;
      if (fail?.(calls)) throw new Error("provider_unavailable");
      return {
        ...base,
        taskType: "knowledge-graph-generation",
        output: { matches: rowsOf(input).map((row) => [row[0], choose(row)]) }
      };
    }
  );
  const generative = () =>
    runDefaultTask.mock.calls.filter(([task]) => task !== "embedding").map(([, input]) => input);
  return { runDefaultTask, generative };
};
const settings = (stored: Partial<CanonicalMatchingSettings> = {}) => ({
  relationTypeCandidateLimit: 3,
  entityCandidateLimit: 3,
  confirmationBatchSize: 12,
  confirmationMaxCharacters: 12_000,
  ...stored
});
const base = { pool: {} as PgPool, threshold: 0.92, language: "en", context: { sourceItemId } };

beforeEach(() => {
  fake.state.keys.clear();
  fake.state.entities.length = 0;
  fake.state.revision = 0;
  fake.state.nextId = 0;
  fake.state.aliases.clear();
  fake.state.types.length = 0;
  fake.entities.commit.mockClear();
  fake.types.commit.mockClear();
});

describe("entity identity grouped per source (F4 D20)", () => {
  it("asks a source's rows across its batches in remote groups of 24, whatever is stored", async () => {
    storePeople(30);
    const stored = settings({ confirmationBatchSize: 12, confirmationMaxCharacters: 12_000 });
    const ai = writer();
    const records: IdentityGroupRecord[] = [];
    await createEntityIdentityResolver({
      ...base,
      ai,
      settings: stored,
      group: identityGroupFor("remote", stored),
      traceGroup: async (record, run) => {
        records.push(record);
        return run();
      }
    })(people(30, 3));
    const prompts = ai.generative();
    expect(prompts.map((prompt) => rowsOf(prompt).length)).toEqual([24, 6]);
    // Rows follow the batches, then each entity's position.
    expect(rowsOf(prompts[0]!).map((row) => row[1])).toEqual(
      Array.from({ length: 24 }, (_unused, index) => `Person: Person ${index}`)
    );
    expect(
      records.map(({ rows, bound, maxRows, maxCharacters, kind }) => ({
        rows,
        bound,
        maxRows,
        maxCharacters,
        kind
      }))
    ).toEqual([
      { rows: 24, bound: "rows", maxRows: 24, maxCharacters: 24_000, kind: "entity_identity" },
      { rows: 6, bound: "end", maxRows: 24, maxCharacters: 24_000, kind: "entity_identity" }
    ]);
  });

  it("sizes local groups by the stored values, never above 12 rows and 12,000 characters", async () => {
    storePeople(30);
    expect(identityGroupFor("local", settings({ confirmationMaxCharacters: 24_000 }))).toEqual({
      maxRows: 12,
      maxCharacters: 12_000
    });
    const stored = settings({ confirmationBatchSize: 8 });
    const ai = writer();
    await createEntityIdentityResolver({
      ...base,
      ai,
      settings: stored,
      group: identityGroupFor("local", stored)
    })(people(30, 3));
    expect(ai.generative().map((prompt) => rowsOf(prompt).length)).toEqual([8, 8, 8, 6]);
  });

  it("closes a group at its character cap", async () => {
    storePeople(30);
    const ai = writer();
    const records: IdentityGroupRecord[] = [];
    await createEntityIdentityResolver({
      ...base,
      ai,
      settings: settings(),
      group: { maxRows: 24, maxCharacters: 2_500 },
      traceGroup: async (record, run) => {
        records.push(record);
        return run();
      }
    })(people(30, 3));
    const prompts = ai.generative();
    expect(prompts.length).toBeGreaterThan(2);
    for (const prompt of prompts) expect(prompt.length).toBeLessThanOrEqual(2_500);
    expect(records.slice(0, -1).every((record) => record.bound === "characters")).toBe(true);
    expect(records.at(-1)?.bound).toBe("end");
    expect(records.reduce((sum, record) => sum + record.rows, 0)).toBe(30);
  });

  it("namespaces keys per batch inside a group and keeps the model's key in the fingerprint", async () => {
    const batches: KnowledgeGraphGenerationOutput[] = [
      { entities: [person("e1", "Ada Lovelace", 0)], relations: [] },
      {
        entities: [person("e1", "Charles Babbage", 1), person("e2", "Ada Lovelace", 1)],
        relations: [
          { ...relation("worked_with", 1), subjectEntityKey: "e1", objectEntityKey: "e2" }
        ]
      }
    ];
    // The second Ada names the first (an in-group candidate); the writer confirms it.
    const ai = writer((row) => row[3][0] ?? null);
    const resolved = await createEntityIdentityResolver({
      ...base,
      ai,
      settings: settings(),
      group: identityGroupFor("remote", settings())
    })(batches);
    expect(ai.generative()).toHaveLength(1);
    const decisions = fake.entities.commit.mock.calls[0]![0];
    expect(decisions.map((decision) => decision.key)).toEqual(["b0:e1", "b1:e1", "b1:e2"]);
    expect(decisions[2]!.target).toEqual({ key: "b0:e1" });
    // The F3 formula, unchanged: the model's own key, no batch.
    const promptIdentity = changedPromptIdentity([
      "graph.entity_identity",
      "graph.entity_identity.repair"
    ]);
    const fingerprint = createHash("sha256")
      .update(
        JSON.stringify({
          sourceItemId,
          key: "e2",
          type: "Person",
          name: "Ada Lovelace",
          identityDescription: "Ada Lovelace, described in the supplied passage.",
          evidence: [chunk(1)],
          version: "entity-identity-resolution-v1",
          ...(promptIdentity ? { promptIdentity } : {})
        })
      )
      .digest("hex");
    expect(decisions[2]!.fingerprint).toBe(fingerprint);
    expect(resolved[1]!.entities[1]!.canonicalEntityId).toBe(
      resolved[0]!.entities[0]!.canonicalEntityId
    );
    expect(resolved[1]!.entities[0]!.canonicalEntityId).not.toBe(
      resolved[0]!.entities[0]!.canonicalEntityId
    );
    expect(resolved[1]!.relations).toHaveLength(1);
  });

  it("resumes after a crash between groups from the stored identity keys", async () => {
    storePeople(30);
    const group = identityGroupFor("remote", settings());
    const failing = writer(
      () => null,
      (call) => call === 2
    );
    await expect(
      createEntityIdentityResolver({ ...base, ai: failing, settings: settings(), group })(
        people(30, 3)
      )
    ).rejects.toThrow("provider_unavailable");
    expect(fake.state.keys.size).toBe(24);
    const retry = writer();
    const resolved = await createEntityIdentityResolver({
      ...base,
      ai: retry,
      settings: settings(),
      group
    })(people(30, 3));
    // Only the second group is asked again.
    expect(retry.generative().map((prompt) => rowsOf(prompt).map((row) => row[1]))).toEqual([
      Array.from({ length: 6 }, (_unused, index) => `Person: Person ${24 + index}`)
    ]);
    expect(
      resolved.flatMap((batch) => batch.entities).every((entity) => entity.canonicalEntityId)
    ).toBe(true);
  });

  it("keeps the pinned path per batch, in slices of 12 with the stored splits", async () => {
    storePeople(30);
    const ai = writer();
    await createEntityIdentityResolver({
      ...base,
      ai,
      pinned: true,
      settings: settings(),
      group: identityGroupFor("remote", settings())
    })(people(30, 3));
    expect(ai.generative().map((prompt) => rowsOf(prompt).length)).toEqual([10, 10, 10]);
  });

  describe("a recurring entity (FRREC 10-24)", () => {
    // One person in every batch of a source, stored before: each later row lists the earlier rows'
    // provisional identities, which read exactly like those rows.
    type Payload = { relations: Row[]; candidates: Array<[string, string, string]> };
    const payloadOf = (prompt: string) =>
      JSON.parse(prompt.split("\n").find((line) => line.startsWith('{"relations"'))!) as Payload;
    const recurring = (): KnowledgeGraphGenerationOutput[] => {
      fake.state.entities.push({
        id: "00000000-0000-4000-8000-2000000000ee",
        type: "Person",
        canonicalName: "Ebbinghaus",
        aliases: [],
        identityDescription: "Ebbinghaus, stored before."
      });
      return [0, 1, 2].map((batch) => ({
        entities: [
          {
            ...person("e1", "Ebbinghaus", batch),
            identityDescription: `Ebbinghaus, as batch ${batch} describes him.`
          }
        ],
        relations: []
      }));
    };
    /** A writer that names, for each row, a key of the call that reads exactly like the row. */
    const selfMatching = (lookAt: "candidates" | "everything") => {
      const ai = writer();
      const embedOrAnswer = ai.runDefaultTask.getMockImplementation()!;
      ai.runDefaultTask.mockImplementation(async (task: string, input: string) => {
        if (task === "embedding") return embedOrAnswer(task, input);
        const payload = payloadOf(input);
        const lines = new Map<string, readonly string[]>(
          payload.candidates.map((candidate) => [candidate[0], candidate])
        );
        if (lookAt === "everything")
          for (const [key, predicate, definition] of payload.relations)
            if (payload.relations.some(([other, , , own]) => other !== key && own.includes(key)))
              lines.set(key, [key, predicate, definition]);
        const matches = payload.relations.map(([key, predicate, definition, own]) => {
          const twin = [...lines.values()].find(
            ([candidate, text, meaning]) =>
              !own.includes(candidate!) && text === predicate && meaning === definition
          );
          return [key, twin ? twin[0] : (own[0] ?? null)];
        });
        return { output: { matches }, aiTaskRunId: `call-${matches.length}` } as never;
      });
      return ai;
    };
    const resolve = (ai: ReturnType<typeof writer>, pinned = false) =>
      createEntityIdentityResolver({
        ...base,
        ai,
        pinned,
        settings: settings(),
        group: identityGroupFor("remote", settings())
      })(recurring());
    const stored = "00000000-0000-4000-8000-2000000000ee";

    it("names an earlier row's provisional identity by its row key, so no call shows a twin", async () => {
      const ai = selfMatching("candidates");
      const resolved = await resolve(ai);
      const [prompt, ...others] = ai.generative();
      expect(others).toEqual([]);
      expect(payloadOf(prompt!)).toEqual({
        relations: [
          ["r1", "Person: Ebbinghaus", "Ebbinghaus, as batch 0 describes him.", ["c1"]],
          ["r2", "Person: Ebbinghaus", "Ebbinghaus, as batch 1 describes him.", ["c1", "r1"]],
          ["r3", "Person: Ebbinghaus", "Ebbinghaus, as batch 2 describes him.", ["c1", "r1", "r2"]]
        ],
        candidates: [["c1", "Person: Ebbinghaus", "Ebbinghaus, stored before."]]
      });
      expect(resolved.map((batch) => batch.entities[0]!.canonicalEntityId)).toEqual([
        stored,
        stored,
        stored
      ]);
    });

    it("resolves a row that names an earlier row's key to that row's identity", async () => {
      const ai = writer((row) => row[3].at(-1) ?? null);
      const resolved = await resolve(ai);
      expect(ai.generative()).toHaveLength(1);
      const decisions = fake.entities.commit.mock.calls[0]![0];
      expect(decisions.map((decision) => decision.target)).toEqual([
        { id: stored },
        { key: "b0:e1" },
        { key: "b1:e1" }
      ]);
      expect(new Set(resolved.map((batch) => batch.entities[0]!.canonicalEntityId))).toEqual(
        new Set([stored])
      );
    });

    it("repairs rows that name their own key in calls that keep each from it", async () => {
      // r1 and r2 answer with their own keys, which the later rows list: the repair asks them apart.
      const ai = selfMatching("everything");
      const resolved = await resolve(ai);
      const prompts = ai.generative();
      expect(prompts.map((prompt) => payloadOf(prompt).relations.map(([key]) => key))).toEqual([
        ["r1", "r2", "r3"],
        ["r1"],
        ["r2"]
      ]);
      // Alone, r2 still meets r1's identity, listed with its text since r1 is not asked.
      expect(payloadOf(prompts[2]!).candidates).toEqual([
        ["c1", "Person: Ebbinghaus", "Ebbinghaus, stored before."],
        ["r1", "Person: Ebbinghaus", "Ebbinghaus, as batch 0 describes him."]
      ]);
      expect(resolved.map((batch) => batch.entities[0]!.canonicalEntityId)).toEqual([
        stored,
        stored,
        stored
      ]);
    });

    it("keeps the recorded aliases on the pinned path", async () => {
      // Two mentions in one batch: pinned, the later row lists the earlier one's identity as c2, as
      // every recording did; unpinned, by its row key.
      const [first, second] = recurring();
      const batch = {
        entities: [first!.entities[0]!, { ...second!.entities[0]!, key: "e2" }],
        relations: []
      };
      const asked = async (pinned: boolean) => {
        // Each run starts from the stored person alone.
        fake.state.keys.clear();
        fake.state.entities.length = 1;
        const ai = writer();
        await createEntityIdentityResolver({
          ...base,
          ai,
          pinned,
          settings: settings(),
          group: identityGroupFor("remote", settings())
        })([batch]);
        return ai.generative().map((prompt) => payloadOf(prompt));
      };
      const stored = ["c1", "Person: Ebbinghaus", "Ebbinghaus, stored before."];
      const r1 = ["r1", "Person: Ebbinghaus", "Ebbinghaus, as batch 0 describes him."];
      const r2 = ["r2", "Person: Ebbinghaus", "Ebbinghaus, as batch 1 describes him."];
      expect(await asked(true)).toEqual([
        {
          relations: [
            [...r1, ["c1"]],
            [...r2, ["c1", "c2"]]
          ],
          candidates: [stored, ["c2", ...r1.slice(1)]]
        }
      ]);
      expect(await asked(false)).toEqual([
        {
          relations: [
            [...r1, ["c1"]],
            [...r2, ["c1", "r1"]]
          ],
          candidates: [stored]
        }
      ]);
    });
  });

  it("keeps an entity that recurs in more batches than its candidate places as one (X7G 10-24)", async () => {
    // Camilo in four batches, stored before: the earlier rows read closer to the fourth than the
    // stored entity does, so they take its three places and the stored Camilo is not its own.
    const stored = "00000000-0000-4000-8000-2000000000dd";
    fake.state.entities.push({
      id: stored,
      type: "Person",
      canonicalName: "Camilo",
      aliases: [],
      identityDescription: "Camilo, stored before."
    });
    const batches = [0, 1, 2, 3].map((batch) => ({
      entities: [
        { ...person("e1", "Camilo", batch), identityDescription: `Camilo in batch ${batch}.` }
      ],
      relations: []
    }));
    type Payload = { relations: Row[]; candidates: Array<[string, string, string]> };
    const payloadOf = (prompt: string) =>
      JSON.parse(prompt.split("\n").find((line) => line.startsWith('{"relations"'))!) as Payload;
    const ai = writer();
    ai.runDefaultTask.mockImplementation(async (task: string, input: string) => {
      const run = {
        providerId: "test",
        modelId: "model",
        runtime: "remote" as const,
        durationMs: 1,
        aiTaskRunId: "00000000-0000-4000-8000-0000000000ff",
        profileId: "00000000-0000-4000-8000-0000000000fe",
        outputLanguage: "en"
      };
      if (task === "embedding") {
        // The four extracted rows read alike; the stored entity lies elsewhere (score 0.95).
        const vector = Array<number>(256).fill(0);
        vector[input.includes("batch") ? 0 : 1] = 1;
        const embedding: DefaultAiTaskResult = {
          ...run,
          taskType: "embedding",
          output: vector,
          embeddingSpaceKey: "space"
        };
        return embedding;
      }
      // Codex's answer: the stored Camilo for every row, whenever the call lists it.
      const payload = payloadOf(input);
      const listed = payload.candidates.some(([key]) => key === "c1");
      const matches = payload.relations.map(([key]) => [key, listed ? "c1" : null]);
      return { ...run, output: { matches } } as never;
    });
    const resolved = await createEntityIdentityResolver({
      ...base,
      ai,
      settings: settings(),
      group: identityGroupFor("remote", settings())
    })(batches);
    const [prompt, ...repairs] = ai.generative();
    expect(payloadOf(prompt!).relations.at(-1)).toEqual([
      "r4",
      "Person: Camilo",
      "Camilo in batch 3.",
      ["r1", "r2", "r3"]
    ]);
    // Before, r4's c1 was refused and its repair, which lists no stored candidate, made a new one.
    expect(repairs).toEqual([]);
    expect(resolved.map((batch) => batch.entities[0]!.canonicalEntityId)).toEqual([
      stored,
      stored,
      stored,
      stored
    ]);
  });

  it("decides a repeated fingerprint once and keeps what a stored checkpoint already resolved", async () => {
    const stored = "00000000-0000-4000-8000-0000000000cc";
    const batches: KnowledgeGraphGenerationOutput[] = [
      { entities: [person("e1", "Ada Lovelace", 0)], relations: [] },
      { entities: [person("e1", "Ada Lovelace", 0)], relations: [] },
      {
        entities: [{ ...person("e1", "Grace Hopper", 2), canonicalEntityId: stored }],
        relations: []
      }
    ];
    const ai = writer();
    const resolved = await createEntityIdentityResolver({
      ...base,
      ai,
      settings: settings(),
      group: identityGroupFor("remote", settings())
    })(batches);
    expect(ai.generative()).toHaveLength(0);
    expect(fake.entities.commit.mock.calls[0]![0]).toHaveLength(1);
    expect(resolved[1]!.entities[0]!.canonicalEntityId).toBe(
      resolved[0]!.entities[0]!.canonicalEntityId
    );
    expect(resolved[2]!.entities[0]!.canonicalEntityId).toBe(stored);
  });
});

describe("entity identity announces its commits (F5 T114)", () => {
  let capture: ObjectEventCapture;
  beforeEach(() => {
    capture = captureObjectEvents();
  });
  afterEach(() => capture.stop());

  it("announces a created entity and an existing one that gained aliases, after the group commits", async () => {
    storePeople(1);
    // Person 0 has a stored candidate and the model confirms it; Person 7 has none.
    const ai = writer((row) => row[3][0] ?? null);
    const resolved = await createEntityIdentityResolver({
      ...base,
      ai,
      settings: settings(),
      group: { maxRows: 24, maxCharacters: 24_000 }
    })([
      {
        entities: [person("e1", "Person 0", 0), person("e2", "Person 7", 0)],
        relations: []
      }
    ]);
    const [existing, created] = resolved[0]!.entities.map((entity) => entity.canonicalEntityId!);
    expect(existing).toBe("00000000-0000-4000-8000-200000000000");
    expect(capture.refs()).toEqual([
      { kind: "entity", id: existing, change: "updated" },
      { kind: "entity", id: created, change: "created" }
    ]);
  });

  it("announces nothing when the catalog moved under the group and the commit was refused", async () => {
    // The resolver tries a group three times before it gives up on a moving catalog.
    fake.entities.commit.mockResolvedValueOnce(null).mockResolvedValueOnce(null);
    fake.entities.commit.mockResolvedValueOnce(null);
    await expect(
      createEntityIdentityResolver({
        ...base,
        ai: writer(),
        settings: settings(),
        group: { maxRows: 24, maxCharacters: 24_000 }
      })(people(2, 1))
    ).rejects.toThrow("errors.entityIdentity.catalogChanged");
    expect(capture.events).toEqual([]);
  });

  it("announces nothing for a group that did not commit because a provider call failed", async () => {
    storePeople(2);
    await expect(
      createEntityIdentityResolver({
        ...base,
        ai: writer(
          () => null,
          () => true
        ),
        settings: settings(),
        group: { maxRows: 24, maxCharacters: 24_000 }
      })(people(2, 1))
    ).rejects.toThrow("provider_unavailable");
    expect(capture.events).toEqual([]);
  });
});

describe("relation types grouped per source (F4 D20)", () => {
  const batches = (): KnowledgeGraphGenerationOutput[] => [
    { entities: [], relations: [relation("employed_by", 0)] },
    { entities: [], relations: [relation("works_for", 1), relation("employed_by", 1)] }
  ];
  beforeEach(() => {
    fake.state.types.push({
      id: "00000000-0000-4000-8000-3000000000aa",
      predicate: "works_at",
      definition: "The subject works at the object."
    });
  });

  it("asks a source's new predicates in one group across its batches", async () => {
    const ai = writer();
    const resolved = await createRelationTypeResolver({
      ...base,
      ai,
      settings: settings(),
      group: identityGroupFor("remote", settings())
    })(batches());
    expect(ai.generative().map((prompt) => rowsOf(prompt).map((row) => row[1]))).toEqual([
      ["employed_by", "works_for"]
    ]);
    expect(resolved.flatMap((batch) => batch.relations).every((item) => item.relationTypeId)).toBe(
      true
    );
    expect(resolved[1]!.relations[1]!.relationTypeId).toBe(
      resolved[0]!.relations[0]!.relationTypeId
    );
  });

  it("names an earlier row's new predicate by its row key", async () => {
    // `hired_by` embeds like `employed_by`, so its row lists that row's provisional type; the writer
    // makes `employed_by` a new type and folds `hired_by` into it.
    const ai = writer((row) => (row[0] === "r1" ? null : (row[3][0] ?? null)));
    const embedOrAnswer = ai.runDefaultTask.getMockImplementation()!;
    ai.runDefaultTask.mockImplementation(async (task: string, input: string) =>
      embedOrAnswer(
        task,
        task === "embedding" ? input.replaceAll("hired by", "employed by") : input
      )
    );
    const resolved = await createRelationTypeResolver({
      ...base,
      ai,
      settings: settings(),
      group: identityGroupFor("remote", settings())
    })([
      { entities: [], relations: [relation("employed_by", 0)] },
      { entities: [], relations: [relation("hired_by", 1)] }
    ]);
    const [prompt, ...others] = ai.generative();
    expect(others).toEqual([]);
    const payload = JSON.parse(prompt!.split("\n").at(-1)!) as {
      relations: Row[];
      candidates: string[][];
    };
    expect(payload.relations.map(([key, , , own]) => [key, own])).toEqual([
      ["r1", ["c1"]],
      ["r2", ["r1", "c1"]]
    ]);
    expect(payload.candidates.map(([key, predicate]) => [key, predicate])).toEqual([
      ["c1", "works_at"]
    ]);
    expect(resolved[1]!.relations[0]!.relationTypeId).toBe(
      resolved[0]!.relations[0]!.relationTypeId
    );
    expect(resolved[0]!.relations[0]!.relationTypeId).not.toBe(
      "00000000-0000-4000-8000-3000000000aa"
    );
  });

  it("keeps the pinned path per batch", async () => {
    const ai = writer();
    await createRelationTypeResolver({ ...base, ai, pinned: true, settings: settings() })(
      batches()
    );
    expect(ai.generative().map((prompt) => rowsOf(prompt).map((row) => row[1]))).toEqual([
      ["employed_by"],
      ["works_for"]
    ]);
  });
});

it("leaves the identity templates byte-identical (stored identity keys stay valid)", () => {
  const body = (id: string) =>
    createHash("sha256")
      .update(promptDefinition(id).fields.find((field) => field.id === "body")!.template)
      .digest("hex");
  expect({
    entity: body("graph.entity_identity"),
    entityRepair: body("graph.entity_identity.repair"),
    relation: body("graph.relation_identity"),
    relationRepair: body("graph.relation_identity.repair")
  }).toEqual({
    entity: "64eb8a8d0b4c159f708dd560f3628a6a3ca4a25ecb1a92c961276204bf93a76a",
    entityRepair: "b81e2afb30031e45e68e85d37212c84f8f79c228a02b1acfe0bd43e6f4f7f838",
    relation: "bc666cf65972b74aef1c83080f416f288de813772c9da6eb6558883b819a7579",
    relationRepair: "1355ca68eae5753577d1ee5fa166e2a3ce8079e467b7ae7c2b0c07d78463a908"
  });
});
