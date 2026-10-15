import { describe, expect, it } from "vitest";

import {
  EffectiveProcessingPlanSchema,
  ProcessingPlanRequestSchema,
  ProcessingStages,
  RetiredProcessingStages,
  defaultInteractivePreset,
  isRetiredProcessingStage,
  processingPresetStages,
  processingStageDependencies,
  readStoredStageCheckpoint,
  resolveProcessingPlan,
  retiredStageSkipReason,
  validateDivisionTree,
  type DocumentDivisionCandidate
} from "./hierarchical-ingestion.js";

// Shapes stored before F2 D14 took organizeKnowledge out of the DAG: a full-knowledge batch plan
// admitted under a curator policy, a custom plan naming the stage directly with a page title, and
// the checkpoints of a run that was waiting for the batch organization.
const storedFullKnowledgePlan = {
  integrateWiki: {
    version: 2,
    policyId: "11111111-1111-4111-8111-111111111111",
    policyRevisionId: "22222222-2222-4222-8222-222222222222"
  },
  preset: "full_knowledge",
  requestedStages: [
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
    "organizeKnowledge"
  ],
  scope: "source_only",
  targetSourceItemIds: ["33333333-3333-4333-8333-333333333333"],
  forceRegeneration: false,
  previousArtifactPolicy: "reuse_valid",
  effectiveStages: [
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
    "organizeKnowledge"
  ],
  automaticallyIncludedStages: [],
  planVersion: "1"
};
const storedOrganizationPlan = {
  organization: {
    title: "Topic",
    privacy: "allow_remote",
    domainId: null
  },
  preset: "custom",
  requestedStages: ["organizeKnowledge"],
  scope: "selected_items",
  targetSourceItemIds: [],
  forceRegeneration: false,
  previousArtifactPolicy: "reuse_valid",
  effectiveStages: [
    "conversion",
    "structureDetection",
    "structureReview",
    "materialization",
    "chunking",
    "organizeKnowledge"
  ],
  automaticallyIncludedStages: [
    "conversion",
    "structureDetection",
    "structureReview",
    "materialization",
    "chunking"
  ],
  planVersion: "1"
};
const storedRunCheckpoints: Record<string, unknown> = {
  chunking: { status: "completed", metadata: { chunkCount: 4 } },
  sourceMatching: { status: "completed", metadata: { persistedCount: 2 } },
  organizeKnowledge: {
    status: "waiting_for_batch",
    metadata: { organizationRunId: "44444444-4444-4444-8444-444444444444" }
  }
};

