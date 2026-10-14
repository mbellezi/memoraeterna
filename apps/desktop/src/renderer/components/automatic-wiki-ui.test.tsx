import { describe, it, expect } from "vitest";
import { renderToString } from "react-dom/server";
import { createTranslator } from "@app/i18n";
import { WikiThemeTree } from "./WikiThemeTree";
import { visibleWikiNavigation } from "./wiki-navigation";
import { AutomaticWikiDialog } from "./AutomaticWikiDialog";
const page = (id: string, parentId: string | null = null, archived = false) => ({
  id,
  parentId,
  title: id,
  archived,
  position: 0
});
describe("automatic wiki native surfaces", () => {
  it("expands only the requested normalized branch, retaining orphan and archived-parent children", () => {
    const pages = [
      page("parent"),
      page("child", "parent"),
      page("gone", null, true),
      page("orphan", "missing"),
      page("survivor", "gone")
    ];
    expect(visibleWikiNavigation(pages, new Set()).map((r) => r.page.id)).toEqual([
      "orphan",
      "parent",
      "survivor"
    ]);
    expect(visibleWikiNavigation(pages, new Set(["parent"])).map((r) => r.page.id)).toEqual([
      "orphan",
      "parent",
      "child",
      "survivor"
    ]);
  });
  it("retains the normalized root for cyclic old data instead of hiding the entire component", () => {
    const rows = visibleWikiNavigation([page("a", "b"), page("b", "a")], new Set());
    expect(rows).toHaveLength(1);
    expect(rows[0]?.parentId).toBeNull();
    expect(
      visibleWikiNavigation([page("a", "b"), page("b", "a")], new Set(["a", "b"]))
    ).toHaveLength(2);
  });
  it.each(["en", "pt-BR", "it", "fr", "es"] as const)(
    "has localized loading/no-model setup and an accessible tree in %s",
    (locale) => {
      const t = createTranslator(locale),
        tree = renderToString(
          <WikiThemeTree
            pages={[page("parent"), page("child", "parent")]}
            selected="parent"
            disabled={false}
            onOpen={() => {}}
            t={t}
          />
        );
      expect(tree).toContain('role="tree"');
      expect(tree).toContain('role="treeitem"');
      expect(tree).toContain('aria-expanded="false"');
      expect(tree).toContain('id="wiki-leaf-parent"');
      expect(tree.match(/tabindex="0"/g)).toHaveLength(1);
      expect(tree).not.toContain("wiki-leaf-child");
      const setup = renderToString(
        <AutomaticWikiDialog t={t} onClose={() => {}} onChanged={() => {}} />
      );
      expect(setup).toContain('role="status"');
      expect(setup).toContain("max-h-[calc(100dvh-2rem)]");
      expect(setup).not.toContain("[[missing:");
      expect(setup).toContain(t("automation.analysisDetails"));
    }
  );
});

