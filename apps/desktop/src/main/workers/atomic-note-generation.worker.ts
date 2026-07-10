import { parseAtomicNoteGenerationOutput } from "../services/knowledge-processing.js";

export async function runAtomicNoteGeneration(payload: Record<string, unknown>): Promise<Record<string, unknown>> {
  const allowedChunkIds = Array.isArray(payload.allowedChunkIds)
    ? new Set(payload.allowedChunkIds.filter((value): value is string => typeof value === "string"))
    : undefined;
  return parseAtomicNoteGenerationOutput(payload.output, allowedChunkIds);
}