describe("the retired organizeKnowledge stage (F2 D14)", () => {
  it("is no longer part of the DAG, any preset or any dependency", () => {
    expect(RetiredProcessingStages).toEqual(["organizeKnowledge"]);
    expect(ProcessingStages).not.toContain("organizeKnowledge");
    expect(Object.keys(processingStageDependencies)).toEqual([...ProcessingStages]);
    for (const stages of Object.values(processingPresetStages))
      expect(stages).not.toContain("organizeKnowledge");
    for (const dependencies of Object.values(processingStageDependencies))
      expect(dependencies).not.toContain("organizeKnowledge");
  });

  it("leaves a full-knowledge plan with every other knowledge stage", () => {
    const plan = resolveProcessingPlan({
      preset: "full_knowledge",
      requestedStages: [],
      scope: "source_only",
      targetSourceItemIds: [],
      forceRegeneration: false,
      previousArtifactPolicy: "reuse_valid"
    });
    expect(plan.effectiveStages).not.toContain("organizeKnowledge");
    expect(plan.effectiveStages).toEqual(
      expect.arrayContaining(["atomicNotes", "knowledgeGraph", "atomicNoteMatching"])
    );
    expect(plan.effectiveStages).toContain("sourceMatching");
    expect(plan).not.toHaveProperty("integrateWiki");
    expect(plan).not.toHaveProperty("organization");
  });

  it("parses stored legacy batch plans, dropping the stage and the organization fields", () => {
    const fullKnowledge = EffectiveProcessingPlanSchema.parse(storedFullKnowledgePlan);
    expect(fullKnowledge.effectiveStages).toEqual(processingPresetStages.full_knowledge);
    expect(fullKnowledge.requestedStages).not.toContain("organizeKnowledge");
    expect(fullKnowledge).not.toHaveProperty("integrateWiki");
    expect(fullKnowledge.targetSourceItemIds).toEqual(storedFullKnowledgePlan.targetSourceItemIds);

    const organization = EffectiveProcessingPlanSchema.parse(storedOrganizationPlan);
    expect(organization.requestedStages).toEqual([]);
    expect(organization.effectiveStages).toEqual([
      "conversion",
      "structureDetection",
      "structureReview",
      "materialization",
      "chunking"
    ]);
    expect(organization).not.toHaveProperty("organization");

    // Tolerance covers only what was retired: other unknown stages and fields still fail.
    expect(
      EffectiveProcessingPlanSchema.safeParse({
        ...storedFullKnowledgePlan,
        effectiveStages: ["integrateTopics"]
      }).success
    ).toBe(false);
    expect(
      EffectiveProcessingPlanSchema.safeParse({ ...storedFullKnowledgePlan, policy: {} }).success
    ).toBe(false);
  });

  it("reads saved stage lists naming the stage and refuses new organization requests", () => {
    // A saved processing preset (app settings) stores only requested stages.
    expect(
      ProcessingPlanRequestSchema.shape.requestedStages.parse(["atomicNotes", "organizeKnowledge"])
    ).toEqual(["atomicNotes"]);
    expect(
      resolveProcessingPlan(
        ProcessingPlanRequestSchema.parse({
          preset: "custom",
          requestedStages: ["organizeKnowledge"]
        })
      ).effectiveStages
    ).toEqual([]);
    // A new request cannot ask for a legacy organization any more.
    for (const field of [
      { integrateWiki: storedFullKnowledgePlan.integrateWiki },
      { organization: storedOrganizationPlan.organization }
    ])
      expect(
        ProcessingPlanRequestSchema.safeParse({
          preset: "full_knowledge",
          requestedStages: [],
          ...field
        }).success
      ).toBe(false);
  });

  it("reads a stored run's checkpoint for the stage as skipped (retired)", () => {
    expect(isRetiredProcessingStage("organizeKnowledge")).toBe(true);
    expect(isRetiredProcessingStage("sourceMatching")).toBe(false);
    expect(isRetiredProcessingStage(undefined)).toBe(false);
    expect(
      readStoredStageCheckpoint("organizeKnowledge", storedRunCheckpoints.organizeKnowledge)
    ).toEqual({ status: "skipped", reason: retiredStageSkipReason });
    expect(readStoredStageCheckpoint("organizeKnowledge", undefined)).toEqual({
      status: "skipped",
      reason: "retired"
    });
    expect(readStoredStageCheckpoint("sourceMatching", storedRunCheckpoints.sourceMatching)).toBe(
      storedRunCheckpoints.sourceMatching
    );
  });
});

