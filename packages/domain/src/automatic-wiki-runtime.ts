import { RejectionFeedbackSchema } from './knowledge-rejections.js';
import { KnowledgeSourceDatesSchema,InterpretationDraftSchema,NoteEvolutionSchema } from "./knowledge-evolution.js";
import { z } from 'zod';
import { AutomationCommandSchema, AutomationDashboardSchema, SourceJourneySchema, KnowledgeAssetsSchema, AutomationDeliveriesSchema } from './knowledge-automation.js';
import { AutomaticMaintenancePreviewSchema } from './automatic-maintenance.js';
import { AutomaticWikiPolicySchema, CuratorChangeSetSchema, initialCuratorLimits } from './automatic-wiki.js';
import { OrganizationEvidenceSchema, OrganizationProfileSchema,OrganizationParticipationSchema } from './organization.js';
import { PromptPinSchema } from './prompt-catalog.js';
import { WikiPageSchema } from './wiki.js';
import { HierarchyAncestorRoleSchema, HierarchyChangeSetSchema, HierarchyCheckpointSchema, HierarchyHandleSchema, HierarchyLimitsSchema, HierarchyPlacementInventorySchema, HierarchyPolicySchema, HierarchyResourceBoundsSchema, HierarchyRouteContinuationSchema, countHierarchyChanges, validateHierarchyAdmission, hierarchyTargetRange } from './wiki-hierarchy.js';
export const curatorVersion = 'wiki-curator-v2';
export const CuratorStartSchema = z.object({ intent:z.enum(['temporal','procedure','merge','split','cross_source','consolidation']).optional(),policyId:z.string().uuid(), policyRevisionId:z.string().uuid(), sourceIds:z.array(z.string().uuid()).min(1).max(100), noteIds:z.array(z.string().uuid()).max(100).default([]),evidenceChunkIds:z.array(z.string().uuid()).min(1).max(12).optional() }).strict();
export const CuratorTargetSchema=z.object({kind:z.enum(['page','source','atomic_note','entity']),id:z.string().uuid(),fingerprint:z.string(),title:z.string(),sourceIds:z.array(z.string().uuid()),chunkIds:z.array(z.string().uuid()),text:z.string().max(12000)}).strict();

