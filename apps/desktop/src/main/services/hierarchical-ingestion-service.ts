import {
  DocumentDivisionCandidateSchema,
  ProcessingStages,
  resolveProcessingPlan,
  validateDivisionTree,
  type DocumentDivisionCandidate,
  type EffectiveProcessingPlan,
  type ProcessingPlanRequest
} from "@app/domain";
import {
  createDocumentRepository,
  createHierarchicalIngestionRepository,
  createIngestionRunRepository,
  createJobRepository,
  type PgPool
} from "@app/db";
import type { StructureDetectionResult } from "@app/conversion";

const executableStages = [
  "chunking",
  "embedding",
  "summarization",
  "atomicNotes",
  "knowledgeGraph",
  "atomicNoteMatching",
  "obsidianProjection"
] as const;

export interface HierarchicalIngestionServiceOptions {
  getPool: () => PgPool | null;
}

export class HierarchicalIngestionService {
  public constructor(private readonly options: HierarchicalIngestionServiceOptions) {}

  public async createStructureDraft(
    rootSourceItemId: string,
    rootDocumentId: string,
    detection: StructureDetectionResult
  ) {
    return createHierarchicalIngestionRepository(this.requirePool()).createDraft({
      rootSourceItemId,
      rootDocumentId,
      format: detection.format,
      detectorVersion: detection.detectorVersion,
      overallConfidence: detection.overallConfidence,
      rawEvidence: { warnings: detection.warnings, metadata: detection.metadata },
      divisions: detection.divisions
    });
  }

  public async getStructure(structureId: string) {
    return createHierarchicalIngestionRepository(this.requirePool()).findById(structureId);
  }

  public async saveStructure(structureId: string, divisions: DocumentDivisionCandidate[]) {
    const parsed = divisions.map((division) => DocumentDivisionCandidateSchema.parse(division));
    const repository = createHierarchicalIngestionRepository(this.requirePool());
    const saved = await repository.saveDraft(structureId, parsed);
    if (!saved) throw new Error("structure_not_editable");
    const structure = await repository.findById(structureId);
    if (!structure) throw new Error("structure_not_found");
    return structure;
  }

  public async confirmStructure(input: {
    structureId: string;
    divisions: DocumentDivisionCandidate[];
    plan: ProcessingPlanRequest;
  }) {
    const divisions = input.divisions.map((division) => DocumentDivisionCandidateSchema.parse(division));
    const issues = validateDivisionTree(divisions);
    const blocking = issues.filter((issue) => issue.code !== "empty_range");
    if (blocking.length > 0) {
      const error = new Error("structure_validation_failed");
      Object.assign(error, { issues: blocking });
      throw error;
    }
    const repository = createHierarchicalIngestionRepository(this.requirePool());
    const saved = await repository.saveDraft(input.structureId, divisions);
    if (!saved) throw new Error("structure_not_editable");
    await repository.confirm(input.structureId);
    const materialized = await repository.materializeStructure(input.structureId);
    const plan = resolveProcessingPlan(input.plan);
    const batch = await this.queueSources(
      materialized.map((item) => item.sourceItemId),
      plan,
      "initial",
      "interactive_import"
    );
    return { structure: await repository.findById(input.structureId), materialized, ...batch };
  }

  public async process(input: {
    plan: ProcessingPlanRequest;
    runKind: "missing_stages" | "reingestion" | "initial";
    trigger?: "library_action" | "interactive_import" | "integration" | "recovery";
  }) {
    const plan = resolveProcessingPlan(input.plan);
    const repository = createHierarchicalIngestionRepository(this.requirePool());
    const targetIds = new Set(plan.targetSourceItemIds);
    if (plan.scope === "children_only" || plan.scope === "source_and_children") {
      for (const rootId of plan.targetSourceItemIds) {
        for (const child of await repository.listDescendants(rootId)) targetIds.add(child.id);
        if (plan.scope === "children_only") targetIds.delete(rootId);
      }
    }
    return this.queueSources([...targetIds], plan, input.runKind, input.trigger ?? "library_action");
  }

