import { z } from "zod";
import {
  AtomicNoteGenerationOutputSchema,
  AtomicNoteRelationTypeSchema,
  type AtomicNoteGenerationOutput,
  type AtomicNoteRelationType
} from "@app/domain";

export const summaryPromptVersion = "summary-v1";
export const atomicNotePromptVersion = "atomic-note-v2";
export const atomicNoteMatchingVersion = "atomic-note-matching-v1";

const atomicNoteGenerationJsonSchema = JSON.stringify(
  z.toJSONSchema(AtomicNoteGenerationOutputSchema),
  null,
  2
);

export interface KnowledgeAiExecution {
  output: unknown;
  providerId: string;
  modelId: string;
  runtime: string;
  profileId: string;
  aiTaskRunId: string;
  outputLanguage?: string;
}

export type KnowledgeAiRunner = (input: string) => Promise<KnowledgeAiExecution | null>;

export interface SummaryResult {
  summary: string;
  mapReduce: boolean;
  executions: KnowledgeAiExecution[];
}

export async function generateSummaryFromChunks(
  chunks: ReadonlyArray<{ id: string; content: string }>,
  run: KnowledgeAiRunner,
  maxInputCharacters = 12_000
): Promise<SummaryResult | null> {
  const nonEmptyChunks = chunks.filter((chunk) => chunk.content.trim().length > 0);
  if (nonEmptyChunks.length === 0) return null;
  const groups = groupChunks(nonEmptyChunks, maxInputCharacters);
  const executions: KnowledgeAiExecution[] = [];
  if (groups.length === 1) {
    const execution = await run(summaryPrompt(groups[0] ?? [], false));
    if (!execution) return null;
    executions.push(execution);
    return { summary: readGeneratedText(execution.output), mapReduce: false, executions };
  }

  const partials: string[] = [];
  for (const group of groups) {
    const execution = await run(summaryPrompt(group, true));
    if (!execution) return null;
    executions.push(execution);
    partials.push(readGeneratedText(execution.output));
  }
  const reduction = await run(
    `Create one faithful, concise source summary from these partial summaries. Preserve important claims and uncertainty.\n\n${partials.join("\n\n---\n\n")}`
  );
  if (!reduction) return null;
  executions.push(reduction);
  return { summary: readGeneratedText(reduction.output), mapReduce: true, executions };
}

export function buildAtomicNoteGenerationPrompt(
  source: { title: string; language: string },
  chunks: ReadonlyArray<{ id: string; content: string }>
): string {
  return `Generate independent atomic knowledge notes from the source below.
Return exactly one complete JSON object. Do not use Markdown fences or add commentary.
The JSON must conform exactly to this JSON Schema:
${atomicNoteGenerationJsonSchema}

Every note must express one self-contained idea and cite at least one supplied chunk id. Do not invent ids.
Use the exact property name "bodyMarkdown" and close the root JSON object.
Set each "language" field to the language used in that note.

Source title: ${source.title}
Chunks:
${chunks.map((chunk) => `[${chunk.id}]\n${chunk.content}`).join("\n\n")}`;
}

export function buildAtomicNoteRepairPrompt(
  previousOutput: unknown,
  allowedChunkIds: ReadonlyArray<string>
): string {
  return `The previous atomic-note output failed JSON parsing or schema validation.
Return exactly one corrected, complete JSON object. Do not use Markdown fences or add commentary.
The JSON must conform exactly to this JSON Schema:
${atomicNoteGenerationJsonSchema}

Use the exact property name "bodyMarkdown" and close the root JSON object.
Set each "language" field to the language used in that note.
Evidence chunk ids must come only from this list: ${JSON.stringify(allowedChunkIds)}

Previous invalid output:
${serializeOutputForRepair(previousOutput)}`;
}

export function parseAtomicNoteGenerationOutput(
  output: unknown,
  allowedChunkIds?: ReadonlySet<string>
): AtomicNoteGenerationOutput {
  const value = AtomicNoteGenerationOutputSchema.parse(parseJsonOutput(output));
  if (allowedChunkIds) {
    for (const note of value.notes) {
      for (const chunkId of note.evidenceChunkIds) {
        if (!allowedChunkIds.has(chunkId)) {
          throw new Error("atomic_note_unknown_evidence_chunk");
        }
      }
    }
  }
  return value;
}