export const hierarchyCuratorVersion = "wiki-curator-v2";
export const hierarchyDraftVersion = "wiki-curator-v2";
export const HierarchyModelReferenceSchema = z.string().regex(/^(r[1-9][0-9]*|new_[a-z][a-z0-9_]{0,63})$/);
const reference = HierarchyModelReferenceSchema;
const DraftSectionSchema=z.object({interpretation:InterpretationDraftSchema.optional(),id:z.string().uuid().nullable(),title:z.string().max(300),markdown:z.string().min(1).max(12000),originalHandles:z.array(z.string().regex(/^e[1-9][0-9]{0,3}$/)).min(1).max(12)}).strict();
const DraftProsePageSchema = z.object({handle:reference,title:z.string().min(1).max(300),purpose:z.string().min(1).max(2000),sections:z.array(DraftSectionSchema).max(6),links:z.array(reference).max(200).default([])}).strict();
const DraftIndexSchema = z.object({handle:reference,title:z.string().min(1).max(300),purpose:z.string().min(1).max(2000),owner:z.union([z.object({topic:reference}).strict(),z.object({source:reference}).strict(),z.object({map:z.literal(true)}).strict()]),groups:z.array(z.object({id:z.string().uuid().nullable(),title:z.string().min(1).max(300),explanation:z.string().max(6000).nullable(),originalHandles:z.array(z.string().regex(/^e[1-9][0-9]{0,3}$/)).max(12),targets:z.array(reference).min(1).max(200)}).strict()).min(1).max(12)}).strict();
const title = DraftProsePageSchema.shape.title;
const purpose = DraftProsePageSchema.shape.purpose;
export const CuratorDraftSchema = z.object({
  explanation: z.string().min(1).max(2000),
  noteEvolution: NoteEvolutionSchema.optional(),
  topics: z.array(DraftProsePageSchema.extend({ initialParent: reference.nullable().default(null), sections: z.array(DraftProsePageSchema.shape.sections.element).max(6) })).max(hierarchyTargetRange.max),
  indexes: z.array(DraftIndexSchema.extend({ initialParent: reference.nullable().default(null), groups: z.array(DraftIndexSchema.shape.groups.element.extend({
    // Subtopic reading edges are explicit; owner and principal parent stay independent.
    targets: z.array(z.object({ target: reference, purpose: z.enum(["reading", "subtopic", "source", "related"]) }).strict()).min(1).max(200)
  })).min(1).max(12) })).max(hierarchyTargetRange.max),
  entities: z.array(DraftProsePageSchema.extend({ initialParent: reference.nullable().default(null),
    entity: z.string().regex(/^r[1-9][0-9]*$/)
  })).max(hierarchyTargetRange.max).default([]),
  ancestors: z.array(z.object({ handle: HierarchyHandleSchema, title, purpose,
    role: HierarchyAncestorRoleSchema, initialParent: reference.nullable().default(null) }).strict()).default([]),
  moves: z.array(z.object({ handle: z.string().regex(/^r[1-9][0-9]*$/),
    toParent: reference.nullable(), reason: z.string().min(1).max(2000) }).strict()).max(hierarchyTargetRange.max).default([])
}).strict().superRefine((v, ctx) => {
  const issue = (message: string) => ctx.addIssue({ code: "custom", message });
  const targets = [...v.topics, ...v.indexes, ...v.entities];
  const handles = new Set(targets.map(t => t.handle));
  if (handles.size !== targets.length) issue("Duplicate work target handle");
  for (const move of v.moves) handles.add(move.handle);
  if (!handles.size || handles.size > hierarchyTargetRange.max) issue("One to twelve work targets required");
  if (new Set(v.moves.map(m => m.handle)).size !== v.moves.length) issue("Duplicate move");
  const nodes = [...targets, ...v.ancestors];
  if (new Set(nodes.map(t => t.handle)).size !== nodes.length) issue("Duplicate target/ancestor handle");
  const byHandle = new Map(nodes.map(t => [t.handle, t]));
  const parent = new Map(nodes.map(t => [t.handle, t.initialParent]));
  for (const target of targets) if (target.handle.startsWith("r") && target.initialParent) issue("Existing target placement requires a reviewed move");
  for (const move of v.moves) parent.set(move.handle, move.toParent);
  const checkRef = (ref: string | null) => { if (ref?.startsWith("new_") && !byHandle.has(ref)) issue("Unknown proposed reference"); };
  const reached = new Set<string>();
  for (const node of [...nodes, ...v.moves]) {
    const visited = new Set([node.handle]); let current = parent.get(node.handle);
    while (current) {
      checkRef(current);
      if (visited.has(current)) { issue("Composed draft parent cycle"); break; }
      visited.add(current);
      if (handles.has(node.handle)) reached.add(current);
      current = parent.get(current);
    }
  }
  for (const ancestor of v.ancestors) if (!reached.has(ancestor.handle)) issue("Detached structural ancestor");
  for (const target of [...v.topics, ...v.entities]) for (const link of target.links) checkRef(link);
  for (const index of v.indexes) {
    if ("topic" in index.owner) {
      const ownerTopic = index.owner.topic;
      checkRef(ownerTopic);
      if (index.owner.topic.startsWith("new_") && !v.topics.some(t => t.handle === ownerTopic) && !v.ancestors.some(t => t.handle === ownerTopic && t.role.kind === "topic")) issue("Topic TOC requires a topic owner");
    } else if ("source" in index.owner && !index.owner.source.startsWith("r")) issue("Source owner must be canonical");
    for (const group of index.groups) for (const member of group.targets) checkRef(member.target);
  }
});
export type HierarchyDraft = z.infer<typeof CuratorDraftSchema>;

