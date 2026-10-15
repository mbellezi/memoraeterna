import { remoteGenerationContextWindow } from "@app/domain";
import type { JsonObject } from "@app/db";

export const profileGenerationMaxTokens = 16_384;

/**
 * Operations of the `notes.match` decision call and its repair. They return decisions, not prose,
 * so they run with reasoning off by default; other uses of the `reranking` route (source matching)
 * keep the profile's own parameters.
 */
export const noteMatchDecisionOperations = {
  decide: "note_matching_reranking",
  repair: "note_matching_reranking_repair"
} as const;

/**
 * The operation that writes the explanation of a relation when the owner opens it. It is a sentence
 * or two of prose, so it runs on the writer route with reasoning off by default.
 */
export const relationExplanationOperation = "relation_explanation";
/** The same, for a relation between two sources. */
export const sourceRelationExplanationOperation = "source_relation_explanation";
/**
 * The call that names topics in the content language (F2 D11): a title, a sentence and a few
 * aliases per topic, written fast on the `write-fast` class, so reasoning is off by default.
 */
export const topicNameOperation = "topic_name";

/**
 * What a task adds beneath the profile's parameters, beyond sizing (`maxTokens`, `contextWindow`).
 * Any default here changes the effective parameters, so a run fingerprint must include it.
 */
export function aiTaskBehaviorDefaults(
  taskType: string,
  localModel: boolean,
  operation?: string | null
): JsonObject {
  const decision =
    operation === noteMatchDecisionOperations.decide ||
    operation === noteMatchDecisionOperations.repair;
  const explanation =
    taskType === "text-generation" &&
    (operation === relationExplanationOperation ||
      operation === sourceRelationExplanationOperation);
  const naming = taskType === "structured-output" && operation === topicNameOperation;
  return {
    ...(localModel && taskType === "atomic-note-generation" ? { temperature: 0 } : {}),
    // Adapters map "off" to the lowest reasoning level a model supports.
    ...((taskType === "reranking" && decision) || explanation || naming
      ? { reasoningLevel: "off" }
      : {})
  };
}

export function withAiTaskParameterDefaults(
  taskType: string,
  parameters: JsonObject,
  localModel: boolean,
  options: {
    admitted?: boolean;
    contextWindowLimit?: number | null;
    /** The calling operation: some defaults apply to one operation of a task only. */
    operation?: string | null | undefined;
  } = {}
): JsonObject {
  if (taskType === "embedding") {
    return { dimensions: 768, ...parameters };
  }
  const known = options.contextWindowLimit;
  const requested =
    typeof parameters.contextWindow === "number"
      ? parameters.contextWindow
      : options.admitted
        ? null
        : remoteGenerationContextWindow;
  if (!localModel && options.admitted && known && (requested ?? 8192) > known)
    throw new Error("errors.ai.contextWindowLimit");
  const effective =
    !localModel && requested !== null ? Math.min(requested, known ?? 2_000_000) : null;
  return {
    maxTokens: profileGenerationMaxTokens,
    ...aiTaskBehaviorDefaults(taskType, localModel, options.operation),
    ...parameters,
    ...(effective !== null ? { contextWindow: effective } : {})
  };
}

/** Only explicit discovered limits are capacity evidence; model names do not imply a window. */
export function discoveredContextWindow(
  metadata: Record<string, unknown> | null | undefined
): number | null {
  const limits = metadata?.modelLimits;
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) return null;
  const values = ["contextWindow", "inputTokens"]
    .map((key) => (limits as Record<string, unknown>)[key])
    .filter(
      (value): value is number =>
        typeof value === "number" && Number.isInteger(value) && value >= 128 && value <= 2_000_000
    );
  return values.length ? Math.min(...values) : null;
}
export function discoveredModelLimits(limits: Record<string, unknown>): JsonObject {
  return Object.fromEntries(
    ["contextWindow", "inputTokens", "outputTokens"].flatMap((key) => {
      const value = limits[key];
      return typeof value === "number" &&
        Number.isInteger(value) &&
        value >= 1 &&
        value <= 2_000_000
        ? [[key, value]]
        : [];
    })
  );
}

/** Conservative planning/reservation bound, not reported token usage or a provider tokenizer. */
export function estimateAiPlanningTokens(
  input: string,
  adapterInstruction: string,
  outputTokens: number
): number {
  return (
    Buffer.byteLength(input, "utf8") +
    Buffer.byteLength(adapterInstruction, "utf8") +
    outputTokens +
    1024
  );
}
