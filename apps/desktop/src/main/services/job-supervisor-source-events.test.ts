import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PgPool } from "@app/db";

import { JobSupervisor } from "./job-supervisor.js";
import type { KnowledgeService } from "./knowledge-service.js";
import { captureObjectEvents, type ObjectEventCapture } from "./object-events-fixture.js";

// F5 T114: the supervisor tells the windows, as `object.changed`, that a source's run ended (done,
// failed or settled with its link job) and that notes' relations changed (the link jobs' hook).
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
  hierarchy: { refreshBatch: vi.fn() },
  documents: { findById: vi.fn() },
  chunks: { listByDocument: vi.fn() },
  notes: { listBySourceItem: vi.fn() },
  /** The options the supervisor gave the link jobs' runner. */
  linkerOptions: [] as Array<{
    relationsChanged: (noteIds: string[]) => void;
    runsSettled: (runs: Array<{ sourceItemId?: string; batchId?: string }>) => Promise<void>;
  }>
}));
vi.mock("@app/db", async (original) => ({
  ...(await original<typeof import("@app/db")>()),
  createJobRepository: () => mocks.jobs,
  createIngestionRunRepository: () => mocks.runs,
  createHierarchicalIngestionRepository: () => mocks.hierarchy,
  createDocumentRepository: () => mocks.documents,
  createChunkRepository: () => mocks.chunks,
  createAtomicNoteRepository: () => mocks.notes
}));
vi.mock("./relations/relation-link.js", async (original) => ({
  ...(await original<typeof import("./relations/relation-link.js")>()),
  RelationLinker: class {
    public constructor(options: (typeof mocks.linkerOptions)[number]) {
      mocks.linkerOptions.push(options);
    }
    public jobs() {
      return {};
    }
  }
}));

let supervisor: JobSupervisor | undefined;
let capture: ObjectEventCapture;
const generateKnowledgeGraph = vi.fn();
beforeEach(() => {
  vi.resetAllMocks();
  mocks.linkerOptions.length = 0;
  capture = captureObjectEvents();
  mocks.jobs.create.mockResolvedValue({ id: "stage-job" });
  mocks.documents.findById.mockResolvedValue({ metadata: {} });
  mocks.chunks.listByDocument.mockResolvedValue([]);
  mocks.notes.listBySourceItem.mockResolvedValue([]);
  generateKnowledgeGraph.mockResolvedValue({ configured: true, generated: true });
});
afterEach(async () => {
  capture.stop();
  await supervisor?.stop();
});

const build = () =>
  (supervisor = new JobSupervisor({
    getPool: () => ({}) as PgPool,
    knowledgeService: { generateKnowledgeGraph } as unknown as KnowledgeService
  }));

/** One ingestion job whose only stage is the graph, so the run ends with the job. */
async function runIngestion(): Promise<void> {
  mocks.runs.startOrResume.mockResolvedValue({
    id: "run",
    batchId: null,
    effectiveStages: ["knowledgeGraph"],
    stagesCheckpoint: {}
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
      sourceItemId: "source-1",
      markdown: "Spacing flattens the forgetting curve.",
      processingMode: "content"
    }
  });
  mocks.jobs.update.mockResolvedValue({ id: "job" });
  await build().runOnce();
}

describe("the object.changed announcements of the supervisor", () => {
  it("announces a source whose run completed with its job", async () => {
    await runIngestion();
    expect(mocks.runs.complete).toHaveBeenCalledWith("run");
    expect(capture.refs()).toEqual([{ kind: "source", id: "source-1", change: "updated" }]);
  });

  it("announces a source whose run failed, once the failure is stored", async () => {
    generateKnowledgeGraph.mockRejectedValue(new Error("errors.common.validationFailed"));
    await runIngestion();
    expect(mocks.runs.fail).toHaveBeenCalledOnce();
    expect(mocks.runs.complete).not.toHaveBeenCalled();
    expect(capture.refs()).toEqual([{ kind: "source", id: "source-1", change: "updated" }]);
  });

  it("announces the sources of the runs that waited for their link job once it settles them", async () => {
    build();
    const linker = mocks.linkerOptions[0]!;
    await linker.runsSettled([{ sourceItemId: "source-1" }, { sourceItemId: "source-2" }, {}]);
    expect(capture.refs()).toEqual([
      { kind: "source", id: "source-1", change: "updated" },
      { kind: "source", id: "source-2", change: "updated" }
    ]);
  });

  it("hands the link jobs the relations funnel: notes announced as relations and on the old push", () => {
    vi.useFakeTimers();
    try {
      build();
      const heard: string[][] = [];
      supervisor!.subscribeRelationsChanged((event) => void heard.push(event.noteIds));
      mocks.linkerOptions[0]!.relationsChanged(["n2", "n1"]);
      expect(capture.refs()).toEqual([
        { kind: "note", id: "n2", change: "relations" },
        { kind: "note", id: "n1", change: "relations" }
      ]);
      vi.advanceTimersByTime(250);
      expect(heard).toEqual([["n1", "n2"]]);
    } finally {
      vi.useRealTimers();
    }
  });
});
