import {
  createSearchRepository,
  createHierarchicalIngestionRepository,
  createKnowledgeGraphRepository,
  createSimilarityDebugRepository,
  type AtomicNoteSearchRecord,
  type GraphEntitySearchRecord,
  type GraphRelationSearchRecord,
  type PgPool,
  type SearchEvidenceRecord
} from "@app/db";
import type { SearchInput, SearchResult } from "../../shared/ipc.js";

import type { AiService } from "./ai-service.js";

const reciprocalRankConstant = 60;

interface FusionRanks {
  textRank: number | null;
  vectorRank: number | null;
  graphRank: number | null;
  fusionScore: number;
}

export type FusedSearchCandidate = SearchEvidenceRecord & FusionRanks;

export type FusedNoteCandidate = AtomicNoteSearchRecord & FusionRanks;

type MergedCandidate =
  | { kind: "chunk"; candidate: FusedSearchCandidate }
  | { kind: "atomic_note"; candidate: FusedNoteCandidate };

type DisplayCandidate = MergedCandidate
  | { kind: "entity"; candidate: GraphEntitySearchRecord }
  | { kind: "relation"; candidate: GraphRelationSearchRecord };

export class SearchService {
  public constructor(
    private readonly getPool: () => PgPool | null,
    private readonly aiService: AiService,
    private readonly isDebugEnabled: () => Promise<boolean> = async () => false
  ) {}

