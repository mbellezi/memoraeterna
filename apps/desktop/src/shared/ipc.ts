import { z } from "zod";
import {
  AiCapabilitySchema,
  AiModelParameterCapabilitiesSchema,
  AiModelParametersSchema,
  AiReasoningLevelSchema,
  DocumentDivisionCandidateSchema,
  EnrichmentCandidateSchema,
  MetadataEnrichmentQuerySchema,
  ProcessingPlanRequestSchema,
  SearchResultSchema,
  SourceDescriptorDraftSchema,
  SourceDescriptorSchema,
  SourceItemTypeSchema,
  type SourceItemType
} from "@app/domain";

export const ipcChannels = {
  systemGetInfo: "app:system:get-info",
  windowNavigation: "app:window:navigation",
  databaseGetStatus: "app:database:get-status",
  databaseStart: "app:database:start",
  googleBooksKeyStatus: "app:settings:google-books-key:status",
  googleBooksKeyUpdate: "app:settings:google-books-key:update",
  appSettingsGet: "app:settings:app:get",
  appSettingsUpdate: "app:settings:app:update",
  settingsGet: "app:settings:get",
  settingsUpdate: "app:settings:update",
  settingsSelectObsidianVault: "app:settings:select-obsidian-vault",
  obsidianSyncStart: "app:obsidian:sync:start",
  obsidianSyncStatus: "app:obsidian:sync:status",
  debugSimilarityRunsList: "app:debug:similarity-runs:list",
  debugSimilarityRunsClear: "app:debug:similarity-runs:clear",
  libraryReset: "app:library:reset",
  ingestionCreateManual: "app:ingestion:create-manual",
  ingestionPreviewUrl: "app:ingestion:preview-url",
  ingestionEditSource: "app:ingestion:edit-source",
  ingestionExtractFileMetadata: "app:ingestion:extract-file-metadata",
  ingestionFileProgress: "app:ingestion:file-progress",
  ingestionEnrichMetadata: "app:ingestion:enrich-metadata",
  ingestionApplyEnrichmentCover: "app:ingestion:apply-enrichment-cover",
  ingestionFindDuplicate: "app:ingestion:find-duplicate",
  ingestionCreateContainerSource: "app:ingestion:create-container-source",
  ingestionImportFile: "app:ingestion:import-file",
  ingestionLookupSources: "app:ingestion:lookup-sources",
  ingestionStructureGet: "app:ingestion:structure:get",
  ingestionStructureSave: "app:ingestion:structure:save",
  ingestionStructureConfirm: "app:ingestion:structure:confirm",
  ingestionProcess: "app:ingestion:process",
  ingestionBatchesList: "app:ingestion:batches:list",
  jobsList: "app:jobs:list",
  jobsChanged: "app:jobs:changed",
  jobsCancel: "app:jobs:cancel",
  jobsRetry: "app:jobs:retry",
  jobsDelete: "app:jobs:delete",
  jobsClearCompletedOrFailed: "app:jobs:clear-completed-or-failed",
  searchQuery: "app:search:query",
  libraryList: "app:library:list",
  libraryBrowse: "app:library:browse",
  libraryDocumentGet: "app:library:document:get",
  librarySourceGet: "app:library:source:get",
  librarySourceDelete: "app:library:source:delete",
  libraryAssetOpen: "app:library:asset:open",
  libraryAssetData: "app:library:asset:data",
  knowledgePendingNotesList: "app:knowledge:notes:pending:list",
  knowledgeNoteReview: "app:knowledge:notes:review",
  aiProvidersList: "app:ai:providers:list",
  aiProvidersSave: "app:ai:providers:save",
  aiProvidersDelete: "app:ai:providers:delete",
  aiProvidersTest: "app:ai:providers:test",
  aiModelsList: "app:ai:models:list",
  aiModelsDiscover: "app:ai:models:discover",
  aiParameterCapabilitiesGet: "app:ai:parameter-capabilities:get",
  aiOpenAiCodexConnect: "app:ai:openai-codex:connect",
  aiOpenAiCodexDisconnect: "app:ai:openai-codex:disconnect",
  aiProfilesList: "app:ai:profiles:list",
  aiProfilesCreate: "app:ai:profiles:create",
  aiProfilesUpdate: "app:ai:profiles:update",
  aiProfilesClone: "app:ai:profiles:clone",
  aiProfilesDelete: "app:ai:profiles:delete",
  aiProfileTasksList: "app:ai:profiles:tasks:list",
  aiProfileTaskSet: "app:ai:profiles:task:set",
  aiTaskRoutesList: "app:ai:task-routes:list",
  aiTaskRouteSet: "app:ai:task-routes:set",
  aiLocalEmbeddingLoadStatus: "app:ai:local-embedding-load-status",
  localModelsList: "app:local-models:list",
  localModelsDownload: "app:local-models:download",
  localModelsCancel: "app:local-models:cancel",
  localModelsResume: "app:local-models:resume",
  localModelsRemove: "app:local-models:remove",
  localModelsTest: "app:local-models:test",
  localModelsDefaultsSet: "app:local-models:defaults:set",
  localModelsImportGguf: "app:local-models:import-gguf",
  localModelsRepositoryTokenSet: "app:local-models:repository-token:set",
  localModelsRepositoryTokenStatus: "app:local-models:repository-token:status",
  backupCreate: "app:backup:create",
  integrationGatewayStatus: "app:integration:gateway:status",
  integrationClientsList: "app:integration:clients:list",
  integrationPairingCreate: "app:integration:pairing:create",
  integrationClientRevoke: "app:integration:client:revoke"
} as const;

export const databaseLifecycleStateSchema = z.enum([
  "starting",
  "migrating",
  "ready",
  "failed",
  "stopping",
  "stopped"
]);

export const databaseStatusMessageKeySchema = z.enum([
  "database.status.starting",
  "database.status.migrating",
  "database.status.ready",
  "database.status.failed",
  "database.status.stopping",
  "database.status.stopped"
]);

export const databaseStatusSchema = z.object({
  state: databaseLifecycleStateSchema,
  messageKey: databaseStatusMessageKeySchema,
  updatedAt: z.string().datetime(),
  error: z.string().optional()
});

