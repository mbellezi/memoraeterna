import { describe, expect, it, vi } from "vitest";

import {
  generateAtomicNoteCandidates,
  generateKnowledgeGraphFromAtomicNotes,
  type KnowledgeAiExecution
} from "./knowledge-processing.js";

const execution = (output: unknown, runId: string): KnowledgeAiExecution => ({
  output,
  providerId: "test",
  modelId: "mock",
  runtime: "local",
  profileId: "profile-1",
  aiTaskRunId: runId
});
const answers = (...outputs: unknown[]) => {
  const run = vi.fn();
  outputs.forEach((output, index) => run.mockResolvedValueOnce(execution(output, `run-${index}`)));
  return run;
};

const source = { title: "Source", language: "en" };
const notes = [
  {
    id: "note-1",
    title: "Imantação",
    ideaStatement: "Imantação envolve co-presença.",
    bodyMarkdown: "A imantação é uma sintonia progressiva.",
    evidenceChunkIds: ["chunk-1"]
  }
];
const entity = (key: string, extra: Record<string, unknown> = {}) => ({
  key,
  type: "Concept",
  canonicalName: `Name ${key}`,
  identityDescription: "A concept defined in the supplied evidence.",
  aliases: [],
  confidence: 0.9,
  evidenceChunkIds: ["c1"],
  ...extra
});
const relation = (subject: string, object: string) => ({
  subjectEntityKey: subject,
  predicate: "relates_to",
  displayLabel: "Relates to",
  definition: "The subject relates to the object.",
  objectEntityKey: object,
  confidence: 0.8,
  evidenceChunkIds: ["c1"]
});
const graph = (entities: unknown[], relations: unknown[]) =>
  JSON.stringify({ entities, relations });

