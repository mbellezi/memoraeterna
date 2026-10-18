// Combining summaries within the writer's window (plan decision 28, F3 T53h).
//
// A book's summary is written from its chapters' summaries in one call, and a long chapter's from
// its partial summaries in one call. Both calls grow with the source, so a large book overflowed
// the writer's context window and was rejected (`errors.ai.contextWindowLimit`). When the input
// exceeds a budget derived from the active writer model, the summaries are combined in consecutive
// batches, recursively, until one call fits. A source that fits in one call makes exactly the
// request it always made (the prompt is a function of content only, rules/ai.md); no model changes.
import type { TaskRouteCapacity } from "./ai-task-parameters.js";

/**
 * The typed configuration of the budget. Tokens are counted as the admission counts them
 * (`estimateAiPlanningTokens`: one per UTF-8 byte, plus the output and 1,024), which over-counts
 * real text, so a request within the budget is one the admission accepts.
 */
export const summaryBudgetConfig = {
  /** Window assumed when a route states none: below the native context of the local models in the catalog. */
  fallbackContextWindow: 32_768,
  /** Output tokens reserved when the window is assumed: a summary is a few hundred tokens. */
  fallbackOutputReserve: 4_096,
  /** What the admission adds to every plan (`estimateAiPlanningTokens`). */
  admissionOverheadTokens: 1_024,
  /** The share of the usable window the prompt may fill: the margin for tokenizer drift. */
  safetyFraction: 0.9,
  /** Room for the application's language instruction a call carries beside the prompt. */
  instructionAllowanceBytes: 512,
  /** A budget never drops below this, so a tiny window still combines two summaries per call. */
  minimumBudgetBytes: 1_024
} as const;

/** How the budget of a route was derived (kept in a summary's metadata and in the tests). */
export interface SummaryBudget {
  /** The most bytes one summary call's prompt may have. */
  bytes: number;
  /** The window the budget rests on, in tokens. */
  contextWindow: number;
  /** Where the window comes from; `assumed` when the route states none. */
  windowSource: TaskRouteCapacity["source"] | "assumed";
  /** The output tokens reserved. */
  outputReserve: number;
}

/**
 * The prompt budget of the active writer: the window it states, minus the output the call reserves
 * and the admission's own overhead, times the safety fraction, minus the room for the language
 * instruction. A route that states no window gets the conservative fallback window and a bounded
 * output reserve (nothing enforces its window, and a summary is short).
 */
export function summaryBudget(
  capacity: Pick<TaskRouteCapacity, "contextWindow" | "source" | "maxOutputTokens"> | null
): SummaryBudget {
  const config = summaryBudgetConfig;
  const stated = capacity?.contextWindow ?? null;
  const contextWindow = stated ?? config.fallbackContextWindow;
  const outputReserve =
    stated === null
      ? Math.min(
          capacity?.maxOutputTokens ?? config.fallbackOutputReserve,
          config.fallbackOutputReserve
        )
      : (capacity?.maxOutputTokens ?? config.fallbackOutputReserve);
  const usable = contextWindow - outputReserve - config.admissionOverheadTokens;
  return {
    bytes: Math.max(
      config.minimumBudgetBytes,
      Math.floor(usable * config.safetyFraction) - config.instructionAllowanceBytes
    ),
    contextWindow,
    windowSource: stated === null ? "assumed" : (capacity?.source ?? "assumed"),
    outputReserve
  };
}

const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");

/**
 * Splits consecutive items into consecutive batches whose rendered prompt fits `budgetBytes`. Every
 * batch but the last holds at least two items, so each level has fewer items than the one before it
 * and the recursion ends, whatever the budget; a lone item left over closes the list as a batch of
 * one, which the next level carries unchanged. An item too large for any prompt is not cut: the call that
 * carries it is refused by the admission, visibly.
 */
export function batchWithinBudget<T>(
  items: readonly T[],
  render: (items: readonly T[]) => string,
  budgetBytes: number
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  for (const item of items) {
    if (current.length >= 2 && byteLength(render([...current, item])) > budgetBytes) {
      batches.push(current);
      current = [];
    }
    current.push(item);
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** One call of the combination: the items it summarizes and where it stands in the recursion. */
export interface CombineStep<T> {
  items: readonly T[];
  prompt: string;
  /** 0 for the single call of a source that fits; counts the levels of batches before the last call. */
  level: number;
  /** The position of this call among the calls of its level, and their number. */
  batch: number;
  batches: number;
  /** Calls made before this one. */
  call: number;
}

/** What one call returned: the text of the combined summary (empty: no substantive content). */
export interface CombineOutcome<E> {
  text: string;
  execution: E;
}

export interface CombinedSummary<T, E> {
  /** The item that stands for everything combined; null when no call returned substantive text. */
  item: T | null;
  executions: E[];
  /** More than one call was needed. */
  batched: boolean;
  calls: number;
  levels: number;
}

/**
 * Combines `items` into one with calls of `run`. When all of them fit in one prompt within the
 * budget (or there is one), that single call is the same request it always was. Otherwise they are
 * combined in consecutive batches, each batch by one call; the results, in order, form the next
 * level, and so on until one call fits. `join` makes the item that stands for a batch from the
 * call's text. Resolves null when `run` resolves null (no model answered).
 */
export async function combineWithinBudget<T, E>(input: {
  items: readonly T[];
  render: (items: readonly T[]) => string;
  budgetBytes: number;
  run: (step: CombineStep<T>) => Promise<CombineOutcome<E> | null>;
  join: (batch: readonly T[], text: string) => T;
  signal?: AbortSignal | undefined;
}): Promise<CombinedSummary<T, E> | null> {
  const executions: E[] = [];
  let level = [...input.items];
  let levels = 0;
  let calls = 0;
  for (;;) {
    input.signal?.throwIfAborted();
    const prompt = input.render(level);
    const fits = level.length <= 1 || byteLength(prompt) <= input.budgetBytes;
    // A level that holds one item after combining is the answer: its call was the last.
    if (levels > 0 && level.length === 1)
      return { item: level[0]!, executions, batched: true, calls, levels };
    if (fits) {
      const outcome = await input.run({
        items: level,
        prompt,
        level: levels,
        batch: 0,
        batches: 1,
        call: calls
      });
      if (!outcome) return null;
      calls += 1;
      executions.push(outcome.execution);
      return {
        item: outcome.text.length > 0 ? input.join(level, outcome.text) : null,
        executions,
        batched: levels > 0,
        calls,
        levels
      };
    }
    const batches = batchWithinBudget(level, input.render, input.budgetBytes);
    const next: T[] = [];
    for (const [index, batch] of batches.entries()) {
      input.signal?.throwIfAborted();
      if (batch.length === 1) {
        next.push(batch[0]!);
        continue;
      }
      const outcome = await input.run({
        items: batch,
        prompt: input.render(batch),
        level: levels,
        batch: index,
        batches: batches.length,
        call: calls
      });
      if (!outcome) return null;
      calls += 1;
      executions.push(outcome.execution);
      if (outcome.text.length > 0) next.push(input.join(batch, outcome.text));
    }
    if (next.length === 0)
      return { item: null, executions, batched: true, calls, levels: levels + 1 };
    level = next;
    levels += 1;
  }
}
