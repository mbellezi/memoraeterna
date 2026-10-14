import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { uuidAssignments, withoutUuids } from "./__fixtures__/uuid-assignments.js";
import { compareContent, contentKey } from "./content-order.js";
import { consultationPrompt, rankConsultationCandidates } from "./consultation-service.js";
import {
  atomicNoteDecisionContentHash,
  buildAtomicNoteGenerationPrompt,
  buildBatchRerankPrompt,
  buildKnowledgeGraphPrompt,
  buildKnowledgeGraphRepairPrompt,
  createEvidenceAliases,
  fuseAtomicNoteCandidateRankings,
  generateAtomicNoteCandidates,
  generateKnowledgeGraphFromAtomicNotes,
  generateSummaryFromChunks
} from "./knowledge-processing.js";
import { defaultPromptPin } from "./prompt-runtime.js";
import { promptSampleSnapshot } from "./prompt-samples.js";

function expectIdentical(prompts: string[]) {
  expect(prompts.length).toBeGreaterThan(1);
  expect(new Set(prompts).size).toBe(1);
}

const source = { title: "Forgetting curve", language: "en" };
const bodies = ["First excerpt body.", "Second excerpt body.", "Third excerpt body."];
const emptyGraph = JSON.stringify({ entities: [], claims: [], relations: [] });
const execution = (output: unknown) => ({
  output,
  providerId: "test",
  modelId: "mock",
  runtime: "remote",
  profileId: "profile",
  aiTaskRunId: "run"
});

describe("knowledge graph prompts", () => {
  it("assign evidence aliases by document position instead of chunk UUID order", async () => {
    const prompts: string[] = [];
    for (const ids of uuidAssignments(bodies.length)) {
      const run = vi.fn(async (prompt: string) => {
        prompts.push(prompt);
        return execution(
          JSON.stringify({
            entities: [
              {
                key: "e1",
                type: "Concept",
                canonicalName: "Forgetting",
                identityDescription: "A concept defined in the supplied evidence.",
                aliases: [],
                confidence: 0.9,
                evidenceChunkIds: ["c2"]
              }
            ],
            claims: [],
            relations: []
          })
        );
      });
      const generated = await generateKnowledgeGraphFromAtomicNotes(
        source,
        bodies.map((bodyMarkdown, index) => ({
          id: ids[index]!,
          title: `${source.title} — excerpt ${index + 1}`,
          ideaStatement: "",
          bodyMarkdown,
          evidenceChunkIds: [ids[index]!]
        })),
        run,
        12_000,
        {
          inputKind: "source_chunks",
          chunkPositions: new Map(ids.map((id, index) => [id, index]))
        }
      );
      // The backend resolves the alias the model cited back to the second chunk of the document.
      expect(generated?.batches[0]?.entities[0]?.evidenceChunkIds).toEqual([ids[1]]);
    }
    expectIdentical(prompts);
    expect(prompts[0]).toContain("[s1; evidence=c1]");
    expect(prompts[0]).toContain("[s2; evidence=c2]");
    expect(prompts[0]).toContain("[s3; evidence=c3]");
    expect(prompts[0]).toContain('allowed evidence aliases in this batch are: ["c1","c2","c3"]');
  });

  it("number aliases in document order even when the inputs list evidence in UUID order", async () => {
    const prompts: string[] = [];
    for (const ids of uuidAssignments(bodies.length)) {
      // The first note cites the document's third and first chunks; SQL used to list them by UUID.
      const cited = (positions: number[]) => positions.map((p) => ids[p]!).sort();
      const notes = [
        {
          id: randomUUID(),
          title: "Third and first",
          ideaStatement: "Idea one",
          bodyMarkdown: "Body one",
          evidenceChunkIds: cited([2, 0])
        },
        {
          id: randomUUID(),
          title: "Second",
          ideaStatement: "Idea two",
          bodyMarkdown: "Body two",
          evidenceChunkIds: cited([1])
        }
      ];
      const run = vi
        .fn()
        .mockImplementationOnce(async (prompt: string) => {
          prompts.push(prompt);
          return execution("not json");
        })
        .mockImplementationOnce(async (prompt: string) => {
          prompts.push(prompt);
          return execution(emptyGraph);
        });
      await generateKnowledgeGraphFromAtomicNotes(source, notes, run, 12_000, {
        inputKind: "atomic_notes",
        chunkPositions: new Map(ids.map((id, index) => [id, index]))
      });
    }
    // Two calls per assignment: the extraction prompt and its repair prompt.
    expect(prompts).toHaveLength(8);
    expectIdentical(prompts.filter((_, index) => index % 2 === 0));
    expectIdentical(prompts.filter((_, index) => index % 2 === 1));
    expect(prompts[0]).toContain("[n1; evidence=c1,c3]");
    expect(prompts[0]).toContain("[n2; evidence=c2]");
    expect(prompts[1]).toContain("[n1; evidence=c1,c3]");
  });

  it("number the aliases of a catalog input and of direct prompt builders in document order", () => {
    const prompts: string[] = [];
    const repairs: string[] = [];
    for (const ids of uuidAssignments(bodies.length)) {
      const catalog = [
        {
          id: `catalog:${randomUUID()}`,
          title: source.title,
          ideaStatement: "Source catalog metadata",
          bodyMarkdown: bodies.join("\n\n"),
          evidenceChunkIds: ids
        }
      ];
      prompts.push(
        buildKnowledgeGraphPrompt(source, catalog, undefined, "catalog_metadata"),
        buildKnowledgeGraphPrompt(
          source,
          catalog,
          createEvidenceAliases(catalog, new Map(ids.map((id, index) => [id, index]))),
          "catalog_metadata"
        )
      );
      repairs.push(
        buildKnowledgeGraphRepairPrompt(
          source,
          catalog,
          createEvidenceAliases(catalog),
          "{",
          new Error("invalid_json"),
          "catalog_metadata"
        )
      );
    }
    expectIdentical(prompts);
    expectIdentical(repairs);
    expect(prompts[0]).toContain("[s1; evidence=c1,c2,c3]");
  });

  it("never lets a chunk UUID decide an alias", () => {
    const [ascending, descending] = uuidAssignments(2);
    for (const ids of [ascending!, descending!]) {
      const notes = ids.map((id, index) => ({
        id: `note-${index}`,
        title: "T",
        ideaStatement: "",
        bodyMarkdown: "B",
        evidenceChunkIds: [id]
      }));
      expect([...createEvidenceAliases(notes).values()]).toEqual(ids);
      // Known positions win over the order of first citation; unknown ones follow in citation order.
      const positions = new Map([[ids[1]!, 0]]);
      expect([...createEvidenceAliases(notes, positions).values()]).toEqual([ids[1], ids[0]]);
    }
  });
});

