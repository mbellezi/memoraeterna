import { z } from "zod";

export const RejectionFeedbackSchema = z
  .object({
    analysisId: z.string().uuid(),
    decidedAt: z.string(),
    inputFingerprint: z.string(),
    originals: z
      .array(
        z
          .object({
            sourceItemId: z.string().uuid(),
            documentId: z.string().uuid(),
            chunkId: z.string().uuid(),
            contentHash: z.string()
          })
          .strict()
      )
      .max(12),
    issues: z
      .array(
        z
          .object({
            path: z.string().max(300),
            message: z.string().max(500),
            previousText: z.string().max(800).nullable()
          })
          .strict()
      )
      .max(2)
  })
  .strict();
export type RejectionFeedback = z.infer<typeof RejectionFeedbackSchema>;
export function isNonReviewableValidation(
  checkpoint: {
    error: string | null;
    callPending: boolean;
    repairs: number;
    validationIssues?: unknown[];
    supportAssessment?: { verdict: { supported: boolean } } | null;
  },
  limits: { repairs: number }
) {
  return (
    !checkpoint.callPending &&
    checkpoint.repairs >= limits.repairs &&
    [
      "organization.errors.evidence",
      "organization.errors.invalid",
      "organization.errors.unsupported"
    ].includes(checkpoint.error ?? "") &&
    (checkpoint.supportAssessment?.verdict.supported === false ||
      Boolean(checkpoint.validationIssues?.length))
  );
}
