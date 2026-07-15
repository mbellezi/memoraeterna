import { z } from "zod";

export const integrationContractVersion = "1.0.0";
export const integrationContractVersionSchema = z.string().regex(/^\d+\.\d+\.\d+$/);
export type IntegrationContractVersion = z.infer<typeof integrationContractVersionSchema>;

export function isIntegrationContractVersionCompatible(
  candidate: string,
  supported = integrationContractVersion
): boolean {
  const candidateVersion = integrationContractVersionSchema.safeParse(candidate);
  const supportedVersion = integrationContractVersionSchema.safeParse(supported);
  if (!candidateVersion.success || !supportedVersion.success) return false;
  return candidateVersion.data.split(".")[0] === supportedVersion.data.split(".")[0];
}

export const integrationClientKindSchema = z.enum(["chrome-extension", "obsidian-plugin"]);
export type IntegrationClientKind = z.infer<typeof integrationClientKindSchema>;

export const integrationCapabilitySchema = z.enum([
  "capture-web-page",
  "capture-selection",
  "capture-youtube-video",
  "import-obsidian-note",
  "watch-obsidian-files",
  "reconcile-obsidian-vault",
  "receive-job-progress"
]);
export type IntegrationCapability = z.infer<typeof integrationCapabilitySchema>;

export const integrationClientCapabilitiesSchema = z
  .object({ capabilities: z.array(integrationCapabilitySchema).min(1) })
  .strict();
export type IntegrationClientCapabilities = z.infer<typeof integrationClientCapabilitiesSchema>;

export const integrationClientIdentitySchema = z
  .object({
    kind: integrationClientKindSchema,
    name: z.string().trim().min(1).max(120),
    contractVersion: integrationContractVersionSchema
  })
  .strict();
export type IntegrationClientIdentity = z.infer<typeof integrationClientIdentitySchema>;

export const integrationHandshakeSchema = z
  .object({
    contractVersion: integrationContractVersionSchema,
    clientId: z.string().uuid(),
    client: integrationClientIdentitySchema,
    capabilities: z.array(integrationCapabilitySchema).min(1),
    instanceId: z.string().trim().min(1).max(200).optional()
  })
  .strict();
export type IntegrationHandshake = z.infer<typeof integrationHandshakeSchema>;

export const integrationHandshakeResponseSchema = z
  .object({
    contractVersion: integrationContractVersionSchema,
    clientId: z.string().uuid(),
    sessionToken: z.string().min(32),
    sessionExpiresAt: z.string().datetime(),
    eventUrl: z.string().url(),
    capabilities: z.array(integrationCapabilitySchema)
  })
  .strict();
export type IntegrationHandshakeResponse = z.infer<typeof integrationHandshakeResponseSchema>;

const requestIdSchema = z.string().uuid();
const metadataSchema = z.record(z.string(), z.unknown());
const sha256Schema = z.string().regex(/^(?:sha256:)?[a-f0-9]{64}$/i);
const relativePathSchema = z.string().trim().min(1).max(1024).refine(
  (path) => !path.startsWith("/") && !path.startsWith("\\") && !/(^|[\\/])\.\.([\\/]|$)/.test(path),
  "Path must be relative and cannot traverse parent directories."
);

const captureBaseShape = {
  requestId: requestIdSchema,
  url: z.string().url(),
  title: z.string().trim().min(1).max(1000),
  capturedAt: z.string().datetime(),
  metadata: metadataSchema.default({})
};

export const captureWebPageRequestSchema = z
  .object({
    ...captureBaseShape,
    html: z.string().min(1).optional(),
    markdown: z.string().min(1).optional(),
    textContent: z.string().min(1).optional(),
    contentHash: sha256Schema.optional()
  })
  .strict()
  .refine((value) => Boolean(value.html || value.markdown || value.textContent), {
    message: "A captured page requires HTML, Markdown, or text content."
  });
export type CaptureWebPageRequest = z.infer<typeof captureWebPageRequestSchema>;

export const captureSelectionRequestSchema = z
  .object({
    ...captureBaseShape,
    selection: z.string().trim().min(1),
    surroundingText: z.string().optional(),
    contentHash: sha256Schema.optional()
  })
  .strict();
export type CaptureSelectionRequest = z.infer<typeof captureSelectionRequestSchema>;

export const youtubeVideoIdSchema = z.string().regex(/^[A-Za-z0-9_-]{11}$/);
export const captureYouTubeVideoRequestSchema = z
  .object({
    requestId: requestIdSchema,
    url: z.string().url(),
    videoId: youtubeVideoIdSchema,
    title: z.string().trim().min(1).max(1000).optional(),
    capturedAt: z.string().datetime(),
    visibleMetadata: metadataSchema.default({})
  })
  .strict();
export type CaptureYouTubeVideoRequest = z.infer<typeof captureYouTubeVideoRequestSchema>;

export const obsidianMemoraTypeSchema = z.enum(["source_item", "atomic_note"]);
export const obsidianManagedFrontmatterSchema = z
  .object({
    memoraId: z.string().uuid(),
    memoraType: obsidianMemoraTypeSchema,
    memoraSourceId: z.string().uuid().optional(),
    memoraDocumentId: z.string().uuid().optional(),
    memoraRootSourceId: z.string().uuid().optional(),
    memoraDivisionId: z.string().min(1).optional(),
    memoraDocumentRevisionId: z.string().uuid().optional(),
    memoraManaged: z.literal(true),
    memoraSyncVersion: z.number().int().nonnegative(),
    memoraContentHash: sha256Schema
  })
  .strict();