export function hierarchyChangedHandles(proposal: z.infer<typeof HierarchyChangeSetSchema>): string[] {
  return [...new Set([...proposal.targets, ...proposal.ancestors, ...proposal.moves].map(t => t.handle))];
}
export const CuratorSupportVerdictSchema = z.object({
  supported:z.boolean(),issues:z.array(z.object({path:z.string().min(1).max(300),message:z.string().min(1).max(500)}).strict()).max(12),
  checkedTargets: z.array(HierarchyHandleSchema).min(1)
}).strict().superRefine((v, ctx) => {
  if (v.supported && v.issues.length || !v.supported && !v.issues.length)
    ctx.addIssue({ code: "custom", message: "Supported requires no issues; rejection requires concrete issues" });
  if (new Set(v.checkedTargets).size !== v.checkedTargets.length)
    ctx.addIssue({ code: "custom", message: "Duplicate checked handle" });
});
export function hasCompleteHierarchySupport(proposal: z.infer<typeof HierarchyChangeSetSchema>, verdict: unknown): boolean {
  const parsed = CuratorSupportVerdictSchema.safeParse(verdict);
  if (!parsed.success || !parsed.data.supported) return false;
  const required = hierarchyChangedHandles(proposal);
  return required.length === parsed.data.checkedTargets.length && required.every(h => parsed.data.checkedTargets.includes(h));
}
/** One exact candidate and all complete originals feed the shared support call. */
export const HierarchySupportSnapshotSchema = z.object({
  version: z.literal(hierarchyCuratorVersion), proposalHash: z.string().min(1),
  proposal: HierarchyChangeSetSchema, originals: z.array(OrganizationEvidenceSchema).min(1).max(12),
  associations: z.array(z.object({ handle: HierarchyHandleSchema,
    originalHandles: z.array(z.string().regex(/^e[1-9][0-9]{0,3}$/)).min(1).max(12)
  }).strict())
}).strict().superRefine((v, ctx) => {
  const expected = hierarchyChangedHandles(v.proposal);
  const handles = v.associations.map(a => a.handle);
  if (new Set(handles).size !== handles.length || handles.length !== expected.length || expected.some(h => !handles.includes(h)))
    ctx.addIssue({ code: "custom", message: "Support must cover every changed page, ancestor and move" });
  const originals = new Set(v.originals.map(o => o.handle));
  if (originals.size !== v.originals.length || v.associations.some(a => a.originalHandles.some(h => !originals.has(h))))
    ctx.addIssue({ code: "custom", message: "Support associations require exact admitted originals" });
  for (const target of v.proposal.targets) {
    const association = v.associations.find(a => a.handle === target.handle);
    for (const h of [...target.sections, ...target.tocGroups].flatMap(s => s.originalHandles))
      if (!association?.originalHandles.includes(h)) ctx.addIssue({ code: "custom", message: "Support omitted authored original lineage" });
  }
});
export const CuratorSupportAssessmentSchema = z.object({
  proposalHash: z.string().min(1), aiTaskRunId: z.string().uuid(), verdict: CuratorSupportVerdictSchema
}).strict();
export const CuratorSnapshotSchema = z.object({
  priorRejections:z.array(RejectionFeedbackSchema).max(4).optional(),intent:z.enum(['temporal','procedure','merge','split','cross_source','consolidation']).optional(),personalSourceIds:z.array(z.string().uuid()).optional(),sourceDates:KnowledgeSourceDatesSchema.optional(),optionalReferenceCoverage:z.object({includedEntities:z.number().int(),omittedEntities:z.number().int()}).default({includedEntities:0,omittedEntities:0}),maintenanceRunId:z.string().uuid().nullable().default(null),parentBootstrapId:z.string().uuid().nullable().default(null),causalRunId:z.string().uuid().nullable().default(null),causalGroupId:z.string().uuid().nullable().default(null),sourceIds:z.array(z.string().uuid()),profile:OrganizationProfileSchema,promptPin:PromptPinSchema,contentLanguage:z.enum(['en','pt-BR','it','fr','es']),evidence:z.array(OrganizationEvidenceSchema).max(12),references:z.array(CuratorTargetSchema),pages:z.array(WikiPageSchema).max(100),inputFingerprint:z.string(),groupId:z.string().uuid(),outputTokens:z.number().int().positive().max(8192),admittedAt:z.string(),participation:OrganizationParticipationSchema.nullable().default(null),sample:z.literal(false).default(false), version: z.literal(hierarchyCuratorVersion), policy: HierarchyPolicySchema,
  limits: HierarchyLimitsSchema, requiredPageIds: z.array(z.string().uuid()).max(hierarchyTargetRange.max).default([]),
  supportCompositionHash: z.string().regex(/^[a-f0-9]{64}$/),
  placement: HierarchyPlacementInventorySchema, resources: HierarchyResourceBoundsSchema,
  continuationRoute: HierarchyRouteContinuationSchema.nullable().default(null)
}).strict().superRefine((v, ctx) => {
  if (new Set(v.requiredPageIds).size !== v.requiredPageIds.length || v.requiredPageIds.length > v.limits.targets || (Object.keys(v.limits) as (keyof typeof v.limits)[]).some(k => v.limits[k] > v.policy.limits[k]))
    ctx.addIssue({ code: "custom", message: "Snapshot must respect the admitted effective target allowance" });
});
export const CuratorCheckpointSchema = z.object({
  rejection:z.object({kind:z.literal('automatic_validation'),decidedAt:z.string()}).strict().optional(),executionBaseMs:z.number().nonnegative().nullable().default(null),executionAdmittedAt:z.string().nullable().default(null),calls:z.number().int().nonnegative(),tools:z.number().int().nonnegative(),repairs:z.number().int().min(0).max(1),startedAt:z.string(),callPending:z.boolean(),waitingForModel:z.boolean(),previousOutput:z.string().max(90000),validationIssues:z.array(z.object({path:z.string().max(300),message:z.string().max(500)}).strict()).max(12).default([]),error:z.string().nullable(),reportedInputTokens:z.number().nonnegative(),reportedOutputTokens:z.number().nonnegative(),costEstimate:z.number().nonnegative(),usageCounts:z.object({input:z.number().int(),output:z.number().int(),cost:z.number().int()}),usageIncomplete:z.boolean(), version: z.literal(hierarchyCuratorVersion),
  proposal: HierarchyChangeSetSchema.nullable(), supportAssessment: CuratorSupportAssessmentSchema.nullable().default(null),
  hierarchy: HierarchyCheckpointSchema.nullable().default(null)
}).strict();
export const CuratorRunSchema = z.object({
  id:z.string().uuid(),jobId:z.string().uuid().nullable(),status:z.enum(['queued','analyzing','awaiting_review','applied','rejected','canceled','failed']),receiptRevisionId:z.string().uuid().nullable(),createdAt:z.string(),updatedAt:z.string(), snapshot: CuratorSnapshotSchema, checkpoint: CuratorCheckpointSchema,
  proposal: HierarchyChangeSetSchema.nullable()
}).strict().superRefine((v, ctx) => {
  for (const proposal of [v.proposal, v.checkpoint.proposal]) if (proposal) {
    if (proposal.continuation && !validateHierarchyAdmission(proposal, v.snapshot.policy, v.snapshot.placement, v.snapshot.references, v.snapshot.continuationRoute).valid)
      ctx.addIssue({ code: "custom", message: "Ancestor-only proposal requires its exact pinned route admission" });
    if (proposal.groupId !== v.snapshot.groupId || proposal.policyRevisionId !== v.snapshot.policy.revisionId || countHierarchyChanges(proposal).workTargets > v.snapshot.limits.targets)
      ctx.addIssue({ code: "custom", message: "Proposal must match its admitted group, policy and effective target limit" });
  }
});
export type HierarchySnapshot = z.infer<typeof CuratorSnapshotSchema>;
export type HierarchyCuratorCheckpoint = z.infer<typeof CuratorCheckpointSchema>;
export type HierarchyCuratorRun = z.infer<typeof CuratorRunSchema>;

