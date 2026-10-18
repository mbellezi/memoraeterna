import {
  renderPrompt,
  capturePromptPin,
  stagePromptFingerprints,
  changedPromptIdentity
} from "./prompt-runtime.js";
import { createEntityIdentityResolver } from "./entity-identity-resolution.js";
import { isExtractionPinned } from "./extraction-pin.js";
import {
  matchSources,
  promoteSourceRelations,
  sourceMatchingOperation
} from "./source-relation-processing.js";
import {
  RelationMatcher,
  type DecidedNote,
  type MatchNotesResult
} from "./relations/relation-matcher.js";
import {
  createTyperRouteResolver,
  typeRelationPairs,
  type RelationTypingOptions,
  type TypingPair
} from "./relations/relation-typing.js";
import type { RelationDiscoveryInput } from "./relations/relation-link.js";
import { relationDailyCapError } from "./relations/relation-call-budget.js";
import {
  CanonicalMatchingSettingsSchema,
  knowledgeGraphBatchFor,
  noteRelationCalibration,
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
import { executionLane } from "@app/ai";
import {
  aiRouteKeys,
  createAiConfigRepository,
  createRelationTypingRepository,
  createAtomicNoteRelationRepository,
  createSourceRelationRepository,
  createSourceRelationExplanationRepository,
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
  createSourceItemRepository,
  createSourceSummaryRepository,
  type AtomicNoteRecord,
  type PgPool,
  type RetrievalFence,
  type SourceItemType
} from "@app/db";

import { chunkTexts, embedManyLimits } from "@app/ai";
import type {
  AiEmbedManyExecution,
  AiService,
  AiTaskLogContext,
  DefaultAiTaskResult
} from "./ai-service.js";
import { SourceDeletionService } from "./source-deletion-service.js";
import type { TopicChangeHooks } from "./topic-tree/topic-hooks.js";
import { logStructuredError } from "./structured-logging.js";
import type { LibraryBrowseInput, StorageSettings } from "../../shared/ipc.js";
import {
  atomicNotePromptVersion,
  defaultSummaryMinimumWordCount,
  generateAtomicNoteCandidates,
  generateKnowledgeGraphFromAtomicNotes,
  generateSummaryFromChunks,
  hierarchyAggregateSummaryPromptVersion,
  normalizeSummaryText,
  knowledgeGraphPromptVersion,
  parseKnowledgeGraphBatchCheckpoints,
  summarizeSubpartsWithinBudget,
  summaryPromptVersion,
  type KnowledgeGraphBatchCheckpoint,
  type KnowledgeAiExecution
} from "./knowledge-processing.js";
import { summaryBudget, type SummaryBudget } from "./summary-batching.js";

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

/**
 * What an aggregate summary built in batches records beside the usual metadata (plan decision 28):
 * every call's run (the audit of the whole combination) and the budget that made it batch. A
 * summary written by one call records nothing more than it always did.
 */
function batchedSummaryMetadata(
  outcome: { executions: ReadonlyArray<{ aiTaskRunId: string }>; levels: number; calls: number },
  budget: SummaryBudget
): Record<string, unknown> {
  if (outcome.calls <= 1) return {};
  return {
    aiTaskRunIds: outcome.executions.map((execution) => execution.aiTaskRunId),
    batched: {
      levels: outcome.levels,
      calls: outcome.calls,
      budgetBytes: budget.bytes,
      contextWindow: budget.contextWindow,
      windowSource: budget.windowSource
    }
  };
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
  /** The generative decider's output budget, the one note-matching setting left (F3 D17, T53b). */
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
  /** The topic engine's hooks (T15b): notes placed once embedded, unplaced when discarded. */
  topicHooks?: TopicChangeHooks;
}

export interface AtomicNoteGenerationLogContext {
  jobId?: string;
  ingestionRunId?: string;
  onProgress?: (progress: number) => void;
}

export interface KnowledgeGraphGenerationContext {
  jobId?: string;
  ingestionRunId?: string;
  /** The lane priority of the calls; background work that yields to ingestion states `P3`. */
  priority?: "P2" | "P3";
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
  private readonly summaryMaxInputCharacters: number;
  /** An explicit batch size; absent, the batch follows the writer's locality (F3 D36). */
  private readonly knowledgeGraphMaxInputCharacters: number | null;
  private readonly sourceDeletionService: SourceDeletionService;
  private readonly relationMatcher: RelationMatcher;

  public constructor(private readonly options: KnowledgeServiceOptions) {
    this.summaryMaxInputCharacters = Math.max(2_000, options.summaryMaxInputCharacters ?? 12_000);
    this.knowledgeGraphMaxInputCharacters =
      options.knowledgeGraphMaxInputCharacters === undefined
        ? null
        : Math.max(2_000, options.knowledgeGraphMaxInputCharacters);
    this.sourceDeletionService = new SourceDeletionService({
      getPool: options.getPool,
      getStorageSettings: options.getStorageSettings,
      userDataPath: options.userDataPath,
      ...(options.logger ? { logger: options.logger } : {}),
      ...(options.topicHooks ? { topicHooks: options.topicHooks } : {})
    });
    this.relationMatcher = new RelationMatcher({
      getPool: options.getPool,
      ai: options.aiService,
      ...(options.getAtomicNoteMatchingSettings
        ? { getAtomicNoteMatchingSettings: options.getAtomicNoteMatchingSettings }
        : {}),
      ...(options.isDebugEnabled ? { isDebugEnabled: options.isDebugEnabled } : {})
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
          embeddingInputType: "query",
          workloadClass: "embed",
          priority: "P0"
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
    const pool = this.requirePool();
    const page = await listSourceRelations(
      pool,
      input.sourceItemId,
      input.targetSourceItemId,
      input.offset,
      input.limit,
      input.relationId
    );
    // An explanation written on open shows while its inputs and the content language still hold.
    const written = await createSourceRelationExplanationRepository(pool).currentExplanations(
      page.relations.map((relation) => String(relation.id)),
      (await this.options.getContentLanguage?.()) ?? "en"
    );
    return {
      ...page,
      relations: page.relations.map((relation) => ({
        ...relation,
        writtenExplanation: written.get(String(relation.id)) ?? null
      }))
    };
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
    regenerate = false,
    // Design E (F3 D27): `defer` promotes only and records discovery as deferred (relation remote
    // calls switched off, or a hierarchy root whose last record has not linked yet).
    options: { discovery?: "run" | "defer"; fence?: RetrievalFence } = {}
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
      ...(options.discovery ? { discovery: options.discovery } : {}),
      ...(options.fence ? { fence: options.fence } : {}),
      context
    });
  }

  /**
   * Re-promotes the source relations of these roots from their typed shown (applied or suggested)
   * note relations, with no call (F3 D27, R14, decision 29): what a typing, a change of type or
   * direction, a review or a revert enqueues for both roots of the note relations it changed.
   */
  public async promoteSourceRelations(rootIds: readonly string[]) {
    return promoteSourceRelations(this.requirePool(), rootIds);
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
      documents.map(async (document) => {
        const chunkRepository = createChunkRepository(pool);
        const [documentChunks, spans] = await Promise.all([
          chunkRepository.listByDocument(document.id),
          chunkRepository.listSpansByDocument(document.id)
        ]);
        const spanById = new Map(spans.map((span) => [span.id, span]));
        return {
          id: document.id,
          title: document.title,
          canonicalMarkdown: document.canonicalMarkdown,
          language: document.language,
          // A chunk carries its SourceSpan so a citation can highlight the passage in the Markdown.
          chunks: documentChunks.map((chunk) => {
            const span = chunk.sourceSpanId ? spanById.get(chunk.sourceSpanId) : undefined;
            return {
              id: chunk.id,
              content: chunk.content,
              chunkIndex: chunk.chunkIndex,
              sourceSpanId: chunk.sourceSpanId,
              startOffset: span?.startOffset ?? null,
              endOffset: span?.endOffset ?? null,
              page: span?.page ?? null
            };
          }),
          assets: (await createDocumentAssetRepository(pool).listByDocument(document.id)).map(
            (asset) => ({
              id: asset.id,
              originalFileName: asset.originalFileName,
              mimeType: asset.mimeType,
              role: asset.role
            })
          )
        };
      })
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
      // The relations the Note pages show (D9): withdrawn and removed ones stay out.
      relations: relations
        .filter((relation) => relation.shown)
        .map((relation) => ({
          id: relation.id,
          sourceAtomicNoteId: relation.sourceAtomicNoteId,
          targetAtomicNoteId: relation.targetAtomicNoteId,
          sourceTitle: relation.sourceTitle,
          targetTitle: relation.targetTitle,
          sourceStatus: relation.sourceStatus,
          targetStatus: relation.targetStatus,
          // The stored pair is sorted by ID; the direction says how it reads (F3 D8), as far as
          // the owner or the decider gave one (decision 31b). An untyped relation reads neutral.
          direction: relation.shownDirection,
          relationType: relation.relationType ?? "related",
          band: relation.band,
          calibration: noteRelationCalibration(relation.metadata),
          state: relation.state,
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
    // A discarded note leaves the topic tree; an edited one is placed again once its new vector
    // exists (the `note-embedding` job).
    if (note && input.action === "discard") await this.options.topicHooks?.notesChanged([note.id]);
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

  /**
   * The prompt budget of the writer a summary operation runs on (plan decision 28): what its model
   * can take in one call, from the route's own metadata. A route that states nothing, or an AI
   * service that cannot say, gets the conservative fallback.
   */
  private async summaryBudgetFor(operation: string): Promise<SummaryBudget> {
    try {
      const capacity =
        typeof this.options.aiService.taskRouteCapacity === "function"
          ? await this.options.aiService.taskRouteCapacity("summarization", {
              operation,
              workloadClass: "write-fast"
            })
          : null;
      return summaryBudget(capacity);
    } catch {
      return summaryBudget(null);
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
              workloadClass: "write-fast",
              priority: "P2",
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
      ),
      async () => (await this.summaryBudgetFor("summary_reduce")).bytes
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
        ...(summary.reductionLevels ? { reductionLevels: summary.reductionLevels } : {}),
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
    // The roots whose summary was written or cleared: a header chunk built before follows it.
    const changedRootIds: string[] = [];
    let budget: SummaryBudget | null = null;
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
        changedRootIds.push(root.rootId);
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
      // One call while the subparts' summaries fit the active writer's window; past it, consecutive
      // batches combined by the same prompt until one call fits (plan decision 28).
      budget ??= await this.summaryBudgetFor("hierarchy_summary");
      const outcome = await summarizeSubpartsWithinBudget({
        source: { kind: aggregateSourceLabel(root.rootType), title: root.rootTitle },
        subparts: summarizedChildren.map((child) => ({
          title: child.childTitle,
          summary: child.summary
        })),
        budgetBytes: budget.bytes,
        run: (prompt, step) =>
          this.options.aiService.runDefaultTask(
            "summarization",
            prompt,
            {
              ...withAiSourceItems(logContext, [
                root.rootId,
                ...children.map((child) => child.childId)
              ]),
              operation: "hierarchy_summary",
              workloadClass: "write-fast",
              priority: "P2",
              promptVersion: hierarchyAggregateSummaryPromptVersion,
              sourceItemId: root.rootId,
              documentId: root.documentId,
              ...(step.batched ? { batchIndex: step.call } : {})
            },
            signal
          ),
        signal
      });
      const execution = outcome?.executions.at(-1);
      if (!outcome || !execution) continue;
      const summary = outcome.summary;
      if (summary.length === 0) {
        await createSourceSummaryRepository(pool).clearCurrent(root.rootId);
        await createSourceItemRepository(pool).update(root.rootId, {
          summary: null,
          summaryGeneratedAt: null
        });
        updateGroupedChildSummary(grouped, root.rootId, null);
        changedRootIds.push(root.rootId);
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
          skippedSubpartCount: missingSummaryCount,
          ...batchedSummaryMetadata(outcome, budget)
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
          skippedSubpartCount: missingSummaryCount,
          ...batchedSummaryMetadata(outcome, budget)
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
      changedRootIds.push(root.rootId);
    }
    return { generatedCount, reusedCount, blockedRoots, changedRootIds };
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
                workloadClass: "write-quality",
                priority: "P2",
                onProgress: (event) => onProgress?.(event.progress)
              },
              signal
            )
          );
          stage = "output_validation";
          return execution;
        },
        { pinned: isExtractionPinned() }
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
      const persistedNotes: AtomicNoteRecord[] = [];
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
        persistedNotes.push(note);
      }
      await hierarchy.completeKnowledgeGeneration(generationId);
      // A note is embedded when it is created, so matching never meets a note without a vector.
      // Embedding is derived data and calls no generative model: a failure here must not repeat the
      // generation, because matching embeds whatever is still missing.
      stage = "embedding";
      let embeddedCount = 0;
      try {
        embeddedCount = (
          await this.ensureAtomicNoteVectors(persistedNotes, {
            signal,
            logContext: {
              ...structuredLogContext,
              sourceItemId,
              documentId,
              stage: "atomic_note_embedding"
            },
            operation: "note_creation_embedding"
          })
        ).embedded.length;
      } catch (error) {
        if (signal?.aborted) throw error;
        logStructuredError(
          this.options.logger,
          "atomic_note_embedding_failed",
          { ...structuredLogContext, sourceItemId, documentId, stage },
          error,
          "atomic_note_embedding_failed"
        );
      }
      return { configured: true, generatedCount: noteIds.length, embeddedCount, noteIds };
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

  /**
   * Where the knowledge-graph task runs, `null` when no model is routed to it. A catalog header's
   * graph is replaced (its old chunk's mentions go with the chunk) only where it can be extracted
   * again, and a remote route counts against the daily cap of the headers' refresh.
   */
  public async catalogGraphLocality(): Promise<"local" | "remote" | null> {
    const ai = this.options.aiService;
    if (typeof ai.taskRouteLocality !== "function") return null;
    return ai.taskRouteLocality("knowledge-graph-generation", {
      operation: "graph_source_chunks",
      workloadClass: "write-quality"
    });
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
    // The recording-era path under MEMORA_GOLDEN_PIN=extraction (D5); otherwise batches by writer (D36).
    const pinned = isExtractionPinned();
    const locality =
      typeof this.options.aiService.taskRouteLocality === "function"
        ? await this.options.aiService.taskRouteLocality("knowledge-graph-generation", {
            operation: "graph_source_chunks",
            workloadClass: "write-quality"
          })
        : null;
    const batch = knowledgeGraphBatchFor(locality, { pinned });
    const batchLimits = { maxEntities: batch.maxEntities, maxRelations: batch.maxRelations };
    const maxInputCharacters = this.knowledgeGraphMaxInputCharacters ?? batch.maxInputCharacters;
    const salvaged = { items: 0, normalized: 0, dropped: {} as Record<string, number> };
    const onSalvage: NonNullable<
      Parameters<typeof generateKnowledgeGraphFromAtomicNotes>[4]
    >["onSalvage"] = ({ salvage }) => {
      salvaged.items += salvage.salvagedItems;
      salvaged.normalized += salvage.normalized;
      for (const [reason, count] of Object.entries(salvage.dropped))
        salvaged.dropped[reason] = (salvaged.dropped[reason] ?? 0) + (count ?? 0);
    };
    const resolveTypes = createRelationTypeResolver({
      pinned,
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
      pinned,
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
              workloadClass: "write-quality",
              priority: context.priority ?? "P2",
              onProgress: (event) => context.onProgress?.(event.progress)
            },
            signal
          )
        ),
      maxInputCharacters,
      {
        completedBatches,
        inputKind: processingMode ? "catalog_metadata" : "source_chunks",
        pinned,
        batchLimits,
        onSalvage,
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
                    workloadClass: "write-quality",
                    priority: context.priority ?? "P2",
                    onProgress: (event) => context.onProgress?.(event.progress)
                  },
                  signal
                )
              ),
            maxInputCharacters,
            {
              completedBatches,
              inputKind: "atomic_notes",
              pinned,
              batchLimits,
              onSalvage,
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
    // Items dropped with no call are counted apart from repairs (D35): `salvaged_items` in the monitoring.
    if (salvaged.items > 0)
      await trace("graph_salvage", async () => undefined, {
        salvaged_items: salvaged.items,
        normalized: salvaged.normalized,
        dropped: salvaged.dropped
      });
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
   * provider failure is thrown so the job retries it. A re-embedding after the embedding space
   * changed (D26) names that space: only a vector of the text in it makes the note `unchanged`,
   * and once the route writes to another space the job ends without a call (`space_moved`), so a
   * remote route is only ever paid on the owner's action for its own space (Q8).
   */
  public async embedAtomicNote(
    noteId: string,
    signal?: AbortSignal,
    logContext: AiTaskLogContext = {},
    options: { spaceKey?: string } = {}
  ): Promise<{
    embedded: boolean;
    reason?: "note_not_found" | "note_not_current" | "unchanged" | "no_embedding" | "space_moved";
  }> {
    const pool = this.requirePool();
    const note = await createAtomicNoteRepository(pool).findById(noteId);
    if (!note) return { embedded: false, reason: "note_not_found" };
    // A discarded or archived note takes no part in matching or search.
    if (note.status === "rejected" || note.status === "archived")
      return { embedded: false, reason: "note_not_current" };
    const text = atomicNoteEmbeddingText(note);
    // Matching may have embedded the edited text already (in the space a re-embedding names).
    const embeddings = createEmbeddingRepository(pool);
    const hash = sha256(text);
    const current = options.spaceKey
      ? await embeddings.hasContentHash(
          "atomic_note",
          note.id,
          hash,
          `${nativeEmbeddingStrategyPrefix}${options.spaceKey}`
        )
      : await embeddings.hasContentHash("atomic_note", note.id, hash);
    if (current) return { embedded: false, reason: "unchanged" };
    if (
      options.spaceKey &&
      (await this.options.aiService.embeddingRouteSpaceKey()) !== options.spaceKey
    )
      return { embedded: false, reason: "space_moved" };
    const execution = await this.options.aiService.runDefaultTask(
      "embedding",
      text,
      withAiSourceItems(
        {
          ...logContext,
          atomicNoteId: note.id,
          operation: "note_embedding",
          workloadClass: "embed",
          priority: "P2"
        },
        [note.createdFromSourceItemId]
      ),
      signal
    );
    const embedding = readEmbedding(execution?.output);
    if (!execution || !embedding) return { embedded: false, reason: "no_embedding" };
    await this.storeAtomicNoteEmbedding(note, execution, embedding);
    return { embedded: true };
  }

  /**
   * The matching vector of each note, embedding the notes that have none for their current text.
   * Embedding only, never a generative model. The notes without a vector are embedded in batches of
   * at most 32 texts, one lane request each (F3 D37), and the vector is reused by every later match.
   * A batch that fails is run again note by note, so one bad text costs only its own note; a note
   * whose call fails or has no model stays without a vector, which matching scores without vector
   * weights.
   */
  private async ensureAtomicNoteVectors(
    atomicNotes: AtomicNoteRecord[],
    input: {
      signal: AbortSignal | undefined;
      logContext: AiTaskLogContext;
      operation: string;
    }
  ): Promise<{ vectors: Map<string, NoteVector>; embedded: string[] }> {
    const vectors = new Map<string, NoteVector>();
    const embedded: string[] = [];
    if (atomicNotes.length === 0) return { vectors, embedded };
    const stored = await createEmbeddingRepository(this.requirePool()).findCurrentNoteVectors(
      atomicNotes.map((note) => ({
        id: note.id,
        contentHash: sha256(atomicNoteEmbeddingText(note))
      }))
    );
    for (const [noteId, vector] of stored)
      vectors.set(noteId, {
        embedding: vector.embedding,
        space: {
          model: vector.model,
          provider: vector.provider,
          runtime: vector.runtime,
          spaceKey: vector.strategy.startsWith(nativeEmbeddingStrategyPrefix)
            ? vector.strategy.slice(nativeEmbeddingStrategyPrefix.length)
            : ""
        }
      });
    const missing = atomicNotes.filter((note) => !vectors.has(note.id));
    for (const group of chunkTexts(missing, embedManyLimits.perExecution)) {
      for (const [noteId, vector] of await this.embedAtomicNoteVectors(group, input)) {
        vectors.set(noteId, vector);
        embedded.push(noteId);
      }
    }
    // One enqueue for the batch: a note that has its vector is ready for the topic tree.
    if (embedded.length > 0) await this.options.topicHooks?.notesChanged(embedded);
    return { vectors, embedded };
  }

  /**
   * Embeds a group of notes (at most one batch) with the current embedding route and stores their
   * vectors. A failed batch is embedded note by note; a route without a model embeds nothing.
   */
  private async embedAtomicNoteVectors(
    notes: AtomicNoteRecord[],
    input: { signal: AbortSignal | undefined; logContext: AiTaskLogContext; operation: string }
  ): Promise<Map<string, NoteVector>> {
    const found = new Map<string, NoteVector>();
    if (notes.length === 1) {
      const vector = await this.embedAtomicNoteVector(notes[0]!, input);
      if (vector) found.set(notes[0]!.id, vector);
      return found;
    }
    let execution: AiEmbedManyExecution | null;
    try {
      execution = await this.options.aiService.embedMany(
        notes.map(atomicNoteEmbeddingText),
        withAiSourceItems(
          {
            ...input.logContext,
            operation: input.operation,
            workloadClass: "embed",
            priority: "P2"
          },
          notes.map((note) => note.createdFromSourceItemId)
        ),
        input.signal
      );
    } catch (error) {
      if (input.signal?.aborted) throw error;
      for (const note of notes) {
        const vector = await this.embedAtomicNoteVector(note, input);
        if (vector) found.set(note.id, vector);
      }
      return found;
    }
    if (!execution) return found;
    for (const [index, note] of notes.entries()) {
      const embedding = execution.embeddings[index];
      if (!embedding) continue;
      await this.storeAtomicNoteEmbedding(note, execution, embedding);
      found.set(note.id, {
        embedding,
        space: {
          model: execution.modelId,
          provider: execution.providerId,
          runtime: execution.runtime,
          spaceKey: execution.embeddingSpaceKey
        }
      });
    }
    return found;
  }

  /** Embeds one note with the current embedding route and stores the vector; null when it cannot. */
  private async embedAtomicNoteVector(
    note: AtomicNoteRecord,
    input: { signal: AbortSignal | undefined; logContext: AiTaskLogContext; operation: string }
  ): Promise<NoteVector | null> {
    const execution = await this.tryRunDefaultTask(
      "embedding",
      atomicNoteEmbeddingText(note),
      input.signal,
      withAiSourceItems(
        {
          ...input.logContext,
          atomicNoteId: note.id,
          operation: input.operation,
          workloadClass: "embed",
          priority: "P2"
        },
        [note.createdFromSourceItemId]
      )
    );
    const embedding = readEmbedding(execution?.output);
    if (!execution || !embedding) return null;
    await this.storeAtomicNoteEmbedding(note, execution, embedding);
    return {
      embedding,
      space: {
        model: execution.modelId,
        provider: execution.providerId,
        runtime: execution.runtime,
        spaceKey: execution.embeddingSpaceKey ?? ""
      }
    };
  }

  private async storeAtomicNoteEmbedding(
    note: AtomicNoteRecord,
    execution: Pick<DefaultAiTaskResult, "providerId" | "modelId" | "runtime"> & {
      embeddingSpaceKey?: string | undefined;
    },
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
        ? `${nativeEmbeddingStrategyPrefix}${execution.embeddingSpaceKey}`
        : "native-unidentified",
      contentHash: sha256(atomicNoteEmbeddingText(note)),
      embedding
    });
  }

  /**
   * Relations v2 for these notes (F3 T51): the relation matcher retrieves, decides, calibrates and
   * bands each note in order (`relations/relation-matcher.ts`). A decided note's accepted pairs go
   * to `onNoteDecided`; no relation is persisted here (D21): ingestion keeps them in its checkpoint
   * and the link job of the source types and persists them (T52). Mode `ranker` without a
   * validated ranker makes no call and returns `skipped: "waiting_for_decider"`.
   */
  public async matchAtomicNotes(
    noteIds: string[],
    signal?: AbortSignal,
    onProgress?: (progress: number) => void | Promise<void>,
    logContext: AiTaskLogContext = {},
    options: {
      /** Called once a note is decided and its pairs handed on: a resumable checkpoint. */
      onNoteCompleted?: (noteId: string, persistedCount: number) => void | Promise<void>;
      /** Receives each decided note that accepted a pair, before its `onNoteCompleted`. */
      onNoteDecided?: (note: DecidedNote) => void | Promise<void>;
      /** The visibility fence of a re-match run (F3 3.17): retrieval sees only these roots. */
      fence?: RetrievalFence;
    } = {}
  ): Promise<MatchNotesResult> {
    const pool = this.requirePool();
    const notes = createAtomicNoteRepository(pool);
    const current: AtomicNoteRecord[] = [];
    for (const noteId of noteIds) {
      const note = await notes.findById(noteId);
      if (
        note &&
        note.status !== "rejected" &&
        note.status !== "archived" &&
        note.supersessionStatus === "current"
      )
        current.push(note);
    }
    // Notes are embedded when they are created. Only a note that still has no vector for its
    // current text (an older library, a failed call) is embedded here, all of the batch before the
    // first retrieval, so no note is matched while another one of the batch is still invisible.
    const { vectors } = await this.ensureAtomicNoteVectors(current, {
      signal,
      logContext,
      operation: "note_matching_embedding"
    });
    return this.relationMatcher.matchNotes({
      noteIds,
      vectors,
      signal,
      logContext,
      onProgress,
      onNoteCompleted: options.onNoteCompleted,
      fence: options.fence,
      handOff: async (note) => {
        await options.onNoteDecided?.(note);
        return 0;
      }
    });
  }

  /**
   * Whether note matching would decide now: false while mode `ranker` waits for a validated ranker
   * (C7). Matching stages skipped to wait are re-run by the stage-level retry once it is true.
   */
  public async noteDeciderAvailable(): Promise<boolean> {
    return this.relationMatcher.deciderAvailable();
  }

  /**
   * The link job's typing step (F3 D20, `relations/relation-typing.ts`) on the writer route of
   * `op:relation_typing` / `class:write-fast`, with the typing cache. The routes are read after the
   * legacy mapping wrote the class routes, as for any call.
   */
  public async typeRelationPairs(
    pairs: readonly TypingPair[],
    options: RelationTypingOptions,
    signal?: AbortSignal
  ) {
    const pool = this.requirePool();
    const resolve = createTyperRouteResolver(createAiConfigRepository(pool));
    const contentLanguage = await this.options.getContentLanguage?.();
    return typeRelationPairs(
      {
        ai: this.options.aiService,
        store: createRelationTypingRepository(pool),
        resolveRoute: async () => {
          await this.options.aiService.ensureLegacyRouteMapping?.();
          return resolve();
        },
        ...(contentLanguage ? { contentLanguage } : {}),
        ...(this.options.logger
          ? { logger: { warn: (message, error) => this.options.logger!.warn(message, error) } }
          : {})
      },
      pairs,
      options,
      signal
    );
  }

  /**
   * The link job's discovery step for one root: design E (D27) on the root, promotion and then the
   * nearest-root discovery, each selected pair judged once under the link jobs' in-flight registry
   * (D24, keyed by source-pair key). Its calls run at the link job's priority and each remote one
   * is asked of the daily cap first (D26): a refused call stops the pass with
   * `errors.relations.dailyCapReached`, and the pass's saved state lets the next link job resume it.
   */
  public async discoverSourceRelations(input: RelationDiscoveryInput, signal?: AbortSignal) {
    const pool = this.requirePool();
    const ai = this.options.aiService;
    const judgeLane = async (): Promise<"local" | "remote"> => {
      const route = await createAiConfigRepository(pool).getDefaultTask(
        "reranking",
        undefined,
        aiRouteKeys("reranking", { operation: sourceMatchingOperation, workloadClass: "decide" })
      );
      return route && executionLane(route).lane !== "local" ? "remote" : "local";
    };
    return matchSources({
      pool,
      ai: {
        // The class routes exist before the judge's route is read (D34).
        ensureLegacyRouteMapping: async () => {
          await ai.ensureLegacyRouteMapping?.();
        },
        runDefaultTask: async (task, prompt, context, callSignal, limits) => {
          // The v5 source judge only ever runs the reranking task.
          if (task !== "reranking") throw new Error("relation_discovery_task_invalid");
          if (!(await input.reserveCall(await judgeLane()))) throw new Error(relationDailyCapError);
          // The source judge on its op: route and class decide (D16, R5), at the link job's priority.
          return ai.runDefaultTask(
            "reranking",
            prompt,
            {
              ...context,
              operation: sourceMatchingOperation,
              workloadClass: "decide",
              priority: input.priority
            },
            callSignal,
            limits
          );
        }
      },
      sourceIds: [input.rootId],
      runKey: input.runKey,
      settings: SourceRelationSettingsSchema.parse(
        (await this.options.getSourceRelationSettings?.()) ?? {}
      ),
      contentLanguage: (await this.options.getContentLanguage?.()) ?? "en",
      regenerate: input.regenerate,
      registry: input.registry,
      ...(signal ? { signal } : {}),
      context: input.context
    });
  }

  /** The key note matching decides under now; null while it waits for a validated ranker (T52b). */
  public currentRelationDeciderKey(): Promise<string | null> {
    return this.relationMatcher.currentDeciderKey();
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

const nativeEmbeddingStrategyPrefix = "native-v2:";

/** A note's matching vector with the embedding space it was built in (the key of its strategy). */
interface NoteVector {
  embedding: number[];
  space: { model: string; provider: string; runtime: string; spaceKey: string };
}

/** The text a note is embedded from; its hash tells whether a stored vector is still current. */
function atomicNoteEmbeddingText(note: AtomicNoteRecord): string {
  return renderPrompt("embedding.content.note", {
    note_title: note.title,
    note_idea: note.ideaStatement,
    note_body: note.bodyMarkdown
  });
}

export function serializeNote(note: AtomicNoteRecord) {
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
    humanProtected: note.metadata.humanProtected === true,
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