describe("knowledge-graph extraction with salvage (F3 D35)", () => {
  it("keeps the valid items of an answer with a bad relation and makes no repair call", async () => {
    const run = answers(
      graph(
        [entity("e1"), entity("e2")],
        [relation("e1", "e2"), relation("e1", "co-presença"), relation("e2", "e2")]
      )
    );
    const onSalvage = vi.fn();
    const result = await generateKnowledgeGraphFromAtomicNotes(source, notes, run, undefined, {
      onSalvage
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(result?.batches[0]?.entities).toHaveLength(2);
    expect(result?.batches[0]?.relations).toHaveLength(1);
    expect(result?.executions[0]?.aiTaskRunId).toBe("run-0");
    expect(onSalvage).toHaveBeenCalledTimes(1);
    expect(onSalvage.mock.calls[0]![0]).toMatchObject({
      batchIndex: 0,
      repaired: false,
      salvage: { salvagedItems: 2, dropped: { unknown_entity_key: 1, self_relation: 1 } }
    });
  });

  it("does not call onSalvage for an answer that needed none", async () => {
    const onSalvage = vi.fn();
    await generateKnowledgeGraphFromAtomicNotes(
      source,
      notes,
      answers(graph([entity("e1"), entity("e2")], [relation("e1", "e2")])),
      undefined,
      { onSalvage }
    );
    expect(onSalvage).not.toHaveBeenCalled();
  });

  it("asks again, with the problems listed, only when nothing valid is left", async () => {
    const run = answers(
      graph([entity("e1", { type: "Spaceship" })], [relation("e1", "e2")]),
      graph([entity("e1")], [])
    );
    const result = await generateKnowledgeGraphFromAtomicNotes(source, notes, run);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[1]).toMatchObject({
      operation: "graph_atomic_notes_repair",
      attempt: 1
    });
    expect(run.mock.calls[1]?.[0]).toContain("- entities.0:");
    expect(result?.batches[0]?.entities.map((item) => item.key)).toEqual(["e1"]);
    expect(result?.executions[0]?.aiTaskRunId).toBe("run-1");
  });

  it("salvages the repair's answer too, and counts it as repaired", async () => {
    const onSalvage = vi.fn();
    const result = await generateKnowledgeGraphFromAtomicNotes(
      source,
      notes,
      answers(
        "not json at all",
        graph([entity("e1"), entity("e2")], [relation("e1", "e2"), relation("e2", "e2")])
      ),
      undefined,
      { onSalvage }
    );
    expect(result?.batches[0]?.relations).toHaveLength(1);
    expect(onSalvage.mock.calls[0]![0]).toMatchObject({ repaired: true });
  });

  it("fails with a stable code when the repair has nothing valid either", async () => {
    const run = answers(
      graph([entity("e1", { type: "Spaceship" })], []),
      graph([entity("e2", { type: "Spaceship" })], [])
    );
    await expect(generateKnowledgeGraphFromAtomicNotes(source, notes, run)).rejects.toThrow(
      "knowledge_graph_output_invalid:nothing_valid"
    );
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("states the caps the writer's locality gives (24/24 on a remote writer, 12/12 by default)", async () => {
    const remote = answers(graph([entity("e1")], []));
    await generateKnowledgeGraphFromAtomicNotes(source, notes, remote, 7_000, {
      batchLimits: { maxEntities: 24, maxRelations: 24 }
    });
    expect(remote.mock.calls[0]?.[0]).toContain("at most 24 entities and 24 relations");
    const local = answers(graph([entity("e1")], []));
    await generateKnowledgeGraphFromAtomicNotes(source, notes, local);
    expect(local.mock.calls[0]?.[0]).toContain("at most 12 entities and 12 relations");
  });

  it("packs larger batches when the input size allows it", async () => {
    const many = Array.from({ length: 6 }, (_unused, index) => ({
      id: `note-${index}`,
      title: `Title ${index}`,
      ideaStatement: "Idea.",
      bodyMarkdown: "x".repeat(1_500),
      evidenceChunkIds: [`chunk-${index}`]
    }));
    const run = vi.fn().mockImplementation(async () => execution(graph([entity("e1")], []), "run"));
    await generateKnowledgeGraphFromAtomicNotes(source, many, run, 3_500);
    const smallBatches = run.mock.calls.length;
    run.mockClear();
    await generateKnowledgeGraphFromAtomicNotes(source, many, run, 7_000);
    expect(run.mock.calls.length).toBeLessThan(smallBatches);
  });
});

describe("the extraction pin keeps the recording-era path (F3 D5, C1)", () => {
  it("repairs the whole answer for a bad relation instead of salvaging it", async () => {
    const run = answers(
      graph([entity("e1"), entity("e2")], [relation("e1", "e2"), relation("e1", "co-presença")]),
      graph([entity("e1"), entity("e2")], [relation("e1", "e2")])
    );
    const onSalvage = vi.fn();
    const result = await generateKnowledgeGraphFromAtomicNotes(source, notes, run, undefined, {
      pinned: true,
      onSalvage
    });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toContain(
      "relations.1: relation references an unknown entity key"
    );
    expect(result?.executions[0]?.aiTaskRunId).toBe("run-1");
    expect(onSalvage).not.toHaveBeenCalled();
  });

  it("still fails an unknown evidence alias for the whole batch, as it was recorded", async () => {
    const run = answers(
      graph([entity("e1", { evidenceChunkIds: ["c9"] })], []),
      graph([entity("e1", { evidenceChunkIds: ["c9"] })], [])
    );
    await expect(
      generateKnowledgeGraphFromAtomicNotes(source, notes, run, undefined, { pinned: true })
    ).rejects.toThrow("knowledge_graph_output_invalid:knowledge_graph_unknown_evidence_alias:c9");
  });

  it("keeps the stable error code of an invalid repair", async () => {
    const run = answers('{"entities":[', '{"entities":[');
    await expect(
      generateKnowledgeGraphFromAtomicNotes(source, notes, run, undefined, { pinned: true })
    ).rejects.toThrow("knowledge_graph_output_invalid:invalid_json");
  });
});

describe("atomic notes with item-level repair (F3 D35)", () => {
  const chunks = [
    { id: "chunk-1", content: "Evidence one." },
    { id: "chunk-2", content: "Evidence two." }
  ];
  const note = (title: string, evidence: string[] = ["chunk-1"], extra = {}) => ({
    title,
    bodyMarkdown: `Body of ${title}.`,
    ideaStatement: `Idea of ${title}.`,
    evidenceChunkIds: evidence,
    ...extra
  });

  it("keeps the valid notes and asks again only for the invalid ones", async () => {
    const invalid = note("Cites a chunk that is not here", ["chunk-9"]);
    const run = answers(
      JSON.stringify({ notes: [note("First"), invalid, note("Second", ["chunk-2"])] }),
      JSON.stringify({ notes: [note("Cites a chunk that is here", ["chunk-2"])] })
    );
    const result = await generateAtomicNoteCandidates(source, chunks, run);
    expect(run).toHaveBeenCalledTimes(2);
    expect(result?.output.notes.map((item) => item.title)).toEqual([
      "First",
      "Second",
      "Cites a chunk that is here"
    ]);
    expect(result?.execution.aiTaskRunId).toBe("run-1");
    // The repair sees the invalid note and the reason, not the notes that were fine.
    const prompt = run.mock.calls[1]?.[0] as string;
    expect(prompt).toContain("Cites a chunk that is not here");
    expect(prompt).not.toContain("Body of First.");
    expect(prompt).toContain("chunk ids are not allowed");
    expect(run.mock.calls[1]?.[1]).toMatchObject({ operation: "atomic_note_repair", attempt: 1 });
  });

  it("keeps the valid notes when the repair fixes nothing, and does not fail the stage", async () => {
    const run = answers(
      JSON.stringify({ notes: [note("Fine"), note("Broken", [])] }),
      "still not json"
    );
    const result = await generateAtomicNoteCandidates(source, chunks, run);
    expect(result?.output.notes.map((item) => item.title)).toEqual(["Fine"]);
    // Nothing was added by the repair, so the first answer remains the generating run.
    expect(result?.execution.aiTaskRunId).toBe("run-0");
  });

  it("makes no repair call when every note is valid", async () => {
    const run = answers(JSON.stringify({ notes: [note("One"), note("Two", ["chunk-2"])] }));
    const result = await generateAtomicNoteCandidates(source, chunks, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(result?.output.notes).toHaveLength(2);
  });

  it("asks again for the whole answer when no note is valid, as before", async () => {
    const run = answers(
      JSON.stringify({ notes: [note("Broken", [])] }),
      JSON.stringify({ notes: [note("Mended")] })
    );
    const result = await generateAtomicNoteCandidates(source, chunks, run);
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toContain("Broken");
    expect(result?.output.notes.map((item) => item.title)).toEqual(["Mended"]);
  });

  it("fails when the whole-answer repair has no valid note either", async () => {
    const run = answers('{"notes":[', JSON.stringify({ notes: [note("Broken", ["chunk-9"])] }));
    await expect(generateAtomicNoteCandidates(source, chunks, run)).rejects.toThrow(
      "atomic_note_nothing_valid"
    );
  });

  it("accepts the empty answer for material with no ideas in it", async () => {
    const run = answers('{"notes":[]}');
    const result = await generateAtomicNoteCandidates(source, chunks, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(result?.output.notes).toEqual([]);
  });

  it("repairs the whole answer when pinned, even if some notes were valid", async () => {
    const run = answers(
      JSON.stringify({ notes: [note("Fine"), note("Broken", [])] }),
      JSON.stringify({ notes: [note("Fine"), note("Mended")] })
    );
    const result = await generateAtomicNoteCandidates(source, chunks, run, { pinned: true });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[1]?.[0]).toContain("Body of Fine.");
    expect(result?.output.notes.map((item) => item.title)).toEqual(["Fine", "Mended"]);
  });
});
