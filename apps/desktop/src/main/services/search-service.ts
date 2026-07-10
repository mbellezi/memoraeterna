import { createSearchRepository, type PgPool } from "@app/db";
import type { SearchInput, SearchResult } from "../../shared/ipc.js";

import type { AiService } from "./ai-service.js";

export class SearchService {
  public constructor(
    private readonly getPool: () => PgPool | null,
    private readonly aiService: AiService
  ) {}

  public async search(input: SearchInput): Promise<SearchResult[]> {
    let embedding: number[] | undefined;
    let embeddingModel: string | undefined;
    if (input.mode === "hybrid") {
      try {
        const generated = await this.aiService.runDefaultTask("embedding", input.text);
        if (generated && Array.isArray(generated.output)) {
          const candidate = generated.output.map(Number);
          if ((candidate.length === 256 || candidate.length === 768) && candidate.every(Number.isFinite)) {
            embedding = candidate;
            embeddingModel = generated.modelId;
          }
        }
      } catch {
        // Text search remains available when a configured remote provider is offline.
      }
    }
    const rows = await createSearchRepository(this.requirePool()).search({
      text: input.text,
      sourceTypes: input.sourceTypes,
      limit: input.limit,
      ...(embedding ? { embedding } : {}),
      ...(embeddingModel ? { embeddingModel } : {})
    });
    return rows.map((row) => ({
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
    }));
  }

  private requirePool(): PgPool {
    const pool = this.getPool();
    if (!pool) throw new Error("errors.database.notReady");
    return pool;
  }
}
