import { compareContent } from "./content-order.js";
import { StructuredItemsError, salvageKnowledgeGraph, type GraphSalvage } from "./graph-salvage.js";
import { renderPrompt, changedPromptIdentity } from "./prompt-runtime.js";
import { combineWithinBudget } from "./summary-batching.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AtomicNoteGenerationCandidateSchema,
  AtomicNoteGenerationOutputSchema,
  AtomicNoteRelationTypeSchema,
  KnowledgeGraphGenerationOutputSchema,
  type AiOutputContract,
  type AtomicNoteGenerationOutput,
  type AtomicNoteRelationType,
  type KnowledgeGraphGenerationOutput,
  validateItems
} from "@app/domain";

export const summaryPromptVersion = "summary-v3";
export const hierarchyAggregateSummaryPromptVersion = "hierarchy-aggregate-v2";
export const atomicNotePromptVersion = "atomic-note-v4";
export const atomicNoteMatchingVersion = "atomic-note-matching-v9";
export const knowledgeGraphPromptVersion = "knowledge-graph-v8";
/** The contracts the generative structured calls state (F4 D23); neither can be sent strictly. */
const knowledgeGraphOutputContract: AiOutputContract = {
  name: "knowledge_graph",
  contract: KnowledgeGraphGenerationOutputSchema
};
const atomicNotesOutputContract: AiOutputContract = {
  name: "atomic_notes",
  contract: AtomicNoteGenerationOutputSchema
};
export const emptySummaryTag = "<NO_SUMMARY>";
export const defaultSummaryMinimumWordCount = 40;

const knowledgeGraphExecutionTraceSchema = z
  .object({
    providerId: z.string(),
    modelId: z.string(),
    runtime: z.string(),
    profileId: z.string(),
    aiTaskRunId: z.string(),
    outputLanguage: z.string().optional()
  })
  .strict();

const knowledgeGraphBatchCheckpointSchema = z
  .object({
    batchKey: z.string(),
    batch: KnowledgeGraphGenerationOutputSchema,
    execution: knowledgeGraphExecutionTraceSchema
  })
  .strict();

export interface KnowledgeAiExecution {
  output: unknown;
  providerId: string;
  modelId: string;
  runtime: string;
  profileId: string;
  aiTaskRunId: string;
  outputLanguage?: string;
}

export interface KnowledgeCallContext {
  operation: string;
  promptVersion: string;
  /** Set by the structured calls (graph, notes); the summaries answer free text. */
  outputContract?: AiOutputContract;
  batchIndex: number;
  attempt: number;
  chunkIds: string[];
}
export type KnowledgeAiRunner = (
  input: string,
  context: KnowledgeCallContext
) => Promise<KnowledgeAiExecution | null>;

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

export interface KnowledgeGraphExtractionLimits {
  maxEntities: number;
  maxRelations: number;
}

export function limitKnowledgeGraphBatches(
  batches: ReadonlyArray<KnowledgeGraphGenerationOutput>,
  limits: KnowledgeGraphExtractionLimits
): KnowledgeGraphGenerationOutput[] {
  const maxEntities = Math.max(0, Math.floor(limits.maxEntities));
  const maxRelations = Math.max(0, Math.floor(limits.maxRelations));
  let entityCount = 0;
  let relationCount = 0;
  return batches.map((batch) => {
    const allowedKeys = new Set<string>();
    const entities = batch.entities.filter((entity) => {
      if (entityCount >= maxEntities) return false;
      entityCount += 1;
      allowedKeys.add(entity.key);
      return true;
    });
    const relations = batch.relations.filter((relation) => {
      if (
        relationCount >= maxRelations ||
        !allowedKeys.has(relation.subjectEntityKey) ||
        !allowedKeys.has(relation.objectEntityKey)
      )
        return false;
      relationCount += 1;
      return true;
    });
    return { entities, relations };
  });
}

function remainingGraphLimits(
  batches: ReadonlyArray<KnowledgeGraphGenerationOutput>,
  limits?: KnowledgeGraphExtractionLimits
): KnowledgeGraphExtractionLimits | null {
  if (!limits) return null;
  const entities = batches.reduce((total, batch) => total + batch.entities.length, 0);
  const relations = batches.reduce((total, batch) => total + batch.relations.length, 0);
  return {
    maxEntities: Math.max(0, Math.floor(limits.maxEntities) - entities),
    maxRelations: Math.max(0, Math.floor(limits.maxRelations) - relations)
  };
}

export interface KnowledgeGraphGenerationOptions {
  completedBatches?: ReadonlyArray<KnowledgeGraphBatchCheckpoint>;
  inputKind?: "atomic_notes" | "source_chunks" | "catalog_metadata";
  checkpointNamespace?: string;
  contentLanguage?: string;
  /**
   * Document position (chunk index) of each evidence chunk. Evidence aliases follow it, so the same
   * content gets the same aliases on every import; chunk IDs never order anything.
   */
  chunkPositions?: ReadonlyMap<string, number>;
  resolveRelations?: (
    batch: KnowledgeGraphGenerationOutput
  ) => Promise<KnowledgeGraphGenerationOutput>;
  extractionLimits?: KnowledgeGraphExtractionLimits;
  /**
   * The recording-era parse path (F3 D5): the whole answer is validated strictly and repaired as a
   * whole, with no salvage. Pinned runs set it so every recorded repair replays.
   */
  pinned?: boolean;
  /** The hard caps one call states (D36: 24/24 on a remote writer, 12/12 otherwise); 12/12 when left out. */
  batchLimits?: KnowledgeGraphExtractionLimits;
  /** Called for every batch whose answer was salvaged, so the items dropped with no call are counted. */
  onSalvage?: (input: { batchIndex: number; salvage: GraphSalvage; repaired: boolean }) => void;
  onBatchCompleted?: (input: {
    completed: number;
    total: number;
    checkpoints: KnowledgeGraphBatchCheckpoint[];
  }) => Promise<void>;
}