  public async listBatches() {
    return createHierarchicalIngestionRepository(this.requirePool()).listBatches();
  }

  private async queueSources(
    sourceItemIds: string[],
    plan: EffectiveProcessingPlan,
    runKind: "initial" | "missing_stages" | "reingestion",
    trigger: string
  ) {
    const pool = this.requirePool();
    const hierarchy = createHierarchicalIngestionRepository(pool);
    const runs = createIngestionRunRepository(pool);
    const jobs = createJobRepository(pool);
    const documents = createDocumentRepository(pool);
    const uniqueSourceIds = [...new Set(sourceItemIds)];
    const batch = await hierarchy.createBatch({
      trigger,
      requestedPlan: plan,
      effectivePlan: plan,
      reingestionPolicy: plan.previousArtifactPolicy,
      targetSourceItemIds: uniqueSourceIds
    });
    const queued: Array<{ sourceItemId: string; documentId: string; ingestionRunId: string; jobId: string | null }> = [];
    for (const sourceItemId of uniqueSourceIds) {
      const sourceDocuments = await documents.listBySourceItem(sourceItemId);
      const document = sourceDocuments[0];
      if (!document) continue;
      const revisionId = await hierarchy.ensureCurrentDocumentRevision(document.id, document.contentHash);
      if (runKind === "reingestion" && plan.previousArtifactPolicy === "preserve_reviewed_archive_pending") {
        await pool.query(
          `update atomic_notes set status = 'archived', supersession_status = 'superseded', updated_at = now()
           where created_from_source_item_id = $1 and status = 'pending_review'`,
          [sourceItemId]
        );
      }
      const run = await runs.create({
        sourceItemId,
        batchId: batch.id,
        runKind,
        requestedStages: plan.requestedStages,
        effectiveStages: plan.effectiveStages,
        planVersion: plan.planVersion,
        inputDocumentRevisionId: revisionId,
        inputHashes: { contentHash: document.contentHash },
        previousArtifactPolicy: plan.previousArtifactPolicy,
        trigger,
        currentStage: "queued"
      });
      await runs.initializeStages(run.id, plan.effectiveStages, ProcessingStages);
      const artifactState = await hierarchy.getArtifactState(sourceItemId, document.id);
      for (const stage of ["conversion", "structureDetection", "structureReview", "materialization"] as const) {
        if (plan.effectiveStages.includes(stage)) await runs.completeStage(run.id, stage, { reused: true });
      }
      if (!plan.forceRegeneration && plan.previousArtifactPolicy === "reuse_valid") {
        for (const stage of executableStages) {
          if (plan.effectiveStages.includes(stage) && artifactState[stage]) {
            await runs.completeStage(run.id, stage, { reused: true });
          }
        }
      }
      if (plan.effectiveStages.includes("chunking") && artifactState.chunking) {
        await runs.completeStage(run.id, "chunking", { reused: true, reason: "same_document_revision" });
      }
      const refreshed = await runs.findById(run.id);
      const pending = executableStages.filter((stage) =>
        plan.effectiveStages.includes(stage)
        && (refreshed?.stagesCheckpoint[stage] as { status?: string } | undefined)?.status !== "completed"
      );
      let jobId: string | null = null;
      if (pending.length > 0) {
        const job = await jobs.create({
          type: "ingestion",
          payload: {
            ingestionRunId: run.id,
            batchId: batch.id,
            sourceItemId,
            documentId: document.id,
            markdown: document.canonicalMarkdown,
            effectiveStages: plan.effectiveStages
          }
        });
        jobId = job.id;
        await runs.update(run.id, { jobId: job.id, currentStage: pending[0]! });
      } else {
        await runs.complete(run.id);
      }
      queued.push({ sourceItemId, documentId: document.id, ingestionRunId: run.id, jobId });
    }
    await hierarchy.refreshBatch(batch.id);
    return { batchId: batch.id, queued };
  }

  private requirePool(): PgPool {
    const pool = this.options.getPool();
    if (!pool) throw new Error("database_not_ready");
    return pool;
  }
}
