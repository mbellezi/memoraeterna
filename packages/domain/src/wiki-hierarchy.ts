import { z } from "zod";
import {
  AutomaticWikiPolicySchema, CuratorChangeSetSchema, CuratorLimitsSchema,
  CuratorReferenceSchema, WikiRoleSchema, initialCuratorLimits
} from "./automatic-wiki.js";

/** Canonical hierarchy contracts shared by discovery, transport and persistence. */
export const automaticWikiHierarchyVersion = "automatic-wiki-v1";
export const hierarchyTargetRange = { min: 1, max: 12, default: 3 } as const;
const id = z.string().uuid();
const fingerprint = z.string().min(1).max(256);
export const HierarchyHandleSchema = z.string().regex(/^new_[a-z][a-z0-9_]{0,63}$/);
export const HierarchyLimitsSchema = CuratorLimitsSchema.extend({
  targets: z.number().int().min(hierarchyTargetRange.min).max(hierarchyTargetRange.max).default(hierarchyTargetRange.default)
});
export const initialHierarchyLimits = HierarchyLimitsSchema.parse(initialCuratorLimits);
export const HierarchyPolicySchema = z.object({
  ...AutomaticWikiPolicySchema.shape,
  version: z.literal(automaticWikiHierarchyVersion), limits: HierarchyLimitsSchema,
  operations: z.array(z.enum([
    ...AutomaticWikiPolicySchema.shape.operations.element.options,
    "reviewed_reparent", "use_scoped_destinations"
  ])).max(9)
}).strict().superRefine((v, ctx) => {
  if (!v.scope.wholeLibrary && !v.scope.sourceIds.length) ctx.addIssue({ code: "custom", message: "Explicit scope required" });
  for (const field of ["triggers", "operations"] as const)
    if (new Set(v[field]).size !== v[field].length) ctx.addIssue({ code: "custom", message: "Duplicate capability" });
});
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
export const HierarchyPageTargetSchema = CuratorChangeSetSchema.shape.targets.element.extend({
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
export const HierarchyChangeSetSchema = z.object({
  version: z.literal(automaticWikiHierarchyVersion), groupId: id, policyRevisionId: id,
  explanation: CuratorChangeSetSchema.shape.explanation,
  noteEvolution: CuratorChangeSetSchema.shape.noteEvolution,
  continuation: HierarchyContinuationProofSchema.optional(),
  targets: z.array(HierarchyPageTargetSchema).max(hierarchyTargetRange.max),
  ancestors: z.array(HierarchyAncestorSchema), moves: z.array(HierarchyMoveSchema).max(hierarchyTargetRange.max)
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
export type HierarchyChangeSet = z.infer<typeof HierarchyChangeSetSchema>;
export type HierarchyPolicy = z.infer<typeof HierarchyPolicySchema>;

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
  fingerprint: HierarchyStructuralFingerprintSchema,
  state: z.enum(["pending", "partial", "deferred", "complete", "canceled"]),
  intendedTargets: z.array(z.object({ key: HierarchyHandleSchema, title: z.string().min(1).max(300),
    purpose: z.string().min(1).max(2000), role: HierarchyPageTargetSchema.shape.role,
    resolvedPageId: id.nullable() }).strict()).min(1).max(hierarchyTargetRange.max),
  // Durable planning keys are not group-local live references and must be expanded afresh.
  remainingPath: z.array(z.object({ key: HierarchyHandleSchema, title: z.string().min(1).max(300),
    purpose: z.string().min(1).max(2000), role: HierarchyAncestorRoleSchema }).strict()),
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
  appliedGroupIds: z.array(id)
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
  const proposal = HierarchyChangeSetSchema.parse(proposalInput);
  const policy = HierarchyPolicySchema.parse(policyInput);
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
