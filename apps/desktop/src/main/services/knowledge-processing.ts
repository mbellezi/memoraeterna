import { compareContent } from "./content-order.js";
import { renderPrompt, changedPromptIdentity } from "./prompt-runtime.js";
import { createHash } from "node:crypto";
import { z } from "zod";
import {
  AtomicNoteGenerationOutputSchema,
  defaultAtomicNoteMatchingSettings,
  type AtomicNoteMatchingSettings,
  AtomicNoteRelationTypeSchema,
  KnowledgeGraphGenerationOutputSchema,
  type AtomicNoteGenerationOutput,
  type AtomicNoteRelationType,
  type KnowledgeGraphGenerationOutput
} from "@app/domain";

export const summaryPromptVersion = "summary-v3";
export const hierarchyAggregateSummaryPromptVersion = "hierarchy-aggregate-v2";
export const atomicNotePromptVersion = "atomic-note-v4";
export const atomicNoteMatchingVersion = "atomic-note-matching-v8";
export const knowledgeGraphPromptVersion = "knowledge-graph-v8";
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
  minimumWordCount = defaultSummaryMinimumWordCount
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

  const partials: string[] = [];
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
    if (partial.length > 0) partials.push(partial);
  }
  if (partials.length === 0) {
    return { summary: "", mapReduce: true, executions, skippedReason: "non_content" };
  }
  const reduction = await run(summaryReductionPrompt(partials), {
    operation: "summary_reduce",
    promptVersion: summaryPromptVersion,
    batchIndex: groups.length,
    attempt: 0,
    chunkIds: nonEmptyChunks.map((chunk) => chunk.id)
  });
  if (!reduction) return null;
  executions.push(reduction);
  const summary = normalizeSummaryText(reduction.output);
  return {
    summary,
    concepts,
    mapReduce: true,
    executions,
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
    const batchLimits = {
      maxEntities: Math.min(12, remaining?.maxEntities ?? 12),
      maxRelations: Math.min(12, remaining?.maxRelations ?? 12)
    };
    const execution = await run(
      buildKnowledgeGraphPrompt(source, group, evidenceAliases, inputKind, batchLimits),
      {
        operation: `graph_${inputKind}`,
        promptVersion: knowledgeGraphPromptVersion,
        batchIndex,
        attempt: 0,
        chunkIds: [...evidenceAliases.values()]
      }
    );
    if (!execution) return null;
    let parsed: KnowledgeGraphGenerationOutput;
    let finalExecution = execution;
    try {
      parsed = parseKnowledgeGraphOutput(execution.output, evidenceAliases);
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
          batchIndex,
          attempt: 1,
          chunkIds: [...evidenceAliases.values()]
        }
      );
      if (!repaired) throw initialError;
      try {
        parsed = parseKnowledgeGraphOutput(repaired.output, evidenceAliases);
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

export async function generateAtomicNoteCandidates(
  source: { title: string; language: string },
  chunks: ReadonlyArray<{ id: string; content: string }>,
  run: KnowledgeAiRunner
): Promise<{ output: AtomicNoteGenerationOutput; execution: KnowledgeAiExecution } | null> {
  const allowedChunkIds = new Set(chunks.map((chunk) => chunk.id));
  const execution = await run(buildAtomicNoteGenerationPrompt(source, chunks), {
    operation: "atomic_note_generation",
    promptVersion: atomicNotePromptVersion,
    batchIndex: 0,
    attempt: 0,
    chunkIds: [...allowedChunkIds]
  });
  if (!execution) return null;
  try {
    return {
      output: parseAtomicNoteGenerationOutput(execution.output, allowedChunkIds),
      execution
    };
  } catch (initialError) {
    const repairedExecution = await run(
      buildAtomicNoteRepairPrompt(execution.output, [...allowedChunkIds], initialError),
      {
        operation: "atomic_note_repair",
        promptVersion: atomicNotePromptVersion,
        batchIndex: 0,
        attempt: 1,
        chunkIds: [...allowedChunkIds]
      }
    );
    if (!repairedExecution) throw initialError;
    return {
      output: parseAtomicNoteGenerationOutput(repairedExecution.output, allowedChunkIds),
      execution: repairedExecution
    };
  }
}

export function scoreMetadataOverlap(
  left: Record<string, unknown>,
  right: Record<string, unknown>
): number {
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

export function qualifiesAtomicNoteRelation(input: {
  finalScore: number;
  threshold: number;
  rerankScore: number | null;
  relationType: string;
  settings: AtomicNoteMatchingSettings;
}): boolean {
  const validated =
    input.rerankScore === null
      ? !input.settings.requireReranking
      : input.rerankScore > 0 && input.rerankScore >= input.settings.minRerankScore;
  return (
    meetsRelationThreshold(input.finalScore, input.threshold) &&
    validated &&
    (input.settings.includeWeakTypes || !["mentions", "related"].includes(input.relationType))
  );
}

export function calculateRelationScore(input: {
  vectorScore: number;
  textScore: number;
  metadataScore: number;
  graphScore?: number | null;
  hasEmbedding: boolean;
  rerankScore?: number | null;
  settings?: AtomicNoteMatchingSettings;
}): number {
  const hasGraph = input.graphScore !== null && input.graphScore !== undefined;
  const settings = input.settings ?? defaultAtomicNoteMatchingSettings;
  const selected = input.hasEmbedding
    ? hasGraph
      ? settings.withEmbeddingAndGraph
      : settings.withEmbedding
    : hasGraph
      ? settings.withGraph
      : settings.textAndMetadata;
  const scores = {
    vector: input.vectorScore,
    text: input.textScore,
    metadata: input.metadataScore,
    graph: input.graphScore ?? 0
  };
  const entries = Object.entries(selected) as Array<[keyof typeof scores, number]>;
  const totalWeight = entries.reduce((total, [, value]) => total + value, 0);
  const baseScore =
    entries.reduce((total, [key, value]) => total + scores[key] * value, 0) / totalWeight;
  return Math.max(
    0,
    Math.min(
      1,
      input.rerankScore === null || input.rerankScore === undefined
        ? baseScore
        : baseScore * (1 - settings.rerankerWeight) + input.rerankScore * settings.rerankerWeight
    )
  );
}

export interface AtomicNoteRelationScoreInputs {
  vectorScore: number;
  textScore: number;
  metadataScore: number;
  graphScore: number | null;
}

/**
 * Lossless feasibility gate: the final score grows monotonically with the decider score, so a
 * candidate whose final score stays below the threshold even with a perfect decider score (1) can
 * never qualify, whatever the decider would say. Only such candidates are dropped before a call.
 */
export function canQualifyAtomicNoteRelation(input: {
  scores: AtomicNoteRelationScoreInputs;
  hasEmbedding: boolean;
  threshold: number;
  settings: AtomicNoteMatchingSettings;
}): boolean {
  return meetsRelationThreshold(
    calculateRelationScore({
      ...input.scores,
      hasEmbedding: input.hasEmbedding,
      rerankScore: 1,
      settings: input.settings
    }),
    input.threshold
  );
}

/**
 * Whether one decider verdict could be accepted for a candidate, ignoring the per-note limit that
 * depends on the other candidates. A verdict that cannot qualify is never explained or repaired.
 */
export function atomicNoteVerdictQualifies(input: {
  scores: AtomicNoteRelationScoreInputs;
  hasEmbedding: boolean;
  threshold: number;
  settings: AtomicNoteMatchingSettings;
  verdict: { score: number; relationType: string };
}): boolean {
  return qualifiesAtomicNoteRelation({
    finalScore: calculateRelationScore({
      ...input.scores,
      hasEmbedding: input.hasEmbedding,
      rerankScore: input.verdict.score,
      settings: input.settings
    }),
    threshold: input.threshold,
    rerankScore: input.verdict.score,
    relationType: input.verdict.relationType,
    settings: input.settings
  });
}

export interface AtomicNoteRelationSelectionCandidate {
  noteId: string;
  contentKey: string;
  scores: AtomicNoteRelationScoreInputs;
  /**
   * Whether this candidate's vector score is real. A candidate that still has no vector is scored
   * with the weights that do not assume one, never as a vector score of 0. Defaults to the note's.
   */
  hasEmbedding?: boolean;
  /** The decider's verdict for this direction, or null when no decision exists. */
  decision: { score: number; relationType: AtomicNoteRelationType } | null;
}

export interface AtomicNoteRelationSelection<
  T extends AtomicNoteRelationSelectionCandidate = AtomicNoteRelationSelectionCandidate
> {
  candidate: T;
  baseScore: number;
  finalScore: number;
  relationType: string;
  qualifies: boolean;
  /** Qualifies and fits in the per-note relation limit, in final-score order. */
  accepted: boolean;
}

/** Orders candidates by final score and applies the acceptance rules and the per-note limit. */
export function selectAtomicNoteRelations<T extends AtomicNoteRelationSelectionCandidate>(
  candidates: ReadonlyArray<T>,
  options: { hasEmbedding: boolean; threshold: number; settings: AtomicNoteMatchingSettings }
): AtomicNoteRelationSelection<T>[] {
  let accepted = 0;
  return candidates
    .map((candidate) => {
      const score = (rerankScore: number | null) =>
        calculateRelationScore({
          ...candidate.scores,
          hasEmbedding: candidate.hasEmbedding ?? options.hasEmbedding,
          rerankScore,
          settings: options.settings
        });
      const finalScore = score(candidate.decision?.score ?? null);
      const relationType = candidate.decision?.relationType ?? "related";
      return {
        candidate,
        baseScore: score(null),
        finalScore,
        relationType,
        qualifies: qualifiesAtomicNoteRelation({
          finalScore,
          threshold: options.threshold,
          rerankScore: candidate.decision?.score ?? null,
          relationType,
          settings: options.settings
        }),
        accepted: false
      };
    })
    .sort(
      (left, right) =>
        right.finalScore - left.finalScore ||
        compareContent(left.candidate.contentKey, right.candidate.contentKey) ||
        left.candidate.noteId.localeCompare(right.candidate.noteId)
    )
    .map((selection) => {
      const fits = selection.qualifies && accepted < options.settings.maxRelationsPerNote;
      if (fits) accepted += 1;
      return { ...selection, accepted: fits };
    });
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

/** Model-written explanations are short; longer prose is treated as an invalid item. */
export const maxRerankExplanationCharacters = 300;

/**
 * The decider is told to explain scores at or above this. A fixed part of the matching contract,
 * never derived from the relation calibration (`minRerankScore`), so a stored raw score does not
 * depend on how the thresholds were set when it was produced.
 */
export const rerankExplanationMinScore = 0.5;

const batchRerankDecisionSchema = z.object({
  candidateAlias: z.string().regex(/^c[1-9][0-9]*$/),
  score: z.number().min(0).max(1),
  relationType: AtomicNoteRelationTypeSchema,
  // Validated only when the score asks for an explanation; prose of a rejection is ignored.
  explanation: z.unknown().optional()
});

const batchRerankEnvelopeSchema = z.object({ results: z.array(z.unknown()).max(100) });

export interface BatchRerankDecision {
  candidateAlias: string;
  score: number;
  relationType: AtomicNoteRelationType;
  /** A safe explanation with unresolved aliases, only for scores at or above the threshold. */
  explanation: string | null;
}

export interface BatchRerankParseResult {
  /** Valid decisions; a valid score without its required explanation keeps a null explanation. */
  decisions: Map<string, BatchRerankDecision>;
  /** Aliases to request once more, in prompt order: missing, malformed, duplicated or unexplained. */
  retry: string[];
}

/**
 * Decision-only contract: every candidate gets an alias, a score and a relation type; only a score
 * at or above `rerankExplanationMinScore` carries a short explanation. Valid items are kept;
 * nothing in one item can invalidate another, and the prose of a rejected candidate is never read.
 * A missing explanation is asked for again only when `canQualify` says the verdict could still be
 * accepted: a pair that never qualifies is not worth a paid repair.
 */
export function parseBatchRerankOutput(
  output: unknown,
  allowedAliases: ReadonlyArray<string>,
  canQualify: (
    alias: string,
    verdict: { score: number; relationType: AtomicNoteRelationType }
  ) => boolean = () => true
): BatchRerankParseResult {
  const allowed = new Set(allowedAliases);
  const decisions = new Map<string, BatchRerankDecision>();
  const invalid = new Set<string>();
  const unexplained = new Set<string>();
  let items: unknown[];
  try {
    items = batchRerankEnvelopeSchema.parse(parseJsonOutput(output)).results;
  } catch {
    // Unparseable output decides nothing: every alias is asked again once.
    items = [];
  }
  for (const item of items) {
    const alias =
      item && typeof item === "object" && "candidateAlias" in item
        ? (item as { candidateAlias: unknown }).candidateAlias
        : undefined;
    if (typeof alias !== "string" || !allowed.has(alias)) continue;
    const parsed = batchRerankDecisionSchema.safeParse(item);
    if (!parsed.success || decisions.has(alias) || invalid.has(alias)) {
      // A duplicated alias is ambiguous: neither answer is trusted.
      decisions.delete(alias);
      unexplained.delete(alias);
      invalid.add(alias);
      continue;
    }
    const explained = parsed.data.score >= rerankExplanationMinScore;
    const explanation = explained ? safeRerankExplanation(parsed.data.explanation, alias) : null;
    if (
      explained &&
      explanation === null &&
      canQualify(alias, { score: parsed.data.score, relationType: parsed.data.relationType })
    )
      unexplained.add(alias);
    decisions.set(alias, {
      candidateAlias: alias,
      score: parsed.data.score,
      relationType: parsed.data.relationType,
      explanation
    });
  }
  return {
    decisions,
    retry: allowedAliases.filter((alias) => !decisions.has(alias) || unexplained.has(alias))
  };
}

/**
 * A repaired answer replaces the first one for the aliases asked again (the repair is parsed with
 * only those aliases allowed). A decision whose explanation is still missing after the repair is
 * kept without one: the score decides, the prose is optional.
 */
export function mergeBatchRerankRepair(
  initial: BatchRerankParseResult,
  repair: BatchRerankParseResult
): Map<string, BatchRerankDecision> {
  return new Map([...initial.decisions, ...repair.decisions]);
}

function safeRerankExplanation(value: unknown, candidateAlias: string): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text || text.length > maxRerankExplanationCharacters) return null;
  if (/<\/?(?:note|source)-ref\b/i.test(text)) return null;
  for (const [alias] of text.matchAll(/\b[sc][0-9]+\b/g))
    if (alias !== "s1" && alias !== candidateAlias) return null;
  return text;
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

export function buildBatchRerankPrompt(
  source: { title: string; ideaStatement: string },
  candidates: ReadonlyArray<{ alias: string; title: string; ideaStatement: string }>
): string {
  return renderPrompt("notes.match", {
    source_title: source.title,
    source_idea: source.ideaStatement,
    explanation_min_score: rerankExplanationMinScore,
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
  if (error instanceof SyntaxError) return "invalid_json";
  if (error instanceof z.ZodError) return "schema_validation";
  if (error instanceof Error && /^[a-zA-Z0-9_.:-]{1,100}$/.test(error.message))
    return error.message;
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

function collectMetadataSignals(metadata: Record<string, unknown>): Set<string> {
  const values = [metadata.entities, metadata.tags, metadata.concepts]
    .flatMap((value) => (Array.isArray(value) ? value : []))
    .filter((value): value is string => typeof value === "string")
    .map((value) => value.trim().toLocaleLowerCase())
    .filter(Boolean);
  return new Set(values);
}