describe("summary prompts", () => {
  it("map and reduce chunks in document order whatever their UUIDs", async () => {
    const chunkBodies = Array.from(
      { length: 6 },
      (_, index) => `Chunk ${index + 1} states a fact about retention number ${index + 1}.`
    );
    const prompts: string[] = [];
    for (const ids of uuidAssignments(chunkBodies.length)) {
      const run = vi.fn(async (prompt: string) => {
        prompts.push(prompt);
        return execution(
          JSON.stringify({
            summary: "A partial summary of the passage.",
            concepts: [{ idea: "Retention", evidenceChunkIds: ["c2"] }]
          })
        );
      });
      const result = await generateSummaryFromChunks(
        chunkBodies.map((content, index) => ({ id: ids[index]!, content })),
        run,
        130,
        0
      );
      expect(result?.mapReduce).toBe(true);
      // The concept cites the second chunk of each group, resolved to a real chunk of the document.
      expect(result?.concepts?.map((concept) => concept.evidenceChunkIds[0])).toEqual([
        ids[1],
        ids[3],
        ids[5]
      ]);
    }
    expect(prompts.length).toBe(16);
    for (let offset = 0; offset < 4; offset++)
      expectIdentical(prompts.filter((_, index) => index % 4 === offset));
    expect(prompts[0]).toContain("[c1]\nChunk 1");
    expect(prompts[0]).toContain("[c2]\nChunk 2");
  });
});

describe("atomic note generation prompts", () => {
  it("list the chunks in document order, identical once chunk IDs are normalized", async () => {
    const prompts: string[] = [];
    const repairs: string[] = [];
    for (const ids of uuidAssignments(bodies.length)) {
      const chunks = bodies.map((content, index) => ({ id: ids[index]!, content }));
      prompts.push(withoutUuids(buildAtomicNoteGenerationPrompt(source, chunks)));
      const run = vi
        .fn()
        .mockImplementationOnce(async (prompt: string) => {
          prompts.push(withoutUuids(prompt));
          return execution("not json");
        })
        .mockImplementationOnce(async (prompt: string) => {
          repairs.push(withoutUuids(prompt));
          return execution(JSON.stringify({ notes: [] }));
        });
      await generateAtomicNoteCandidates(source, chunks, run);
    }
    expectIdentical(prompts);
    expectIdentical(repairs);
    const first = prompts[0]!;
    expect(first.indexOf("First excerpt")).toBeLessThan(first.indexOf("Second excerpt"));
    expect(first.indexOf("Second excerpt")).toBeLessThan(first.indexOf("Third excerpt"));
  });
});

