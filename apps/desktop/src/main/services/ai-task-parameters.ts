import type { JsonObject } from "@app/db";

export const profileGenerationMaxTokens = 16_384;

export function withAiTaskParameterDefaults(
  taskType: string,
  parameters: JsonObject,
  localModel: boolean
): JsonObject {
  if (taskType === "embedding") {
    return { dimensions: 768, ...parameters };
  }
  return {
    maxTokens: profileGenerationMaxTokens,
    ...(localModel && taskType === "atomic-note-generation" ? { temperature: 0 } : {}),
    ...parameters
  };
}
