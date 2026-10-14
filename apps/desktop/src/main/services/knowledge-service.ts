import {
  renderPrompt,
  capturePromptPin,
  promptFingerprint,
  stagePromptFingerprints,
  changedPromptIdentity
} from "./prompt-runtime.js";
import { contentKey } from "./content-order.js";
import { noteMatchDecisionOperations, withAiTaskParameterDefaults } from "./ai-task-parameters.js";
import { createEntityIdentityResolver } from "./entity-identity-resolution.js";
import { matchSources } from "./source-relation-processing.js";
import {
  AtomicNoteMatchingSettingsSchema,
  AtomicNoteRelationTypeSchema,
  type AtomicNoteRelationType,
  CanonicalMatchingSettingsSchema,
  type AtomicNoteMatchingSettings,
  type CanonicalMatchingSettings,
  SourceRelationSettingsSchema,
  type SourceRelationSettings
} from "@app/domain";
import {
  createRelationTypeResolver,
  defaultRelationTypeSimilarityThreshold
} from "./relation-type-resolution.js";
import { sha256 } from "@app/conversion";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  createAiConfigRepository,
  createAtomicNoteRelationRepository,
  createRelationDecisionRepository,
  createSourceRelationRepository,
  listSourceRelations,
  createAtomicNoteRepository,
  createChunkRepository,
  createDocumentAssetRepository,
  createDocumentRepository,
  createEmbeddingRepository,
  createHierarchicalIngestionRepository,
  createLibraryRepository,
  createKnowledgeGraphRepository,
  createKnowledgeGraphDashboardRepository,
  createSimilarityDebugRepository,
  createSourceItemRepository,
  createSourceSummaryRepository,
  type AtomicNoteGraphElements,
  type AtomicNoteRecord,
  type PgPool,
  type RelationDecisionInput,
  type SourceItemType
} from "@app/db";

import type { AiService, AiTaskLogContext, DefaultAiTaskResult } from "./ai-service.js";
import { SourceDeletionService } from "./source-deletion-service.js";
import { logStructuredError } from "./structured-logging.js";
import type { LibraryBrowseInput, StorageSettings } from "../../shared/ipc.js";
import {
  atomicNoteDecisionContentHash,
  atomicNoteDeciderKey,
  atomicNoteMatchingVersion,
  atomicNotePromptVersion,
  atomicNoteVerdictQualifies,
  buildAggregateSummaryPrompt,
  buildBatchRerankPrompt,
  calculateAtomicNoteMatchingProgress,
  canQualifyAtomicNoteRelation,
  defaultSummaryMinimumWordCount,
  fuseAtomicNoteCandidateRankings,
  generateAtomicNoteCandidates,
  generateKnowledgeGraphFromAtomicNotes,
  generateSummaryFromChunks,
  hierarchyAggregateSummaryPromptVersion,
  mergeBatchRerankRepair,
  normalizeSummaryText,
  parseBatchRerankOutput,
  resolveAtomicNoteReferences,
  scoreMetadataOverlap,
  selectAtomicNoteRelations,
  knowledgeGraphPromptVersion,
  parseKnowledgeGraphBatchCheckpoints,
  summaryPromptVersion,
  type BatchRerankDecision,
  type KnowledgeGraphBatchCheckpoint,
  type KnowledgeAiExecution
} from "./knowledge-processing.js";

const maxInlineAssetBytes = 5 * 1024 * 1024;

function aggregateSourceLabel(type: SourceItemType): string {
  if (type === "Book") return "book";
  if (type === "PeriodicalIssue") return "periodical issue";
  if (type === "AcademicPaper") return "academic paper";
  if (type === "StandaloneArticle" || type === "WebArticle") return "article";
  return "source";
}

interface HierarchySummaryRow {
  rootId: string;
  rootType: SourceItemType;
  rootTitle: string;
  rootLanguage: string;
  documentId: string;
  documentHash: string;
  childId: string;
  childTitle: string;
  summaryId: string | null;
  summary: string | null;
  summaryHash: string | null;
}

function updateGroupedChildSummary(
  grouped: ReadonlyMap<string, HierarchySummaryRow[]>,
  childId: string,
  summary: { id: string; summary: string; hash: string } | null
): void {
  for (const children of grouped.values()) {
    for (const child of children) {
      if (child.childId !== childId) continue;
      child.summaryId = summary?.id ?? null;
      child.summary = summary?.summary ?? null;
      child.summaryHash = summary?.hash ?? null;
    }
  }
}

export interface KnowledgeServiceOptions {
  getPool: () => PgPool | null;
  aiService: AiService;
  relationThreshold?: number;
  getRelationThreshold?: () => Promise<number>;
  getAtomicNoteMatchingSettings?: () => Promise<AtomicNoteMatchingSettings>;
  getCanonicalMatchingSettings?: () => Promise<CanonicalMatchingSettings>;
  getSourceRelationSettings?: () => Promise<SourceRelationSettings>;
  getSummaryMinimumWordCount?: () => Promise<number>;
  getContentLanguage?: () => Promise<string>;
  getEntityIdentitySimilarityThreshold?: () => Promise<number>;
  getRelationTypeSimilarityThreshold?: () => Promise<number>;
  getKnowledgeGraphLimits?: () => Promise<{ maxEntities: number; maxRelations: number }>;
  summaryMaxInputCharacters?: number;
  knowledgeGraphMaxInputCharacters?: number;
  userDataPath: string;
  getStorageSettings: () => Promise<StorageSettings>;
  getUploadedFilesBasePath: () => Promise<string | null>;
  isDebugEnabled?: () => Promise<boolean>;
  logger?: Pick<Console, "error" | "warn">;
}

export interface AtomicNoteGenerationLogContext {
  jobId?: string;
  ingestionRunId?: string;
  onProgress?: (progress: number) => void;
}

export interface KnowledgeGraphGenerationContext {
  jobId?: string;
  ingestionRunId?: string;
  includeAtomicNotesGraph?: boolean;
  completedBatches?: unknown;
  onProgress?: (progress: number) => void;
  onBatchCompleted?: (input: {
    completed: number;
    total: number;
    checkpoints: KnowledgeGraphBatchCheckpoint[];
  }) => Promise<void>;
}

export class KnowledgeService {
  private readonly relationThreshold: number;
  private readonly summaryMaxInputCharacters: number;
  private readonly knowledgeGraphMaxInputCharacters: number;
  private readonly sourceDeletionService: SourceDeletionService;

  public constructor(private readonly options: KnowledgeServiceOptions) {
    this.relationThreshold = clamp(options.relationThreshold ?? 0.72);
    this.summaryMaxInputCharacters = Math.max(2_000, options.summaryMaxInputCharacters ?? 12_000);
    this.knowledgeGraphMaxInputCharacters = Math.max(
      2_000,
      options.knowledgeGraphMaxInputCharacters ?? 3_500
    );
    this.sourceDeletionService = new SourceDeletionService({
      getPool: options.getPool,
      getStorageSettings: options.getStorageSettings,
      userDataPath: options.userDataPath,
      ...(options.logger ? { logger: options.logger } : {})
    });
  }

  public async browseLibrary(input: LibraryBrowseInput) {
    const query = input.query?.trim() ?? "";
    let queryEmbedding: number[] | undefined;
    let embeddingModel: string | undefined;
    let embeddingIdentity:
      | { embeddingSpaceKey: string; embeddingProvider: string; embeddingRuntime: string }
      | undefined;
    if (query && input.searchMode !== "traditional") {
      try {
        const generated = await this.options.aiService.runDefaultTask("embedding", query, {
          stage: "library_search",
          embeddingInputType: "query"
        });
        if (generated && Array.isArray(generated.output)) {
          const candidate = generated.output.map(Number);
          if (
            (candidate.length === 256 || candidate.length === 768 || candidate.length === 1_024) &&
            candidate.every(Number.isFinite)
          ) {
            queryEmbedding = candidate;
            embeddingModel = generated.modelId;
            embeddingIdentity = {
              embeddingSpaceKey: generated.embeddingSpaceKey ?? "",
              embeddingProvider: generated.providerId,
              embeddingRuntime: generated.runtime
            };
          }
        }
      } catch {
        // Traditional catalog search remains available when vector search is unavailable.
      }
    }
    return (
      await createLibraryRepository(this.requirePool()).listSources({
        ...input,
        query,
        ...(queryEmbedding && embeddingModel
          ? { queryEmbedding, embeddingModel, ...embeddingIdentity }
          : {})
      })
    ).map((source) => ({
      ...source,
      summary: source.summary ? normalizeSummaryText(source.summary) : null,
      updatedAt: source.updatedAt.toISOString()
    }));
  }

  public async getGraphDashboard(
    mode: "sources" | "atomic_notes",
    sourceView: "relations" | "entities" = "relations"
  ) {
    return createKnowledgeGraphDashboardRepository(this.requirePool()).get(mode, sourceView);
  }

  public async listSourceRelations(input: {
    sourceItemId: string;
    targetSourceItemId: string | null;
    offset: number;
    limit: number;
    relationId?: string | undefined;
  }) {
    return listSourceRelations(
      this.requirePool(),
      input.sourceItemId,
      input.targetSourceItemId,
      input.offset,
      input.limit,
      input.relationId
    );
  }

