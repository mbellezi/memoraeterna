import { sha256 } from "@app/conversion";
import { readFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import {
  createAtomicNoteRelationRepository,
  createAtomicNoteRepository,
  createChunkRepository,
  createDocumentAssetRepository,
  createDocumentRepository,
  createEmbeddingRepository,
  createHierarchicalIngestionRepository,
  createLibraryRepository,
  createKnowledgeGraphRepository,
  createSimilarityDebugRepository,
  createSourceItemRepository,
  createSourceSummaryRepository,
  type AtomicNoteGraphElements,
  type AtomicNoteRecord,
  type PgPool,
  type SourceItemType
} from "@app/db";

import type { AiService, AiTaskLogContext, DefaultAiTaskResult } from "./ai-service.js";
import { SourceDeletionService } from "./source-deletion-service.js";
import { logStructuredError } from "./structured-logging.js";
import type { LibraryBrowseInput, StorageSettings } from "../../shared/ipc.js";
import {
  atomicNoteMatchingVersion,
  atomicNotePromptVersion,
  buildAggregateSummaryPrompt,
  buildBatchRerankPrompt,
  calculateAtomicNoteMatchingProgress,
  calculateRelationScore,
  defaultSummaryMinimumWordCount,
  fuseAtomicNoteCandidateRankings,
  generateAtomicNoteCandidates,
  generateKnowledgeGraphFromAtomicNotes,
  generateSummaryFromChunks,
  hierarchyAggregateSummaryPromptVersion,
  meetsRelationThreshold,
  normalizeSummaryText,
  parseBatchRerankOutput,
  scoreMetadataOverlap,
  knowledgeGraphPromptVersion,
  parseKnowledgeGraphBatchCheckpoints,
  summaryPromptVersion,
  type BatchRerankOutput,
  type KnowledgeGraphBatchCheckpoint,
  type KnowledgeAiExecution
} from "./knowledge-processing.js";

const maxInlineAssetBytes = 5 * 1024 * 1024;
const atomicNoteTextCandidateLimit = 30;
const atomicNoteVectorCandidateLimit = 30;
const atomicNoteGraphCandidateLimit = 20;
const atomicNoteFusedCandidateLimit = 30;

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
  getSummaryMinimumWordCount?: () => Promise<number>;
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
    this.knowledgeGraphMaxInputCharacters = Math.max(2_000, options.knowledgeGraphMaxInputCharacters ?? 3_500);
    this.sourceDeletionService = new SourceDeletionService({
      getPool: options.getPool,
      getStorageSettings: options.getStorageSettings,
      userDataPath: options.userDataPath,
      ...(options.logger ? { logger: options.logger } : {})
    });
  }

  public async browseLibrary(input: LibraryBrowseInput) {
    return (await createLibraryRepository(this.requirePool()).listSources(input)).map((source) => ({
      ...source, summary: source.summary ? normalizeSummaryText(source.summary) : null, updatedAt: source.updatedAt.toISOString()
    }));
  }

  public async listLibrary(sourceTypes: SourceItemType[] = []) {
    return (await createLibraryRepository(this.requirePool()).listSources({ sourceTypes })).map((source) => ({
      ...source,
      summary: source.summary ? normalizeSummaryText(source.summary) : null,
      updatedAt: source.updatedAt.toISOString()
    }));
  }

  public async getSourceDocument(input: { sourceItemId: string; documentId: string }) {
    const document = await createDocumentRepository(this.requirePool()).findById(input.documentId);
    if (!document || document.sourceItemId !== input.sourceItemId) throw new Error("errors.common.validationFailed");
    return { title: document.title, markdown: document.canonicalMarkdown };
  }

  public async getSourceDetail(sourceItemId: string) {
    const pool = this.requirePool();
    const source = await createSourceItemRepository(pool).findById(sourceItemId);
    if (!source) return null;
    const documents = await createDocumentRepository(pool).listBySourceItem(sourceItemId);
    const sourceAssets = await createDocumentAssetRepository(pool).listBySourceItem(sourceItemId);
    const documentDetails = await Promise.all(documents.map(async (document) => ({
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
      assets: (await createDocumentAssetRepository(pool).listByDocument(document.id)).map((asset) => ({
        id: asset.id,
        originalFileName: asset.originalFileName,
        mimeType: asset.mimeType,
        role: asset.role
      }))
    })));
    const notes = await createAtomicNoteRepository(pool).listBySourceItem(sourceItemId);
    const relations = await createAtomicNoteRelationRepository(pool).listBySourceItem(sourceItemId);
    const summaries = await createSourceSummaryRepository(pool).listBySourceItem(sourceItemId);
    return {
      history: (await createDocumentRepository(pool).listHistory(source.id)).map((item) => ({ ...item, createdAt: item.createdAt.toISOString() })),
      breadcrumbs: (await createHierarchicalIngestionRepository(pool).getBreadcrumbs([source.id])).get(source.id) ?? [],
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
        id: asset.id, originalFileName: asset.originalFileName, mimeType: asset.mimeType, role: asset.role
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
    return await Promise.all(notes.map(async (note) => {
      const source = await createSourceItemRepository(pool).findById(note.createdFromSourceItemId);
      return { ...serializeNote(note), sourceTitle: source?.title ?? null };
    }));
  }

  public async reviewNote(input: {
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
    const basePath = asset.storageBase === "app_internal"
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
    if (!source || !document || document.metadata.supersededByDocumentId || document.sourceItemId !== source.id) throw new Error("source_document_not_found");
    const chunks = await createChunkRepository(pool).listByDocument(documentId);
    const summary = await generateSummaryFromChunks(
      chunks.length > 0
        ? chunks.map((chunk) => ({ id: chunk.id, content: chunk.content }))
        : [{ id: document.id, content: document.canonicalMarkdown }],
      async (prompt) => toKnowledgeExecution(await this.options.aiService.runDefaultTask(
        "summarization",
        prompt,
        {
          ...withAiSourceItems(logContext, [sourceItemId]),
          documentId,
          onProgress: (event) => onProgress?.(event.progress)
        },
        signal
      )),
      this.summaryMaxInputCharacters,
      Math.max(0, Math.floor(
        await this.options.getSummaryMinimumWordCount?.() ?? defaultSummaryMinimumWordCount
      ))
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
    const summaryRevisionId = await summaryHierarchy.ensureCurrentDocumentRevision(document.id, document.contentHash);
    const summaryGenerationId = await summaryHierarchy.createKnowledgeGeneration({
      sourceItemId,
      documentRevisionId: summaryRevisionId,
      stage: "summarization",
      ingestionRunId: typeof logContext.ingestionRunId === "string" ? logContext.ingestionRunId : null,
      jobId: typeof logContext.jobId === "string" ? logContext.jobId : null,
      aiTaskRunId: finalExecution.aiTaskRunId,
      inputHash: sha256(document.canonicalMarkdown),
      metadata: { promptVersion: summaryPromptVersion }
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
       order by aggregate_roots.maximum_depth, aggregate_roots.root_id,
                canonical_order.position nulls last, child.created_at, child.id`,
      [batchId, rootSourceItemId]
    );
    const grouped = new Map<string, typeof rows.rows>();
    for (const row of rows.rows) grouped.set(row.rootId, [...(grouped.get(row.rootId) ?? []), row]);
    let generatedCount = 0;
    let reusedCount = 0;
    const blockedRoots: Array<{ sourceItemId: string; missingSummaryCount: number; totalSubparts: number }> = [];
    for (const children of grouped.values()) {
      const root = children[0];
      if (!root) continue;
      const missingSummaryCount = children.filter((child) => !child.summary || !child.summaryId || !child.summaryHash).length;
      const summarizedChildren = children.filter((child): child is typeof child & {
        summaryId: string; summary: string; summaryHash: string;
      } => Boolean(child.summary && child.summaryId && child.summaryHash));
      if (summarizedChildren.length === 0) {
        await createSourceSummaryRepository(pool).clearCurrent(root.rootId);
        await createSourceItemRepository(pool).update(root.rootId, { summary: null, summaryGeneratedAt: null });
        updateGroupedChildSummary(grouped, root.rootId, null);
        blockedRoots.push({ sourceItemId: root.rootId, missingSummaryCount, totalSubparts: children.length });
        continue;
      }
      const inputHash = sha256(summarizedChildren.map((child) => `${child.childId}:${child.summaryHash}`).join("\n"));
      const current = (await createSourceSummaryRepository(pool).listBySourceItem(root.rootId)).find((summary) => summary.isCurrent);
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
          ...withAiSourceItems(logContext, [root.rootId, ...children.map((child) => child.childId)]),
          sourceItemId: root.rootId,
          documentId: root.documentId
        },
        signal
      );
      if (!execution) continue;
      const summary = normalizeSummaryText(execution.output);
      if (summary.length === 0) {
        await createSourceSummaryRepository(pool).clearCurrent(root.rootId);
        await createSourceItemRepository(pool).update(root.rootId, { summary: null, summaryGeneratedAt: null });
        updateGroupedChildSummary(grouped, root.rootId, null);
        continue;
      }
      const hierarchy = createHierarchicalIngestionRepository(pool);
      const revisionId = await hierarchy.ensureCurrentDocumentRevision(root.documentId, root.documentHash);
      const generationId = await hierarchy.createKnowledgeGeneration({
        sourceItemId: root.rootId, documentRevisionId: revisionId, stage: "aggregateSummarization",
        ingestionRunId: typeof logContext.ingestionRunId === "string" ? logContext.ingestionRunId : null,
        jobId: typeof logContext.jobId === "string" ? logContext.jobId : null,
        aiTaskRunId: execution.aiTaskRunId, inputHash,
        metadata: {
          promptVersion: hierarchyAggregateSummaryPromptVersion,
          batchId,
          childSummaryIds: summarizedChildren.map((child) => child.summaryId),
          skippedSubpartCount: missingSummaryCount
        }
      });
      const persisted = await createSourceSummaryRepository(pool).create({
        sourceItemId: root.rootId, generationId, summary, language: execution.outputLanguage ?? root.rootLanguage,
        profileId: execution.profileId, aiTaskRunId: execution.aiTaskRunId, provider: execution.providerId,
        model: execution.modelId, runtime: execution.runtime,
        promptVersion: hierarchyAggregateSummaryPromptVersion, inputHash,
        outputHash: sha256(summary), metadata: {
          aggregate: true,
          batchId,
          childSummaryIds: summarizedChildren.map((child) => child.summaryId),
          skippedSubpartCount: missingSummaryCount
        }
      });
      await createSourceItemRepository(pool).update(root.rootId, { summary, summaryGeneratedAt: persisted.generatedAt });
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
      if (!source || !document || document.sourceItemId !== source.id) throw new Error("source_document_not_found");
      const chunks = await createChunkRepository(pool).listByDocument(documentId);
      if (chunks.length === 0) return { configured: true, generatedCount: 0, noteIds: [] as string[] };
      stage = "ai_execution";
      const generatedResult = await generateAtomicNoteCandidates(
        source,
        chunks,
        async (prompt) => {
          execution = toKnowledgeExecution(await this.options.aiService.runDefaultTask(
            "atomic-note-generation",
            prompt,
            {
              ...structuredLogContext,
              sourceItemId,
              documentId,
              stage: "ai_execution",
              onProgress: (event) => onProgress?.(event.progress)
            },
            signal
          ));
          stage = "output_validation";
          return execution;
        }
      );
      if (!generatedResult) return { configured: false, generatedCount: 0, noteIds: [] as string[] };
      const { output: parsed } = generatedResult;
      execution = generatedResult.execution;
      stage = "persistence";
      const hierarchy = createHierarchicalIngestionRepository(pool);
      const revisionId = await hierarchy.ensureCurrentDocumentRevision(document.id, document.contentHash);
      const generationId = await hierarchy.createKnowledgeGeneration({
        sourceItemId,
        documentRevisionId: revisionId,
        stage: "atomicNotes",
        ingestionRunId: logContext.ingestionRunId ?? null,
        jobId: logContext.jobId ?? null,
        aiTaskRunId: execution.aiTaskRunId,
        inputHash: sha256(document.canonicalMarkdown),
        metadata: { promptVersion: atomicNotePromptVersion }
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
        const generationKey = sha256(JSON.stringify({
          promptVersion: atomicNotePromptVersion,
          title: generated.title,
          ideaStatement: generated.ideaStatement,
          evidenceChunkIds: generated.evidenceChunkIds.toSorted()
        }));
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
      return { configured: true, generatedCount: noteIds.length, noteIds };
    } catch (error) {
      logStructuredError(this.options.logger, "atomic_note_generation_failed", {
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
      }, error, stage === "output_validation" ? "atomic_note_output_invalid" : "atomic_note_generation_failed");
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
    if (!source || !document || document.sourceItemId !== source.id) throw new Error("source_document_not_found");
    const notes = await createAtomicNoteRepository(pool).listGraphInputsBySourceItem(sourceItemId);
    if (notes.length === 0) {
      return { configured: true, generated: false, projected: false, entityCount: 0, claimCount: 0, relationCount: 0 };
    }
    return this.generateKnowledgeGraphFromInputs(sourceItemId, documentId, notes, context, signal);
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
    if (!source || !document || document.sourceItemId !== source.id) throw new Error("source_document_not_found");
    const chunks = await createChunkRepository(pool).listByDocument(documentId);
    if (chunks.length === 0) {
      return { configured: true, generated: false, projected: false, entityCount: 0, claimCount: 0, relationCount: 0 };
    }
    return this.generateKnowledgeGraphFromInputs(
      sourceItemId,
      documentId,
      [{
        id: `catalog:${sourceItemId}`,
        title: source.title,
        ideaStatement: "Source catalog metadata",
        bodyMarkdown: chunks.map((chunk) => chunk.content).join("\n\n"),
        evidenceChunkIds: chunks.map((chunk) => chunk.id)
      }],
      context,
      signal,
      "catalog_metadata"
    );
  }

  private async generateKnowledgeGraphFromInputs(
    sourceItemId: string,
    documentId: string,
    notes: Parameters<typeof generateKnowledgeGraphFromAtomicNotes>[1],
    context: KnowledgeGraphGenerationContext,
    signal?: AbortSignal,
    processingMode?: "catalog_metadata"
  ) {
    const pool = this.requirePool();
    const source = await createSourceItemRepository(pool).findById(sourceItemId);
    const document = await createDocumentRepository(pool).findById(documentId);
    if (!source || !document || document.sourceItemId !== source.id) throw new Error("source_document_not_found");
    const generated = await generateKnowledgeGraphFromAtomicNotes(
      source,
      notes,
      async (prompt) => toKnowledgeExecution(await this.options.aiService.runDefaultTask(
        "knowledge-graph-generation",
        prompt,
        {
          ...(context.jobId ? { jobId: context.jobId } : {}),
          ...(context.ingestionRunId ? { ingestionRunId: context.ingestionRunId } : {}),
          sourceItemId,
          documentId,
          stage: "knowledge_graph_generation",
          onProgress: (event) => context.onProgress?.(event.progress)
        },
        signal
      )),
      this.knowledgeGraphMaxInputCharacters,
      {
        completedBatches: parseKnowledgeGraphBatchCheckpoints(context.completedBatches),
        ...(context.onBatchCompleted ? { onBatchCompleted: context.onBatchCompleted } : {})
      }
    );
    if (!generated) {
      return { configured: false, generated: false, projected: false, entityCount: 0, claimCount: 0, relationCount: 0 };
    }
    const finalExecution = generated.executions.at(-1);
    if (!finalExecution) throw new Error("knowledge_graph_execution_missing");
    const repository = createKnowledgeGraphRepository(pool);
    const persisted = await repository.replaceSourceExtraction({
      sourceItemId,
      language: source.language,
      batches: generated.batches,
      generation: {
        profileId: finalExecution.profileId,
        aiTaskRunIds: generated.executions.map((execution) => execution.aiTaskRunId),
        provider: finalExecution.providerId,
        model: finalExecution.modelId,
        runtime: finalExecution.runtime,
        promptVersion: knowledgeGraphPromptVersion,
        ...(processingMode ? { processingMode } : {})
      }
    });
    if (processingMode) {
      const hierarchy = createHierarchicalIngestionRepository(pool);
      const revisionId = await hierarchy.ensureCurrentDocumentRevision(document.id, document.contentHash);
      await hierarchy.createKnowledgeGeneration({
        sourceItemId,
        documentRevisionId: revisionId,
        stage: "knowledgeGraph",
        ingestionRunId: context.ingestionRunId ?? null,
        jobId: context.jobId ?? null,
        aiTaskRunId: finalExecution.aiTaskRunId,
        inputHash: sha256(notes.map((note) => note.bodyMarkdown).join("\n\n")),
        metadata: { processingMode, promptVersion: knowledgeGraphPromptVersion }
      });
    }
    let projected = true;
    let projectionError: string | null = null;
    try {
      await repository.projectSource(sourceItemId);
    } catch (error) {
      projected = false;
      projectionError = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
      logStructuredError(this.options.logger, "knowledge_graph_projection_failed", {
        sourceItemId,
        documentId,
        stage: "graph_projection",
        taskType: "knowledge-graph-generation",
        profileId: finalExecution.profileId,
        providerId: finalExecution.providerId,
        modelId: finalExecution.modelId,
        runtime: finalExecution.runtime,
        aiTaskRunId: finalExecution.aiTaskRunId
      }, error, "knowledge_graph_projection_failed");
    }
    return {
      configured: true,
      generated: true,
      projected,
      projectionError,
      batchCount: generated.batches.length,
      ...persisted
    };
  }

  public async matchAtomicNotes(
    noteIds: string[],
    signal?: AbortSignal,
    onProgress?: (progress: number) => void | Promise<void>,
    logContext: AiTaskLogContext = {}
  ) {
    const pool = this.requirePool();
    const notes = createAtomicNoteRepository(pool);
    const relations = createAtomicNoteRelationRepository(pool);
    const relationThreshold = clamp(await this.options.getRelationThreshold?.() ?? this.relationThreshold);
    let persistedCount = 0;
    for (const [noteIndex, noteId] of noteIds.entries()) {
      const note = await notes.findById(noteId);
      if (!note) {
        await onProgress?.((noteIndex + 1) / noteIds.length);
        continue;
      }
      const embeddingExecution = await this.tryRunDefaultTask(
        "embedding",
        `${note.title}\n\n${note.ideaStatement}\n\n${note.bodyMarkdown}`,
        signal,
        withAiSourceItems(logContext, [note.createdFromSourceItemId])
      );
      const embedding = readEmbedding(embeddingExecution?.output);
      if (embedding && embeddingExecution) {
        await createEmbeddingRepository(pool).upsert({
          targetType: "atomic_note",
          targetId: note.id,
          provider: embeddingExecution.providerId,
          model: embeddingExecution.modelId,
          runtime: embeddingExecution.runtime,
          usage: "matching",
          strategy: "native",
          contentHash: sha256(`${note.title}\n${note.ideaStatement}\n${note.bodyMarkdown}`),
          embedding
        });
      }
      const textCandidates = await notes.findTextMatchingCandidates({
        noteId,
        limit: atomicNoteTextCandidateLimit
      });
      const vectorCandidates = embedding
        ? await notes.findVectorMatchingCandidates({
            noteId,
            embedding,
            ...(embeddingExecution ? { embeddingModel: embeddingExecution.modelId } : {}),
            limit: atomicNoteVectorCandidateLimit
          })
        : [];
      const graphRepository = createKnowledgeGraphRepository(pool);
      let graphCandidates: Awaited<ReturnType<typeof graphRepository.findAtomicNoteCandidates>> = [];
      let graphError: string | null = null;
      try {
        graphCandidates = await graphRepository.findAtomicNoteCandidates(noteId, atomicNoteGraphCandidateLimit);
      } catch (error) {
        graphError = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
      }
      const fusedCandidates = fuseAtomicNoteCandidateRankings(
        textCandidates.map((candidate) => ({ noteId: candidate.note.id, score: candidate.textScore })),
        vectorCandidates.map((candidate) => ({ noteId: candidate.note.id, score: candidate.vectorScore })),
        graphCandidates.map((candidate) => ({ noteId: candidate.noteId, score: candidate.graphScore })),
        atomicNoteFusedCandidateLimit
      );
      const scoredCandidates = await notes.scoreMatchingCandidates({
        noteId,
        candidateIds: fusedCandidates.map((candidate) => candidate.noteId),
        ...(embedding ? { embedding } : {}),
        ...(embeddingExecution ? { embeddingModel: embeddingExecution.modelId } : {})
      });
      const scoresById = new Map(scoredCandidates.map((candidate) => [candidate.note.id, candidate]));
      const graphPathsById = new Map(graphCandidates.map((candidate) => [candidate.noteId, candidate.pathType]));
      const candidates = fusedCandidates.flatMap((candidate) => {
        const scored = scoresById.get(candidate.noteId);
        return scored ? [{
          ...candidate,
          note: scored.note,
          textScore: scored.textScore,
          vectorScore: scored.vectorScore
        }] : [];
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
      let rerankExecution: DefaultAiTaskResult | null = null;
      let rerankResults = new Map<string, BatchRerankOutput>();
      let rerankError: string | null = null;
      const rerankAliases = new Map(candidates.map((candidate, index) => [candidate.note.id, `c${index + 1}`]));
      if (candidates.length > 0) {
        try {
          rerankExecution = await this.options.aiService.runDefaultTask(
            "reranking",
            buildBatchRerankPrompt(note, candidates.map((candidate) => ({
              alias: rerankAliases.get(candidate.note.id)!,
              title: candidate.note.title,
              ideaStatement: candidate.note.ideaStatement
            }))),
            withAiSourceItems(logContext, [
              note.createdFromSourceItemId,
              ...candidates.map((candidate) => candidate.note.createdFromSourceItemId)
            ]),
            signal
          );
          if (rerankExecution) {
            rerankResults = parseBatchRerankOutput(
              rerankExecution.output,
              new Set(rerankAliases.values())
            );
          }
        } catch (error) {
          if (signal?.aborted) throw error;
          rerankExecution = null;
          rerankResults.clear();
          rerankError = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
          // The batch is atomic: any invalid or incomplete output discards all reranking results.
        }
      }
      const debugResults: Parameters<ReturnType<typeof createSimilarityDebugRepository>["record"]>[0]["results"] = [];
      for (const [candidateIndex, candidate] of candidates.entries()) {
        const metadataScore = scoreMetadataOverlap(note.metadata, candidate.note.metadata);
        const graphScore = candidate.graphScore;
        const baseScore = calculateRelationScore({
          vectorScore: candidate.vectorScore,
          textScore: candidate.textScore,
          metadataScore,
          graphScore,
          hasEmbedding: Boolean(embedding)
        });
        let finalScore = baseScore;
        let relationType = "related";
        let explanation = "knowledge.relations.explanations.hybrid";
        let rerankScore: number | null = null;
        const alias = rerankAliases.get(candidate.note.id);
        const reranked = alias ? rerankResults.get(alias) : undefined;
        if (reranked) {
          rerankScore = reranked.score;
          finalScore = calculateRelationScore({
            vectorScore: candidate.vectorScore,
            textScore: candidate.textScore,
            metadataScore,
            graphScore,
            hasEmbedding: Boolean(embedding),
            rerankScore: reranked.score
          });
          relationType = reranked.relationType;
          explanation = "knowledge.relations.explanations.reranked";
        }
        const passedThreshold = meetsRelationThreshold(finalScore, relationThreshold);
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
          passedThreshold,
          explanation,
          metadata: {
            baseScore,
            relationType,
            graphError,
            graphStatus: graphError ? "failed" : graphCandidates.length > 0 ? "succeeded" : "no_signal",
            graphPathType: graphPathsById.get(candidate.note.id) ?? null,
            graphElements: graphElementsByNote.get(candidate.note.id) ?? { entities: [], claims: [], relations: [] },
            rerankError,
            rerankStatus: rerankExecution ? "succeeded" : rerankError ? "failed" : "not_configured",
            rerankProfileId: rerankExecution?.profileId ?? null,
            rerankModel: rerankExecution?.modelId ?? null,
            candidateStatus: candidate.note.status
          }
        });
        if (passedThreshold) {
          await relations.upsert({
            sourceAtomicNoteId: note.id,
            targetAtomicNoteId: candidate.note.id,
            relationType,
            vectorScore: candidate.vectorScore,
            graphScore,
            rerankScore,
            finalScore,
            explanation,
            matchingProfileId: rerankExecution?.profileId ?? null,
            matchingModel: rerankExecution?.modelId ?? null,
            metadata: {
              version: atomicNoteMatchingVersion,
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
              pendingReview: note.status === "pending_review" || candidate.note.status === "pending_review"
            }
          });
          persistedCount += 1;
        }
        await onProgress?.(calculateAtomicNoteMatchingProgress({
          noteIndex,
          noteCount: noteIds.length,
          completedCandidates: candidateIndex + 1,
          candidateCount: candidates.length
        }));
      }
      await this.recordAtomicMatchingDebug({
        noteId: note.id,
        queryText: `${note.title}\n${note.ideaStatement}`,
        embeddingModel: embeddingExecution?.modelId ?? null,
        dimensions: embedding?.length ?? null,
        hasEmbedding: Boolean(embedding),
        relationThreshold,
        sourceGraphElements: graphElementsByNote.get(note.id) ?? { entities: [], claims: [], relations: [] },
        results: debugResults
      });
      if (candidates.length === 0) await onProgress?.((noteIndex + 1) / noteIds.length);
    }
    return { persistedCount, threshold: relationThreshold };
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
    sourceGraphElements: AtomicNoteGraphElements;
    results: Parameters<ReturnType<typeof createSimilarityDebugRepository>["record"]>[0]["results"];
  }): Promise<void> {
    try {
      if (!await this.options.isDebugEnabled?.()) return;
      await createSimilarityDebugRepository(this.requirePool()).record({
        kind: "atomic_note_matching",
        queryText: input.queryText,
        queryTargetId: input.noteId,
        mode: input.hasEmbedding ? "hybrid" : "text_metadata",
        model: input.embeddingModel,
        dimensions: input.dimensions,
        requestedLimit: atomicNoteFusedCandidateLimit,
        strategy: "text_vector_graph_rrf_with_batch_reranking",
        metadata: {
          threshold: input.relationThreshold,
          retrievalLimits: {
            text: atomicNoteTextCandidateLimit,
            vector: atomicNoteVectorCandidateLimit,
            graph: atomicNoteGraphCandidateLimit,
            fused: atomicNoteFusedCandidateLimit
          },
          fusion: { strategy: "rrf", reciprocalRankConstant: 60 },
          baseWeights: {
            withEmbeddingAndGraph: { vector: 0.45, text: 0.25, graph: 0.2, metadata: 0.1 },
            withEmbedding: { vector: 0.55, text: 0.3, metadata: 0.15 },
            withGraph: { text: 0.55, graph: 0.3, metadata: 0.15 },
            textAndMetadata: { text: 0.7, metadata: 0.3 }
          },
          rerankWeights: { base: 0.6, reranker: 0.4 },
          rerankMode: "single_atomic_batch",
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
  const combined = [...new Set([
    ...(context.sourceItemId ? [context.sourceItemId] : []),
    ...(context.sourceItemIds ?? []),
    ...sourceItemIds
  ])];
  return {
    ...context,
    ...(combined[0] ? { sourceItemId: combined[0] } : {}),
    sourceItemIds: combined
  };
}

function serializeNote(note: AtomicNoteRecord) {
  return {
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
  return result ? {
    output: result.output,
    providerId: result.providerId,
    modelId: result.modelId,
    runtime: result.runtime,
    profileId: result.profileId,
    aiTaskRunId: result.aiTaskRunId,
    outputLanguage: result.outputLanguage
  } : null;
}

function readEmbedding(output: unknown): number[] | undefined {
  if (!Array.isArray(output)) return undefined;
  const embedding = output.map(Number);
  return (embedding.length === 256 || embedding.length === 768 || embedding.length === 1_024)
      && embedding.every(Number.isFinite)
    ? embedding
    : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
