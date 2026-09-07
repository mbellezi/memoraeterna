import { beforeEach, describe, expect, it, vi } from "vitest";
import type { KnowledgeGraphGenerationOutput } from "@app/domain";
import type { PgPool } from "@app/db";
import { createRelationTypeResolver, parseRelationMatches, buildRelationMatchPrompt } from "./relation-type-resolution.js";
import { createEntityIdentityResolver } from "./entity-identity-resolution.js";
import type { DefaultAiTaskResult } from "./ai-service.js";

const mocks = vi.hoisted(() => ({
  types: { findExact: vi.fn(), revision: vi.fn(), missingVectors: vi.fn(), saveVector: vi.fn(), candidates: vi.fn(), commit: vi.fn() },
  entities: { findResolved: vi.fn(), revision: vi.fn(), missingVectors: vi.fn(), saveVector: vi.fn(), candidates: vi.fn(), commit: vi.fn() }
}));
vi.mock("@app/db", async (original) => ({ ...await original<object>(),
  createRelationTypeRepository: () => mocks.types, createEntityIdentityRepository: () => mocks.entities }));
const id = "00000000-0000-4000-8000-000000000001";
const otherId = "00000000-0000-4000-8000-000000000002";
const vector = [1, ...Array<number>(255).fill(0)];
const result = (output: unknown): DefaultAiTaskResult => ({ taskType: "embedding", output, providerId: "local", modelId: "model", runtime: "local", durationMs: 1,
  aiTaskRunId: id, profileId: id, outputLanguage: "en", embeddingSpaceKey: "model-space" });
const batch = (): KnowledgeGraphGenerationOutput => ({ entities: [{ key: "e1", type: "Person", canonicalName: "John Smith", aliases: [],
  identityDescription: "Physicist at University A, born 1950", confidence: 0.9, evidenceChunkIds: [id] }], claims: [],
  relations: [{ subjectEntityKey: "e1", objectEntityKey: "e2", predicate: "utilized_to_accuse", definition: "The subject was used as evidence to accuse the object.", displayLabel: "Foi utilizado para acusar", confidence: 0.9, evidenceChunkIds: [id] }] });
const type = { id, predicate: "used_to_accuse", definition: "The subject was used as evidence to accuse the object." };
const base = { pool: {} as PgPool, context: { sourceItemId: id }, threshold: 0.92 };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.types.findExact.mockResolvedValue(new Map()); mocks.types.revision.mockResolvedValue(0); mocks.types.missingVectors.mockResolvedValue([]); mocks.types.candidates.mockResolvedValue([]);
  mocks.types.commit.mockResolvedValue(new Map([["utilized_to_accuse", type]]));
  mocks.entities.findResolved.mockResolvedValue(new Map()); mocks.entities.revision.mockResolvedValue("0:0:0"); mocks.entities.missingVectors.mockResolvedValue([]); mocks.entities.candidates.mockResolvedValue([]);
  mocks.entities.commit.mockResolvedValue(new Map([["e1", otherId]]));
});