export async function generateAtomicNoteCandidates(
  source: { title: string; language: string },
  chunks: ReadonlyArray<{ id: string; content: string }>,
  run: KnowledgeAiRunner
): Promise<{ output: AtomicNoteGenerationOutput; execution: KnowledgeAiExecution } | null> {
  const allowedChunkIds = new Set(chunks.map((chunk) => chunk.id));
  const execution = await run(buildAtomicNoteGenerationPrompt(source, chunks));
  if (!execution) return null;
  try {
    return {
      output: parseAtomicNoteGenerationOutput(execution.output, allowedChunkIds),
      execution
    };
  } catch (initialError) {
    const repairedExecution = await run(buildAtomicNoteRepairPrompt(
      execution.output,
      [...allowedChunkIds]
    ));
    if (!repairedExecution) throw initialError;
    return {
      output: parseAtomicNoteGenerationOutput(repairedExecution.output, allowedChunkIds),
      execution: repairedExecution
    };
  }
}

export function scoreMetadataOverlap(left: Record<string, unknown>, right: Record<string, unknown>): number {
  const leftSignals = collectMetadataSignals(left);
  const rightSignals = collectMetadataSignals(right);
  if (leftSignals.size === 0 || rightSignals.size === 0) return 0;
  let shared = 0;
  for (const signal of leftSignals) if (rightSignals.has(signal)) shared += 1;
  return shared / new Set([...leftSignals, ...rightSignals]).size;
}

export function meetsRelationThreshold(score: number, threshold: number): boolean {
  return Number.isFinite(score) && Number.isFinite(threshold) && score >= threshold;
}

export function calculateRelationScore(input: {
  vectorScore: number;
  textScore: number;
  metadataScore: number;
  hasEmbedding: boolean;
  rerankScore?: number | null;
}): number {
  const baseScore = input.hasEmbedding
    ? (input.vectorScore * 0.55) + (input.textScore * 0.3) + (input.metadataScore * 0.15)
    : (input.textScore * 0.7) + (input.metadataScore * 0.3);
  return Math.max(0, Math.min(1, input.rerankScore === null || input.rerankScore === undefined
    ? baseScore
    : (baseScore * 0.6) + (input.rerankScore * 0.4)));
}

const rerankOutputSchema = z.object({
  score: z.number().min(0).max(1),
  relationType: AtomicNoteRelationTypeSchema.default("related"),
  explanation: z.string().trim().min(1).max(500)
}).strict();

export interface RerankOutput {
  score: number;
  relationType: AtomicNoteRelationType;
  explanation: string;
}

export function parseRerankOutput(output: unknown): RerankOutput {
  return rerankOutputSchema.parse(parseJsonOutput(output));
}

export function buildRerankPrompt(
  source: { title: string; ideaStatement: string },
  target: { title: string; ideaStatement: string }
): string {
  return `Evaluate whether these two atomic notes have a meaningful knowledge relationship.
Return only JSON: {"score":0.0,"relationType":"related","explanation":"one short explanation"}.
Allowed relationType values: supports, contrasts, extends, similar_to, depends_on, clarifies, mentions, related.

Note A: ${source.title}\n${source.ideaStatement}

Note B: ${target.title}\n${target.ideaStatement}`;
}

function summaryPrompt(chunks: ReadonlyArray<{ id: string; content: string }>, partial: boolean): string {
  return `${partial ? "Summarize this part of a longer source" : "Summarize this source"} faithfully and concisely. Preserve important claims, evidence, and uncertainty. Do not add facts.\n\n${chunks.map((chunk) => `[${chunk.id}]\n${chunk.content}`).join("\n\n")}`;
}

function groupChunks(
  chunks: ReadonlyArray<{ id: string; content: string }>,
  maxCharacters: number
): Array<Array<{ id: string; content: string }>> {
  const groups: Array<Array<{ id: string; content: string }>> = [];
  let current: Array<{ id: string; content: string }> = [];
  let currentLength = 0;
  for (const chunk of chunks) {
    const length = chunk.content.length;
    if (current.length > 0 && currentLength + length > maxCharacters) {
      groups.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(chunk);
    currentLength += length;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function readGeneratedText(output: unknown): string {
  if (typeof output !== "string" || output.trim().length === 0) {
    throw new Error("ai_task_empty_output");
  }
  return output.trim();
}

function parseJsonOutput(output: unknown): unknown {
  if (typeof output !== "string") return output;
  const trimmed = output.trim();
  const withoutFence = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : trimmed;
  return JSON.parse(withoutFence);
}

function serializeOutputForRepair(output: unknown): string {
  if (typeof output === "string") return output;
  try {
    return JSON.stringify(output) ?? String(output);
  } catch {
    return String(output);
  }
}

function collectMetadataSignals(metadata: Record<string, unknown>): Set<string> {
  const values = [metadata.entities, metadata.tags, metadata.concepts]
    .flatMap((value) => Array.isArray(value) ? value : [])
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLocaleLowerCase())
    .filter(Boolean);
  return new Set(values);
}
