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

/** The embedding of a note matching finds without a vector for its current text (`class:embed`). */
export const noteMatchingEmbeddingOperation = "note_matching_embedding";

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
 * The call that writes a topic's overview when its page opens (F2 T31): a few cited paragraphs the
 * owner waits for, on the `write-fast` class, so reasoning is off by default too.
 */
export const topicOverviewOperation = "topic_overview";

/**
 * The calls that type the pairs a source's notes were accepted in (F3 D20), and their one re-ask:
 * codes only (a type and a direction per pair) on the `write-fast` class, so reasoning is off by
 * default. `op:` routes may override either.
 */
export const relationTypingOperation = "relation_typing";
export const relationTypingRepairOperation = "relation_typing_repair";

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
  const naming =
    taskType === "structured-output" &&
    (operation === topicNameOperation ||
      operation === topicOverviewOperation ||
      operation === relationTypingOperation ||
      operation === relationTypingRepairOperation);
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

/** The model a route serves, as far as its capacity is concerned (a slice of the route selection). */
export interface RouteCapacitySelection {
  localModelId: string | null;
  parameters: JsonObject;
  modelDefaultParameters: JsonObject;
  providerMetadata: JsonObject | null | undefined;
}

/** What a task route's model can take in one call (plan decision 28), known without a call. */
export interface TaskRouteCapacity {
  /**
   * The context window, in tokens, that the route's calls are planned and admitted against: the
   * profile's own value, else the provider's discovered limit (Codex and OpenAI-compatible
   * `context_window`), bounded by the planning budget of a remote call. Null when nothing states one.
   */
  contextWindow: number | null;
  /** Where `contextWindow` comes from; `unknown` for a local model whose catalog states none. */
  source: "profile" | "provider" | "planning" | "unknown";
  /** The output tokens a call of the route reserves: its effective `maxTokens`. */
  maxOutputTokens: number;
  /** The model runs on this machine. */
  local: boolean;
}

/**
 * The capacity of a route's model, derived exactly as an admitted call derives its parameters
 * (`withAiTaskParameterDefaults`), so a request sized to it is one the admission accepts. A local
 * model whose profile and catalog state no window reports `unknown`: its native limit is not
 * metadata the app holds.
 */
export function routeCapacity(
  taskType: string,
  selection: RouteCapacitySelection,
  operation?: string | null
): TaskRouteCapacity {
  const local = Boolean(selection.localModelId);
  const stated = { ...selection.modelDefaultParameters, ...selection.parameters };
  const discovered = discoveredContextWindow(selection.providerMetadata);
  const effective = withAiTaskParameterDefaults(taskType, stated, local, {
    contextWindowLimit: discovered,
    operation
  });
  const window =
    typeof effective.contextWindow === "number" && effective.contextWindow > 0
      ? effective.contextWindow
      : null;
  const maxOutputTokens =
    typeof effective.maxTokens === "number" && effective.maxTokens > 0
      ? effective.maxTokens
      : profileGenerationMaxTokens;
  if (window === null) return { contextWindow: null, source: "unknown", maxOutputTokens, local };
  if (typeof stated.contextWindow !== "number")
    return {
      contextWindow: window,
      source: discovered !== null && window === discovered ? "provider" : "planning",
      maxOutputTokens,
      local
    };
  return {
    contextWindow: window,
    source: discovered !== null && window === discovered ? "provider" : "profile",
    maxOutputTokens,
    local
  };
}