export const deletionPolicySchema = z.enum(["tombstone", "archive", "delete"]);
export const themeModeSchema = z.enum(["dark", "light"]);
export const appLanguageCodes = ["en", "pt-BR", "it", "fr", "es"] as const;
export const languageCodeSchema = z.enum(appLanguageCodes);
export const windowNavigationDirectionSchema = z.enum(["back", "forward"]);

export const savedProcessingPresetSchema = z.object({
  id: z.string().uuid(), name: z.string().trim().min(1).max(100), requestedStages: ProcessingPlanRequestSchema.shape.requestedStages
}).strict();

export const googleBooksKeyInputSchema = z.object({ apiKey: z.string().trim().min(1).max(512).regex(/^[A-Za-z0-9_-]+$/).nullable() }).strict();
export const googleBooksKeyStatusSchema = z.object({ configured: z.boolean() }).strict();

export const appSettingsSchema = z.object({
  processingPresets: savedProcessingPresetSchema.array().max(50).optional(),
  language: languageCodeSchema,
  themeMode: themeModeSchema,
  debugMode: z.boolean().default(false),
  metadataEnrichmentEnabled: z.boolean().default(true),
  keepLocalEmbeddingModelsLoaded: z.boolean().default(true),
  bookMetadataProvider: z.enum(["auto", "open-library", "google-books"]).default("auto"),
  atomicNoteRelationThreshold: z.number().min(0).max(1).default(0.72),
  summaryMinimumWordCount: z.number().int().min(0).max(1_000).default(40),
  updatedAt: z.string().datetime()
});

export const appSettingsUpdateSchema = z.object({
  processingPresets: savedProcessingPresetSchema.array().max(50).optional(),
  language: languageCodeSchema.optional(),
  themeMode: themeModeSchema.optional(),
  debugMode: z.boolean().optional(),
  metadataEnrichmentEnabled: z.boolean().optional(),
  keepLocalEmbeddingModelsLoaded: z.boolean().optional(),
  bookMetadataProvider: z.enum(["auto", "open-library", "google-books"]).optional(),
  atomicNoteRelationThreshold: z.number().min(0).max(1).optional(),
  summaryMinimumWordCount: z.number().int().min(0).max(1_000).optional()
}).strict();

export const storageSettingsSchema = z.object({
  obsidianVaultPath: z.string().nullable(),
  managedRoot: z.string().min(1),
  obsidianSyncEnabled: z.boolean(),
  obsidianSyncPaused: z.boolean(),
  deletionPolicy: deletionPolicySchema,
  uploadCopiesEnabled: z.boolean(),
  uploadCopiesFolderPath: z.string().nullable(),
  updatedAt: z.string().datetime()
});

export const storageSettingsUpdateSchema = storageSettingsSchema
  .omit({ updatedAt: true })
  .partial()
  .strict();

export const obsidianSyncStatusSchema = z.object({
  state: z.enum(["idle", "running", "completed", "failed"]),
  stage: z.enum(["idle", "reconciling", "projecting", "completed", "failed"]),
  progress: z.number().min(0).max(1),
  processed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  synced: z.number().int().nonnegative(),
  conflicts: z.number().int().nonnegative(),
  projected: z.number().int().nonnegative(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  error: z.string().nullable()
}).strict();

export const systemInfoSchema = z.object({
  appName: z.string().min(1),
  locale: z.string().min(2),
  platform: z.string().min(1),
  versions: z.object({
    chrome: z.string().optional(),
    electron: z.string().optional(),
    node: z.string().min(1)
  })
});

export const duplicatePolicySchema = z.enum(["ignore", "update", "version"]);

export const manualIngestionInputSchema = z.object({
  descriptor: SourceDescriptorSchema,
  content: z.string().default(""),
  duplicatePolicy: duplicatePolicySchema.default("ignore"),
  processingPlan: ProcessingPlanRequestSchema.default({
    preset: "full_knowledge", requestedStages: [], scope: "source_only", targetSourceItemIds: [],
    forceRegeneration: false, previousArtifactPolicy: "reuse_valid"
  })
}).strict().superRefine((input, context) => {
  const containerType = ["Book", "PeriodicalIssue", "AcademicPaper"].includes(input.descriptor.type);
  if (!containerType && input.content.trim().length === 0) {
    context.addIssue({ code: "custom", message: "Content is required for this source type.", path: ["content"] });
  }
});

export const fileImportInputSchema = z.object({
  fileToken: z.string().uuid().optional(),
  descriptor: SourceDescriptorSchema,
  duplicatePolicy: duplicatePolicySchema.default("ignore"),
  processingPlan: ProcessingPlanRequestSchema.default({
    preset: "full_knowledge", requestedStages: [], scope: "source_only", targetSourceItemIds: [],
    forceRegeneration: false, previousArtifactPolicy: "reuse_valid"
  })
}).strict();

export const containerSourceInputSchema = z.object({
  descriptor: SourceDescriptorSchema.refine(
    (descriptor) => ["Book", "PeriodicalIssue", "AcademicPaper"].includes(descriptor.type),
    "Only hierarchical root types can be containers."
  ),
  duplicatePolicy: duplicatePolicySchema.default("ignore")
}).strict();

export const duplicateCheckInputSchema = z.object({
  descriptor: SourceDescriptorSchema,
  content: z.string().optional(),
  fileToken: z.string().uuid().optional()
}).strict();

export const duplicateCandidateSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  type: SourceItemTypeSchema
}).strict();

export const fileMetadataExtractionInputSchema = z.object({
  sourceType: SourceItemTypeSchema.default("GenericDocument"),
  requestId: z.string().uuid().optional()
}).strict();

export const fileImportProgressStageSchema = z.enum([
  "selecting_file",
  "inspecting_file",
  "loading_engine",
  "converting_document",
  "processing_pages",
  "serializing",
  "extracting_metadata",
  "storing_cover",
  "completed"
]);