  public async reviewSourceRelation(input: {
    id: string;
    status: string;
    expectedUpdatedAt: string;
  }) {
    return createSourceRelationRepository(this.requirePool()).review(
      input.id,
      input.status,
      input.expectedUpdatedAt
    );
  }

  public async matchSourceRelations(
    sourceIds: string[],
    runKey: string,
    signal?: AbortSignal,
    onProgress?: (
      progress: number,
      counts: { completed: number; total: number }
    ) => void | Promise<void>,
    context: AiTaskLogContext = {},
    regenerate = false
  ) {
    return matchSources({
      pool: this.requirePool(),
      ai: this.options.aiService,
      sourceIds,
      runKey,
      settings: SourceRelationSettingsSchema.parse(
        (await this.options.getSourceRelationSettings?.()) ?? {}
      ),
      contentLanguage: (await this.options.getContentLanguage?.()) ?? "en",
      regenerate,
      ...(signal ? { signal } : {}),
      ...(onProgress ? { onProgress } : {}),
      context
    });
  }

  public async getGraphSourceConnectionDetails(sourceItemId: string, targetSourceItemId: string) {
    return createKnowledgeGraphDashboardRepository(this.requirePool()).getSourceConnectionDetails(
      sourceItemId,
      targetSourceItemId
    );
  }

  public async listLibrary(sourceTypes: SourceItemType[] = []) {
    return (await createLibraryRepository(this.requirePool()).listSources({ sourceTypes })).map(
      (source) => ({
        ...source,
        summary: source.summary ? normalizeSummaryText(source.summary) : null,
        updatedAt: source.updatedAt.toISOString()
      })
    );
  }

  public async getSourceDocument(input: { sourceItemId: string; documentId: string }) {
    const document = await createDocumentRepository(this.requirePool()).findById(input.documentId);
    if (!document || document.sourceItemId !== input.sourceItemId)
      throw new Error("errors.common.validationFailed");
    return { title: document.title, markdown: document.canonicalMarkdown };
  }

  public async getSourceDetail(sourceItemId: string) {
    const pool = this.requirePool();
    const source = await createSourceItemRepository(pool).findById(sourceItemId);
    if (!source) return null;
    const documents = await createDocumentRepository(pool).listBySourceItem(sourceItemId);
    const sourceAssets = await createDocumentAssetRepository(pool).listBySourceItem(sourceItemId);
    const documentDetails = await Promise.all(
      documents.map(async (document) => ({
        id: document.id,
        title: document.title,
        canonicalMarkdown: document.canonicalMarkdown,
        language: document.language,
        chunks: (await createChunkRepository(pool).listByDocument(document.id)).map((chunk) => ({
          id: chunk.id,
          content: chunk.content,
          chunkIndex: chunk.chunkIndex,
          sourceSpanId: chunk.sourceSpanId
        })),
        assets: (await createDocumentAssetRepository(pool).listByDocument(document.id)).map(
          (asset) => ({
            id: asset.id,
            originalFileName: asset.originalFileName,
            mimeType: asset.mimeType,
            role: asset.role
          })
        )
      }))
    );
    const notes = await createAtomicNoteRepository(pool).listBySourceItem(sourceItemId);
    const relations = await createAtomicNoteRelationRepository(pool).listBySourceItem(sourceItemId);
    const summaries = await createSourceSummaryRepository(pool).listBySourceItem(sourceItemId);
    const graph = await createKnowledgeGraphRepository(pool).listSourceElements(sourceItemId);
    return {
      history: (await createDocumentRepository(pool).listHistory(source.id)).map((item) => ({
        ...item,
        createdAt: item.createdAt.toISOString()
      })),
      breadcrumbs:
        (await createHierarchicalIngestionRepository(pool).getBreadcrumbs([source.id])).get(
          source.id
        ) ?? [],
      parentSourceItemId: source.parentSourceItemId,
      id: source.id,
      type: source.type,
      title: source.title,
      subtitle: source.subtitle,
      sourceUri: source.sourceUri,
      language: source.language,
      summary: source.summary ? normalizeSummaryText(source.summary) : null,
      metadata: source.metadata,
      updatedAt: source.updatedAt.toISOString(),
      assets: sourceAssets.map((asset) => ({
        id: asset.id,
        originalFileName: asset.originalFileName,
        mimeType: asset.mimeType,
        role: asset.role
      })),
      documents: documentDetails,
      summaries: summaries.map((summary) => ({
        id: summary.id,
        summary: normalizeSummaryText(summary.summary),
        provider: summary.provider,
        model: summary.model,
        promptVersion: summary.promptVersion,
        generatedAt: summary.generatedAt.toISOString()
      })),
      atomicNotes: notes.map(serializeNote),
      graph,
      relations: relations.map((relation) => ({
        id: relation.id,
        sourceAtomicNoteId: relation.sourceAtomicNoteId,
        targetAtomicNoteId: relation.targetAtomicNoteId,
        sourceTitle: relation.sourceTitle,
        targetTitle: relation.targetTitle,
        sourceStatus: relation.sourceStatus,
        targetStatus: relation.targetStatus,
        relationType: relation.relationType,
        finalScore: relation.finalScore,
        explanation: relation.explanation
      }))
    };
  }

  public async listSourceTreeIds(sourceItemId: string): Promise<string[]> {
    return this.sourceDeletionService.listSourceTreeIds(sourceItemId);
  }

  public async deleteSource(sourceItemId: string) {
    return this.sourceDeletionService.delete(sourceItemId);
  }

  public async listPendingNotes() {
    const pool = this.requirePool();
    const notes = await createAtomicNoteRepository(pool).listPending();
    return await Promise.all(
      notes.map(async (note) => {
        const source = await createSourceItemRepository(pool).findById(
          note.createdFromSourceItemId
        );
        return { ...serializeNote(note), sourceTitle: source?.title ?? null };
      })
    );
  }

  public async reviewNote(input: {
    expectedUpdatedAt?: string | undefined;
    id: string;
    action: "approve" | "edit" | "discard";
    title?: string | undefined;
    bodyMarkdown?: string | undefined;
    ideaStatement?: string | undefined;
  }) {
    const note = await createAtomicNoteRepository(this.requirePool()).review(input);
    return note ? serializeNote(note) : null;
  }

  public async resolveAssetPath(assetId: string): Promise<string> {
    const asset = await createDocumentAssetRepository(this.requirePool()).findById(assetId);
    if (!asset) throw new Error("errors.common.notFound");
    const basePath =
      asset.storageBase === "app_internal"
        ? join(this.options.userDataPath, "assets")
        : asset.storageBase === "uploaded_files"
          ? await this.options.getUploadedFilesBasePath()
          : null;
    if (!basePath) throw new Error("errors.common.notFound");
    const safeBase = resolve(basePath);
    const absolutePath = resolve(safeBase, asset.relativePath);
    if (absolutePath !== safeBase && !absolutePath.startsWith(`${safeBase}${sep}`)) {
      throw new Error("errors.common.permissionDenied");
    }
    return absolutePath;
  }

  public async getAssetDataUrl(assetId: string): Promise<string | null> {
    try {
      const asset = await createDocumentAssetRepository(this.requirePool()).findById(assetId);
      if (!asset || !asset.mimeType.startsWith("image/") || asset.sizeBytes > maxInlineAssetBytes) {
        return null;
      }
      const absolutePath = await this.resolveAssetPath(assetId);
      const bytes = await readFile(absolutePath);
      return `data:${asset.mimeType};base64,${bytes.toString("base64")}`;
    } catch {
      return null;
    }
  }

