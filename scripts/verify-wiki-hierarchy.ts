import { AutomaticMaintenance } from "../apps/desktop/src/main/services/automatic-maintenance.js";
import {
  curatorPrompt,
  curatorSupportView,
  WikiCurator
} from "../apps/desktop/src/main/services/wiki-curator.js";
import { WikiCollection } from "../apps/desktop/src/main/services/wiki-collection.js";
import {
  defaultPromptPin,
  promptFingerprint,
  promptAudit
} from "../apps/desktop/src/main/services/prompt-runtime.js";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
  createPgPool,
  closePgPool,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations,
  createWikiRepository,
  createWikiCuratorRepository,
  createOrganizationRepository,
  createAiConfigRepository,
  createSourceItemRepository,
  createDocumentRepository,
  createChunkRepository,
  createKnowledgeAutomationRepository,
  createWikiCollectionRepository,
  createAutomaticMaintenanceRepository,
  curatorHash,
  type PgPool
} from "../packages/db/src/index.js";
import {
  hierarchyMoveReviews,
  resolveHierarchyRouteParent,
  HierarchyPolicySchema,
  HierarchySnapshotSchema,
  HierarchyChangeSetSchema,
  HierarchyCuratorCheckpointSchema,
  HierarchyPageTargetSchema,
  HierarchyRouteContinuationSchema,
  WikiPageSchema,
  WikiPageContentSchema,
  hierarchyChangedHandles,
  initialHierarchyLimits,
  promptDefinition,
  wikiAreaIds,
  type HierarchySnapshot,
  type HierarchyChangeSet,
  type HierarchyParent,
  type HierarchyPolicy
} from "@app/domain";

const root = resolve(import.meta.dirname, ".."),
  dir = await mkdtemp(join(tmpdir(), "memora-wiki-hierarchy-"));
