import type { AiService } from "./ai-service.js";
import type { JobSupervisorOptions } from "./job-supervisor.js";

/**
 * How the job supervisor embeds the chunks of a document (F3 D37): in batches of at most 32 texts,
 * one lane request each, at the ingestion priority, and skipping the chunks whose vector in the
 * route's embedding space is current (`embeddingSpaceKey` says which space that is without a call).
 * The single-text form stays for a supervisor wired without batches.
 */
export function createJobEmbeddingGenerators(
  ai: Pick<AiService, "runDefaultTask" | "embedMany" | "embeddingRouteSpaceKey">
): Required<
  Pick<JobSupervisorOptions, "generateEmbedding" | "generateEmbeddings" | "embeddingSpaceKey">
> {
  return {
    generateEmbedding: async (text, signal, context) => {
      const result = await ai.runDefaultTask(
        "embedding",
        text,
        { ...context, workloadClass: "embed", priority: "P2" },
        signal
      );
      if (!result || !Array.isArray(result.output)) return null;
      return {
        embedding: result.output.map(Number),
        provider: result.providerId,
        model: result.modelId,
        runtime: result.runtime,
        ...(result.embeddingSpaceKey ? { spaceKey: result.embeddingSpaceKey } : {})
      };
    },
    generateEmbeddings: async (texts, signal, context) => {
      const result = await ai.embedMany(
        texts,
        { ...context, workloadClass: "embed", priority: "P2" },
        signal
      );
      if (!result) return null;
      return {
        embeddings: result.embeddings,
        provider: result.providerId,
        model: result.modelId,
        runtime: result.runtime,
        ...(result.embeddingSpaceKey ? { spaceKey: result.embeddingSpaceKey } : {})
      };
    },
    embeddingSpaceKey: () => ai.embeddingRouteSpaceKey()
  };
}
