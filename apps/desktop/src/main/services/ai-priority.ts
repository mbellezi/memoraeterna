import { isAiPriority, type AiPriority } from "@app/ai";

/**
 * What a caller may state as its priority: a lane priority (F3 D30), or one of the two classes of
 * the single queue the lanes replaced, read as P0 (`interactive`) and P2 (`background`). Product
 * callers state a lane priority and `workload-class-callers.test.ts` requires it; the two old
 * words stay readable for code and tests that predate the lanes.
 */
export type AiPriorityInput = AiPriority | "interactive" | "background";

export interface AiPriorityContext {
  priority?: AiPriorityInput | undefined;
  origin?: string | undefined;
  embeddingInputType?: "query" | "document" | undefined;
}

/**
 * The lane priority of a call. A stated priority wins. Otherwise the user is waiting for query
 * embeddings, Ask answers (origin `consultation`) and actions started from the settings, which are
 * P0; everything else is background work at P2.
 */
export function aiTaskPriority(context: AiPriorityContext): AiPriority {
  const stated = context.priority;
  if (stated === "interactive") return "P0";
  if (stated === "background") return "P2";
  if (isAiPriority(stated)) return stated;
  return context.embeddingInputType === "query" ||
    context.origin === "consultation" ||
    context.origin === "settings"
    ? "P0"
    : "P2";
}
