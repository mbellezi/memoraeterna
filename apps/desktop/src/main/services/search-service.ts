import {
  createSearchRepository,
  createSimilarityDebugRepository,
  type PgPool,
  type SearchEvidenceRecord
} from "@app/db";
import type { SearchInput, SearchResult } from "../../shared/ipc.js";

import type { AiService } from "./ai-service.js";

const reciprocalRankConstant = 60;

export interface FusedSearchCandidate extends SearchEvidenceRecord {
  textRank: number | null;
  vectorRank: number | null;
  fusionScore: number;
}

export class SearchService {
  public constructor(
    private readonly getPool: () => PgPool | null,
    private readonly aiService: AiService,
    private readonly isDebugEnabled: () => Promise<boolean> = async () => false
  ) {}

  public async search(input: SearchInput): Promise<SearchResult[]> {
    const pool = this.requirePool();
    const repository = createSearchRepository(pool);
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
      limit: candidateLimit
    });
    const vectorCandidates = embedding && embeddingModel
      ? await repository.searchVector({
          embedding,
          embeddingModel,
          sourceTypes: input.sourceTypes,
          limit: candidateLimit
        })
      : [];
    const candidates = input.mode === "hybrid" && vectorCandidates.length > 0
      ? fuseSearchRankings(textCandidates, vectorCandidates)
      : textCandidates.map((candidate, index) => ({
          ...candidate,
          textRank: index + 1,
          vectorRank: null,
          fusionScore: candidate.textScore,
          finalScore: candidate.textScore
        }));

    await this.recordDebugRun(pool, input, candidates, {
      embeddingModel,
      dimensions: embedding?.length,
      textCandidateCount: textCandidates.length,
      vectorCandidateCount: vectorCandidates.length,
      candidateLimit
    });

    return candidates.slice(0, input.limit).map(toSearchResult);
  }

  private async recordDebugRun(
    pool: PgPool,
    input: SearchInput,
    candidates: FusedSearchCandidate[],
    context: {
      embeddingModel: string | undefined;
      dimensions: number | undefined;
      textCandidateCount: number;
      vectorCandidateCount: number;
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
        strategy: context.vectorCandidateCount > 0 ? "reciprocal_rank_fusion" : "text_only",
        metadata: {
          reciprocalRankConstant,
          candidateLimit: context.candidateLimit,
          textCandidateCount: context.textCandidateCount,
          vectorCandidateCount: context.vectorCandidateCount,
          sourceTypes: input.sourceTypes
        },
        results: candidates.map((candidate, index) => ({
          targetType: "chunk",
          targetId: candidate.chunkId,
          targetLabel: `${candidate.sourceTitle} — ${candidate.excerpt.slice(0, 180)}`,
          finalRank: index + 1,
          textRank: candidate.textRank,
          vectorRank: candidate.vectorRank,
          textScore: candidate.textScore,
          vectorScore: candidate.vectorScore,
          fusionScore: candidate.fusionScore,
          finalScore: candidate.finalScore,
          metadata: {
            sourceItemId: candidate.sourceItemId,
            documentId: candidate.documentId,
            sourceSpanId: candidate.sourceSpanId,
            page: candidate.page
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

export function fuseSearchRankings(
  textCandidates: SearchEvidenceRecord[],
  vectorCandidates: SearchEvidenceRecord[]
): FusedSearchCandidate[] {
  const candidates = new Map<string, FusedSearchCandidate>();
  textCandidates.forEach((candidate, index) => {
    candidates.set(candidate.chunkId, {
      ...candidate,
      vectorScore: 0,
      textRank: index + 1,
      vectorRank: null,
      fusionScore: 0,
      finalScore: 0
    });
  });
  vectorCandidates.forEach((candidate, index) => {
    const current = candidates.get(candidate.chunkId);
    candidates.set(candidate.chunkId, {
      ...(current ?? candidate),
      textScore: current?.textScore ?? 0,
      vectorScore: candidate.vectorScore,
      textRank: current?.textRank ?? null,
      vectorRank: index + 1,
      fusionScore: 0,
      finalScore: 0
    });
  });

  const maximumRrf = 2 / (reciprocalRankConstant + 1);
  return [...candidates.values()]
    .map((candidate) => {
      const rawRrf = (candidate.textRank ? 1 / (reciprocalRankConstant + candidate.textRank) : 0)
        + (candidate.vectorRank ? 1 / (reciprocalRankConstant + candidate.vectorRank) : 0);
      const fusionScore = rawRrf / maximumRrf;
      return { ...candidate, fusionScore, finalScore: fusionScore };
    })
    .sort((left, right) => right.fusionScore - left.fusionScore
      || right.vectorScore - left.vectorScore
      || right.textScore - left.textScore
      || left.chunkId.localeCompare(right.chunkId));
}

function toSearchResult(row: SearchEvidenceRecord): SearchResult {
  return {
    sourceItemId: row.sourceItemId,
    sourceTitle: row.sourceTitle,
    sourceType: row.sourceType,
    documentId: row.documentId,
    chunkId: row.chunkId,
    excerpt: row.excerpt,
    textScore: row.textScore,
    vectorScore: row.vectorScore,
    finalScore: row.finalScore,
    ...(row.sourceSpanId ? { sourceSpanId: row.sourceSpanId } : {}),
    ...(row.page ? { page: row.page } : {}),
    ...(row.sourceBlockId ? { sourceBlockId: row.sourceBlockId } : {}),
    ...(row.boundingBox ? { boundingBox: row.boundingBox as SearchResult["boundingBox"] } : {}),
    ...(row.selector ? { selector: row.selector } : {})
  };
}