export const fileImportProgressSchema = z.object({
  requestId: z.string().uuid(),
  stage: fileImportProgressStageSchema,
  progress: z.number().min(0).max(1),
  completedPages: z.number().int().nonnegative().optional(),
  totalPages: z.number().int().positive().optional()
}).strict().superRefine((event, context) => {
  if (event.completedPages !== undefined && event.totalPages !== undefined
      && event.completedPages > event.totalPages) {
    context.addIssue({
      code: "custom",
      message: "Completed pages cannot exceed total pages.",
      path: ["completedPages"]
    });
  }
});

export const fileMetadataExtractionResultSchema = z.object({
  fileToken: z.string().uuid(),
  fileName: z.string().min(1),
  mimeType: z.string().min(1),
  draft: SourceDescriptorDraftSchema
}).strict();

export const metadataEnrichmentInputSchema = MetadataEnrichmentQuerySchema;
export const metadataEnrichmentResultSchema = EnrichmentCandidateSchema.array();
export const enrichmentCoverInputSchema = z.object({ coverUrl: z.string().url() }).strict();
export const enrichmentCoverResultSchema = z.object({
  assetId: z.string().uuid(),
  mimeType: z.string().min(1)
}).strict();

export const ingestionResultSchema = z.object({
  sourceItemId: z.string().uuid(),
  documentId: z.string().uuid().nullable(),
  ingestionRunId: z.string().uuid().nullable(),
  jobId: z.string().uuid().nullable(),
  batchId: z.string().uuid().nullable(),
  structureId: z.string().uuid().nullable(),
  requiresStructureReview: z.boolean(),
  duplicate: z.boolean()
}).strict();

export const documentDivisionViewSchema = DocumentDivisionCandidateSchema.safeExtend({
  childSourceItemId: z.string().uuid().nullable(),
  childDocumentId: z.string().uuid().nullable()
});

export const documentStructureViewSchema = z.object({
  id: z.string().uuid(),
  rootSourceItemId: z.string().uuid(),
  rootDocumentId: z.string().uuid(),
  format: z.string().min(1),
  detectorVersion: z.string().min(1),
  status: z.enum(["draft", "in_review", "confirmed", "materialized", "superseded"]),
  overallConfidence: z.number().min(0).max(1),
  revision: z.number().int().positive(),
  warnings: z.array(z.string()),
  rootMarkdown: z.string(),
  boundaries: z.array(z.object({
    offset: z.number().int().nonnegative(),
    label: z.string().min(1),
    kind: z.enum(["heading", "division", "page"]),
    page: z.number().int().positive().optional()
  }).strict()),
  divisions: z.array(documentDivisionViewSchema),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();

export const structureConfirmInputSchema = z.object({
  structureId: z.string().uuid(),
  divisions: z.array(DocumentDivisionCandidateSchema),
  plan: ProcessingPlanRequestSchema
}).strict();

export const structureSaveInputSchema = z.object({
  structureId: z.string().uuid(),
  divisions: z.array(DocumentDivisionCandidateSchema)
}).strict();

export const processingRequestSchema = z.object({
  plan: ProcessingPlanRequestSchema,
  runKind: z.enum(["initial", "missing_stages", "reingestion"]),
  trigger: z.enum(["library_action", "interactive_import", "integration", "recovery"]).optional()
}).strict();

export const processingQueueResultSchema = z.object({
  batchId: z.string().uuid(),
  queued: z.array(z.object({
    sourceItemId: z.string().uuid(),
    documentId: z.string().uuid(),
    ingestionRunId: z.string().uuid(),
    jobId: z.string().uuid().nullable()
  }).strict())
}).strict();

export const processingBatchSchema = z.object({
  id: z.string().uuid(), trigger: z.string(), requestedPlan: z.record(z.string(), z.unknown()),
  effectivePlan: z.record(z.string(), z.unknown()), reingestionPolicy: z.string(), status: z.string(),
  progress: z.number().min(0).max(1), totalItems: z.number().int().nonnegative(),
  completedItems: z.number().int().nonnegative(), failedItems: z.number().int().nonnegative(),
  createdAt: z.string().datetime(), updatedAt: z.string().datetime()
}).strict();

export const sourceSuggestionSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  type: SourceItemTypeSchema
}).strict();

export const sourceLookupInputSchema = z.object({
  query: z.string().trim().min(1).max(200),
  sourceTypes: z.array(SourceItemTypeSchema).max(11).default([])
}).strict();

export const jobRecordSchema = z.object({
  id: z.string().uuid(),
  type: z.string().min(1),
  status: z.enum(["queued", "running", "succeeded", "failed", "canceled"]),
  progress: z.number().min(0).max(1),
  attempts: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  canCancel: z.boolean(),
  canRetry: z.boolean(),
  canDelete: z.boolean().default(false),
  error: z.string().nullable(),
  errorHistory: z.array(z.object({
    message: z.string().min(1),
    stage: z.string().min(1),
    attempt: z.number().int().nonnegative(),
    occurredAt: z.string().datetime()
  }).strict()).default([]),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  aiExecution: z.object({
    provider: z.string().min(1),
    modelId: z.string().min(1),
    reasoningLevel: AiReasoningLevelSchema.nullable()
  }).strict().nullable(),
  source: z.object({
    id: z.string().uuid(),
    title: z.string().min(1),
    type: SourceItemTypeSchema,
    origin: z.string().min(1)
  }).strict().nullable().optional(),
  ingestionRun: z.object({
    id: z.string().uuid(),
    batchId: z.string().uuid().nullable().default(null),
    status: z.enum(["pending", "running", "succeeded", "failed", "canceled"]),
    currentStage: z.string().min(1),
    effectiveStages: z.array(z.string()).default([]),
    stagesCheckpoint: z.record(z.string(), z.unknown())
  }).strict().nullable().optional()
}).strict();

export const jobsClearResultSchema = z.object({
  deletedCount: z.number().int().nonnegative()
}).strict();

export const jobsDeleteResultSchema = z.object({
  deletedJobs: z.number().int().nonnegative(),
  deletedRuns: z.number().int().nonnegative()
}).strict();

