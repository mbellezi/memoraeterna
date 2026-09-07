import { createHash } from "node:crypto";
import { z } from "zod";
import type { RelationTypeVector } from "@app/db";
import type { AiService, AiTaskLogContext } from "./ai-service.js";

const vectorSchema = z.array(z.number().finite()).refine((values) => [256, 768, 1024].includes(values.length) && values.some((value) => value !== 0));
export function createCanonicalEmbedder(options: {
  ai: Pick<AiService, "runDefaultTask">; context: AiTaskLogContext; strategy: string; signal?: AbortSignal;
}) {
  const cache = new Map<string, RelationTypeVector>();
  let spaceKey: string | undefined;
  return async (text: string, sourceItemIds: string[] = []): Promise<RelationTypeVector> => {
    options.signal?.throwIfAborted();
    const cached = cache.get(text);
    if (cached) return cached;
    const result = await options.ai.runDefaultTask("embedding", text, { ...options.context, sourceItemIds: [...new Set([...(options.context.sourceItemIds ?? []), ...(options.context.sourceItemId ? [options.context.sourceItemId] : []), ...sourceItemIds])], stage: options.strategy, embeddingInputType: "document" }, options.signal);
    if (!result) throw new Error("errors.relationTypes.embeddingRequired");
    const parsed = vectorSchema.safeParse(result.output);
    if (!parsed.success || !result.embeddingSpaceKey) throw new Error("errors.relationTypes.invalidEmbedding");
    const key = `${result.embeddingSpaceKey}:${parsed.data.length}:${options.strategy}`;
    if (spaceKey && key !== spaceKey) throw new Error("errors.relationTypes.modelChanged");
    spaceKey = key;
    const vector: RelationTypeVector = { embedding: parsed.data, spaceKey: key,
      contentHash: createHash("sha256").update(text).digest("hex"), provider: result.providerId, model: result.modelId, runtime: result.runtime,
      metadata: { aiTaskRunId: result.aiTaskRunId, profileId: result.profileId, strategy: options.strategy } };
    cache.set(text, vector);
    return vector;
  };
}
