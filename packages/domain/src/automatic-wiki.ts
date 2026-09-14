import { InterpretationDraftSchema,NoteEvolutionSchema } from "./knowledge-evolution.js";
import { z } from "zod";

/** A0 contracts only. No policy, executor or migration is activated by importing these. */
export const automaticWikiVersion = "automatic-wiki-v1";
export const hierarchyTargetRange = { min: 1, max: 12, default: 3 } as const;
const id = z.string().uuid();
const fingerprint = z.string().min(1).max(256);
export const KnowledgeTargetSchema = z.object({
  kind: z.enum(["page", "source", "atomic_note", "entity"]), id
}).strict();
export const WikiManagementSchema = z.enum(["ai_managed", "human_managed"]);
export const WikiRoleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("topic"), role: z.literal("topic") }).strict(),
  z.object({ kind: z.literal("entity"), role: z.literal("entity"), entityId: id }).strict(),
  z.object({ kind: z.literal("synthesis"), role: z.enum(["synthesis", "investigation"]) }).strict(),
  z.object({ kind: z.literal("collection"), role: z.enum(["source_toc", "topic_toc", "map"]),
    owner: KnowledgeTargetSchema.nullable() }).strict()
]).superRefine((value, ctx) => {
  if (value.kind !== "collection") return;
  const ownerKind = value.role === "source_toc" ? "source" : value.role === "topic_toc" ? "page" : null;
  if ((ownerKind && value.owner?.kind !== ownerKind) || (!ownerKind && value.owner !== null))
    ctx.addIssue({ code: "custom", path: ["owner"], message: "Invalid collection owner" });
});
export const SectionAssessmentSchema = z.object({
  version: z.literal(automaticWikiVersion), sectionId: id, sectionRevisionId: id,
  supportMethod:z.enum(['structural','model_checked','human_review']).optional(),supportAuditId:id.optional(),
  // Human verification never follows from a structural machine check.
  humanReview: z.enum(["unreviewed", "verified"]),
  support: z.enum(["validated", "unassessed", "invalidated", "unsupported"]),
  reason: z.enum(["generated_pending_verification", "human_verified", "legacy_ambiguous",
    "prose_changed", "input_changed", "missing_original", "structural_failure", "revalidated"]),
  inputFingerprint: fingerprint, freshness: z.enum(["current", "stale", "missing"])
}).strict().superRefine((value, ctx) => {
  if (value.support === "validated" && !["generated_pending_verification", "human_verified", "revalidated"].includes(value.reason))
    ctx.addIssue({ code: "custom", path: ["reason"], message: "Invalidated support cannot be relabeled as validated" });
  if ((value.reason === "input_changed" && value.freshness === "current") || (value.reason === "missing_original" && value.freshness !== "missing"))
    ctx.addIssue({ code: "custom", path: ["freshness"], message: "Freshness must match the assessment reason" });
  if ((value.reason === "generated_pending_verification" && value.humanReview !== "unreviewed") || (value.reason === "human_verified" && value.humanReview !== "verified"))
    ctx.addIssue({ code: "custom", path: ["humanReview"], message: "Human verification must match its reason" });
});
export type SectionAssessment = z.infer<typeof SectionAssessmentSchema>;
export function canConsultSection(assessment: SectionAssessment, currentSectionRevisionId: string, reviewedOnly: boolean): boolean {
  return SectionAssessmentSchema.safeParse(assessment).success && assessment.sectionRevisionId === currentSectionRevisionId && assessment.support === "validated"
    && (assessment.humanReview === "verified" || assessment.supportMethod === "model_checked" && Boolean(assessment.supportAuditId))
    && assessment.freshness === "current" && (!reviewedOnly || assessment.humanReview === "verified");
}
/** Conservative migration classification; does not change any existing record. */
export function legacyWikiManagement(input: { origin: string | null; reviewed: boolean; protected: boolean }): z.infer<typeof WikiManagementSchema> {
  return input.origin === "organization" && !input.reviewed && !input.protected ? "ai_managed" : "human_managed";
}
export const KnowledgeMembershipSchema = z.object({
  version: z.literal(automaticWikiVersion), id, pageId: id, groupId: id,
  target: KnowledgeTargetSchema, purpose: z.enum(["reading", "subtopic", "source", "related"]),
  order: z.number().int().nonnegative(), origin: z.enum(["human", "generated", "deterministic"]),
  placementProtected: z.boolean(), expectedPageRevisionId: id,
  targetFingerprint: fingerprint
}).strict();
export const TocGroupSchema = z.object({
  version: z.literal(automaticWikiVersion), id, collectionId: id, title: z.string().min(1).max(300),
  explanation: z.string().max(6000).nullable(), explanationEvidenceIds: z.array(id).max(20),
  membershipIds: z.array(id).max(200), orderProtected: z.boolean(),
  origin: z.enum(["human", "generated", "deterministic"])
}).strict().superRefine((value, ctx) => {
  if (new Set(value.membershipIds).size !== value.membershipIds.length)
    ctx.addIssue({ code: "custom", path: ["membershipIds"], message: "Duplicate membership" });
  if (value.explanation && !value.explanationEvidenceIds.length)
    ctx.addIssue({ code: "custom", path: ["explanationEvidenceIds"], message: "Substantive explanations require original evidence" });
});
export const CuratorLimitsSchema = z.object({
  targets: z.number().int().min(hierarchyTargetRange.min).max(hierarchyTargetRange.max).default(hierarchyTargetRange.default), sectionPatchesPerPage: z.number().int().min(1).max(6),
  originalPassages: z.number().int().min(1).max(12), tools: z.number().int().min(1).max(20),
  modelCalls: z.number().int().min(1).max(21), repairs: z.number().int().min(0).max(1),
  deadlineMs: z.number().int().min(1).max(600_000)
}).strict();
export const initialCuratorLimits = CuratorLimitsSchema.parse({
  targets: 3, sectionPatchesPerPage: 6, originalPassages: 12, tools: 20,
  modelCalls: 21, repairs: 1, deadlineMs: 600_000
});
const proposalHandle = z.string().regex(/^new_[a-z][a-z0-9_]{0,63}$/);
export const CuratorReferenceSchema = z.discriminatedUnion("reference", [
  z.object({ reference: z.literal("existing"), target: KnowledgeTargetSchema, fingerprint }).strict(),
  z.object({ reference: z.literal("proposed"), handle: proposalHandle }).strict()
]);
const CuratorPageTargetSchema = z.object({
    handle: proposalHandle, pageId: id.nullable(), expectedRevisionId: id.nullable(),
    title: z.string().trim().min(1).max(300), purpose: z.string().min(1).max(2000),
    role: z.discriminatedUnion("kind", [
      z.object({ kind: z.literal("topic"), role: z.literal("topic") }).strict(),
      z.object({ kind: z.literal("entity"), role: z.literal("entity"), entityId: id }).strict(),
      z.object({ kind: z.literal("synthesis"), role: z.enum(["synthesis", "investigation"]) }).strict(),
      z.object({ kind: z.literal("collection"), role: z.enum(["source_toc", "topic_toc", "map"]), owner: CuratorReferenceSchema.nullable() }).strict()
    ]),
    // Existing placements cannot be moved through this initial-placement field.
    initialParent: CuratorReferenceSchema.nullable(),
    sections: z.array(z.object({ interpretation:InterpretationDraftSchema.optional(), sectionId: id.nullable(), expectedSectionRevisionId: id.nullable(),
      title: z.string().max(300), markdown: z.string().min(1).max(12000),
      originalHandles: z.array(z.string().regex(/^e[1-9][0-9]{0,3}$/)).min(1).max(12)
    }).strict()).max(6),
    links: z.array(CuratorReferenceSchema).max(200),
    tocGroups: z.array(z.object({
      handle: proposalHandle, id: id.nullable(), expectedRevisionId: id.nullable(),
      title: z.string().min(1).max(300), explanation: z.string().max(6000).nullable(),
      originalHandles: z.array(z.string().regex(/^e[1-9][0-9]{0,3}$/)).max(12),
      memberships: z.array(z.object({ id: id.nullable(), target: CuratorReferenceSchema,
        purpose: z.enum(["reading", "subtopic", "source", "related"]), order: z.number().int().nonnegative()
      }).strict()).max(200)
    }).strict()).max(12)
  }).strict();