export const libraryResetResultSchema = z.object({
  deletedSources: z.number().int().nonnegative(),
  deletedAtomicNotes: z.number().int().nonnegative(),
  deletedFiles: z.number().int().nonnegative(),
  failedFiles: z.number().int().nonnegative()
}).strict();

export const sourceDeletionResultSchema = z.object({
  deletedSources: z.number().int().nonnegative(),
  deletedAtomicNotes: z.number().int().nonnegative(),
  deletedFiles: z.number().int().nonnegative(),
  failedFiles: z.number().int().nonnegative(),
  graphCleanupFailed: z.boolean()
}).strict();

export const librarySourceSchema = z.object({
  id: z.string().uuid(),
  parentSourceItemId: z.string().uuid().nullable(),
  parentTitle: z.string().nullable().default(null),
  structurePosition: z.number().int().nonnegative().nullable(),
  childCount: z.number().int().nonnegative(),
  hasDocument: z.boolean(),
  type: SourceItemTypeSchema,
  title: z.string().min(1),
  subtitle: z.string().nullable(),
  sourceUri: z.string().nullable(),
  language: z.string().min(1),
  summary: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  processingStatus: z.string().min(1),
  currentStage: z.string().min(1),
  textScore: z.number().min(0).max(1).nullable().default(null),
  embeddingScore: z.number().min(0).max(1).nullable().default(null),
  rankingScore: z.number().nonnegative().nullable().default(null),
  matchKind: z.enum(["traditional", "embedding", "combined"]).nullable().default(null),
  updatedAt: z.string().datetime()
}).strict();

export const libraryBrowseInputSchema = z.object({
  sourceTypes: SourceItemTypeSchema.array().default([]), query: z.string().max(500).default(""),
  searchMode: z.enum(["traditional", "hybrid"]).default("hybrid"),
  parentId: z.string().uuid().nullable().optional(), ids: z.string().uuid().array().max(100).optional(),
  offset: z.number().int().nonnegative().default(0), limit: z.number().int().min(1).max(100).default(48)
}).strict();
export const sourceUrlPreviewInputSchema = z.object({ type: z.enum(["WebArticle", "Video"]), url: z.string().url().max(4000) }).strict();
export const sourceUrlPreviewSchema = z.object({ draft: SourceDescriptorDraftSchema, markdown: z.string().max(20_000_000) }).strict();
export const sourceEditInputSchema = z.object({
  sourceItemId: z.string().uuid(), expectedUpdatedAt: z.string().datetime(), descriptor: SourceDescriptorSchema,
  content: z.object({ documentId: z.string().uuid().nullable(), markdown: z.string().min(1).max(20_000_000) }).strict().optional()
}).strict();
export const sourceEditResultSchema = z.object({
  sourceItemId: z.string().uuid(), documentId: z.string().uuid().nullable(), contentChanged: z.boolean()
}).strict();
export type LibraryBrowseInput = z.input<typeof libraryBrowseInputSchema>;
export type SourceEditInput = z.infer<typeof sourceEditInputSchema>;

export const atomicNoteViewSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  bodyMarkdown: z.string().min(1),
  ideaStatement: z.string().min(1),
  language: z.string().min(1),
  status: z.enum(["pending_review", "approved", "rejected", "archived"]),
  sourceItemId: z.string().uuid(),
  sourceSpanId: z.string().uuid().nullable(),
  evidenceChunkId: z.string().uuid(),
  generationModel: z.string().min(1),
  generationPromptVersion: z.string().min(1),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();

export const pendingAtomicNoteSchema = atomicNoteViewSchema.extend({
  sourceTitle: z.string().nullable()
}).strict();

export const sourceDocumentInputSchema = z.object({ sourceItemId: z.string().uuid(), documentId: z.string().uuid() }).strict();
export const sourceDocumentSchema = z.object({ title: z.string(), markdown: z.string() }).strict();
export const sourceDetailSchema = z.object({
  history: z.array(z.object({ id: z.string().uuid(), title: z.string(), createdAt: z.string().datetime(), isCurrent: z.boolean() })).default([]),
  breadcrumbs: z.array(z.object({ id: z.string().uuid(), title: z.string() })).default([]),
  parentSourceItemId: z.string().uuid().nullable().default(null),
  id: z.string().uuid(),
  type: SourceItemTypeSchema,
  title: z.string().min(1),
  subtitle: z.string().nullable(),
  sourceUri: z.string().nullable(),
  language: z.string().min(1),
  summary: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  updatedAt: z.string().datetime(),
  assets: z.array(z.object({
    id: z.string().uuid(), originalFileName: z.string().min(1), mimeType: z.string().min(1), role: z.string().min(1)
  }).strict()),
  documents: z.array(z.object({
    id: z.string().uuid(),
    title: z.string().min(1),
    canonicalMarkdown: z.string(),
    language: z.string().min(1),
    chunks: z.array(z.object({
      id: z.string().uuid(),
      content: z.string(),
      chunkIndex: z.number().int().nonnegative(),
      sourceSpanId: z.string().uuid().nullable()
    }).strict()),
    assets: z.array(z.object({
      id: z.string().uuid(),
      originalFileName: z.string().min(1),
      mimeType: z.string().min(1),
      role: z.string().min(1)
    }).strict())
  }).strict()),
  summaries: z.array(z.object({
    id: z.string().uuid(),
    summary: z.string().min(1),
    provider: z.string().min(1),
    model: z.string().min(1),
    promptVersion: z.string().min(1),
    generatedAt: z.string().datetime()
  }).strict()),
  atomicNotes: z.array(atomicNoteViewSchema),
  relations: z.array(z.object({
    id: z.string().uuid(),
    sourceAtomicNoteId: z.string().uuid(),
    targetAtomicNoteId: z.string().uuid(),
    sourceTitle: z.string().min(1),
    targetTitle: z.string().min(1),
    sourceStatus: z.string().min(1),
    targetStatus: z.string().min(1),
    relationType: z.string().min(1),
    finalScore: z.number().min(0).max(1),
    explanation: z.string().min(1)
  }).strict())
}).strict();

