import { z } from "zod";

/** A0 contracts only. No policy, executor or migration is activated by importing these. */
export const automaticWikiVersion = "automatic-wiki-v1";
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
  targets: z.number().int().min(1).max(3), sectionPatchesPerPage: z.number().int().min(1).max(6),
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
export const CuratorChangeSetSchema = z.object({
  version: z.literal(automaticWikiVersion), groupId: id, policyRevisionId: id,
  explanation: z.string().min(1).max(2000),
  targets: z.array(z.object({
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
    sections: z.array(z.object({ sectionId: id.nullable(), expectedSectionRevisionId: id.nullable(),
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
  }).strict()).min(1).max(3)
}).strict().superRefine((value, ctx) => {
  const handles = new Set(value.targets.map(t => t.handle));
  if (handles.size !== value.targets.length) ctx.addIssue({ code: "custom", message: "Duplicate proposal handle" });
  const pages = value.targets.flatMap(t => t.pageId ? [t.pageId] : []);
  if (new Set(pages).size !== pages.length) ctx.addIssue({ code: "custom", message: "Duplicate target page" });
  const groups = value.targets.flatMap(t => t.tocGroups);
  for (const identities of [groups.map(g => g.handle), groups.flatMap(g => g.id ? [g.id] : []), groups.flatMap(g => g.memberships.flatMap(m => m.id ? [m.id] : []))])
    if (new Set(identities).size !== identities.length) ctx.addIssue({ code: "custom", message: "Duplicate group or membership identity" });
  if (groups.some(g => handles.has(g.handle))) ctx.addIssue({ code: "custom", message: "Group and page handles must be distinct" });
  value.targets.forEach((target, index) => {
    if (Boolean(target.pageId) !== Boolean(target.expectedRevisionId) || (target.pageId && target.initialParent))
      ctx.addIssue({ code: "custom", path: ["targets", index], message: "Existing targets require revision and preserve placement" });
    if (target.initialParent?.reference === "existing" && target.initialParent.target.kind !== "page")
      ctx.addIssue({ code: "custom", path: ["targets", index, "initialParent"], message: "Editorial parents must be pages" });
    const visited = new Set([target.handle]);
    let parent = target.initialParent;
    while (parent?.reference === "proposed") {
      if (visited.has(parent.handle)) { ctx.addIssue({ code: "custom", path: ["targets", index, "initialParent"], message: "Proposed parent cycle" }); break; }
      visited.add(parent.handle);
      const parentHandle = parent.handle;
      parent = value.targets.find(t => t.handle === parentHandle)?.initialParent ?? null;
    }
    const sections = target.sections.flatMap(s => s.sectionId ? [s.sectionId] : []);
    if (new Set(sections).size !== sections.length) ctx.addIssue({ code: "custom", path: ["targets", index, "sections"], message: "Duplicate section patch" });
    for (const ref of [...target.links, ...target.tocGroups.flatMap(g => g.memberships.map(m => m.target)), ...(target.initialParent ? [target.initialParent] : []), ...(target.role.kind === "collection" && target.role.owner ? [target.role.owner] : [])])
      if (ref.reference === "proposed" && !handles.has(ref.handle)) ctx.addIssue({ code: "custom", path: ["targets", index], message: "Unknown proposal handle" });
    if (target.role.kind === "collection") {
      const owner = target.role.owner;
      if ((target.role.role === "map" && owner !== null) || (target.role.role !== "map" && owner === null)
        || (target.role.role === "source_toc" && (owner?.reference !== "existing" || owner.target.kind !== "source"))
        || (target.role.role === "topic_toc" && owner?.reference === "existing" && owner.target.kind !== "page"))
        ctx.addIssue({ code: "custom", path: ["targets", index, "role"], message: "Invalid TOC owner" });
      if (target.role.role === "topic_toc" && owner?.reference === "proposed" && value.targets.find(t => t.handle === owner.handle)?.role.kind !== "topic")
        ctx.addIssue({ code: "custom", path: ["targets", index, "role"], message: "Topic TOC must refer to a topic" });
    }
    for (const group of target.tocGroups) {
      if (Boolean(group.id) !== Boolean(group.expectedRevisionId) || (group.explanation && !group.originalHandles.length))
        ctx.addIssue({ code: "custom", path: ["targets", index, "tocGroups"], message: "Group revision and original evidence required" });
      if (new Set(group.memberships.map(m => m.order)).size !== group.memberships.length)
        ctx.addIssue({ code: "custom", path: ["targets", index, "tocGroups"], message: "Membership order must be unambiguous" });
    }
    for (const section of target.sections)
      if (Boolean(section.sectionId) !== Boolean(section.expectedSectionRevisionId)) ctx.addIssue({ code: "custom", path: ["targets", index], message: "Section revision required" });
  });
});
export const AutomaticWikiPolicySchema = z.object({
  version: z.literal(automaticWikiVersion), id, revisionId: id,
  state: z.enum(["draft", "enabled", "paused"]),
  scope: z.object({ wholeLibrary: z.boolean(), sourceIds: z.array(id).max(1000),
    includeDescendants: z.boolean(), excludedSourceIds: z.array(id).max(1000), domainId: id.nullable() }).strict(),
  triggers: z.array(z.enum(["processing_settled", "input_changed", "daily", "weekly", "monthly"])).max(5),
  operations: z.array(z.enum(["repair_navigation", "create_grounded", "update_unprotected", "initial_placement", "refresh_investigation"])).max(5),
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
  consumer: z.enum(["curator", "investigation"]), inputGeneration: fingerprint,
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
