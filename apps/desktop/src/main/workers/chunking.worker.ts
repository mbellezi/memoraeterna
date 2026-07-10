import { chunkMarkdown, conversionBlockSchema } from "@app/conversion";

export async function runChunking(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  if (typeof payload.markdown !== "string") throw new Error("Worker chunking payload is missing Markdown.");
  const blocks = Array.isArray(payload.blocks) ? payload.blocks.map((block) => conversionBlockSchema.parse(block)) : [];
  return { chunks: chunkMarkdown(payload.markdown, blocks) };
}