export const atomicNoteReviewInputSchema = z.object({
  id: z.string().uuid(),
  action: z.enum(["approve", "edit", "discard"]),
  title: z.string().trim().min(1).optional(),
  bodyMarkdown: z.string().trim().min(1).optional(),
  ideaStatement: z.string().trim().min(1).optional()
}).strict().superRefine((input, context) => {
  if (input.action === "edit" && input.title === undefined
      && input.bodyMarkdown === undefined && input.ideaStatement === undefined) {
    context.addIssue({ code: "custom", message: "Edit requires content.", path: ["action"] });
  }
});

export const searchInputSchema = z.object({
  text: z.string().trim().min(1),
  sourceTypes: z.array(SourceItemTypeSchema).default([]),
  rootSourceItemId: z.string().uuid().optional(),
  mode: z.enum(["text", "hybrid"]).default("hybrid"),
  limit: z.number().int().min(1).max(100).default(20)
}).strict();

export const searchResultsSchema = z.array(SearchResultSchema);

export const localEmbeddingLoadStatusSchema = z.object({
  state: z.enum(["loading", "ready", "failed"]),
  modelId: z.string().min(1)
}).strict();

export const similarityDebugResultSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  targetType: z.enum(["chunk", "atomic_note"]),
  targetId: z.string().uuid(),
  targetLabel: z.string().nullable(),
  finalRank: z.number().int().positive(),
  textRank: z.number().int().positive().nullable(),
  vectorRank: z.number().int().positive().nullable(),
  graphRank: z.number().int().positive().nullable(),
  textScore: z.number().finite().nullable(),
  vectorScore: z.number().finite().nullable(),
  metadataScore: z.number().finite().nullable(),
  graphScore: z.number().finite().nullable(),
  rerankScore: z.number().finite().nullable(),
  fusionScore: z.number().finite().nullable(),
  finalScore: z.number().finite(),
  passedThreshold: z.boolean().nullable(),
  explanation: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime()
}).strict();

export const similarityDebugRunSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["chunk_search", "atomic_note_matching"]),
  queryText: z.string(),
  queryTargetId: z.string().uuid().nullable(),
  mode: z.string().min(1),
  model: z.string().nullable(),
  dimensions: z.number().int().positive().nullable(),
  requestedLimit: z.number().int().positive(),
  strategy: z.string().min(1),
  metadata: z.record(z.string(), z.unknown()),
  createdAt: z.string().datetime(),
  results: z.array(similarityDebugResultSchema)
}).strict();

export const similarityDebugClearResultSchema = z.object({
  deletedCount: z.number().int().nonnegative()
}).strict();

export const aiProviderKindSchema = z.enum(["google", "openai-compatible", "openai-codex"]);
export const aiReasoningLevelSchema = AiReasoningLevelSchema;
export const aiModelParameterCapabilitiesSchema = AiModelParameterCapabilitiesSchema;
export const aiModelParametersSchema = AiModelParametersSchema;
export const aiConfigurableTaskSchema = z.enum([
  "embedding",
  "summarization",
  "text-generation",
  "structured-output",
  "knowledge-graph-generation",
  "atomic-note-generation",
  "reranking"
]);
export const aiOutputLanguageSchema = z.union([languageCodeSchema, z.literal("ui")]);
export const aiProviderConfigInputSchema = z.object({
  id: z.string().uuid().optional(),
  provider: aiProviderKindSchema,
  displayName: z.string().trim().min(1),
  baseUrl: z.string().url().nullable().optional(),
  apiKey: z.string().min(1).optional(),
  modelId: z.string().trim().min(1),
  capabilities: z.array(AiCapabilitySchema).default([]),
  defaultParameters: aiModelParametersSchema.default({})
}).strict();

export const aiModelDiscoveryInputSchema = z.object({
  provider: aiProviderKindSchema,
  baseUrl: z.string().url().nullable().optional(),
  apiKey: z.string().min(1).optional()
}).strict().superRefine((input, context) => {
  if (input.provider !== "openai-codex" && !input.apiKey) {
    context.addIssue({ code: "custom", message: "API key is required.", path: ["apiKey"] });
  }
});

export const aiParameterCapabilitiesInputSchema = z.object({
  provider: aiProviderKindSchema,
  modelId: z.string().trim().min(1),
  baseUrl: z.string().url().nullable().optional(),
  capabilities: z.array(AiCapabilitySchema).default([])
}).strict();

export const aiModelListSchema = z.array(z.string().min(1));

export const aiProviderConfigSchema = aiProviderConfigInputSchema.omit({ apiKey: true }).extend({
  id: z.string().uuid(),
  parameterCapabilities: aiModelParameterCapabilitiesSchema,
  secretConfigured: z.boolean(),
  status: z.string().min(1)
}).strict();

export const aiProfileSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1),
  description: z.string().nullable(),
  isDefault: z.boolean(),
  privacyMode: z.string().min(1),
  outputLanguage: aiOutputLanguageSchema,
  providerConfigId: z.string().uuid().nullable(),
  localModelId: z.string().uuid().nullable(),
  modelId: z.string().min(1).nullable(),
  runtime: z.enum(["remote", "gguf", "mlx"]).nullable(),
  capabilities: z.array(AiCapabilitySchema),
  status: z.string().min(1)
}).strict();

export const aiProfileCreateSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().nullable().optional(),
  isDefault: z.boolean().default(false),
  privacyMode: z.enum(["allow_remote", "offline_only"]).default("allow_remote"),
  outputLanguage: aiOutputLanguageSchema.default("ui")
}).strict();

export const aiProfileUpdateSchema = z.object({
  id: z.string().uuid(),
  name: z.string().trim().min(1).optional(),
  privacyMode: z.enum(["allow_remote", "offline_only"]).optional(),
  outputLanguage: aiOutputLanguageSchema.optional(),
  providerConfigId: z.string().uuid().nullable().optional(),
  localModelId: z.string().uuid().nullable().optional(),
  modelId: z.string().trim().min(1).nullable().optional(),
  runtime: z.enum(["remote", "gguf", "mlx"]).nullable().optional(),
  capabilities: z.array(AiCapabilitySchema).optional()
}).strict().superRefine((input, context) => {
  const updatesModel = input.providerConfigId !== undefined || input.localModelId !== undefined
    || input.modelId !== undefined || input.runtime !== undefined || input.capabilities !== undefined;
  if (updatesModel) {
    const hasRemote = Boolean(input.providerConfigId);
    const hasLocal = Boolean(input.localModelId);
    if (hasRemote === hasLocal) {
      context.addIssue({ code: "custom", message: "Select exactly one remote or local model.", path: ["modelId"] });
    }
    if (!input.modelId || !input.runtime || input.capabilities === undefined) {
      context.addIssue({ code: "custom", message: "Model id, runtime and capabilities are required together.", path: ["modelId"] });
    }
  }
});

