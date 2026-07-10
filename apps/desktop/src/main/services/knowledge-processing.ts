import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AtomicNoteGenerationOutputSchema,
  AtomicNoteRelationTypeSchema,
  KnowledgeGraphGenerationOutputSchema,
  type AtomicNoteGenerationOutput,
  type AtomicNoteRelationType,
  type KnowledgeGraphGenerationOutput
} from "@app/domain";

export const summaryPromptVersion = "summary-v1";
export const atomicNotePromptVersion = "atomic-note-v2";
export const atomicNoteMatchingVersion = "atomic-note-matching-v1";
export const knowledgeGraphPromptVersion = "knowledge-graph-v2";

const atomicNoteGenerationJsonSchema = JSON.stringify(
  z.toJSONSchema(AtomicNoteGenerationOutputSchema),
  null,
  2
);

const knowledgeGraphJsonContract = `{
  "entities": [{"key":"e1","type":"Concept","canonicalName":"Name","aliases":[],"description":"Optional description","confidence":0.9,"evidenceChunkIds":["c1"]}],
  "claims": [{"text":"Verifiable statement","confidence":0.9,"evidenceChunkIds":["c1"],"relatedEntityKeys":["e1"]}],
  "relations": [{"subjectEntityKey":"e1","predicate":"relates_to","objectEntityKey":"e2","confidence":0.9,"evidenceChunkIds":["c1"]}]
}`;

const knowledgeGraphExecutionTraceSchema = z.object({
  providerId: z.string(),
  modelId: z.string(),
  runtime: z.string(),
  profileId: z.string(),
  aiTaskRunId: z.string(),
  outputLanguage: z.string().optional()
}).strict();

const knowledgeGraphBatchCheckpointSchema = z.object({
  batchKey: z.string(),
  batch: KnowledgeGraphGenerationOutputSchema,
  execution: knowledgeGraphExecutionTraceSchema
}).strict();

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

export interface KnowledgeGraphAtomicNoteInput {
  id: string;
  title: string;
  ideaStatement: string;
  bodyMarkdown: string;
  evidenceChunkIds: string[];
}

export interface KnowledgeGraphExecutionTrace {
  providerId: string;
  modelId: string;
  runtime: string;
  profileId: string;
  aiTaskRunId: string;
  outputLanguage?: string | undefined;
}

export interface KnowledgeGraphBatchCheckpoint {
  batchKey: string;
  batch: KnowledgeGraphGenerationOutput;
  execution: KnowledgeGraphExecutionTrace;
}

export interface KnowledgeGraphGenerationOptions {
  completedBatches?: ReadonlyArray<KnowledgeGraphBatchCheckpoint>;
  onBatchCompleted?: (input: {
    completed: number;
    total: number;
    checkpoints: KnowledgeGraphBatchCheckpoint[];
  }) => Promise<void>;
}

export interface SummaryResult {
  summary: string;
  mapReduce: boolean;
  executions: KnowledgeAiExecution[];
}

export function normalizeSummaryText(output: unknown): string {
  if (typeof output === "object" && output !== null && "summary" in output) {
    const summary = (output as { summary?: unknown }).summary;
    if (typeof summary === "string" && summary.trim().length > 0) return summary.trim();
  }
  if (typeof output !== "string" || output.trim().length === 0) {
    throw new Error("ai_task_empty_output");
  }
  const trimmed = output.trim();
  try {
    const parsed = parseJsonOutput(trimmed);
    if (typeof parsed === "object" && parsed !== null && "summary" in parsed) {
      const summary = (parsed as { summary?: unknown }).summary;
      if (typeof summary === "string" && summary.trim().length > 0) return summary.trim();
    }
  } catch {
    // Plain-text summaries are the normal response format.
  }
  return trimmed;
}