describe("compact canonical matching", () => {
  it("requires exactly one decision per input and rejects duplicates, omissions and cross-row candidates", () => {
    const rows = ["1", "2"].map((n) => ({ key: `r${n}`, predicate: "name", definition: "definition", candidates: [{ key: `c${n}`, predicate: "candidate", definition: "definition" }] }));
    expect([...parseRelationMatches({ matches: [["r1", "c1"], ["r2", null]] }, rows)]).toEqual([["r1", "c1"], ["r2", null]]);
    for (const matches of [[["r1", "c2"], ["r2", null]], [["r1", null]], [["r1", "c1"], ["r1", null]]]) {
      expect(() => parseRelationMatches({ matches }, rows)).toThrow();
    }
    expect(buildRelationMatchPrompt(rows)).toContain("No explanations, scores or additional fields");
  });
  it("reuses exact relation aliases without any AI call", async () => {
    mocks.types.findExact.mockResolvedValue(new Map([["utilized_to_accuse", type]]));
    const ai = { runDefaultTask: vi.fn() };
    const resolved = await createRelationTypeResolver({ ...base, ai })(batch());
    expect(resolved.relations[0]).toMatchObject({ predicate: "used_to_accuse", relationTypeId: id, originalPredicate: "utilized_to_accuse", displayLabel: "Foi utilizado para acusar" });
    expect(ai.runDefaultTask).not.toHaveBeenCalled();
  });
  it("only commits an equivalent alias after compact LLM confirmation", async () => {
    mocks.types.candidates.mockResolvedValue([{ ...type, score: 0.99 }]);
    const ai = { runDefaultTask: vi.fn(async (task) => result(task === "embedding" ? vector : { matches: [["r1", "c1"]] })) };
    await createRelationTypeResolver({ ...base, ai })(batch());
    expect(mocks.types.commit).toHaveBeenCalledWith([expect.objectContaining({ target: { id }, metadata: expect.objectContaining({ method: "llm_equivalent", threshold: 0.92, score: 0.99 }) })], 0);
    expect(ai.runDefaultTask.mock.calls.filter(([task]) => task !== "embedding")).toHaveLength(1);
  });
  it("compares novel synonyms from the same extraction in one batch", async () => {
    const input = batch(); input.relations.push({ ...input.relations[0]!, predicate: "employed_to_accuse" });
    mocks.types.commit.mockResolvedValue(new Map([["utilized_to_accuse", type], ["employed_to_accuse", type]]));
    const ai = { runDefaultTask: vi.fn(async (task) => result(task === "embedding" ? vector : { matches: [["r2", "c1"]] })) };
    await createRelationTypeResolver({ ...base, ai })(input);
    expect(mocks.types.commit.mock.calls[0]?.[0][1]).toMatchObject({ target: { predicate: "utilized_to_accuse" } });
  });
  it("keeps non-equivalent relations separate even above the vector threshold", async () => {
    mocks.types.candidates.mockResolvedValue([{ ...type, score: 0.999 }]);
    const ai = { runDefaultTask: vi.fn(async (task) => result(task === "embedding" ? vector : { matches: [["r1", null]] })) };
    await createRelationTypeResolver({ ...base, ai })(batch());
    expect(mocks.types.commit.mock.calls[0]?.[0][0].target).toBeNull();
  });
  it("never registers an alias from malformed output after its repair attempt", async () => {
    mocks.types.candidates.mockResolvedValue([{ ...type, score: 0.99 }]);
    const ai = { runDefaultTask: vi.fn(async (task) => result(task === "embedding" ? vector : { matches: [["r1", "invented"]] })) };
    await expect(createRelationTypeResolver({ ...base, ai })(batch())).rejects.toThrow("errors.relationTypes.invalidOutput");
    expect(mocks.types.commit).not.toHaveBeenCalled();
  });
  it("does not persist when canceled while matching", async () => {
    const controller = new AbortController();
    mocks.types.candidates.mockResolvedValue([{ ...type, score: 0.99 }]);
    const ai = { runDefaultTask: vi.fn(async (task) => { if (task !== "embedding") controller.abort(); return result(task === "embedding" ? vector : { matches: [["r1", "c1"]] }); }) };
    await expect(createRelationTypeResolver({ ...base, ai, signal: controller.signal })(batch())).rejects.toThrow();
    expect(mocks.types.commit).not.toHaveBeenCalled();
  });
  it("requires an embedding route for unseen identities", async () => {
    await expect(createRelationTypeResolver({ ...base, ai: { runDefaultTask: vi.fn().mockResolvedValue(null) } })(batch())).rejects.toThrow("errors.relationTypes.embeddingRequired");
    expect(mocks.types.commit).not.toHaveBeenCalled();
  });
});

describe("conservative entity identity", () => {
  it("does not unite homonyms when the model abstains", async () => {
    mocks.entities.candidates.mockResolvedValue([{ id, type: "Person", canonicalName: "John Smith", aliases: [], identityDescription: "Musician in London, born 1980", score: 0.99 }]);
    const ai = { runDefaultTask: vi.fn(async (task) => result(task === "embedding" ? vector : { matches: [["r1", null]] })) };
    const resolved = await createEntityIdentityResolver({ ...base, ai, language: "en" })(batch());
    expect(resolved.entities[0]?.canonicalEntityId).toBe(otherId);
    expect(mocks.entities.commit.mock.calls[0]?.[0][0].target).toBeNull();
    expect(ai.runDefaultTask.mock.calls.filter(([task]) => task !== "embedding")).toHaveLength(1);
  });
  it("reuses the already-confirmed identity for the same source evidence without calling AI", async () => {
    mocks.entities.findResolved.mockImplementation(async (keys: string[]) => new Map([[keys[0], id]]));
    const ai = { runDefaultTask: vi.fn() };
    const resolved = await createEntityIdentityResolver({ ...base, ai, language: "en" })(batch());
    expect(resolved.entities[0]?.canonicalEntityId).toBe(id);
    expect(ai.runDefaultTask).not.toHaveBeenCalled();
    expect(mocks.entities.commit).not.toHaveBeenCalled();
  });
  it("requires distinguishing facts rather than names or scores as proof", () => {
    const prompt = buildRelationMatchPrompt([], true);
    expect(prompt).toContain("names, aliases or vector similarity ALONE never prove identity");
    expect(prompt).toContain("Insufficient context, homonyms");
  });
});

it("serializes shared candidate definitions once and never includes provenance IDs in the prompt", () => {
  const candidate = { key: "c1", predicate: "works_at", definition: "The subject works at the object.", sourceItemIds: [id] };
  const prompt = buildRelationMatchPrompt(["r1", "r2"].map((key) => ({ key, predicate: "employed_at", definition: candidate.definition, candidates: [candidate] })));
  const data = JSON.parse(prompt.split("\n").at(-1)!);
  expect(data.candidates).toHaveLength(1);
  expect(data.relations).toHaveLength(2);
  expect(prompt).not.toContain(id);
});

it("fails before catalog persistence when the embedding model changes mid-batch", async () => {
  const input = batch(); input.relations.push({ ...input.relations[0]!, predicate: "employed_to_accuse" });
  let runs = 0;
  const ai = { runDefaultTask: vi.fn(async () => ({ ...result(vector), embeddingSpaceKey: String(++runs) })) };
  await expect(createRelationTypeResolver({ ...base, ai })(input)).rejects.toThrow("errors.relationTypes.modelChanged");
  expect(mocks.types.commit).not.toHaveBeenCalled();
});