export const CuratorPolicyDraftSchema=z.object({interpretMemory:z.boolean().optional(),evolveNotes:z.boolean().optional(),timezone:z.string().optional(),policyId:z.string().uuid().optional(),wholeLibrary:z.boolean().default(false),sourceIds:z.array(z.string().uuid()).max(100),includeDescendants:z.boolean().default(false),excludedSourceIds:z.array(z.string().uuid()).max(100).default([]),profileOverrideId:z.string().uuid().nullable().default(null),limits:AutomaticWikiPolicySchema.shape.limits.default(initialCuratorLimits)}).strict();
export const CuratorPreviewSchema=z.object({maintenance:AutomaticMaintenancePreviewSchema.nullable().default(null),policy:AutomaticWikiPolicySchema,sourceTitles:z.array(z.object({id:z.string().uuid(),title:z.string()})),profile:OrganizationProfileSchema.nullable(),promptIds:z.array(z.string()),previewHash:z.string(),modelError:z.string().nullable()}).strict();
export const CuratorCommandSchema=z.discriminatedUnion('command',[
 ...AutomationCommandSchema.options,
 z.object({command:z.literal('preview'),input:CuratorPolicyDraftSchema}).strict(),
 z.object({command:z.literal('activate'),state:z.enum(['enabled','paused']).optional(),policyId:z.string().uuid(),revisionId:z.string().uuid(),previewHash:z.string()}).strict(),
 z.object({command:z.literal('pause'),policyId:z.string().uuid()}).strict(),
 z.object({command:z.literal('resume'),policyId:z.string().uuid()}).strict(),
 z.object({command:z.literal('policies')}).strict(),
 z.object({command:z.literal('start'),input:CuratorStartSchema}).strict(),
 z.object({command:z.literal('list')}).strict(),
 ...(['get','cancel','retry','accept','reject'] as const).map(command=>z.object({command:z.literal(command),id:z.string().uuid()}).strict())
]);
export const CuratorResponseSchema=z.union([AutomationDeliveriesSchema,KnowledgeAssetsSchema,SourceJourneySchema,AutomationDashboardSchema,CuratorPreviewSchema,CuratorRunSchema,z.array(CuratorRunSchema),AutomaticWikiPolicySchema,z.array(AutomaticWikiPolicySchema),z.null()]);
export type CuratorSnapshot=z.infer<typeof CuratorSnapshotSchema>;
export type CuratorCheckpoint=z.infer<typeof CuratorCheckpointSchema>;
export type CuratorRun=z.infer<typeof CuratorRunSchema>;
export type CuratorChangeSet=z.infer<typeof CuratorChangeSetSchema>;
export type AutomaticWikiPolicy=z.infer<typeof AutomaticWikiPolicySchema>;
export type CuratorTarget=z.infer<typeof CuratorTargetSchema>;
export type CuratorCommand=z.infer<typeof CuratorCommandSchema>;