export async function generateSummaryFromChunks(
  chunks: ReadonlyArray<{ id: string; content: string }>,
  run: KnowledgeAiRunner,
  maxInputCharacters = 3_500
): Promise<SummaryResult | null> {
  const nonEmptyChunks = chunks.filter((chunk) => chunk.content.trim().length > 0);
  if (nonEmptyChunks.length === 0) return null;
  const groups = groupChunks(nonEmptyChunks, maxInputCharacters);
  const executions: KnowledgeAiExecution[] = [];
  if (groups.length === 1) {
    const execution = await run(summaryPrompt(groups[0] ?? [], false));
    if (!execution) return null;
    executions.push(execution);
    return { summary: normalizeSummaryText(execution.output), mapReduce: false, executions };
  }

  const partials: string[] = [];
  for (const group of groups) {
    const execution = await run(summaryPrompt(group, true));
    if (!execution) return null;
    executions.push(execution);
    partials.push(normalizeSummaryText(execution.output));
  }
  const reduction = await run(
    `Create one faithful, concise source summary from these partial summaries. Preserve important claims and uncertainty.\n\n${partials.join("\n\n---\n\n")}`
  );
  if (!reduction) return null;
  executions.push(reduction);
  return { summary: normalizeSummaryText(reduction.output), mapReduce: true, executions };
}

export async function generateKnowledgeGraphFromAtomicNotes(
  source: { title: string; language: string },
  notes: ReadonlyArray<KnowledgeGraphAtomicNoteInput>,
  run: KnowledgeAiRunner,
  maxInputCharacters = 12_000,
  options: KnowledgeGraphGenerationOptions = {}
): Promise<{
  batches: KnowledgeGraphGenerationOutput[];
  executions: KnowledgeGraphExecutionTrace[];
  checkpoints: KnowledgeGraphBatchCheckpoint[];
} | null> {
  const groups = groupAtomicNotes(notes.filter((note) => graphNoteContent(note).trim().length > 0), maxInputCharacters);
  if (groups.length === 0) return null;
  const checkpoints = reusableGraphCheckpoints(groups, options.completedBatches ?? []);
  for (let batchIndex = checkpoints.length; batchIndex < groups.length; batchIndex += 1) {
    const group = groups[batchIndex] ?? [];
    const evidenceAliases = createEvidenceAliases(group);
    const execution = await run(buildKnowledgeGraphPrompt(source, group, evidenceAliases));
    if (!execution) return null;
    let parsed: KnowledgeGraphGenerationOutput;
    let finalExecution = execution;
    try {
      parsed = parseKnowledgeGraphOutput(execution.output, evidenceAliases);
    } catch (initialError) {
      const repaired = await run(buildKnowledgeGraphRepairPrompt(source, group, evidenceAliases));
      if (!repaired) throw initialError;
      try {
        parsed = parseKnowledgeGraphOutput(repaired.output, evidenceAliases);
      } catch (repairError) {
        throw new Error(`knowledge_graph_output_invalid:${knowledgeGraphValidationCode(repairError)}`);
      }
      finalExecution = repaired;
    }
    checkpoints.push({
      batchKey: knowledgeGraphBatchKey(group),
      batch: parsed,
      execution: executionTrace(finalExecution)
    });
    await options.onBatchCompleted?.({
      completed: checkpoints.length,
      total: groups.length,
      checkpoints: [...checkpoints]
    });
  }
  return {
    batches: checkpoints.map((checkpoint) => checkpoint.batch),
    executions: checkpoints.map((checkpoint) => checkpoint.execution),
    checkpoints
  };
}

export function buildKnowledgeGraphPrompt(
  source: { title: string; language: string },
  notes: ReadonlyArray<KnowledgeGraphAtomicNoteInput>,
  evidenceAliases = createEvidenceAliases(notes)
): string {
  return `Extract knowledge graph elements only from the atomic notes below.
Return exactly one complete JSON object. Do not use Markdown fences or add commentary.
Use exactly this compact JSON shape and these property names:
${knowledgeGraphJsonContract}

Create entities for named people, organizations, places, events, concepts, works, publications, publishers, projects, products, fields of study, tags, or collections.
Use a short unique local key for each entity. Claims must be verifiable statements from the text. Relations must connect two extracted entities.
Every entity, claim, and relation must cite at least one supplied evidence alias such as "c1". Copy aliases exactly. Do not infer unsupported facts or invent aliases.
Keep the response small: at most 12 entities, 8 claims, and 12 relations. Use empty arrays when no supported items exist.

Source title: ${source.title}
Source language: ${source.language}
Atomic notes:
${formatAtomicNotesForGraph(notes, evidenceAliases)}`;
}