export const AutomaticWikiPolicySchema = z.object({
  version: z.literal(automaticWikiVersion), id, revisionId: id,
  state: z.enum(["draft", "enabled", "paused"]),
  scope: z.object({ wholeLibrary: z.boolean(), sourceIds: z.array(id).max(1000),
    includeDescendants: z.boolean(), excludedSourceIds: z.array(id).max(1000), domainId: id.nullable() }).strict(),
  triggers: z.array(z.enum(["processing_settled", "input_changed", "daily", "weekly", "monthly"])).max(5),
  operations: z.array(z.enum(["repair_navigation", "create_grounded", "update_unprotected", "initial_placement", "refresh_investigation", "interpret_memory", "evolve_notes", "reviewed_reparent", "use_scoped_destinations"])).max(9),
  profileOverrideId: id.nullable(), limits: CuratorLimitsSchema,
  // A4 must calibrate these; null means unavailable, never unlimited or zero.
  allowancePreset: z.object({ version: z.string().min(1), monthlyCalls: z.number().int().positive(),
    monthlyTokens: z.number().int().positive() }).strict().nullable()
}).strict().superRefine((value, ctx) => {
  if (!value.scope.wholeLibrary && !value.scope.sourceIds.length)
    ctx.addIssue({ code: "custom", path: ["scope"], message: "Explicit scope required" });
  for (const field of ["triggers", "operations"] as const)
    if (new Set(value[field]).size !== value[field].length) ctx.addIssue({ code: "custom", path: [field], message: "Duplicate capability" });
});
export const ImpactDeliverySchema = z.object({
  version: z.literal(automaticWikiVersion), eventId: id,
  consumer: z.enum(["curator", "investigation"]), consumerKey:z.string().min(1).optional(), inputGeneration: fingerprint,
  causalRunId: id.nullable(), causalChangeSetId: id.nullable(),
  status: z.enum(["pending", "leased", "acknowledged", "deferred"]),
  runId: id.nullable(), receiptId: id.nullable()
}).strict().superRefine((value, ctx) => {
  if (value.status === "acknowledged" && !value.receiptId)
    ctx.addIssue({ code: "custom", path: ["receiptId"], message: "Acknowledgment requires durable receipt" });
});
export const AutomaticRoutineKindSchema = z.enum(["incremental", "daily", "weekly", "monthly"]);
export const automaticRoutineDefaults = [
  { kind: "incremental", debounceMs: 120_000, hour: null, weekday: null, day: null, startWindowMs: 900_000, executionMs: 600_000 },
  { kind: "daily", debounceMs: null, hour: 2, weekday: null, day: null, startWindowMs: 21_600_000, executionMs: 1_200_000 },
  { kind: "weekly", debounceMs: null, hour: 3, weekday: 0, day: null, startWindowMs: 86_400_000, executionMs: 2_700_000 },
  { kind: "monthly", debounceMs: null, hour: 4, weekday: null, day: 1, startWindowMs: 259_200_000, executionMs: 5_400_000 }
] as const;
/** Preset version is stored on the binding, not in uniqueness: upgrades cannot duplicate it. */
export function automaticRoutineSetupKey(policyId: string, kind: z.infer<typeof AutomaticRoutineKindSchema>, scopeFingerprint: string): string {
  return JSON.stringify([automaticWikiVersion, id.parse(policyId), AutomaticRoutineKindSchema.parse(kind), fingerprint.parse(scopeFingerprint)]);
}
export const InvestigationSchema = z.object({
  version: z.literal(automaticWikiVersion), id, question: z.string().trim().min(1).max(2000),
  answerPageId: id, policyId: id, sourceIds: z.array(id).min(1).max(1000),
  state: z.enum(["followed", "paused", "resolved", "awaiting_evidence"]),
  gaps: z.array(z.string().max(2000)).max(30), lastInputFingerprint: fingerprint.nullable()
}).strict();

