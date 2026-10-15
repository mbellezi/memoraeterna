import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PgPool } from "@app/db";
import { resolveProcessingPlan, type ProcessingPlanRequest } from "@app/domain";

import {
  HierarchicalIngestionService,
  organizeKnowledgeSkipReason,
  resolveOrganizeKnowledgeAdmission
} from "./hierarchical-ingestion-service.js";

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
const policy = { id: "policy-1", revisionId: "revision-1" };

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

const admit = () =>
  new HierarchicalIngestionService({ getPool: () => ({}) as PgPool }).process({
    plan: fullKnowledge,
    runKind: "initial"
  });

describe("organizeKnowledge admission", () => {
  it("integrates the wiki under the curator policy when one exists", () => {
    const plan = resolveProcessingPlan(fullKnowledge);
    const admitted = resolveOrganizeKnowledgeAdmission(plan, policy);
    expect(admitted.organizationSkipped).toBe(false);
    expect(admitted.plan.effectiveStages).toEqual(plan.effectiveStages);
    expect(admitted.plan.integrateWiki).toEqual({
      version: 2,
      policyId: "policy-1",
      policyRevisionId: "revision-1"
    });
  });

  it("drops only organizeKnowledge from the executed stages without a policy", () => {
    const plan = resolveProcessingPlan(fullKnowledge);
    const admitted = resolveOrganizeKnowledgeAdmission(plan, null);
    expect(admitted.organizationSkipped).toBe(true);
    expect(admitted.plan.effectiveStages).toEqual(
      plan.effectiveStages.filter((stage) => stage !== "organizeKnowledge")
    );
    expect(admitted.plan.requestedStages).toContain("organizeKnowledge");
    expect(admitted.plan.integrateWiki).toBeUndefined();
  });

  it("admits a full-knowledge source without a policy and records the stage as skipped", async () => {
    mocks.settings.get.mockResolvedValue(null);
    const queued = await admit();

    expect(queued.queued).toHaveLength(1);
    expect(mocks.curator.policy).not.toHaveBeenCalled();
    const run = mocks.runs.create.mock.calls[0]![0];
    expect(run.requestedStages).toContain("organizeKnowledge");
    expect(run.effectiveStages).not.toContain("organizeKnowledge");
    expect(run.effectiveStages).toContain("sourceMatching");
    expect(mocks.runs.skipStage).toHaveBeenCalledExactlyOnceWith(
      "run-1",
      "organizeKnowledge",
      organizeKnowledgeSkipReason
    );
    expect(organizeKnowledgeSkipReason).toBe("no_policy");
    // The batch has no organization to wait for, and the job does not run the stage.
    const batch = mocks.hierarchy.createBatch.mock.calls[0]![0];
    expect(batch.effectivePlan.effectiveStages).not.toContain("organizeKnowledge");
    expect(batch.effectivePlan.integrateWiki).toBeUndefined();
    expect(batch.promptPin).toBeUndefined();
    const job = mocks.jobs.create.mock.calls[0]![0];
    expect(job.payload.effectiveStages).not.toContain("organizeKnowledge");
  });

  it("treats a policy setting whose policy no longer exists as no policy", async () => {
    mocks.settings.get.mockResolvedValue({ policyId: "policy-1" });
    mocks.curator.policy.mockResolvedValue(null);
    await admit();
    expect(mocks.runs.skipStage).toHaveBeenCalledExactlyOnceWith(
      "run-1",
      "organizeKnowledge",
      organizeKnowledgeSkipReason
    );
  });

  it("keeps the integrated wiki stage when a policy exists", async () => {
    mocks.settings.get.mockResolvedValue({ policyId: "policy-1" });
    mocks.curator.policy.mockResolvedValue(policy);
    await admit();

    expect(mocks.runs.skipStage).not.toHaveBeenCalled();
    expect(mocks.runs.create.mock.calls[0]![0].effectiveStages).toContain("organizeKnowledge");
    const batch = mocks.hierarchy.createBatch.mock.calls[0]![0];
    expect(batch.effectivePlan.integrateWiki).toEqual({
      version: 2,
      policyId: "policy-1",
      policyRevisionId: "revision-1"
    });
    expect(batch.promptPin).toBeDefined();
    expect(mocks.jobs.create.mock.calls[0]![0].payload.effectiveStages).toContain(
      "organizeKnowledge"
    );
  });
});