import {
  CuratorRunSchema,
  CuratorCheckpointSchema,
  CuratorSnapshotSchema,
  HierarchyChangeSetSchema,
  initialCuratorLimits,
  AutomaticWikiPolicySchema
} from "@app/domain";
import {
  HierarchyReview,
  hierarchyCandidateState,
  retainedHierarchyProposal
} from "./HierarchyReview";
const uuid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
function reviewFixture() {
  const policy = AutomaticWikiPolicySchema.parse({
    version: "automatic-wiki-v1",
    id: uuid(1),
    revisionId: uuid(2),
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
      "reviewed_reparent",
      "use_scoped_destinations"
    ],
    profileOverrideId: null,
    limits: initialCuratorLimits,
    allowancePreset: null
  });
  const proposal = HierarchyChangeSetSchema.parse({
    version: "automatic-wiki-v1",
    groupId: uuid(3),
    policyRevisionId: policy.revisionId,
    explanation: "Classify the exact identity",
    targets: [
      {
        handle: "new_entity",
        pageId: null,
        expectedRevisionId: null,
        title: "Same name",
        purpose: "Attributed entity page",
        role: { kind: "entity", role: "entity", entityId: uuid(4) },
        initialParent: { reference: "proposed", handle: "new_category" },
        sections: [],
        tocGroups: [],
        links: []
      }
    ],
    ancestors: [
      {
        handle: "new_category",
        title: "Entity category",
        purpose: "Required path",
        role: { kind: "collection", role: "map", owner: null },
        initialParent: null
      }
    ],
    moves: []
  });
  const checkpoint = CuratorCheckpointSchema.parse({
    version: "wiki-curator-v2",
    calls: 1,
    tools: 3,
    repairs: 0,
    startedAt: "2026-09-15T00:00:00Z",
    callPending: false,
    waitingForModel: false,
    proposal,
    previousOutput: "",
    error: "organization.errors.scopeLimit",
    reportedInputTokens: 0,
    reportedOutputTokens: 0,
    costEstimate: 0,
    usageCounts: { input: 0, output: 0, cost: 0 },
    usageIncomplete: true,
    continuedByRouteId: uuid(9),
    continuationComplete: true
  });
  const snapshot = CuratorSnapshotSchema.parse({
    version: "wiki-curator-v2",
    policy,
    limits: policy.limits,
    sourceIds: [uuid(5)],
    profile: {
      profileId: uuid(6),
      providerConfigId: null,
      localModelId: null,
      provider: "fixture",
      modelId: "fixture",
      runtime: "fixture",
      revision: "1",
      privacy: "offline_only",
      parameters: {},
      identityHash: "fixture",
      contextWindow: 8192
    },
    promptPin: { version: "prompt-catalog-v1", domainId: null, entries: [] },
    contentLanguage: "en",
    evidence: [],
    references: [
      {
        kind: "entity",
        id: uuid(4),
        fingerprint: "entity",
        title: "Same name",
        sourceIds: [uuid(5)],
        chunkIds: [uuid(7)],
        text: ""
      },
      {
        kind: "source",
        id: uuid(5),
        fingerprint: "source",
        title: "Attribution source",
        sourceIds: [uuid(5)],
        chunkIds: [],
        text: ""
      }
    ],
    pages: [],
    inputFingerprint: "fixture",
    groupId: proposal.groupId,
    outputTokens: 2048,
    admittedAt: checkpoint.startedAt,
    supportCompositionHash: "a".repeat(64),
    resources: { maxInventoryBytes: 256000, maxProposalBytes: 256000 },
    placement: {
      version: "automatic-wiki-v1",
      pages: [],
      fingerprint: "placement",
      scopeFingerprint: "scope",
      nextCursor: null
    }
  });
  return CuratorRunSchema.parse({
    id: uuid(8),
    jobId: null,
    status: "failed",
    receiptRevisionId: null,
    createdAt: checkpoint.startedAt,
    updatedAt: checkpoint.startedAt,
    snapshot,
    checkpoint,
    proposal: null
  });
}
it.each(["en", "pt-BR", "es", "fr", "it"] as const)(
  "shows retained hierarchy candidates, exempt ancestors and disambiguating attribution in %s",
  (locale) => {
    const run = reviewFixture(),
      t = createTranslator(locale),
      proposal = retainedHierarchyProposal(run)!;
    expect(hierarchyCandidateState(run, proposal)).toBe("unchecked");
    const html = renderToString(<HierarchyReview run={run} t={t} />);
    expect(html).toContain("Entity category / Same name");
    expect(html).toContain("Attribution source");
    expect(html).toContain(uuid(4));
    expect(html).toContain(uuid(7));
    expect(html).toContain(
      t("hierarchy.counts", { values: { workTargets: 1, structuralAncestors: 1, changedPages: 2 } })
    );
    expect(html).toContain(t("hierarchy.candidate.unchecked"));
    expect(html).not.toContain(t("hierarchy.candidate.applied"));
    expect(html).not.toContain("[[missing:");
    run.checkpoint.supportAssessment = {
      proposalHash: "stale-same-handles",
      aiTaskRunId: uuid(10),
      verdict: { supported: true, checkedTargets: ["new_entity", "new_category"], issues: [] }
    };
    expect(hierarchyCandidateState(run, proposal)).toBe("unchecked");
    run.candidateSupportMatches = true;
    expect(hierarchyCandidateState(run, proposal)).toBe("supported");
    run.checkpoint.supportAssessment.verdict = {
      supported: false,
      checkedTargets: ["new_entity", "new_category"],
      issues: [{ path: "targets.0.title", message: "Unsupported attribution" }]
    };
    expect(hierarchyCandidateState(run, proposal)).toBe("unsupported");
  }
);
