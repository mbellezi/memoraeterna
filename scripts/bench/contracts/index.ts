/**
 * The contract registry of the prompt-replay harness (F4 T69): classifies a recorded call and, for a
 * writer call, rebuilds it so the product's flow can run on a local model.
 */
import { splitLanguagePrefix, type RecordedCall } from "../replay-cassette.ts";
import { prepareConfirmation } from "./confirmation.ts";
import { prepareGraph } from "./graph.ts";
import { prepareNotes } from "./notes.ts";
import { prepareOverview } from "./overview.ts";
import { prepareSummary } from "./summary.ts";
import { prepareTopicNames } from "./topic-names.ts";
import { prepareTyping } from "./typing.ts";
import type { ContractId, Prepared } from "./types.ts";

export * from "./types.ts";

export type Classified =
  | Prepared
  /** The call is not a generative writer call (an embedding, a ranker, a legacy decider). */
  | { kind: "not_a_writer_call"; reason: string }
  | { kind: "unreconstructable"; contract: ContractId | null; reason: string };

type Preparer = (call: RecordedCall, split: { language: string; body: string }) => Prepared | null;

const preparers: readonly Preparer[] = [
  prepareNotes,
  prepareGraph,
  prepareConfirmation,
  prepareSummary,
  prepareOverview,
  prepareTopicNames,
  prepareTyping
];

/** The task types a writer's contract can have; the others are never read in full. */
export const writerTaskTypes: ReadonlySet<string> = new Set([
  "summarization",
  "atomic-note-generation",
  "knowledge-graph-generation",
  "structured-output"
]);

/** Classifies one recorded call. */
export function classifyRecordedCall(call: RecordedCall): Classified {
  if (!writerTaskTypes.has(call.taskType))
    return { kind: "not_a_writer_call", reason: `task_type:${call.taskType}` };
  const split = splitLanguagePrefix(call.input);
  if (!split) return { kind: "unreconstructable", contract: null, reason: "no_language_prefix" };
  for (const prepare of preparers) {
    const prepared = prepare(call, split);
    if (prepared) return prepared;
  }
  return { kind: "not_a_writer_call", reason: "unknown_prompt" };
}