export interface SummaryResult {
  summary: string;
  concepts?: Array<{ idea: string; evidenceChunkIds: string[] }>;
  mapReduce: boolean;
  executions: KnowledgeAiExecution[];
  skippedReason?: "too_short" | "non_content";
  /** Levels of batches the partial summaries were combined in before the last call (0: one call). */
  reductionLevels?: number;
}

export function normalizeSummaryText(output: unknown): string {
  const structuredSummary = extractStructuredSummary(output);
  if (structuredSummary) return normalizeSummaryValue(structuredSummary);
  if (typeof output !== "string" || output.trim().length === 0) {
    throw new Error("ai_task_empty_output");
  }
  const trimmed = output.trim();
  try {
    const parsed = parseJsonOutput(trimmed);
    const parsedSummary = extractStructuredSummary(parsed);
    if (parsedSummary) return normalizeSummaryValue(parsedSummary);
  } catch {
    // Plain-text summaries are the normal response format.
  }
  return normalizeSummaryValue(trimmed);
}

export function hasMinimumSummaryContent(
  contents: ReadonlyArray<string>,
  minimumWords = defaultSummaryMinimumWordCount
): boolean {
  if (minimumWords <= 0) return true;
  const words = contents.join("\n").match(/[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu);
  return (words?.length ?? 0) >= minimumWords;
}

export async function generateSummaryFromChunks(
  chunks: ReadonlyArray<{ id: string; content: string }>,
  run: KnowledgeAiRunner,
  maxInputCharacters = 3_500,
  minimumWordCount = defaultSummaryMinimumWordCount,
  /**
   * The most bytes one reduction call's prompt may have (plan decision 28), or how to find out when
   * the partial summaries are there; null leaves the reduction as one call whatever its size.
   */
  promptBudgetBytes: number | (() => Promise<number>) | null = null
): Promise<SummaryResult | null> {
  const nonEmptyChunks = chunks.filter((chunk) => chunk.content.trim().length > 0);
  if (nonEmptyChunks.length === 0) return null;
  if (
    !hasMinimumSummaryContent(
      nonEmptyChunks.map((chunk) => chunk.content),
      minimumWordCount
    )
  ) {
    return { summary: "", mapReduce: false, executions: [], skippedReason: "too_short" };
  }
  const groups = groupChunks(nonEmptyChunks, maxInputCharacters);
  const executions: KnowledgeAiExecution[] = [];
  if (groups.length === 1) {
    const execution = await run(summaryPrompt(groups[0] ?? [], false), {
      operation: "summary",
      promptVersion: summaryPromptVersion,
      batchIndex: 0,
      attempt: 0,
      chunkIds: (groups[0] ?? []).map((chunk) => chunk.id)
    });
    if (!execution) return null;
    executions.push(execution);
    const summary = normalizeSummaryText(execution.output);
    return {
      summary,
      concepts: summaryConcepts(execution.output, groups[0] ?? []),
      mapReduce: false,
      executions,
      ...(summary.length === 0 ? { skippedReason: "non_content" as const } : {})
    };
  }

  const partials: Array<{ text: string; chunkIds: string[] }> = [];
  const concepts: NonNullable<SummaryResult["concepts"]> = [];
  for (const [batchIndex, group] of groups.entries()) {
    const execution = await run(summaryPrompt(group, true), {
      operation: "summary_map",
      promptVersion: summaryPromptVersion,
      batchIndex,
      attempt: 0,
      chunkIds: group.map((chunk) => chunk.id)
    });
    if (!execution) return null;
    executions.push(execution);
    const partial = normalizeSummaryText(execution.output);
    concepts.push(...summaryConcepts(execution.output, group));
    if (partial.length > 0)
      partials.push({ text: partial, chunkIds: group.map((chunk) => chunk.id) });
  }
  if (partials.length === 0) {
    return { summary: "", mapReduce: true, executions, skippedReason: "non_content" };
  }
  // The partial summaries go to one call. Past the writer's budget (plan decision 28) they are
  // combined in consecutive batches, recursively, until one call fits; within it, this is the one
  // call it always was.
  const budgetBytes =
    typeof promptBudgetBytes === "function" ? await promptBudgetBytes() : promptBudgetBytes;
  const reduced = await combineWithinBudget({
    items: partials,
    render: (batch) => summaryReductionPrompt(batch.map((partial) => partial.text)),
    budgetBytes: budgetBytes ?? Number.POSITIVE_INFINITY,
    run: async (step) => {
      const reduction = await run(step.prompt, {
        operation: "summary_reduce",
        promptVersion: summaryPromptVersion,
        batchIndex: groups.length + step.call,
        attempt: 0,
        chunkIds:
          step.level === 0 && step.batches === 1
            ? nonEmptyChunks.map((chunk) => chunk.id)
            : step.items.flatMap((partial) => partial.chunkIds)
      });
      return reduction
        ? { text: normalizeSummaryText(reduction.output), execution: reduction }
        : null;
    },
    join: (batch, text) => ({ text, chunkIds: batch.flatMap((partial) => partial.chunkIds) })
  });
  if (!reduced) return null;
  executions.push(...reduced.executions);
  const summary = reduced.item?.text ?? "";
  return {
    summary,
    concepts,
    mapReduce: true,
    executions,
    ...(reduced.batched ? { reductionLevels: reduced.levels } : {}),
    ...(summary.length === 0 ? { skippedReason: "non_content" as const } : {})
  };
}

export function buildAggregateSummaryPrompt(
  source: { kind: string; title: string },
  subparts: ReadonlyArray<{ title: string; summary: string }>
): string {
  return renderPrompt("summary.aggregate", {
    source_type: source.kind,
    source_title: source.title,
    ordered_subparts: subparts
      .map((subpart, index) => `[Subpart ${index + 1}: ${subpart.title}]\n${subpart.summary}`)
      .join("\n\n")
  });
}

export interface AggregateSummaryOutcome<E> {
  summary: string;
  executions: E[];
  /** Levels of batches the subparts' summaries were combined in before the last call (0: one call). */
  levels: number;
  calls: number;
}

/**
 * The aggregate summary of a source from its subparts' summaries. All of them go to one call, as
 * they always did, while the prompt fits `budgetBytes` (derived from the writer's context window,
 * `summaryBudget`); past it they are combined in consecutive batches by the same prompt, each batch
 * standing in the next level for the span of titles it covers, until one call fits (plan decision
 * 28). Resolves null when `run` resolves null (no model answered); the summary is empty when
 * nothing substantive came back.
 */
export async function summarizeSubpartsWithinBudget<E extends { output: unknown }>(input: {
  source: { kind: string; title: string };
  subparts: ReadonlyArray<{ title: string; summary: string }>;
  budgetBytes: number;
  /** One call; `call` is its position among the calls of the combination. */
  run: (prompt: string, info: { call: number; batched: boolean }) => Promise<E | null>;
  signal?: AbortSignal | undefined;
}): Promise<AggregateSummaryOutcome<E> | null> {
  const combined = await combineWithinBudget({
    items: input.subparts.map((subpart) => ({
      ...subpart,
      first: subpart.title,
      last: subpart.title
    })),
    render: (batch) => buildAggregateSummaryPrompt(input.source, batch),
    budgetBytes: input.budgetBytes,
    run: async (step) => {
      const execution = await input.run(step.prompt, {
        call: step.call,
        batched: step.level > 0 || step.items.length < input.subparts.length
      });
      return execution ? { text: normalizeSummaryText(execution.output), execution } : null;
    },
    // A batch stands for the span of subparts it covers, named by its first and last titles.
    join: (batch, text) => {
      const first = batch[0]!.first;
      const last = batch.at(-1)!.last;
      return { title: first === last ? first : `${first} – ${last}`, summary: text, first, last };
    },
    signal: input.signal
  });
  if (!combined) return null;
  return {
    summary: combined.item?.summary ?? "",
    executions: combined.executions,
    levels: combined.batched ? combined.levels : 0,
    calls: combined.calls
  };
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
  const inputKind = options.inputKind ?? "atomic_notes";
  const checkpointNamespace = options.checkpointNamespace ?? "";
  const groups = groupAtomicNotes(
    notes.filter((note) => graphNoteContent(note).trim().length > 0),
    maxInputCharacters
  );
  if (groups.length === 0) return null;
  const completedBatches = checkpointNamespace
    ? (options.completedBatches ?? []).filter((checkpoint) =>
        checkpoint.batchKey.startsWith(`${checkpointNamespace}:`)
      )
    : (options.completedBatches ?? []);
  const reusable = reusableGraphCheckpoints(
    groups,
    completedBatches,
    checkpointNamespace,
    options.contentLanguage
  );
  const limitedReusable = options.extractionLimits
    ? limitKnowledgeGraphBatches(
        reusable.map((checkpoint) => checkpoint.batch),
        options.extractionLimits
      )
    : reusable.map((checkpoint) => checkpoint.batch);
  const checkpoints = reusable.map((checkpoint, index) => ({
    ...checkpoint,
    batch: limitedReusable[index] ?? checkpoint.batch
  }));
  for (let batchIndex = checkpoints.length; batchIndex < groups.length; batchIndex += 1) {
    const remaining = remainingGraphLimits(
      checkpoints.map((checkpoint) => checkpoint.batch),
      options.extractionLimits
    );
    if (remaining && remaining.maxEntities <= 0) break;
    const group = groups[batchIndex] ?? [];
    const evidenceAliases = createEvidenceAliases(group, options.chunkPositions);
    const callCaps = options.batchLimits ?? { maxEntities: 12, maxRelations: 12 };
    const batchLimits = {
      maxEntities: Math.min(callCaps.maxEntities, remaining?.maxEntities ?? callCaps.maxEntities),
      maxRelations: Math.min(
        callCaps.maxRelations,
        remaining?.maxRelations ?? callCaps.maxRelations
      )
    };
    const execution = await run(
      buildKnowledgeGraphPrompt(source, group, evidenceAliases, inputKind, batchLimits),
      {
        operation: `graph_${inputKind}`,
        promptVersion: knowledgeGraphPromptVersion,
        outputContract: knowledgeGraphOutputContract,
        batchIndex,
        attempt: 0,
        chunkIds: [...evidenceAliases.values()]
      }
    );
    if (!execution) return null;
    let parsed: KnowledgeGraphGenerationOutput;
    let finalExecution = execution;
    // A pinned run parses as the recording did: strict, repaired as a whole, nothing salvaged.
    const parse = options.pinned
      ? (output: unknown) => ({
          output: parseKnowledgeGraphOutput(output, evidenceAliases),
          salvage: null
        })
      : (output: unknown) => {
          const salvage = salvageKnowledgeGraph(parseJsonOutput(output), evidenceAliases);
          if (salvage.nothingValid)
            throw new StructuredItemsError("knowledge_graph_nothing_valid", salvage.problems);
          return { output: salvage.output, salvage };
        };
    try {
      const first = parse(execution.output);
      parsed = first.output;
      if (first.salvage?.salvagedItems)
        options.onSalvage?.({ batchIndex, salvage: first.salvage, repaired: false });
    } catch (initialError) {
      const repaired = await run(
        buildKnowledgeGraphRepairPrompt(
          source,
          group,
          evidenceAliases,
          execution.output,
          initialError,
          inputKind,
          batchLimits
        ),
        {
          operation: `graph_${inputKind}_repair`,
          promptVersion: knowledgeGraphPromptVersion,
          outputContract: knowledgeGraphOutputContract,
          batchIndex,
          attempt: 1,
          chunkIds: [...evidenceAliases.values()]
        }
      );
      if (!repaired) throw initialError;
      try {
        const second = parse(repaired.output);
        parsed = second.output;
        if (second.salvage?.salvagedItems)
          options.onSalvage?.({ batchIndex, salvage: second.salvage, repaired: true });
      } catch (repairError) {
        throw new Error(
          `knowledge_graph_output_invalid:${knowledgeGraphValidationCode(repairError)}`
        );
      }
      finalExecution = repaired;
    }
    if (options.extractionLimits) {
      const limited = limitKnowledgeGraphBatches(
        [...checkpoints.map((checkpoint) => checkpoint.batch), parsed],
        options.extractionLimits
      );
      parsed = limited.at(-1) ?? { entities: [], relations: [] };
    }
    if (options.resolveRelations) parsed = await options.resolveRelations(parsed);
    checkpoints.push({
      batchKey: knowledgeGraphBatchKey(group, checkpointNamespace, options.contentLanguage),
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
  evidenceAliases = createEvidenceAliases(notes),
  inputKind: "atomic_notes" | "source_chunks" | "catalog_metadata" = "atomic_notes",
  limits: KnowledgeGraphExtractionLimits = { maxEntities: 12, maxRelations: 12 }
): string {
  const inputLabel = graphInputLabel(inputKind);
  return renderPrompt(`graph.${inputKind}`, {
    input_kind: inputLabel,
    relation_language: renderPrompt("shared.relation_language"),
    evidence_aliases: [...evidenceAliases.keys()],
    max_entities: limits.maxEntities,
    max_relations: limits.maxRelations,
    source_title: source.title,
    source_language: source.language,
    input_heading: graphInputHeading(inputKind),
    graph_inputs: formatGraphInputs(notes, evidenceAliases, inputKind)
  });
}

export function parseKnowledgeGraphOutput(
  output: unknown,
  evidenceAliases?: ReadonlyMap<string, string>
): KnowledgeGraphGenerationOutput {
  const value = parseJsonOutput(output);
  const resolved = evidenceAliases ? resolveGraphEvidenceAliases(value, evidenceAliases) : value;
  const parsed = KnowledgeGraphGenerationOutputSchema.parse(resolved);
  if (parsed.entities.some((entity) => entity.canonicalEntityId !== undefined))
    throw new Error("knowledge_graph_model_supplied_canonical_identity");
  if (
    parsed.relations.some(
      (relation) =>
        relation.relationTypeId !== undefined || relation.originalPredicate !== undefined
    )
  ) {
    throw new Error("knowledge_graph_model_supplied_canonical_identity");
  }
  return parsed;
}

export function buildKnowledgeGraphRepairPrompt(
  source: { title: string; language: string },
  notes: ReadonlyArray<KnowledgeGraphAtomicNoteInput>,
  evidenceAliases: ReadonlyMap<string, string>,
  previousOutput: unknown,
  validationError: unknown,
  inputKind: "atomic_notes" | "source_chunks" | "catalog_metadata" = "atomic_notes",
  limits: KnowledgeGraphExtractionLimits = { maxEntities: 8, maxRelations: 8 }
): string {
  return renderPrompt(`graph.${inputKind}.repair`, {
    input_kind: graphInputLabel(inputKind),
    relation_language: renderPrompt("shared.relation_language"),
    validation_errors: structuredOutputRepairFeedback(validationError),
    max_entities: Math.min(8, limits.maxEntities),
    max_relations: Math.min(8, limits.maxRelations),
    evidence_aliases: [...evidenceAliases.keys()],
    source_title: source.title,
    source_language: source.language,
    input_heading: graphInputHeading(inputKind),
    graph_inputs: formatGraphInputs(notes, evidenceAliases, inputKind),
    previous_output: serializeOutputForRepair(previousOutput)
  });
}

export function parseKnowledgeGraphBatchCheckpoints(
  value: unknown
): KnowledgeGraphBatchCheckpoint[] {
  const parsed = z.array(knowledgeGraphBatchCheckpointSchema).safeParse(value);
  return parsed.success ? parsed.data : [];
}

export function buildAtomicNoteGenerationPrompt(
  source: { title: string; language: string },
  chunks: ReadonlyArray<{ id: string; content: string }>
): string {
  return renderPrompt("notes.extract", {
    source_title: source.title,
    chunks: chunks.map((chunk) => `[${chunk.id}]\n${chunk.content}`).join("\n\n")
  });
}

export function buildAtomicNoteRepairPrompt(
  previousOutput: unknown,
  allowedChunkIds: ReadonlyArray<string>,
  validationError: unknown
): string {
  return renderPrompt("notes.repair", {
    validation_errors: structuredOutputRepairFeedback(validationError),
    allowed_chunk_ids: allowedChunkIds,
    previous_output: serializeOutputForRepair(previousOutput)
  });
}

export function parseAtomicNoteGenerationOutput(
  output: unknown,
  allowedChunkIds?: ReadonlySet<string>
): AtomicNoteGenerationOutput {
  const value = AtomicNoteGenerationOutputSchema.parse(
    normalizeAtomicNoteGenerationOutput(parseJsonOutput(output))
  );
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

export interface AtomicNoteGenerationOptions {
  /** The recording-era path (F3 D5): the whole answer is validated and repaired as a whole. */
  pinned?: boolean;
}

interface AtomicNoteItems {
  valid: AtomicNoteGenerationOutput["notes"];
  invalid: Array<{ raw: unknown; problems: string[] }>;
}

/**
 * Reads a note answer item by item (F3 D35): a note that fails its schema, or cites a chunk the
 * batch does not have, is set aside with what was wrong; the others are kept. A malformed answer as a
 * whole (not JSON, no note list) throws.
 */
function atomicNoteItems(output: unknown, allowedChunkIds: ReadonlySet<string>): AtomicNoteItems {
  const value = normalizeAtomicNoteGenerationOutput(parseJsonOutput(output));
  const notes =
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? (value as Record<string, unknown>).notes
      : undefined;
  if (!Array.isArray(notes))
    throw new StructuredItemsError("atomic_note_output_shape", [
      "root: the answer must be one JSON object with a notes list"
    ]);
  const checked = validateItems(notes, AtomicNoteGenerationCandidateSchema);
  const items: AtomicNoteItems = {
    valid: [],
    invalid: checked.invalid.map(({ raw, problems }) => ({ raw, problems }))
  };
  for (const { index, value: note } of checked.valid) {
    if (note.evidenceChunkIds.every((chunkId) => allowedChunkIds.has(chunkId)))
      items.valid.push(note);
    else
      items.invalid.push({
        raw: notes[index],
        problems: ["evidenceChunkIds: one or more chunk ids are not allowed"]
      });
  }
  // The contract holds at most 50 notes; the first ones in answer order are kept.
  items.valid = items.valid.slice(0, 50);
  return items;
}

export async function generateAtomicNoteCandidates(
  source: { title: string; language: string },
  chunks: ReadonlyArray<{ id: string; content: string }>,
  run: KnowledgeAiRunner,
  options: AtomicNoteGenerationOptions = {}
): Promise<{ output: AtomicNoteGenerationOutput; execution: KnowledgeAiExecution } | null> {
  const allowedChunkIds = new Set(chunks.map((chunk) => chunk.id));
  const execution = await run(buildAtomicNoteGenerationPrompt(source, chunks), {
    operation: "atomic_note_generation",
    promptVersion: atomicNotePromptVersion,
    outputContract: atomicNotesOutputContract,
    batchIndex: 0,
    attempt: 0,
    chunkIds: [...allowedChunkIds]
  });
  if (!execution) return null;
  const repair = (previousOutput: unknown, error: unknown) =>
    run(buildAtomicNoteRepairPrompt(previousOutput, [...allowedChunkIds], error), {
      operation: "atomic_note_repair",
      promptVersion: atomicNotePromptVersion,
      outputContract: atomicNotesOutputContract,
      batchIndex: 0,
      attempt: 1,
      chunkIds: [...allowedChunkIds]
    });
  if (options.pinned) {
    try {
      return {
        output: parseAtomicNoteGenerationOutput(execution.output, allowedChunkIds),
        execution
      };
    } catch (initialError) {
      const repairedExecution = await repair(execution.output, initialError);
      if (!repairedExecution) throw initialError;
      return {
        output: parseAtomicNoteGenerationOutput(repairedExecution.output, allowedChunkIds),
        execution: repairedExecution
      };
    }
  }
  let first: AtomicNoteItems | undefined;
  let initialError: unknown;
  try {
    first = atomicNoteItems(execution.output, allowedChunkIds);
  } catch (error) {
    initialError = error;
  }
  if (first && first.invalid.length === 0) return { output: { notes: first.valid }, execution };
  if (first && first.valid.length > 0) {
    // Valid notes are kept; one repair asks only for the invalid ones. Whatever it cannot fix is
    // left out, and the notes that were valid stay.
    const repaired = await repair(
      { notes: first.invalid.map((item) => item.raw) },
      new StructuredItemsError(
        "atomic_note_items_invalid",
        first.invalid.flatMap((item) => item.problems).slice(0, 8)
      )
    );
    if (!repaired) return { output: { notes: first.valid }, execution };
    let second: AtomicNoteItems | undefined;
    try {
      second = atomicNoteItems(repaired.output, allowedChunkIds);
    } catch {
      second = undefined;
    }
    const mended = second?.valid ?? [];
    return {
      output: { notes: [...first.valid, ...mended].slice(0, 50) },
      execution: mended.length > 0 ? repaired : execution
    };
  }
  // Nothing valid is left: the whole answer is asked again, as before.
  const failure =
    initialError ??
    new StructuredItemsError(
      "atomic_note_nothing_valid",
      (first?.invalid ?? []).flatMap((item) => item.problems).slice(0, 8)
    );
  const repairedExecution = await repair(execution.output, failure);
  if (!repairedExecution) throw failure;
  const second = atomicNoteItems(repairedExecution.output, allowedChunkIds);
  if (second.valid.length === 0 && second.invalid.length > 0)
    throw new StructuredItemsError(
      "atomic_note_nothing_valid",
      second.invalid.flatMap((item) => item.problems).slice(0, 8)
    );
  return { output: { notes: second.valid }, execution: repairedExecution };
}

/**
 * Identifies who decided a relation: the model, the matching contract and prompt, and the
 * parameters that can change a verdict. Output budgets and thresholds are not part of it, so
 * changing them never makes a recorded decision stale.
 */
export function atomicNoteDeciderKey(input: {
  provider: string;
  baseUrl: string | null;
  modelId: string;
  runtime: string;
  repository: string | null;
  revision: string | null;
  quantization: string | null;
  parameters: Record<string, unknown>;
  promptFingerprint: string;
}): string {
  const parameters = Object.fromEntries(
    Object.entries(input.parameters)
      .filter(([key]) => key !== "maxTokens" && key !== "contextWindow")
      .sort(([left], [right]) => compareContent(left, right))
  );
  return createHash("sha256")
    .update(
      JSON.stringify({
        contract: atomicNoteMatchingVersion,
        prompt: input.promptFingerprint,
        model: [
          input.provider,
          input.baseUrl,
          input.modelId,
          input.runtime,
          input.repository,
          input.revision,
          input.quantization
        ],
        parameters
      })
    )
    .digest("hex");
}

/** The note content a relation decision depends on: what the decider is shown. */
export function atomicNoteDecisionContentHash(note: {
  title: string;
  ideaStatement: string;
}): string {
  return createHash("sha256").update(`${note.title}\u0000${note.ideaStatement}`).digest("hex");
}

export function calculateAtomicNoteMatchingProgress(input: {
  noteIndex: number;
  noteCount: number;
  completedCandidates: number;
  candidateCount: number;
}): number {
  if (input.noteCount <= 0) return 1;
  const candidateProgress =
    input.candidateCount > 0 ? input.completedCandidates / input.candidateCount : 1;
  return Math.max(0, Math.min(1, (input.noteIndex + candidateProgress) / input.noteCount));
}

/**
 * One decision of the decide-only contract (`atomic-note-matching-v9`): the candidate's number, an
 * integer score from 0 to 100 and a relation type, and nothing else. The decider writes no prose.
 */
export const batchRerankItemSchema = z.tuple([
  z.number().int().positive(),
  z.number().int().min(0).max(100),
  AtomicNoteRelationTypeSchema
]);

// The envelope has no length cap: the answer is bounded by the output token limit, items for numbers
// that were not asked are ignored and a number answered twice is not trusted, so a surplus item can
// never discard the valid ones.
const batchRerankEnvelopeSchema = z.object({ results: z.array(z.unknown()) });

export interface BatchRerankDecision {
  /** The candidate's number in the prompt, resolved to its note by the backend. */
  alias: number;
  /** The decider's score scaled to 0-1 (the contract's integer divided by 100). */
  score: number;
  relationType: AtomicNoteRelationType;
}

export interface BatchRerankParseResult {
  /** Valid decisions by candidate number. */
  decisions: Map<number, BatchRerankDecision>;
  /** Numbers to request once more, in prompt order: missing, malformed or duplicated. */
  retry: number[];
}

/**
 * Decide-only contract: every candidate gets exactly one `[number, score, type]` item. Valid items
 * are kept; nothing in one item can invalidate another. An item for a number that was not asked
 * is ignored, and a number answered twice is ambiguous, so neither answer is trusted.
 */
export function parseBatchRerankOutput(
  output: unknown,
  allowedAliases: ReadonlyArray<number>
): BatchRerankParseResult {
  const allowed = new Set(allowedAliases);
  const decisions = new Map<number, BatchRerankDecision>();
  const invalid = new Set<number>();
  let items: unknown[];
  try {
    items = batchRerankEnvelopeSchema.parse(parseJsonOutput(output)).results;
  } catch {
    // Unparseable output decides nothing: every number is asked again once.
    items = [];
  }
  for (const item of items) {
    const alias: unknown = Array.isArray(item) ? item[0] : undefined;
    if (typeof alias !== "number" || !allowed.has(alias)) continue;
    const parsed = batchRerankItemSchema.safeParse(item);
    if (!parsed.success || decisions.has(alias) || invalid.has(alias)) {
      decisions.delete(alias);
      invalid.add(alias);
      continue;
    }
    const [, score, relationType] = parsed.data;
    decisions.set(alias, { alias, score: score / 100, relationType });
  }
  return { decisions, retry: allowedAliases.filter((alias) => !decisions.has(alias)) };
}

/**
 * A repaired answer completes the first one for the numbers asked again (the repair is parsed with
 * only those numbers allowed).
 */
export function mergeBatchRerankRepair(
  initial: BatchRerankParseResult,
  repair: BatchRerankParseResult
): Map<number, BatchRerankDecision> {
  return new Map([...initial.decisions, ...repair.decisions]);
}

export function resolveAtomicNoteReferences(
  text: string,
  sourceId: string,
  candidateAlias: string,
  targetId: string
): string {
  const aliases = new Map([
    ["s1", sourceId],
    [candidateAlias, targetId]
  ]);
  // Model output has aliases only; canonical tags are created exclusively here.
  if (/<\/?(?:note|source)-ref\b/i.test(text))
    throw new Error("atomic_note_rerank_invalid_reference");
  return text.replace(/\b[sc][0-9]+\b/g, (alias) => {
    const id = aliases.get(alias);
    if (!id) throw new Error("atomic_note_rerank_invalid_reference");
    return `<note-ref id="${id}" />`;
  });
}

/** Candidates are numbered from 1 in the content order the caller gives them. */
export function buildBatchRerankPrompt(
  source: { title: string; ideaStatement: string },
  candidates: ReadonlyArray<{ alias: number; title: string; ideaStatement: string }>
): string {
  return renderPrompt("notes.match", {
    source_title: source.title,
    source_idea: source.ideaStatement,
    candidate_notes: candidates
      .map(
        (candidate) =>
          `[${candidate.alias}]\nTitle: ${candidate.title}\nMain idea: ${candidate.ideaStatement}`
      )
      .join("\n\n")
  });
}

export interface AtomicNoteRankingInput {
  noteId: string;
  score: number;
  /** Content-stable tie-break (for example title and idea); note IDs differ on every import. */
  contentKey?: string;
}

export interface FusedAtomicNoteCandidate {
  noteId: string;
  contentKey: string;
  textScore: number;
  vectorScore: number;
  graphScore: number | null;
  textRank: number | null;
  vectorRank: number | null;
  graphRank: number | null;
  fusionScore: number;
}

export function fuseAtomicNoteCandidateRankings(
  textCandidates: ReadonlyArray<AtomicNoteRankingInput>,
  vectorCandidates: ReadonlyArray<AtomicNoteRankingInput>,
  graphCandidates: ReadonlyArray<AtomicNoteRankingInput>,
  limit = 30,
  minimumGraphOnlyCandidates = 5,
  reciprocalRankConstant = 60
): FusedAtomicNoteCandidate[] {
  const candidates = new Map<string, FusedAtomicNoteCandidate>();
  const add = (ranking: ReadonlyArray<AtomicNoteRankingInput>, kind: "text" | "vector" | "graph") =>
    ranking.forEach((candidate, index) => {
      const current = candidates.get(candidate.noteId) ?? {
        noteId: candidate.noteId,
        contentKey: candidate.contentKey ?? "",
        textScore: 0,
        vectorScore: 0,
        graphScore: null,
        textRank: null,
        vectorRank: null,
        graphRank: null,
        fusionScore: 0
      };
      if (kind === "text") {
        current.textScore = candidate.score;
        current.textRank = index + 1;
      } else if (kind === "vector") {
        current.vectorScore = candidate.score;
        current.vectorRank = index + 1;
      } else {
        current.graphScore = candidate.score;
        current.graphRank = index + 1;
      }
      if (!current.contentKey && candidate.contentKey) current.contentKey = candidate.contentKey;
      candidates.set(candidate.noteId, current);
    });
  add(textCandidates, "text");
  add(vectorCandidates, "vector");
  add(graphCandidates, "graph");
  const activeRankings = Math.max(
    1,
    (textCandidates.length > 0 ? 1 : 0) +
      (vectorCandidates.length > 0 ? 1 : 0) +
      (graphCandidates.length > 0 ? 1 : 0)
  );
  const maximumRrf = activeRankings / (reciprocalRankConstant + 1);
  const compare = (left: FusedAtomicNoteCandidate, right: FusedAtomicNoteCandidate) =>
    right.fusionScore - left.fusionScore ||
    (right.graphScore ?? 0) - (left.graphScore ?? 0) ||
    right.vectorScore - left.vectorScore ||
    right.textScore - left.textScore ||
    compareContent(left.contentKey, right.contentKey) ||
    left.noteId.localeCompare(right.noteId);
  const ranked = [...candidates.values()]
    .map((candidate) => ({
      ...candidate,
      fusionScore:
        ((candidate.textRank ? 1 / (reciprocalRankConstant + candidate.textRank) : 0) +
          (candidate.vectorRank ? 1 / (reciprocalRankConstant + candidate.vectorRank) : 0) +
          (candidate.graphRank ? 1 / (reciprocalRankConstant + candidate.graphRank) : 0)) /
        maximumRrf
    }))
    .sort(compare);
  const safeLimit = Math.max(0, limit);
  const selected = ranked.slice(0, safeLimit);
  if (safeLimit === 0 || minimumGraphOnlyCandidates <= 0) return selected;
  const textOrVectorIds = new Set([
    ...textCandidates.map((candidate) => candidate.noteId),
    ...vectorCandidates.map((candidate) => candidate.noteId)
  ]);
  const reservedGraphOnlyIds = graphCandidates
    .filter((candidate) => !textOrVectorIds.has(candidate.noteId))
    .slice(0, Math.min(safeLimit, minimumGraphOnlyCandidates))
    .map((candidate) => candidate.noteId);
  const selectedIds = new Set(selected.map((candidate) => candidate.noteId));
  const reservedIds = new Set(reservedGraphOnlyIds);
  for (const noteId of reservedGraphOnlyIds) {
    if (selectedIds.has(noteId)) continue;
    const graphCandidate = ranked.find((candidate) => candidate.noteId === noteId);
    const replacementIndex = selected.findLastIndex(
      (candidate) => !reservedIds.has(candidate.noteId)
    );
    if (!graphCandidate || replacementIndex < 0) continue;
    selectedIds.delete(selected[replacementIndex]!.noteId);
    selected[replacementIndex] = graphCandidate;
    selectedIds.add(noteId);
  }
  return selected.sort(compare);
}

export function summaryPrompt(
  chunks: ReadonlyArray<{ id: string; content: string }>,
  partial: boolean
): string {
  return renderPrompt(partial ? "summary.partial" : "summary.short", {
    chunks: chunks.map((chunk, index) => `[c${index + 1}]\n${chunk.content}`).join("\n\n")
  });
}

export function summaryConcepts(output: unknown, chunks: ReadonlyArray<{ id: string }>) {
  try {
    const schema = z.object({
      concepts: z
        .array(
          z
            .object({
              idea: z.string().trim().min(1).max(600),
              evidenceChunkIds: z.array(z.string()).min(1).max(6)
            })
            .strict()
        )
        .max(6)
    });
    const result = schema.parse(parseJsonOutput(output));
    return result.concepts.flatMap((concept) => {
      const ids = concept.evidenceChunkIds.map(
        (alias) => chunks.find((_, index) => alias === `c${index + 1}`)?.id
      );
      return ids.every((id): id is string => Boolean(id))
        ? [{ idea: concept.idea, evidenceChunkIds: [...new Set(ids)] }]
        : [];
    });
  } catch {
    return [];
  } // Legacy plain summaries remain readable; invalid concept references never become evidence.
}

export function summaryReductionPrompt(partials: ReadonlyArray<string>): string {
  return renderPrompt("summary.reduce", { partial_summaries: partials.join("\n\n---\n\n") });
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

/**
 * Evidence aliases c1..cN follow document order: the chunk position when it is known, then the order
 * in which the inputs first cite the chunk (which is itself content order). Chunk IDs are random per
 * import and must never decide an alias.
 */
export function createEvidenceAliases(
  notes: ReadonlyArray<KnowledgeGraphAtomicNoteInput>,
  chunkPositions?: ReadonlyMap<string, number>
): Map<string, string> {
  const citedAt = new Map<string, number>();
  for (const note of notes)
    for (const chunkId of note.evidenceChunkIds)
      if (!citedAt.has(chunkId)) citedAt.set(chunkId, citedAt.size);
  const position = (chunkId: string) => chunkPositions?.get(chunkId) ?? Number.POSITIVE_INFINITY;
  const ordered = [...citedAt.keys()].sort((left, right) => {
    const leftPosition = position(left);
    const rightPosition = position(right);
    return (
      (leftPosition === rightPosition ? 0 : leftPosition < rightPosition ? -1 : 1) ||
      citedAt.get(left)! - citedAt.get(right)!
    );
  });
  return new Map(ordered.map((chunkId, index) => [`c${index + 1}`, chunkId]));
}

function formatGraphInputs(
  notes: ReadonlyArray<KnowledgeGraphAtomicNoteInput>,
  evidenceAliases: ReadonlyMap<string, string>,
  inputKind: "atomic_notes" | "source_chunks" | "catalog_metadata"
): string {
  const aliasByChunkId = new Map([...evidenceAliases].map(([alias, chunkId]) => [chunkId, alias]));
  const aliasOrder = new Map([...evidenceAliases.keys()].map((alias, index) => [alias, index]));
  return notes
    .map((note, index) => {
      const aliases = note.evidenceChunkIds
        .flatMap((chunkId) => {
          const alias = aliasByChunkId.get(chunkId);
          return alias ? [alias] : [];
        })
        .sort((left, right) => aliasOrder.get(left)! - aliasOrder.get(right)!);
      const prefix = inputKind === "atomic_notes" ? "n" : "s";
      return `[${prefix}${index + 1}; evidence=${aliases.join(",")}]
Title: ${note.title}
${inputKind === "atomic_notes" ? `Idea: ${note.ideaStatement}\n` : ""}
${note.bodyMarkdown}`;
    })
    .join("\n\n");
}

function graphInputLabel(inputKind: "atomic_notes" | "source_chunks" | "catalog_metadata"): string {
  if (inputKind === "atomic_notes") return "atomic notes";
  if (inputKind === "catalog_metadata") return "source catalog metadata";
  return "source excerpts";
}

function graphInputHeading(
  inputKind: "atomic_notes" | "source_chunks" | "catalog_metadata"
): string {
  if (inputKind === "atomic_notes") return "Atomic notes";
  if (inputKind === "catalog_metadata") return "Source catalog metadata";
  return "Source excerpts";
}

function resolveGraphEvidenceAliases(
  value: unknown,
  evidenceAliases: ReadonlyMap<string, string>
): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  // Claims are no longer extracted: a model that still returns them is ignored, aliases included.
  const root = { ...(value as Record<string, unknown>) };
  delete root.claims;
  const resolveItems = (items: unknown): unknown =>
    Array.isArray(items)
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
    relations: resolveItems(root.relations)
  };
}

function knowledgeGraphBatchKey(
  notes: ReadonlyArray<KnowledgeGraphAtomicNoteInput>,
  namespace = "",
  contentLanguage = "en"
): string {
  const hash = createHash("sha256");
  hash.update(`${knowledgeGraphPromptVersion}\0${contentLanguage}\0`);
  const promptIdentity = changedPromptIdentity([
    "graph.atomic_notes",
    "graph.source_chunks",
    "graph.catalog_metadata",
    "graph.atomic_notes.repair",
    "graph.source_chunks.repair",
    "graph.catalog_metadata.repair"
  ]);
  if (promptIdentity) hash.update(promptIdentity + "\0");
  for (const note of notes) {
    hash.update(note.id);
    hash.update("\0");
    hash.update(graphNoteContent(note));
    hash.update("\0");
    hash.update([...note.evidenceChunkIds].sort().join(","));
    hash.update("\0");
  }
  const digest = hash.digest("hex");
  return namespace ? `${namespace}:${digest}` : digest;
}

function reusableGraphCheckpoints(
  groups: ReadonlyArray<ReadonlyArray<KnowledgeGraphAtomicNoteInput>>,
  completed: ReadonlyArray<KnowledgeGraphBatchCheckpoint>,
  namespace = "",
  contentLanguage = "en"
): KnowledgeGraphBatchCheckpoint[] {
  const reusable: KnowledgeGraphBatchCheckpoint[] = [];
  for (let index = 0; index < Math.min(groups.length, completed.length); index += 1) {
    const group = groups[index] ?? [];
    const checkpoint = completed[index];
    if (
      !checkpoint ||
      checkpoint.batchKey !== knowledgeGraphBatchKey(group, namespace, contentLanguage)
    )
      break;
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

function extractStructuredSummary(output: unknown): string | null {
  if (typeof output !== "object" || output === null || Array.isArray(output)) return null;
  const record = output as Record<string, unknown>;
  const summary = record.summary;
  if (typeof summary === "string" && summary.trim().length > 0) return summary.trim();
  const entries = Object.entries(record);
  if (entries.length !== 1) return null;
  const value = entries[0]?.[1];
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function normalizeSummaryValue(value: string): string {
  const trimmed = value.trim();
  return trimmed.toUpperCase() === emptySummaryTag ? "" : trimmed;
}

function structuredOutputRepairFeedback(error: unknown): string {
  if (error instanceof StructuredItemsError)
    return error.problems.length > 0
      ? error.problems.map((problem) => `- ${problem}`).join("\n")
      : "- No item of the response was valid. Match the schema and all consistency rules exactly.";
  if (error instanceof SyntaxError)
    return "- The response is not valid JSON. Fix its JSON syntax and close every string, array, and object.";
  if (error instanceof z.ZodError) {
    return error.issues
      .slice(0, 8)
      .map((issue) => {
        const path = issue.path.length > 0 ? issue.path.join(".") : "root";
        return `- ${path}: ${issue.message}`;
      })
      .join("\n");
  }
  if (
    error instanceof Error &&
    error.message.startsWith("knowledge_graph_unknown_evidence_alias:")
  ) {
    return `- ${error.message}. Use only the allowed evidence aliases listed below.`;
  }
  if (error instanceof Error && error.message === "atomic_note_unknown_evidence_chunk") {
    return "- One or more evidenceChunkIds are not allowed. Use only the supplied chunk ids listed below.";
  }
  return "- The response failed the required structured-output schema. Match the schema and all consistency rules exactly.";
}

function normalizeAtomicNoteGenerationOutput(value: unknown): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const root = value as Record<string, unknown>;
  if (!Array.isArray(root.notes)) return value;
  return {
    ...root,
    notes: root.notes.map((note) => {
      if (typeof note !== "object" || note === null || Array.isArray(note)) return note;
      const record = note as Record<string, unknown>;
      if ("evidenceChunkIds" in record || !Array.isArray(record.evidenceChunkId)) return note;
      const { evidenceChunkId, ...canonical } = record;
      return { ...canonical, evidenceChunkIds: evidenceChunkId };
    })
  };
}

function knowledgeGraphValidationCode(error: unknown): string {
  if (error instanceof StructuredItemsError) return "nothing_valid";
  if (error instanceof SyntaxError) return "invalid_json";
  if (error instanceof z.ZodError) return "schema_validation";
  if (error instanceof Error && /^[a-zA-Z0-9_.:-]{1,100}$/.test(error.message))
    return error.message;
  return "unknown_validation_error";
}

export function parseJsonOutput(output: unknown): unknown {
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
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
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
