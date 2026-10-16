import { randomUUID } from "node:crypto";
import { describe, it, expect, vi } from "vitest";
import { ConsultationInputSchema, ConsultationResultSchema } from "@app/domain";
import {
  ConsultationService,
  packConsultationSnapshot,
  consultationPrompt
} from "./consultation-service.js";
import { defaultPromptPin, withPromptPin, promptAudit } from "./prompt-runtime.js";
import { consultationEvidence, consultationSnapshot } from "./consultation-fixture.js";

const requestId = randomUUID(),
  question = "What do the studies report?";
describe("knowledge-first consultation contract", () => {
  it("keeps at most twelve complete passages at a generous context and drops what does not fit", () => {
    const wide = consultationSnapshot({
      profile: { ...consultationSnapshot().profile, contextWindow: 128000 },
      evidence: Array.from({ length: 20 }, (_, i) => consultationEvidence(i + 1))
    });
    expect(packConsultationSnapshot(wide, question).evidence.length).toBe(12);
    const narrow = consultationSnapshot({
      profile: { ...consultationSnapshot().profile, contextWindow: 10000 },
      evidence: [
        consultationEvidence(1, { excerpt: "Unrelated ".repeat(1100) }),
        ...Array.from({ length: 5 }, (_, i) => consultationEvidence(i + 2))
      ]
    });
    const packed = packConsultationSnapshot(narrow, question);
    expect(packed.evidence.map((e) => e.handle)).toEqual(["e2", "e3", "e4", "e5", "e6"]);
    expect(consultationPrompt(packed, question).includes('"handle":"e6"')).toBe(true);
  });
  it("defaults to the one supported version and rejects page and domain scopes and unknown versions", () => {
    const input = { requestId, question: "Question" };
    expect(ConsultationInputSchema.parse(input).version).toBe("knowledge-consultation-v2");
    expect(() => ConsultationInputSchema.parse({ ...input, version: "future" })).toThrow();
    expect(() => ConsultationInputSchema.parse({ ...input, version: "wiki-answer-v1" })).toThrow();
    expect(() => ConsultationInputSchema.parse({ ...input, pageId: randomUUID() })).toThrow();
    expect(() => ConsultationInputSchema.parse({ ...input, domainId: randomUUID() })).toThrow();
    expect(ConsultationInputSchema.parse({ ...input, includeDescendants: true }).sourceIds).toEqual(
      []
    );
  });
  it("scopes a question to one topic, which replaces the source scope", () => {
    const input = { requestId, question: "Question" },
      topicId = randomUUID();
    expect(ConsultationInputSchema.parse(input).topicId).toBeUndefined();
    expect(ConsultationInputSchema.parse({ ...input, topicId })).toMatchObject({
      topicId,
      sourceIds: [],
      includeDescendants: false
    });
    expect(() =>
      ConsultationInputSchema.parse({ ...input, topicId, sourceIds: [randomUUID()] })
    ).toThrow("consultation.errors.scope");
    expect(() => ConsultationInputSchema.parse({ ...input, topicId: "not-an-id" })).toThrow();
    expect(() => ConsultationInputSchema.parse({ ...input, topicId: null })).toThrow();
    const scope = { sourceIds: [], topicId, includeDescendants: false, reviewedOnly: false };
    const result = {
      id: requestId,
      question,
      scope,
      answer: {
        paragraphs: [{ markdown: "Finding [e1]", citations: ["e1"], contextIds: [] }],
        gaps: []
      },
      evidence: [consultationEvidence(1)],
      contexts: [],
      coverage: {
        retrieved: 1,
        selected: 1,
        sourceCount: 1,
        limited: false,
        vector: "disabled" as const,
        signals: ["text"],
        stale: false
      },
      model: "fixture-model",
      inputTokens: null,
      outputTokens: null,
      costEstimate: null,
      promptFingerprint: "fingerprint"
    };
    expect(ConsultationResultSchema.parse(result).scope.topicId).toBe(topicId);
    expect(() =>
      ConsultationResultSchema.parse({ ...result, scope: { ...scope, topicId: "x" } })
    ).toThrow();
  });
  it("describes a result by its sources only and rejects a page scope or a wiki context", () => {
    const result = {
      id: requestId,
      question,
      scope: { sourceIds: [], includeDescendants: false, reviewedOnly: false },
      answer: {
        paragraphs: [{ markdown: "Finding [e1]", citations: ["e1"], contextIds: [] }],
        gaps: []
      },
      evidence: [consultationEvidence(1)],
      contexts: [],
      coverage: {
        retrieved: 1,
        selected: 1,
        sourceCount: 1,
        limited: false,
        vector: "disabled" as const,
        signals: ["text"],
        stale: false
      },
      model: "fixture-model",
      inputTokens: null,
      outputTokens: null,
      costEstimate: null,
      promptFingerprint: "fingerprint"
    };
    expect(ConsultationResultSchema.parse(result).version).toBe("knowledge-consultation-v2");
    expect(() =>
      ConsultationResultSchema.parse({
        ...result,
        scope: { ...result.scope, pageId: randomUUID() }
      })
    ).toThrow();
    expect(() =>
      ConsultationResultSchema.parse({
        ...result,
        contexts: [
          {
            id: randomUUID(),
            kind: "wiki_section",
            sourceItemId: randomUUID(),
            text: "A page section.",
            review: null,
            fingerprint: "x",
            handles: ["e1"],
            dependencies: []
          }
        ]
      })
    ).toThrow();
  });
  it("maps the common prepared-context guard to the actionable consultation error", async () => {
    const service = new ConsultationService({
      getPool: () => null,
      ai: {
        runOrganizationTask: async () => {
          throw new Error("errors.ai.contextWindowLimit");
        }
      },
      contentLanguage: async () => "en"
    } as any);
    await expect(
      service.generate(consultationSnapshot(), question, new AbortController().signal)
    ).rejects.toThrow("consultation.errors.context");
  });
  it.each(["answer", "comparison"] as const)(
    "uses actual registered %s and gap leaves with one bounded repair",
    async (intent) => {
      const pin = defaultPromptPin(),
        snapshot = consultationSnapshot({ promptPin: pin, consultationIntent: intent });
      const calls: Array<{ prompt: string; ids: string[] }> = [];
      let attempt = 0;
      const runOrganizationTask = vi.fn(async (_profile: unknown, prompt: string) => {
        calls.push({ prompt, ids: promptAudit(prompt).map((s) => s.promptId) });
        return {
          aiTaskRunId: randomUUID(),
          output:
            ++attempt === 1
              ? "{"
              : {
                  paragraphs: [
                    { markdown: "Qualified finding [e1]", citations: ["e1"], contextIds: [] }
                  ],
                  gaps: []
                }
        };
      });
      const service = new ConsultationService({
        getPool: () => null,
        ai: { runOrganizationTask },
        contentLanguage: async () => "en"
      } as any);
      await withPromptPin(pin, () =>
        service.generate(snapshot, "Question", new AbortController().signal)
      );
      expect(calls).toHaveLength(2);
      expect(calls[0]!.ids).toContain("consultation.knowledge");
      expect(calls[0]!.ids).toContain("consultation.gaps");
      if (intent !== "answer") expect(calls[0]!.ids).toContain("consultation." + intent);
      expect(calls[1]!.ids).toContain("consultation.repair");
    }
  );
});
