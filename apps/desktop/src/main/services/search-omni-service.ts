import { performance } from "node:perf_hooks";

import { createOmniSearchRepository, type OmniQueryEmbedding, type PgPool } from "@app/db";

import {
  SearchOmniInputSchema,
  SearchOmniResultSchema,
  type SearchOmniResult
} from "../../shared/ipc-search.js";
import type { AiService } from "./ai-service.js";

/** What the service needs of the AI layer: one query embedding with the routed model. */
export type OmniQueryEmbedder = Pick<AiService, "runDefaultTask">;

const vectorDimensions = new Set([256, 768, 1_024]);

/**
 * `search.omni` (F5 D12): the one retriever of every search surface. Quick mode (Cmd-K) is one SQL
 * statement over titles, names and full text, with no AI. Full mode (the search results panel) also
 * reads passages and, when an embedding model is routed, embeds the query at P0 and adds the
 * nearest notes and passages; without one it answers with the text arms and says so
 * (`degraded: ["ann"]`). Read-only: nothing is stored, the query included.
 */
export class SearchOmniService {
  constructor(
    private readonly getPool: () => PgPool | null,
    private readonly embedder: OmniQueryEmbedder | null
  ) {}

  async omni(input: unknown): Promise<SearchOmniResult> {
    const started = performance.now();
    const request = SearchOmniInputSchema.parse(input);
    const pool = this.getPool();
    if (!pool) throw new Error("errors.database.notReady");
    const embedding = request.mode === "full" ? await this.embed(request.query) : null;
    const outcome = await createOmniSearchRepository(pool).search({
      query: request.query,
      mode: request.mode,
      kinds: request.kinds,
      topicId: request.scope?.topicId,
      limit: request.limit,
      embedding
    });
    const degraded: SearchOmniResult["degraded"] = [];
    if (request.mode === "full" && !outcome.vectors) degraded.push("ann");
    if (!outcome.fullText) degraded.push("fts");
    return SearchOmniResultSchema.parse({
      requestId: request.requestId,
      items: outcome.items,
      degraded,
      tookMs: Math.round(performance.now() - started)
    });
  }

  /**
   * The query's vector in the routed embedding space, or null when there is no embedding model,
   * it fails, or it answers with something that is not a vector of a stored dimension.
   */
  private async embed(query: string): Promise<OmniQueryEmbedding | null> {
    if (!this.embedder) return null;
    try {
      const result = await this.embedder.runDefaultTask("embedding", query, {
        stage: "knowledge_search",
        embeddingInputType: "query",
        workloadClass: "embed",
        priority: "P0",
        budgetClass: "interactive"
      });
      if (!result || !Array.isArray(result.output) || !result.embeddingSpaceKey) return null;
      const vector = result.output.map(Number);
      if (!vectorDimensions.has(vector.length) || !vector.every(Number.isFinite)) return null;
      return {
        vector,
        model: result.modelId,
        spaceKey: result.embeddingSpaceKey,
        provider: result.providerId,
        runtime: result.runtime
      };
    } catch {
      // The text arms answer alone; the result names the missing arm.
      return null;
    }
  }
}