const paths = resolvePostgresSidecarPaths({ cwd: root, env: process.env });
const manager = new PostgresSidecarManager({
  binDir: paths.binDir,
  dataDir: join(dir, "data"),
  database: "hierarchy_test",
  user: "hierarchy_test",
  password: randomUUID()
});
let pool: PgPool | undefined;
try {
  const connection = await manager.start();
  const verifierConnection = new URL(connection.connectionString);
  verifierConnection.searchParams.set("options", "-c statement_timeout=30000");
  pool = createPgPool({ connectionString: verifierConnection.toString(), max: 8 });
  const db = pool;
  const migrations = await runMigrations(db, join(root, "packages/db/drizzle"), {
    seedFolder: join(root, "packages/db/seed")
  });
  assert.equal(migrations.seed.applied, true, "Fresh baseline only; never touch the user database");
  const repo = createWikiCuratorRepository(db),
    hierarchy = repo.hierarchy,
    wiki = createWikiRepository(db),
    runs = createOrganizationRepository(db);
  const areaTitles = {
    themes: "Themes",
    entities: "Entities",
    syntheses: "Syntheses",
    investigations: "Investigations",
    maps: "Maps",
    people: "People",
    organizations: "Organizations",
    places: "Places",
    works: "Works"
  };
  await createKnowledgeAutomationRepository(db).initializeAreas(areaTitles);
  assert.equal((await wiki.list()).length, Object.keys(wikiAreaIds).length);
  const source = await createSourceItemRepository(db).create({
    type: "PersonalNote",
    title: "Synthetic genetics notebook"
  });
  const outside = await createSourceItemRepository(db).create({
    type: "PersonalNote",
    title: "Excluded notebook"
  });
  async function original(sourceId: string, text: string) {
    const document = await createDocumentRepository(db).create({
      sourceItemId: sourceId,
      title: "Original",
      canonicalMarkdown: text,
      contentHash: text
    });
    const id = randomUUID(),
      span = randomUUID();
    await createChunkRepository(db).replaceDocumentChunks(document.id, sourceId, [
      {
        id,
        sourceSpanId: span,
        chunkIndex: 0,
        content: text,
        contentHash: text,
        span: { id: span, startOffset: 0, endOffset: text.length }
      }
    ]);
    return id;
  }
  const chunk = await original(
    source.id,
    "Gene regulation belongs to molecular genetics within genetics, biology and science. Multiple original observations support the reading categories."
  );
  const excludedChunk = await original(outside.id, "Private excluded findings.");
  const profile = {
    profileId: randomUUID(),
    providerConfigId: null,
    localModelId: null,
    provider: "synthetic",
    modelId: "fixture",
    runtime: "test",
    revision: "1",
    privacy: "offline_only",
    parameters: {},
    identityHash: "fixture",
    contextWindow: 65536
  };
  const promptId = "organization.curator.support";
  const promptPin = defaultPromptPin();
  const promptIds = new Set<string>();
  const collect = (id: string) => {
    if (promptIds.has(id)) return;
    promptIds.add(id);
    promptDefinition(id).fragmentIds.forEach(collect);
  };
  collect(promptId);
  const revisions = [...promptIds].flatMap(
    (id) => promptPin.entries.find((p) => p.id === id)!.revisions
  );
  const supportCompositionHash = promptFingerprint([promptId], promptPin, false);
  const resources = { maxInventoryBytes: 1_000_000, maxProposalBytes: 1_000_000 };
  async function policy(targets = 3) {
    const policy = HierarchyPolicySchema.parse({
      version: "automatic-wiki-v1",
      id: randomUUID(),
      revisionId: randomUUID(),
      state: "enabled",
      scope: {
        wholeLibrary: false,
        sourceIds: [source.id],
        includeDescendants: false,
        excludedSourceIds: [outside.id],
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
      limits: { ...initialHierarchyLimits, targets, deadlineMs: 600000 },
      allowancePreset: null
    });
    await db.query(
      "insert into wiki_policy_revisions(id,policy_id,policy,preview,preview_hash) values($1,$2,$3,'{}','fixture')",
      [policy.revisionId, policy.id, policy]
    );
    await db.query(
      "insert into wiki_policy_activations(policy_id,revision_id,state) values($1,$2,'enabled')",
      [policy.id, policy.revisionId]
    );
    return policy;
  }
  const mainPolicy = await policy();
  const topic = (handle: string, title = handle) =>
    HierarchyPageTargetSchema.parse({
      handle,
      title,
      purpose: "Place current genetics findings",
      pageId: null,
      expectedRevisionId: null,
      initialParent: null,
      role: { kind: "topic", role: "topic" },
      sections: [
        {
          sectionId: null,
          expectedSectionRevisionId: null,
          title: "Finding",
          markdown: "Original genetics observation [e1]",
          originalHandles: ["e1"]
        }
      ],
      tocGroups: [],
      links: []
    });
  const proposed = (handle: string): HierarchyParent => ({ reference: "proposed", handle });
  const parentRef = (snapshot: HierarchySnapshot, id: string): HierarchyParent => {
    const p = snapshot.placement.pages.find((p) => p.pageId === id)!;
    return {
      reference: "existing",
      target: { kind: "page", id },
      fingerprint: p.fingerprint,
      expectedRevisionId: p.revisionId
    };
  };
  const checkpoint = () =>
    HierarchyCuratorCheckpointSchema.parse({
      version: "wiki-curator-v2",
      calls: 0,
      tools: 0,
      repairs: 0,
      startedAt: new Date().toISOString(),
      callPending: false,
      waitingForModel: false,
      proposal: null,
      previousOutput: "",
      error: null,
      reportedInputTokens: 0,
      reportedOutputTokens: 0,
      costEstimate: 0,
      usageCounts: { input: 0, output: 0, cost: 0 },
      usageIncomplete: true,
      hierarchy: null
    });
  async function snapshot(
    policy = mainPolicy,
    pageIds: string[] = [],
    editablePageIds: string[] = [],
    noteIds: string[] = []
  ) {
    const evidence = (await repo.evidencePage([source.id], null, 12)).items;
    const references = await repo.references([source.id], noteIds, [chunk]);
    const pages = await Promise.all(
      editablePageIds.map(async (id) => WikiPageSchema.parse(await wiki.get(id)))
    );
    const placement = await hierarchy.inventory(policy, {
      pageIds,
      editablePageIds,
      limit: 300,
      maxBytes: resources.maxInventoryBytes
    });
    for (const page of pages)
      references.push({
        kind: "page",
        id: page.id,
        title: page.title,
        text: "",
        fingerprint: page.revisionId,
        sourceIds: placement.pages.find((p) => p.pageId === page.id)!.sourceIds,
        chunkIds: page.evidence.map((e) => e.chunkId)
      });
    return HierarchySnapshotSchema.parse({
      version: "wiki-curator-v2",
      policy,
      sourceIds: [source.id],
      profile,
      promptPin,
      supportCompositionHash,
      contentLanguage: "en",
      evidence,
      references,
      pages,
      placement,
      resources,
      inputFingerprint: randomUUID(),
      groupId: randomUUID(),
      outputTokens: 4096,
      limits: policy.limits,
      admittedAt: new Date().toISOString()
    });
  }
  function change(s: HierarchySnapshot, patch: Partial<HierarchyChangeSet> = {}) {
    return HierarchyChangeSetSchema.parse({
      version: "automatic-wiki-v1",
      groupId: s.groupId,
      policyRevisionId: s.policy.revisionId,
      explanation: "Organize supported findings",
      targets: [topic("new_leaf")],
      ancestors: [],
      moves: [],
      ...patch
    });
  }
  async function pending(s: HierarchySnapshot, proposal: HierarchyChangeSet, certify = true) {
    const id = await runs.create(s, checkpoint());
    if (!certify) return id;
    const verdict = {
      supported: true,
      checkedTargets: hierarchyChangedHandles(proposal),
      issues: []
    };
    const aiTaskRunId = await createAiConfigRepository(db).recordTaskRun({
      organizationRunId: id,
      organizationStep: 1,
      taskType: "structured-output",
      provider: "synthetic",
      modelId: "fixture",
      runtime: "test",
      durationMs: 1,
      status: "succeeded",
      promptCompositions: [
        {
          version: "prompt-catalog-v1",
          promptId,
          revisions,
          compositionHash: supportCompositionHash,
          templateLanguage: "en",
          origin: "default",
          outputContractVersion: "fixture",
          embeddingStrategyIdentity: null
        }
      ]
    });
    const cp = {
      ...checkpoint(),
      calls: 1,
      proposal,
      supportAssessment: { proposalHash: curatorHash(proposal), aiTaskRunId, verdict }
    };
    await runs.step(
      id,
      1,
      cp,
      { proposalHash: curatorHash(proposal), support: verdict },
      aiTaskRunId
    );
    await runs.propose(id, proposal, cp, false);
    return id;
  }
  const apply = (id: string, human = false) =>
    hierarchy.apply(
      id,
      human,
      () => {},
      async () => {}
    );
  const countPages = async () =>
    (await db.query("select count(*)::int n from wiki_pages")).rows[0].n as number;
  // Deep path + two counted work targets in one canonical transaction/receipt.
  const emptyAreas = await hierarchy.inventory(mainPolicy, {
    pageIds: [wikiAreaIds.themes, wikiAreaIds.organizations],
    editablePageIds: Object.values(wikiAreaIds)
  });
  assert.deepEqual(
    new Set(emptyAreas.pages.map((p) => p.pageId)),
    new Set([wikiAreaIds.themes, wikiAreaIds.entities, wikiAreaIds.organizations])
  );
  assert.ok(
    emptyAreas.pages.every(
      (p) => p.canReceiveChildren && !p.canEdit && p.sourceIds.length === 0 && !p.reviewFootprint
    )
  );
  const arbitrary = await wiki.save({
    expectedRevisionId: null,
    content: WikiPageContentSchema.parse({ title: "Unbound human container", kind: "collection" }),
    evidenceChunkIds: []
  });
  assert.ok(
    !(
      await hierarchy.inventory(mainPolicy, { pageIds: [arbitrary], editablePageIds: [arbitrary] })
    ).pages.some((p) => p.pageId === arbitrary)
  );
  const first = await snapshot(mainPolicy, [wikiAreaIds.themes]);
  const ancestors = ["Science", "Biology", "Genetics", "Molecular genetics"].map((title, i) => ({
    handle: `new_path_${i}`,
    title,
    purpose: "Required path for current findings",
    role: { kind: "topic" as const, role: "topic" as const },
    initialParent: i ? proposed(`new_path_${i - 1}`) : parentRef(first, wikiAreaIds.themes)
  }));
  const leaf = { ...topic("new_leaf", "Gene regulation"), initialParent: proposed("new_path_3") };
  const toc = {
    ...topic("new_toc", "Gene regulation reading"),
    initialParent: proposed("new_leaf"),
    role: { kind: "collection" as const, role: "topic_toc" as const, owner: proposed("new_leaf") },
    sections: [],
    tocGroups: [
      {
        handle: "new_reading",
        id: null,
        expectedRevisionId: null,
        title: "Original source",
        explanation: null,
        originalHandles: [],
        memberships: [
          {
            id: null,
            target: {
              reference: "existing" as const,
              target: { kind: "source" as const, id: source.id },
              fingerprint: first.references.find((r) => r.kind === "source")!.fingerprint
            },
            purpose: "source" as const,
            order: 0
          }
        ]
      }
    ]
  };
  const proposal = change(first, { targets: [leaf, toc], ancestors });
  const firstRun = await pending(first, proposal),
    before = await countPages();
  const receipt = await apply(firstRun);
  assert.equal(receipt.length, 6);
  assert.equal(await countPages(), before + 6);
  assert.deepEqual(await apply(firstRun), receipt, "Lost acknowledgment reuses committed receipt");
  const all = await wiki.list(),
    leafPage = all.find((p) => p.title === "Gene regulation")!;
  const science = all.find((p) => p.title === "Science")!,
    molecular = all.find((p) => p.title === "Molecular genetics")!;
  for (const title of ancestors.map((a) => a.title))
    assert.equal((await wiki.get(all.find((p) => p.title === title)!.id))!.sections.length, 0);
  const inventory = await hierarchy.inventory(mainPolicy, {
    pageIds: [leafPage.id],
    editablePageIds: [leafPage.id]
  });
  assert.equal(inventory.pages.length, 6);
  assert.equal(inventory.pages.find((p) => p.pageId === science.id)!.descendantCount, 5);
  assert.ok(inventory.pages.find((p) => p.pageId === molecular.id)!.canReceiveChildren);
  assert.equal(inventory.pages.find((p) => p.pageId === molecular.id)!.canEdit, false);
  assert.ok(!JSON.stringify(inventory).includes("Original genetics observation"));
  let cursor: string | null = null;
  const seen: string[] = [];
  do {
    const part = await hierarchy.inventory(mainPolicy, {
      pageIds: [leafPage.id],
      limit: 2,
      after: cursor
    });
    seen.push(...part.pages.map((p) => p.pageId));
    cursor = part.nextCursor;
  } while (cursor);
  assert.equal(new Set(seen).size, 6, "Bounded cursor reaches complete ancestry");
  // Actual initialized entity destinations accept the first canonical entity path.
  const placedEntity = randomUUID();
  await db.query(
    "insert into entities(id,canonical_name,type,normalized_name,confidence) values($1,'Genetics institute','organization','genetics institute',1)",
    [placedEntity]
  );
  await db.query(
    "insert into entity_mentions(entity_id,source_item_id,chunk_id,surface_text,confidence) values($1,$2,$3,'Genetics institute',1)",
    [placedEntity, source.id, chunk]
  );
  const entitySnapshot = await snapshot(mainPolicy, [wikiAreaIds.organizations]);
  assert.equal(
    entitySnapshot.placement.pages.find((p) => p.pageId === wikiAreaIds.organizations)!.parentId,
    wikiAreaIds.entities
  );
  const entityProposal = change(entitySnapshot, {
    ancestors: [
      {
        handle: "new_institutes",
        title: "Institutes",
        purpose: "Required canonical organization category",
        role: { kind: "collection", role: "map", owner: null },
        initialParent: parentRef(entitySnapshot, wikiAreaIds.organizations)
      }
    ],
    targets: [
      {
        ...topic("new_canonical_org", "Genetics institute"),
        role: { kind: "entity", role: "entity", entityId: placedEntity },
        initialParent: proposed("new_institutes")
      }
    ]
  });
  const entityReceipt = await apply(await pending(entitySnapshot, entityProposal));
  assert.equal(entityReceipt.length, 2);
  const canonicalEntity = WikiPageSchema.parse(
    await wiki.get((await hierarchy.canonicalEntityPage(placedEntity))!)
  );
  const institutes = WikiPageSchema.parse(await wiki.get(canonicalEntity.parentId!));
  assert.equal(institutes.parentId, wikiAreaIds.organizations);
  const initialized = (await wiki.list()).filter((p) =>
    Object.values(wikiAreaIds).some((id) => id === p.id)
  );
  assert.equal(initialized.length, 9);
  assert.equal(initialized.filter((p) => p.title === "Entities").length, 1);
  assert.equal(initialized.filter((p) => p.title === "Themes").length, 1);
  const areaMoveSnapshot = await snapshot(
    mainPolicy,
    [wikiAreaIds.themes, wikiAreaIds.entities],
    [wikiAreaIds.entities]
  );
  const areaPage = areaMoveSnapshot.pages[0]!;
  const areaMove = change(areaMoveSnapshot, {
    targets: [],
    moves: [
      {
        handle: "new_forbidden_area_move",
        operation: "reviewed_reparent",
        pageId: areaPage.id,
        expectedRevisionId: areaPage.revisionId,
        fromParent: null,
        toParent: parentRef(areaMoveSnapshot, wikiAreaIds.themes),
        reason: "Destination access must not grant move access"
      }
    ]
  });
  await assert.rejects(apply(await pending(areaMoveSnapshot, areaMove), true), /scope/);
  assert.equal((await wiki.get(wikiAreaIds.entities))!.revisionId, areaPage.revisionId);
  // Six ordinary targets fit a six-target policy and share existing ancestry.
  const sixPolicy = await policy(6),
    six = await snapshot(sixPolicy, [molecular.id]);
  const sixProposal = change(six, {
    targets: Array.from({ length: 6 }, (_, i) => ({
      ...topic(`new_six_${i}`),
      initialParent: parentRef(six, molecular.id)
    }))
  });
  assert.equal((await apply(await pending(six, sixProposal))).length, 6);
  const capped = await snapshot(mainPolicy),
    over = change(capped, { targets: Array.from({ length: 4 }, (_, i) => topic(`new_over_${i}`)) });
  await assert.rejects(apply(await pending(capped, over)), /scopeLimit/);
  // A failed target rolls back already allocated ancestors and every target.
  const invalid = await snapshot(),
    broken = change(invalid, {
      targets: [
        {
          ...topic("new_invalid"),
          sections: [{ ...topic("new_template").sections[0]!, originalHandles: ["e2"] }]
        }
      ]
    });
  const n = await countPages();
  await assert.rejects(apply(await pending(invalid, broken)), /evidence/);
  assert.equal(await countPages(), n);
  // Canonical support must cover ancestors exactly, use the exact proposal and admitted pin.
  const noSupport = await snapshot(),
    noSupportProposal = change(noSupport),
    noSupportRun = await pending(noSupport, noSupportProposal);
  await db.query(
    "update organization_runs set checkpoint=jsonb_set(checkpoint,'{supportAssessment,verdict,checkedTargets}','[]') where id=$1",
    [noSupportRun]
  );
  await assert.rejects(apply(noSupportRun), /evidence|ZodError/);
  const changedSupport = await snapshot(),
    changedRun = await pending(changedSupport, change(changedSupport));
  await db.query(
    "update organization_proposals set proposal=jsonb_set(proposal,'{explanation}','\"different\"') where run_id=$1",
    [changedRun]
  );
  await assert.rejects(apply(changedRun), /evidence/);
  const wrongComposition = await snapshot(),
    wrongCompositionRun = await pending(wrongComposition, change(wrongComposition));
  await db.query(
    "update ai_task_runs set prompt_compositions=jsonb_set(prompt_compositions,'{0,compositionHash}',to_jsonb($2::text)) where id in(select ai_task_run_id from organization_steps where run_id=$1)",
    [wrongCompositionRun, "b".repeat(64)]
  );
  await assert.rejects(apply(wrongCompositionRun), /evidence/);
  // Reviewed placement preserves exact prose revisions, support and protected memberships.
  const loaded = WikiPageSchema.parse(await wiki.get(leafPage.id));
  await wiki.save({
    version: 2,
    id: loaded.id,
    expectedRevisionId: loaded.revisionId,
    content: {
      ...WikiPageContentSchema.strip().parse(loaded),
      sections: loaded.sections.map((s) => ({ ...s, protected: true }))
    },
    evidenceChunkIds: []
  });
  async function saveFixtureNavigation(
    page: ReturnType<typeof WikiPageSchema.parse>,
    content: ReturnType<typeof WikiPageContentSchema.parse>
  ) {
    const client = await db.connect();
    try {
      await client.query("begin");
      await wiki.save(
        { id: page.id, expectedRevisionId: page.revisionId, content, evidenceChunkIds: [] },
        { transaction: client, origin: "organization", allocatedTarget: false, humanApproved: true }
      );
      await client.query("commit");
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
  const reading = WikiPageSchema.parse(
    await wiki.get(all.find((p) => p.title === "Gene regulation reading")!.id)
  );
  const protectedReading = structuredClone(WikiPageContentSchema.strip().parse(reading));
  protectedReading.automatic!.groups[0]!.orderProtected = true;
  protectedReading.automatic!.memberships[0]!.placementProtected = true;
  await saveFixtureNavigation(reading, protectedReading);
  const backlinkId = await wiki.save({
    expectedRevisionId: null,
    content: WikiPageContentSchema.parse({
      title: "Excluded backlink title",
      kind: "collection",
      sections: [
        {
          id: randomUUID(),
          title: "Private",
          markdown: "Private excluded backlink prose",
          evidenceIds: [excludedChunk]
        }
      ]
    }),
    evidenceChunkIds: [excludedChunk]
  });
  const backlink = WikiPageSchema.parse(await wiki.get(backlinkId)),
    backlinkGroup = randomUUID(),
    backlinkMember = randomUUID();
  const backlinkContent = WikiPageContentSchema.strip().parse(backlink);
  backlinkContent.collectionIds = [reading.id];
  backlinkContent.automatic = {
    version: "automatic-wiki-v1",
    management: "human_managed",
    role: { kind: "collection", role: "map", owner: null },
    purpose: "Private navigation",
    placementProtected: true,
    links: [],
    groups: [
      {
        version: "automatic-wiki-v1",
        id: backlinkGroup,
        collectionId: backlinkId,
        title: "Private group heading",
        explanation: null,
        explanationEvidenceIds: [],
        membershipIds: [backlinkMember],
        orderProtected: true,
        origin: "human"
      }
    ],
    memberships: [
      {
        version: "automatic-wiki-v1",
        id: backlinkMember,
        pageId: backlinkId,
        groupId: backlinkGroup,
        target: { kind: "page", id: leafPage.id },
        purpose: "related",
        order: 3,
        origin: "human",
        placementProtected: true,
        expectedPageRevisionId: backlink.revisionId,
        targetFingerprint: loaded.revisionId
      }
    ]
  };
  await saveFixtureNavigation(backlink, backlinkContent);
  const preservedReading = WikiPageSchema.parse(await wiki.get(reading.id)),
    preservedBacklink = WikiPageSchema.parse(await wiki.get(backlinkId));
  const moving = await snapshot(mainPolicy, [leafPage.id, science.id], [leafPage.id]);
  const from = moving.pages[0]!,
    beforeSections = structuredClone(from.sections),
    beforeEvidence = structuredClone(from.evidence);
  const move = {
    handle: "new_move",
    operation: "reviewed_reparent" as const,
    pageId: from.id,
    expectedRevisionId: from.revisionId,
    fromParent: parentRef(moving, from.parentId!) as Extract<
      HierarchyParent,
      { reference: "existing" }
    >,
    toParent: parentRef(moving, science.id),
    reason: "Reviewed broader category"
  };
  const moveProposal = change(moving, { targets: [], moves: [move] }),
    moveReview = hierarchyMoveReviews(moving.placement, moveProposal)[0]!;
  assert.deepEqual(
    moveReview.before.map((p) => p.title),
    ["Themes", "Science", "Biology", "Genetics", "Molecular genetics", "Gene regulation"]
  );
  assert.deepEqual(
    moveReview.after.map((p) => p.title),
    ["Themes", "Science", "Gene regulation"]
  );
  assert.equal(moveReview.descendantCount, 1);
  assert.equal(moveReview.affectedMemberships.length, 2);
  assert.ok(
    moveReview.affectedMemberships.every((m) => m.placementProtected && m.groupOrderProtected)
  );
  assert.equal(moveReview.affectedMemberships.find((m) => m.id === backlinkMember)!.order, 3);
  assert.deepEqual(moveReview.backlinks, [
    { pageId: backlinkId, revisionId: preservedBacklink.revisionId }
  ]);
  assert.ok(!JSON.stringify(moving).includes("Private excluded backlink prose"));
  assert.ok(!JSON.stringify(moveReview).includes("Private group heading"));
  assert.ok(!curatorPrompt(moving, checkpoint()).includes("reviewFootprint"));
  assert.ok(
    !JSON.stringify(curatorSupportView(moving, moveProposal)).includes("groupOrderProtected"),
    "Review manifests never enter synthesis or support prompts"
  );
  assert.ok(
    !moving.pages.some((p) => p.id === backlinkId),
    "Inbound review IDs do not grant edits or expose excluded prose"
  );
  const moveRun = await pending(moving, moveProposal);
  await assert.rejects(apply(moveRun), /review/);
  await apply(moveRun, true);
  const moved = WikiPageSchema.parse(await wiki.get(from.id));
  assert.equal(moved.parentId, science.id);
  assert.deepEqual(moved.sections, beforeSections);
  assert.deepEqual(moved.evidence, beforeEvidence);
  assert.deepEqual(await apply(moveRun, true), await apply(moveRun, true));
  assert.deepEqual(
    WikiPageContentSchema.strip().parse(await wiki.get(reading.id)),
    WikiPageContentSchema.strip().parse(preservedReading),
    "Descendant TOC content, membership identities, order and protection survive the move"
  );
  assert.equal(
    WikiPageSchema.parse(await wiki.get(reading.id)).revisionId,
    preservedReading.revisionId
  );
  assert.deepEqual(
    WikiPageSchema.parse(await wiki.get(backlinkId)),
    preservedBacklink,
    "Inbound protected membership and excluded prose remain untouched"
  );
  const staleFootprint = await snapshot(mainPolicy, [leafPage.id, molecular.id], [leafPage.id]);
  const staleMove = change(staleFootprint, {
    targets: [],
    moves: [
      {
        ...move,
        expectedRevisionId: moved.revisionId,
        fromParent: parentRef(staleFootprint, science.id) as Extract<
          HierarchyParent,
          { reference: "existing" }
        >,
        toParent: parentRef(staleFootprint, molecular.id)
      }
    ]
  });
  const staleFootprintRun = await pending(staleFootprint, staleMove);
  const changedBacklink = WikiPageContentSchema.strip().parse(preservedBacklink);
  changedBacklink.automatic!.memberships[0]!.order = 4;
  await saveFixtureNavigation(preservedBacklink, changedBacklink);
  const newFootprint = await hierarchy.inventory(mainPolicy, {
    pageIds: [leafPage.id, molecular.id],
    editablePageIds: [leafPage.id]
  });
  assert.equal(
    newFootprint.pages.find((p) => p.pageId === leafPage.id)!.reviewFootprint!.memberships.length,
    moveReview.affectedMemberships.length,
    "Inbound cardinality is unchanged"
  );
  await assert.rejects(
    apply(staleFootprintRun, true),
    /conflict/,
    "A same-count concurrent incoming membership reorder invalidates the shown review"
  );
  assert.equal(WikiPageSchema.parse(await wiki.get(leafPage.id)).revisionId, moved.revisionId);
  assert.equal(
    (
      await db.query("select count(*)::int n from wiki_group_receipts where run_id=$1", [
        staleFootprintRun
      ])
    ).rows[0].n,
    0
  );
  // Current destination metadata and source parent are exact, not a title-based guess.
  const stale = await snapshot(mainPolicy, [science.id]),
    staleProposal = change(stale, {
      targets: [{ ...topic("new_stale"), initialParent: parentRef(stale, science.id) }]
    }),
    staleRun = await pending(stale, staleProposal);
  const currentScience = WikiPageSchema.parse(await wiki.get(science.id));
  await wiki.save({
    version: 2,
    id: science.id,
    expectedRevisionId: currentScience.revisionId,
    content: { ...WikiPageContentSchema.strip().parse(currentScience), pinned: true },
    evidenceChunkIds: []
  });
  await assert.rejects(apply(staleRun), /conflict/);
  const cyclic = await snapshot(mainPolicy, [science.id, molecular.id], [science.id]);
  const sciencePage = cyclic.pages[0]!;
  await assert.rejects(
    apply(
      await pending(
        cyclic,
        change(cyclic, {
          targets: [],
          moves: [
            {
              handle: "new_cycle",
              operation: "reviewed_reparent",
              pageId: science.id,
              expectedRevisionId: sciencePage.revisionId,
              fromParent: parentRef(cyclic, wikiAreaIds.themes) as Extract<
                HierarchyParent,
                { reference: "existing" }
              >,
              toParent: parentRef(cyclic, molecular.id),
              reason: "Invalid descendant destination"
            }
          ]
        })
      ),
      true
    ),
    /scope/
  );
  const mixed = await wiki.save({
    expectedRevisionId: null,
    content: WikiPageContentSchema.parse({
      title: "Mixed excluded lineage",
      kind: "topic",
      sections: [
        { id: randomUUID(), title: "Both", markdown: "mixed", evidenceIds: [chunk, excludedChunk] }
      ]
    }),
    evidenceChunkIds: [chunk, excludedChunk]
  });
  const mixedInventory = await hierarchy.inventory(mainPolicy, {
    pageIds: [mixed],
    editablePageIds: [mixed]
  });
  assert.ok(!mixedInventory.pages.some((p) => p.pageId === mixed));
  assert.ok(
    mixedInventory.pages.every(
      (p) =>
        p.pageId === wikiAreaIds.themes &&
        !p.canEdit &&
        p.canReceiveChildren &&
        p.sourceIds.length === 0
    )
  );
  // Canonical save itself rejects duplicate entity identity, but homonyms remain distinct.
  const entityA = randomUUID(),
    entityB = randomUUID();
  for (const id of [entityA, entityB])
    await db.query(
      "insert into entities(id,canonical_name,type,normalized_name,confidence) values($1,'Shared name','organization','shared name',1)",
      [id]
    );
  const entityPage = await wiki.save({
    expectedRevisionId: null,
    content: WikiPageContentSchema.parse({
      title: "Shared name",
      kind: "entity",
      entityId: entityA
    }),
    evidenceChunkIds: []
  });
  assert.equal(await hierarchy.canonicalEntityPage(entityA), entityPage);
  await assert.rejects(
    wiki.save({
      expectedRevisionId: null,
      content: WikiPageContentSchema.parse({
        title: "Other name",
        kind: "entity",
        entityId: entityA
      }),
      evidenceChunkIds: []
    }),
    /conflict/
  );
  await wiki.save({
    expectedRevisionId: null,
    content: WikiPageContentSchema.parse({
      title: "Shared name",
      kind: "entity",
      entityId: entityB
    }),
    evidenceChunkIds: []
  });
  const archived = await wiki.save({
    expectedRevisionId: null,
    content: WikiPageContentSchema.parse({ title: "Archived", kind: "topic", archived: true }),
    evidenceChunkIds: []
  });
  await assert.rejects(
    wiki.save({
      expectedRevisionId: null,
      content: WikiPageContentSchema.parse({
        title: "Invalid child",
        kind: "topic",
        parentId: archived
      }),
      evidenceChunkIds: []
    }),
    /cycle/
  );
  // Composed nested TOC descent includes current and same-group links.
  const nested = await snapshot();
  const mapTarget = (handle: string) => ({
    ...topic(handle),
    role: { kind: "collection" as const, role: "map" as const, owner: null }
  });
  const nestedA = {
    ...mapTarget("new_nested_a"),
    tocGroups: [
      {
        handle: "new_nested_group",
        id: null,
        expectedRevisionId: null,
        title: "Subtopic path",
        explanation: null,
        originalHandles: [],
        memberships: [
          {
            id: null,
            target: { reference: "proposed" as const, handle: "new_nested_b" },
            purpose: "subtopic" as const,
            order: 0
          }
        ]
      }
    ]
  };
  const nestedReceipt = await apply(
    await pending(nested, change(nested, { targets: [nestedA, mapTarget("new_nested_b")] }))
  );
  const nestedPages = await Promise.all(nestedReceipt.map((r) => wiki.get(r.pageId)));
  const nestedPageA = WikiPageSchema.parse(nestedPages.find((p) => p!.title === "new_nested_a"));
  const nestedPageB = WikiPageSchema.parse(nestedPages.find((p) => p!.title === "new_nested_b"));
  const nestedSnapshot = await snapshot(
    mainPolicy,
    [nestedPageA.id, nestedPageB.id],
    [nestedPageB.id]
  );
  const cycleTarget = {
    ...mapTarget("new_nested_update"),
    title: nestedPageB.title,
    pageId: nestedPageB.id,
    expectedRevisionId: nestedPageB.revisionId,
    sections: [],
    tocGroups: [
      {
        ...nestedA.tocGroups[0]!,
        handle: "new_nested_reverse",
        memberships: [
          {
            id: null,
            target: {
              reference: "existing" as const,
              target: { kind: "page" as const, id: nestedPageA.id },
              fingerprint: nestedSnapshot.placement.pages.find((p) => p.pageId === nestedPageA.id)!
                .fingerprint
            },
            purpose: "subtopic" as const,
            order: 0
          }
        ]
      }
    ]
  };
  await assert.rejects(
    apply(await pending(nestedSnapshot, change(nestedSnapshot, { targets: [cycleTarget] }))),
    /scope/
  );
  // The canonical save guard protects other save callers too.
  const cycleDb = await db.connect();
  try {
    await cycleDb.query("begin");
    const content = WikiPageContentSchema.strip().parse(nestedPageB),
      groupId = randomUUID(),
      memberId = randomUUID();
    content.automatic!.groups.push({
      version: "automatic-wiki-v1",
      id: groupId,
      collectionId: nestedPageB.id,
      title: "Reverse path",
      explanation: null,
      explanationEvidenceIds: [],
      membershipIds: [memberId],
      orderProtected: false,
      origin: "generated"
    });
    content.automatic!.memberships.push({
      version: "automatic-wiki-v1",
      id: memberId,
      pageId: nestedPageB.id,
      groupId,
      target: { kind: "page", id: nestedPageA.id },
      purpose: "subtopic",
      order: 0,
      origin: "generated",
      placementProtected: false,
      expectedPageRevisionId: nestedPageB.revisionId,
      targetFingerprint: nestedPageA.revisionId
    });
    await assert.rejects(
      wiki.save(
        {
          id: nestedPageB.id,
          expectedRevisionId: nestedPageB.revisionId,
          content,
          evidenceChunkIds: []
        },
        {
          transaction: cycleDb,
          origin: "organization",
          humanApproved: true,
          allocatedTarget: false
        }
      ),
      /cycle/
    );
  } finally {
    await cycleDb.query("rollback");
    cycleDb.release();
  }
  const ungrounded = await snapshot(),
    ungroundedCount = await countPages();
  await assert.rejects(
    apply(
      await pending(
        ungrounded,
        change(ungrounded, {
          targets: [topic("new_rollback_first"), { ...topic("new_rollback_unbound"), sections: [] }]
        })
      )
    ),
    /scope/
  );
  assert.equal(
    await countPages(),
    ungroundedCount,
    "Late scope failure rolls back both saved revisions and allocated rows"
  );
  // A real pending note participates in both levels of a reading TOC with one identity.
  const sharedNote = randomUUID();
  await db.query(
    "insert into atomic_notes(id,title,idea_statement,body_markdown,created_from_source_item_id,evidence_chunk_id,status,generation_provider,generation_model,generation_runtime,generation_prompt_version,generation_key) values($1::uuid,'Regulation note','Original observation','Original genetics observation',$2,$3,'pending_review','synthetic','fixture','test','fixture',$1::text)",
    [sharedNote, source.id, chunk]
  );
  await db.query(
    "insert into atomic_note_source_links(atomic_note_id,source_item_id,chunk_id) values($1,$2,$3)",
    [sharedNote, source.id, chunk]
  );
  const noteSnapshot = await snapshot(mainPolicy, [], [], [sharedNote]),
    noteRef = noteSnapshot.references.find((r) => r.kind === "atomic_note" && r.id === sharedNote)!;
  const noteTarget = {
    reference: "existing" as const,
    target: { kind: "atomic_note" as const, id: sharedNote },
    fingerprint: noteRef.fingerprint
  };
  const noteIndex = (handle: string, child: string | null) => ({
    ...mapTarget(handle),
    sections: [],
    tocGroups: [
      {
        handle: handle + "_group",
        id: null,
        expectedRevisionId: null,
        title: "Shared original note",
        explanation: null,
        originalHandles: [],
        memberships: [
          { id: null, target: noteTarget, purpose: "reading" as const, order: 0 },
          ...(child
            ? [
                {
                  id: null,
                  target: { reference: "proposed" as const, handle: child },
                  purpose: "subtopic" as const,
                  order: 1
                }
              ]
            : [])
        ]
      }
    ]
  });
  const noteReceipt = await apply(
    await pending(
      noteSnapshot,
      change(noteSnapshot, {
        targets: [
          noteIndex("new_note_index_parent", "new_note_index_child"),
          noteIndex("new_note_index_child", null)
        ]
      })
    )
  );
  const memberships = (
    await db.query(
      "select id,page_id,target_id from wiki_memberships where target_kind='atomic_note' and target_id=$1 order by id",
      [sharedNote]
    )
  ).rows;
  assert.equal(memberships.length, 2);
  assert.equal(new Set(memberships.map((m) => m.page_id)).size, 2);
  assert.equal((await db.query("select count(*)::int n from atomic_notes")).rows[0].n, 1);
  assert.equal(
    (await db.query("select status from atomic_notes where id=$1", [sharedNote])).rows[0].status,
    "pending_review"
  );
  const notePages = await Promise.all(noteReceipt.map((r) => wiki.get(r.pageId))),
    noteParent = notePages.find((p) => p!.title === "new_note_index_parent")!;
  const noteInventory = await hierarchy.inventory(mainPolicy, { pageIds: [noteParent.id] });
  assert.equal(noteInventory.pages.length, 2);
  assert.ok(
    noteInventory.pages.every((p) => p.sourceIds.length === 1 && p.sourceIds[0] === source.id)
  );
  const staleNoteSnapshot = await snapshot(mainPolicy, [], [], [sharedNote]),
    staleNoteRun = await pending(
      staleNoteSnapshot,
      change(staleNoteSnapshot, { targets: [noteIndex("new_note_after_admission", null)] })
    );
  const notePageCount = await countPages();
  await db.query(
    "insert into atomic_note_source_links(atomic_note_id,source_item_id,chunk_id) values($1,$2,$3)",
    [sharedNote, outside.id, excludedChunk]
  );
  await assert.rejects(apply(staleNoteRun), /scope|evidence/);
  assert.equal(await countPages(), notePageCount);
  assert.equal(
    (await hierarchy.inventory(mainPolicy, { pageIds: [noteParent.id] })).pages.filter(
      (p) => !Object.values(wikiAreaIds).some((id) => id === p.pageId)
    ).length,
    0,
    "Secondary source lineage excludes both nested indexes"
  );
  await db.query(
    "insert into atomic_note_evidence(note_id,chunk_id,source_id,snapshot) select $1,id,source_item_id,jsonb_build_object('contentHash',content_hash,'excerpt',content) from chunks where id=$2",
    [sharedNote, excludedChunk]
  );
  await db.query("delete from atomic_note_source_links where atomic_note_id=$1 and chunk_id=$2", [
    sharedNote,
    excludedChunk
  ]);
  const retainedOriginals = await repo.noteOriginals(sharedNote);
  assert.ok(
    retainedOriginals.source_ids.includes(outside.id) &&
      retainedOriginals.chunk_ids.includes(excludedChunk)
  );
  await assert.rejects(repo.references([source.id], [sharedNote], [chunk]), /scope/);
  await assert.rejects(apply(staleNoteRun), /scope|evidence/);
  assert.equal(
    (await hierarchy.inventory(mainPolicy, { pageIds: [noteParent.id] })).pages.length,
    0,
    "Retained original lineage cannot disappear with a removed live link"
  );
  assert.deepEqual(
    (
      await db.query(
        "select id,page_id,target_id from wiki_memberships where target_kind='atomic_note' and target_id=$1 order by id",
        [sharedNote]
      )
    ).rows,
    memberships
  );
  // Both requests wait behind the same placement lock before racing; no timing guess.
  async function contend<T>(actions: Array<() => Promise<T>>) {
    const blocker = await db.connect();
    await blocker.query("begin");
    await blocker.query("select pg_advisory_xact_lock(hashtextextended('wiki-placement',0))");
    const pending = actions.map((action) =>
      action().then(
        (value) => ({ ok: true as const, value }),
        (error) => ({ ok: false as const, error })
      )
    );
    try {
      let waiting = 0;
      for (let attempt = 0; attempt < 200 && waiting < actions.length; attempt++) {
        waiting = (
          await db.query(
            "select count(*)::int n from pg_stat_activity where datname=current_database() and wait_event_type='Lock' and query like '%wiki-placement%'"
          )
        ).rows[0].n;
        if (waiting < actions.length) await new Promise((resolve) => setTimeout(resolve, 5));
      }
      assert.equal(
        waiting,
        actions.length,
        "Both independent transactions reached the serialization lock"
      );
    } finally {
      await blocker.query("commit");
      blocker.release();
    }
    return Promise.all(pending);
  }
  const racingEntity = randomUUID();
  await db.query(
    "insert into entities(id,canonical_name,type,normalized_name,confidence) values($1,'Concurrent identity','organization','concurrent identity',1)",
    [racingEntity]
  );
  const raceBindings = await contend(
    [0, 1].map(
      (i) => () =>
        wiki.save({
          expectedRevisionId: null,
          content: WikiPageContentSchema.parse({
            title: "Concurrent entity " + i,
            kind: "entity",
            entityId: racingEntity
          }),
          evidenceChunkIds: []
        })
    )
  );
  assert.equal(raceBindings.filter((r) => r.ok).length, 1);
  assert.match(String(raceBindings.find((r) => !r.ok)!.error), /conflict/);
  assert.equal(
    (
      await db.query(
        "select count(*)::int n from wiki_pages p join wiki_page_revisions r on r.id=p.current_revision_id where r.content->>'entityId'=$1",
        [racingEntity]
      )
    ).rows[0].n,
    1
  );
  const reciprocalBase = await snapshot(),
    reciprocalReceipt = await apply(
      await pending(
        reciprocalBase,
        change(reciprocalBase, { targets: [topic("new_reciprocal_a"), topic("new_reciprocal_b")] })
      )
    );
  const [reciprocalA, reciprocalB] = reciprocalReceipt.map((r) => r.pageId) as [string, string];
  const moveSnapshots = await Promise.all([
    snapshot(mainPolicy, [reciprocalA, reciprocalB], [reciprocalA]),
    snapshot(mainPolicy, [reciprocalA, reciprocalB], [reciprocalB])
  ]);
  const moveRuns = await Promise.all(
    moveSnapshots.map((s, index) =>
      pending(
        s,
        change(s, {
          targets: [],
          moves: [
            {
              handle: "new_reciprocal_move",
              operation: "reviewed_reparent",
              pageId: s.pages[0]!.id,
              expectedRevisionId: s.pages[0]!.revisionId,
              fromParent: null,
              toParent: parentRef(s, index ? reciprocalA : reciprocalB),
              reason: "Explicit reviewed concurrent move"
            }
          ]
        })
      )
    )
  );
  const reciprocal = await contend(moveRuns.map((id) => () => apply(id, true)));
  assert.equal(reciprocal.filter((r) => r.ok).length, 1);
  assert.match(String(reciprocal.find((r) => !r.ok)!.error), /conflict|scope/);
  const finalMoves = await Promise.all([wiki.get(reciprocalA), wiki.get(reciprocalB)]);
  assert.equal(finalMoves.filter((p) => p!.parentId !== null).length, 1);
  assert.equal(
    (
      await db.query(
        "select count(*)::int n from wiki_group_receipts where run_id=any($1::uuid[])",
        [moveRuns]
      )
    ).rows[0].n,
    1
  );
  assert.equal(
    (
      await db.query(
        "select count(*)::int n from wiki_page_revisions where page_id=any($1::uuid[])",
        [[reciprocalA, reciprocalB]]
      )
    ).rows[0].n,
    3,
    "Losing move has no partial revision"
  );
  // Reserved identity never exempts authored excluded prose from scope.
  const changedArea = WikiPageSchema.parse(await wiki.get(wikiAreaIds.investigations));
  await wiki.save({
    version: 2,
    id: changedArea.id,
    expectedRevisionId: changedArea.revisionId,
    content: {
      ...WikiPageContentSchema.strip().parse(changedArea),
      sections: [
        {
          id: randomUUID(),
          title: "Excluded human section",
          markdown: "Private excluded findings",
          kind: "prose",
          provenance: "personal",
          protected: true,
          evidenceReview: "needs_review",
          evidenceIds: [excludedChunk]
        }
      ]
    },
    evidenceChunkIds: [excludedChunk]
  });
  assert.equal(
    (
      await hierarchy.inventory(mainPolicy, {
        pageIds: [changedArea.id],
        editablePageIds: [changedArea.id]
      })
    ).pages.length,
    0
  );
  // An ancestor-only proof is never self-authorizing; exact owner checkpoint + restart is required.
  const prefixSnapshot = await snapshot();
  const ownerId = await runs.create(
    { version: "fixture-owner" },
    { state: "running", hierarchy: { routes: [], outcome: "pending" } }
  );
  const route = HierarchyRouteContinuationSchema.parse({
    version: "automatic-wiki-v1",
    routeId: randomUUID(),
    fingerprint: {
      version: "automatic-wiki-v1",
      branchFingerprint: prefixSnapshot.placement.fingerprint,
      scopeFingerprint: prefixSnapshot.placement.scopeFingerprint,
      policyRevisionId: mainPolicy.revisionId,
      promptFingerprint: curatorHash(promptPin),
      modelFingerprint: profile.identityHash
    },
    state: "pending",
    intendedTargets: [
      {
        key: "new_final_leaf",
        title: "Later findings",
        purpose: "Complete supported route",
        role: { kind: "topic", role: "topic" },
        initialParent: proposed("new_prefix_3"),
        resolvedPageId: null
      }
    ],
    remainingPath: Array.from({ length: 4 }, (_, i) => ({
      key: `new_prefix_${i}`,
      title: `Continuation ${i}`,
      purpose: "Required continuation route",
      role: { kind: "topic", role: "topic" },
      initialParent: i ? proposed("new_prefix_" + (i - 1)) : null,
      chunkIds: [chunk]
    })),
    resolvedPrefix: [],
    reason: "context",
    completedGroupIds: [],
    currentChildRunId: null
  });
  function prefixChange(s: HierarchySnapshot, route: typeof s.continuationRoute, length: number) {
    const r = route!;
    return change(s, {
      targets: [],
      ancestors: r.remainingPath.slice(0, length).map((p, i) => ({
        handle: p.key,
        title: p.title,
        purpose: p.purpose,
        role: p.role,
        initialParent: resolveHierarchyRouteParent(p.initialParent, r)
      })),
      continuation: {
        routeId: r.routeId,
        fingerprint: r.fingerprint,
        intendedTargetKeys: r.intendedTargets.map((t) => t.key),
        nextParents: [{ reference: "proposed", handle: r.remainingPath[length - 1]!.key }]
      }
    });
  }
  async function admitPrefix(s: HierarchySnapshot, r: typeof route, length: number) {
    const proposal = prefixChange(s, r, length),
      runId = await pending({ ...s, parentBootstrapId: ownerId, continuationRoute: r }, proposal);
    const bound = { ...r, currentChildRunId: runId };
    await db.query("update organization_runs set snapshot=$2 where id=$1", [
      runId,
      { ...s, parentBootstrapId: ownerId, continuationRoute: bound }
    ]);
    await db.query("update organization_runs set checkpoint=$2 where id=$1", [
      ownerId,
      { state: "running", hierarchy: { routes: [bound], outcome: "pending" } }
    ]);
    return runId;
  }
  const prefixRun = await admitPrefix(prefixSnapshot, route, 2);
  assert.equal((await apply(prefixRun)).length, 2);
  const afterPrefix = (await runs.get(ownerId))!.checkpoint.hierarchy.routes[0];
  assert.equal(afterPrefix.state, "partial");
  assert.equal(afterPrefix.remainingPath.length, 2);
  assert.equal(afterPrefix.resolvedPrefix.length, 2);
  assert.deepEqual(await apply(prefixRun), await apply(prefixRun));
  const resumeSnapshot = await snapshot(
    mainPolicy,
    afterPrefix.resolvedPrefix.map((p: { pageId: string }) => p.pageId)
  );
  assert.equal(resumeSnapshot.placement.fingerprint, afterPrefix.fingerprint.branchFingerprint);
  const resumedRun = await admitPrefix(resumeSnapshot, afterPrefix, 2);
  assert.equal((await apply(resumedRun)).length, 2);
  const afterResume = (await runs.get(ownerId))!.checkpoint.hierarchy.routes[0];
  assert.equal(afterResume.remainingPath.length, 0);
  assert.equal(afterResume.state, "partial", "Prefix completion cannot claim the unresolved leaf");
  const finishSnapshot = await snapshot(
    mainPolicy,
    afterResume.resolvedPrefix.map((p: { pageId: string }) => p.pageId)
  );
  const finalTarget = {
    ...topic("new_final_leaf", "Later findings"),
    purpose: "Complete supported route",
    initialParent: parentRef(finishSnapshot, afterResume.resolvedPrefix.at(-1).pageId)
  };
  const finishProposal = change(finishSnapshot, { targets: [finalTarget] });
  const finishRun = await pending(
    { ...finishSnapshot, parentBootstrapId: ownerId, continuationRoute: afterResume },
    finishProposal
  );
  const finishRoute = { ...afterResume, currentChildRunId: finishRun };
  await db.query("update organization_runs set snapshot=$2 where id=$1", [
    finishRun,
    { ...finishSnapshot, parentBootstrapId: ownerId, continuationRoute: finishRoute }
  ]);
  await db.query("update organization_runs set checkpoint=$2 where id=$1", [
    ownerId,
    { state: "running", hierarchy: { routes: [finishRoute], outcome: "partial" } }
  ]);
  const finalReceipt = await apply(finishRun);
  const finished = (await runs.get(ownerId))!.checkpoint.hierarchy;
  assert.equal(finished.outcome, "complete");
  assert.equal(finished.routes[0].intendedTargets[0].resolvedPageId, finalReceipt[0]!.pageId);
  const forged = await snapshot(),
    forgedProposal = prefixChange(forged, route, 1),
    forgedRun = await pending({ ...forged, continuationRoute: route }, forgedProposal);
  await assert.rejects(apply(forgedRun), /scope/);
  const pause = await snapshot(),
    pauseRun = await pending(pause, change(pause));
  await db.query(
    "insert into wiki_policy_activations(policy_id,revision_id,state,created_at) values($1,$2,'paused',clock_timestamp())",
    [mainPolicy.id, mainPolicy.revisionId]
  );
  await assert.rejects(apply(pauseRun, true), /policy/);

  // The normal current service admits, calls the existing adapter twice, audits and applies.
  for (const targetCount of [1, 2, 6, 12]) {
    const inputSource = await createSourceItemRepository(db).create({
      type: "PersonalNote",
      title: "Cobaltquartz" + targetCount
    });
    await original(
      inputSource.id,
      "Cobaltquartz" + targetCount + " Euclidean" + targetCount + " Quaternary" + targetCount + "."
    );
    const servicePolicy = HierarchyPolicySchema.parse({
      ...mainPolicy,
      id: randomUUID(),
      revisionId: randomUUID(),
      scope: { ...mainPolicy.scope, sourceIds: [inputSource.id] },
      limits: { ...mainPolicy.limits, targets: targetCount }
    });
    await repo.draft(servicePolicy, {}, "service-fixture");
    await repo.activate(servicePolicy.id, servicePolicy.revisionId, "service-fixture");
    let proposeMove = false;
    const prompts: string[] = [],
      service = new WikiCurator({
        getPool: () => db,
        contentLanguage: async () => "en",
        wake: () => {},
        cancelJob: async () => {},
        ai: {
          pinOrganizationProfile: async () => profile,
          runOrganizationTask: async (_profile, input, context, signal, _maxOutput, guard) => {
            await guard?.();
            signal?.throwIfAborted();
            await context.onProviderStart?.();
            prompts.push(input);
            const current = (await runs.get(context.organizationRunId!))!;
            const sourceHandle =
              "r" +
              (current.snapshot.references.findIndex((r: { kind: string }) => r.kind === "source") +
                1);
            const areaHandle =
              "r" +
              (current.snapshot.references.findIndex(
                (r: { id: string }) => r.id === wikiAreaIds.themes
              ) +
                1);
            const ancestors =
              targetCount === 2
                ? Array.from({ length: 5 }, (_, i) => ({
                    handle: "new_service_path_" + i,
                    title: "Service category " + i,
                    purpose: "Required supported reading path",
                    role: { kind: "topic", role: "topic" },
                    initialParent: i ? "new_service_path_" + (i - 1) : areaHandle
                  }))
                : [];
            const draft = {
              explanation: "Place independent source findings",
              topics: Array.from({ length: targetCount === 2 ? 1 : targetCount }, (_, i) => ({
                handle: "new_service_leaf_" + i,
                title: "Service leaf " + targetCount + " " + i,
                purpose: "Read exact independent finding " + targetCount + " " + i,
                initialParent: targetCount === 2 ? "new_service_path_4" : areaHandle,
                sections: [
                  {
                    id: null,
                    title: "Finding",
                    markdown: "Complete independent fixture observation [e1]",
                    originalHandles: ["e1"]
                  }
                ],
                links: []
              })),
              indexes:
                targetCount === 2
                  ? [
                      {
                        handle: "new_service_index",
                        title: "Service reading",
                        purpose: "Read original evidence",
                        initialParent: "new_service_leaf_0",
                        owner: { topic: "new_service_leaf_0" },
                        groups: [
                          {
                            id: null,
                            title: "Originals",
                            explanation: null,
                            originalHandles: [],
                            targets: [{ target: sourceHandle, purpose: "source" }]
                          }
                        ]
                      }
                    ]
                  : [],
              entities: [],
              ancestors,
              moves: []
            };
            const moveDraft = {
              explanation: "Review the exact supported placement",
              topics: [],
              indexes: [],
              entities: [],
              ancestors: [],
              moves: [
                {
                  handle:
                    "r" +
                    (current.snapshot.references.findIndex(
                      (r: { id: string }) => r.id === current.snapshot.pages[0]?.id
                    ) +
                      1),
                  toParent: areaHandle,
                  reason: "Restore the supported scoped reading destination"
                }
              ]
            };
            const output =
              context.stage === "support"
                ? {
                    supported: true,
                    checkedTargets: hierarchyChangedHandles(current.checkpoint.proposal),
                    issues: []
                  }
                : proposeMove
                  ? moveDraft
                  : draft;
            const aiTaskRunId = await createAiConfigRepository(db).recordTaskRun({
              organizationRunId: context.organizationRunId,
              organizationStep: context.organizationStep,
              taskType: "structured-output",
              provider: "synthetic",
              modelId: "fixture",
              runtime: "test",
              durationMs: 1,
              status: "succeeded",
              promptCompositions: promptAudit(input),
              inputTokens: 100,
              outputTokens: 50
            });
            return { output, aiTaskRunId, inputTokens: 100, outputTokens: 50 };
          }
        } as never
      });
    const admitted = await service.start({
      policyId: servicePolicy.id,
      policyRevisionId: servicePolicy.revisionId,
      sourceIds: [inputSource.id],
      noteIds: []
    });
    assert.ok(admitted);
    assert.equal(admitted.snapshot.limits.targets, targetCount);
    assert.ok(
      admitted.snapshot.placement.pages.some(
        (p) => p.pageId === wikiAreaIds.themes && p.canReceiveChildren && !p.canEdit
      )
    );
    const job = (await db.query("select * from jobs where id=$1", [admitted.jobId])).rows[0];
    await service.execute(job, new AbortController().signal);
    const executed = (await service.get(admitted.id))!;
    assert.equal(executed.status, "applied");
    assert.equal(prompts.length, 2);
    assert.equal(executed.checkpoint.calls, 2);
    assert.equal(
      (await db.query("select targets from wiki_group_receipts where run_id=$1", [admitted.id]))
        .rows[0].targets.length,
      targetCount + (targetCount === 2 ? 5 : 0)
    );
    await service.execute(job, new AbortController().signal);
    assert.equal(prompts.length, 2, "Applied service replay never invokes inference");
    const repeated = await service.start({
      policyId: servicePolicy.id,
      policyRevisionId: servicePolicy.revisionId,
      sourceIds: [inputSource.id],
      noteIds: []
    });
    assert.equal(
      repeated!.id,
      admitted.id,
      "Repeated current admission returns the original receipt after its own placements"
    );
    assert.equal(prompts.length, 2);
    if (targetCount === 1) {
      const committed = (
        await db.query("select targets from wiki_group_receipts where run_id=$1", [admitted.id])
      ).rows[0].targets[0];
      let page = WikiPageSchema.parse(await wiki.get(committed.pageId));
      const originalSections = structuredClone(page.sections),
        generation = await repo.editorialGeneration([inputSource.id]);
      const areaBefore = await hierarchy.inventory(servicePolicy, {
        pageIds: [wikiAreaIds.themes]
      });
      await wiki.save({
        version: 2,
        id: page.id,
        expectedRevisionId: page.revisionId,
        content: { ...WikiPageContentSchema.strip().parse(page), pinned: true, position: 42 },
        evidenceChunkIds: []
      });
      assert.equal(
        await repo.editorialGeneration([inputSource.id]),
        generation,
        "Pin/order-only revisions do not trigger ordinary prose analysis"
      );
      assert.equal(
        (await service.start({
          policyId: servicePolicy.id,
          policyRevisionId: servicePolicy.revisionId,
          sourceIds: [inputSource.id],
          noteIds: []
        }))!.id,
        admitted.id,
        "Pin/order-only changes retain the content receipt"
      );
      page = WikiPageSchema.parse(await wiki.get(page.id));
      await wiki.save({
        version: 2,
        id: page.id,
        expectedRevisionId: page.revisionId,
        content: { ...WikiPageContentSchema.strip().parse(page), parentId: wikiAreaIds.maps },
        evidenceChunkIds: []
      });
      assert.notEqual(
        await repo.editorialGeneration([inputSource.id]),
        generation,
        "A manual move changes ordinary editorial generation without prose edits"
      );
      assert.deepEqual(
        await hierarchy.inventory(servicePolicy, { pageIds: [wikiAreaIds.themes] }),
        areaBefore,
        "An unrelated descendant placement does not alter reserved destination metadata"
      );
      proposeMove = true;
      const movedAdmission = (await service.start({
        policyId: servicePolicy.id,
        policyRevisionId: servicePolicy.revisionId,
        sourceIds: [inputSource.id],
        noteIds: []
      }))!;
      assert.notEqual(movedAdmission.id, admitted.id);
      const movedJob = (await db.query("select * from jobs where id=$1", [movedAdmission.jobId]))
        .rows[0];
      await service.execute(movedJob, new AbortController().signal);
      assert.equal((await service.get(movedAdmission.id))!.status, "awaiting_review");
      assert.equal(prompts.length, 4);
      const supportedMove = (await service.get(movedAdmission.id))!;
      assert.equal(supportedMove.candidateSupportMatches, true);
      await db.query(
        "update organization_runs set checkpoint=jsonb_set(checkpoint,'{supportAssessment,proposalHash}',to_jsonb($2::text)) where id=$1",
        [movedAdmission.id, "stale-same-handles"]
      );
      assert.equal(
        (await service.get(movedAdmission.id))!.candidateSupportMatches,
        false,
        "Review DTO does not trust a same-handle stale support verdict"
      );
      await db.query(
        "update organization_runs set checkpoint=jsonb_set(checkpoint,'{supportAssessment,proposalHash}',to_jsonb($2::text)) where id=$1",
        [movedAdmission.id, supportedMove.checkpoint.supportAssessment!.proposalHash]
      );
      await service.command({ command: "accept", id: movedAdmission.id });
      assert.equal((await service.get(movedAdmission.id))!.status, "applied");
      assert.equal(prompts.length, 4, "Accepting supported movement invokes no inference");
      assert.deepEqual(WikiPageSchema.parse(await wiki.get(page.id)).sections, originalSections);
    }
  }
  // Real collection entrypoints: targets=1 separates the substantive topic and
  // required TOC; resource continuation resumes a retained synthesis after restart.
  for (const previous of await repo.policies())
    if (previous.state === "enabled") await repo.pause(previous.id);
  await db.query(
    "update jobs set status='succeeded',finished_at=now() where status in('queued','running')"
  );
  let auditFixture: {
    parent: import("@app/domain").WikiBootstrap;
    child: import("@app/domain").CuratorRun;
  } | null = null;
  for (const scenario of [
    "single",
    "review",
    "forest_fits",
    "forest",
    "packed",
    "maintenance",
    "admitted_expiry",
    "stale",
    "canceled",
    "uncertain",
    "rejected"
  ] as const) {
    const forest = ["forest", "forest_fits"].includes(scenario),
      packed = scenario === "packed",
      resourceRoute = !["single", "review", "forest_fits", "packed"].includes(scenario),
      installed = ["maintenance", "admitted_expiry"].includes(scenario),
      negative = ["stale", "canceled", "uncertain", "rejected"].includes(scenario);
    const topicCount = forest ? 2 : packed ? 3 : 1;
    const inputSource = await createSourceItemRepository(db).create({
      type: "PersonalNote",
      title: scenario + "zygomatic" + randomUUID().replaceAll("-", "")
    });
    await original(
      inputSource.id,
      inputSource.title + " Quasaryttrium" + randomUUID().replaceAll("-", "")
    );
    const p = HierarchyPolicySchema.parse({
      ...mainPolicy,
      id: randomUUID(),
      revisionId: randomUUID(),
      scope: { ...mainPolicy.scope, sourceIds: [inputSource.id] },
      limits: { ...mainPolicy.limits, targets: forest ? 4 : packed ? 3 : resourceRoute ? 2 : 1 }
    });
    const automaticRepo = createAutomaticMaintenanceRepository(db),
      maintenancePreview = installed ? await automaticRepo.preview(p, "UTC") : null;
    if (maintenancePreview && scenario === "maintenance")
      maintenancePreview.routines.find((r) => r.policy.kind === "daily")!.policy.allowance.calls =
        1;
    await repo.draft(
      p,
      maintenancePreview ? { maintenance: maintenancePreview } : {},
      "collection-fixture"
    );
    await repo.activate(p.id, p.revisionId, "collection-fixture");
    // Earlier isolated scenarios deliberately share this cluster. Seed only their
    // wholly unrelated exclusions; current-source impacts use normal delivery.
    await db.query(
      "insert into knowledge_impact_deliveries(event_id,consumer,consumer_key,input_generation,status,receipt) select e.id,'curator',$1,e.fingerprint||':'||$2,'acknowledged',jsonb_build_object('kind','excluded','reason','outside_fixture_scope') from knowledge_impact_events e where not(e.source_ids ? $3) on conflict do nothing",
      [p.id, p.revisionId, inputSource.id]
    );
    assert.equal(
      (
        await db.query(
          "select count(*)::int n from knowledge_impact_deliveries d join knowledge_impact_events e on e.id=d.event_id where d.consumer_key=$1 and e.source_ids ? $2 and d.status='acknowledged'",
          [p.id, inputSource.id]
        )
      ).rows[0].n,
      0,
      "Fixture isolation never pre-settles a current-source delivery"
    );
    const calls: Array<{ runId: string; stage: string }> = [];
    const options: ConstructorParameters<typeof WikiCurator>[0] = {
      getPool: () => db,
      contentLanguage: async () => "en",
      wake: () => {},
      cancelJob: async () => {},
      ...(resourceRoute ? { hierarchyResources: { maxProposalBytes: forest ? 4000 : 2500 } } : {}),
      ai: {
        pinOrganizationProfile: async () => profile,
        runOrganizationTask: async (_profile, input, context, signal, _max, guard) => {
          await guard?.();
          signal?.throwIfAborted();
          if (scenario === "uncertain" && context.stage === "support") {
            const current = (await service.get(context.organizationRunId!))!,
              parent = (await collections.get(current.snapshot.parentBootstrapId!))!;
            const race = await Promise.allSettled([
              context.onProviderStart!(),
              collections.deferUnstartedRouteChild(parent, current.id)
            ]);
            assert.equal(race[0].status, "fulfilled");
            assert.deepEqual(
              race[1],
              { status: "fulfilled", value: false },
              "A provider-starting attempt cannot be retired"
            );
          } else await context.onProviderStart?.();
          const current = (await runs.get(context.organizationRunId!))!,
            s = current.snapshot;
          calls.push({ runId: current.id, stage: context.stage! });
          const ref = (id: string) =>
              "r" + (s.references.findIndex((r: { id: string }) => r.id === id) + 1),
            sourceRef = ref(inputSource.id),
            area = ref(wikiAreaIds.themes),
            owner = s.structuralIntent?.owners[0]?.pageId
              ? ref(s.structuralIntent.owners[0].pageId)
              : "new_collection_leaf";
          const ancestors =
            (resourceRoute || forest) && !s.structuralIntent
              ? Array.from({ length: forest ? 7 : 9 }, (_, i) => ({
                  handle: "new_collection_path_" + i,
                  title: "Reading category " + i,
                  purpose:
                    "Required supported editorial route " +
                    i +
                    " " +
                    "source category ".repeat(forest ? 40 : 12),
                  role: { kind: "topic", role: "topic" },
                  initialParent: i ? "new_collection_path_" + (forest && i === 4 ? 0 : i - 1) : area
                }))
              : [];
          const owners =
            s.structuralIntent?.owners.map((o: { pageId: string }) => ref(o.pageId)) ??
            Array.from({ length: topicCount }, (_, i) => "new_collection_leaf_" + i);
          const indexes = owners.map((owner: string, i: number) => ({
            handle: "new_collection_toc_" + i,
            title: "Collection reading " + i,
            purpose: "Read complete original material",
            initialParent: owner,
            owner: { topic: owner },
            groups: [
              {
                id: null,
                title: "Originals",
                explanation: null,
                originalHandles: [],
                targets: [
                  { target: sourceRef, purpose: "source" },
                  ...(forest && i === 0
                    ? [{ target: "new_collection_toc_1", purpose: "subtopic" }]
                    : [])
                ]
              }
            ]
          }));
          const draft = {
            explanation: "Organize supported collection",
            topics: s.structuralIntent
              ? []
              : Array.from({ length: topicCount }, (_, i) => ({
                  handle: "new_collection_leaf_" + i,
                  title: "Substantive collection finding " + i,
                  purpose: "Read complete source findings",
                  initialParent: forest
                    ? "new_collection_path_" + (i ? 6 : 3)
                    : resourceRoute
                      ? "new_collection_path_8"
                      : scenario === "review"
                        ? null
                        : area,
                  sections: [
                    {
                      id: null,
                      title: "Finding",
                      markdown: "Complete original observation [e1]",
                      originalHandles: ["e1"]
                    }
                  ],
                  links: resourceRoute || forest ? ["new_collection_path_0"] : []
                })),
            indexes: s.structuralIntent || resourceRoute || forest ? indexes : [],
            entities: [],
            ancestors,
            moves: []
          };
          if (scenario === "uncertain" && s.continuationRoute && context.stage === "support")
            throw new Error("Synthetic lost provider acknowledgment");
          const output =
            context.stage === "support"
              ? {
                  supported: scenario !== "rejected",
                  checkedTargets: hierarchyChangedHandles(current.checkpoint.proposal),
                  issues:
                    scenario === "rejected"
                      ? [{ path: "ancestors.0.title", message: "Unsupported classification" }]
                      : []
                }
              : s.structuralIntent?.kind === "unplaced"
                ? {
                    explanation: "Review existing placement",
                    topics: [],
                    indexes: [],
                    entities: [],
                    ancestors: [],
                    moves: [
                      {
                        handle: owner,
                        toParent: area,
                        reason: "Use the supported canonical reading destination"
                      }
                    ]
                  }
                : draft;
          const aiTaskRunId = await createAiConfigRepository(db).recordTaskRun({
            organizationRunId: context.organizationRunId,
            organizationStep: context.organizationStep,
            taskType: "structured-output",
            provider: "synthetic",
            modelId: "fixture",
            runtime: "test",
            durationMs: 1,
            status: "succeeded",
            promptCompositions: promptAudit(input),
            inputTokens: 100,
            outputTokens: 50
          });
          return { output, aiTaskRunId, inputTokens: 100, outputTokens: 50 };
        }
      } as never
    };
    const collections = createWikiCollectionRepository(db),
      service = new WikiCurator(options);
    let collection = new WikiCollection(options);
    const automatic = new AutomaticMaintenance({
      ...options,
      idleSeconds: () => 1000,
      aiBusy: () => false
    });
    const bootstrap = (await collection.command({
      command: "bootstrap",
      input: {
        policyId: p.id,
        policyRevisionId: p.revisionId,
        sourceIds: [inputSource.id],
        includeExistingNotes: true
      }
    })) as import("@app/domain").WikiBootstrap;
    let paused = false,
      finished = false,
      stopped = false,
      handedOff = false,
      oldOccurrence: string | null = null,
      oldReservation: unknown = null,
      expiredChild: string | null = null;
    for (let step = 0; step < 300; step++) {
      if (installed) await automatic.tick();
      await collection.tick();
      const current = (await collections.get(bootstrap.id))!;
      if (
        scenario === "admitted_expiry" &&
        current.checkpoint.state === "attention" &&
        current.checkpoint.error === "organization.errors.deadline" &&
        !current.checkpoint.childRunId
      ) {
        await automatic.tick();
        const old = (await automaticRepo.get(oldOccurrence!))!;
        assert.equal(old.status, "failed");
        assert.deepEqual(old.reservation, oldReservation);
        const weekly = (await automaticRepo.schedules(p.id)).find(
          (s) => s.policy.kind === "weekly"
        )!;
        await automatic.command({
          command: "automaticRun",
          scheduleId: weekly.id,
          requestId: randomUUID()
        });
        handedOff = true;
        continue;
      }
      if (
        installed &&
        current.checkpoint.state === "attention" &&
        current.checkpoint.error === "maintenance.errors.budget" &&
        !current.checkpoint.childRunId
      ) {
        if (handedOff) continue;
        assert.ok(
          current.checkpoint.hierarchy!.routes[0]!.resolvedPrefix.length > 0,
          "Recorded budget exhaustion follows a committed prefix in the old occurrence"
        );
        await automatic.tick();
        const old = (await automaticRepo.history(p.id))[0]!;
        oldOccurrence = old.id;
        oldReservation = old.reservation;
        assert.equal(old.status, "failed");
        assert.equal(old.usage.calls, 2);
        assert.equal(
          (
            await db.query(
              "select count(*)::int n from wiki_group_receipts g join organization_runs c on c.id=g.run_id where c.snapshot->>'maintenanceRunId'=$1 and c.snapshot->>'continuationRoute' is not null",
              [old.id]
            )
          ).rows[0].n,
          1,
          "The old occurrence owns the committed prefix receipt"
        );
        const weekly = (await automaticRepo.schedules(p.id)).find(
          (s) => s.policy.kind === "weekly"
        )!;
        await automatic.command({
          command: "automaticRun",
          scheduleId: weekly.id,
          requestId: randomUUID()
        });
        handedOff = true;
        continue;
      }
      if (
        scenario === "review" &&
        current.checkpoint.state === "attention" &&
        current.checkpoint.childRunId
      ) {
        const child = (await service.get(current.checkpoint.childRunId))!,
          beforeCalls = calls.length;
        assert.equal(child.status, "awaiting_review");
        const page = WikiPageSchema.parse(await wiki.get(child.snapshot.requiredPageIds[0]!)),
          sections = page.sections;
        await service.command({ command: "accept", id: child.id });
        assert.deepEqual(WikiPageSchema.parse(await wiki.get(page.id)).sections, sections);
        assert.equal(
          calls.length,
          beforeCalls,
          "Accepting retained structural move requires no inference"
        );
        continue;
      }
      if (negative && current.checkpoint.state !== "running") {
        stopped = true;
        break;
      }
      if (current.checkpoint.state === "complete") {
        finished = true;
        break;
      }
      assert.equal(current.checkpoint.state, "running", JSON.stringify(current.checkpoint));
      if (
        resourceRoute &&
        !paused &&
        current.checkpoint.hierarchy?.routes[0]?.resolvedPrefix.length &&
        !current.checkpoint.childRunId
      ) {
        if (scenario === "stale") {
          const prefix = current.checkpoint.hierarchy!.routes[0]!.resolvedPrefix[0]!,
            page = WikiPageSchema.parse(await wiki.get(prefix.pageId));
          await wiki.save({
            version: 2,
            id: page.id,
            expectedRevisionId: page.revisionId,
            content: {
              ...WikiPageContentSchema.strip().parse(page),
              title: "Human changed exact prefix"
            },
            evidenceChunkIds: []
          });
          paused = true;
          continue;
        }
        if (scenario === "canceled") {
          await collection.command({ command: "bootstrapCancel", id: bootstrap.id });
          paused = true;
          continue;
        }
        const beforeCalls = calls.length;
        await collection.command({ command: "bootstrapPause", id: bootstrap.id });
        await collection.tick();
        assert.equal(calls.length, beforeCalls);
        collection = new WikiCollection(options);
        await collection.command({ command: "bootstrapResume", id: bootstrap.id });
        paused = true;
      }
      if (current.checkpoint.childRunId) {
        const child = (await service.get(current.checkpoint.childRunId))!;
        if (child.status === "queued") {
          if (scenario === "admitted_expiry" && !expiredChild && child.snapshot.continuationRoute) {
            auditFixture = { parent: structuredClone(current), child: structuredClone(child) };
            expiredChild = child.id;
            oldOccurrence = child.snapshot.maintenanceRunId!;
            const owner = (await automaticRepo.get(oldOccurrence))!;
            oldReservation = structuredClone(owner.reservation);
            owner.checkpoint.executionMs = owner.snapshot.policy.executionMs;
            await automaticRepo.checkpoint(owner);
          }
          const job = (await db.query("select * from jobs where id=$1", [child.jobId])).rows[0];
          try {
            await service.execute(job, new AbortController().signal);
          } catch (error) {
            assert.match(
              String(error),
              /scopeLimit|uncertain|evidence|deadline/,
              JSON.stringify((await service.get(child.id))?.checkpoint)
            );
          }
          if (child.id === expiredChild && !handedOff) {
            const parent = (await collections.get(bootstrap.id))!,
              race = await Promise.allSettled([
                collections.deferUnstartedRouteChild(parent, child.id),
                runs.modelStarted(child.id, 1)
              ]);
            assert.deepEqual(race[0], { status: "fulfilled", value: true });
            assert.equal(
              race[1].status,
              "rejected",
              "Retirement prevents a late provider callback"
            );
          }
          if (
            child.snapshot.continuationRoute &&
            (await service.get(child.id))!.status === "applied"
          )
            await assert.rejects(
              collections.checkpoint(current),
              /conflict/,
              "A stale coordinator cannot overwrite transactional route progress"
            );
          await db.query(
            "update jobs set status='succeeded',finished_at=now() where id=$1 and status<>'canceled'",
            [child.jobId]
          );
        }
      }
    }
    if (negative) {
      assert.ok(stopped);
      const stoppedRun = (await collections.get(bootstrap.id))!,
        beforeCalls = calls.length;
      assert.equal(
        stoppedRun.checkpoint.state,
        scenario === "canceled" ? "canceled" : scenario === "rejected" ? "rejected" : "attention"
      );
      if (scenario === "stale")
        assert.equal(stoppedRun.checkpoint.error, "organization.errors.conflict");
      if (scenario === "uncertain")
        assert.equal(stoppedRun.checkpoint.error, "organization.errors.uncertain");
      for (let i = 0; i < 3; i++) await new WikiCollection(options).tick();
      assert.equal(
        calls.length,
        beforeCalls,
        "Canceled, uncertain, stale and rejected routes do not replay inference"
      );
      assert.notEqual(stoppedRun.checkpoint.hierarchy!.routes[0]!.state, "complete");
      await repo.pause(p.id);
      continue;
    }
    assert.ok(finished, "Collection reached source + note + structure completion");
    const done = (await collections.get(bootstrap.id))!;
    assert.ok(done.checkpoint.contentComplete && done.checkpoint.notesComplete);
    assert.ok(["complete", "no_change"].includes(done.checkpoint.hierarchy!.outcome));
    const pages = await repo.pages([inputSource.id]);
    assert.equal(
      pages.filter((p) => p.kind === "topic" && p.sections.length).length,
      topicCount,
      "No duplicate substantive topics"
    );
    assert.equal(
      pages.filter((p) => p.automatic?.role.role === "topic_toc").length,
      topicCount,
      "One canonical owned TOC per topic"
    );
    if (resourceRoute) {
      assert.ok(paused);
      if (installed) {
        assert.ok(handedOff);
        assert.deepEqual(
          (await automaticRepo.get(oldOccurrence!))!.reservation,
          oldReservation,
          "Later authority does not refund consumed reservations"
        );
      }
      const route = done.checkpoint.hierarchy!.routes[0]!;
      assert.equal(route.state, "complete");
      assert.equal(route.remainingPath.length, 0);
      assert.equal(route.resolvedPrefix.length, forest ? 7 : 9);
      assert.equal(
        calls.filter((c) => c.stage === "curate").length,
        1,
        "Retained route synthesis is never replayed"
      );
      assert.ok((await service.get(route.planningRunId!))!.checkpoint.continuationComplete);
    } else
      assert.equal(
        calls.length,
        forest ? 2 : scenario === "review" ? 6 : 4,
        "One synthesis/support pair per exact topic, owned TOC and optional reviewed move"
      );
    if (expiredChild) {
      const old = (await service.get(expiredChild))!;
      assert.equal(old.checkpoint.calls, 0);
      assert.ok(old.checkpoint.routeDeferral?.successorRunId);
      assert.equal(
        (await service.get(old.checkpoint.routeDeferral!.successorRunId!))!.snapshot
          .continuedFromRunId,
        old.id
      );
      assert.equal(calls.filter((c) => c.runId === old.id).length, 0);
      assert.equal(
        (
          await db.query(
            "select count(*)::int n from organization_steps s join ai_task_runs a on a.id=s.ai_task_run_id where s.run_id=$1",
            [old.id]
          )
        ).rows[0].n,
        0
      );
      await assert.rejects(runs.modelStarted(old.id, 1), /canceled/);
      await assert.rejects(runs.retry(old.id), /budget/);
    }
    if (resourceRoute) {
      const automationTasks = createKnowledgeAutomationRepository(db),
        plannerId = done.checkpoint.hierarchy!.routes[0]!.planningRunId!;
      const listTasks = async (attention: boolean) => {
        const items: Awaited<ReturnType<typeof automationTasks.tasks>>["tasks"] = [];
        let offset: number | null = 0;
        while (offset !== null) {
          const page = await automationTasks.tasks(offset, attention);
          items.push(...page.tasks);
          offset = page.next;
        }
        return items;
      };
      const history = await listTasks(false),
        plannerTask = history.find((t) => t.id === plannerId)!;
      assert.equal(plannerTask.status, "superseded");
      assert.equal(plannerTask.relatedRunId, bootstrap.id);
      assert.equal(plannerTask.relatedRunVersion, "wiki-bootstrap-v1");
      assert.equal(plannerTask.reason, "organization.errors.scopeLimit");
      assert.ok(
        !(await listTasks(true)).some((t) => t.id === plannerId || t.id === expiredChild),
        "Linked historical attempts are not actionable failures"
      );
      assert.equal((await service.get(plannerId))!.status, "failed");
      assert.equal(
        (
          await db.query("select count(*)::int n from wiki_group_receipts where run_id=$1", [
            plannerId
          ])
        ).rows[0].n,
        0
      );
      if (expiredChild) {
        const old = (await service.get(expiredChild))!;
        assert.equal(history.find((t) => t.id === old.id)!.status, "superseded");
        assert.equal(
          history.find((t) => t.id === old.id)!.relatedRunId,
          old.checkpoint.routeDeferral!.successorRunId
        );
      }
      const projectionClient = await db.connect();
      try {
        await projectionClient.query("begin");
        const event = (
          await projectionClient.query(
            "insert into knowledge_impact_events(kind,input_id,operation,fingerprint,source_ids) values('source',$1,'update','retained-planner-review',$2) returning id",
            [inputSource.id, JSON.stringify([inputSource.id])]
          )
        ).rows[0].id;
        const retainedReceipt = {
          kind: "attention",
          runId: bootstrap.id,
          reason: "organization.errors.scopeLimit"
        };
        const delivery = (
          await projectionClient.query(
            "insert into knowledge_impact_deliveries(event_id,consumer,consumer_key,input_generation,status,checkpoint,receipt) values($1,'curator',$2,$3,'acknowledged',$4,$5) returning id",
            [
              event,
              p.id,
              "retained-planner:" + p.revisionId,
              {
                bootstrapId: bootstrap.id,
                childRunId: plannerId,
                blockedReason: "organization.errors.scopeLimit"
              },
              retainedReceipt
            ]
          )
        ).rows[0].id;
        const projected = createKnowledgeAutomationRepository(
          projectionClient as unknown as PgPool
        );
        const deliveries = async () => {
          const items: Awaited<ReturnType<typeof projected.deliveries>>["items"] = [];
          let offset: number | null = 0;
          while (offset !== null) {
            const page = await projected.deliveries(p.id, [inputSource.id], offset, p.revisionId);
            items.push(...page.items);
            offset = page.next;
          }
          return items;
        };
        assert.notEqual(
          (await deliveries()).find((d) => d.id === delivery)!.status,
          "blocked",
          "A settled continuation does not inherit its historical planner failure"
        );
        await projectionClient.query(
          "update organization_runs set status='failed',checkpoint=jsonb_set(jsonb_set(checkpoint,'{state}','\"attention\"'),'{error}', '\"organization.errors.conflict\"') where id=$1",
          [bootstrap.id]
        );
        const unresolved = (await deliveries()).find((d) => d.id === delivery)!;
        assert.equal(unresolved.status, "blocked");
        assert.equal(
          unresolved.reason,
          "organization.errors.conflict",
          "An unresolved actual continuation remains visible"
        );
        assert.deepEqual(
          (
            await projectionClient.query(
              "select receipt from knowledge_impact_deliveries where id=$1",
              [delivery]
            )
          ).rows[0].receipt,
          retainedReceipt,
          "Projection preserves the original attention receipt"
        );
      } finally {
        await projectionClient.query("rollback");
        projectionClient.release();
      }
      const prior = (
        await db.query("select value from settings where key='jobs.history.dismissed-through.v1'")
      ).rows[0];
      await db.query(
        "insert into settings(key,value) values('jobs.history.dismissed-through.v1',jsonb_build_object('before',clock_timestamp()+interval '1 second')) on conflict(key) do update set value=excluded.value"
      );
      assert.ok(
        !(await listTasks(false)).some((t) => t.id === plannerId || t.id === expiredChild),
        "History cutoff clears terminal linked attempts"
      );
      assert.equal(
        (await service.get(plannerId))!.status,
        "failed",
        "Display cleanup preserves exact audit access"
      );
      if (prior)
        await db.query(
          "update settings set value=$1 where key='jobs.history.dismissed-through.v1'",
          [prior.value]
        );
      else await db.query("delete from settings where key='jobs.history.dismissed-through.v1'");
    }
    if (forest) {
      const tree = (
        await hierarchy.inventory(p, { pageIds: pages.map((p) => p.id), limit: 300 })
      ).pages.map((p) => ({ ...p, id: p.pageId }));
      const root = tree.find((p) => p.title === "Reading category 0")!;
      assert.equal(tree.filter((p) => p.title === "Reading category 0").length, 1);
      for (let i = 0; i < 2; i++) {
        const leaf = tree.find((p) => p.title === "Substantive collection finding " + i)!;
        assert.equal(
          leaf.parentId,
          tree.find((p) => p.title === "Reading category " + (i ? 6 : 3))!.id
        );
      }
      assert.equal(tree.find((p) => p.title === "Reading category 4")!.parentId, root.id);
      const toc = pages.find((p) => p.title === "Collection reading 0")!;
      assert.ok(
        toc.automatic!.memberships.some(
          (m) =>
            m.purpose === "subtopic" &&
            m.target.id === tree.find((p) => p.title === "Collection reading 1")!.id
        )
      );
    }
    if (packed) {
      const beforeDenied = calls.length;
      await assert.rejects(
        service.start(
          {
            policyId: p.id,
            policyRevisionId: p.revisionId,
            sourceIds: [inputSource.id],
            noteIds: []
          },
          null,
          {
            structuralIntent: {
              kind: "missing_toc",
              owners: [
                { pageId: pages.find((p) => p.kind === "topic")!.id, fingerprint: "allowed" },
                { pageId: leafPage.id, fingerprint: "excluded" }
              ]
            }
          }
        ),
        /scopeDecision/
      );
      assert.equal(
        calls.length,
        beforeDenied,
        "An excluded second owner is rejected before inference"
      );
      const children = (
        await db.query(
          "select id,snapshot from organization_runs where snapshot->>'parentBootstrapId'=$1 and snapshot->>'structuralIntent' is not null",
          [bootstrap.id]
        )
      ).rows;
      assert.equal(children.length, 1);
      assert.equal(children[0].snapshot.structuralIntent.owners.length, 3);
      assert.equal(children[0].snapshot.pages.length, 0);
      assert.equal(calls.filter((c) => c.runId === children[0].id).length, 2);
      for (const page of pages.filter((p) => p.kind === "topic"))
        assert.equal(
          (await wiki.history(page.id)).length,
          1,
          "Packed TOCs do not rewrite owner revisions"
        );
    }
    if (installed) {
      let ancestryReads = 0;
      const counted = {
        query: async (...args: unknown[]) => {
          if (String(args[0]).includes("seeds(id)")) ancestryReads++;
          return (db.query as Function).apply(db, args);
        }
      };
      assert.deepEqual(
        (
          await createWikiCollectionRepository(counted as PgPool).structuralCandidates(
            p,
            null,
            [inputSource.id],
            100
          )
        ).items,
        []
      );
      assert.equal(
        ancestryReads,
        0,
        "Settled daily branches are filtered before lineage expansion"
      );
      for (let drain = 0; drain < 300 && (await automaticRepo.pending(p.id)); drain++) {
        await collection.tick();
        await automatic.tick();
      }
      await automatic.tick();
      const owner = (await automaticRepo.history(p.id)).find((r) => r.id !== oldOccurrence)!;
      assert.ok(["applied", "no_change"].includes(owner.status), JSON.stringify(owner.checkpoint));
      assert.equal(owner.checkpoint.phase, "complete");
    }
    const beforeCalls = calls.length;
    const second = (await collection.command({
      command: "bootstrap",
      input: {
        policyId: p.id,
        policyRevisionId: p.revisionId,
        sourceIds: [inputSource.id],
        includeExistingNotes: true
      }
    })) as import("@app/domain").WikiBootstrap;
    for (
      let step = 0;
      step < 200 && (await collections.get(second.id))!.checkpoint.state !== "complete";
      step++
    ) {
      if (resourceRoute) await automatic.tick();
      await collection.tick();
    }
    assert.equal((await collections.get(second.id))!.checkpoint.state, "complete");
    assert.equal(
      calls.length,
      beforeCalls,
      "Unchanged collection reinspection uses zero inference"
    );
    if (installed) {
      await automatic.tick();
      const count = async () =>
        (
          await db.query(
            "select count(*)::int n from organization_runs where snapshot->>'version'='wiki-bootstrap-v1' and snapshot->'policy'->>'id'=$1",
            [p.id]
          )
        ).rows[0].n;
      const beforeCount = await count(),
        daily = (await automaticRepo.schedules(p.id)).find((s) => s.policy.kind === "daily")!;
      const idle = (await automatic.command({
        command: "automaticRun",
        scheduleId: daily.id,
        requestId: randomUUID()
      })) as import("@app/domain").AutomaticMaintenanceRun;
      assert.equal(idle.status, "no_change");
      assert.equal(idle.checkpoint.bootstrapId, null);
      assert.equal(
        await count(),
        beforeCount,
        "Unchanged daily occurrence creates no redundant bootstrap"
      );
      assert.equal(calls.length, beforeCalls);
    }
    if (scenario === "single") {
      const leaf = pages.find((p) => p.kind === "topic" && p.sections.length)!;
      const originals = (await repo.evidencePage([inputSource.id], null, 12)).items;
      const sibling = await wiki.save({
        version: 2,
        expectedRevisionId: null,
        content: WikiPageContentSchema.parse({
          title: "Independent diagnostic branch",
          kind: "topic",
          parentId: wikiAreaIds.themes,
          sections: [
            {
              id: randomUUID(),
              title: "Independent finding",
              markdown: "Independent original observation",
              kind: "prose",
              provenance: "personal",
              protected: true,
              evidenceReview: "needs_review",
              evidenceIds: [originals[0]!.chunkId]
            }
          ]
        }),
        evidenceChunkIds: [originals[0]!.chunkId]
      });
      const before = await collections.structuralCandidates(p, null, [inputSource.id], 100, true);
      const leafPage = WikiPageSchema.parse(await wiki.get(leaf.id));
      await wiki.save({
        version: 2,
        id: leaf.id,
        expectedRevisionId: leafPage.revisionId,
        content: { ...WikiPageContentSchema.strip().parse(leafPage), parentId: null },
        evidenceChunkIds: []
      });
      const coverageBefore = (
        await db.query(
          "select status from wiki_source_coverage where policy_id=$1 and source_id=$2",
          [p.id, inputSource.id]
        )
      ).rows[0].status;
      const after = await collections.structuralCandidates(p, null, [inputSource.id], 100, true);
      assert.equal(
        after.items.find((i) => i.pageId === sibling)!.fingerprint,
        before.items.find((i) => i.pageId === sibling)!.fingerprint,
        "Unrelated branch placement does not invalidate this diagnostic identity"
      );
      assert.notEqual(
        after.items.find((i) => i.pageId === leaf.id)!.fingerprint,
        before.items.find((i) => i.pageId === leaf.id)!.fingerprint,
        "A noncausal parent-only edit changes the affected branch identity"
      );
      const daily = await collections.structuralCandidates(p, null, [inputSource.id], 100);
      assert.equal(daily.items.find((i) => i.pageId === leaf.id)!.kind, "unplaced");
      assert.equal(daily.items.find((i) => i.pageId === sibling)!.kind, "missing_toc");
      assert.deepEqual(WikiPageSchema.parse(await wiki.get(leaf.id)).sections, leafPage.sections);
      assert.equal(
        (
          await db.query(
            "select status from wiki_source_coverage where policy_id=$1 and source_id=$2",
            [p.id, inputSource.id]
          )
        ).rows[0].status,
        coverageBefore,
        "Structural inspection does not alter source coverage"
      );
    }
    await repo.pause(p.id);
  }
  assert.ok(auditFixture);
  {
    const parentId = randomUUID(),
      childId = randomUUID(),
      groupId = randomUUID(),
      routeId = randomUUID();
    const route = {
      ...auditFixture.child.snapshot.continuationRoute!,
      routeId,
      currentChildRunId: childId
    };
    const parentCheckpoint = {
      ...auditFixture.parent.checkpoint,
      state: "attention",
      error: "organization.errors.deadline",
      childRunId: childId,
      hierarchy: { ...auditFixture.parent.checkpoint.hierarchy!, routes: [route] }
    };
    await db.query(
      "insert into organization_runs(id,status,snapshot,checkpoint) values($1,'failed',$2,$3)",
      [parentId, auditFixture.parent.snapshot, parentCheckpoint]
    );
    const job = (
      await db.query(
        "insert into jobs(type,payload,status) values('organization',$1,'failed') returning id",
        [{ organizationRunId: childId }]
      )
    ).rows[0].id;
    const candidate = auditFixture.child.checkpoint.proposal!;
    const checkpoint = {
      ...auditFixture.child.checkpoint,
      calls: 0,
      callPending: false,
      waitingForModel: false,
      error: "organization.errors.deadline",
      proposal: { ...candidate, groupId, continuation: { ...candidate.continuation!, routeId } }
    };
    await db.query(
      "insert into organization_runs(id,job_id,status,snapshot,checkpoint) values($1,$2,'failed',$3,$4)",
      [
        childId,
        job,
        {
          ...auditFixture.child.snapshot,
          parentBootstrapId: parentId,
          groupId,
          continuationRoute: route
        },
        checkpoint
      ]
    );
    await createAiConfigRepository(db).recordTaskRun({
      organizationRunId: childId,
      organizationStep: 1,
      taskType: "structured-output",
      provider: "synthetic",
      modelId: "fixture",
      runtime: "test",
      durationMs: 1,
      status: "failed",
      error: "Canonical audit contradicts a never-started checkpoint"
    });
    const owner = (await createWikiCollectionRepository(db).get(parentId))!;
    assert.equal(
      await createWikiCollectionRepository(db).deferUnstartedRouteChild(owner, childId),
      false,
      "A canonical audit blocks retirement even if the checkpoint claims zero calls"
    );
    assert.equal((await runs.get(childId))!.checkpoint.routeDeferral, null);
    assert.equal(
      (await createWikiCollectionRepository(db).get(parentId))!.checkpoint.childRunId,
      childId
    );
  }
  console.log(
    "Grouped continuation: fitting forests remain two calls; resource-sized shared roots/branched parents/nested TOCs survive restart; three exact TOC owners share one two-call child with no owner revisions; admitted unstarted expiry retains the ledger and binds a later successor; provider-start/retirement winners and canonical-audit refusal passed."
  );
  console.log(
    "Collection/maintenance: target-one topic and required owned TOC, separate structural completion, resource-sized continuation with exact prefix/original refs, pause/restart, mid-route occurrence exhaustion and later authority preserving the ledger, stale/canceled/uncertain/rejected no replay, selective branch diagnostics, and unchanged daily zero inference passed."
  );
  console.log(
    "Hierarchy fresh PostgreSQL: actual initialized area destinations with immutable reserved ownership, shared pending note across nested TOCs with retained excluded-secondary-lineage rejection, serialized entity-binding and reciprocal-move races, deep 4-ancestor + 2-target transaction, six-target cap, scoped inventory/cursors, shared reuse, protected reviewed move with unchanged section/support/evidence, exact support and stale guards, canonical entity uniqueness/homonyms, archived/cyclic parents, nested TOC cycles, late rollback, excluded lineage, atomic route prefixes/restart/final leaf/replay and pause passed. Actual current service.start/execute completed target allowances 1/2/6/12 with two fixture adapter calls and canonical audit/apply. Synthetic adapters only; no real inference or user database accessed."
  );
} finally {
  if (pool) await closePgPool(pool);
  await manager.stop();
  await rm(dir, { recursive: true, force: true });
}
