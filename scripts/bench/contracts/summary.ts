/**
 * Summaries (`summary.short`, `summary.partial`, `summary.reduce`, `summary.aggregate`): one call whose
 * answer the product reads with `normalizeSummaryText` and `summaryConcepts`. The product has no repair
 * for a summary: an empty answer ends the call, so the flow here is that one call.
 */
import {
  normalizeSummaryText,
  summaryConcepts,
  summaryPrompt,
  summaryReductionPrompt
} from "../../../apps/desktop/src/main/services/knowledge-processing.js";
import { errorCode, share } from "./text.ts";
import type { Digest, FlowOutcome, Prepared, ReplayCaller, YieldMetrics } from "./types.ts";
import type { RecordedCall } from "../replay-cassette.ts";

type Kind = "short" | "partial" | "reduce" | "aggregate";

const starts: ReadonlyArray<readonly [string, Kind]> = [
  ["Summarize this source faithfully and concisely.", "short"],
  ["Summarize this part of a longer source faithfully and concisely.", "partial"],
  [
    "Create one faithful, concise source summary from these substantive partial summaries.",
    "reduce"
  ],
  ["Create a coherent aggregate summary of the ", "aggregate"]
];

const operationOf: Record<Kind, string> = {
  short: "summary",
  partial: "summary_map",
  reduce: "summary_reduce",
  aggregate: "summary_aggregate"
};

/** The `[c1]` blocks of a summary prompt, in order; null when the numbering does not run 1..n. */
function parseChunks(text: string): Array<{ id: string; content: string }> | null {
  const heads: Array<{ at: number; length: number }> = [];
  let from = 0;
  for (let number = 1; ; number += 1) {
    const marker = `[c${number}]\n`;
    const at =
      number === 1 ? (text.startsWith(marker) ? 0 : -1) : text.indexOf(`\n\n${marker}`, from);
    if (at < 0) break;
    const length = number === 1 ? marker.length : marker.length + 2;
    heads.push({ at, length });
    from = at + length;
  }
  if (heads.length === 0) return null;
  return heads.map((head, index) => ({
    id: `c${index + 1}`,
    content: text.slice(head.at + head.length, heads[index + 1]?.at ?? text.length)
  }));
}

function wordCount(text: string): number {
  return (text.match(/[\p{L}\p{N}]+/gu) ?? []).length;
}

function digestOfAnswer(output: string, chunkCount: number): Digest | null {
  let summary: string;
  try {
    summary = normalizeSummaryText(output);
  } catch {
    return null;
  }
  const chunks = Array.from({ length: chunkCount }, (_, index) => ({ id: `c${index + 1}` }));
  return { words: wordCount(summary), concepts: summaryConcepts(output, chunks).length };
}

function compare(local: Digest, recorded: Digest): YieldMetrics {
  return {
    lengthRatio: (local.words as number) / Math.max(1, recorded.words as number),
    conceptRatio: share(local.concepts as number, recorded.concepts as number)
  };
}

export function prepareSummary(
  call: RecordedCall,
  split: { language: string; body: string }
): Prepared | null {
  if (call.taskType !== "summarization") return null;
  const { body, language } = split;
  const kind = starts.find(([start]) => body.startsWith(start))?.[1];
  if (!kind) return null;
  let current = body;
  let chunkCount = 0;
  if (kind === "short" || kind === "partial") {
    const at = body.indexOf("\n\n[c1]\n");
    const chunks = at < 0 ? null : parseChunks(body.slice(at + 2));
    if (!chunks)
      return { kind: "unreconstructable", contract: "summary", reason: "chunks_not_parsed" };
    chunkCount = chunks.length;
    current = summaryPrompt(chunks, kind === "partial");
    if (current.slice(current.indexOf("[c1]\n")) !== body.slice(at + 2))
      return {
        kind: "unreconstructable",
        contract: "summary",
        reason: "inputs_differ_when_rebuilt"
      };
  } else if (kind === "reduce") {
    const head = "substantive partial summaries.";
    const at = body.indexOf("\n\n", body.indexOf(head));
    const partials = at < 0 ? null : body.slice(at + 2).split("\n\n---\n\n");
    if (!partials)
      return { kind: "unreconstructable", contract: "summary", reason: "partials_not_parsed" };
    current = summaryReductionPrompt(partials);
  }
  return {
    kind: "item",
    item: {
      contract: "summary",
      fidelity: "product-pure",
      taskType: "summarization",
      operation: operationOf[kind],
      language,
      body,
      current,
      answerContract: null,
      digestOf: (output) => digestOfAnswer(output, chunkCount),
      compare,
      async run(caller: ReplayCaller, prompts): Promise<FlowOutcome> {
        try {
          const result = await caller({
            contract: "summary",
            taskType: "summarization",
            prompt: prompts === "recorded" ? body : current,
            language,
            operation: operationOf[kind],
            attempt: 0,
            isRepair: false
          });
          const digest = digestOfAnswer(result.output, chunkCount);
          return digest
            ? { ok: true, error: null, digest, salvagedItems: 0 }
            : { ok: false, error: "ai_task_empty_output", digest: null, salvagedItems: 0 };
        } catch (error) {
          return { ok: false, error: errorCode(error), digest: null, salvagedItems: 0 };
        }
      }
    }
  };
}
