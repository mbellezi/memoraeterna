/**
 * Atomic notes (`notes.extract`, repaired by `notes.repair`): the product's own flow,
 * `generateAtomicNoteCandidates`, runs with a runner that sends its prompts to the local writer. Its
 * item-by-item reading, partial repair and final answer are the product's.
 */
import { AtomicNoteGenerationOutputSchema } from "@app/domain";

import {
  buildAtomicNoteGenerationPrompt,
  generateAtomicNoteCandidates
} from "../../../apps/desktop/src/main/services/knowledge-processing.js";
import { knowledgeRunner } from "./flow.ts";
import {
  intersectionSize,
  isRecord,
  normalizeName,
  readObject,
  share,
  stringList,
  wordOverlap,
  errorCode
} from "./text.ts";
import type { Digest, FlowOutcome, Prepared, YieldMetrics } from "./types.ts";
import type { RecordedCall } from "../replay-cassette.ts";

const firstPromptStart = "Generate independent atomic knowledge notes from the source below.";
const repairPromptStart =
  "The previous atomic-note output failed JSON parsing or schema validation.";
const uuidBlock =
  /(?:^|\n\n)\[([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\]\n/gu;

export const notesAnswerContract = {
  name: "atomic_notes",
  contract: AtomicNoteGenerationOutputSchema
} as const;

/** The chunks of a notes prompt: `[id]` on its own line, then the text, blocks joined by a blank line. */
export function parseChunkBlocks(text: string): Array<{ id: string; content: string }> | null {
  const heads = [...text.matchAll(uuidBlock)];
  if (heads.length === 0 || heads[0]!.index !== 0) return null;
  return heads.map((head, index) => {
    const start = head.index + head[0].length;
    const end = heads[index + 1]?.index ?? text.length;
    return { id: head[1]!, content: text.slice(start, end) };
  });
}

function digestOfAnswer(output: string): Digest | null {
  const root = readObject(output);
  const notes = root?.notes;
  if (!Array.isArray(notes)) return null;
  const records = notes.filter(isRecord);
  const evidence = records.flatMap((note) =>
    stringList(note.evidenceChunkIds ?? note.evidenceChunkId)
  );
  return {
    count: records.length,
    titles: records.map((note) => normalizeName(String(note.title ?? ""))),
    evidence: [...new Set(evidence)].sort()
  };
}

function compare(local: Digest, recorded: Digest): YieldMetrics {
  const localTitles = local.titles as string[];
  const recordedTitles = recorded.titles as string[];
  const best = recordedTitles.map((title) =>
    Math.max(0, ...localTitles.map((candidate) => wordOverlap(candidate, title)))
  );
  const localCount = local.count as number;
  const recordedCount = recorded.count as number;
  return {
    countRatio: recordedCount === 0 ? (localCount === 0 ? 1 : 0) : localCount / recordedCount,
    titleOverlap: best.length === 0 ? 1 : best.reduce((sum, value) => sum + value, 0) / best.length,
    evidenceCoverage: share(
      intersectionSize(local.evidence as string[], recorded.evidence as string[]),
      (recorded.evidence as string[]).length
    )
  };
}

export function prepareNotes(
  call: RecordedCall,
  split: { language: string; body: string }
): Prepared | null {
  if (call.taskType !== "atomic-note-generation") return null;
  const { body, language } = split;
  if (body.startsWith(repairPromptStart)) return { kind: "recorded_repair", contract: "notes" };
  if (!body.startsWith(firstPromptStart)) return null;
  const titleAt = body.indexOf("\n\nSource title: ");
  const chunksAt = body.indexOf("\nChunks:\n", titleAt);
  if (titleAt < 0 || chunksAt < 0)
    return { kind: "unreconstructable", contract: "notes", reason: "no_source_title_or_chunks" };
  const title = body.slice(titleAt + "\n\nSource title: ".length, chunksAt);
  const chunks = parseChunkBlocks(body.slice(chunksAt + "\nChunks:\n".length));
  if (!chunks) return { kind: "unreconstructable", contract: "notes", reason: "chunks_not_parsed" };
  const source = { title, language };
  const current = buildAtomicNoteGenerationPrompt(source, chunks);
  // The inputs are put back when today's prompt ends with the recording's source and chunks.
  const tail = (text: string) => text.slice(text.indexOf("\nSource title: "));
  if (tail(current) !== tail(body))
    return { kind: "unreconstructable", contract: "notes", reason: "inputs_differ_when_rebuilt" };
  return {
    kind: "item",
    item: {
      contract: "notes",
      fidelity: "product-flow",
      taskType: "atomic-note-generation",
      operation: "atomic_note_generation",
      language,
      body,
      current,
      answerContract: notesAnswerContract,
      digestOf: digestOfAnswer,
      compare,
      async run(caller, prompts): Promise<FlowOutcome> {
        const runner = knowledgeRunner(
          caller,
          {
            contract: "notes",
            taskType: "atomic-note-generation",
            language,
            answerContract: notesAnswerContract
          },
          prompts === "recorded" ? body : undefined
        );
        try {
          const result = await generateAtomicNoteCandidates(source, chunks, runner);
          const notes = result?.output.notes ?? [];
          const digest: Digest = {
            count: notes.length,
            titles: notes.map((note) => normalizeName(note.title)),
            evidence: [...new Set(notes.flatMap((note) => note.evidenceChunkIds))].sort()
          };
          return { ok: result !== null, error: null, digest, salvagedItems: 0 };
        } catch (error) {
          return { ok: false, error: errorCode(error), digest: null, salvagedItems: 0 };
        }
      }
    }
  };
}
