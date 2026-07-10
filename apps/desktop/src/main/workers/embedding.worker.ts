export async function runEmbedding(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (!Array.isArray(payload.embedding)) throw new Error("Embedding worker requires a generated embedding vector.");
  return { embedding: payload.embedding };
}
