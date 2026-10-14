import { describe, expect, it } from "vitest";
import { automaticWikiVersion, initialCuratorLimits } from "./automatic-wiki.js";
import {
  CuratorSnapshotSchema,
  CuratorCheckpointSchema,
  curatorVersion
} from "./automatic-wiki-runtime.js";
import { WikiPageContentSchema } from "./wiki.js";
import {
  HierarchyAncestorSchema,
  HierarchyChangeSetSchema,
  HierarchyLimitsSchema,
  HierarchyPageTargetSchema,
  HierarchyPlacementInventorySchema,
  HierarchyPolicySchema,
  HierarchyRouteContinuationSchema,
  automaticWikiHierarchyVersion,
  countHierarchyChanges,
  hierarchyResourceDecision,
  validateHierarchyAdmission
} from "./wiki-hierarchy.js";
import {
  HierarchyDraftSchema,
  HierarchySnapshotSchema,
  HierarchySupportSnapshotSchema,
  HierarchyCuratorRunSchema,
  hasCompleteHierarchySupport,
  hierarchyChangedHandles,
  hierarchyCuratorVersion,
  hierarchyDraftVersion
} from "./wiki-hierarchy-runtime.js";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const proposed = (handle: string) => ({ reference: "proposed" as const, handle });
const existing = (n: number) => ({
  reference: "existing" as const,
  target: { kind: "page" as const, id: id(n) },
  expectedRevisionId: id(n + 100),
  fingerprint: `page-${n}`
});
const topic = (handle: string) =>
  HierarchyPageTargetSchema.parse({
    handle,
    pageId: null,
    expectedRevisionId: null,
    title: handle,
    purpose: "Organize the admitted findings",
    role: { kind: "topic", role: "topic" },
    initialParent: null,
    sections: [],
    links: [],
    tocGroups: []
  });
const ancestor = (handle: string, parent: string | null = null) =>
  HierarchyAncestorSchema.parse({
    handle,
    title: handle,
    purpose: "Required thematic navigation",
    role: { kind: "topic", role: "topic" },
    initialParent: parent ? proposed(parent) : null
  });
const change = (targets = [topic("new_leaf")], ancestors: ReturnType<typeof ancestor>[] = []) =>
  HierarchyChangeSetSchema.parse({
    version: automaticWikiHierarchyVersion,
    groupId: id(1),
    policyRevisionId: id(2),
    explanation: "Group current findings",
    targets,
    ancestors,
    moves: []
  });
const policy = (targets = 3) =>
  HierarchyPolicySchema.parse({
    version: automaticWikiHierarchyVersion,
    id: id(1),
    revisionId: id(2),
    state: "enabled",
    scope: {
      wholeLibrary: true,
      sourceIds: [],
      includeDescendants: true,
      excludedSourceIds: [],
      domainId: null
    },
    triggers: ["input_changed"],
    operations: [
      "create_grounded",
      "initial_placement",
      "update_unprotected",
      "repair_navigation",
      "reviewed_reparent",
      "use_scoped_destinations"
    ],
    profileOverrideId: null,
    limits: { ...initialCuratorLimits, targets },
    allowancePreset: null
  });
const page = (n: number, parentId: string | null = null) => ({
  pageId: id(n),
  revisionId: id(n + 100),
  fingerprint: `page-${n}`,
  title: `Page ${n}`,
  purpose: "Navigation",
  role: { kind: "topic" as const, role: "topic" as const },
  parentId,
  archived: false,
  placementProtected: false,
  canEdit: true,
  canReceiveChildren: true,
  sourceIds: [],
  subtopicIds: [],
  descendantCount: 0,
  membershipCount: 0
});
const inventory = (pages: unknown[] = []) =>
  HierarchyPlacementInventorySchema.parse({
    version: automaticWikiHierarchyVersion,
    fingerprint: "branch",
    scopeFingerprint: "scope",
    pages,
    nextCursor: null
  });
const map = (handle: string) => ({
  ...topic(handle),
  role: { kind: "collection" as const, role: "map" as const, owner: null }
});
const subtopic = (handle: string, target: string) => ({
  handle,
  id: null,
  expectedRevisionId: null,
  title: "Read next",
  explanation: null,
  originalHandles: [],
  memberships: [{ id: null, target: proposed(target), purpose: "subtopic" as const, order: 0 }]
});
const move = (n: number, handle = "new_moved") => ({
  handle,
  operation: "reviewed_reparent" as const,
  pageId: id(n),
  expectedRevisionId: id(n + 100),
  fromParent: null,
  toParent: existing(20),
  reason: "Place under the relevant topic"
});