  public async search(input: SearchInput): Promise<SearchResult[]> {
    const pool = this.requirePool();
    const repository = createSearchRepository(pool);
    const hierarchy = createHierarchicalIngestionRepository(pool);
    const sourceItemIds = input.rootSourceItemId
      ? [input.rootSourceItemId, ...(await hierarchy.listDescendants(input.rootSourceItemId)).map((source) => source.id)]
      : [];
    let embedding: number[] | undefined;
    let embeddingModel: string | undefined;
    if (input.mode === "hybrid") {
      try {
        const generated = await this.aiService.runDefaultTask("embedding", input.text);
        if (generated && Array.isArray(generated.output)) {
          const candidate = generated.output.map(Number);
          if ((candidate.length === 256 || candidate.length === 768 || candidate.length === 1_024)
              && candidate.every(Number.isFinite)) {
            embedding = candidate;
            embeddingModel = generated.modelId;
          }
        }
      } catch {
        // Text search remains available when the embedding model is unavailable.
      }
    }

    const candidateLimit = Math.min(300, Math.max(50, input.limit * 3));
    const textCandidates = await repository.searchText({
      text: input.text,
      sourceTypes: input.sourceTypes,
      sourceItemIds,
      limit: candidateLimit
    });
    const vectorCandidates = embedding && embeddingModel
      ? await repository.searchVector({
          embedding,
          embeddingModel,
          sourceTypes: input.sourceTypes,
          sourceItemIds,
          limit: candidateLimit
        })
      : [];
    let graphCandidates: SearchEvidenceRecord[] = [];
    let graphEntities: GraphEntitySearchRecord[] = [];
    let graphRelations: GraphRelationSearchRecord[] = [];
    let graphError: string | null = null;
    try {
      graphCandidates = await createKnowledgeGraphRepository(pool).searchChunks({
        text: input.text,
        sourceTypes: input.sourceTypes,
        sourceItemIds,
        limit: candidateLimit
      });
    } catch (error) {
      graphError = error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
    }
    try {
      const elements = await createKnowledgeGraphRepository(pool).searchElements({
        text: input.text,
        sourceTypes: input.sourceTypes,
        sourceItemIds,
        limit: candidateLimit
      });
      graphEntities = elements.entities;
      graphRelations = elements.relations;
    } catch (error) {
      graphError ??= error instanceof Error ? error.message.slice(0, 500) : String(error).slice(0, 500);
    }
    const noteTextCandidates = await repository.searchNotesText({
      text: input.text,
      sourceTypes: input.sourceTypes,
      sourceItemIds,
      limit: candidateLimit
    });
    const noteVectorCandidates = embedding && embeddingModel
      ? await repository.searchNotesVector({
          embedding,
          embeddingModel,
          sourceTypes: input.sourceTypes,
          sourceItemIds,
          limit: candidateLimit
        })
      : [];

    const candidates = (input.mode === "hybrid" && vectorCandidates.length > 0) || graphCandidates.length > 0
      ? fuseSearchRankings(textCandidates, vectorCandidates, graphCandidates)
      : textCandidates.map((candidate, index) => ({
          ...candidate,
          textRank: index + 1,
          vectorRank: null,
          graphRank: null,
          fusionScore: candidate.textScore,
          finalScore: candidate.textScore
        }));
    const noteCandidates = noteVectorCandidates.length > 0
      ? fuseRankings((candidate) => candidate.noteId, noteTextCandidates, noteVectorCandidates)
      : noteTextCandidates.map((candidate, index) => ({
          ...candidate,
          textRank: index + 1,
          vectorRank: null,
          graphRank: null,
          fusionScore: candidate.textScore,
          finalScore: candidate.textScore
        }));
    const merged: MergedCandidate[] = [
      ...candidates.map((candidate) => ({ kind: "chunk" as const, candidate })),
      ...noteCandidates.map((candidate) => ({ kind: "atomic_note" as const, candidate }))
    ].sort((left, right) => right.candidate.finalScore - left.candidate.finalScore
      || mergedCandidateId(left).localeCompare(mergedCandidateId(right)));
    const displayCandidates: DisplayCandidate[] = [
      ...merged,
      ...graphEntities.map((candidate) => ({ kind: "entity" as const, candidate })),
      ...graphRelations.map((candidate) => ({ kind: "relation" as const, candidate }))
    ].sort((left, right) => right.candidate.finalScore - left.candidate.finalScore
      || displayCandidateId(left).localeCompare(displayCandidateId(right)));

    await this.recordDebugRun(pool, input, merged, {
      embeddingModel,
      dimensions: embedding?.length,
      textCandidateCount: textCandidates.length,
      vectorCandidateCount: vectorCandidates.length,
      graphCandidateCount: graphCandidates.length,
      noteTextCandidateCount: noteTextCandidates.length,
      noteVectorCandidateCount: noteVectorCandidates.length,
      graphError,
      candidateLimit
    });

    const selected = displayCandidates.slice(0, input.limit);
    const breadcrumbs = await hierarchy.getBreadcrumbs([...new Set(selected.map(({ candidate }) => candidate.sourceItemId))]);
    return selected.map((entry) => {
      const candidate = { ...entry.candidate, breadcrumbs: breadcrumbs.get(entry.candidate.sourceItemId) ?? [] };
      if (entry.kind === "chunk") return toSearchResult(candidate as FusedSearchCandidate);
      if (entry.kind === "atomic_note") return toNoteSearchResult(candidate as FusedNoteCandidate);
      if (entry.kind === "entity") return toEntitySearchResult(candidate as GraphEntitySearchRecord);
      return toRelationSearchResult(candidate as GraphRelationSearchRecord);
    });
  }