export function parseKnowledgeGraphOutput(
  output: unknown,
  evidenceAliases?: ReadonlyMap<string, string>
): KnowledgeGraphGenerationOutput {
  const value = parseJsonOutput(output);
  const resolved = evidenceAliases ? resolveGraphEvidenceAliases(value, evidenceAliases) : value;
  return KnowledgeGraphGenerationOutputSchema.parse(resolved);
}

function buildKnowledgeGraphRepairPrompt(
  source: { title: string; language: string },
  notes: ReadonlyArray<KnowledgeGraphAtomicNoteInput>,
  evidenceAliases: ReadonlyMap<string, string>
): string {
  return `The previous knowledge-graph response was invalid or incomplete. Regenerate it only from the atomic notes below.
Return one complete compact JSON object only. Do not include reasoning, commentary, or Markdown fences.
Use exactly this shape and property names:
${knowledgeGraphJsonContract}

Use at most 8 entities, 5 claims, and 8 relations. Use empty arrays when necessary. Cite only supplied evidence aliases and copy them exactly.
Source title: ${source.title}
Source language: ${source.language}
Atomic notes:
${formatAtomicNotesForGraph(notes, evidenceAliases)}`;
}

export function parseKnowledgeGraphBatchCheckpoints(value: unknown): KnowledgeGraphBatchCheckpoint[] {
  const parsed = z.array(knowledgeGraphBatchCheckpointSchema).safeParse(value);
  return parsed.success ? parsed.data : [];
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
  graphScore?: number | null;
  hasEmbedding: boolean;
  rerankScore?: number | null;
}): number {
  const hasGraph = input.graphScore !== null && input.graphScore !== undefined;
  const baseScore = input.hasEmbedding
    ? hasGraph
      ? (input.vectorScore * 0.45) + (input.textScore * 0.25) + (input.graphScore! * 0.2) + (input.metadataScore * 0.1)
      : (input.vectorScore * 0.55) + (input.textScore * 0.3) + (input.metadataScore * 0.15)
    : hasGraph
      ? (input.textScore * 0.55) + (input.graphScore! * 0.3) + (input.metadataScore * 0.15)
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

function groupAtomicNotes(
  notes: ReadonlyArray<KnowledgeGraphAtomicNoteInput>,
  maxCharacters: number
): KnowledgeGraphAtomicNoteInput[][] {
  const groups: KnowledgeGraphAtomicNoteInput[][] = [];
  let current: KnowledgeGraphAtomicNoteInput[] = [];
  let currentLength = 0;
  for (const note of notes) {
    const length = graphNoteContent(note).length;
    if (current.length > 0 && currentLength + length > maxCharacters) {
      groups.push(current);
      current = [];
      currentLength = 0;
    }
    current.push(note);
    currentLength += length;
  }
  if (current.length > 0) groups.push(current);
  return groups;
}

function graphNoteContent(note: KnowledgeGraphAtomicNoteInput): string {
  return `${note.title}\n${note.ideaStatement}\n${note.bodyMarkdown}`;
}

function createEvidenceAliases(notes: ReadonlyArray<KnowledgeGraphAtomicNoteInput>): Map<string, string> {
  const chunkIds = [...new Set(notes.flatMap((note) => note.evidenceChunkIds))].sort();
  return new Map(chunkIds.map((chunkId, index) => [`c${index + 1}`, chunkId]));
}

function formatAtomicNotesForGraph(
  notes: ReadonlyArray<KnowledgeGraphAtomicNoteInput>,
  evidenceAliases: ReadonlyMap<string, string>
): string {
  const aliasByChunkId = new Map([...evidenceAliases].map(([alias, chunkId]) => [chunkId, alias]));
  return notes.map((note, index) => {
    const aliases = note.evidenceChunkIds.flatMap((chunkId) => {
      const alias = aliasByChunkId.get(chunkId);
      return alias ? [alias] : [];
    });
    return `[n${index + 1}; evidence=${aliases.join(",")}]
Title: ${note.title}
Idea: ${note.ideaStatement}
${note.bodyMarkdown}`;
  }).join("\n\n");
}

function resolveGraphEvidenceAliases(value: unknown, evidenceAliases: ReadonlyMap<string, string>): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const root = value as Record<string, unknown>;
  const resolveItems = (items: unknown): unknown => Array.isArray(items)
    ? items.map((item) => {
        if (typeof item !== "object" || item === null || Array.isArray(item)) return item;
        const record = item as Record<string, unknown>;
        if (!Array.isArray(record.evidenceChunkIds)) return record;
        return {
          ...record,
          evidenceChunkIds: record.evidenceChunkIds.map((candidate) => {
            if (typeof candidate !== "string") return candidate;
            const chunkId = evidenceAliases.get(candidate);
            if (!chunkId) throw new Error(`knowledge_graph_unknown_evidence_alias:${candidate}`);
            return chunkId;
          })
        };
      })
    : items;
  return {
    ...root,
    entities: resolveItems(root.entities),
    claims: resolveItems(root.claims),
    relations: resolveItems(root.relations)
  };
}