export type ObsidianManagedFrontmatter = z.infer<typeof obsidianManagedFrontmatterSchema>;

export const importObsidianNoteRequestSchema = z
  .object({
    requestId: requestIdSchema,
    relativePath: relativePathSchema,
    title: z.string().trim().min(1).max(1000).optional(),
    markdown: z.string(),
    frontmatter: obsidianManagedFrontmatterSchema.optional(),
    contentHash: sha256Schema,
    mtimeMs: z.number().int().nonnegative()
  })
  .strict();
export type ImportObsidianNoteRequest = z.infer<typeof importObsidianNoteRequestSchema>;

export const obsidianFileChangedEventSchema = z
  .object({
    eventId: requestIdSchema,
    kind: z.enum(["created", "modified"]),
    occurredAt: z.string().datetime(),
    note: importObsidianNoteRequestSchema.extend({ frontmatter: obsidianManagedFrontmatterSchema })
  })
  .strict();
export type ObsidianFileChangedEvent = z.infer<typeof obsidianFileChangedEventSchema>;

export const obsidianFileMovedEventSchema = z
  .object({
    eventId: requestIdSchema,
    occurredAt: z.string().datetime(),
    memoraId: z.string().uuid(),
    previousRelativePath: relativePathSchema,
    relativePath: relativePathSchema,
    syncVersion: z.number().int().nonnegative(),
    mtimeMs: z.number().int().nonnegative()
  })
  .strict();
export type ObsidianFileMovedEvent = z.infer<typeof obsidianFileMovedEventSchema>;

export const obsidianFileDeletedEventSchema = z
  .object({
    eventId: requestIdSchema,
    occurredAt: z.string().datetime(),
    memoraId: z.string().uuid(),
    relativePath: relativePathSchema,
    syncVersion: z.number().int().nonnegative()
  })
  .strict();
export type ObsidianFileDeletedEvent = z.infer<typeof obsidianFileDeletedEventSchema>;

export const obsidianReconciliationRequestSchema = z
  .object({
    requestId: requestIdSchema,
    scannedAt: z.string().datetime(),
    files: z.array(
      z
        .object({
          relativePath: relativePathSchema,
          frontmatter: obsidianManagedFrontmatterSchema,
          contentHash: sha256Schema,
          mtimeMs: z.number().int().nonnegative(),
          markdown: z.string().optional()
        })
        .strict()
    )
  })
  .strict();
export type ObsidianReconciliationRequest = z.infer<typeof obsidianReconciliationRequestSchema>;

export const jobProgressEventSchema = z
  .object({
    eventId: requestIdSchema,
    type: z.literal("job-progress"),
    jobId: z.string().uuid(),
    status: z.enum(["queued", "running", "succeeded", "failed", "canceled"]),
    progress: z.number().min(0).max(1),
    emittedAt: z.string().datetime(),
    errorCode: z.string().min(1).optional()
  })
  .strict();
export type JobProgressEvent = z.infer<typeof jobProgressEventSchema>;

export const integrationErrorCodeSchema = z.enum([
  "invalid_request",
  "incompatible_contract",
  "unauthorized",
  "forbidden",
  "not_found",
  "conflict",
  "desktop_unavailable",
  "internal_error"
]);

export const integrationErrorSchema = z
  .object({
    code: integrationErrorCodeSchema,
    messageKey: z.string().min(1),
    retryable: z.boolean(),
    details: metadataSchema.optional()
  })
  .strict();
export type IntegrationError = z.infer<typeof integrationErrorSchema>;

export const integrationCommandResultSchema = z
  .object({
    requestId: requestIdSchema,
    accepted: z.boolean(),
    sourceItemId: z.string().uuid().optional(),
    documentId: z.string().uuid().optional(),
    ingestionRunId: z.string().uuid().optional(),
    jobId: z.string().uuid().optional(),
    duplicate: z.boolean().optional(),
    syncStatus: z.enum(["synced", "conflict", "deleted", "ignored"]).optional()
  })
  .strict();
export type IntegrationCommandResult = z.infer<typeof integrationCommandResultSchema>;

export const integrationEventSchema = z.discriminatedUnion("type", [
  jobProgressEventSchema,
  z
    .object({
      eventId: requestIdSchema,
      type: z.literal("sync-status"),
      memoraId: z.string().uuid(),
      status: z.enum(["synced", "conflict", "deleted", "ignored"]),
      emittedAt: z.string().datetime()
    })
    .strict()
]);
export type IntegrationEvent = z.infer<typeof integrationEventSchema>;

export function normalizeIntegrationError(error: unknown): IntegrationError {
  if (error instanceof z.ZodError) {
    return {
      code: "invalid_request",
      messageKey: "integrations.errors.invalidRequest",
      retryable: false,
      details: { issues: error.issues.map((issue) => ({ path: issue.path.join("."), code: issue.code })) }
    };
  }
  return {
    code: "internal_error",
    messageKey: "integrations.errors.internal",
    retryable: true
  };
}