  private async recordDebugRun(
    pool: PgPool,
    input: SearchInput,
    candidates: MergedCandidate[],
    context: {
      embeddingModel: string | undefined;
      dimensions: number | undefined;
      textCandidateCount: number;
      vectorCandidateCount: number;
      graphCandidateCount: number;
      noteTextCandidateCount: number;
      noteVectorCandidateCount: number;
      graphError: string | null;
      candidateLimit: number;
    }
  ): Promise<void> {
    try {
      if (!await this.isDebugEnabled()) return;
      await createSimilarityDebugRepository(pool).record({
        kind: "chunk_search",
        queryText: input.text,
        mode: input.mode,
        model: context.embeddingModel ?? null,
        dimensions: context.dimensions ?? null,
        requestedLimit: input.limit,
        strategy: context.vectorCandidateCount > 0 || context.graphCandidateCount > 0
          ? "reciprocal_rank_fusion"
          : "text_only",
        metadata: {
          reciprocalRankConstant,
          candidateLimit: context.candidateLimit,
          textCandidateCount: context.textCandidateCount,
          vectorCandidateCount: context.vectorCandidateCount,
          graphCandidateCount: context.graphCandidateCount,
          noteTextCandidateCount: context.noteTextCandidateCount,
          noteVectorCandidateCount: context.noteVectorCandidateCount,
          graphStatus: context.graphError ? "failed" : context.graphCandidateCount > 0 ? "succeeded" : "no_signal",
          graphError: context.graphError,
          sourceTypes: input.sourceTypes
        },
        results: candidates.map((entry, index) => ({
          targetType: entry.kind,
          targetId: entry.kind === "chunk" ? entry.candidate.chunkId : entry.candidate.noteId,
          targetLabel: entry.kind === "chunk"
            ? `${entry.candidate.sourceTitle} — ${entry.candidate.excerpt.slice(0, 180)}`
            : `${entry.candidate.sourceTitle} — ${entry.candidate.title}`,
          finalRank: index + 1,
          textRank: entry.candidate.textRank,
          vectorRank: entry.candidate.vectorRank,
          graphRank: entry.candidate.graphRank,
          textScore: entry.candidate.textScore,
          vectorScore: entry.candidate.vectorScore,
          graphScore: entry.candidate.graphScore,
          fusionScore: entry.candidate.fusionScore,
          finalScore: entry.candidate.finalScore,
          metadata: entry.kind === "chunk"
            ? {
                sourceItemId: entry.candidate.sourceItemId,
                documentId: entry.candidate.documentId,
                sourceSpanId: entry.candidate.sourceSpanId,
                page: entry.candidate.page
              }
            : {
                sourceItemId: entry.candidate.sourceItemId,
                noteStatus: entry.candidate.status
              }
        }))
      });
    } catch {
      // Debug persistence must never make the user search fail.
    }
  }

  private requirePool(): PgPool {
    const pool = this.getPool();
    if (!pool) throw new Error("errors.database.notReady");
    return pool;
  }
}

interface FusableCandidate {
  textScore: number;
  vectorScore: number;
  graphScore: number;
  finalScore: number;
}

export function fuseRankings<T extends FusableCandidate>(
  keyOf: (candidate: T) => string,
  textCandidates: T[],
  vectorCandidates: T[],
  graphCandidates: T[] = []
): Array<T & FusionRanks> {
  const candidates = new Map<string, T & FusionRanks>();
  textCandidates.forEach((candidate, index) => {
    candidates.set(keyOf(candidate), {
      ...candidate,
      vectorScore: 0,
      graphScore: 0,
      textRank: index + 1,
      vectorRank: null,
      graphRank: null,
      fusionScore: 0,
      finalScore: 0
    });
  });
  vectorCandidates.forEach((candidate, index) => {
    const current = candidates.get(keyOf(candidate));
    candidates.set(keyOf(candidate), {
      ...(current ?? candidate),
      textScore: current?.textScore ?? 0,
      vectorScore: candidate.vectorScore,
      textRank: current?.textRank ?? null,
      vectorRank: index + 1,
      graphRank: current?.graphRank ?? null,
      fusionScore: 0,
      finalScore: 0
    });
  });
  graphCandidates.forEach((candidate, index) => {
    const current = candidates.get(keyOf(candidate));
    candidates.set(keyOf(candidate), {
      ...(current ?? candidate),
      textScore: current?.textScore ?? 0,
      vectorScore: current?.vectorScore ?? 0,
      graphScore: candidate.graphScore,
      textRank: current?.textRank ?? null,
      vectorRank: current?.vectorRank ?? null,
      graphRank: index + 1,
      fusionScore: 0,
      finalScore: 0
    });
  });

  const activeRankings = Math.max(1,
    (textCandidates.length > 0 ? 1 : 0)
      + (vectorCandidates.length > 0 ? 1 : 0)
      + (graphCandidates.length > 0 ? 1 : 0));
  const maximumRrf = activeRankings / (reciprocalRankConstant + 1);
  return [...candidates.values()]
    .map((candidate) => {
      const rawRrf = (candidate.textRank ? 1 / (reciprocalRankConstant + candidate.textRank) : 0)
        + (candidate.vectorRank ? 1 / (reciprocalRankConstant + candidate.vectorRank) : 0);
      const graphRrf = candidate.graphRank ? 1 / (reciprocalRankConstant + candidate.graphRank) : 0;
      const fusionScore = (rawRrf + graphRrf) / maximumRrf;
      return { ...candidate, fusionScore, finalScore: fusionScore };
    })
    .sort((left, right) => right.fusionScore - left.fusionScore
      || right.vectorScore - left.vectorScore
      || right.graphScore - left.graphScore
      || right.textScore - left.textScore
      || keyOf(left).localeCompare(keyOf(right)));
}