describe("hierarchical ingestion", () => {
  it("includes source matching in full knowledge and resolves it without generating notes", () => {
    const input = {
      preset: "custom" as const,
      requestedStages: ["sourceMatching" as const],
      scope: "source_only" as const,
      targetSourceItemIds: [],
      forceRegeneration: false,
      previousArtifactPolicy: "reuse_valid" as const
    };
    const plan = resolveProcessingPlan(input);
    expect(plan.effectiveStages).toContain("summarization");
    expect(plan.effectiveStages).toContain("embedding");
    expect(plan.effectiveStages).not.toContain("atomicNotes");
    expect(plan.effectiveStages).not.toContain("knowledgeGraph");
    expect(
      resolveProcessingPlan({ ...input, preset: "full_knowledge", requestedStages: [] })
        .effectiveStages
    ).toContain("sourceMatching");
  });
  it("resolves presets and automatically includes dependencies", () => {
    const plan = resolveProcessingPlan({
      preset: "custom",
      requestedStages: ["knowledgeGraph"],
      scope: "selected_items",
      targetSourceItemIds: ["11111111-1111-4111-8111-111111111111"],
      forceRegeneration: false,
      previousArtifactPolicy: "reuse_valid"
    });
    expect(plan.effectiveStages).toEqual([
      "conversion",
      "structureDetection",
      "structureReview",
      "materialization",
      "chunking",
      "knowledgeGraph"
    ]);
    expect(plan.automaticallyIncludedStages).toContain("chunking");
    expect(plan.automaticallyIncludedStages).not.toContain("atomicNotes");
  });

  it("runs one knowledge-graph pass per source unless the plan asks for a second one over notes", () => {
    const request = {
      preset: "full_knowledge" as const,
      requestedStages: [],
      scope: "source_only" as const,
      targetSourceItemIds: [],
      forceRegeneration: false,
      previousArtifactPolicy: "reuse_valid" as const
    };
    // Both passes belong to the one knowledgeGraph stage: the plan only chooses the second.
    const byDefault = resolveProcessingPlan(request);
    expect(byDefault.effectiveStages.filter((stage) => stage.startsWith("knowledgeGraph"))).toEqual(
      ["knowledgeGraph"]
    );
    expect(byDefault.knowledgeGraphOnNotes).toBeUndefined();
    expect(ProcessingPlanRequestSchema.parse(request).knowledgeGraphOnNotes).toBeUndefined();
    expect(
      resolveProcessingPlan({ ...request, knowledgeGraphOnNotes: true }).knowledgeGraphOnNotes
    ).toBe(true);
    // Plans stored before the option existed still parse.
    expect(() => EffectiveProcessingPlanSchema.parse(byDefault)).not.toThrow();
    expect(() =>
      ProcessingPlanRequestSchema.parse({ ...request, knowledgeGraphOnNotes: "yes" })
    ).toThrow();
  });

  it("defaults interactive processing to full knowledge only when a writer route is ready", () => {
    const request = (preset: ReturnType<typeof defaultInteractivePreset>) =>
      resolveProcessingPlan({
        preset,
        requestedStages: [],
        scope: "source_only",
        targetSourceItemIds: [],
        forceRegeneration: false,
        previousArtifactPolicy: "reuse_valid"
      }).effectiveStages;
    expect(defaultInteractivePreset(true)).toBe("full_knowledge");
    expect(request(defaultInteractivePreset(true))).toEqual(
      expect.arrayContaining(["atomicNotes", "knowledgeGraph", "sourceMatching"])
    );
    expect(defaultInteractivePreset(false)).toBe("search_ready");
    const searchable = request(defaultInteractivePreset(false));
    expect(searchable).toEqual(expect.arrayContaining(["chunking", "embedding"]));
    for (const generative of [
      "summarization",
      "atomicNotes",
      "knowledgeGraph",
      "atomicNoteMatching",
      "sourceMatching",
      "organizeKnowledge"
    ] as const)
      expect(searchable).not.toContain(generative);
  });
  it("keeps import-only free from AI stages", () => {
    const plan = resolveProcessingPlan({
      preset: "import_only",
      requestedStages: [],
      scope: "source_only",
      targetSourceItemIds: [],
      forceRegeneration: false,
      previousArtifactPolicy: "reuse_valid"
    });
    expect(plan.effectiveStages).not.toContain("embedding");
    expect(plan.effectiveStages).not.toContain("summarization");
    expect(plan.effectiveStages).not.toContain("atomicNotes");
  });

  it("reports overlaps without rejecting adjacent divisions", () => {
    const base = {
      parentId: null,
      kind: "chapter",
      level: 0,
      startSelector: {},
      endSelector: {},
      confidence: 0.9,
      evidence: [],
      reviewStatus: "accepted",
      isProcessable: true,
      metadata: {}
    } as const;
    const divisions: DocumentDivisionCandidate[] = [
      {
        ...base,
        id: "11111111-1111-4111-8111-111111111111",
        title: "One",
        position: 0,
        markdownStart: 0,
        markdownEnd: 10
      },
      {
        ...base,
        id: "22222222-2222-4222-8222-222222222222",
        title: "Two",
        position: 1,
        markdownStart: 9,
        markdownEnd: 20
      },
      {
        ...base,
        id: "33333333-3333-4333-8333-333333333333",
        title: "Three",
        position: 2,
        markdownStart: 20,
        markdownEnd: 30
      }
    ];
    expect(validateDivisionTree(divisions)).toEqual([
      { code: "overlap", divisionIds: [divisions[0]!.id, divisions[1]!.id] }
    ]);
  });
});