  public async summarizeSource(
    sourceItemId: string,
    documentId: string,
    signal?: AbortSignal,
    onProgress?: (progress: number) => void,
    logContext: AiTaskLogContext = {}
  ) {
    const pool = this.requirePool();
    const source = await createSourceItemRepository(pool).findById(sourceItemId);
    const document = await createDocumentRepository(pool).findById(documentId);
    if (
      !source ||
      !document ||
      document.metadata.supersededByDocumentId ||
      document.sourceItemId !== source.id
    )
      throw new Error("source_document_not_found");
    const chunks = await createChunkRepository(pool).listByDocument(documentId);
    const summary = await generateSummaryFromChunks(
      chunks.length > 0
        ? chunks.map((chunk) => ({ id: chunk.id, content: chunk.content }))
        : [{ id: document.id, content: document.canonicalMarkdown }],
      async (prompt, callContext) =>
        toKnowledgeExecution(
          await this.options.aiService.runDefaultTask(
            "summarization",
            prompt,
            {
              ...withAiSourceItems(logContext, [sourceItemId]),
              ...callContext,
              documentId,
              onProgress: (event) => onProgress?.(event.progress)
            },
            signal
          )
        ),
      this.summaryMaxInputCharacters,
      Math.max(
        0,
        Math.floor(
          (await this.options.getSummaryMinimumWordCount?.()) ?? defaultSummaryMinimumWordCount
        )
      )
    );
    if (!summary) return { configured: false, generated: false, mapReduce: false };
    if (summary.summary.length === 0) {
      await createSourceSummaryRepository(pool).clearCurrent(sourceItemId);
      await createSourceItemRepository(pool).update(sourceItemId, {
        summary: null,
        summaryGeneratedAt: null
      });
      return {
        configured: true,
        generated: false,
        mapReduce: summary.mapReduce,
        skippedReason: summary.skippedReason ?? "non_content"
      };
    }
    const finalExecution = summary.executions.at(-1);
    if (!finalExecution) throw new Error("summary_execution_missing");
    const summaryHierarchy = createHierarchicalIngestionRepository(pool);
    const summaryRevisionId = await summaryHierarchy.ensureCurrentDocumentRevision(
      document.id,
      document.contentHash
    );
    const summaryGenerationId = await summaryHierarchy.createKnowledgeGeneration({
      sourceItemId,
      documentRevisionId: summaryRevisionId,
      stage: "summarization",
      ingestionRunId:
        typeof logContext.ingestionRunId === "string" ? logContext.ingestionRunId : null,
      jobId: typeof logContext.jobId === "string" ? logContext.jobId : null,
      aiTaskRunId: finalExecution.aiTaskRunId,
      inputHash: sha256(document.canonicalMarkdown),
      metadata: {
        promptVersion: summaryPromptVersion,
        promptFingerprint: stagePromptFingerprints(
          capturePromptPin(),
          false,
          summary.executions.map((e) => e.providerId)
        ).summarization
      }
    });
    const persisted = await createSourceSummaryRepository(pool).create({
      sourceItemId,
      generationId: summaryGenerationId,
      summary: summary.summary,
      language: finalExecution.outputLanguage ?? source.language,
      profileId: finalExecution.profileId,
      aiTaskRunId: finalExecution.aiTaskRunId,
      provider: finalExecution.providerId,
      model: finalExecution.modelId,
      runtime: finalExecution.runtime,
      promptVersion: summaryPromptVersion,
      inputHash: sha256(document.canonicalMarkdown),
      outputHash: sha256(summary.summary),
      metadata: {
        mapReduce: summary.mapReduce,
        executionCount: summary.executions.length,
        concepts: summary.concepts ?? [],
        aiTaskRunIds: summary.executions.map((execution) => execution.aiTaskRunId)
      }
    });
    await createSourceItemRepository(pool).update(sourceItemId, {
      summary: summary.summary,
      summaryGeneratedAt: persisted.generatedAt
    });
    return {
      configured: true,
      generated: true,
      mapReduce: summary.mapReduce,
      sourceSummaryId: persisted.id
    };
  }

  public async summarizeHierarchiesForBatch(
    batchId: string | null,
    signal?: AbortSignal,
    logContext: AiTaskLogContext = {},
    rootSourceItemId: string | null = null,
    forceRegeneration = false
  ) {
    const pool = this.requirePool();
    const rows = await pool.query<HierarchySummaryRow>(
      `with recursive hierarchy as (
         select root.id as root_id, root.type as root_type, root.title as root_title,
                root.language as root_language, document.id as document_id,
                document.content_hash as document_hash, child.id as child_id,
                1 as depth
         from source_items root
         join source_items child on child.parent_source_item_id = root.id
         join documents document on document.source_item_id = root.id
         union all
         select hierarchy.root_id, hierarchy.root_type, hierarchy.root_title,
                hierarchy.root_language, hierarchy.document_id, hierarchy.document_hash,
                child.id, hierarchy.depth + 1
         from hierarchy
         join source_items child on child.parent_source_item_id = hierarchy.child_id
       ), aggregate_roots as (
         select hierarchy.root_id, hierarchy.root_type, hierarchy.root_title,
                hierarchy.root_language, hierarchy.document_id, hierarchy.document_hash,
                max(hierarchy.depth) as maximum_depth
         from hierarchy
         where hierarchy.root_id = $2::uuid
            or exists (
              select 1 from hierarchy selected
              where selected.root_id = $2::uuid and selected.child_id = hierarchy.root_id
            )
            or exists (
              select 1 from ingestion_runs run
              where run.batch_id = $1 and run.source_item_id in (hierarchy.root_id, hierarchy.child_id)
            )
         group by hierarchy.root_id, hierarchy.root_type, hierarchy.root_title,
                  hierarchy.root_language, hierarchy.document_id, hierarchy.document_hash
       )
       select aggregate_roots.root_id as "rootId", aggregate_roots.root_type as "rootType",
              aggregate_roots.root_title as "rootTitle", aggregate_roots.root_language as "rootLanguage",
              aggregate_roots.document_id as "documentId", aggregate_roots.document_hash as "documentHash",
              child.id as "childId", child.title as "childTitle",
              summary.id as "summaryId", summary.summary, summary.output_hash as "summaryHash"
       from aggregate_roots
       join source_items child on child.parent_source_item_id = aggregate_roots.root_id
       left join lateral (
         select division.position
         from document_divisions division
         join document_structures structure on structure.id = division.structure_id
         where division.child_source_item_id = child.id and structure.status = 'materialized'
         order by structure.revision desc limit 1
       ) canonical_order on true
       left join source_summaries summary on summary.source_item_id = child.id and summary.is_current = true
       order by aggregate_roots.maximum_depth, aggregate_roots.root_title, aggregate_roots.root_id,
                canonical_order.position nulls last, child.created_at, child.title, child.id`,
      [batchId, rootSourceItemId]
    );
    const grouped = new Map<string, typeof rows.rows>();
    for (const row of rows.rows) grouped.set(row.rootId, [...(grouped.get(row.rootId) ?? []), row]);
    let generatedCount = 0;
    let reusedCount = 0;
    const blockedRoots: Array<{
      sourceItemId: string;
      missingSummaryCount: number;
      totalSubparts: number;
    }> = [];
    for (const children of grouped.values()) {
      const root = children[0];
      if (!root) continue;
      const missingSummaryCount = children.filter(
        (child) => !child.summary || !child.summaryId || !child.summaryHash
      ).length;
      const summarizedChildren = children.filter(
        (
          child
        ): child is typeof child & {
          summaryId: string;
          summary: string;
          summaryHash: string;
        } => Boolean(child.summary && child.summaryId && child.summaryHash)
      );
      if (summarizedChildren.length === 0) {
        await createSourceSummaryRepository(pool).clearCurrent(root.rootId);
        await createSourceItemRepository(pool).update(root.rootId, {
          summary: null,
          summaryGeneratedAt: null
        });
        updateGroupedChildSummary(grouped, root.rootId, null);
        blockedRoots.push({
          sourceItemId: root.rootId,
          missingSummaryCount,
          totalSubparts: children.length
        });
        continue;
      }
      const promptIdentity = changedPromptIdentity(["summary.aggregate"]);
      const inputHash = sha256(
        summarizedChildren.map((child) => `${child.childId}:${child.summaryHash}`).join("\n") +
          (promptIdentity ? `\n${promptIdentity}` : "")
      );
      const current = (
        await createSourceSummaryRepository(pool).listBySourceItem(root.rootId)
      ).find((summary) => summary.isCurrent);
      if (!forceRegeneration && current?.inputHash === inputHash) {
        reusedCount += 1;
        continue;
      }
      const prompt = buildAggregateSummaryPrompt(
        { kind: aggregateSourceLabel(root.rootType), title: root.rootTitle },
        summarizedChildren.map((child) => ({ title: child.childTitle, summary: child.summary }))
      );
      const execution = await this.options.aiService.runDefaultTask(
        "summarization",
        prompt,
        {
          ...withAiSourceItems(logContext, [
            root.rootId,
            ...children.map((child) => child.childId)
          ]),
          operation: "hierarchy_summary",
          promptVersion: hierarchyAggregateSummaryPromptVersion,
          sourceItemId: root.rootId,
          documentId: root.documentId
        },
        signal
      );
      if (!execution) continue;
      const summary = normalizeSummaryText(execution.output);
      if (summary.length === 0) {
        await createSourceSummaryRepository(pool).clearCurrent(root.rootId);
        await createSourceItemRepository(pool).update(root.rootId, {
          summary: null,
          summaryGeneratedAt: null
        });
        updateGroupedChildSummary(grouped, root.rootId, null);
        continue;
      }
      const hierarchy = createHierarchicalIngestionRepository(pool);
      const revisionId = await hierarchy.ensureCurrentDocumentRevision(
        root.documentId,
        root.documentHash
      );
      const generationId = await hierarchy.createKnowledgeGeneration({
        sourceItemId: root.rootId,
        documentRevisionId: revisionId,
        stage: "aggregateSummarization",
        ingestionRunId:
          typeof logContext.ingestionRunId === "string" ? logContext.ingestionRunId : null,
        jobId: typeof logContext.jobId === "string" ? logContext.jobId : null,
        aiTaskRunId: execution.aiTaskRunId,
        inputHash,
        metadata: {
          promptVersion: hierarchyAggregateSummaryPromptVersion,
          batchId,
          childSummaryIds: summarizedChildren.map((child) => child.summaryId),
          skippedSubpartCount: missingSummaryCount
        }
      });
      const persisted = await createSourceSummaryRepository(pool).create({
        sourceItemId: root.rootId,
        generationId,
        summary,
        language: execution.outputLanguage ?? root.rootLanguage,
        profileId: execution.profileId,
        aiTaskRunId: execution.aiTaskRunId,
        provider: execution.providerId,
        model: execution.modelId,
        runtime: execution.runtime,
        promptVersion: hierarchyAggregateSummaryPromptVersion,
        inputHash,
        outputHash: sha256(summary),
        metadata: {
          aggregate: true,
          batchId,
          childSummaryIds: summarizedChildren.map((child) => child.summaryId),
          skippedSubpartCount: missingSummaryCount
        }
      });
      await createSourceItemRepository(pool).update(root.rootId, {
        summary,
        summaryGeneratedAt: persisted.generatedAt
      });
      updateGroupedChildSummary(grouped, root.rootId, {
        id: persisted.id,
        summary,
        hash: persisted.outputHash
      });
      generatedCount += 1;
    }
    return { generatedCount, reusedCount, blockedRoots };
  }