/** Versioned revision metadata; legacy content omits it entirely. */
export const WikiAutomaticContentSchema=z.object({version:z.literal(automaticWikiVersion),management:WikiManagementSchema,role:WikiRoleSchema,purpose:z.string().max(2000),placementProtected:z.boolean(),links:z.array(KnowledgeTargetSchema).max(200),groups:z.array(TocGroupSchema).max(12),memberships:z.array(KnowledgeMembershipSchema).max(2400)}).strict();

export const automaticWikiHierarchyVersion = automaticWikiVersion;
export const HierarchyLimitsSchema = CuratorLimitsSchema;
export const initialHierarchyLimits = initialCuratorLimits;
export const HierarchyPolicySchema = AutomaticWikiPolicySchema;
export const HierarchyHandleSchema = proposalHandle;
export const HierarchyParentSchema = z.discriminatedUnion("reference", [
  z.object({ reference: z.literal("existing"), target: z.object({ kind: z.literal("page"), id }).strict(),
    expectedRevisionId: id, fingerprint }).strict(),
  z.object({ reference: z.literal("proposed"), handle: HierarchyHandleSchema }).strict()
]);
export const HierarchyAncestorRoleSchema = z.union([
  z.object({ kind: z.literal("topic"), role: z.literal("topic") }).strict(),
  z.object({ kind: z.literal("collection"), role: z.literal("map"), owner: z.null() }).strict()
]);
/** No page ID, sections, entity binding, groups or links can be hidden here. */
export const HierarchyAncestorSchema = z.object({
  handle: HierarchyHandleSchema, title: z.string().trim().min(1).max(300),
  purpose: z.string().min(1).max(2000), role: HierarchyAncestorRoleSchema,
  initialParent: HierarchyParentSchema.nullable()
}).strict();
export const HierarchyPageTargetSchema = CuratorPageTargetSchema.extend({
  initialParent: HierarchyParentSchema.nullable()
});
export const HierarchyMoveSchema = z.object({
  handle: HierarchyHandleSchema, operation: z.literal("reviewed_reparent"), pageId: id,
  expectedRevisionId: id, fromParent: HierarchyParentSchema.options[0].nullable(),
  toParent: HierarchyParentSchema.nullable(), reason: z.string().trim().min(1).max(2000)
}).strict();
export type HierarchyParent = z.infer<typeof HierarchyParentSchema>;
export type HierarchyMove = z.infer<typeof HierarchyMoveSchema>;
export type HierarchyPageTarget = z.infer<typeof HierarchyPageTargetSchema>;
type Countable = { targets: readonly { handle: string; pageId: string | null }[]; moves: readonly { pageId: string }[]; ancestors: readonly unknown[] };
export function countHierarchyChanges(value: Countable) {
  const pages = new Set(value.targets.map(t => t.pageId ? `page:${t.pageId}` : `new:${t.handle}`));
  for (const move of value.moves) pages.add(`page:${move.pageId}`);
  return { workTargets: pages.size, structuralAncestors: value.ancestors.length, changedPages: pages.size + value.ancestors.length };
}
export const HierarchyCountsSchema = z.object({ workTargets: z.number().int().nonnegative(),
  structuralAncestors: z.number().int().nonnegative(), changedPages: z.number().int().nonnegative()
}).strict().superRefine((v, ctx) => {
  if (v.changedPages !== v.workTargets + v.structuralAncestors)
    ctx.addIssue({ code: "custom", message: "Changed pages must include targets and ancestors exactly once" });
});
function hasCycle(edges: Map<string, string[]>): boolean {
  const done = new Set<string>();
  for (const start of edges.keys()) {
    const active = new Set<string>();
    const stack: { key: string; exit: boolean }[] = [{ key: start, exit: false }];
    while (stack.length) {
      const next = stack.pop()!;
      if (next.exit) { active.delete(next.key); done.add(next.key); continue; }
      if (active.has(next.key)) return true;
      if (done.has(next.key)) continue;
      active.add(next.key); stack.push({ key: next.key, exit: true });
      for (const key of edges.get(next.key) ?? []) stack.push({ key, exit: false });
    }
  }
  return false;
}
export const HierarchyStructuralFingerprintSchema = z.object({
  version: z.literal(automaticWikiHierarchyVersion), branchFingerprint: fingerprint,
  scopeFingerprint: fingerprint, policyRevisionId: id, promptFingerprint: fingerprint, modelFingerprint: fingerprint
}).strict();
/** Backend route proof for an ancestor-only prefix; never inferred from draft text. */
export const HierarchyContinuationProofSchema = z.object({
  routeId: id, fingerprint: HierarchyStructuralFingerprintSchema,
  intendedTargetKeys: z.array(HierarchyHandleSchema).min(1).max(hierarchyTargetRange.max),
  nextParent: HierarchyParentSchema.options[1]
}).strict();
export const CuratorChangeSetSchema = z.object({
  version: z.literal(automaticWikiHierarchyVersion), groupId: id, policyRevisionId: id,
  explanation: z.string().min(1).max(2000),
  noteEvolution: NoteEvolutionSchema.optional(),
  continuation: HierarchyContinuationProofSchema.optional(),
  targets: z.array(HierarchyPageTargetSchema).max(hierarchyTargetRange.max),
  ancestors: z.array(HierarchyAncestorSchema).default([]), moves: z.array(HierarchyMoveSchema).max(hierarchyTargetRange.max).default([])
}).strict().superRefine((value, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  const unique = (values: string[], name: string) => {
    if (new Set(values).size !== values.length) issue(`Duplicate ${name}`);
  };
  const nodes = [...value.targets, ...value.ancestors];
  const byHandle = new Map(nodes.map(t => [t.handle, t]));
  const targetById = new Map(value.targets.filter(t => t.pageId).map(t => [t.pageId!, t]));
  const moveById = new Map(value.moves.map(m => [m.pageId, m]));
  unique(nodes.map(t => t.handle), "page handle");
  unique(value.targets.flatMap(t => t.pageId ? [t.pageId] : []), "target page");
  unique(value.moves.map(m => m.pageId), "move page");
  unique(value.moves.map(m => m.handle), "move handle");
  for (const move of value.moves) {
    const target = targetById.get(move.pageId);
    if (target ? target.handle !== move.handle || target.expectedRevisionId !== move.expectedRevisionId : byHandle.has(move.handle))
      issue("Overlapping target and move must share page, handle and revision");
  }
  const count = countHierarchyChanges(value).workTargets;
  if (count > hierarchyTargetRange.max || count < 1 && !value.continuation) issue("A group requires work targets or an admitted route continuation");
  if (value.continuation && (count !== 0 || !value.ancestors.length)) issue("Route prefix continuation is ancestor-only");
  if (value.continuation) {
    unique(value.continuation.intendedTargetKeys, "continuation target key");
    if (!value.ancestors.some(a => a.handle === value.continuation!.nextParent.handle)) issue("Continuation must end at a created ancestor");
  }
  const key = (ref: HierarchyParent | z.infer<typeof CuratorReferenceSchema>): string => ref.reference === "proposed"
    ? ref.handle : targetById.get(ref.target.id)?.handle ?? moveById.get(ref.target.id)?.handle ?? ref.target.id;
  const parents = new Map<string, string[]>();
  const reading = new Map<string, string[]>();
  const reference = (ref: z.infer<typeof CuratorReferenceSchema> | HierarchyParent) => {
    if (ref.reference === "proposed" && !byHandle.has(ref.handle)) issue("Unknown proposed page handle");
  };
  for (const node of nodes) {
    if (node.initialParent) reference(node.initialParent);
    parents.set(node.handle, node.initialParent ? [key(node.initialParent)] : []);
  }
  for (const move of value.moves) {
    if (move.toParent) reference(move.toParent);
    parents.set(move.handle, move.toParent ? [key(move.toParent)] : []);
    if ((move.fromParent?.target.id ?? null) === (move.toParent?.reference === "existing" ? move.toParent.target.id : move.toParent === null ? null : undefined))
      issue("A move must change its parent");
  }
  const required = new Set<string>();
  if (value.continuation) parents.set("$pending_route_target", [value.continuation.nextParent.handle]);
  for (const work of [...value.targets, ...value.moves, ...(value.continuation ? [{ handle: "$pending_route_target" }] : [])]) {
    const seen = new Set<string>(); let current = parents.get(work.handle)?.[0];
    while (current && !seen.has(current)) {
      seen.add(current); required.add(current); current = parents.get(current)?.[0];
    }
  }
  for (const ancestor of value.ancestors)
    if (!required.has(ancestor.handle)) issue("Structural ancestor must lead to an admitted work target");
  unique(value.targets.flatMap(t => t.role.kind === "entity" ? [t.role.entityId] : []), "canonical entity binding");
  unique(value.targets.flatMap(t => t.role.kind === "collection" && t.role.owner ? [`${t.role.role}:${key(t.role.owner)}`] : []), "canonical TOC owner");
  const groups = value.targets.flatMap(t => t.tocGroups);
  unique([...nodes.map(t => t.handle), ...groups.map(g => g.handle)], "page/group handle");
  unique(groups.flatMap(g => g.id ? [g.id] : []), "group identity");
  unique(groups.flatMap(g => g.memberships.flatMap(m => m.id ? [m.id] : [])), "membership identity");
  for (const target of value.targets) {
    if (Boolean(target.pageId) !== Boolean(target.expectedRevisionId) || target.pageId && target.initialParent)
      issue("Existing targets require revisions and use reviewed moves for placement");
    unique(target.sections.flatMap(s => s.sectionId ? [s.sectionId] : []), "section patch");
    for (const section of target.sections) {
      if (Boolean(section.sectionId) !== Boolean(section.expectedSectionRevisionId)) issue("Section revision required");
      unique(section.originalHandles, "section original handle");
    }
    for (const ref of [...target.links, ...target.tocGroups.flatMap(g => g.memberships.map(m => m.target))]) reference(ref);
    if (target.role.kind === "collection") {
      const { role, owner } = target.role;
      if (owner) reference(owner);
      if (role === "map" ? owner !== null : owner === null) issue("Invalid collection owner");
      if (role === "source_toc" && (owner?.reference !== "existing" || owner.target.kind !== "source")) issue("Source TOC requires a canonical source owner");
      if (role === "topic_toc" && owner && (owner.reference === "existing" ? owner.target.kind !== "page" : byHandle.get(owner.handle)?.role.kind !== "topic")) issue("Topic TOC requires a topic owner");
    } else if (target.tocGroups.length) issue("Reading groups require a collection");
    for (const group of target.tocGroups) {
      if (Boolean(group.id) !== Boolean(group.expectedRevisionId) || group.explanation && !group.originalHandles.length) issue("Group revision and original evidence required");
      unique(group.memberships.map(m => String(m.order)), "membership order");
      for (const member of group.memberships) if (member.purpose === "subtopic") {
        const ref = member.target;
        if (ref.reference === "existing" ? ref.target.kind !== "page" : byHandle.get(ref.handle)?.role.kind !== "collection")
          issue("Hierarchical TOC descent requires a collection page");
        reading.set(target.handle, [...(reading.get(target.handle) ?? []), key(ref)]);
      }
    }
  }
  if (hasCycle(parents)) issue("Composed parent cycle");
  if (hasCycle(reading)) issue("Hierarchical TOC cycle");
});
export type HierarchyChangeSet = z.infer<typeof CuratorChangeSetSchema>;
export type HierarchyPolicy = z.infer<typeof AutomaticWikiPolicySchema>;