export const WikiAssessmentInputSchema=z.object({policyId:z.string().uuid(),after:z.string().uuid().nullable().default(null),limit:z.number().int().min(1).max(100).default(50)}).strict();
export const WikiCoverageStateSchema=z.enum(['cataloged','awaiting','analyzing','partial','integrated','attention','stale']);
export const WikiAssessmentSourceSchema=z.object({id:z.string().uuid(),title:z.string(),originals:z.number().int(),notes:z.number().int(),summaries:z.number().int(),vectors:z.number().int(),relations:z.number().int(),pages:z.number().int(),fingerprint:z.string(),coverage:WikiCoverageStateSchema,covered:z.number().int(),protectedPages:z.number().int()}).strict();
export const WikiAssessmentSchema=z.object({scopeConflicts:z.array(z.object({pageId:z.string().uuid(),title:z.string(),excludedSources:z.array(z.object({id:z.string().uuid(),title:z.string()}).strict())}).strict()).max(12).default([]),policyId:z.string().uuid(),policyRevisionId:z.string().uuid(),sources:z.array(WikiAssessmentSourceSchema),next:z.string().uuid().nullable(),totals:z.object({sources:z.number().int(),originals:z.number().int(),cataloged:z.number().int(),integrated:z.number().int(),attention:z.number().int()}).strict(),groupOriginalLimit:z.number().int(),readOnly:z.literal(true)}).strict();
export const WikiBootstrapCheckpointSchema=z.object({version:z.literal('wiki-bootstrap-v1'),afterNote:z.string().uuid().nullable().default(null),nextNote:z.string().uuid().nullable().default(null),lastTickAt:z.string().nullable().default(null),phase:z.enum(['originals','notes']).default('originals'),noteCursor:z.number().int().default(0),state:z.enum(['running','paused','complete','attention','canceled','rejected']),afterSource:z.string().uuid().nullable(),sourceId:z.string().uuid().nullable(),sourceFingerprint:z.string().nullable(),afterChunk:z.string().uuid().nullable(),nextChunk:z.string().uuid().nullable(),childRunId:z.string().uuid().nullable(),pendingOriginals:z.number().int().default(0),sourceCovered:z.number().int(),completedSources:z.number().int(),catalogedSources:z.number().int(),completedGroups:z.number().int(),attentionSources:z.number().int(),error:z.string().nullable()}).strict();
export const WikiBootstrapSchema=z.object({id:z.string().uuid(),status:z.string(),snapshot:z.object({version:z.literal('wiki-bootstrap-v1'),includeExistingNotes:z.boolean().default(false),participation:OrganizationParticipationSchema.nullable().default(null),noteIds:z.array(z.string().uuid()).max(1000).default([]),policy:AutomaticWikiPolicySchema,promptPin:PromptPinSchema,profile:OrganizationProfileSchema,contentLanguage:z.string(),sourceIds:z.array(z.string().uuid()),admittedAt:z.string()}).strict(),checkpoint:WikiBootstrapCheckpointSchema,createdAt:z.string(),updatedAt:z.string()}).strict();
export const WikiBootstrapStartSchema=z.object({includeExistingNotes:z.boolean().default(false),noteIds:z.array(z.string().uuid()).max(1000).default([]),policyId:z.string().uuid(),policyRevisionId:z.string().uuid(),sourceIds:z.array(z.string().uuid()).max(1000).default([])}).strict();
export const WikiCollectionCommandSchema=z.discriminatedUnion('command',[
 z.object({command:z.literal('assessment'),input:WikiAssessmentInputSchema}).strict(),
 z.object({command:z.literal('bootstrap'),input:WikiBootstrapStartSchema}).strict(),
 z.object({command:z.literal('bootstraps'),policyId:z.string().uuid().optional(),after:z.string().uuid().optional()}).strict(),
 ...(['bootstrapGet','bootstrapPause','bootstrapResume','bootstrapCancel']as const).map(command=>z.object({command:z.literal(command),id:z.string().uuid()}).strict()),
 z.object({command:z.literal('drainImpacts')}).strict()
]);
export const WikiCollectionResponseSchema=z.union([WikiAssessmentSchema,WikiBootstrapSchema,z.array(WikiBootstrapSchema),z.null()]);
export type WikiBootstrap=z.infer<typeof WikiBootstrapSchema>;
