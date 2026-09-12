import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  AutomaticWikiPolicySchema, CuratorChangeSetSchema, CuratorLimitsSchema, ImpactDeliverySchema,
  KnowledgeMembershipSchema, SectionAssessmentSchema, TocGroupSchema, WikiRoleSchema,
  automaticRoutineDefaults, automaticRoutineSetupKey, automaticWikiVersion,
  canConsultSection, initialCuratorLimits, legacyWikiManagement
} from "./automatic-wiki.js";
import { OrganizationActionSchema, organizationVersion } from "./organization.js";
import { maintenanceLocalInstant, maintenanceOccurrences, MaintenanceCadenceSchema } from "./maintenance.js";
import { SourceItemTypeSchema } from "./source-item.js";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`../../../scripts/fixtures/automatic-wiki/${name}.json`, import.meta.url), "utf8"));
const assessment = () => SectionAssessmentSchema.parse({ version: automaticWikiVersion, sectionId: id(1), sectionRevisionId: id(2), humanReview: "unreviewed", support: "validated", supportMethod:"model_checked", supportAuditId:id(3), reason: "generated_pending_verification", inputFingerprint: "original-r1", freshness: "current" });

describe("A0 automatic wiki contract acceptance", () => {
  it("separates human verification, support and exact evidence freshness", () => {
    const fresh = assessment();
    expect(canConsultSection(fresh, id(2), false)).toBe(true);
    expect(canConsultSection(fresh, id(2), true)).toBe(false);
    expect(canConsultSection({...fresh,supportMethod:"structural"},id(2),false)).toBe(false);
    expect(canConsultSection({...fresh,supportAuditId:undefined},id(2),false)).toBe(false);
    expect(canConsultSection(fresh, id(3), false)).toBe(false);
    for (const support of ["unassessed", "invalidated", "unsupported"] as const)
      expect(canConsultSection({ ...fresh, support, humanReview: "verified" }, id(2), false)).toBe(false);
    expect(canConsultSection({ ...fresh, freshness: "stale" }, id(2), false)).toBe(false);
    expect(SectionAssessmentSchema.safeParse({ ...fresh, reason: "prose_changed" }).success).toBe(false);
    expect(SectionAssessmentSchema.safeParse({ ...fresh, reason: "input_changed" }).success).toBe(false);
    expect(canConsultSection({ ...fresh, reason: "input_changed" }, id(2), false)).toBe(false);
    expect(SectionAssessmentSchema.safeParse({ ...fresh, reason: "revalidated" }).success).toBe(true);
    expect(canConsultSection({ ...fresh, humanReview: "verified", reason: "human_verified" }, id(2), true)).toBe(true);
  });
  it("backfills uncertain/human/reviewed/protected origin conservatively", () => {
    for (const origin of [null, "unknown", "human", "obsidian", "maintenance"])
      expect(legacyWikiManagement({ origin, reviewed: false, protected: false })).toBe("human_managed");
    expect(legacyWikiManagement({ origin: "organization", reviewed: false, protected: false })).toBe("ai_managed");
    expect(legacyWikiManagement({ origin: "organization", reviewed: true, protected: false })).toBe("human_managed");
    expect(legacyWikiManagement({ origin: "organization", reviewed: false, protected: true })).toBe("human_managed");
  });
  it("models one note in several maps without a semantic relation or identity copy", () => {
    const memberships = [1, 2, 3].map(n => KnowledgeMembershipSchema.parse({ version: automaticWikiVersion, id: id(n), pageId: id(n + 10), groupId: id(n + 20), target: { kind: "atomic_note", id: id(90) }, purpose: "reading", order: n, origin: "deterministic", placementProtected: n === 2, expectedPageRevisionId: id(60), targetFingerprint: "note-r1" }));
    expect(new Set(memberships.map(m => m.target.id)).size).toBe(1);
    expect(KnowledgeMembershipSchema.safeParse({ ...memberships[0], purpose: "supports" }).success).toBe(false);
    const group = { version: automaticWikiVersion, id: id(21), collectionId: id(11), title: "Recall", explanation: null, explanationEvidenceIds: [], membershipIds: [id(1)], orderProtected: true, origin: "deterministic" };
    expect(TocGroupSchema.safeParse(group).success).toBe(true);
    expect(TocGroupSchema.safeParse({ ...group, membershipIds: [id(1), id(1)] }).success).toBe(false);
    expect(TocGroupSchema.safeParse({ ...group, explanation: "Retrieval always improves recall." }).success).toBe(false);
    expect(WikiRoleSchema.safeParse({ kind: "collection", role: "source_toc", owner: { kind: "page", id: id(1) } }).success).toBe(false);
  });
  it("bounds coherent proposals and rejects unresolved/newly privileged references", () => {
    const target = { handle: "new_topic", pageId: null, expectedRevisionId: null, title: "Memory", purpose: "Recall and spacing", role: { kind: "topic", role: "topic" }, initialParent: null, sections: [{ sectionId: null, expectedSectionRevisionId: null, title: "Recall", markdown: "Attributed finding [e1]", originalHandles: ["e1"] }], links: [], tocGroups: [] };
    const proposal = { version: automaticWikiVersion, groupId: id(1), policyRevisionId: id(2), explanation: "Use complementary originals", targets: [target] };
    expect(CuratorChangeSetSchema.safeParse(proposal).success).toBe(true);
    expect(CuratorChangeSetSchema.safeParse({ ...proposal, targets: Array(4).fill(target) }).success).toBe(false);
    expect(CuratorChangeSetSchema.safeParse({ ...proposal, targets: [{ ...target, links: [{ reference: "proposed", handle: "new_unknown" }] }] }).success).toBe(false);
    expect(CuratorChangeSetSchema.safeParse({ ...proposal, sql: "delete from sources" }).success).toBe(false);
    expect(CuratorLimitsSchema.safeParse({ ...initialCuratorLimits, modelCalls: 22 }).success).toBe(false);
  });
  it("never makes a global consumption timestamp sufficient for fan-out acknowledgment", () => {
    const delivery = { version: automaticWikiVersion, eventId: id(1), consumer: "curator", inputGeneration: "r2", causalRunId: null, causalChangeSetId: null, status: "pending", runId: null, receiptId: null };
    expect(ImpactDeliverySchema.safeParse(delivery).success).toBe(true);
    expect(ImpactDeliverySchema.safeParse({ ...delivery, status: "acknowledged" }).success).toBe(false);
    const acknowledged = ImpactDeliverySchema.parse({ ...delivery, status: "acknowledged", receiptId: id(2) });
    const other = ImpactDeliverySchema.parse({ ...delivery, consumer: "investigation" });
    expect(acknowledged.status).toBe("acknowledged");
    expect(other.status).toBe("pending");
  });
  it("represents the first topic, source TOC and topic TOC as one three-target group", () => {
    const change = CuratorChangeSetSchema.parse(fixture("first-change-set"));
    expect(change.targets.map(t => t.title)).toEqual(["Memória", "Notas deste capítulo", "Índice de Memória"]);
    const sourceGroup = change.targets[1]!.tocGroups[0]!, topicGroup = change.targets[2]!.tocGroups[0]!;
    expect(sourceGroup.memberships.map(m => m.target)).toEqual(topicGroup.memberships.map(m => m.target));
    expect(topicGroup.memberships.map(m => m.order)).toEqual([0, 1]);
    expect(change.targets[2]!.role).toMatchObject({ role: "topic_toc", owner: { reference: "proposed", handle: "new_topic" } });
    expect(CuratorChangeSetSchema.safeParse({ ...change, targets: change.targets.map((t, i) => i !== 2 ? t : { ...t, tocGroups: [{ ...topicGroup, memberships: topicGroup.memberships.map(m => ({ ...m, order: 0 })) }] }) }).success).toBe(false);
    // Placement/prose protection lives on canonical objects; proposals have no
    // protection override and backend validation must compare exact revisions.
    expect(CuratorChangeSetSchema.safeParse({ ...change, targets: [{ ...change.targets[0], protected: false }] }).success).toBe(false);
  });
  it("rejects non-page parents, new-parent cycles and duplicate patch/group/membership identities", () => {
    const original = fixture("first-change-set");
    const rejected = (mutate: (value: typeof original) => void) => {
      const value = structuredClone(original); mutate(value);
      expect(CuratorChangeSetSchema.safeParse(value).success).toBe(false);
    };
    rejected(v => { v.targets[0].initialParent = { reference: "existing", target: { kind: "source", id: id(4) }, fingerprint: "r1" }; });
    rejected(v => { v.targets[0].initialParent = { reference: "proposed", handle: "new_topic" }; });
    rejected(v => { v.targets[0].initialParent = { reference: "proposed", handle: "new_topic_toc" }; });
    rejected(v => { v.targets[0].sections = [1, 2].map(() => ({ ...v.targets[0].sections[0], sectionId: id(10), expectedSectionRevisionId: id(11) })); });
    rejected(v => { v.targets[2].tocGroups[0].handle = v.targets[1].tocGroups[0].handle; });
    rejected(v => { for (const target of v.targets.slice(1)) Object.assign(target.tocGroups[0], { id: id(20), expectedRevisionId: id(21) }); });
    rejected(v => { for (const member of v.targets[2].tocGroups[0].memberships) member.id = id(30); });
  });
  it("keeps legacy executors and policy review constraints versioned", () => {
    expect(organizationVersion).toBe("wiki-three-tools-v1");
    expect(OrganizationActionSchema.safeParse({ tool: "readKnowledgeIndex" }).success).toBe(false);
    const policy = { version: automaticWikiVersion, id: id(1), revisionId: id(2), state: "draft", scope: { wholeLibrary: false, sourceIds: [id(3)], includeDescendants: false, excludedSourceIds: [], domainId: null }, triggers: ["input_changed"], operations: ["update_unprotected"], profileOverrideId: null, limits: initialCuratorLimits, allowancePreset: null };
    expect(AutomaticWikiPolicySchema.safeParse(policy).success).toBe(true);
    expect(AutomaticWikiPolicySchema.safeParse({ ...policy, operations: ["delete_sources"] }).success).toBe(false);
  });
  it("freezes idempotent routine keys, windows and existing calendar edge semantics", () => {
    expect(automaticRoutineDefaults.map(r => [r.kind, r.startWindowMs / 60000, r.executionMs / 60000])).toEqual([["incremental", 15, 10], ["daily", 360, 20], ["weekly", 1440, 45], ["monthly", 4320, 90]]);
    const keys = automaticRoutineDefaults.map(r => automaticRoutineSetupKey(id(1), r.kind, "scope-r1"));
    expect(new Set([...keys, ...keys]).size).toBe(4);
    expect(automaticRoutineSetupKey(id(1), "daily", "scope-r2")).not.toBe(keys[1]);
    expect(maintenanceLocalInstant([2026, 3, 29, 1, 30], "Europe/London").toISOString()).toBe("2026-03-29T01:00:00.000Z");
    expect(maintenanceLocalInstant([2026, 10, 25, 1, 30], "Europe/London").toISOString()).toBe("2026-10-25T00:30:00.000Z");
    const cadence = MaintenanceCadenceSchema.parse({ kind: "monthly", timezone: "UTC", day: 31, hour: 4 });
    expect(maintenanceOccurrences(cadence, new Date("2026-02-01T00:00:00Z"), 1)).toEqual(["2026-02-28T04:00:00.000Z"]);
  });
  it("validates the mixed-library and migration oracles without importing anything", () => {
    const mixed = fixture("mixed-library"), paths = fixture("path-map");
    expect(mixed.synthetic).toBe(true);
    const sources = mixed.sources as Array<{key:string;type:string;parent:string|null;text:string|null;optionalArtifacts:string[]}>;
    for (const source of sources) {
      expect(SourceItemTypeSchema.safeParse(source.type).success).toBe(true);
      if (source.parent) expect(sources.some(s => s.key === source.parent)).toBe(true);
      if (source.text === null) expect(source.optionalArtifacts).toEqual([]);
    }
    expect(sources.find(s => s.key === "A")?.parent).toBe("book");
    expect(sources.find(s => s.key === "B")?.parent).toBe("paper");
    const entries = paths.entries as Array<{identity:string;next:string;state:string}>;
    expect(new Set(entries.map(e => e.identity)).size).toBe(entries.length);
    expect(new Set(entries.map(e => e.next.normalize("NFC").toLowerCase())).size).toBe(entries.length);
    expect(entries.filter(e => e.state !== "clean").map(e => e.identity)).toEqual(paths.blockedAutomaticMoves);
    expect(entries.find(e => e.identity === "A")?.next).toContain("/Capítulos/");
    expect(entries.find(e => e.identity === "B")?.next).toContain("/Seções/");
    expect(entries.every(e => !e.next.startsWith("/") && !e.next.split("/").includes(".."))).toBe(true);
  });
});
