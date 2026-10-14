import type { AiCapability, AiTaskType } from "./ai.js";

/** What a model has to declare to serve a task. Tasks without an entry have no requirement. */
export function capabilitiesForTask(taskType: AiTaskType): AiCapability[] {
  return (
    (
      {
        "text-generation": ["text-generation"],
        embedding: ["embedding"],
        summarization: ["summarization"],
        "knowledge-graph-generation": ["structured-output"],
        "atomic-note-generation": ["atomic-note-generation", "structured-output"],
        "structured-output": ["structured-output"],
        reranking: ["reranking"]
      } as Partial<Record<AiTaskType, AiCapability[]>>
    )[taskType] ?? []
  );
}

/** Generative capabilities that qualify a model as an explicit, decision-only decider. */
export const generativeDeciderCapabilities: readonly AiCapability[] = [
  "structured-output",
  "text-generation"
];

/**
 * Whether a model with these capabilities can serve a task. The decision route (`reranking`) also
 * accepts a generative model as a decision-only decider, which is how matching decides today. That
 * is a routing rule: no `reranking` capability is ever written for the model. Routing in the main
 * process and every renderer decision about routing use this one rule.
 */
export function supportsTask(taskType: AiTaskType, capabilities: readonly string[]): boolean {
  return (
    capabilitiesForTask(taskType).every((capability) => capabilities.includes(capability)) ||
    (taskType === "reranking" &&
      generativeDeciderCapabilities.some((capability) => capabilities.includes(capability)))
  );
}
