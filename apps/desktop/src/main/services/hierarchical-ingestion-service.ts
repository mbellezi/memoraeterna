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
  createSourceItemRepository,
  type PgPool
} from "@app/db";
import { sha256, type StructureDetectionResult } from "@app/conversion";

const executableStages = [
  "chunking",
  "embedding",
  "summarization",
  "atomicNotes",
  "knowledgeGraph",
  "atomicNoteMatching",
  "obsidianProjection"
] as const;

const catalogMetadataProcessingMode = "catalog_metadata";

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
    const pool = this.requirePool();
    const structure = await createHierarchicalIngestionRepository(pool).findById(structureId);
    if (!structure) return null;
    const document = await createDocumentRepository(pool).findById(structure.rootDocumentId);
    const rootMarkdown = document?.canonicalMarkdown ?? "";
    return { ...structure, rootMarkdown, boundaries: structureBoundaries(rootMarkdown, structure.divisions) };
  }

  public async saveStructure(structureId: string, divisions: DocumentDivisionCandidate[]) {
    const parsed = divisions.map((division) => DocumentDivisionCandidateSchema.parse(division));
    const repository = createHierarchicalIngestionRepository(this.requirePool());
    const saved = await repository.saveDraft(structureId, parsed);
    if (!saved) throw new Error("structure_not_editable");
    const structure = await this.getStructure(structureId);
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
    const structure = await repository.findById(input.structureId);
    if (!structure) throw new Error("structure_not_found");
    const plan = resolveProcessingPlan(input.plan);
    const batch = await this.queueSources(
      materialized.map((item) => item.sourceItemId),
      plan,
      "initial",
      "interactive_import",
      [structure.rootSourceItemId]
    );
    return { structure, materialized, ...batch };
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
    const breadcrumbs = await repository.getBreadcrumbs([...targetIds]);
    const targets = splitHierarchicalProcessingTargets([...targetIds], breadcrumbs);
    return this.queueSources(
      targets.contentSourceItemIds,
      plan,
      input.runKind,
      input.trigger ?? "library_action",
      targets.catalogParentIds
    );
  }

  public async listBatches() {
    return createHierarchicalIngestionRepository(this.requirePool()).listBatches();
  }

  private async queueSources(
    sourceItemIds: string[],
    plan: EffectiveProcessingPlan,
    runKind: "initial" | "missing_stages" | "reingestion",
    trigger: string,
    catalogParentIds: string[] = []
  ) {
    const pool = this.requirePool();
    const hierarchy = createHierarchicalIngestionRepository(pool);
    const runs = createIngestionRunRepository(pool);
    const jobs = createJobRepository(pool);
    const documents = createDocumentRepository(pool);
    const sources = createSourceItemRepository(pool);
    const catalogStages = catalogMetadataStages(plan.effectiveStages);
    const catalogIds = catalogStages.length > 0 ? new Set(catalogParentIds) : new Set<string>();
    const uniqueSourceIds = [...new Set([...sourceItemIds, ...catalogIds])];
    const batch = await hierarchy.createBatch({
      trigger,
      requestedPlan: plan,
      effectivePlan: plan,
      reingestionPolicy: plan.previousArtifactPolicy,
      targetSourceItemIds: uniqueSourceIds
    });
    const queued: Array<{ sourceItemId: string; documentId: string; ingestionRunId: string; jobId: string | null }> = [];
    for (const sourceItemId of uniqueSourceIds) {
      const catalogMetadataOnly = catalogIds.has(sourceItemId);
      const source = catalogMetadataOnly ? await sources.findById(sourceItemId) : null;
      if (catalogMetadataOnly && !source) continue;
      const catalogInput = catalogMetadataOnly
        ? await prepareCatalogMetadataDocument(documents, source!)
        : null;
      const document = catalogInput?.document ?? (await documents.listBySourceItem(sourceItemId))[0];
      if (!document) continue;
      const processingMarkdown = catalogInput?.markdown ?? document.canonicalMarkdown;
      const revisionId = await hierarchy.ensureCurrentDocumentRevision(document.id, document.contentHash);
      const effectiveStages = catalogMetadataOnly ? catalogStages : plan.effectiveStages;
      const requestedStages = catalogMetadataOnly
        ? effectiveStages.filter((stage) => stage !== "chunking")
        : plan.requestedStages;
      if (!catalogMetadataOnly && runKind === "reingestion" && plan.previousArtifactPolicy === "preserve_reviewed_archive_pending") {
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
        requestedStages,
        effectiveStages,
        planVersion: plan.planVersion,
        inputDocumentRevisionId: revisionId,
        inputHashes: { contentHash: catalogMetadataOnly ? sha256(processingMarkdown) : document.contentHash },
        previousArtifactPolicy: plan.previousArtifactPolicy,
        trigger,
        currentStage: "queued"
      });
      await runs.initializeStages(run.id, effectiveStages, ProcessingStages);
      const artifactState = catalogMetadataOnly ? {} : await hierarchy.getArtifactState(sourceItemId, document.id);
      for (const stage of ["conversion", "structureDetection", "structureReview", "materialization"] as const) {
        if (effectiveStages.includes(stage)) await runs.completeStage(run.id, stage, { reused: true });
      }
      if (!catalogMetadataOnly && !plan.forceRegeneration && plan.previousArtifactPolicy === "reuse_valid") {
        for (const stage of executableStages) {
          if (effectiveStages.includes(stage) && artifactState[stage]) {
            await runs.completeStage(run.id, stage, { reused: true });
          }
        }
      }
      if (effectiveStages.includes("chunking") && artifactState.chunking) {
        await runs.completeStage(run.id, "chunking", { reused: true, reason: "same_document_revision" });
      }
      const refreshed = await runs.findById(run.id);
      const pending = executableStages.filter((stage) =>
        effectiveStages.includes(stage)
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
            markdown: processingMarkdown,
            effectiveStages,
            processingMode: catalogMetadataOnly ? catalogMetadataProcessingMode : "content"
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

export function catalogMetadataStages(stages: readonly string[]) {
  const selected = ["embedding", "knowledgeGraph"].filter((stage) => stages.includes(stage));
  return selected.length > 0 ? ["chunking", ...selected] : [];
}

export function splitHierarchicalProcessingTargets(
  sourceItemIds: readonly string[],
  breadcrumbs: ReadonlyMap<string, ReadonlyArray<{ id: string }>>
) {
  const contentSourceItemIds = new Set(sourceItemIds);
  const catalogParentIds = new Set<string>();
  for (const sourceItemId of sourceItemIds) {
    const path = breadcrumbs.get(sourceItemId) ?? [];
    const root = path.length > 1 ? path[0] : undefined;
    if (root) catalogParentIds.add(root.id);
  }
  for (const parentId of catalogParentIds) contentSourceItemIds.delete(parentId);
  return {
    contentSourceItemIds: [...contentSourceItemIds],
    catalogParentIds: [...catalogParentIds]
  };
}

export function buildCatalogMetadataMarkdown(source: {
  type: string;
  title: string;
  subtitle: string | null;
  sourceUri: string | null;
  language: string;
  summary: string | null;
  metadata: Record<string, unknown>;
}): string {
  const descriptor = asObject(source.metadata.descriptor);
  const creators = Array.isArray(descriptor.creators)
    ? descriptor.creators.flatMap((creator) => {
        const value = asObject(creator);
        return typeof value.name === "string" && value.name.trim()
          ? [{ name: value.name.trim(), ...(typeof value.role === "string" ? { role: value.role } : {}) }]
          : [];
      })
    : [];
  const excluded = new Set(["type", "title", "subtitle", "creators", "provenance", "cover", "parentSourceItemId"]);
  const metadata = Object.fromEntries(Object.entries(descriptor).filter(([key]) => !excluded.has(key)));
  return JSON.stringify({
    sourceType: source.type,
    title: source.title,
    ...(source.subtitle ? { subtitle: source.subtitle } : {}),
    creators,
    language: source.language,
    ...(source.summary ? { summary: source.summary } : {}),
    ...(source.sourceUri ? { sourceUri: source.sourceUri } : {}),
    metadata
  }, null, 2);
}

async function prepareCatalogMetadataDocument(
  documents: ReturnType<typeof createDocumentRepository>,
  source: Parameters<typeof buildCatalogMetadataMarkdown>[0] & { id: string }
) {
  const markdown = buildCatalogMetadataMarkdown(source);
  const contentHash = sha256(markdown);
  const sourceDocuments = await documents.listBySourceItem(source.id);
  const canonical = sourceDocuments.find(
    (document) => document.metadata.processingMode !== catalogMetadataProcessingMode
  );
  if (canonical) return { document: canonical, markdown };
  const existing = sourceDocuments.find(
    (document) => document.metadata.processingMode === catalogMetadataProcessingMode
  );
  if (existing) {
    const document = await documents.update(existing.id, {
      title: source.title,
      canonicalMarkdown: markdown,
      contentHash,
      language: source.language,
      metadata: { processingMode: catalogMetadataProcessingMode }
    });
    return document ? { document, markdown } : null;
  }
  const document = await documents.create({
    sourceItemId: source.id,
    title: source.title,
    canonicalMarkdown: markdown,
    contentHash,
    language: source.language,
    metadata: { processingMode: catalogMetadataProcessingMode }
  });
  return { document, markdown };
}

function asObject(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function structureBoundaries(
  markdown: string,
  divisions: Array<{
    title: string;
    markdownStart?: number | undefined;
    markdownEnd?: number | undefined;
    startPage?: number | undefined;
    endPage?: number | undefined;
  }>
) {
  const boundaries = new Map<number, { offset: number; label: string; kind: "heading" | "division" | "page"; page?: number }>();
  for (const match of markdown.matchAll(/^(#{1,6})\s+(.+)$/gm)) {
    boundaries.set(match.index, { offset: match.index, label: match[2]!.trim(), kind: "heading" });
  }
  for (const division of divisions) {
    if (division.markdownStart !== undefined && !boundaries.has(division.markdownStart)) {
      boundaries.set(division.markdownStart, {
        offset: division.markdownStart, label: division.title,
        kind: division.startPage ? "page" : "division",
        ...(division.startPage ? { page: division.startPage } : {})
      });
    }
    if (division.markdownEnd !== undefined && !boundaries.has(division.markdownEnd)) {
      boundaries.set(division.markdownEnd, {
        offset: division.markdownEnd,
        label: division.endPage ? `Page ${division.endPage}` : division.title,
        kind: division.endPage ? "page" : "division",
        ...(division.endPage ? { page: division.endPage } : {})
      });
    }
  }
  boundaries.set(0, { offset: 0, label: "Document start", kind: "division" });
  boundaries.set(markdown.length, { offset: markdown.length, label: "Document end", kind: "division" });
  return [...boundaries.values()].sort((left, right) => left.offset - right.offset);
}