export const aiProfileCloneSchema = z.object({
  profileId: z.string().uuid(),
  name: z.string().trim().min(1)
}).strict();

export const aiProfileTaskInputSchema = z.object({
  profileId: z.string().uuid(),
  task: aiConfigurableTaskSchema,
  parameters: aiModelParametersSchema.default({})
}).strict();

export const aiProfileTaskSchema = z.object({
  profileId: z.string().uuid(),
  task: aiConfigurableTaskSchema,
  parameters: aiModelParametersSchema
}).strict();

export const aiTaskRouteSchema = z.object({
  task: aiConfigurableTaskSchema,
  profileId: z.string().uuid()
}).strict();

export const localModelStatusSchema = z.enum([
  "not_downloaded", "downloading", "verifying", "ready", "failed", "removing"
]);

export const localModelRecommendedParametersSchema = z.object({
  reasoning: aiModelParametersSchema.optional(),
  nonReasoning: aiModelParametersSchema.optional()
}).strict().refine(
  (presets) => presets.reasoning !== undefined || presets.nonReasoning !== undefined,
  { message: "At least one recommended parameter preset is required." }
);

export const localModelViewSchema = z.object({
  id: z.string().uuid(),
  catalogId: z.string().min(1),
  modelId: z.string().min(1),
  displayName: z.string().min(1),
  family: z.string().min(1),
  variant: z.string().min(1),
  repository: z.string().min(1),
  revision: z.string().min(1),
  runtime: z.enum(["gguf", "mlx"]),
  format: z.string().min(1),
  quantization: z.string().min(1),
  capabilities: z.array(AiCapabilitySchema),
  parameterCapabilities: aiModelParameterCapabilitiesSchema,
  defaultParameters: aiModelParametersSchema,
  recommendedParameters: localModelRecommendedParametersSchema.nullable(),
  minimumMemoryBytes: z.number().int().nonnegative(),
  recommendedMemoryBytes: z.number().int().nonnegative(),
  expectedSizeBytes: z.number().int().nonnegative(),
  installedSizeBytes: z.number().int().nonnegative(),
  licenseName: z.string().min(1),
  licenseUrl: z.string().url(),
  requiresLicenseAcceptance: z.boolean(),
  licenseAccepted: z.boolean(),
  status: localModelStatusSchema,
  compatible: z.boolean(),
  compatibilityReason: z.enum(["compatible", "unsupported_platform", "insufficient_memory"]),
  profilesUsing: z.array(z.string()),
  lastError: z.string().nullable(),
  download: z.object({
    jobId: z.string().uuid(),
    currentFile: z.string().nullable(),
    downloadedBytes: z.number().int().nonnegative(),
    totalBytes: z.number().int().nonnegative(),
    bytesPerSecond: z.number().int().nonnegative(),
    etaSeconds: z.number().int().nonnegative().nullable()
  }).strict().nullable()
}).strict();

export const localModelDefaultsInputSchema = z.object({
  localModelId: z.string().uuid(),
  defaultParameters: aiModelParametersSchema
}).strict();

export const localModelDownloadInputSchema = z.object({
  catalogId: z.string().min(1),
  acceptLicense: z.boolean().default(false)
}).strict();

export const repositoryTokenInputSchema = z.object({ token: z.string().min(1) }).strict();

export const backupResultSchema = z.object({
  path: z.string().min(1),
  createdAt: z.string().datetime(),
  included: z.array(z.enum(["database", "obsidian", "uploadedFiles"]))
}).strict();

export const integrationGatewayStatusSchema = z.object({
  state: z.enum(["stopped", "starting", "ready", "failed"]),
  host: z.literal("127.0.0.1"),
  port: z.number().int().positive().nullable(),
  baseUrl: z.string().url().nullable()
}).strict();

export const integrationPairingInputSchema = z.object({
  clientType: z.enum(["chrome-extension", "obsidian-plugin"]),
  displayName: z.string().trim().min(1).max(120)
}).strict();

export const integrationPairingResultSchema = z.object({
  clientId: z.string().uuid(),
  token: z.string().min(32)
}).strict();

export const integrationClientSchema = z.object({
  id: z.string().uuid(),
  clientType: z.string().min(1),
  displayName: z.string().min(1),
  scopes: z.array(z.string()),
  capabilities: z.array(z.string()),
  contractVersion: z.string().min(1),
  status: z.enum(["paired", "revoked", "disabled"]),
  lastSeenAt: z.date().nullable(),
  createdAt: z.date(),
  updatedAt: z.date()
}).strict();

