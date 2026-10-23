/**
 * Adapters between the harness's `ReplayCaller` and the shapes the product's flows take: the
 * knowledge runner of `knowledge-processing.ts` and the `runDefaultTask` of `AiService`.
 *
 * A flow builds its first prompt from today's builders. When a replay sends the recording's prompt
 * instead, `firstPrompt` replaces that one prompt on its way to the writer; every repair prompt is the
 * product's own.
 */
import type {
  AiService,
  AiTaskLogContext
} from "../../../apps/desktop/src/main/services/ai-service.js";
import type { KnowledgeAiRunner } from "../../../apps/desktop/src/main/services/knowledge-processing.js";
import type { ReplayCall, ReplayCaller, ReplayTaskType } from "./types.ts";

export type FixedCall = Pick<ReplayCall, "contract" | "taskType" | "language"> &
  Partial<Pick<ReplayCall, "answerContract" | "maxOutputTokens">>;

/** Replaces the first prompt (attempt zero) of a flow; later asks pass through. */
function firstPromptSwap(firstPrompt: string | undefined) {
  let pending = firstPrompt !== undefined;
  return (prompt: string, attempt: number): string => {
    if (pending && attempt === 0) {
      pending = false;
      return firstPrompt!;
    }
    return prompt;
  };
}

/** The `run` the knowledge flows (notes, graph) take, sending each prompt to the writer. */
export function knowledgeRunner(
  caller: ReplayCaller,
  fixed: FixedCall,
  firstPrompt?: string
): KnowledgeAiRunner {
  const swap = firstPromptSwap(firstPrompt);
  return async (prompt, context) => {
    const result = await caller({
      ...fixed,
      prompt: swap(prompt, context.attempt),
      operation: context.operation,
      attempt: context.attempt,
      isRepair: context.operation.endsWith("_repair")
    });
    return {
      output: result.output,
      providerId: "local-replay",
      modelId: "local-replay",
      runtime: "local",
      profileId: "replay",
      aiTaskRunId: "replay",
      outputLanguage: fixed.language
    };
  };
}

/** The `ai` the confirmation flow takes: `runDefaultTask` of the service, answered by the writer. */
export function defaultTaskService(
  caller: ReplayCaller,
  fixed: FixedCall,
  firstPrompt?: string
): Pick<AiService, "runDefaultTask"> {
  const swap = firstPromptSwap(firstPrompt);
  const runDefaultTask = async (
    taskType: ReplayTaskType | string,
    prompt: string,
    context: AiTaskLogContext = {},
    _signal?: AbortSignal,
    limits?: { maxOutputTokens: number }
  ) => {
    const attempt = context.attempt ?? 0;
    const result = await caller({
      ...fixed,
      taskType: taskType as ReplayTaskType,
      prompt: swap(prompt, attempt),
      language: context.contentLanguage ?? fixed.language,
      operation: context.operation ?? "replay",
      attempt,
      isRepair: context.isRepair ?? false,
      ...(limits ? { maxOutputTokens: limits.maxOutputTokens } : {})
    });
    return {
      taskType,
      output: result.output,
      providerId: "local-replay",
      modelId: "local-replay",
      runtime: "local",
      durationMs: result.durationMs,
      profileId: "replay",
      aiTaskRunId: "replay",
      outputLanguage: fixed.language
    };
  };
  return { runDefaultTask } as unknown as Pick<AiService, "runDefaultTask">;
}
