import type { ConsultationEvidence } from "@app/domain";
import type { ConsultationSnapshot } from "./consultation-service.js";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

/** One original passage of a synthetic source, as retrieval hands it to a question. */
export function consultationEvidence(
  n: number,
  overrides: Partial<ConsultationEvidence> = {}
): ConsultationEvidence {
  return {
    handle: `e${n}`,
    chunkId: id(100 + n),
    sourceItemId: id(10 + (n % 2)),
    documentId: id(200 + n),
    sourceSpanId: null,
    contentHash: `hash-${n}`,
    excerpt: `Retrieval practice improved delayed recall in study ${n}.`,
    sourceTitle: `Study ${n}`,
    documentCreatedAt: "2026-01-01T00:00:00.000Z",
    locator: null,
    ...overrides
  };
}

/**
 * A synthetic prepared question. It is flagged `sample`, so answering it needs no database state;
 * pass `sample: false` with a mocked repository to exercise validation.
 */
export function consultationSnapshot(
  overrides: Partial<ConsultationSnapshot> = {}
): ConsultationSnapshot {
  return {
    promptPin: null,
    consultationVersion: "knowledge-consultation-v2",
    consultationIntent: "answer",
    sourceIds: [id(10), id(11)],
    profile: {
      profileId: id(20),
      providerConfigId: null,
      localModelId: id(21),
      provider: "fixture",
      modelId: "fixture-model",
      runtime: "test",
      revision: null,
      privacy: "offline_only",
      parameters: {},
      identityHash: "fixture",
      contextWindow: 16384
    },
    contentLanguage: "en",
    instructions: { slots: { guidance: "Attribute claims.", advanced: "Answer from evidence." } },
    sample: true,
    evidence: [consultationEvidence(1), consultationEvidence(2)],
    contexts: [],
    relations: [],
    ...overrides
  };
}
