import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import { resolveOrganizationInstructions, OrganizationConfigurationSchema } from "@app/domain";
import {
  parseConsultationAnswer,
  rankConsultationCandidates,
  packConsultationSnapshot,
  consultationFits,
  consultationPrompt
} from "./consultation-service.js";
import { consultationEvidence, consultationSnapshot } from "./consultation-fixture.js";
import { organizationReadiness } from "./organization-participation.js";
const fixture = () =>
  consultationSnapshot({
    evidence: [consultationEvidence(1), consultationEvidence(2)],
    contexts: [
      {
        id: randomUUID(),
        kind: "atomic_note",
        sourceItemId: consultationEvidence(1).sourceItemId,
        text: "A note.",
        review: "active",
        fingerprint: "fixture",
        handles: ["e1", "e2"],
        dependencies: []
      }
    ]
  });
describe("bounded cited consultation", () => {
  it("requires supplied original handles and two-sided context, rejecting forged tools and duplicate citations", () => {
    const snapshot = fixture(),
      answer = {
        paragraphs: [
          {
            markdown: "Qualified comparison [e1] [e2]",
            citations: ["e1", "e2"],
            contextIds: [snapshot.contexts[0]!.id]
          }
        ],
        gaps: ["Conditions differ."]
      };
    expect(parseConsultationAnswer(JSON.stringify(answer), snapshot)).toEqual(answer);
    expect(() =>
      parseConsultationAnswer({ ...answer, tool: "matchSourceRelations" }, snapshot)
    ).toThrow();
    expect(() =>
      parseConsultationAnswer(
        { paragraphs: [{ ...answer.paragraphs[0], citations: ["e1"] }], gaps: [] },
        snapshot
      )
    ).toThrow();
    expect(() =>
      parseConsultationAnswer(
        {
          paragraphs: [{ markdown: "Unsupported [e9]", citations: ["e1"], contextIds: [] }],
          gaps: []
        },
        snapshot
      )
    ).toThrow();
    expect(() =>
      parseConsultationAnswer(
        { paragraphs: [{ markdown: "Repeated", citations: ["e1", "e1"] }], gaps: [] },
        snapshot
      )
    ).toThrow();
  });
  it("rejects irrelevant candidates and weak uncorroborated vectors while preserving independently hydrated vector hits", () => {
    const rows = [
      { chunkId: "a", sourceItemId: "one", text: 1 },
      { chunkId: "b", sourceItemId: "two", text: 0 },
      { chunkId: "c", sourceItemId: "three", text: 0 }
    ];
    expect(
      rankConsultationCandidates(rows, [
        { id: "b", score: 0.47 },
        { id: "c", score: 0.49 }
      ]).map((r) => r.chunkId)
    ).toEqual(["a", "c"]);
    expect(rankConsultationCandidates([{ chunkId: "z", sourceItemId: "x", text: 0 }], [])).toEqual(
      []
    );
  });
  it("reserves other works while retaining useful same-book chapters and avoids derivative vote multiplication", () => {
    const rows = [
      { chunkId: "a1", sourceItemId: "chapter1", rootId: "book", text: 5, note: 5, concept: 5 },
      { chunkId: "a2", sourceItemId: "chapter2", rootId: "book", text: 4 },
      { chunkId: "b", sourceItemId: "paper", rootId: "paper", text: 3 }
    ];
    expect(rankConsultationCandidates(rows, [], 2).map((r) => r.chunkId)).toEqual(["a1", "b"]);
    expect(rankConsultationCandidates(rows, [], 3).map((r) => r.chunkId)).toEqual([
      "a1",
      "b",
      "a2"
    ]);
  });
  it("packs only the complete passages the profile's context window takes before generation, in rank order and never cut", () => {
    const sources = [randomUUID(), randomUUID()],
      snapshot = consultationSnapshot({
        sourceIds: sources,
        profile: { ...consultationSnapshot().profile, contextWindow: 16384 },
        evidence: Array.from({ length: 12 }, (_, i) =>
          consultationEvidence(i + 1, {
            sourceItemId: sources[i % 2]!,
            contentHash: "original",
            excerpt: "x".repeat(2500),
            sourceTitle: "Original"
          })
        )
      });
    const packed = packConsultationSnapshot(snapshot, "Question");
    expect(packed.evidence.length).toBeLessThan(12);
    expect(packed.evidence.length).toBeGreaterThanOrEqual(2);
    expect(new Set(packed.evidence.map((e) => e.sourceItemId)).size).toBe(2);
    expect(packed.evidence.every((e) => e.excerpt.length === 2500)).toBe(true);
    expect(consultationFits(packed, "Question")).toBe(true);
    // The next passage in rank order was the one that no longer fit.
    const next = snapshot.evidence[packed.evidence.length]!;
    expect(consultationFits({ ...packed, evidence: [...packed.evidence, next] }, "Question")).toBe(
      false
    );
    expect(consultationPrompt(packed, "Question").includes("ORIGINALS: [")).toBe(true);
  });
  it("keeps the optional context and relations whose passages all made the cut", () => {
    const snapshot = consultationSnapshot({
      evidence: Array.from({ length: 14 }, (_, i) => consultationEvidence(i + 1)),
      contexts: [
        {
          id: randomUUID(),
          kind: "atomic_note",
          sourceItemId: consultationEvidence(1).sourceItemId,
          text: "Supported by the first passages.",
          review: "active",
          fingerprint: "a",
          handles: ["e1", "e2"],
          dependencies: []
        },
        {
          id: randomUUID(),
          kind: "atomic_note",
          sourceItemId: consultationEvidence(1).sourceItemId,
          text: "Needs a passage beyond the twelve kept.",
          review: "active",
          fingerprint: "b",
          handles: ["e1", "e14"],
          dependencies: []
        }
      ]
    });
    const packed = packConsultationSnapshot(snapshot, "Question");
    expect(packed.evidence.map((e) => e.handle)).toEqual(
      Array.from({ length: 12 }, (_, i) => `e${i + 1}`)
    );
    expect(packed.contexts.map((c) => c.fingerprint)).toEqual(["a"]);
  });
  it("fails with the actionable context error when not even one passage fits", () => {
    const snapshot = consultationSnapshot({
      profile: { ...consultationSnapshot().profile, contextWindow: 3000 },
      evidence: [consultationEvidence(1, { excerpt: "x".repeat(20000) })]
    });
    expect(() => packConsultationSnapshot(snapshot, "Question")).toThrow(
      "consultation.errors.context"
    );
  });
  it("keeps legacy advanced synthesis instructions away from consultation until a deliberate versioned activation", () => {
    const old = OrganizationConfigurationSchema.parse({
      global: { advanced: "Write page {{title}}", guidance: "Global guidance" },
      pageSynthesis: { guidance: "Page only" },
      domains: []
    });
    const query = resolveOrganizationInstructions(old, null, "Topic", "en", "consultation");
    expect(query.slots.advanced).not.toBe("Write page Topic");
    expect(query.slots.guidance).toBe("Global guidance");
    expect(
      resolveOrganizationInstructions(
        { ...old, functionsVersion: 2, consultation: { guidance: "Answer only" } },
        null,
        "Topic",
        "en",
        "consultation"
      ).slots
    ).toEqual({ guidance: "Answer only", advanced: "Write page Topic" });
  });
});
describe("organization checkpoint barrier", () => {
  const run = (stages: Record<string, string>, status = "succeeded") => ({
    id: randomUUID(),
    sourceItemId: randomUUID(),
    status: status as "succeeded",
    effectiveStages: [...Object.keys(stages), "organizeKnowledge"],
    stagesCheckpoint: Object.fromEntries(
      Object.entries(stages).map(([k, status]) => [k, { status }])
    )
  });
  it("never equates an ended parent with selected matching completion", () => {
    expect(
      organizationReadiness(
        [
          run({
            chunking: "completed",
            atomicNotes: "completed",
            atomicNoteMatching: "waiting_for_batch",
            sourceMatching: "pending"
          })
        ],
        false
      ).ready
    ).toBe(false);
    expect(
      organizationReadiness([run({ chunking: "completed", sourceMatching: "completed" })], true)
        .ready
    ).toBe(false);
  });
  it("treats source matching limited by the pair cap as complete and an exhausted budget as partial", () => {
    const matching = (metadata: Record<string, unknown>) => {
      const item = run({ sourceMatching: "completed" });
      item.stagesCheckpoint.sourceMatching = { status: "completed", metadata } as never;
      return item;
    };
    const coverage = {
      judgedPairs: 6,
      candidatePairs: 18,
      capReached: true,
      relationLimitReached: false,
      budgetExhausted: false
    };
    const capped = matching({ partial: false, coverage });
    expect(organizationReadiness([capped], false).omissions).toEqual([]);
    const exhausted = matching({
      partial: true,
      coverage: { ...coverage, capReached: false, budgetExhausted: true }
    });
    expect(organizationReadiness([exhausted], false).omissions).toEqual([
      { sourceItemId: exhausted.sourceItemId, stage: "sourceMatching", status: "partial" }
    ]);
  });
  it("admits terminal partial inputs after both matching barriers and the final catalog job settle", () => {
    const successful = run({
        chunking: "completed",
        atomicNotes: "completed",
        atomicNoteMatching: "completed",
        sourceMatching: "completed"
      }),
      failed = run({ chunking: "completed", knowledgeGraph: "failed" }, "failed");
    const before = structuredClone(successful),
      state = organizationReadiness([successful, failed], false);
    expect(state.ready).toBe(true);
    expect(state.omissions).toEqual([
      { sourceItemId: failed.sourceItemId, stage: "knowledgeGraph", status: "failed" }
    ]);
    expect(successful).toEqual(before);
    expect(organizationReadiness([successful, failed], true).ready).toBe(false);
  });
});