describe("current hierarchy contracts", () => {
  it("admits six targets and enforces the exact configured allowance", () => {
    const proposal = change(Array.from({ length: 6 }, (_, n) => topic(`new_topic_${n}`)));
    expect(validateHierarchyAdmission(proposal, policy(6), inventory(), []).valid).toBe(true);
    expect(validateHierarchyAdmission(proposal, policy(5), inventory(), []).issues).toContain(
      "Configured work target limit exceeded"
    );
    const { targets: _, ...limits } = initialCuratorLimits;
    expect(HierarchyLimitsSchema.parse(limits).targets).toBe(3);
    for (const targets of [0, 13, 1.5])
      expect(HierarchyLimitsSchema.safeParse({ ...limits, targets }).success).toBe(false);
  });
  it("keeps two targets with an arbitrarily deep shared exempt path in one group", () => {
    const path = Array.from({ length: 160 }, (_, n) =>
      ancestor(`new_path_${n}`, n ? `new_path_${n - 1}` : null)
    );
    const leaf = { ...topic("new_leaf"), initialParent: proposed("new_path_159") };
    const toc = {
      ...map("new_toc"),
      initialParent: proposed("new_leaf"),
      role: { kind: "collection" as const, role: "topic_toc" as const, owner: proposed("new_leaf") }
    };
    const proposal = change([leaf, toc], path);
    expect(countHierarchyChanges(proposal)).toEqual({
      workTargets: 2,
      structuralAncestors: 160,
      changedPages: 162
    });
    expect(validateHierarchyAdmission(proposal, policy(2), inventory(), []).valid).toBe(true);
    expect(hierarchyResourceDecision(proposal, 1).decision).toBe("continue");
    expect(hierarchyResourceDecision(proposal, 1_000_000).decision).toBe("fits");
    expect(
      hasCompleteHierarchySupport(proposal, {
        supported: true,
        checkedTargets: ["new_leaf", "new_toc"],
        issues: []
      })
    ).toBe(false);
    expect(
      hasCompleteHierarchySupport(proposal, {
        supported: true,
        checkedTargets: hierarchyChangedHandles(proposal),
        issues: []
      })
    ).toBe(true);
  });
  it("rejects detached ancestors and all hidden content, bindings and existing edits", () => {
    const base = change();
    expect(
      HierarchyChangeSetSchema.safeParse({ ...base, ancestors: [ancestor("new_detached")] }).success
    ).toBe(false);
    for (const forbidden of [
      { sections: [] },
      { links: [] },
      { tocGroups: [] },
      { pageId: id(4) },
      { entityId: id(4) }
    ])
      expect(
        HierarchyAncestorSchema.safeParse({ ...ancestor("new_path"), ...forbidden }).success
      ).toBe(false);
    expect(
      HierarchyAncestorSchema.safeParse({
        ...ancestor("new_path"),
        role: { kind: "entity", role: "entity", entityId: id(4) }
      }).success
    ).toBe(false);
    expect(
      HierarchyAncestorSchema.safeParse({
        ...ancestor("new_path"),
        role: { kind: "collection", role: "source_toc", owner: { kind: "source", id: id(4) } }
      }).success
    ).toBe(false);
    expect(
      HierarchyChangeSetSchema.safeParse({
        ...base,
        targets: [{ ...topic("new_leaf"), initialParent: proposed("new_path") }],
        ancestors: [ancestor("new_path"), ancestor("new_path")]
      }).success
    ).toBe(false);
  });
  it("rejects missing references and composed ancestor/target/move cycles", () => {
    const base = change();
    expect(
      HierarchyChangeSetSchema.safeParse({
        ...base,
        targets: [{ ...topic("new_leaf"), initialParent: proposed("new_missing") }]
      }).success
    ).toBe(false);
    expect(
      HierarchyChangeSetSchema.safeParse({
        ...base,
        targets: [{ ...topic("new_leaf"), initialParent: proposed("new_path") }],
        ancestors: [ancestor("new_path", "new_leaf")]
      }).success
    ).toBe(false);
    const moved = { ...move(10), toParent: proposed("new_leaf") };
    expect(
      HierarchyChangeSetSchema.safeParse({
        ...base,
        targets: [{ ...topic("new_leaf"), initialParent: existing(10) }],
        moves: [moved]
      }).success
    ).toBe(false);
    const proposal = HierarchyChangeSetSchema.parse({ ...base, targets: [], moves: [move(10)] });
    expect(
      validateHierarchyAdmission(proposal, policy(), inventory([page(10), page(20, id(10))]), [])
        .issues
    ).toContain("Composed canonical parent cycle");
  });
  it("counts a target and its move once while requiring shared identity and revision", () => {
    const target = { ...topic("new_moved"), pageId: id(10), expectedRevisionId: id(110) };
    const proposal = HierarchyChangeSetSchema.parse({ ...change([target]), moves: [move(10)] });
    expect(countHierarchyChanges(proposal).workTargets).toBe(1);
    const admitted = validateHierarchyAdmission(
      proposal,
      policy(1),
      inventory([page(10), page(20)]),
      []
    );
    expect(admitted.valid).toBe(true);
    expect(admitted.requiresHumanReview).toBe(true);
    expect(
      HierarchyChangeSetSchema.safeParse({
        ...proposal,
        moves: [{ ...move(10), expectedRevisionId: id(999) }]
      }).success
    ).toBe(false);
    expect(
      HierarchyChangeSetSchema.safeParse({
        ...proposal,
        moves: [{ ...move(10), handle: "new_alias" }]
      }).success
    ).toBe(false);
    expect(
      HierarchyChangeSetSchema.safeParse({
        ...proposal,
        targets: [{ ...target, initialParent: existing(20) }]
      }).success
    ).toBe(false);
  });
  it("requires grants, exact destinations and current source-parent metadata", () => {
    const proposal = HierarchyChangeSetSchema.parse({
      ...change(),
      targets: [],
      moves: [move(10)]
    });
    const pages = inventory([page(10), { ...page(20), placementProtected: true, canEdit: false }]);
    expect(validateHierarchyAdmission(proposal, policy(), pages, []).valid).toBe(true);
    for (const grant of ["reviewed_reparent", "use_scoped_destinations"])
      expect(
        validateHierarchyAdmission(
          proposal,
          { ...policy(), operations: policy().operations.filter((o) => o !== grant) },
          pages,
          []
        ).valid
      ).toBe(false);
    expect(
      validateHierarchyAdmission(
        proposal,
        policy(),
        inventory([page(10), { ...page(20), revisionId: id(999) }]),
        []
      ).valid
    ).toBe(false);
    expect(
      validateHierarchyAdmission(
        proposal,
        policy(),
        inventory([page(10, id(30)), page(20), page(30)]),
        []
      ).valid
    ).toBe(false);
    expect(
      validateHierarchyAdmission(proposal, { ...policy(), state: "paused" }, pages, []).valid
    ).toBe(false);
  });
  it("requires grounded creation for new targets and exempt ancestors", () => {
    const withoutCreation = {
      ...policy(),
      operations: policy().operations.filter((o) => o !== "create_grounded")
    };
    expect(validateHierarchyAdmission(change(), withoutCreation, inventory(), []).issues).toContain(
      "Grounded creation capability required"
    );
    const ancestorOnlyContent = HierarchyChangeSetSchema.parse({
      ...change(),
      targets: [],
      ancestors: [ancestor("new_path")],
      moves: [{ ...move(10), toParent: proposed("new_path") }]
    });
    expect(
      validateHierarchyAdmission(ancestorOnlyContent, policy(), inventory([page(10)]), []).valid
    ).toBe(true);
    expect(
      validateHierarchyAdmission(ancestorOnlyContent, withoutCreation, inventory([page(10)]), [])
        .issues
    ).toContain("Grounded creation capability required");
  });
  it("requires update and navigation grants for the corresponding target patches", () => {
    const existingTarget = {
      ...topic("new_patch"),
      pageId: id(10),
      expectedRevisionId: id(110),
      sections: [
        {
          sectionId: null,
          expectedSectionRevisionId: null,
          title: "Finding",
          markdown: "Attributed finding",
          originalHandles: ["e1"]
        }
      ]
    };
    const patch = change([existingTarget]);
    expect(validateHierarchyAdmission(patch, policy(), inventory([page(10)]), []).valid).toBe(true);
    const withoutUpdates = {
      ...policy(),
      operations: policy().operations.filter((o) => o !== "update_unprotected")
    };
    expect(
      validateHierarchyAdmission(patch, withoutUpdates, inventory([page(10)]), []).issues
    ).toContain("Unprotected update capability required");
    const navigation = change([
      { ...map("new_outer"), tocGroups: [subtopic("new_group", "new_inner")] },
      map("new_inner")
    ]);
    expect(validateHierarchyAdmission(navigation, policy(), inventory(), []).valid).toBe(true);
    const withoutNavigation = {
      ...policy(),
      operations: policy().operations.filter((o) => o !== "repair_navigation")
    };
    expect(
      validateHierarchyAdmission(navigation, withoutNavigation, inventory(), []).issues
    ).toContain("Navigation repair capability required");
  });
  it("admits moves-only work with its structural grants and no content grants", () => {
    const proposal = HierarchyChangeSetSchema.parse({
      ...change(),
      targets: [],
      moves: [move(10)]
    });
    const movePolicy = {
      ...policy(),
      operations: ["reviewed_reparent", "use_scoped_destinations"]
    };
    expect(
      validateHierarchyAdmission(proposal, movePolicy, inventory([page(10), page(20)]), []).valid
    ).toBe(true);
    expect(
      validateHierarchyAdmission(
        proposal,
        { ...movePolicy, operations: ["use_scoped_destinations"] },
        inventory([page(10), page(20)]),
        []
      ).issues
    ).toContain("Reviewed reparent capability required");
  });
  it("models nested TOCs with separate owners and detects hierarchical cycles", () => {
    const outer = { ...map("new_outer"), tocGroups: [subtopic("new_group_a", "new_inner")] };
    const inner = { ...map("new_inner"), initialParent: proposed("new_outer") };
    expect(change([outer, inner]).targets).toHaveLength(2);
    const cyclic = { ...inner, tocGroups: [subtopic("new_group_b", "new_outer")] };
    expect(
      HierarchyChangeSetSchema.safeParse({ ...change(), targets: [outer, cyclic] }).success
    ).toBe(false);
    // Additional related links may be cyclic without becoming hierarchy.
    expect(
      change([
        { ...outer, links: [proposed("new_inner")] },
        { ...inner, links: [proposed("new_outer")] }
      ]).targets
    ).toHaveLength(2);
  });
  it("binds entity pages by admitted canonical ID and rejects duplicate representations", () => {
    const entity = {
      ...topic("new_entity"),
      role: { kind: "entity" as const, role: "entity" as const, entityId: id(80) }
    };
    const proposal = change([entity]);
    expect(validateHierarchyAdmission(proposal, policy(), inventory(), []).valid).toBe(false);
    const refs = [{ kind: "entity", id: id(80), fingerprint: "entity-r1" }];
    expect(validateHierarchyAdmission(proposal, policy(), inventory(), refs).valid).toBe(true);
    expect(
      validateHierarchyAdmission(
        proposal,
        policy(),
        inventory([{ ...page(40), role: entity.role }]),
        refs
      ).valid
    ).toBe(false);
    expect(
      HierarchyChangeSetSchema.safeParse({
        ...proposal,
        targets: [entity, { ...entity, handle: "new_duplicate" }]
      }).success
    ).toBe(false);
    const homonym = {
      ...entity,
      handle: "new_homonym",
      role: { ...entity.role, entityId: id(81) }
    };
    expect(change([entity, homonym]).targets).toHaveLength(2);
  });
  it("freezes scoped inventory and requests additional discovery for incomplete ancestry", () => {
    const saved = inventory([page(20, id(30))]);
    expect(Object.isFrozen(saved)).toBe(true);
    expect(Object.isFrozen(saved.pages[0]!.role)).toBe(true);
    const proposal = change([{ ...topic("new_leaf"), initialParent: existing(20) }]);
    expect(validateHierarchyAdmission(proposal, policy(), saved, []).issues).toContain(
      "Incomplete ancestry: continue placement discovery"
    );
  });
  it("keeps minimal topics canonical with zero authored sections", () => {
    expect(
      WikiPageContentSchema.safeParse({ title: "Science", kind: "topic", sections: [] }).success
    ).toBe(true);
    const draft = {
      explanation: "Organize",
      topics: [
        {
          handle: "new_leaf",
          title: "Leaf",
          purpose: "Navigation",
          initialParent: "new_path",
          sections: [],
          links: []
        }
      ],
      indexes: [],
      entities: [],
      ancestors: [{ ...ancestor("new_path"), initialParent: null }],
      moves: []
    };
    expect(HierarchyDraftSchema.safeParse(draft).success).toBe(true);
    expect(
      HierarchyDraftSchema.safeParse({
        ...draft,
        entities: [{ ...draft.topics[0], handle: "new_entity", entity: "University of Coimbra" }]
      }).success
    ).toBe(false);
    expect(
      HierarchyDraftSchema.safeParse({
        ...draft,
        entities: [
          {
            ...draft.topics[0],
            handle: "new_entity",
            entity: "r1",
            sections: [
              {
                id: null,
                title: "Evidence",
                markdown: "Attributed finding",
                originalHandles: ["e1"]
              }
            ]
          }
        ]
      }).success
    ).toBe(true);
  });
  it("requires grounded sections for new entities while preserving existing entity patches", () => {
    const entity = {
      handle: "new_entity",
      title: "Known organization",
      purpose: "Read original mentions",
      initialParent: null,
      entity: "r1",
      sections: [],
      links: []
    };
    const draft = {
      explanation: "Organize canonical mentions",
      topics: [],
      indexes: [],
      entities: [entity],
      ancestors: [],
      moves: []
    };
    for (const handle of ["new_entity", "Known organization"]) {
      const result = HierarchyDraftSchema.safeParse({
        ...draft,
        entities: [{ ...entity, handle }]
      });
      expect(result.success).toBe(false);
      if (!result.success)
        expect(result.error.issues).toContainEqual(
          expect.objectContaining({
            path: ["entities", 0, "sections"],
            message: expect.stringContaining("at least one grounded section with originalHandles")
          })
        );
    }
    expect(
      HierarchyDraftSchema.safeParse({
        ...draft,
        entities: [{ ...entity, handle: "r2", links: ["r3"] }]
      }).success
    ).toBe(true);
    expect(
      HierarchyDraftSchema.safeParse({
        ...draft,
        entities: [
          {
            ...entity,
            sections: [
              {
                id: null,
                title: "Mention",
                markdown: "The source names the organization [e1].",
                originalHandles: ["e1"]
              }
            ]
          }
        ]
      }).success
    ).toBe(true);
    expect(
      HierarchyDraftSchema.safeParse({
        ...draft,
        entities: [
          {
            ...entity,
            sections: [{ id: null, title: "Mention", markdown: "Unsupported", originalHandles: [] }]
          }
        ]
      }).success
    ).toBe(false);
  });
  it("reports distinct entity page handles and exact existing-parent fields", () => {
    const section = {
      id: null,
      title: "Mention",
      markdown: "Attributed mention [e1]",
      originalHandles: ["e1"]
    };
    const draft = {
      explanation: "Place canonical pages",
      topics: [
        {
          handle: "r1",
          title: "Topic",
          purpose: "Retain",
          initialParent: "r9",
          sections: [],
          links: []
        }
      ],
      indexes: [
        {
          handle: "r2",
          title: "Reading",
          purpose: "Read",
          initialParent: "r9",
          owner: { map: true },
          groups: [
            {
              id: null,
              title: "Sources",
              explanation: null,
              originalHandles: [],
              targets: [{ target: "r8", purpose: "source" }]
            }
          ]
        }
      ],
      entities: ["r4", "r5"].map((handle) => ({
        handle,
        entity: handle,
        title: "Organization",
        purpose: "Read mentions",
        initialParent: "r9",
        sections: [section],
        links: []
      })),
      ancestors: [],
      moves: []
    };
    const result = HierarchyDraftSchema.safeParse(draft);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues
          .filter((i) => i.path.at(-1) === "initialParent")
          .map((i) => i.path.join("."))
      ).toEqual(["topics.0.initialParent", "indexes.0.initialParent"]);
      expect(
        result.error.issues.filter((i) => i.path.at(-1) === "handle").map((i) => i.path.join("."))
      ).toEqual(["entities.0.handle", "entities.1.handle"]);
      expect(result.error.issues.find((i) => i.path.at(-1) === "initialParent")!.message).toContain(
        "even for an unchanged parent"
      );
    }
    const corrected = {
      ...draft,
      topics: draft.topics.map((t) => ({ ...t, initialParent: null })),
      indexes: draft.indexes.map((t) => ({ ...t, initialParent: null })),
      entities: draft.entities.map((t, i) => ({ ...t, handle: "new_entity_" + i }))
    };
    expect(HierarchyDraftSchema.safeParse(corrected).success).toBe(true);
    const existingEntities = HierarchyDraftSchema.safeParse({
      ...corrected,
      entities: draft.entities.map((t, i) => ({ ...t, handle: "r" + (i + 6) }))
    });
    expect(existingEntities.success).toBe(false);
    if (!existingEntities.success)
      expect(existingEntities.error.issues.map((i) => i.path.join("."))).toEqual([
        "entities.0.initialParent",
        "entities.1.initialParent"
      ]);
    const objectBinding = HierarchyDraftSchema.safeParse({
      ...corrected,
      entities: [{ ...corrected.entities[0], entity: { canonical: "r4" } }]
    });
    expect(objectBinding.success).toBe(false);
    if (!objectBinding.success)
      expect(objectBinding.error.issues).toContainEqual(
        expect.objectContaining({
          path: ["entities", 0, "entity"],
          message: expect.stringContaining("string, not an object")
        })
      );
  });
  it("uses the complete shared support snapshot for ancestors as well as targets", () => {
    const proposal = change(
      [{ ...topic("new_leaf"), initialParent: proposed("new_path") }],
      [ancestor("new_path")]
    );
    const support = {
      version: hierarchyCuratorVersion,
      proposalHash: "exact-proposal",
      proposal,
      originals: [
        {
          handle: "e1",
          chunkId: id(4),
          sourceItemId: id(5),
          documentId: id(6),
          sourceSpanId: null,
          contentHash: "original",
          excerpt: "Complete original",
          sourceTitle: "Study",
          documentCreatedAt: "2026-09-14",
          locator: null
        }
      ],
      associations: hierarchyChangedHandles(proposal).map((handle) => ({
        handle,
        originalHandles: ["e1"]
      }))
    };
    expect(HierarchySupportSnapshotSchema.safeParse(support).success).toBe(true);
    expect(
      HierarchySupportSnapshotSchema.safeParse({
        ...support,
        associations: support.associations.slice(0, 1)
      }).success
    ).toBe(false);
    expect(
      HierarchySupportSnapshotSchema.safeParse({
        ...support,
        associations: support.associations.map((a) => ({ ...a, originalHandles: ["e2"] }))
      }).success
    ).toBe(false);
  });
  it("keeps the existing current markers without version union readers", () => {
    expect(automaticWikiHierarchyVersion).toBe(automaticWikiVersion);
    expect(hierarchyCuratorVersion).toBe(curatorVersion);
  });
  it("reads the hierarchy runtime and rejects incomplete snapshots and widened effective limits", () => {
    const oldPolicy = {
      ...policy(),
      version: automaticWikiVersion,
      operations: ["create_grounded"]
    };
    const snapshot = CuratorSnapshotSchema.parse({
      version: curatorVersion,
      policy: oldPolicy,
      sourceIds: [],
      supportCompositionHash: "a".repeat(64),
      placement: inventory(),
      resources: { maxInventoryBytes: 100000, maxProposalBytes: 100000 },
      profile: {
        profileId: id(20),
        providerConfigId: null,
        localModelId: null,
        provider: "synthetic",
        modelId: "synthetic",
        runtime: "remote",
        revision: null,
        privacy: "allow_remote",
        parameters: {},
        identityHash: "synthetic",
        contextWindow: 16384
      },
      promptPin: { version: "prompt-catalog-v1", entries: [], domainId: null },
      contentLanguage: "en",
      evidence: [],
      references: [],
      pages: [],
      inputFingerprint: "input",
      groupId: id(1),
      outputTokens: 2048,
      limits: initialCuratorLimits,
      admittedAt: "2026-09-14T00:00:00Z"
    });
    const checkpoint = CuratorCheckpointSchema.parse({
      version: curatorVersion,
      calls: 0,
      tools: 0,
      repairs: 0,
      startedAt: "2026-09-14T00:00:00Z",
      callPending: false,
      waitingForModel: false,
      proposal: null,
      previousOutput: "",
      error: null,
      reportedInputTokens: 0,
      reportedOutputTokens: 0,
      costEstimate: 0,
      usageCounts: { input: 0, output: 0, cost: 0 },
      usageIncomplete: false
    });
    const oldRun = {
      id: id(10),
      jobId: null,
      status: "queued",
      snapshot,
      checkpoint,
      proposal: null,
      receiptRevisionId: null,
      createdAt: "now",
      updatedAt: "now"
    };
    const successor = {
      ...oldRun,
      snapshot: {
        ...snapshot,
        version: hierarchyCuratorVersion,
        policy: policy(6),
        limits: policy(6).limits,
        requiredPageIds: Array.from({ length: 6 }, (_, n) => id(n + 20)),
        supportCompositionHash: "a".repeat(64),
        placement: inventory(),
        resources: { maxInventoryBytes: 100000, maxProposalBytes: 100000 }
      },
      checkpoint: { ...checkpoint, version: hierarchyCuratorVersion, hierarchy: null }
    };
    expect(HierarchyCuratorRunSchema.safeParse(successor).success).toBe(true);
    expect(HierarchyCuratorRunSchema.safeParse({ ...successor, checkpoint }).success).toBe(true);
    expect(
      HierarchyCuratorRunSchema.safeParse({
        ...successor,
        snapshot: { ...snapshot, placement: undefined }
      }).success
    ).toBe(false);
    expect(
      HierarchySnapshotSchema.safeParse({ ...successor.snapshot, limits: policy(5).limits }).success
    ).toBe(false);
    expect(
      HierarchySnapshotSchema.safeParse({ ...successor.snapshot, limits: policy(7).limits }).success
    ).toBe(false);
  });
  it("retains pending deep route work without a depth cap or premature completion", () => {
    const route = {
      version: automaticWikiHierarchyVersion,
      routeId: id(1),
      fingerprint: {
        version: automaticWikiHierarchyVersion,
        branchFingerprint: "branch",
        scopeFingerprint: "scope",
        policyRevisionId: id(2),
        promptFingerprint: "prompt",
        modelFingerprint: "model"
      },
      state: "partial",
      intendedTargets: [
        {
          key: "new_leaf",
          title: "Leaf",
          purpose: "Findings",
          role: { kind: "topic", role: "topic" },
          initialParent: proposed("new_path_159"),
          resolvedPageId: null
        }
      ],
      remainingPath: Array.from({ length: 160 }, (_, n) => ({
        key: `new_path_${n}`,
        title: `Path ${n}`,
        purpose: "Navigation",
        role: { kind: "topic", role: "topic" },
        initialParent: n ? proposed(`new_path_${n - 1}`) : null,
        chunkIds: [id(50)]
      })),
      resolvedPrefix: [],
      reason: "context",
      completedGroupIds: [],
      currentChildRunId: null
    };
    const admittedRoute = HierarchyRouteContinuationSchema.parse(route);
    expect(HierarchyRouteContinuationSchema.safeParse(route).success).toBe(true);
    const ancestors = admittedRoute.remainingPath.slice(0, 2).map((segment, index) =>
      HierarchyAncestorSchema.parse({
        handle: segment.key,
        title: segment.title,
        purpose: segment.purpose,
        role: segment.role,
        initialParent: index ? proposed(admittedRoute.remainingPath[index - 1]!.key) : null
      })
    );
    const prefix = HierarchyChangeSetSchema.parse({
      ...change(),
      targets: [],
      ancestors,
      continuation: {
        routeId: admittedRoute.routeId,
        fingerprint: admittedRoute.fingerprint,
        intendedTargetKeys: ["new_leaf"],
        nextParents: [proposed("new_path_1")]
      }
    });
    expect(countHierarchyChanges(prefix)).toEqual({
      workTargets: 0,
      structuralAncestors: 2,
      changedPages: 2
    });
    expect(
      validateHierarchyAdmission(prefix, policy(1), inventory(), [], admittedRoute).valid
    ).toBe(true);
    expect(validateHierarchyAdmission(prefix, policy(1), inventory(), []).valid).toBe(false);
    expect(
      validateHierarchyAdmission(prefix, policy(1), inventory(), [], {
        ...admittedRoute,
        routeId: id(999)
      }).valid
    ).toBe(false);
    expect(
      validateHierarchyAdmission(prefix, policy(1), inventory(), [], {
        ...admittedRoute,
        fingerprint: { ...admittedRoute.fingerprint, promptFingerprint: "changed" }
      }).valid
    ).toBe(false);
    expect(
      validateHierarchyAdmission(
        {
          ...prefix,
          continuation: { ...prefix.continuation, intendedTargetKeys: ["new_invented"] }
        },
        policy(1),
        inventory(),
        [],
        admittedRoute
      ).valid
    ).toBe(false);
    expect(
      validateHierarchyAdmission(
        { ...prefix, ancestors: ancestors.map((a) => ({ ...a, title: "Invented category" })) },
        policy(1),
        inventory(),
        [],
        admittedRoute
      ).valid
    ).toBe(false);
    expect(HierarchyChangeSetSchema.safeParse({ ...prefix, continuation: undefined }).success).toBe(
      false
    );
    expect(
      hasCompleteHierarchySupport(prefix, {
        supported: true,
        checkedTargets: ["new_path_0"],
        issues: []
      })
    ).toBe(false);
    expect(
      hasCompleteHierarchySupport(prefix, {
        supported: true,
        checkedTargets: ["new_path_0", "new_path_1"],
        issues: []
      })
    ).toBe(true);
    // A later chunk starts from the exact canonical prefix, never an earlier group's handle.
    const laterRoute = HierarchyRouteContinuationSchema.parse({
      ...admittedRoute,
      remainingPath: admittedRoute.remainingPath.slice(1),
      resolvedPrefix: [
        { key: "new_path_0", pageId: id(20), revisionId: id(120), fingerprint: "page-20" }
      ]
    });
    const later = HierarchyChangeSetSchema.parse({
      ...prefix,
      ancestors: [{ ...ancestors[1]!, initialParent: existing(20) }]
    });
    expect(
      validateHierarchyAdmission(later, policy(1), inventory([page(20)]), [], laterRoute).valid
    ).toBe(true);
    expect(
      validateHierarchyAdmission(
        later,
        policy(1),
        inventory([{ ...page(20), revisionId: id(999) }]),
        [],
        laterRoute
      ).valid
    ).toBe(false);
    expect(
      HierarchyRouteContinuationSchema.safeParse({ ...route, state: "complete" }).success
    ).toBe(false);
  });
});

