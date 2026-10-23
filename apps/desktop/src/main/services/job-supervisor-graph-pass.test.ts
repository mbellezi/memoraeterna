import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PgPool } from "@app/db";
import { JobSupervisor } from "./job-supervisor.js";
import type { KnowledgeService } from "./knowledge-service.js";

const mocks = vi.hoisted(() => ({
  jobs: {
    recoverInterrupted: vi.fn(),
    releaseBlocks: vi.fn(),
    claimNext: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    reportProgress: vi.fn()
  },
  runs: {
    startOrResume: vi.fn(),
    findById: vi.fn(),
    beginStage: vi.fn(),
    completeStage: vi.fn(),
    updateStageProgress: vi.fn(),
    complete: vi.fn(),
    update: vi.fn(),
    fail: vi.fn(),
    cancel: vi.fn()
  },
  documents: { findById: vi.fn() },
  chunks: { listByDocument: vi.fn() },
  notes: { listBySourceItem: vi.fn() }
}));
vi.mock("@app/db", async (original) => ({
  ...(await original<typeof import("@app/db")>()),
  createJobRepository: () => mocks.jobs,
  createIngestionRunRepository: () => mocks.runs,
  createDocumentRepository: () => mocks.documents,
  createChunkRepository: () => mocks.chunks,
  createAtomicNoteRepository: () => mocks.notes
}));

let supervisor: JobSupervisor | undefined;
const generateKnowledgeGraph = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  mocks.jobs.create.mockResolvedValue({ id: "stage-job" });
  mocks.documents.findById.mockResolvedValue({ metadata: {} });
  mocks.chunks.listByDocument.mockResolvedValue([]);
  mocks.notes.listBySourceItem.mockResolvedValue([]);
  generateKnowledgeGraph.mockResolvedValue({ configured: true, generated: true });
});
afterEach(async () => {
  await supervisor?.stop();
});

/** Runs one ingestion job whose notes exist and whose only remaining stage is the graph. */
async function graphContext(input: {
  stages: string[];
  payload?: Record<string, unknown>;
}): Promise<{ includeAtomicNotesGraph?: boolean }> {
  supervisor = new JobSupervisor({
    getPool: () => ({}) as PgPool,
    knowledgeService: { generateKnowledgeGraph } as unknown as KnowledgeService
  });
  mocks.runs.startOrResume.mockResolvedValue({
    id: "run",
    batchId: null,
    effectiveStages: input.stages,
    stagesCheckpoint: {
      atomicNotes: { status: "completed", metadata: { noteIds: ["note-1"] } }
    }
  });
  mocks.jobs.claimNext.mockResolvedValue({
    id: "job",
    type: "ingestion",
    attempts: 1,
    maxAttempts: 3,
    progress: 0,
    payload: {
      ingestionRunId: "run",
      documentId: "document",
      sourceItemId: "source",
      markdown: "Spacing flattens the forgetting curve.",
      processingMode: "content",
      ...input.payload
    }
  });
  mocks.jobs.update.mockResolvedValue({ id: "job" });
  await supervisor.runOnce();
  expect(mocks.runs.fail.mock.calls).toEqual([]);
  expect(generateKnowledgeGraph).toHaveBeenCalledOnce();
  expect(mocks.runs.completeStage).toHaveBeenCalledWith("run", "knowledgeGraph", expect.anything());
  return generateKnowledgeGraph.mock.calls[0]![2];
}

describe("the knowledge graph pass of an ingestion run", () => {
  const stages = ["atomicNotes", "knowledgeGraph"];

  it("reads only the chunks of a source by default: one graph pass per source", async () => {
    expect((await graphContext({ stages })).includeAtomicNotesGraph).toBe(false);
  });

  it("adds a pass over the notes only when the processing plan asked for it", async () => {
    expect(
      (await graphContext({ stages, payload: { knowledgeGraphOnNotes: true } }))
        .includeAtomicNotesGraph
    ).toBe(true);
  });

  it("never reads notes the run did not generate", async () => {
    expect(
      (await graphContext({ stages: ["knowledgeGraph"], payload: { knowledgeGraphOnNotes: true } }))
        .includeAtomicNotesGraph
    ).toBe(false);
  });

  it("takes the run to 0.87 with extraction and to 0.89 with identity, keeping the checkpoints (D20)", async () => {
    const checkpoints = [{ batchKey: "source:b1" }, { batchKey: "source:b2" }];
    generateKnowledgeGraph.mockImplementation(
      async (
        _source: string,
        _document: string,
        context: {
          onBatchCompleted: (input: object) => Promise<void>;
          onIdentityProgress: (input: object) => Promise<void>;
        }
      ) => {
        await context.onBatchCompleted({ completed: 2, total: 2, checkpoints });
        await context.onIdentityProgress({ fraction: 0.5, checkpoints });
        await context.onIdentityProgress({ fraction: 1, checkpoints });
        return { configured: true, generated: true };
      }
    );
    await graphContext({ stages });
    const run = mocks.jobs.reportProgress.mock.calls
      .filter(([id]) => id === "job")
      .map(([, progress]) => progress as number);
    const stage = mocks.runs.updateStageProgress.mock.calls.map(([, , progress, metadata]) => [
      progress,
      metadata
    ]);
    // After the stage starts at 0.84: the three graph reports.
    const start = run.indexOf(0.84);
    expect(run.slice(start + 1, start + 4).map((progress) => Number(progress.toFixed(4)))).toEqual([
      0.87, 0.88, 0.89
    ]);
    expect(stage.map(([progress]) => Number((progress as number).toFixed(4)))).toEqual([
      0.6, 0.8, 1
    ]);
    for (const [, metadata] of stage)
      expect(metadata).toEqual({ completed: 2, total: 2, completedBatches: checkpoints });
  });

  it("treats anything but an explicit true as off", async () => {
    expect(
      (await graphContext({ stages, payload: { knowledgeGraphOnNotes: "true" } }))
        .includeAtomicNotesGraph
    ).toBe(false);
  });
});
