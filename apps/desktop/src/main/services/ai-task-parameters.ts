import type { JsonObject } from "@app/db";

export const atomicNoteGenerationMaxTokens = 16_384;

export function withAiTaskParameterDefaults(
  taskType: string,
  parameters: JsonObject,
  localModel: boolean
): JsonObject {
  if (taskType === "embedding") {
    return { dimensions: 768, ...parameters };
  }
  if (localModel && taskType === "atomic-note-generation") {
    return {
      maxTokens: atomicNoteGenerationMaxTokens,
      temperature: 0,
      ...parameters
    };
  }
  return { ...parameters };
}