import { hierarchyMoveReviews, hierarchyReviewPath } from "./automatic-wiki.js";
it("composes exact review paths from the pinned base, renamed targets, ancestors and all moves", () => {
  const footprint = {
    memberships: [
      {
        id: id(800),
        pageId: id(20),
        expectedRevisionId: id(120),
        groupId: id(801),
        target: { kind: "page" as const, id: id(10) },
        purpose: "related" as const,
        origin: "human" as const,
        placementProtected: true,
        order: 7,
        groupOrderProtected: true,
        groupOrder: 2
      }
    ],
    backlinks: [{ pageId: id(22), revisionId: id(122) }]
  };
  const base = inventory([
    {
      ...page(10, id(30)),
      reviewFootprint: footprint,
      placementProtected: true,
      descendantCount: 5
    },
    { ...page(20), reviewFootprint: { memberships: [], backlinks: [] } },
    page(30)
  ]);
  const target = {
    ...topic("new_moved"),
    pageId: id(10),
    expectedRevisionId: id(110),
    title: "Renamed leaf"
  };
  const proposal = HierarchyChangeSetSchema.parse({
    ...change([target]),
    ancestors: [ancestor("new_path")],
    moves: [
      { ...move(10), fromParent: existing(30) },
      { ...move(20, "new_parent"), toParent: proposed("new_path") }
    ]
  });
  const reviews = hierarchyMoveReviews(base, proposal);
  expect(reviews[0]?.before.map((p) => p.title)).toEqual(["Page 30", "Page 10"]);
  expect(reviews[0]?.after.map((p) => p.title)).toEqual(["new_path", "Page 20", "Renamed leaf"]);
  expect(reviews[0]?.after[1]?.reference).toEqual(existing(20));
  expect(reviews[0]?.affectedMemberships).toEqual(footprint.memberships);
  expect(reviews[0]?.backlinks).toEqual(footprint.backlinks);
  expect(reviews[0]?.descendantCount).toBe(5);
  expect(countHierarchyChanges(proposal)).toEqual({
    workTargets: 2,
    structuralAncestors: 1,
    changedPages: 3
  });
  expect(() =>
    hierarchyMoveReviews(inventory([page(10, id(30)), page(20), page(30)]), proposal)
  ).toThrow("conflict");
  expect(
    hierarchyReviewPath(inventory([page(10, id(30))]), proposal, existing(10), false)
  ).toBeNull();
  const deep = Array.from({ length: 220 }, (_, n) => page(n + 1000, n ? id(n + 999) : null));
  expect(
    hierarchyReviewPath(inventory(deep), change(), {
      reference: "existing",
      target: { kind: "page", id: id(1219) },
      expectedRevisionId: id(1319),
      fingerprint: "page-1219"
    })?.length
  ).toBe(220);
});
