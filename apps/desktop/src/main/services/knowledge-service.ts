import { sha256 } from "@app/conversion";
import { join, resolve, sep } from "node:path";
import {
  createAtomicNoteRelationRepository,
  createAtomicNoteRepository,
  createChunkRepository,
  createDocumentAssetRepository,
  createDocumentRepository,
  createEmbeddingRepository,
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
import { logStructuredError } from "./structured-logging.js";
import {
  atomicNoteMatchingVersion,
  atomicNotePromptVersion,
  buildBatchRerankPrompt,
  calculateAtomicNoteMatchingProgress,
  calculateRelationScore,
  fuseAtomicNoteCandidateRankings,
  generateAtomicNoteCandidates,
  generateKnowledgeGraphFromAtomicNotes,
  generateSummaryFromChunks,
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

const atomicNoteTextCandidateLimit = 30;
const atomicNoteVectorCandidateLimit = 30;
const atomicNoteGraphCandidateLimit = 20;
const atomicNoteFusedCandidateLimit = 30;

export interface KnowledgeServiceOptions {
  getPool: () => PgPool | null;
  aiService: AiService;
  relationThreshold?: number;
  getRelationThreshold?: () => Promise<number>;
  summaryMaxInputCharacters?: number;
  knowledgeGraphMaxInputCharacters?: number;
  userDataPath: string;
  getUploadedFilesBasePath: () => Promise<string | null>;
  isDebugEnabled?: () => Promise<boolean>;
  logger?: Pick<Console, "error">;
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

  public constructor(private readonly options: KnowledgeServiceOptions) {
    this.relationThreshold = clamp(options.relationThreshold ?? 0.72);
    this.summaryMaxInputCharacters = Math.max(2_000, options.summaryMaxInputCharacters ?? 12_000);
    this.knowledgeGraphMaxInputCharacters = Math.max(2_000, options.knowledgeGraphMaxInputCharacters ?? 3_500);
  }

  public async listLibrary(sourceTypes: SourceItemType[] = []) {
    return (await createLibraryRepository(this.requirePool()).listSources({ sourceTypes })).map((source) => ({
      ...source,
      summary: source.summary ? normalizeSummaryText(source.summary) : null,
      updatedAt: source.updatedAt.toISOString()
    }));
  }

  public async getSourceDetail(sourceItemId: string) {
    const pool = this.requirePool();
    const source = await createSourceItemRepository(pool).findById(sourceItemId);
    if (!source) return null;
    const documents = await createDocumentRepository(pool).listBySourceItem(sourceItemId);
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
      id: source.id,
      type: source.type,
      title: source.title,
      subtitle: source.subtitle,
      sourceUri: source.sourceUri,
      language: source.language,
      summary: source.summary ? normalizeSummaryText(source.summary) : null,
      metadata: source.metadata,
      updatedAt: source.updatedAt.toISOString(),
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
    if (!source || !document || document.sourceItemId !== source.id) throw new Error("source_document_not_found");
    const chunks = await createChunkRepository(pool).listByDocument(documentId);
    const summary = await generateSummaryFromChunks(
      chunks.length > 0
        ? chunks.map((chunk) => ({ id: chunk.id, content: chunk.content }))
        : [{ id: document.id, content: document.canonicalMarkdown }],
      async (prompt) => toKnowledgeExecution(await this.options.aiService.runDefaultTask(
        "summarization",
        prompt,
        { ...logContext, onProgress: (event) => onProgress?.(event.progress) },
        signal
      )),
      this.summaryMaxInputCharacters
    );
    if (!summary) return { configured: false, generated: false, mapReduce: false };
    const finalExecution = summary.executions.at(-1);
    if (!finalExecution) throw new Error("summary_execution_missing");
    const persisted = await createSourceSummaryRepository(pool).create({
      sourceItemId,
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
        promptVersion: knowledgeGraphPromptVersion
      }
    });
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
        logContext
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
            logContext,
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
