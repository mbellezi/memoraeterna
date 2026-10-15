import { z } from "zod";
import { ConsultationAnswerSchema } from "./consultation.js";
import { OrganizationContextSchema, OrganizationEvidenceSchema } from "./organization.js";

/**
 * Followed questions. Retired with Ask's page scope (F2 T10): these schemas only read what the
 * pre-refactoring wiki stored, and the legacy removal deletes them with the tables.
 */
export const LegacyConsultationInputSchema = z
  .object({
    version: z.enum(["wiki-answer-v1", "knowledge-consultation-v2"]).default("wiki-answer-v1"),
    intent: z.enum(["answer", "comparison"]).default("answer"),
    requestId: z.string().uuid(),
    question: z.string().trim().min(3).max(1000),
    sourceIds: z.array(z.string().uuid()).max(100).default([]),
    pageId: z.string().uuid().nullable().default(null),
    includeDescendants: z.boolean().default(false),
    profileId: z.string().uuid().optional(),
    privacy: z.enum(["offline_only", "allow_remote"]).default("offline_only"),
    domainId: z.string().uuid().nullable().default(null),
    reviewedOnly: z.boolean().default(false),
    mode: z.enum(["text", "hybrid"]).default("text"),
    relationContext: z.boolean().default(true)
  })
  .strict();
export const LegacyConsultationResultSchema = z
  .object({
    version: z.enum(["wiki-answer-v1", "knowledge-consultation-v2"]).default("wiki-answer-v1"),
    id: z.string().uuid(),
    question: z.string(),
    scope: z.object({
      pageId: z.string().uuid().nullable(),
      sourceIds: z.array(z.string().uuid()),
      includeDescendants: z.boolean(),
      reviewedOnly: z.boolean()
    }),
    answer: ConsultationAnswerSchema,
    evidence: z.array(OrganizationEvidenceSchema),
    contexts: z.array(OrganizationContextSchema),
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
    configurationHash: z.string()
  })
  .strict();
export type LegacyConsultationInput = z.infer<typeof LegacyConsultationInputSchema>;
export type LegacyConsultationResult = z.infer<typeof LegacyConsultationResultSchema>;
export const FollowInvestigationInputSchema = z
  .object({ answerId: z.string().uuid(), policyId: z.string().uuid() })
  .strict();
export const InvestigationStateInputSchema = z
  .object({
    id: z.string().uuid(),
    expectedRevision: z.number().int().positive(),
    state: z.enum(["followed", "paused", "resolved"])
  })
  .strict();
export const FollowedInvestigationSchema = z
  .object({
    id: z.string().uuid(),
    question: z.string(),
    answerPageId: z.string().uuid(),
    policyId: z.string().uuid(),
    policyRevisionId: z.string().uuid(),
    revision: z.number().int().positive(),
    state: z.enum(["followed", "paused", "resolved", "awaiting_evidence"]),
    input: LegacyConsultationInputSchema,
    lastInputFingerprint: z.string().nullable(),
    current: LegacyConsultationResultSchema,
    gaps: z.array(z.string()),
    createdAt: z.string(),
    updatedAt: z.string(),
    attention: z.string().nullable(),
    history: z.array(
      z.object({
        id: z.string().uuid(),
        createdAt: z.string(),
        status: z.enum([
          "initial",
          "changed",
          "no_change",
          "awaiting_evidence",
          "failed",
          "rejected",
          "uncertain",
          "running",
          "deferred"
        ]),
        inputFingerprint: z.string(),
        result: LegacyConsultationResultSchema.nullable(),
        previous: LegacyConsultationResultSchema.nullable(),
        runId: z.string().uuid().nullable(),
        changedUnderstanding: z.array(z.string()),
        error: z.string().nullable()
      })
    )
  })
  .strict();
export type FollowedInvestigation = z.infer<typeof FollowedInvestigationSchema>;