export function fuseSearchRankings(
  textCandidates: SearchEvidenceRecord[],
  vectorCandidates: SearchEvidenceRecord[],
  graphCandidates: SearchEvidenceRecord[] = []
): FusedSearchCandidate[] {
  return fuseRankings((candidate) => candidate.chunkId, textCandidates, vectorCandidates, graphCandidates);
}

function mergedCandidateId(entry: MergedCandidate): string {
  return entry.kind === "chunk" ? entry.candidate.chunkId : entry.candidate.noteId;
}

function displayCandidateId(entry: DisplayCandidate): string {
  if (entry.kind === "entity") return entry.candidate.entityId;
  if (entry.kind === "relation") return entry.candidate.relationId;
  return mergedCandidateId(entry);
}

function toNoteSearchResult(row: AtomicNoteSearchRecord): SearchResult {
  return {
    kind: "atomic_note",
    noteId: row.noteId,
    sourceItemId: row.sourceItemId,
    sourceTitle: row.sourceTitle,
    sourceType: row.sourceType,
    breadcrumbs: row.breadcrumbs ?? [],
    title: row.title,
    ideaStatement: row.ideaStatement,
    excerpt: row.excerpt,
    status: row.status,
    textScore: row.textScore,
    vectorScore: row.vectorScore,
    graphScore: row.graphScore,
    finalScore: row.finalScore
  };
}

function toSearchResult(row: SearchEvidenceRecord): SearchResult {
  return {
    kind: "chunk",
    sourceItemId: row.sourceItemId,
    sourceTitle: row.sourceTitle,
    sourceType: row.sourceType,
    breadcrumbs: row.breadcrumbs ?? [],
    documentId: row.documentId,
    chunkId: row.chunkId,
    excerpt: row.excerpt,
    textScore: row.textScore,
    vectorScore: row.vectorScore,
    graphScore: row.graphScore,
    finalScore: row.finalScore,
    ...(row.sourceSpanId ? { sourceSpanId: row.sourceSpanId } : {}),
    ...(row.page ? { page: row.page } : {}),
    ...(row.sourceBlockId ? { sourceBlockId: row.sourceBlockId } : {}),
    ...(row.boundingBox
      ? { boundingBox: row.boundingBox as Extract<SearchResult, { kind: "chunk" }>["boundingBox"] }
      : {}),
    ...(row.selector ? { selector: row.selector } : {})
  };
}

function toEntitySearchResult(row: GraphEntitySearchRecord): SearchResult {
  return {
    kind: "entity",
    entityId: row.entityId,
    entityType: row.entityType as Extract<SearchResult, { kind: "entity" }>["entityType"],
    canonicalName: row.canonicalName,
    aliases: row.aliases,
    description: row.description,
    sourceItemId: row.sourceItemId,
    sourceTitle: row.sourceTitle,
    sourceType: row.sourceType,
    breadcrumbs: row.breadcrumbs ?? [],
    excerpt: row.excerpt,
    graphScore: row.graphScore,
    finalScore: row.finalScore
  };
}

function toRelationSearchResult(row: GraphRelationSearchRecord): SearchResult {
  return {
    kind: "relation",
    relationId: row.relationId,
    subjectEntityId: row.subjectEntityId,
    subjectName: row.subjectName,
    predicate: row.predicate,
    objectEntityId: row.objectEntityId,
    objectName: row.objectName,
    sourceItemId: row.sourceItemId,
    sourceTitle: row.sourceTitle,
    sourceType: row.sourceType,
    breadcrumbs: row.breadcrumbs ?? [],
    excerpt: row.excerpt,
    graphScore: row.graphScore,
    finalScore: row.finalScore
  };
}