  public async isHierarchicalRoot(sourceItemId: string): Promise<boolean> {
    const result = await this.requirePool().query<{ exists: boolean }>(
      `select exists(
         select 1 from source_items root
         join source_items child on child.parent_source_item_id = root.id
         where root.id = $1
       ) as exists`,
      [sourceItemId]
    );
    return result.rows[0]?.exists ?? false;
  }

  public async generateAtomicNotes(
    sourceItemId: string,
    documentId: string,
    logContext: AtomicNoteGenerationLogContext = {},
    signal?: AbortSignal
  ) {
    const { onProgress, ...structuredLogContext } = logContext;
    const pool = this.requirePool();
    let stage = "source_loading";
    let execution: KnowledgeAiExecution | null = null;
    try {
      const source = await createSourceItemRepository(pool).findById(sourceItemId);
      const document = await createDocumentRepository(pool).findById(documentId);
      if (!source || !document || document.sourceItemId !== source.id)
        throw new Error("source_document_not_found");
      const chunks = await createChunkRepository(pool).listByDocument(documentId);
      if (chunks.length === 0)
        return { configured: true, generatedCount: 0, noteIds: [] as string[] };
      stage = "ai_execution";
      const generatedResult = await generateAtomicNoteCandidates(
        source,
        chunks,
        async (prompt, callContext) => {
          execution = toKnowledgeExecution(
            await this.options.aiService.runDefaultTask(
              "atomic-note-generation",
              prompt,
              {
                ...structuredLogContext,
                ...callContext,
                sourceItemId,
                documentId,
                stage: "atomic_note_generation",
                onProgress: (event) => onProgress?.(event.progress)
              },
              signal
            )
          );
          stage = "output_validation";
          return execution;
        }
      );
      if (!generatedResult)
        return { configured: false, generatedCount: 0, noteIds: [] as string[] };
      const { output: parsed } = generatedResult;
      execution = generatedResult.execution;
      stage = "persistence";
      const hierarchy = createHierarchicalIngestionRepository(pool);
      const revisionId = await hierarchy.ensureCurrentDocumentRevision(
        document.id,
        document.contentHash
      );
      const generationId = await hierarchy.createKnowledgeGeneration({
        sourceItemId,
        documentRevisionId: revisionId,
        stage: "atomicNotes",
        ingestionRunId: logContext.ingestionRunId ?? null,
        jobId: logContext.jobId ?? null,
        aiTaskRunId: execution.aiTaskRunId,
        inputHash: sha256(document.canonicalMarkdown),
        metadata: {
          promptVersion: atomicNotePromptVersion,
          promptFingerprint: stagePromptFingerprints(
            capturePromptPin(),
            false,
            execution.providerId
          ).atomicNotes,
          promptComplete: false
        }
      });
      const repository = createAtomicNoteRepository(pool);
      const noteIds: string[] = [];
      for (const generated of parsed.notes) {
        const evidence = generated.evidenceChunkIds.flatMap((chunkId) => {
          const chunk = chunks.find((candidate) => candidate.id === chunkId);
          return chunk ? [{ chunkId: chunk.id, sourceSpanId: chunk.sourceSpanId }] : [];
        });
        const primary = evidence[0];
        if (!primary) continue;
        const generationKey = sha256(
          JSON.stringify({
            promptVersion: atomicNotePromptVersion,
            title: generated.title,
            ideaStatement: generated.ideaStatement,
            evidenceChunkIds: generated.evidenceChunkIds.toSorted()
          })
        );
        const note = await repository.upsertGenerated({
          generationId,
          title: generated.title,
          bodyMarkdown: generated.bodyMarkdown,
          ideaStatement: generated.ideaStatement,
          language: generated.language ?? execution.outputLanguage ?? source.language,
          sourceItemId,
          evidenceChunkId: primary.chunkId,
          sourceSpanId: primary.sourceSpanId,
          evidenceLinks: evidence,
          generationProfileId: execution.profileId,
          aiTaskRunId: execution.aiTaskRunId,
          generationProvider: execution.providerId,
          generationModel: execution.modelId,
          generationRuntime: execution.runtime,
          generationPromptVersion: atomicNotePromptVersion,
          generationKey,
          metadata: {
            entities: readStringArray(source.metadata.entities),
            tags: readStringArray(source.metadata.tags),
            concepts: readStringArray(source.metadata.concepts)
          }
        });
        noteIds.push(note.id);
      }
      await hierarchy.completeKnowledgeGeneration(generationId);
      return { configured: true, generatedCount: noteIds.length, noteIds };
    } catch (error) {
      logStructuredError(
        this.options.logger,
        "atomic_note_generation_failed",
        {
          ...structuredLogContext,
          sourceItemId,
          documentId,
          stage,
          taskType: "atomic-note-generation",
          profileId: execution?.profileId ?? null,
          providerId: execution?.providerId ?? null,
          modelId: execution?.modelId ?? null,
          runtime: execution?.runtime ?? null,
          aiTaskRunId: execution?.aiTaskRunId ?? null
        },
        error,
        stage === "output_validation"
          ? "atomic_note_output_invalid"
          : "atomic_note_generation_failed"
      );
      throw error;
    }
  }

  public async generateKnowledgeGraph(
    sourceItemId: string,
    documentId: string,
    context: KnowledgeGraphGenerationContext = {},
    signal?: AbortSignal
  ) {
    const pool = this.requirePool();
    const source = await createSourceItemRepository(pool).findById(sourceItemId);
    const document = await createDocumentRepository(pool).findById(documentId);
    if (!source || !document || document.sourceItemId !== source.id)
      throw new Error("source_document_not_found");
    const chunks = await createChunkRepository(pool).listByDocument(documentId);
    if (chunks.length === 0) {
      return {
        configured: true,
        generated: false,
        projected: false,
        entityCount: 0,
        relationCount: 0
      };
    }
    const notes = context.includeAtomicNotesGraph
      ? await createAtomicNoteRepository(pool).listGraphInputsBySourceItem(sourceItemId)
      : [];
    return this.generateKnowledgeGraphFromInputs(
      sourceItemId,
      documentId,
      chunks.map((chunk, index) => ({
        id: chunk.id,
        title: `${source.title} — excerpt ${index + 1}`,
        ideaStatement: "",
        bodyMarkdown: chunk.content,
        evidenceChunkIds: [chunk.id]
      })),
      notes,
      chunkPositions(chunks),
      context,
      signal
    );
  }

  public async generateCatalogKnowledgeGraph(
    sourceItemId: string,
    documentId: string,
    context: KnowledgeGraphGenerationContext = {},
    signal?: AbortSignal
  ) {
    const pool = this.requirePool();
    const source = await createSourceItemRepository(pool).findById(sourceItemId);
    const document = await createDocumentRepository(pool).findById(documentId);
    if (!source || !document || document.sourceItemId !== source.id)
      throw new Error("source_document_not_found");
    const chunks = await createChunkRepository(pool).listByDocument(documentId);
    if (chunks.length === 0) {
      return {
        configured: true,
        generated: false,
        projected: false,
        entityCount: 0,
        relationCount: 0
      };
    }
    return this.generateKnowledgeGraphFromInputs(
      sourceItemId,
      documentId,
      [
        {
          id: `catalog:${sourceItemId}`,
          title: source.title,
          ideaStatement: "Source catalog metadata",
          bodyMarkdown: chunks.map((chunk) => chunk.content).join("\n\n"),
          evidenceChunkIds: chunks.map((chunk) => chunk.id)
        }
      ],
      [],
      chunkPositions(chunks),
      context,
      signal,
      "catalog_metadata"
    );
  }

