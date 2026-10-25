import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { ConsultationContext } from "@app/domain";
import {
  ConsultationService,
  parseConsultationAnswer,
  rankConsultationCandidates,
  packConsultationSnapshot,
  consultationFits,
  consultationPrompt
} from "./consultation-service.js";
import { consultationEvidence, consultationSnapshot } from "./consultation-fixture.js";
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
  it("requires supplied original handles and cited markers, rejecting forged tools and duplicate citations", () => {
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
});

describe("an answer's context links", () => {
  const context = (handles: string[], text = "A synthetic note."): ConsultationContext => ({
    id: randomUUID(),
    kind: "atomic_note",
    sourceItemId: consultationEvidence(1).sourceItemId,
    text,
    review: "active",
    fingerprint: "fixture",
    handles,
    dependencies: []
  });
  // The shape STRICTP recorded on 10-25 (synthetic text): the second paragraph cites one passage
  // and links a summary whose passages are that one and another the paragraph does not cite.
  const notes = {
    first: context(["e1"]),
    fourth: context(["e4"]),
    eleventh: context(["e11"]),
    summary: { ...context(["e1", "e11"], "Retention declines without review."), kind: "summary" },
    twelfth: context(["e12"]),
    second: context(["e2"])
  } satisfies Record<string, ConsultationContext>;
  const relation = { id: randomUUID(), sourceHandle: "e1", targetHandle: "e2" };
  const snapshot = {
    ...consultationSnapshot({
      evidence: Array.from({ length: 12 }, (_, i) => consultationEvidence(i + 1)),
      contexts: Object.values(notes)
    }),
    relations: [relation]
  };
  const recorded = () => ({
    change: null,
    paragraphs: [
      {
        markdown: "Practice slows forgetting [e1] and spacing helps [e4].",
        citations: ["e1", "e4"],
        contextIds: [notes.first.id, notes.fourth.id]
      },
      {
        markdown: "Stronger memories stay reachable longer [e11].",
        citations: ["e11"],
        contextIds: [notes.eleventh.id, notes.summary.id]
      },
      {
        markdown: "Feedback qualifies the benefit [e12] [e2].",
        citations: ["e12", "e2"],
        contextIds: [notes.twelfth.id, notes.second.id]
      }
    ],
    gaps: ["Long-term effects are not covered."]
  });

  it("drops a link whose passages the paragraph does not all cite and keeps the answer", () => {
    const onDropped = vi.fn();
    const read = parseConsultationAnswer(JSON.stringify(recorded()), snapshot, onDropped);
    expect(read.paragraphs.map((p) => p.contextIds)).toEqual([
      [notes.first.id, notes.fourth.id],
      [notes.eleventh.id],
      [notes.twelfth.id, notes.second.id]
    ]);
    // Citations and text are the model's own: nothing is added to cover the link.
    expect(read.paragraphs.map((p) => p.citations)).toEqual([["e1", "e4"], ["e11"], ["e12", "e2"]]);
    expect(read.paragraphs[1]!.markdown).toBe(recorded().paragraphs[1]!.markdown);
    expect(onDropped).toHaveBeenCalledTimes(1);
    expect(onDropped).toHaveBeenCalledWith(1);
  });

  it("drops an unknown id and a relation whose two passages are not both cited", () => {
    const onDropped = vi.fn();
    const output = {
      paragraphs: [
        {
          markdown: "Practice helps [e1].",
          citations: ["e1"],
          contextIds: [randomUUID(), relation.id, notes.first.id]
        }
      ],
      gaps: []
    };
    const before = structuredClone(output);
    const read = parseConsultationAnswer(output, snapshot, onDropped);
    expect(read.paragraphs[0]!.contextIds).toEqual([notes.first.id]);
    expect(onDropped).toHaveBeenCalledWith(2);
    // The caller's object is read, never changed.
    expect(output).toEqual(before);
  });

  it("drops a link that is no id, as STRICTP saw passage handles there, and leaves the caller's object", () => {
    const onDropped = vi.fn();
    const output = {
      change: null,
      paragraphs: [
        {
          markdown: "Practice helps [e1].",
          citations: ["e1"],
          contextIds: [notes.summary.id, "e1"]
        },
        {
          markdown: "Feedback qualifies it [e12].",
          citations: ["e12"],
          contextIds: [notes.twelfth.id, "e12", 7, "⟦id:26⟧"]
        }
      ],
      gaps: []
    };
    const before = structuredClone(output);
    const read = parseConsultationAnswer(output, snapshot, onDropped);
    // The summary is dropped too: the first paragraph does not cite its e11.
    expect(read.paragraphs.map((p) => p.contextIds)).toEqual([[], [notes.twelfth.id]]);
    expect(onDropped).toHaveBeenCalledTimes(1);
    expect(onDropped).toHaveBeenCalledWith(5);
    expect(output).toEqual(before);
  });

  it("keeps covered contexts and relations and reports nothing", () => {
    const onDropped = vi.fn();
    const answer = {
      paragraphs: [
        {
          markdown: "Practice and feedback [e1] [e2] [e11].",
          citations: ["e1", "e2", "e11"],
          contextIds: [notes.summary.id, relation.id, notes.second.id]
        }
      ],
      gaps: []
    };
    expect(parseConsultationAnswer(answer, snapshot, onDropped)).toEqual(answer);
    expect(onDropped).not.toHaveBeenCalled();
  });

  it("still rejects the schema, an unknown citation, an uncited marker and the investigation rule", () => {
    const onDropped = vi.fn();
    const paragraph = recorded().paragraphs[1]!;
    const answer = (p: Record<string, unknown>) => ({ paragraphs: [p], gaps: [] });
    expect(() =>
      parseConsultationAnswer({ ...answer(paragraph), tool: "x" }, snapshot, onDropped)
    ).toThrow();
    expect(() =>
      parseConsultationAnswer(answer({ ...paragraph, extra: true }), snapshot, onDropped)
    ).toThrow();
    expect(() =>
      parseConsultationAnswer(
        answer({ ...paragraph, markdown: "Unsupported [e13].", citations: ["e11", "e13"] }),
        snapshot,
        onDropped
      )
    ).toThrow("consultation.errors.evidence");
    expect(() =>
      parseConsultationAnswer(
        answer({ ...paragraph, markdown: "Also [e1] [e11]." }),
        snapshot,
        onDropped
      )
    ).toThrow("consultation.errors.evidence");
    expect(() =>
      parseConsultationAnswer(
        answer(paragraph),
        { ...snapshot, consultationIntent: "investigation" },
        onDropped
      )
    ).toThrow("consultation.errors.invalid");
    expect(onDropped).not.toHaveBeenCalled();
  });

  it("answers in one call and logs the count with the call's audit row, never the text", async () => {
    const runOrganizationTask = vi.fn(async () => ({
      output: JSON.stringify(recorded()),
      aiTaskRunId: "run-1",
      inputTokens: 10,
      outputTokens: 5,
      costEstimate: 0
    }));
    const info = vi.fn();
    const ai = {
      pinOrganizationProfile: vi.fn(),
      runOrganizationTask,
      runConsultationEmbedding: vi.fn(async () => null)
    } as never;
    const sample = consultationSnapshot({
      evidence: snapshot.evidence,
      contexts: snapshot.contexts
    });
    const question = "Does retrieval practice help?";
    const service = new ConsultationService({
      getPool: () => null,
      ai,
      contentLanguage: async () => "en",
      logger: { info }
    });
    const result = await service.generate(sample, question, new AbortController().signal);
    expect(runOrganizationTask).toHaveBeenCalledTimes(1);
    expect(result.answer.paragraphs[1]!.contextIds).toEqual([notes.eleventh.id]);
    expect(info).toHaveBeenCalledTimes(1);
    const line = String(info.mock.calls[0]![0]);
    expect(JSON.parse(line)).toMatchObject({
      level: "info",
      event: "consultation_context_links_dropped",
      aiTaskRunId: "run-1",
      attempt: 1,
      droppedContextLinks: 1
    });
    for (const text of [question, ...recorded().paragraphs.map((p) => p.markdown)])
      expect(line).not.toContain(text);
    // Without a logger the answer is the same and nothing is written.
    const quiet = new ConsultationService({
      getPool: () => null,
      ai,
      contentLanguage: async () => "en"
    });
    await expect(
      quiet.generate(sample, question, new AbortController().signal)
    ).resolves.toMatchObject({ answer: result.answer });
  });
});