export type DeletionPolicy = z.infer<typeof deletionPolicySchema>;
export type DatabaseLifecycleState = z.infer<typeof databaseLifecycleStateSchema>;
export type DatabaseStatus = z.infer<typeof databaseStatusSchema>;
export type DatabaseStatusMessageKey = z.infer<typeof databaseStatusMessageKeySchema>;
export type ThemeMode = z.infer<typeof themeModeSchema>;
export type AppSettings = z.infer<typeof appSettingsSchema>;
export type AppSettingsUpdate = z.infer<typeof appSettingsUpdateSchema>;
export type StorageSettings = z.infer<typeof storageSettingsSchema>;
export type StorageSettingsUpdate = z.infer<typeof storageSettingsUpdateSchema>;
export type SystemInfo = z.infer<typeof systemInfoSchema>;
export type DuplicatePolicy = z.infer<typeof duplicatePolicySchema>;
export type ManualIngestionInput = z.infer<typeof manualIngestionInputSchema>;
export type FileImportInput = z.infer<typeof fileImportInputSchema>;
export type ContainerSourceInput = z.infer<typeof containerSourceInputSchema>;
export type DuplicateCheckInput = z.infer<typeof duplicateCheckInputSchema>;
export type DuplicateCandidate = z.infer<typeof duplicateCandidateSchema>;
export type FileMetadataExtractionInput = z.infer<typeof fileMetadataExtractionInputSchema>;
export type FileMetadataExtractionResult = z.infer<typeof fileMetadataExtractionResultSchema>;
export type FileImportProgress = z.infer<typeof fileImportProgressSchema>;
export type MetadataEnrichmentInput = z.infer<typeof metadataEnrichmentInputSchema>;
export type EnrichmentCandidate = z.infer<typeof EnrichmentCandidateSchema>;
export type EnrichmentCoverResult = z.infer<typeof enrichmentCoverResultSchema>;
export type IngestionResult = z.infer<typeof ingestionResultSchema>;
export type DocumentStructureView = z.infer<typeof documentStructureViewSchema>;
export type StructureConfirmInput = z.infer<typeof structureConfirmInputSchema>;
export type StructureSaveInput = z.infer<typeof structureSaveInputSchema>;
export type ProcessingRequest = z.infer<typeof processingRequestSchema>;
export type ProcessingQueueResult = z.infer<typeof processingQueueResultSchema>;
export type ProcessingBatch = z.infer<typeof processingBatchSchema>;
export type SourceSuggestion = z.infer<typeof sourceSuggestionSchema>;
export type JobRecord = z.infer<typeof jobRecordSchema>;
export type JobsClearResult = z.infer<typeof jobsClearResultSchema>;
export type JobsDeleteResult = z.infer<typeof jobsDeleteResultSchema>;
export type LibraryResetResult = z.infer<typeof libraryResetResultSchema>;
export type SourceDeletionResult = z.infer<typeof sourceDeletionResultSchema>;
export type SearchInput = z.infer<typeof searchInputSchema>;
export type SearchResult = z.infer<typeof SearchResultSchema>;
export type LocalEmbeddingLoadStatus = z.infer<typeof localEmbeddingLoadStatusSchema>;
export type SimilarityDebugRun = z.infer<typeof similarityDebugRunSchema>;
export type LibrarySource = z.infer<typeof librarySourceSchema>;
export type SourceDetail = z.infer<typeof sourceDetailSchema>;
export type AtomicNoteView = z.infer<typeof atomicNoteViewSchema>;
export type PendingAtomicNote = z.infer<typeof pendingAtomicNoteSchema>;
export type AtomicNoteReviewInput = z.infer<typeof atomicNoteReviewInputSchema>;
export type AiProviderConfigInput = z.infer<typeof aiProviderConfigInputSchema>;
export type AiProviderConfig = z.infer<typeof aiProviderConfigSchema>;
export type AiModelDiscoveryInput = z.infer<typeof aiModelDiscoveryInputSchema>;
export type AiParameterCapabilitiesInput = z.infer<typeof aiParameterCapabilitiesInputSchema>;
export type AiProfile = z.infer<typeof aiProfileSchema>;
export type AiProfileCreate = z.infer<typeof aiProfileCreateSchema>;
export type AiProfileUpdate = z.infer<typeof aiProfileUpdateSchema>;
export type AiProfileTaskInput = z.infer<typeof aiProfileTaskInputSchema>;
export type AiProfileTask = z.infer<typeof aiProfileTaskSchema>;
export type AiTaskRoute = z.infer<typeof aiTaskRouteSchema>;
export type AiConfigurableTask = z.infer<typeof aiConfigurableTaskSchema>;
export type AiModelParameters = z.infer<typeof aiModelParametersSchema>;
export type AiModelParameterCapabilities = z.infer<typeof aiModelParameterCapabilitiesSchema>;
export type AiOutputLanguage = z.infer<typeof aiOutputLanguageSchema>;
export type LocalModelView = z.infer<typeof localModelViewSchema>;
export type LocalModelDownloadInput = z.infer<typeof localModelDownloadInputSchema>;
export type BackupResult = z.infer<typeof backupResultSchema>;
export type IntegrationGatewayStatus = z.infer<typeof integrationGatewayStatusSchema>;
export type IntegrationPairingInput = z.infer<typeof integrationPairingInputSchema>;
export type IntegrationPairingResult = z.infer<typeof integrationPairingResultSchema>;
export type IntegrationClient = z.infer<typeof integrationClientSchema>;
export type ObsidianSyncStatus = z.infer<typeof obsidianSyncStatusSchema>;
export type WindowNavigationDirection = z.infer<typeof windowNavigationDirectionSchema>;

export const defaultAppSettings = {
  themeMode: "dark",
  debugMode: false,
  metadataEnrichmentEnabled: true,
  keepLocalEmbeddingModelsLoaded: true,
  bookMetadataProvider: "auto",
  atomicNoteRelationThreshold: 0.72,
  summaryMinimumWordCount: 40
} satisfies Omit<AppSettingsUpdate, "language">;

export const defaultStorageSettings = {
  obsidianVaultPath: null,
  managedRoot: "Memora",
  obsidianSyncEnabled: false,
  obsidianSyncPaused: false,
  deletionPolicy: "tombstone",
  uploadCopiesEnabled: false,
  uploadCopiesFolderPath: null
} satisfies StorageSettingsUpdate;