  private async generateKnowledgeGraphFromInputs(
    sourceItemId: string,
    documentId: string,
    sourceInputs: Parameters<typeof generateKnowledgeGraphFromAtomicNotes>[1],
    atomicNoteInputs: Parameters<typeof generateKnowledgeGraphFromAtomicNotes>[1],
    positions: ReadonlyMap<string, number>,
    context: KnowledgeGraphGenerationContext,
    signal?: AbortSignal,
    processingMode?: "catalog_metadata"
  ) {
    const pool = this.requirePool();
    const source = await createSourceItemRepository(pool).findById(sourceItemId);
    const document = await createDocumentRepository(pool).findById(documentId);
    if (!source || !document || document.sourceItemId !== source.id)
      throw new Error("source_document_not_found");
    const contentLanguage = (await this.options.getContentLanguage?.()) ?? "en";
    const completedBatches = parseKnowledgeGraphBatchCheckpoints(context.completedBatches);
    const extractionLimits = (await this.options.getKnowledgeGraphLimits?.()) ?? {
      maxEntities: 250,
      maxRelations: 500
    };
    const canonicalSettings = CanonicalMatchingSettingsSchema.parse(
      (await this.options.getCanonicalMatchingSettings?.()) ?? {}
    );
    const resolveTypes = createRelationTypeResolver({
      settings: canonicalSettings,
      pool,
      ai: this.options.aiService,
      threshold:
        (await this.options.getRelationTypeSimilarityThreshold?.()) ??
        defaultRelationTypeSimilarityThreshold,
      context: {
        sourceItemId,
        documentId,
        ...(context.jobId ? { jobId: context.jobId } : {}),
        ...(context.ingestionRunId ? { ingestionRunId: context.ingestionRunId } : {})
      },
      ...(signal ? { signal } : {})
    });
    const resolveEntities = createEntityIdentityResolver({
      settings: canonicalSettings,
      pool,
      ai: this.options.aiService,
      language: contentLanguage,
      threshold: (await this.options.getEntityIdentitySimilarityThreshold?.()) ?? 0.92,
      context: {
        sourceItemId,
        documentId,
        ...(context.jobId ? { jobId: context.jobId } : {}),
        ...(context.ingestionRunId ? { ingestionRunId: context.ingestionRunId } : {})
      },
      ...(signal ? { signal } : {})
    });
    const trace = <T>(
      operation: string,
      run: () => Promise<T>,
      details: Record<string, unknown> = {}
    ) =>
      this.options.aiService.traceOperation?.(
        operation,
        {
          sourceItemId,
          documentId,
          ...(context.jobId ? { jobId: context.jobId } : {}),
          ...(context.ingestionRunId ? { ingestionRunId: context.ingestionRunId } : {})
        },
        run,
        details
      ) ?? run();
    const resolveRelations = async (batch: Parameters<typeof resolveTypes>[0]) => {
      const entities = await trace("entity_canonicalization", () => resolveEntities(batch), {
        entities: batch.entities.length
      });
      return trace("relation_canonicalization", () => resolveTypes(entities), {
        relations: batch.relations.length
      });
    };
    let sourceCheckpoints: KnowledgeGraphBatchCheckpoint[] = [];
    const sourceGraph = await generateKnowledgeGraphFromAtomicNotes(
      source,
      sourceInputs,
      async (prompt, callContext) =>
        toKnowledgeExecution(
          await this.options.aiService.runDefaultTask(
            "knowledge-graph-generation",
            prompt,
            {
              ...(context.jobId ? { jobId: context.jobId } : {}),
              ...(context.ingestionRunId ? { ingestionRunId: context.ingestionRunId } : {}),
              sourceItemId,
              documentId,
              contentLanguage,
              ...callContext,
              stage: "knowledge_graph_generation",
              onProgress: (event) => context.onProgress?.(event.progress)
            },
            signal
          )
        ),
      this.knowledgeGraphMaxInputCharacters,
      {
        completedBatches,
        inputKind: processingMode ? "catalog_metadata" : "source_chunks",
        resolveRelations,
        checkpointNamespace: "source",
        chunkPositions: positions,
        contentLanguage,
        extractionLimits,
        ...(context.onBatchCompleted
          ? {
              onBatchCompleted: async ({ completed, total, checkpoints }) => {
                sourceCheckpoints = checkpoints;
                const multiplier = atomicNoteInputs.length > 0 ? 2 : 1;
                await context.onBatchCompleted!({
                  completed,
                  total: total * multiplier,
                  checkpoints
                });
              }
            }
          : {})
      }
    );
    if (!sourceGraph) {
      return {
        configured: false,
        generated: false,
        projected: false,
        entityCount: 0,
        relationCount: 0
      };
    }
    sourceCheckpoints = sourceGraph.checkpoints;
    const atomicGraph =
      atomicNoteInputs.length > 0
        ? await generateKnowledgeGraphFromAtomicNotes(
            source,
            atomicNoteInputs,
            async (prompt, callContext) =>
              toKnowledgeExecution(
                await this.options.aiService.runDefaultTask(
                  "knowledge-graph-generation",
                  prompt,
                  {
                    ...(context.jobId ? { jobId: context.jobId } : {}),
                    ...(context.ingestionRunId ? { ingestionRunId: context.ingestionRunId } : {}),
                    sourceItemId,
                    documentId,
                    contentLanguage,
                    ...callContext,
                    stage: "atomic_note_knowledge_graph_generation",
                    onProgress: (event) => context.onProgress?.(event.progress)
                  },
                  signal
                )
              ),
            this.knowledgeGraphMaxInputCharacters,
            {
              completedBatches,
              inputKind: "atomic_notes",
              resolveRelations,
              checkpointNamespace: "atomic_notes",
              chunkPositions: positions,
              contentLanguage,
              ...(context.onBatchCompleted
                ? {
                    onBatchCompleted: async ({ completed, total, checkpoints }) => {
                      await context.onBatchCompleted!({
                        completed: sourceCheckpoints.length + completed,
                        total: sourceCheckpoints.length + total,
                        checkpoints: [...sourceCheckpoints, ...checkpoints]
                      });
                    }
                  }
                : {})
            }
          )
        : null;
    if (atomicNoteInputs.length > 0 && !atomicGraph) {
      return {
        configured: false,
        generated: false,
        projected: false,
        entityCount: 0,
        relationCount: 0
      };
    }
    const generated = {
      batches: [...sourceGraph.batches, ...(atomicGraph?.batches ?? [])],
      executions: [...sourceGraph.executions, ...(atomicGraph?.executions ?? [])],
      checkpoints: [...sourceGraph.checkpoints, ...(atomicGraph?.checkpoints ?? [])]
    };
    const finalExecution = generated.executions.at(-1);
    if (!finalExecution) throw new Error("knowledge_graph_execution_missing");
    const repository = createKnowledgeGraphRepository(pool);
    const hierarchy = createHierarchicalIngestionRepository(pool);
    const revisionId = await hierarchy.ensureCurrentDocumentRevision(
      document.id,
      document.contentHash
    );
    const graphModes = [
      processingMode ?? "source_chunks",
      ...(atomicGraph ? ["atomic_notes"] : [])
    ];
    const persisted = await trace("graph_relations_persistence", () =>
      repository.replaceSourceExtraction({
        sourceItemId,
        language: source.language,
        batches: generated.batches,
        generationReceipt: {
          documentRevisionId: revisionId,
          ingestionRunId: context.ingestionRunId ?? null,
          jobId: context.jobId ?? null,
          aiTaskRunId: finalExecution.aiTaskRunId,
          inputHash: sha256(
            [...sourceInputs, ...atomicNoteInputs].map((input) => input.bodyMarkdown).join("\n\n")
          ),
          metadata: {
            graphModes,
            extractionLimits,
            promptVersion: knowledgeGraphPromptVersion,
            promptFingerprint: stagePromptFingerprints(
              capturePromptPin(),
              false,
              generated.executions.map((e) => e.providerId)
            ).knowledgeGraph
          }
        },
        generation: {
          profileId: finalExecution.profileId,
          aiTaskRunIds: generated.executions.map((execution) => execution.aiTaskRunId),
          provider: finalExecution.providerId,
          model: finalExecution.modelId,
          runtime: finalExecution.runtime,
          promptVersion: knowledgeGraphPromptVersion,
          displayLanguage: finalExecution.outputLanguage ?? "en",
          extractionLimits,
          ...(processingMode ? { processingMode } : {})
        }
      })
    );
    let projected = true;
    let projectionError: string | null = null;
    try {
      await repository.projectSource(sourceItemId);
    } catch (error) {
      projected = false;
      projectionError =
        error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
      logStructuredError(
        this.options.logger,
        "knowledge_graph_projection_failed",
        {
          sourceItemId,
          documentId,
          stage: "graph_projection",
          taskType: "knowledge-graph-generation",
          profileId: finalExecution.profileId,
          providerId: finalExecution.providerId,
          modelId: finalExecution.modelId,
          runtime: finalExecution.runtime,
          aiTaskRunId: finalExecution.aiTaskRunId
        },
        error,
        "knowledge_graph_projection_failed"
      );
    }
    return {
      configured: true,
      generated: true,
      projected,
      projectionError,
      batchCount: generated.batches.length,
      graphModes,
      extractionLimits,
      ...persisted
    };
  }

