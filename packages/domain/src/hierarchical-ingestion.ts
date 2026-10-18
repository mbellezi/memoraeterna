import { z } from "zod";

import { OptionalMetadataSchema, StableIdSchema } from "./primitives.js";

export const DocumentDivisionKinds = [
  "part",
  "chapter",
  "article",
  "section",
  "subsection",
  "frontmatter",
  "backmatter",
  "appendix",
  "unknown"
] as const;

export const DocumentDivisionKindSchema = z.enum(DocumentDivisionKinds);
export type DocumentDivisionKind = z.infer<typeof DocumentDivisionKindSchema>;

export const DivisionSelectorSchema = z.record(z.string(), z.unknown());

export const DivisionEvidenceSchema = z
  .object({
    kind: z.string().min(1),
    source: z.string().min(1),
    score: z.number().min(0).max(1),
    metadata: OptionalMetadataSchema
  })
  .strict();

export const DocumentDivisionCandidateSchema = z
  .object({
    id: StableIdSchema,
    parentId: StableIdSchema.nullable(),
    kind: DocumentDivisionKindSchema,
    title: z.string().trim().min(1),
    level: z.number().int().nonnegative(),
    position: z.number().int().nonnegative(),
    startSelector: DivisionSelectorSchema,
    endSelector: DivisionSelectorSchema,
    startPage: z.number().int().positive().optional(),
    endPage: z.number().int().positive().optional(),
    markdownStart: z.number().int().nonnegative().optional(),
    markdownEnd: z.number().int().nonnegative().optional(),
    confidence: z.number().min(0).max(1),
    evidence: z.array(DivisionEvidenceSchema),
    reviewStatus: z.enum(["proposed", "accepted", "rejected", "edited"]),
    isProcessable: z.boolean().default(true),
    metadata: OptionalMetadataSchema
  })
  .strict()
  .superRefine((division, context) => {
    if (
      division.endPage !== undefined &&
      division.startPage !== undefined &&
      division.endPage < division.startPage
    ) {
      context.addIssue({
        code: "custom",
        message: "endPage must not precede startPage",
        path: ["endPage"]
      });
    }
    if (
      division.markdownEnd !== undefined &&
      division.markdownStart !== undefined &&
      division.markdownEnd < division.markdownStart
    ) {
      context.addIssue({
        code: "custom",
        message: "markdownEnd must not precede markdownStart",
        path: ["markdownEnd"]
      });
    }
  });

export type DocumentDivisionCandidate = z.infer<typeof DocumentDivisionCandidateSchema>;

export const DocumentStructureStatusSchema = z.enum([
  "draft",
  "in_review",
  "confirmed",
  "materialized",
  "superseded"
]);

export const DocumentStructureDraftSchema = z
  .object({
    id: StableIdSchema,
    rootSourceItemId: StableIdSchema,
    rootDocumentId: StableIdSchema,
    format: z.enum(["epub", "pdf", "markdown", "other"]),
    detectorVersion: z.string().min(1),
    status: DocumentStructureStatusSchema,
    overallConfidence: z.number().min(0).max(1),
    revision: z.number().int().positive(),
    divisions: z.array(DocumentDivisionCandidateSchema),
    warnings: z.array(z.string()),
    metadata: OptionalMetadataSchema
  })
  .strict();

export type DocumentStructureDraft = z.infer<typeof DocumentStructureDraftSchema>;

export const ProcessingStages = [
  "conversion",
  "structureDetection",
  "structureReview",
  "materialization",
  "chunking",
  "embedding",
  "summarization",
  "atomicNotes",
  "knowledgeGraph",
  "atomicNoteMatching",
  "sourceMatching",
  "obsidianProjection",
  "aggregateSummarization"
] as const;

export const ProcessingStageSchema = z.enum(ProcessingStages);
export type ProcessingStage = z.infer<typeof ProcessingStageSchema>;

/**
 * Stage IDs that left the processing DAG (F2 D14: `organizeKnowledge` fed the legacy wiki). No new
 * plan, run or job names one. Stored plans, runs and batches still may: a stored stage list drops
 * them when parsed, and a stored run's checkpoint for one reads as skipped (retired), so history
 * parses and a run admitted before the change settles without it.
 */
export const RetiredProcessingStages = ["organizeKnowledge"] as const;
export type RetiredProcessingStage = (typeof RetiredProcessingStages)[number];

/** The skip reason a retired stage reads with. */
export const retiredStageSkipReason = "retired";

