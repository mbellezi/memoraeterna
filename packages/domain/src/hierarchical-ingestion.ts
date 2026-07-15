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

export const DivisionEvidenceSchema = z.object({
  kind: z.string().min(1),
  source: z.string().min(1),
  score: z.number().min(0).max(1),
  metadata: OptionalMetadataSchema
}).strict();

export const DocumentDivisionCandidateSchema = z.object({
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
}).strict().superRefine((division, context) => {
  if (division.endPage !== undefined && division.startPage !== undefined && division.endPage < division.startPage) {
    context.addIssue({ code: "custom", message: "endPage must not precede startPage", path: ["endPage"] });
  }
  if (division.markdownEnd !== undefined && division.markdownStart !== undefined
      && division.markdownEnd < division.markdownStart) {
    context.addIssue({ code: "custom", message: "markdownEnd must not precede markdownStart", path: ["markdownEnd"] });
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

export const DocumentStructureDraftSchema = z.object({
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
}).strict();

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
  "obsidianProjection",
  "aggregateSummarization"
] as const;

export const ProcessingStageSchema = z.enum(ProcessingStages);
export type ProcessingStage = z.infer<typeof ProcessingStageSchema>;

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

export const ProcessingPlanRequestSchema = z.object({
  preset: ProcessingPresetSchema,
  requestedStages: z.array(ProcessingStageSchema),
  scope: ProcessingScopeSchema.default("source_only"),
  targetSourceItemIds: z.array(StableIdSchema).default([]),
  forceRegeneration: z.boolean().default(false),
  previousArtifactPolicy: PreviousArtifactPolicySchema.default("reuse_valid")
}).strict();

export type ProcessingPlanRequest = z.infer<typeof ProcessingPlanRequestSchema>;

export const EffectiveProcessingPlanSchema = ProcessingPlanRequestSchema.extend({
  effectiveStages: z.array(ProcessingStageSchema),
  automaticallyIncludedStages: z.array(ProcessingStageSchema),
  planVersion: z.literal("1")
}).strict();

export type EffectiveProcessingPlan = z.infer<typeof EffectiveProcessingPlanSchema>;

export const processingStageDependencies: Readonly<Record<ProcessingStage, readonly ProcessingStage[]>> = {
  conversion: [],
  structureDetection: ["conversion"],
  structureReview: ["structureDetection"],
  materialization: ["structureReview"],
  chunking: ["materialization"],
  embedding: ["chunking"],
  summarization: ["chunking"],
  atomicNotes: ["chunking"],
  knowledgeGraph: ["atomicNotes"],
  atomicNoteMatching: ["atomicNotes"],
  obsidianProjection: ["materialization"],
  aggregateSummarization: ["summarization"]
};

export const processingPresetStages: Readonly<Record<Exclude<ProcessingPreset, "custom">, readonly ProcessingStage[]>> = {
  import_only: ["conversion", "structureDetection", "structureReview", "materialization"],
  search_ready: ["conversion", "structureDetection", "structureReview", "materialization", "chunking", "embedding"],
  summary: ["conversion", "structureDetection", "structureReview", "materialization", "chunking", "summarization"],
  full_knowledge: [
    "conversion", "structureDetection", "structureReview", "materialization", "chunking", "embedding",
    "summarization", "atomicNotes", "knowledgeGraph", "atomicNoteMatching"
  ]
};

export function resolveProcessingPlan(input: ProcessingPlanRequest): EffectiveProcessingPlan {
  const parsed = ProcessingPlanRequestSchema.parse(input);
  const requested = parsed.preset === "custom"
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

export function validateDivisionTree(divisions: readonly DocumentDivisionCandidate[]): DivisionValidationIssue[] {
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
    if (duplicate) issues.push({ code: "duplicate_position", divisionIds: [duplicate, division.id] });
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
    .filter((division) => division.isProcessable && division.reviewStatus !== "rejected"
      && division.markdownStart !== undefined && division.markdownEnd !== undefined)
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