  /**
   * Rebuilds the vector of one note after a human edit invalidated it. Ordinary background work
   * (the `note-embedding` job): it only calls the embedding model, never a generative one, and a
   * provider failure is thrown so the job retries it.
   */
  public async embedAtomicNote(
    noteId: string,
    signal?: AbortSignal,
    logContext: AiTaskLogContext = {}
  ): Promise<{
    embedded: boolean;
    reason?: "note_not_found" | "note_not_current" | "unchanged" | "no_embedding";
  }> {
    const pool = this.requirePool();
    const note = await createAtomicNoteRepository(pool).findById(noteId);
    if (!note) return { embedded: false, reason: "note_not_found" };
    // A discarded or archived note takes no part in matching or search.
    if (note.status === "rejected" || note.status === "archived")
      return { embedded: false, reason: "note_not_current" };
    const text = atomicNoteEmbeddingText(note);
    // Matching may have embedded the edited text already.
    if (await createEmbeddingRepository(pool).hasContentHash("atomic_note", note.id, sha256(text)))
      return { embedded: false, reason: "unchanged" };
    const execution = await this.options.aiService.runDefaultTask(
      "embedding",
      text,
      withAiSourceItems({ ...logContext, atomicNoteId: note.id, operation: "note_embedding" }, [
        note.createdFromSourceItemId
      ]),
      signal
    );
    const embedding = readEmbedding(execution?.output);
    if (!execution || !embedding) return { embedded: false, reason: "no_embedding" };
    await this.storeAtomicNoteEmbedding(note, execution, embedding);
    return { embedded: true };
  }

  private async storeAtomicNoteEmbedding(
    note: AtomicNoteRecord,
    execution: DefaultAiTaskResult,
    embedding: number[]
  ): Promise<void> {
    await createEmbeddingRepository(this.requirePool()).upsert({
      targetType: "atomic_note",
      targetId: note.id,
      provider: execution.providerId,
      model: execution.modelId,
      runtime: execution.runtime,
      usage: "matching",
      strategy: execution.embeddingSpaceKey
        ? `native-v2:${execution.embeddingSpaceKey}`
        : "native-unidentified",
      contentHash: sha256(atomicNoteEmbeddingText(note)),
      embedding
    });
  }