/** Snapshot metadata only; canonical wiki tables continue owning these objects. */
export const HierarchyPlacementEntrySchema = z.object({
  pageId: id, revisionId: id, fingerprint, title: z.string().max(300), purpose: z.string().max(2000),
  role: WikiRoleSchema, parentId: id.nullable(), archived: z.boolean(), placementProtected: z.boolean(),
  canEdit: z.boolean(), canReceiveChildren: z.boolean(), sourceIds: z.array(id),
  subtopicIds: z.array(id), descendantCount: z.number().int().nonnegative(), membershipCount: z.number().int().nonnegative()
}).strict();
function freezeSnapshot<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freezeSnapshot(child);
    Object.freeze(value);
  }
  return value;
}
export const HierarchyPlacementInventorySchema = z.object({
  version: z.literal(automaticWikiHierarchyVersion), fingerprint, scopeFingerprint: fingerprint,
  pages: z.array(HierarchyPlacementEntrySchema), nextCursor: z.string().min(1).nullable()
}).strict().superRefine((v, ctx) => {
  if (new Set(v.pages.map(p => p.pageId)).size !== v.pages.length) ctx.addIssue({ code: "custom", message: "Duplicate placement page" });
}).transform(freezeSnapshot);
export type HierarchyPlacementInventory = z.infer<typeof HierarchyPlacementInventorySchema>;
export const HierarchyResourceBoundsSchema = z.object({
  maxInventoryBytes: z.number().int().positive(), maxProposalBytes: z.number().int().positive()
}).strict();
/** Resource failures request continuation, never invent a maximum hierarchy depth. */
export function hierarchyResourceDecision(value: unknown, maxBytes: number) {
  z.number().int().positive().parse(maxBytes);
  const bytes = new TextEncoder().encode(JSON.stringify(value)).byteLength;
  return { bytes, decision: bytes <= maxBytes ? "fits" as const : "continue" as const };
}
export const HierarchyRouteContinuationSchema = z.object({
  version: z.literal(automaticWikiHierarchyVersion), routeId: id,
  planningRunId: id.nullable().default(null),
  fingerprint: HierarchyStructuralFingerprintSchema,
  state: z.enum(["pending", "partial", "deferred", "complete", "canceled"]),
  intendedTargets: z.array(z.object({ key: HierarchyHandleSchema, title: z.string().min(1).max(300),
    purpose: z.string().min(1).max(2000), role: HierarchyPageTargetSchema.shape.role,
    resolvedPageId: id.nullable() }).strict()).min(1).max(hierarchyTargetRange.max),
  // Durable planning keys are not group-local live references and must be expanded afresh.
  remainingPath: z.array(z.object({ key: HierarchyHandleSchema, title: z.string().min(1).max(300),
    purpose: z.string().min(1).max(2000), role: HierarchyAncestorRoleSchema,chunkIds:z.array(id).default([]) }).strict()),
  resolvedPrefix: z.array(z.object({ key: HierarchyHandleSchema, pageId: id, revisionId: id, fingerprint }).strict()),
  destination: HierarchyParentSchema.options[0].nullable(),
  reason: z.enum(["context", "output", "deadline", "occurrence_budget", "paused"]).nullable(),
  completedGroupIds: z.array(id), currentChildRunId: id.nullable()
}).strict().superRefine((v, ctx) => {
  const keys = [...v.remainingPath, ...v.resolvedPrefix, ...v.intendedTargets].map(s => s.key);
  if (new Set(keys).size !== keys.length) ctx.addIssue({ code: "custom", message: "Route keys must be unique" });
  if (v.state === "complete" && (v.remainingPath.length || v.intendedTargets.some(t => !t.resolvedPageId) || v.currentChildRunId))
    ctx.addIssue({ code: "custom", message: "Completion requires all ancestors, leaves and required TOCs" });
});
export const HierarchyCheckpointSchema = z.object({
  version: z.literal(automaticWikiHierarchyVersion), fingerprint: HierarchyStructuralFingerprintSchema,
  afterPageId: id.nullable(), inspectedPages: z.number().int().nonnegative(),
  outcome: z.enum(["pending", "no_change", "partial", "complete", "rejected", "awaiting_review", "canceled"]),
  routes: z.array(HierarchyRouteContinuationSchema), counts: HierarchyCountsSchema,
  appliedGroupIds: z.array(id),
  decisions: z.array(z.object({pageId:id,fingerprint,kind:z.enum(['missing_toc','unplaced','settled']),outcome:z.enum(['no_change','pending','applied','rejected','awaiting_review','failed','canceled']),runId:id.nullable(),reason:z.string().nullable().optional()}).strict()).default([])
}).strict().superRefine((v, ctx) => {
  if (v.outcome === "complete" && v.routes.some(r => r.state !== "complete"))
    ctx.addIssue({ code: "custom", message: "Unfinished routes cannot be reported complete" });
});
export const HierarchyMoveReviewSchema = z.object({
  move: HierarchyMoveSchema,
  before: z.array(z.object({ pageId: id, revisionId: id, title: z.string().max(300) }).strict()),
  after: z.array(z.object({ reference: HierarchyParentSchema, title: z.string().max(300) }).strict()),
  descendantCount: z.number().int().nonnegative(),
  affectedMemberships: z.array(z.object({ id, pageId: id, expectedRevisionId: id, placementProtected: z.boolean(), order: z.number().int().nonnegative() }).strict()),
  placementProtected: z.boolean()
}).strict();