describe("atomic note candidate fusion", () => {
  it("breaks equal rankings on note content, never on the note UUID", () => {
    const fused = (alphaId: string, betaId: string) =>
      fuseAtomicNoteCandidateRankings(
        [
          { noteId: betaId, contentKey: contentKey("Beta", "Idea"), score: 1 },
          { noteId: alphaId, contentKey: contentKey("Alpha", "Idea"), score: 1 }
        ],
        [
          { noteId: alphaId, contentKey: contentKey("Alpha", "Idea"), score: 1 },
          { noteId: betaId, contentKey: contentKey("Beta", "Idea"), score: 1 }
        ],
        [],
        10
      ).map((candidate) => candidate.contentKey);
    const [low, high] = uuidAssignments(2)[0]!;
    const expected = [contentKey("Alpha", "Idea"), contentKey("Beta", "Idea")];
    expect(fused(low!, high!)).toEqual(expected);
    expect(fused(high!, low!)).toEqual(expected);
  });

  it("builds the decision-only matching prompt and cache identity from content alone", () => {
    const prompts: string[] = [];
    const hashes: string[][] = [];
    for (const ids of uuidAssignments(2)) {
      const notes = ["Beta", "Alpha"].map((title, index) => ({
        id: ids[index]!,
        title,
        ideaStatement: `${title} idea`
      }));
      // The two candidates swap ranks between the lists, so they tie; content breaks the tie.
      const ranking = notes.map((note) => ({
        noteId: note.id,
        contentKey: contentKey(note.title, note.ideaStatement),
        score: 1
      }));
      const fused = fuseAtomicNoteCandidateRankings(ranking, [...ranking].reverse(), [], 10);
      const ordered = fused.map((candidate) => notes.find((note) => note.id === candidate.noteId)!);
      prompts.push(
        buildBatchRerankPrompt(
          { title: "Source", ideaStatement: "Source idea" },
          ordered.map((note, index) => ({ ...note, alias: `c${index + 1}` })),
          0.65
        )
      );
      hashes.push(ordered.map(atomicNoteDecisionContentHash));
    }
    expectIdentical(prompts);
    expectIdentical(hashes.map((list) => list.join(",")));
    expect(prompts[0]).toContain("[c1]\nTitle: Alpha");
    expect(prompts[0]).toContain("[c2]\nTitle: Beta");
  });

  it("orders content keys without relying on the locale", () => {
    expect(compareContent("a", "b")).toBe(-1);
    expect(compareContent("b", "a")).toBe(1);
    expect(compareContent("a", "a")).toBe(0);
    expect(compareContent(undefined, "")).toBe(0);
  });
});

describe("consultation prompts", () => {
  it("number the evidence by document position, identical once IDs are normalized", () => {
    const prompts: string[] = [];
    const handles: string[][] = [];
    for (const ids of uuidAssignments(3)) {
      // Three chunks of one source tie on every score; only their position tells them apart.
      const rows = ["Gamma passage", "Alpha passage", "Beta passage"].map((excerpt, index) => ({
        chunkId: ids[index]!,
        sourceItemId: ids[0]!,
        sourceTitle: "Source",
        chunkIndex: [2, 0, 1][index]!,
        excerpt,
        text: 1
      }));
      const ranked = rankConsultationCandidates(rows, []);
      handles.push(ranked.map((row) => row.excerpt));
      const snapshot = promptSampleSnapshot(defaultPromptPin(), "consultation");
      const template = snapshot.evidence[0]!;
      snapshot.contexts = [];
      snapshot.relations = [];
      snapshot.evidence = ranked.map((row, index) => ({
        ...template,
        chunkId: row.chunkId,
        sourceItemId: row.sourceItemId,
        excerpt: row.excerpt,
        handle: `e${index + 1}`
      }));
      prompts.push(withoutUuids(consultationPrompt(snapshot, "What is retained?")));
    }
    expectIdentical(prompts);
    for (const order of handles)
      expect(order).toEqual(["Alpha passage", "Beta passage", "Gamma passage"]);
  });
});