  public async matchAtomicNotes(
    noteIds: string[],
    signal?: AbortSignal,
    onProgress?: (progress: number) => void | Promise<void>,
    logContext: AiTaskLogContext = {},
    options: {
      /** Called once a note's relations and decisions are saved: a resumable checkpoint. */
      onNoteCompleted?: (noteId: string, persistedCount: number) => void | Promise<void>;
    } = {}
  ) {
    const pool = this.requirePool();
    const notes = createAtomicNoteRepository(pool);
    const relations = createAtomicNoteRelationRepository(pool);
    const decisions = createRelationDecisionRepository(pool);
    const relationThreshold = clamp(
      (await this.options.getRelationThreshold?.()) ?? this.relationThreshold
    );
    const matchingSettings = AtomicNoteMatchingSettingsSchema.parse(
      (await this.options.getAtomicNoteMatchingSettings?.()) ?? {}
    );
    let persistedCount = 0;
    for (const [noteIndex, noteId] of noteIds.entries()) {
      const note = await notes.findById(noteId);
      if (!note) {
        await onProgress?.((noteIndex + 1) / noteIds.length);
        await options.onNoteCompleted?.(noteId, 0);
        continue;
      }
      const embeddingExecution = await this.tryRunDefaultTask(
        "embedding",
        atomicNoteEmbeddingText(note),
        signal,
        withAiSourceItems(
          { ...logContext, atomicNoteId: note.id, operation: "note_matching_embedding" },
          [note.createdFromSourceItemId]
        )
      );
      const embedding = readEmbedding(embeddingExecution?.output);
      if (embedding && embeddingExecution)
        await this.storeAtomicNoteEmbedding(note, embeddingExecution, embedding);
      const textCandidates = await notes.findTextMatchingCandidates({
        noteId,
        limit: matchingSettings.textCandidateLimit
      });
      const vectorCandidates = embedding
        ? await notes.findVectorMatchingCandidates({
            noteId,
            embedding,
            ...(embeddingExecution
              ? {
                  embeddingModel: embeddingExecution.modelId,
                  embeddingSpaceKey: embeddingExecution.embeddingSpaceKey ?? "",
                  embeddingProvider: embeddingExecution.providerId,
                  embeddingRuntime: embeddingExecution.runtime
                }
              : {}),
            limit: matchingSettings.vectorCandidateLimit
          })
        : [];
      const graphRepository = createKnowledgeGraphRepository(pool);
      let graphCandidates: Awaited<ReturnType<typeof graphRepository.findAtomicNoteCandidates>> =
        [];
      let graphError: string | null = null;
      try {
        graphCandidates =
          matchingSettings.graphCandidateLimit > 0
            ? await graphRepository.findAtomicNoteCandidates(
                noteId,
                matchingSettings.graphCandidateLimit
              )
            : [];
      } catch (error) {
        graphError =
          error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
      }
      const fusedCandidates = fuseAtomicNoteCandidateRankings(
        textCandidates.map((candidate) => ({
          noteId: candidate.note.id,
          contentKey: noteContentKey(candidate.note),
          score: candidate.textScore
        })),
        vectorCandidates.map((candidate) => ({
          noteId: candidate.note.id,
          contentKey: noteContentKey(candidate.note),
          score: candidate.vectorScore
        })),
        graphCandidates.map((candidate) => ({
          noteId: candidate.noteId,
          contentKey: candidate.contentKey,
          score: candidate.graphScore
        })),
        matchingSettings.fusedCandidateLimit,
        matchingSettings.minimumGraphOnlyCandidates,
        matchingSettings.reciprocalRankConstant
      );
      const scoredCandidates = await notes.scoreMatchingCandidates({
        noteId,
        candidateIds: fusedCandidates.map((candidate) => candidate.noteId),
        ...(embedding ? { embedding } : {}),
        ...(embeddingExecution
          ? {
              embeddingModel: embeddingExecution.modelId,
              embeddingSpaceKey: embeddingExecution.embeddingSpaceKey ?? "",
              embeddingProvider: embeddingExecution.providerId,
              embeddingRuntime: embeddingExecution.runtime
            }
          : {})
      });
      const scoresById = new Map(
        scoredCandidates.map((candidate) => [candidate.note.id, candidate])
      );
      const graphPathsById = new Map(
        graphCandidates.map((candidate) => [candidate.noteId, candidate.pathType])
      );
      const pairStatuses = await relations.pairStatuses(
        noteId,
        fusedCandidates.map((candidate) => candidate.noteId)
      );
      const hasEmbedding = Boolean(embedding);
      // A human accept or reject is final in both directions. An automatic relation is still
      // decided in a direction that has no decision yet (the decision cache below skips the rest).
      const candidates = fusedCandidates
        .filter(
          (candidate) =>
            (pairStatuses.get(candidate.noteId) ?? "pending_review") === "pending_review"
        )
        .flatMap((candidate) => {
          const scored = scoresById.get(candidate.noteId);
          if (!scored) return [];
          const scores = {
            vectorScore: scored.vectorScore,
            textScore: scored.textScore,
            metadataScore: scoreMetadataOverlap(note.metadata, scored.note.metadata),
            graphScore: candidate.graphScore
          };
          return [
            {
              ...candidate,
              note: scored.note,
              textScore: scored.textScore,
              vectorScore: scored.vectorScore,
              scores,
              contentHash: atomicNoteDecisionContentHash(scored.note),
              feasible: canQualifyAtomicNoteRelation({
                scores,
                hasEmbedding,
                threshold: relationThreshold,
                settings: matchingSettings
              })
            }
          ];
        });
      let graphElementsByNote = new Map<string, AtomicNoteGraphElements>();
      try {
        graphElementsByNote = await graphRepository.listAtomicNoteElements([
          noteId,
          ...candidates.map((candidate) => candidate.note.id)
        ]);
      } catch {
        // Debug enrichment must not make note matching fail.
      }
      const sourceContentHash = atomicNoteDecisionContentHash(note);
      const feasible = candidates.filter((candidate) => candidate.feasible);
      // The decider is resolved once per note, before the cache lookup: the cached verdicts, their
      // provenance and the recorded decisions of this note all belong to this identity.
      const decider = await this.atomicNoteDecider();
      // A direction already decided on the same content by the same decider is never asked again.
      const cachedVerdicts = new Map<
        string,
        { score: number; relationType: AtomicNoteRelationType }
      >();
      if (decider && feasible.length > 0) {
        const verdicts = await decisions.findVerdicts({
          sourceAtomicNoteId: note.id,
          sourceContentHash,
          deciderKey: decider.key,
          targets: feasible.map((candidate) => ({
            atomicNoteId: candidate.note.id,
            contentHash: candidate.contentHash
          }))
        });
        for (const [targetId, verdict] of verdicts) {
          const relationType = AtomicNoteRelationTypeSchema.safeParse(verdict.relationType);
          if (relationType.success)
            cachedVerdicts.set(targetId, { score: verdict.score, relationType: relationType.data });
        }
      }
      // Aliases follow the content order of the fused candidates, never their IDs.
      const pending = feasible.filter((candidate) => !cachedVerdicts.has(candidate.note.id));
      const rerankAliases = new Map(
        pending.map((candidate, index) => [candidate.note.id, `c${index + 1}`])
      );
      const runRerank = (subset: typeof pending, attempt: number) =>
        this.options.aiService.runDefaultTask(
          "reranking",
          buildBatchRerankPrompt(
            note,
            subset.map((candidate) => ({
              alias: rerankAliases.get(candidate.note.id)!,
              title: candidate.note.title,
              ideaStatement: candidate.note.ideaStatement
            }))
          ),
          withAiSourceItems(
            {
              ...logContext,
              atomicNoteId: note.id,
              operation: attempt
                ? noteMatchDecisionOperations.repair
                : noteMatchDecisionOperations.decide,
              promptVersion: atomicNoteMatchingVersion,
              attempt
            },
            [
              note.createdFromSourceItemId,
              ...subset.map((candidate) => candidate.note.createdFromSourceItemId)
            ]
          ),
          signal,
          { maxOutputTokens: matchingSettings.maxRerankOutputTokens }
        );
      // A verdict that can never be accepted (weak type, or a final score under the threshold even
      // with it) is neither explained nor repaired.
      const pendingByAlias = new Map(
        pending.map((candidate) => [rerankAliases.get(candidate.note.id)!, candidate])
      );
      const verdictCanQualify = (
        alias: string,
        verdict: { score: number; relationType: AtomicNoteRelationType }
      ) => {
        const candidate = pendingByAlias.get(alias);
        return (
          !candidate ||
          atomicNoteVerdictQualifies({
            scores: candidate.scores,
            hasEmbedding,
            threshold: relationThreshold,
            settings: matchingSettings,
            verdict
          })
        );
      };
      let rerankExecution: DefaultAiTaskResult | null = null;
      let rerankError: string | null = null;
      let rerankCause: unknown;
      let repairedAliases: string[] = [];
      let undecidedAliases: string[] = [];
      const modelDecisions = new Map<string, BatchRerankDecision & { aiTaskRunId: string }>();
      if (pending.length > 0) {
        try {
          rerankExecution = await runRerank(pending, 0);
        } catch (error) {
          if (signal?.aborted) throw error;
          rerankCause = error;
          rerankError =
            error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
        }
        if (rerankExecution) {
          const aliases = pending.map((candidate) => rerankAliases.get(candidate.note.id)!);
          const initial = parseBatchRerankOutput(
            rerankExecution.output,
            aliases,
            verdictCanQualify
          );
          const firstRunId = rerankExecution.aiTaskRunId;
          const runIds = new Map(aliases.map((alias) => [alias, firstRunId]));
          let merged = initial.decisions;
          let repairFailed = false;
          let repairCause: unknown;
          if (initial.retry.length > 0) {
            // One repair call asks again only for missing, invalid or unexplained items.
            repairedAliases = initial.retry;
            const retry = new Set(initial.retry);
            try {
              const repairExecution = await runRerank(
                pending.filter((candidate) => retry.has(rerankAliases.get(candidate.note.id)!)),
                1
              );
              if (repairExecution) {
                const repaired = parseBatchRerankOutput(
                  repairExecution.output,
                  initial.retry,
                  verdictCanQualify
                );
                for (const alias of repaired.decisions.keys())
                  runIds.set(alias, repairExecution.aiTaskRunId);
                merged = mergeBatchRerankRepair(initial, repaired);
              } else repairFailed = true;
            } catch (error) {
              if (signal?.aborted) throw error;
              repairFailed = true;
              repairCause = error;
              rerankError =
                error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
            }
          }
          for (const candidate of pending) {
            const alias = rerankAliases.get(candidate.note.id)!;
            const decision = merged.get(alias);
            if (decision)
              modelDecisions.set(candidate.note.id, {
                ...decision,
                aiTaskRunId: runIds.get(alias)!
              });
          }
          // Items still invalid stay undecided: no relation and no recorded decision.
          undecidedAliases = aliases.filter((alias) => !merged.has(alias));
          // A required decider whose repair failed, or that decided nothing in two calls, fails the
          // note before its checkpoint: the undecided items would otherwise be lost for good. The
          // cause keeps a transient provider failure retryable by the job supervisor.
          if (
            matchingSettings.requireReranking &&
            undecidedAliases.length > 0 &&
            (repairFailed || modelDecisions.size === 0)
          )
            throw new Error("errors.matching.rerankingFailed", { cause: repairCause });
        }
        if (matchingSettings.requireReranking && !rerankExecution) {
          // The cause keeps a transient provider failure retryable by the job supervisor.
          throw new Error(
            rerankError ? "errors.matching.rerankingFailed" : "errors.ai.noCompatibleModel",
            { cause: rerankCause }
          );
        }
      }
      // Decisions are recorded only when the route did not change during the call. The cached
      // verdicts and their provenance stay those of the decider they were looked up under.
      let recordDecisions = false;
      if (rerankExecution && decider) {
        const current = await this.atomicNoteDecider();
        recordDecisions =
          current?.key === decider.key && rerankExecution.profileId === decider.profileId;
      }
      const rerankStatus = rerankExecution
        ? undecidedAliases.length > 0
          ? "partial"
          : "succeeded"
        : rerankError
          ? "failed"
          : pending.length > 0
            ? "not_configured"
            : "not_needed";
      const selection = selectAtomicNoteRelations(
        candidates.map((candidate) => {
          const decision =
            modelDecisions.get(candidate.note.id) ?? cachedVerdicts.get(candidate.note.id);
          return {
            ...candidate,
            noteId: candidate.note.id,
            contentKey: noteContentKey(candidate.note),
            decision: decision
              ? { score: decision.score, relationType: decision.relationType }
              : null
          };
        }),
        { hasEmbedding, threshold: relationThreshold, settings: matchingSettings }
      );
      let notePersistedCount = 0;
      const decisionRecords: RelationDecisionInput[] = [];
      const debugResults: Parameters<
        ReturnType<typeof createSimilarityDebugRepository>["record"]
      >[0]["results"] = [];
      for (const [candidateIndex, selected] of selection.entries()) {
        const candidate = selected.candidate;
        const { finalScore, relationType } = selected;
        const { metadataScore, graphScore } = candidate.scores;
        const rerankScore = candidate.decision?.score ?? null;
        const modelDecision = modelDecisions.get(candidate.note.id);
        const alias = rerankAliases.get(candidate.note.id);
        const decisionSource = modelDecision
          ? "model"
          : cachedVerdicts.has(candidate.note.id)
            ? "cache"
            : candidate.feasible
              ? "undecided"
              : "infeasible";
        const existingRelation = pairStatuses.has(candidate.note.id);
        let explanation =
          rerankScore === null
            ? "knowledge.relations.explanations.hybrid"
            : "knowledge.relations.explanations.reranked";
        if (modelDecision?.explanation && alias) {
          try {
            explanation = resolveAtomicNoteReferences(
              modelDecision.explanation,
              note.id,
              alias,
              candidate.note.id
            );
          } catch {
            // The parser already refused unsafe references; keep the localized fallback.
          }
        }
        debugResults.push({
          targetType: "atomic_note",
          targetId: candidate.note.id,
          targetLabel: candidate.note.title,
          finalRank: candidateIndex + 1,
          textRank: candidate.textRank,
          vectorRank: candidate.vectorRank,
          graphRank: candidate.graphRank,
          textScore: candidate.textScore,
          vectorScore: candidate.vectorScore,
          metadataScore,
          graphScore,
          rerankScore,
          fusionScore: candidate.fusionScore,
          finalScore,
          passedThreshold: selected.qualifies,
          explanation: selected.qualifies ? explanation : null,
          metadata: {
            baseScore: selected.baseScore,
            skippedByRelationLimit: selected.qualifies && !selected.accepted,
            relationType,
            contract: atomicNoteMatchingVersion,
            feasible: candidate.feasible,
            decisionSource,
            existingRelation,
            graphError,
            graphStatus: graphError
              ? "failed"
              : graphCandidates.length > 0
                ? "succeeded"
                : "no_signal",
            graphPathType: graphPathsById.get(candidate.note.id) ?? null,
            graphElements: graphElementsByNote.get(candidate.note.id) ?? {
              entities: [],
              claims: [],
              relations: []
            },
            rerankError,
            rerankStatus,
            rerankProfileId: rerankExecution?.profileId ?? null,
            rerankModel: rerankExecution?.modelId ?? null,
            candidateStatus: candidate.note.status
          }
        });
        // An existing automatic relation is kept as it is; it still counts toward the limit.
        if (selected.accepted && !existingRelation) {
          const persistRelation = () =>
            relations.upsert({
              sourceAtomicNoteId: note.id,
              targetAtomicNoteId: candidate.note.id,
              relationType,
              vectorScore: candidate.vectorScore,
              graphScore,
              rerankScore,
              finalScore,
              explanation,
              // Provenance of the decision itself: the call that made it, or for a cached verdict
              // the decider it was recorded under. A hybrid acceptance has no decider.
              matchingProfileId: modelDecision
                ? (rerankExecution?.profileId ?? null)
                : decisionSource === "cache"
                  ? (decider?.profileId ?? null)
                  : null,
              matchingModel: modelDecision
                ? (rerankExecution?.modelId ?? null)
                : decisionSource === "cache"
                  ? (decider?.modelId ?? null)
                  : null,
              metadata: {
                version: atomicNoteMatchingVersion,
                decisionSource,
                settings: matchingSettings,
                threshold: relationThreshold,
                textScore: candidate.textScore,
                metadataScore,
                graphScore,
                graphPathType: graphPathsById.get(candidate.note.id) ?? null,
                fusionScore: candidate.fusionScore,
                textRank: candidate.textRank,
                vectorRank: candidate.vectorRank,
                graphRank: candidate.graphRank,
                semanticSourceAtomicNoteId: note.id,
                semanticTargetAtomicNoteId: candidate.note.id,
                pendingReview:
                  note.status === "pending_review" || candidate.note.status === "pending_review"
              }
            });
          await (this.options.aiService.traceOperation?.(
            "atomic_note_relation_creation",
            withAiSourceItems({ ...logContext, atomicNoteId: note.id }, [
              note.createdFromSourceItemId,
              candidate.note.createdFromSourceItemId
            ]),
            persistRelation,
            {
              targetAtomicNoteId: candidate.note.id,
              relationType,
              finalScore,
              threshold: relationThreshold
            }
          ) ?? persistRelation());
          persistedCount += 1;
          notePersistedCount += 1;
        }
        if (modelDecision && recordDecisions && decider)
          decisionRecords.push({
            sourceAtomicNoteId: note.id,
            targetAtomicNoteId: candidate.note.id,
            sourceContentHash,
            targetContentHash: candidate.contentHash,
            deciderKey: decider.key,
            score: modelDecision.score,
            relationType: modelDecision.relationType,
            accepted: selected.accepted,
            aiTaskRunId: modelDecision.aiTaskRunId
          });
        await onProgress?.(
          calculateAtomicNoteMatchingProgress({
            noteIndex,
            noteCount: noteIds.length,
            completedCandidates: candidateIndex + 1,
            candidateCount: selection.length
          })
        );
      }
      // Relations are written before their decisions: a crash in between only repeats a decision.
      for (const record of decisionRecords) await decisions.record(record);
      await this.recordAtomicMatchingDebug({
        noteId: note.id,
        queryText: `${note.title}\n${note.ideaStatement}`,
        embeddingModel: embeddingExecution?.modelId ?? null,
        dimensions: embedding?.length ?? null,
        hasEmbedding,
        relationThreshold,
        matchingSettings,
        sourceGraphElements: graphElementsByNote.get(note.id) ?? {
          entities: [],
          claims: [],
          relations: []
        },
        decisions: {
          contract: atomicNoteMatchingVersion,
          candidates: candidates.length,
          infeasible: candidates.length - feasible.length,
          cached: cachedVerdicts.size,
          requested: pending.length,
          repaired: repairedAliases.length,
          undecided: undecidedAliases.length,
          recorded: decisionRecords.length
        },
        results: debugResults
      });
      if (selection.length === 0) await onProgress?.((noteIndex + 1) / noteIds.length);
      await options.onNoteCompleted?.(note.id, notePersistedCount);
    }
    return { persistedCount, threshold: relationThreshold };
  }