/** Re-run against current locked data at apply. This validates admission, not human approval. */
export function validateHierarchyAdmission(proposalInput: unknown, policyInput: unknown, inventoryInput: unknown,
  references: readonly { kind: string; id: string; fingerprint: string }[], admittedRouteInput?: unknown) {
  const proposal = CuratorChangeSetSchema.parse(proposalInput);
  const policy = AutomaticWikiPolicySchema.parse(policyInput);
  const inventory = HierarchyPlacementInventorySchema.parse(inventoryInput);
  const issues: string[] = [];
  if (proposal.continuation) {
    const route = HierarchyRouteContinuationSchema.safeParse(admittedRouteInput);
    const proof = proposal.continuation;
    if (!route.success) issues.push("An exact backend-admitted route is required");
    else {
      const admitted = route.data;
      const unresolved = admitted.intendedTargets.filter(t => !t.resolvedPageId).map(t => t.key).sort();
      if (proof.routeId !== admitted.routeId || JSON.stringify(proof.fingerprint) !== JSON.stringify(admitted.fingerprint)
        || JSON.stringify([...proof.intendedTargetKeys].sort()) !== JSON.stringify(unresolved)
        || !["pending", "partial", "deferred"].includes(admitted.state)
        || admitted.fingerprint.policyRevisionId !== policy.revisionId
        || admitted.fingerprint.scopeFingerprint !== inventory.scopeFingerprint
        || admitted.fingerprint.branchFingerprint !== inventory.fingerprint)
        issues.push("Continuation route identity, unresolved targets or current structural fingerprint mismatch");
      const prefix = admitted.resolvedPrefix.at(-1);
      let expectedParent: HierarchyParent | null = prefix ? { reference: "existing", target: { kind: "page", id: prefix.pageId }, expectedRevisionId: prefix.revisionId, fingerprint: prefix.fingerprint } : admitted.destination;
      if (proposal.ancestors.length > admitted.remainingPath.length) issues.push("Continuation exceeds the admitted remaining path");
      proposal.ancestors.forEach((ancestor, index) => {
        const segment = admitted.remainingPath[index];
        if (!segment || ancestor.handle !== segment.key || ancestor.title !== segment.title || ancestor.purpose !== segment.purpose
          || JSON.stringify(ancestor.role) !== JSON.stringify(segment.role) || JSON.stringify(ancestor.initialParent) !== JSON.stringify(expectedParent))
          issues.push("Continuation must create the exact admitted ancestor prefix");
        expectedParent = { reference: "proposed", handle: ancestor.handle };
      });
      if (proof.nextParent.handle !== proposal.ancestors.at(-1)?.handle) issues.push("Continuation next parent must be the resolved prefix endpoint");
    }
  }
  if (policy.state !== "enabled" || proposal.policyRevisionId !== policy.revisionId) issues.push("Current enabled policy revision required");
  if (countHierarchyChanges(proposal).workTargets > policy.limits.targets) issues.push("Configured work target limit exceeded");
  if (proposal.targets.some(t => t.sections.length > policy.limits.sectionPatchesPerPage)) issues.push("Configured section patch limit exceeded");
  if (proposal.moves.length && !policy.operations.includes("reviewed_reparent")) issues.push("Reviewed reparent capability required");
  const pages = new Map(inventory.pages.map(p => [p.pageId, p]));
  const nodes = [...proposal.targets, ...proposal.ancestors];
  const handles = new Map(nodes.map(t => [t.handle, "pageId" in t && t.pageId ? t.pageId : t.handle]));
  const roleByKey = new Map<string, { kind: string }>(inventory.pages.map(p => [p.pageId, p.role]));
  for (const t of nodes) roleByKey.set(handles.get(t.handle)!, t.role);
  const parents = new Map(inventory.pages.map(p => [p.pageId, p.parentId ? [p.parentId] : []]));
  const reading = new Map(inventory.pages.map(p => [p.pageId, [...p.subtopicIds]]));
  const key = (ref: z.infer<typeof CuratorReferenceSchema>) => ref.reference === "proposed" ? handles.get(ref.handle)! : ref.target.id;
  const admittedReference = (ref: z.infer<typeof CuratorReferenceSchema>) => {
    if (ref.reference === "existing" && !references.some(r => r.kind === ref.target.kind && r.id === ref.target.id && r.fingerprint === ref.fingerprint)
      && !(ref.target.kind === "page" && pages.get(ref.target.id)?.fingerprint === ref.fingerprint)) issues.push("Reference is not in the admitted scoped snapshot");
  };
  const destination = (ref: HierarchyParent | null) => {
    if (!ref || ref.reference === "proposed") return;
    const page = pages.get(ref.target.id);
    if (!policy.operations.includes("use_scoped_destinations")) issues.push("Scoped destination capability required");
    if (!page || page.archived || !page.canReceiveChildren || page.revisionId !== ref.expectedRevisionId || page.fingerprint !== ref.fingerprint)
      issues.push("Missing, stale or unauthorized destination");
  };
  const requirePage = (pageId: string, revisionId: string) => {
    const page = pages.get(pageId);
    if (!page || page.archived || !page.canEdit || page.revisionId !== revisionId) issues.push("Missing, stale or unauthorized changed page");
  };
  for (const target of nodes) {
    const nodeKey = handles.get(target.handle)!;
    if (!("pageId" in target) || !target.pageId) {
      if (!policy.operations.includes("create_grounded")) issues.push("Grounded creation capability required");
      if (!policy.operations.includes("initial_placement")) issues.push("Initial placement capability required");
      destination(target.initialParent); parents.set(nodeKey, target.initialParent ? [key(target.initialParent)] : []);
    } else {
      if (!policy.operations.includes("update_unprotected")) issues.push("Unprotected update capability required");
      requirePage(target.pageId, target.expectedRevisionId!);
    }
    if (!("sections" in target)) continue;
    if (target.tocGroups.length && !policy.operations.includes("repair_navigation")) issues.push("Navigation repair capability required");
    if (target.role.kind === "entity") {
      const entityId = target.role.entityId;
      if (!references.some(r => r.kind === "entity" && r.id === entityId)) issues.push("Entity binding requires an admitted canonical entity");
      if (inventory.pages.some(p => p.role.kind === "entity" && p.role.entityId === entityId && p.pageId !== target.pageId)) issues.push("Reuse the existing canonical entity page");
    }
    if (target.role.kind === "collection" && target.role.owner) {
      admittedReference(target.role.owner);
      if (target.role.role === "topic_toc" && roleByKey.get(key(target.role.owner))?.kind !== "topic") issues.push("Canonical topic owner required");
      const ownerId = key(target.role.owner), collectionRole = target.role.role;
      if (inventory.pages.some(p => p.pageId !== target.pageId && p.role.kind === "collection" && p.role.role === collectionRole && p.role.owner?.id === ownerId)) issues.push("Reuse the existing canonical TOC");
    }
    for (const ref of [...target.links, ...target.tocGroups.flatMap(g => g.memberships.map(m => m.target))]) admittedReference(ref);
    for (const group of target.tocGroups) for (const member of group.memberships) if (member.purpose === "subtopic") {
      const child = key(member.target);
      if (roleByKey.get(child)?.kind !== "collection") issues.push("Subtopic must resolve to a collection");
      reading.set(nodeKey, [...(reading.get(nodeKey) ?? []), child]);
    }
  }
  for (const move of proposal.moves) {
    requirePage(move.pageId, move.expectedRevisionId); destination(move.toParent);
    if ((pages.get(move.pageId)?.parentId ?? null) !== (move.fromParent?.target.id ?? null)) issues.push("Move source parent changed");
    if (move.fromParent) {
      const before = pages.get(move.fromParent.target.id);
      if (!before || before.revisionId !== move.fromParent.expectedRevisionId || before.fingerprint !== move.fromParent.fingerprint) issues.push("Move source parent revision changed");
    }
    parents.set(move.pageId, move.toParent ? [key(move.toParent)] : []);
  }
  // Complete the touched ancestry before admission; paginated omissions require more discovery.
  for (const node of [...nodes.map(t => handles.get(t.handle)!), ...proposal.moves.map(m => m.pageId)]) {
    const seen = new Set<string>(); let current: string | undefined = node;
    while (current && !seen.has(current)) {
      seen.add(current);
      if (!parents.has(current)) { issues.push("Incomplete ancestry: continue placement discovery"); break; }
      current = parents.get(current)?.[0];
    }
  }
  const pendingReading = proposal.targets.flatMap(t => t.tocGroups.flatMap(g => g.memberships.filter(m => m.purpose === "subtopic").map(m => key(m.target))));
  const visitedReading = new Set<string>();
  while (pendingReading.length) {
    const pageId = pendingReading.pop()!;
    if (visitedReading.has(pageId)) continue;
    visitedReading.add(pageId);
    if (!reading.has(pageId) && !nodes.some(t => handles.get(t.handle) === pageId)) issues.push("Incomplete TOC descent: continue placement discovery");
    pendingReading.push(...(reading.get(pageId) ?? []));
  }
  if (hasCycle(parents)) issues.push("Composed canonical parent cycle");
  if (hasCycle(reading)) issues.push("Composed canonical TOC cycle");
  return { valid: !issues.length, issues: [...new Set(issues)], counts: countHierarchyChanges(proposal), requiresHumanReview: proposal.moves.length > 0 };
}

export const HierarchyChangeSetSchema = CuratorChangeSetSchema;