export function isRetiredProcessingStage(stage: unknown): stage is RetiredProcessingStage {
  return (RetiredProcessingStages as readonly unknown[]).includes(stage);
}

/**
 * A stage checkpoint as stored on an ingestion run, read under the current DAG: a retired stage is
 * skipped (retired) whatever was stored for it; any other stage reads as stored.
 */
export function readStoredStageCheckpoint(stage: string, checkpoint: unknown): unknown {
  return isRetiredProcessingStage(stage)
    ? { status: "skipped", reason: retiredStageSkipReason }
    : checkpoint;
}

/**
 * "Graph incomplete" (F3 D25, R25): a run that ended `succeeded` while its knowledge-graph stage
 * failed. Matching ran without the graph signal and the stage stays retryable. The status is read
 * from the stage's checkpoint; the run keeps its five states and nothing is stored for it.
 */
export function isGraphIncomplete(run: { status: unknown; stagesCheckpoint: unknown }): boolean {
  if (run.status !== "succeeded") return false;
  const checkpoint =
    typeof run.stagesCheckpoint === "object" && run.stagesCheckpoint !== null
      ? (run.stagesCheckpoint as Record<string, unknown>).knowledgeGraph
      : undefined;
  return (
    typeof checkpoint === "object" &&
    checkpoint !== null &&
    (checkpoint as { status?: unknown }).status === "failed"
  );
}

/** A stage list as stored or requested: retired IDs are accepted and dropped, unknown IDs are not. */
const ProcessingStageListSchema = z
  .array(z.union([ProcessingStageSchema, z.enum(RetiredProcessingStages)]))
  .transform((stages) =>
    stages.filter((stage): stage is ProcessingStage => !isRetiredProcessingStage(stage))
  );

export const ProcessingPresetSchema = z.enum([
  "import_only",
  "search_ready",
  "summary",
  "full_knowledge",
  "custom"
]);
export type ProcessingPreset = z.infer<typeof ProcessingPresetSchema>;

export const ProcessingScopeSchema = z.enum([
  "source_only",
  "children_only",
  "source_and_children",
  "selected_items"
]);

export const PreviousArtifactPolicySchema = z.enum([
  "reuse_valid",
  "regenerate_selected",
  "preserve_reviewed_archive_pending"
]);

export const ProcessingPlanRequestSchema = z
  .object({
    preset: ProcessingPresetSchema,
    requestedStages: ProcessingStageListSchema,
    scope: ProcessingScopeSchema.default("source_only"),
    targetSourceItemIds: z.array(StableIdSchema).default([]),
    forceRegeneration: z.boolean().default(false),
    /**
     * Run a second knowledge-graph pass over the atomic notes. Absent means off: one pass over the
     * chunks already yields the entities and relations, and the notes link to them by evidence.
     */
    knowledgeGraphOnNotes: z.boolean().optional(),
    previousArtifactPolicy: PreviousArtifactPolicySchema.default("reuse_valid")
  })
  .strict();

export type ProcessingPlanRequest = z.infer<typeof ProcessingPlanRequestSchema>;

/** Fields of plans stored before F2 D14 (the legacy wiki organization); parsing drops them. */
const retiredPlanFields: readonly string[] = ["integrateWiki", "organization"];

/**
 * The effective plan, as resolved and as stored on batches. A stored plan reads tolerantly: its
 * retired stage IDs and organization fields are dropped, everything else is validated strictly.
 */
export const EffectiveProcessingPlanSchema = z.preprocess(
  (value) =>
    typeof value === "object" && value !== null && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value).filter(([key]) => !retiredPlanFields.includes(key))
        )
      : value,
  ProcessingPlanRequestSchema.extend({
    effectiveStages: ProcessingStageListSchema,
    automaticallyIncludedStages: ProcessingStageListSchema,
    planVersion: z.literal("1")
  }).strict()
);

export type EffectiveProcessingPlan = z.infer<typeof EffectiveProcessingPlanSchema>;

export const processingStageDependencies: Readonly<
  Record<ProcessingStage, readonly ProcessingStage[]>
> = {
  conversion: [],
  structureDetection: ["conversion"],
  structureReview: ["structureDetection"],
  materialization: ["structureReview"],
  chunking: ["materialization"],
  embedding: ["chunking"],
  summarization: ["chunking"],
  atomicNotes: ["chunking"],
  knowledgeGraph: ["chunking"],
  atomicNoteMatching: ["atomicNotes"],
  // Source relations come from the source's decided note pairs (F3 D24, D27).
  sourceMatching: ["summarization", "embedding", "atomicNoteMatching"],
  obsidianProjection: ["materialization"],
  aggregateSummarization: ["summarization"]
};