  /** The current reranking route as a decider identity, or null when it cannot be resolved. */
  private async atomicNoteDecider(): Promise<{
    key: string;
    profileId: string;
    modelId: string;
  } | null> {
    try {
      const route = await createAiConfigRepository(this.requirePool()).getDefaultTask("reranking");
      if (!route) return null;
      return {
        key: atomicNoteDeciderKey({
          provider: route.provider,
          baseUrl: route.baseUrl,
          modelId: route.modelId,
          runtime: route.runtime,
          repository: route.repository,
          revision: route.revision,
          quantization: route.quantization,
          parameters: withAiTaskParameterDefaults(
            "reranking",
            { ...route.modelDefaultParameters, ...route.parameters },
            Boolean(route.localModelId),
            { operation: noteMatchDecisionOperations.decide }
          ),
          promptFingerprint: promptFingerprint(["notes.match"], capturePromptPin(), route.provider)
        }),
        profileId: route.profileId,
        modelId: route.modelId
      };
    } catch {
      // Without a decider identity nothing is cached or recorded; matching itself goes on.
      return null;
    }
  }

  private async tryRunDefaultTask(
    task: "embedding",
    input: string,
    signal?: AbortSignal,
    logContext: AiTaskLogContext = {}
  ) {
    try {
      return await this.options.aiService.runDefaultTask(task, input, logContext, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      return null;
    }
  }

  private async recordAtomicMatchingDebug(input: {
    noteId: string;
    queryText: string;
    embeddingModel: string | null;
    dimensions: number | null;
    hasEmbedding: boolean;
    relationThreshold: number;
    matchingSettings: AtomicNoteMatchingSettings;
    sourceGraphElements: AtomicNoteGraphElements;
    /** How the candidates were decided: gate, cache, model call, repair. */
    decisions: Record<string, string | number>;
    results: Parameters<ReturnType<typeof createSimilarityDebugRepository>["record"]>[0]["results"];
  }): Promise<void> {
    try {
      if (!(await this.options.isDebugEnabled?.())) return;
      const matchingSettings = input.matchingSettings;
      await createSimilarityDebugRepository(this.requirePool()).record({
        kind: "atomic_note_matching",
        queryText: input.queryText,
        queryTargetId: input.noteId,
        mode: input.hasEmbedding ? "hybrid" : "text_metadata",
        model: input.embeddingModel,
        dimensions: input.dimensions,
        requestedLimit: matchingSettings.fusedCandidateLimit,
        strategy: "text_vector_graph_rrf_with_batch_reranking",
        metadata: {
          threshold: input.relationThreshold,
          retrievalLimits: {
            text: matchingSettings.textCandidateLimit,
            vector: matchingSettings.vectorCandidateLimit,
            graph: matchingSettings.graphCandidateLimit,
            fused: matchingSettings.fusedCandidateLimit
          },
          fusion: {
            strategy: "rrf",
            reciprocalRankConstant: matchingSettings.reciprocalRankConstant
          },
          settings: matchingSettings,
          rerankWeights: {
            base: 1 - matchingSettings.rerankerWeight,
            reranker: matchingSettings.rerankerWeight
          },
          rerankMode: "decision_only_batch",
          decisions: input.decisions,
          sourceGraphElements: input.sourceGraphElements
        },
        results: input.results
      });
    } catch {
      // Debug persistence must never make atomic-note matching fail.
    }
  }

  private requirePool(): PgPool {
    const pool = this.options.getPool();
    if (!pool) throw new Error("errors.database.notReady");
    return pool;
  }
}

function withAiSourceItems(context: AiTaskLogContext, sourceItemIds: string[]): AiTaskLogContext {
  const combined = [
    ...new Set([
      ...(context.sourceItemId ? [context.sourceItemId] : []),
      ...(context.sourceItemIds ?? []),
      ...sourceItemIds
    ])
  ];
  return {
    ...context,
    ...(combined[0] ? { sourceItemId: combined[0] } : {}),
    sourceItemIds: combined
  };
}

/** The text a note is embedded from; its hash tells whether a stored vector is still current. */
function atomicNoteEmbeddingText(note: AtomicNoteRecord): string {
  return renderPrompt("embedding.content.note", {
    note_title: note.title,
    note_idea: note.ideaStatement,
    note_body: note.bodyMarkdown
  });
}

function serializeNote(note: AtomicNoteRecord) {
  return {
    ownership: note.ownership ?? "source",
    supersessionStatus: note.supersessionStatus,
    id: note.id,
    title: note.title,
    bodyMarkdown: note.bodyMarkdown,
    ideaStatement: note.ideaStatement,
    language: note.language,
    status: note.status,
    sourceItemId: note.createdFromSourceItemId,
    sourceSpanId: note.sourceSpanId,
    evidenceChunkId: note.evidenceChunkId,
    generationModel: note.generationModel,
    generationPromptVersion: note.generationPromptVersion,
    createdAt: note.createdAt.toISOString(),
    updatedAt: note.updatedAt.toISOString()
  };
}

function toKnowledgeExecution(result: DefaultAiTaskResult | null): KnowledgeAiExecution | null {
  return result
    ? {
        output: result.output,
        providerId: result.providerId,
        modelId: result.modelId,
        runtime: result.runtime,
        profileId: result.profileId,
        aiTaskRunId: result.aiTaskRunId,
        outputLanguage: result.outputLanguage
      }
    : null;
}

function readEmbedding(output: unknown): number[] | undefined {
  if (!Array.isArray(output)) return undefined;
  const embedding = output.map(Number);
  return (embedding.length === 256 || embedding.length === 768 || embedding.length === 1_024) &&
    embedding.every(Number.isFinite)
    ? embedding
    : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** The document position of every chunk: evidence aliases follow it, never the chunk IDs. */
function chunkPositions(
  chunks: ReadonlyArray<{ id: string; chunkIndex: number }>
): ReadonlyMap<string, number> {
  return new Map(chunks.map((chunk) => [chunk.id, chunk.chunkIndex]));
}

/** Content-stable tie-break for note candidates; it matches AtomicNoteGraphCandidate.contentKey. */
function noteContentKey(note: { title: string; ideaStatement: string }): string {
  return contentKey(note.title, note.ideaStatement);
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
