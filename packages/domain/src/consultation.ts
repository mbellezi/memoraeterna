import { z } from "zod";

/**
 * Ask: a cited answer from the library's notes and original passages. It reads sources, chunks,
 * notes, summary concepts, entity mentions and source relations only; its scope is the whole
 * library, chosen sources or one topic with its subtopics, and it never writes knowledge.
 */
export const consultationVersion = "knowledge-consultation-v2" as const;

/** An original passage, identified by its chunk and the document revision it was read from. */
export const ConsultationEvidenceSchema = z
  .object({
    handle: z.string(),
    chunkId: z.string().uuid(),
    sourceItemId: z.string().uuid(),
    documentId: z.string().uuid(),
    sourceSpanId: z.string().uuid().nullable(),
    contentHash: z.string(),
    excerpt: z.string().max(12000),
    sourceTitle: z.string(),
    documentCreatedAt: z.string(),
    locator: z.string().nullable()
  })
  .strict();
/** Optional text derived from original passages: a note, a grounded summary concept or an entity. */
export const ConsultationContextSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(["summary", "atomic_note", "entity_mention"]),
    sourceItemId: z.string().uuid(),
    text: z.string().max(6000),
    review: z.string().nullable(),
    fingerprint: z.string(),
    handles: z.array(z.string()),
    dependencies: z.array(
      z.object({ kind: z.string(), id: z.string().uuid(), fingerprint: z.string() })
    )
  })
  .strict();
/** A reviewed or proposed relation between two cited passages. */
export const ConsultationRelationSchema = z
  .object({
    id: z.string().uuid(),
    evidenceId: z.string().uuid(),
    fingerprint: z.string(),
    sourceItemId: z.string().uuid(),
    targetSourceItemId: z.string().uuid(),
    review: z.string(),
    updatedAt: z.string(),
    dependencies: z
      .array(z.object({ kind: z.string(), id: z.string().uuid(), fingerprint: z.string() }))
      .default([]),
    sourceIdea: z.string(),
    targetIdea: z.string(),
    explanation: z.string(),
    sourceHandle: z.string(),
    targetHandle: z.string()
  })
  .strict();
export const ConsultationInputSchema = z
  .object({
    version: z.literal(consultationVersion).default(consultationVersion),
    intent: z.enum(["answer", "comparison"]).default("answer"),
    requestId: z.string().uuid(),
    question: z.string().trim().min(3).max(1000),
    sourceIds: z.array(z.string().uuid()).max(100).default([]),
    /**
     * Ask about one topic: the passages behind the notes placed in the topic or any of its
     * subtopics (primary or secondary placement) and the sources placed there. It replaces the
     * source scope, so the two never come together.
     */
    topicId: z.string().uuid().optional(),
    includeDescendants: z.boolean().default(false),
    profileId: z.string().uuid().optional(),
    privacy: z.enum(["offline_only", "allow_remote"]).default("offline_only"),
    reviewedOnly: z.boolean().default(false),
    mode: z.enum(["text", "hybrid"]).default("text"),
    relationContext: z.boolean().default(true)
  })
  .strict()
  .refine((input) => input.topicId === undefined || input.sourceIds.length === 0, {
    message: "consultation.errors.scope",
    path: ["topicId"]
  });
export const ConsultationAnswerSchema = z
  .object({
    change: z
      .object({ meaningful: z.boolean(), explanation: z.array(z.string().max(1000)).max(6) })
      .strict()
      .optional(),
    paragraphs: z
      .array(
        z
          .object({
            markdown: z.string().trim().min(1).max(6000),
            citations: z
              .array(z.string().regex(/^e\d{1,3}$/))
              .min(1)
              .max(12)
              .refine((v) => new Set(v).size === v.length),
            contextIds: z.array(z.string().uuid()).max(20).default([])
          })
          .strict()
      )
      .min(1)
      .max(6),
    gaps: z.array(z.string().max(1000)).max(8)
  })
  .strict();
export const ConsultationResultSchema = z
  .object({
    version: z.literal(consultationVersion).default(consultationVersion),
    id: z.string().uuid(),
    question: z.string(),
    scope: z
      .object({
        sourceIds: z.array(z.string().uuid()),
        /** The topic the question was about; `sourceIds` is then empty. */
        topicId: z.string().uuid().optional(),
        includeDescendants: z.boolean(),
        reviewedOnly: z.boolean()
      })
      .strict(),
    answer: ConsultationAnswerSchema,
    evidence: z.array(ConsultationEvidenceSchema),
    contexts: z.array(ConsultationContextSchema),
    coverage: z.object({
      retrieved: z.number(),
      selected: z.number(),
      sourceCount: z.number(),
      limited: z.boolean(),
      vector: z.enum(["disabled", "available", "unavailable"]),
      signals: z.array(z.string()),
      stale: z.boolean()
    }),
    model: z.string(),
    inputTokens: z.number().nullable(),
    outputTokens: z.number().nullable(),
    costEstimate: z.number().nullable(),
    /** Fingerprint of the effective prompt wording and the provider fragments the answer used. */
    promptFingerprint: z.string()
  })
  .strict();
export type ConsultationEvidence = z.infer<typeof ConsultationEvidenceSchema>;
export type ConsultationContext = z.infer<typeof ConsultationContextSchema>;
export type ConsultationRelation = z.infer<typeof ConsultationRelationSchema>;
export type ConsultationInput = z.infer<typeof ConsultationInputSchema>;
export type ConsultationAnswer = z.infer<typeof ConsultationAnswerSchema>;
export type ConsultationResult = z.infer<typeof ConsultationResultSchema>;