export const processingPresetStages: Readonly<
  Record<Exclude<ProcessingPreset, "custom">, readonly ProcessingStage[]>
> = {
  import_only: ["conversion", "structureDetection", "structureReview", "materialization"],
  search_ready: [
    "conversion",
    "structureDetection",
    "structureReview",
    "materialization",
    "chunking",
    "embedding"
  ],
  summary: [
    "conversion",
    "structureDetection",
    "structureReview",
    "materialization",
    "chunking",
    "summarization"
  ],
  full_knowledge: [
    "conversion",
    "structureDetection",
    "structureReview",
    "materialization",
    "chunking",
    "embedding",
    "summarization",
    "atomicNotes",
    "knowledgeGraph",
    "atomicNoteMatching",
    "sourceMatching"
  ]
};

/**
 * Default preset for interactive imports and Library processing. Full knowledge needs a generative
 * (writer) route; without one the source is still made searchable with chunks and embeddings, which
 * never calls generative AI. Import-only stays an explicit choice.
 */
export function defaultInteractivePreset(
  writerRouteReady: boolean
): Extract<ProcessingPreset, "full_knowledge" | "search_ready"> {
  return writerRouteReady ? "full_knowledge" : "search_ready";
}

export function resolveProcessingPlan(input: ProcessingPlanRequest): EffectiveProcessingPlan {
  const parsed = ProcessingPlanRequestSchema.parse(input);
  const requested =
    parsed.preset === "custom"
      ? parsed.requestedStages
      : [...processingPresetStages[parsed.preset]];
  const effective = new Set<ProcessingStage>();

  function include(stage: ProcessingStage): void {
    for (const dependency of processingStageDependencies[stage]) include(dependency);
    effective.add(stage);
  }

  for (const stage of requested) include(stage);
  const effectiveStages = ProcessingStages.filter((stage) => effective.has(stage));
  const requestedSet = new Set(requested);
  return EffectiveProcessingPlanSchema.parse({
    ...parsed,
    requestedStages: requested,
    effectiveStages,
    automaticallyIncludedStages: effectiveStages.filter((stage) => !requestedSet.has(stage)),
    planVersion: "1"
  });
}

export interface DivisionValidationIssue {
  code: "cycle" | "missing_parent" | "duplicate_position" | "overlap" | "empty_range";
  divisionIds: string[];
}

export function validateDivisionTree(
  divisions: readonly DocumentDivisionCandidate[]
): DivisionValidationIssue[] {
  const issues: DivisionValidationIssue[] = [];
  const byId = new Map(divisions.map((division) => [division.id, division]));
  const siblingPositions = new Map<string, Map<number, string>>();

  for (const division of divisions) {
    if (division.parentId && !byId.has(division.parentId)) {
      issues.push({ code: "missing_parent", divisionIds: [division.id, division.parentId] });
    }
    const siblingKey = division.parentId ?? "root";
    const positions = siblingPositions.get(siblingKey) ?? new Map<number, string>();
    const duplicate = positions.get(division.position);
    if (duplicate)
      issues.push({ code: "duplicate_position", divisionIds: [duplicate, division.id] });
    positions.set(division.position, division.id);
    siblingPositions.set(siblingKey, positions);

    const visited = new Set<string>([division.id]);
    let parentId = division.parentId;
    while (parentId) {
      if (visited.has(parentId)) {
        issues.push({ code: "cycle", divisionIds: [...visited, parentId] });
        break;
      }
      visited.add(parentId);
      parentId = byId.get(parentId)?.parentId ?? null;
    }
    if (division.markdownStart !== undefined && division.markdownEnd === division.markdownStart) {
      issues.push({ code: "empty_range", divisionIds: [division.id] });
    }
  }

  const processable = divisions
    .filter(
      (division) =>
        division.isProcessable &&
        division.reviewStatus !== "rejected" &&
        division.markdownStart !== undefined &&
        division.markdownEnd !== undefined
    )
    .toSorted((left, right) => left.markdownStart! - right.markdownStart!);
  for (let index = 1; index < processable.length; index += 1) {
    const previous = processable[index - 1];
    const current = processable[index];
    if (previous && current && current.markdownStart! < previous.markdownEnd!) {
      issues.push({ code: "overlap", divisionIds: [previous.id, current.id] });
    }
  }
  return issues;
}
