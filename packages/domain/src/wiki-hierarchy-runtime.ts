import { z } from "zod";
import { AutomaticWikiPolicySchema, CuratorChangeSetSchema } from "./automatic-wiki.js";
import {
  CuratorCheckpointSchema, CuratorDraftSchema, CuratorRunSchema, CuratorSnapshotSchema,
  CuratorSupportVerdictSchema
} from "./automatic-wiki-runtime.js";
import { OrganizationEvidenceSchema } from "./organization.js";
import {
  HierarchyAncestorRoleSchema, HierarchyChangeSetSchema, HierarchyCheckpointSchema,
  HierarchyHandleSchema, HierarchyLimitsSchema, HierarchyPlacementInventorySchema,
  HierarchyPolicySchema, HierarchyResourceBoundsSchema, HierarchyRouteContinuationSchema, countHierarchyChanges, validateHierarchyAdmission,
  hierarchyTargetRange
} from "./wiki-hierarchy.js";

export const hierarchyCuratorVersion = "wiki-curator-v3";
export const hierarchyDraftVersion = "wiki-curator-draft-v3";
export const HierarchyModelReferenceSchema = z.string().regex(/^(r[1-9][0-9]{0,2}|new_[a-z][a-z0-9_]{0,63})$/);
const reference = HierarchyModelReferenceSchema;
const oldTopic = CuratorDraftSchema.shape.topics.element;
const oldIndex = CuratorDraftSchema.shape.indexes.element;
const title = oldTopic.shape.title;
const purpose = oldTopic.shape.purpose;
export const HierarchyDraftSchema = z.object({
  version: z.literal(hierarchyDraftVersion), explanation: CuratorDraftSchema.shape.explanation,
  noteEvolution: CuratorDraftSchema.shape.noteEvolution,
  topics: z.array(oldTopic.extend({ initialParent: reference.nullable(), sections: z.array(oldTopic.shape.sections.element).max(6) })).max(hierarchyTargetRange.max),
  indexes: z.array(oldIndex.extend({ initialParent: reference.nullable(), groups: z.array(oldIndex.shape.groups.element.extend({
    // Subtopic reading edges are explicit; owner and principal parent stay independent.
    targets: z.array(z.object({ target: reference, purpose: z.enum(["reading", "subtopic", "source", "related"]) }).strict()).min(1).max(200)
  })).min(1).max(12) })).max(hierarchyTargetRange.max),
  entities: z.array(oldTopic.extend({ initialParent: reference.nullable(),
    entity: z.string().regex(/^r[1-9][0-9]{0,2}$/)
  })).max(hierarchyTargetRange.max),
  ancestors: z.array(z.object({ handle: HierarchyHandleSchema, title, purpose,
    role: HierarchyAncestorRoleSchema, initialParent: reference.nullable() }).strict()),
  moves: z.array(z.object({ handle: z.string().regex(/^r[1-9][0-9]{0,2}$/),
    toParent: reference.nullable(), reason: z.string().min(1).max(2000) }).strict()).max(hierarchyTargetRange.max)
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
export type HierarchyDraft = z.infer<typeof HierarchyDraftSchema>;

export function hierarchyChangedHandles(proposal: z.infer<typeof HierarchyChangeSetSchema>): string[] {
  return [...new Set([...proposal.targets, ...proposal.ancestors, ...proposal.moves].map(t => t.handle))];
}
export const HierarchySupportVerdictSchema = z.object({
  ...CuratorSupportVerdictSchema.shape,
  checkedTargets: z.array(HierarchyHandleSchema).min(1)
}).strict().superRefine((v, ctx) => {
  if (v.supported && v.issues.length || !v.supported && !v.issues.length)
    ctx.addIssue({ code: "custom", message: "Supported requires no issues; rejection requires concrete issues" });
  if (new Set(v.checkedTargets).size !== v.checkedTargets.length)
    ctx.addIssue({ code: "custom", message: "Duplicate checked handle" });
});
export function hasCompleteHierarchySupport(proposal: z.infer<typeof HierarchyChangeSetSchema>, verdict: unknown): boolean {
  const parsed = HierarchySupportVerdictSchema.safeParse(verdict);
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
export const HierarchySupportAssessmentSchema = z.object({
  proposalHash: z.string().min(1), aiTaskRunId: z.string().uuid(), verdict: HierarchySupportVerdictSchema
}).strict();
export const HierarchySnapshotSchema = z.object({
  ...CuratorSnapshotSchema.shape, version: z.literal(hierarchyCuratorVersion), policy: HierarchyPolicySchema,
  limits: HierarchyLimitsSchema, requiredPageIds: z.array(z.string().uuid()).max(hierarchyTargetRange.max).default([]),
  placement: HierarchyPlacementInventorySchema, resources: HierarchyResourceBoundsSchema,
  continuationRoute: HierarchyRouteContinuationSchema.nullable().default(null)
}).strict().superRefine((v, ctx) => {
  if (new Set(v.requiredPageIds).size !== v.requiredPageIds.length || v.requiredPageIds.length > v.limits.targets || (Object.keys(v.limits) as (keyof typeof v.limits)[]).some(k => v.limits[k] > v.policy.limits[k]))
    ctx.addIssue({ code: "custom", message: "Snapshot must respect the admitted effective target allowance" });
});
export const HierarchyCuratorCheckpointSchema = z.object({
  ...CuratorCheckpointSchema.shape, version: z.literal(hierarchyCuratorVersion),
  proposal: HierarchyChangeSetSchema.nullable(), supportAssessment: HierarchySupportAssessmentSchema.nullable().default(null),
  hierarchy: HierarchyCheckpointSchema.nullable()
}).strict();
export const HierarchyCuratorRunSchema = z.object({
  ...CuratorRunSchema.shape, snapshot: HierarchySnapshotSchema, checkpoint: HierarchyCuratorCheckpointSchema,
  proposal: HierarchyChangeSetSchema.nullable()
}).strict().superRefine((v, ctx) => {
  for (const proposal of [v.proposal, v.checkpoint.proposal]) if (proposal) {
    if (proposal.continuation && !validateHierarchyAdmission(proposal, v.snapshot.policy, v.snapshot.placement, v.snapshot.references, v.snapshot.continuationRoute).valid)
      ctx.addIssue({ code: "custom", message: "Ancestor-only proposal requires its exact pinned route admission" });
    if (proposal.groupId !== v.snapshot.groupId || proposal.policyRevisionId !== v.snapshot.policy.revisionId || countHierarchyChanges(proposal).workTargets > v.snapshot.limits.targets)
      ctx.addIssue({ code: "custom", message: "Proposal must match its admitted group, policy and effective target limit" });
  }
});
/** Explicit readers, never replacements for current .shape consumers or admission. */
export const VersionedWikiPolicySchema = z.union([AutomaticWikiPolicySchema, HierarchyPolicySchema]);
export const VersionedCuratorChangeSetSchema = z.union([CuratorChangeSetSchema, HierarchyChangeSetSchema]);
export const VersionedCuratorSnapshotSchema = z.union([CuratorSnapshotSchema, HierarchySnapshotSchema]);
export const VersionedCuratorCheckpointSchema = z.union([CuratorCheckpointSchema, HierarchyCuratorCheckpointSchema]);
export const VersionedCuratorRunSchema = z.union([CuratorRunSchema, HierarchyCuratorRunSchema]);
// The old compact draft has no version field; strict parsing keeps that exact legacy shape.
export const VersionedCuratorDraftSchema = z.union([CuratorDraftSchema, HierarchyDraftSchema]);
export type HierarchySnapshot = z.infer<typeof HierarchySnapshotSchema>;
export type HierarchyCuratorCheckpoint = z.infer<typeof HierarchyCuratorCheckpointSchema>;
export type HierarchyCuratorRun = z.infer<typeof HierarchyCuratorRunSchema>;
