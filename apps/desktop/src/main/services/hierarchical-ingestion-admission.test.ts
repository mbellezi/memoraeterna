import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PgPool } from "@app/db";
import { ProcessingPlanRequestSchema, type ProcessingPlanRequest } from "@app/domain";

import { HierarchicalIngestionService } from "./hierarchical-ingestion-service.js";

const mocks = vi.hoisted(() => ({
  settings: { get: vi.fn() },
  curator: { policy: vi.fn() },
  hierarchy: {
    getBreadcrumbs: vi.fn(),
    createBatch: vi.fn(),
    ensureCurrentDocumentRevision: vi.fn(),
    listDescendants: vi.fn(),
    getArtifactState: vi.fn(),
    refreshBatch: vi.fn()
  },
  runs: {
    create: vi.fn(),
    initializeStages: vi.fn(),
    skipStage: vi.fn(),
    completeStage: vi.fn(),
    findById: vi.fn(),
    update: vi.fn(),
    complete: vi.fn(),
    listBySourceItem: vi.fn()
  },
  jobs: { create: vi.fn() },
  documents: { listBySourceItem: vi.fn() },
  sources: { findById: vi.fn() },
  embeddings: { hasSourceMatchingCoverage: vi.fn() }
}));
vi.mock("@app/db", async (original) => ({
  ...(await original<typeof import("@app/db")>()),
  createSettingsRepository: () => mocks.settings,
  createWikiCuratorRepository: () => mocks.curator,
  createHierarchicalIngestionRepository: () => mocks.hierarchy,
  createIngestionRunRepository: () => mocks.runs,
  createJobRepository: () => mocks.jobs,
  createDocumentRepository: () => mocks.documents,
  createSourceItemRepository: () => mocks.sources,
  createEmbeddingRepository: () => mocks.embeddings
}));
vi.mock("./prompt-strategies.js", () => ({ promptStageProviders: async () => ({}) }));

const sourceId = "00000000-0000-4000-8000-000000000001";
const fullKnowledge: ProcessingPlanRequest = {
  preset: "full_knowledge",
  requestedStages: [],
  scope: "source_only",
  targetSourceItemIds: [sourceId],
  forceRegeneration: false,
  previousArtifactPolicy: "reuse_valid"
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.hierarchy.getBreadcrumbs.mockResolvedValue(new Map([[sourceId, [{ id: sourceId }]]]));
  mocks.hierarchy.createBatch.mockResolvedValue({ id: "batch-1" });
  mocks.hierarchy.ensureCurrentDocumentRevision.mockResolvedValue("revision-1");
  mocks.hierarchy.listDescendants.mockResolvedValue([]);
  mocks.hierarchy.getArtifactState.mockResolvedValue({});
  mocks.runs.create.mockResolvedValue({ id: "run-1" });
  mocks.runs.findById.mockResolvedValue({ stagesCheckpoint: {} });
  mocks.jobs.create.mockResolvedValue({ id: "job-1" });
  mocks.documents.listBySourceItem.mockResolvedValue([
    { id: "document-1", canonicalMarkdown: "# Text", contentHash: "hash-1", metadata: {} }
  ]);
});

const admit = (plan: ProcessingPlanRequest = fullKnowledge) =>
  new HierarchicalIngestionService({ getPool: () => ({}) as PgPool }).process({
    plan,
    runKind: "initial"
  });

describe("full-knowledge admission without the legacy wiki stage (F2 D14)", () => {
  it("admits a full-knowledge source with no organization stage, policy lookup or skip", async () => {
    const queued = await admit();

    expect(queued.queued).toHaveLength(1);
    // Admission no longer consults the legacy curator policy at all.
    expect(mocks.settings.get).not.toHaveBeenCalled();
    expect(mocks.curator.policy).not.toHaveBeenCalled();
    expect(mocks.runs.skipStage).not.toHaveBeenCalled();
    const run = mocks.runs.create.mock.calls[0]![0];
    expect(run.requestedStages).not.toContain("organizeKnowledge");
    expect(run.effectiveStages).not.toContain("organizeKnowledge");
    expect(run.effectiveStages).toContain("sourceMatching");
    expect(mocks.runs.initializeStages.mock.calls[0]![2]).not.toContain("organizeKnowledge");
    const batch = mocks.hierarchy.createBatch.mock.calls[0]![0];
    expect(batch.effectivePlan.effectiveStages).not.toContain("organizeKnowledge");
    expect(batch.effectivePlan).not.toHaveProperty("integrateWiki");
    expect(batch.effectivePlan).not.toHaveProperty("organization");
    expect(batch.promptPin).toBeUndefined();
    const job = mocks.jobs.create.mock.calls[0]![0];
    expect(job.payload.effectiveStages).not.toContain("organizeKnowledge");
  });

  it("admits a saved custom plan that still names the retired stage without it", async () => {
    const saved = ProcessingPlanRequestSchema.parse({
      ...fullKnowledge,
      preset: "custom",
      requestedStages: ["atomicNotes", "organizeKnowledge"]
    });
    await admit(saved);

    const run = mocks.runs.create.mock.calls[0]![0];
    expect(run.requestedStages).toEqual(["atomicNotes"]);
    expect(run.effectiveStages).not.toContain("organizeKnowledge");
    expect(mocks.runs.skipStage).not.toHaveBeenCalled();
  });
});