export interface DesktopApi {
  system: {
    getInfo: () => Promise<SystemInfo>;
    subscribeNavigation: (listener: (direction: WindowNavigationDirection) => void) => () => void;
  };
  database: {
    getStatus: () => Promise<DatabaseStatus>;
    start: () => Promise<DatabaseStatus>;
  };
  settings: {
    getGoogleBooksKeyStatus: () => Promise<{ configured: boolean }>;
    updateGoogleBooksKey: (input: { apiKey: string | null }) => Promise<{ configured: boolean }>;
    getApp: () => Promise<AppSettings>;
    updateApp: (settings: AppSettingsUpdate) => Promise<AppSettings>;
    get: () => Promise<StorageSettings>;
    update: (settings: StorageSettingsUpdate) => Promise<StorageSettings>;
    selectObsidianVault: () => Promise<StorageSettings | null>;
    resetLibrary: () => Promise<LibraryResetResult>;
  };
  obsidian: {
    startSync: () => Promise<ObsidianSyncStatus>;
    getSyncStatus: () => Promise<ObsidianSyncStatus>;
  };
  debug: {
    listSimilarityRuns: () => Promise<SimilarityDebugRun[]>;
    clearSimilarityRuns: () => Promise<{ deletedCount: number }>;
  };
  ingestion: {
    createManual: (input: ManualIngestionInput) => Promise<IngestionResult>;
    previewUrl: (input: z.infer<typeof sourceUrlPreviewInputSchema>) => Promise<z.infer<typeof sourceUrlPreviewSchema>>;
    editSource: (input: SourceEditInput) => Promise<z.infer<typeof sourceEditResultSchema>>;
    extractFileMetadata: (
      input: FileMetadataExtractionInput,
      onProgress?: (progress: FileImportProgress) => void
    ) => Promise<FileMetadataExtractionResult | null>;
    enrichMetadata: (input: MetadataEnrichmentInput) => Promise<EnrichmentCandidate[]>;
    applyEnrichmentCover: (coverUrl: string) => Promise<EnrichmentCoverResult>;
    findDuplicate: (input: DuplicateCheckInput) => Promise<DuplicateCandidate | null>;
    createContainerSource: (input: ContainerSourceInput) => Promise<IngestionResult>;
    importFile: (input: FileImportInput) => Promise<IngestionResult | null>;
    lookupSources: (query: string, sourceTypes?: SourceItemType[]) => Promise<SourceSuggestion[]>;
    getStructure: (structureId: string) => Promise<DocumentStructureView | null>;
    saveStructure: (input: StructureSaveInput) => Promise<DocumentStructureView>;
    confirmStructure: (input: StructureConfirmInput) => Promise<ProcessingQueueResult>;
    process: (input: ProcessingRequest) => Promise<ProcessingQueueResult>;
    listBatches: () => Promise<ProcessingBatch[]>;
  };
  jobs: {
    list: () => Promise<JobRecord[]>;
    subscribe: (listener: () => void) => () => void;
    cancel: (jobId: string) => Promise<JobRecord | null>;
    retry: (jobId: string) => Promise<JobRecord | null>;
    delete: (jobId: string) => Promise<JobsDeleteResult | null>;
    clearCompletedOrFailed: () => Promise<JobsClearResult>;
  };
  search: {
    query: (input: SearchInput) => Promise<SearchResult[]>;
  };
  knowledge: {
    listLibrary: (sourceTypes?: SourceItemType[]) => Promise<LibrarySource[]>;
    browseLibrary: (input: LibraryBrowseInput) => Promise<LibrarySource[]>;
    getSourceDocument: (input: z.infer<typeof sourceDocumentInputSchema>) => Promise<z.infer<typeof sourceDocumentSchema>>;
    getSourceDetail: (sourceItemId: string) => Promise<SourceDetail | null>;
    deleteSource: (sourceItemId: string) => Promise<SourceDeletionResult>;
    openAsset: (assetId: string) => Promise<boolean>;
    getAssetDataUrl: (assetId: string) => Promise<string | null>;
    listPendingNotes: () => Promise<PendingAtomicNote[]>;
    reviewNote: (input: AtomicNoteReviewInput) => Promise<AtomicNoteView | null>;
  };
  ai: {
    listProviders: () => Promise<AiProviderConfig[]>;
    saveProvider: (input: AiProviderConfigInput) => Promise<AiProviderConfig>;
    deleteProvider: (providerId: string) => Promise<boolean>;
    testProvider: (providerId: string) => Promise<boolean>;
    listModels: (providerId: string) => Promise<string[]>;
    discoverModels: (input: AiModelDiscoveryInput) => Promise<string[]>;
    getParameterCapabilities: (input: AiParameterCapabilitiesInput) => Promise<AiModelParameterCapabilities>;
    connectOpenAiCodex: () => Promise<string[]>;
    disconnectOpenAiCodex: () => Promise<void>;
    listProfiles: () => Promise<AiProfile[]>;
    createProfile: (input: AiProfileCreate) => Promise<AiProfile>;
    updateProfile: (input: AiProfileUpdate) => Promise<AiProfile>;
    cloneProfile: (profileId: string, name: string) => Promise<AiProfile>;
    deleteProfile: (profileId: string) => Promise<boolean>;
    listProfileTasks: (profileId?: string) => Promise<AiProfileTask[]>;
    setProfileTask: (input: AiProfileTaskInput) => Promise<void>;
    listTaskRoutes: () => Promise<AiTaskRoute[]>;
    setTaskRoute: (input: AiTaskRoute) => Promise<void>;
    subscribeLocalEmbeddingLoadStatus: (listener: (status: LocalEmbeddingLoadStatus) => void) => () => void;
  };
  localModels: {
    list: () => Promise<LocalModelView[]>;
    download: (input: LocalModelDownloadInput) => Promise<LocalModelView>;
    cancel: (catalogId: string) => Promise<LocalModelView>;
    resume: (catalogId: string) => Promise<LocalModelView>;
    remove: (catalogId: string) => Promise<LocalModelView>;
    test: (catalogId: string) => Promise<string>;
    setDefaults: (localModelId: string, defaultParameters: AiModelParameters) => Promise<LocalModelView>;
    importGguf: () => Promise<LocalModelView | null>;
    setRepositoryToken: (token: string) => Promise<boolean>;
    hasRepositoryToken: () => Promise<boolean>;
  };
  backup: {
    create: () => Promise<BackupResult | null>;
  };
  integrations: {
    getGatewayStatus: () => Promise<IntegrationGatewayStatus>;
    listClients: () => Promise<IntegrationClient[]>;
    createPairing: (input: IntegrationPairingInput) => Promise<IntegrationPairingResult>;
    revokeClient: (clientId: string) => Promise<boolean>;
  };
}