function knowledgeGraphBatchKey(notes: ReadonlyArray<KnowledgeGraphAtomicNoteInput>): string {
  const hash = createHash("sha256");
  for (const note of notes) {
    hash.update(note.id);
    hash.update("\0");
    hash.update(graphNoteContent(note));
    hash.update("\0");
    hash.update([...note.evidenceChunkIds].sort().join(","));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function reusableGraphCheckpoints(
  groups: ReadonlyArray<ReadonlyArray<KnowledgeGraphAtomicNoteInput>>,
  completed: ReadonlyArray<KnowledgeGraphBatchCheckpoint>
): KnowledgeGraphBatchCheckpoint[] {
  const reusable: KnowledgeGraphBatchCheckpoint[] = [];
  for (let index = 0; index < Math.min(groups.length, completed.length); index += 1) {
    const group = groups[index] ?? [];
    const checkpoint = completed[index];
    if (!checkpoint || checkpoint.batchKey !== knowledgeGraphBatchKey(group)) break;
    reusable.push(checkpoint);
  }
  return reusable;
}

function executionTrace(execution: KnowledgeAiExecution): KnowledgeGraphExecutionTrace {
  return {
    providerId: execution.providerId,
    modelId: execution.modelId,
    runtime: execution.runtime,
    profileId: execution.profileId,
    aiTaskRunId: execution.aiTaskRunId,
    ...(execution.outputLanguage !== undefined ? { outputLanguage: execution.outputLanguage } : {})
  };
}

function knowledgeGraphValidationCode(error: unknown): string {
  if (error instanceof SyntaxError) return "invalid_json";
  if (error instanceof z.ZodError) return "schema_validation";
  if (error instanceof Error && /^[a-zA-Z0-9_.:-]{1,100}$/.test(error.message)) return error.message;
  return "unknown_validation_error";
}

function parseJsonOutput(output: unknown): unknown {
  if (typeof output !== "string") return output;
  const trimmed = output.trim();
  const withoutFence = trimmed.startsWith("```")
    ? trimmed.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")
    : trimmed;
  try {
    return JSON.parse(withoutFence);
  } catch (error) {
    const object = extractFirstJsonObject(withoutFence);
    if (!object) throw error;
    return JSON.parse(object);
  }
}

function extractFirstJsonObject(value: string): string | null {
  const start = value.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < value.length; index += 1) {
    const character = value[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === "\"") inString = false;
      continue;
    }
    if (character === "\"") inString = true;
    else if (character === "{") depth += 1;
    else if (character === "}") {
      depth -= 1;
      if (depth === 0) return value.slice(start, index + 1);
    }
  }
  return null;
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
