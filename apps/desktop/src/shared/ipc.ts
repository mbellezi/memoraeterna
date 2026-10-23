import {
  obsidianLayoutStatusSchema,
  obsidianLayoutConfigSchema,
  obsidianLayoutApplyInputSchema
} from "@app/integration-contracts";
export { obsidianLayoutStatusSchema, obsidianLayoutConfigSchema, obsidianLayoutApplyInputSchema };
import type {
  BudgetSnapshot,
  ImportEstimate,
  ImportEstimateInput,
  NoteDeciderMode,
  PromptCommand
} from "@app/domain";
import {
  AiClassIdSchema,
  AiPresetIdSchema,
  AiPresetModeSchema,
  DecisionsStatusSchema,
  NoteDeciderModeSchema,
  NotePageRelationStateSchema,
  NoteRelationBandSchema,
  NoteRelationCalibrationSchema,
  relationExplanationLimits
} from "@app/domain";
import {
  obsidianEditorialConflictsSchema,
  obsidianResolveInputSchema,
  type ObsidianEditReceipt
} from "@app/integration-contracts";
export { obsidianEditorialConflictsSchema, obsidianResolveInputSchema };
import type { ObsidianDeepLink } from "./obsidian-deep-link.js";
import type { AppMenuCommand } from "./app-menu.js";
import type { AppEventHandler, AppEventType } from "./app-events.js";
import type {
  ViewHistoryEntry,
  ViewHistoryListInput,
  ViewHistoryRecordInput
} from "./view-history.js";
import type {
  ConsultationInput,
  ConsultationResult,
  NotePage,
  NotePageInputSchema,
  NotePageRelations,
  NoteRelationsInputSchema,
  ObjectLocateInput,
  ObjectNeighborhood,
  ObjectNeighborhoodInput,
  RelationExplainInput,
  RelationExplainOutcome,
  RelationExplanationResult,
  RelationReviewInput,
  RelationReviewResult,
  ObjectLocateResult
} from "@app/domain";
import type { WikiResultsSchema } from "@app/domain";
import type {
  TopicChangeSet,
  TopicChangeSetInput,
  TopicMutation,
  TopicMutationResult,
  TopicNotes,
  TopicNotesInput,
  TopicPage,
  TopicPageInput,
  TopicPath,
  TopicPathInput,
  TopicReembedInput,
  TopicReembedResult,
  TopicReviewInput,
  TopicReviewResult,
  TopicShape,
  TopicShapeInput,
  TopicTree,
  TopicTreeInput,
  TopicUndoInput,
  TopicUndoResult,
  TopicsChangedEvent,
  TopicsStatus
} from "@app/domain";
import type { TopicOverviewCancelInput, TopicOverviewInput, TopicOverviewState } from "@app/domain";
import type {
  ChangesDiff,
  ChangesDiffInput,
  ChangesList,
  ChangesListInput,
  ChangesPendingCounts,
  ChangesReviewInput,
  ChangesReviewResult,
  ChangesUndoInput,
  ChangesUndoResult
} from "@app/domain";
import type {
  MonitoringQuery,
  MonitoringPage,
  MonitoringDetail,
  MonitoringPrune
} from "./monitoring.js";
import { z } from "zod";
import {
  AiCapabilitySchema,
  AiModelParameterCapabilitiesSchema,
  AiModelParametersSchema,
  AiReasoningLevelSchema,
  DocumentDivisionCandidateSchema,
  EnrichmentCandidateSchema,
  GraphEntityTypeSchema,
  MetadataEnrichmentQuerySchema,
  ProcessingPlanRequestSchema,
  SearchResultSchema,
  SourceDescriptorDraftSchema,
  SourceDescriptorSchema,
  SourceItemTypeSchema,
  SourceRelationSettingsSchema,
  AtomicNoteMatchingSettingsSchema,
  MatchingPresetsSchema,
  MatchingPresetIdSchema,
  recommendedMatchingConfiguration,
  recommendedMatchingPresetId,
  CanonicalMatchingSettingsSchema,
  SourceRelationsPageSchema,
  SourceRelationReviewInputSchema,
  type SourceItemType
} from "@app/domain";

export const ipcChannels = {
  /** The one push channel of the typed event bus (`app-events.ts`). */
  appEvents: "app:events",
  consultationAsk: "app:consultation:ask",
  consultationCancel: "app:consultation:cancel",
  /** F4 D14: the import plan chip's estimate (T76). */
  budgetEstimateImport: "app:budget:estimateImport",
  /** F4 D14: the budget's meters, and the Activity's "continue" past the pause share. */
  budgetSnapshot: "app:budget:snapshot",
  budgetContinue: "app:budget:continue",
  promptCommand: "app:prompts:command",
  wikiSearch: "app:wiki:search",
  objectsLocate: "app:objects:locate",
  objectsNeighborhood: "app:objects:neighborhood",
  notesPage: "app:notes:page",
  notesRelations: "app:notes:relations",
  relationsExplain: "app:relations:explain",
  relationsCancelExplain: "app:relations:cancel-explain",
  relationsReview: "app:relations:review",
  relationsExplainSource: "app:relations:explain-source",
  relationsCancelExplainSource: "app:relations:cancel-explain-source",
  relationsChanged: "app:relations:changed",
  relationExplanationDelta: "app:relations:explanation-delta",
  topicsTree: "app:topics:tree",
  topicsPath: "app:topics:path",
  topicsPage: "app:topics:page",
  topicsNotes: "app:topics:notes",
  topicsShape: "app:topics:shape",
  topicsChangeSet: "app:topics:change-set",
  topicsMutate: "app:topics:mutate",
  topicsUndo: "app:topics:undo",
  topicsReview: "app:topics:review",
  topicsStatus: "app:topics:status",
  topicsReembed: "app:topics:reembed",
  topicsOverview: "app:topics:overview",
  topicsOverviewCancel: "app:topics:overview-cancel",
  topicsChanged: "app:topics:changed",
  changesList: "app:changes:list",
  changesPendingCounts: "app:changes:pending-counts",
  changesUndo: "app:changes:undo",
  changesReview: "app:changes:review",
  changesDiff: "app:changes:diff",
  systemGetInfo: "app:system:get-info",
  windowNavigation: "app:window:navigation",
  menuCommand: "app:menu:command",
  menuSetLanguage: "app:menu:set-language",
  viewHistoryRecord: "app:view-history:record",
  viewHistoryList: "app:view-history:list",
  viewHistoryPin: "app:view-history:pin",
  viewHistoryClear: "app:view-history:clear",
  viewHistoryChanged: "app:view-history:changed",
  databaseGetStatus: "app:database:get-status",
  databaseStart: "app:database:start",
  googleBooksKeyStatus: "app:settings:google-books-key:status",
  googleBooksKeyUpdate: "app:settings:google-books-key:update",
  appSettingsGet: "app:settings:app:get",
  appSettingsUpdate: "app:settings:app:update",
  settingsGet: "app:settings:get",
  settingsUpdate: "app:settings:update",
  settingsSelectObsidianVault: "app:settings:select-obsidian-vault",
  obsidianDeepLink: "app:obsidian:open",
  obsidianDeepLinkPending: "app:obsidian:open:pending",
  obsidianEditorialConflicts: "app:obsidian:editorial:conflicts",
  obsidianEditorialComparison: "app:obsidian:editorial:comparison",
  obsidianEditorialResolve: "app:obsidian:editorial:resolve",
  obsidianLayoutStatus: "app:obsidian:layout:status",
  obsidianLayoutPreview: "app:obsidian:layout:preview",
  obsidianLayoutApply: "app:obsidian:layout:apply",
  obsidianLayoutRollback: "app:obsidian:layout:rollback",
  obsidianWikiStatus: "app:obsidian:wiki:status",
  obsidianWikiScope: "app:obsidian:wiki:scope",
  obsidianWikiDiff: "app:obsidian:wiki:diff",
  obsidianWikiRecover: "app:obsidian:wiki:recover",
  obsidianWikiRetiredMove: "app:obsidian:wiki:retired:move",
  obsidianSyncStart: "app:obsidian:sync:start",
  obsidianSyncStatus: "app:obsidian:sync:status",
  monitoringList: "app:monitoring:list",
  monitoringDetail: "app:monitoring:detail",
  monitoringPrune: "app:monitoring:prune",
  debugSimilarityRunsList: "app:debug:similarity-runs:list",
  debugSimilarityRunsClear: "app:debug:similarity-runs:clear",
  libraryReset: "app:library:reset",
  ingestionCreateManual: "app:ingestion:create-manual",
  ingestionPreviewUrl: "app:ingestion:preview-url",
  ingestionEditSource: "app:ingestion:edit-source",
  ingestionExtractFileMetadata: "app:ingestion:extract-file-metadata",
  ingestionPreviewFileStructure: "app:ingestion:preview-file-structure",
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
  relationLabelsStart: "app:knowledge:relation-labels:start",
  relationLabelsStatus: "app:knowledge:relation-labels:status",
  jobsList: "app:jobs:list",
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
  knowledgeGraphDashboardGet: "app:knowledge:graph-dashboard:get",
  sourceRelationsList: "app:knowledge:source-relations:list",
  sourceRelationsReview: "app:knowledge:source-relations:review",
  knowledgeGraphSourceConnectionDetailsGet:
    "app:knowledge:graph-dashboard:source-connection-details:get",
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
  aiClassRoutes: "app:ai:class-routes",
  aiApplyPreset: "app:ai:class-routes:apply-preset",
  aiTestClassRoute: "app:ai:class-routes:test",
  aiSetClassRoute: "app:ai:class-routes:set",
  aiSetDeciderMode: "app:ai:class-routes:decider-mode",
  aiDecisionsStatus: "app:ai:decisions:status",
  aiDecisionsSetEnabled: "app:ai:decisions:set-enabled",
  aiDecisionsSaveKey: "app:ai:decisions:save-key",
  aiDecisionsRemoveKey: "app:ai:decisions:remove-key",
  aiDecisionsTestKey: "app:ai:decisions:test-key",
  aiLocalEmbeddingLoadStatus: "app:ai:local-embedding-load-status",
  localModelsList: "app:local-models:list",
  localModelsStatuses: "app:local-models:statuses",
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
/** "system" follows the OS appearance live; "light" and "dark" are explicit choices that always win. */
export const themeModeSchema = z.enum(["system", "light", "dark"]);
export const appLanguageCodes = ["en", "pt-BR", "it", "fr", "es"] as const;
export const languageCodeSchema = z.enum(appLanguageCodes);
export const windowNavigationDirectionSchema = z.enum(["back", "forward"]);

export const savedProcessingPresetSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).max(100),
    requestedStages: ProcessingPlanRequestSchema.shape.requestedStages
  })
  .strict();

export const googleBooksKeyInputSchema = z
  .object({
    apiKey: z
      .string()
      .trim()
      .min(1)
      .max(512)
      .regex(/^[A-Za-z0-9_-]+$/)
      .nullable()
  })
  .strict();
export const googleBooksKeyStatusSchema = z.object({ configured: z.boolean() }).strict();

/** The `relationsChanged` push (F3 3.11 step 4): the notes whose relations a commit changed. */
export const RelationsChangedEventSchema = z
  .object({ noteIds: z.array(z.string().uuid()).min(1).max(200) })
  .strict();
export type RelationsChangedEvent = z.infer<typeof RelationsChangedEventSchema>;

/**
 * The `relationExplanationDelta` push (F3 D22): an explanation as it is written, to the window that
 * asked for it. `text` is the whole text so far, with canonical note references, coalesced to one
 * message per 50 ms; empty text says what was shown is void (the answer is written again).
 */
export const RelationExplanationDeltaEventSchema = z
  .object({
    requestId: z.string().uuid(),
    relationId: z.string().uuid(),
    text: z.string().max(relationExplanationLimits.storedCharacters * 2)
  })
  .strict();
export type RelationExplanationDeltaEvent = z.infer<typeof RelationExplanationDeltaEventSchema>;

export const relationLabelsInputSchema = z
  .object({ mode: z.enum(["missing", "all"]), contentLanguage: languageCodeSchema })
  .strict();
export const relationLabelJobPayloadSchema = z.object({
  mode: z.enum(["missing", "all"]),
  contentLanguage: languageCodeSchema,
  before: z.string().datetime()
});

export const appSettingsSchema = z.object({
  matchingPresets: MatchingPresetsSchema.default([]),
  activeMatchingPresetId: MatchingPresetIdSchema.optional(),
  processingPresets: savedProcessingPresetSchema.array().max(50).optional(),
  language: languageCodeSchema,
  contentLanguage: languageCodeSchema.default("en"),
  themeMode: themeModeSchema,
  graphWheelZoomSensitivity: z.number().min(0.5).max(1.5).default(1),
  navigationCollapsed: z.boolean().default(false),
  wikiTreeWidth: z.number().int().min(240).max(520).default(320),
  debugMode: z.boolean().default(false),
  debugFullCapture: z.boolean().default(false),
  metadataEnrichmentEnabled: z.boolean().default(true),
  keepLocalEmbeddingModelsLoaded: z.boolean().default(true),
  bookMetadataProvider: z.enum(["auto", "open-library", "google-books"]).default("auto"),
  summaryMinimumWordCount: z.number().int().min(0).max(1_000).default(40),
  entityIdentitySimilarityThreshold: z.number().min(0).max(1).default(0.92),
  relationTypeSimilarityThreshold: z.number().min(0).max(1).default(0.92),
  knowledgeGraphMaxEntitiesPerSource: z.number().int().min(1).max(10_000).default(250),
  knowledgeGraphMaxRelationsPerSource: z.number().int().min(1).max(20_000).default(500),
  atomicNoteMatchingSettings: AtomicNoteMatchingSettingsSchema.prefault(
    recommendedMatchingConfiguration.atomicNoteMatchingSettings
  ),
  canonicalMatchingSettings: CanonicalMatchingSettingsSchema.prefault(
    recommendedMatchingConfiguration.canonicalMatchingSettings
  ),
  sourceRelationSettings: SourceRelationSettingsSchema.default(() =>
    structuredClone(recommendedMatchingConfiguration.sourceRelationSettings)
  ),
  updatedAt: z.string().datetime()
});

export const appSettingsUpdateSchema = z
  .object({
    matchingPresets: MatchingPresetsSchema.optional(),
    activeMatchingPresetId: MatchingPresetIdSchema.optional(),
    processingPresets: savedProcessingPresetSchema.array().max(50).optional(),
    language: languageCodeSchema.optional(),
    contentLanguage: languageCodeSchema.optional(),
    themeMode: themeModeSchema.optional(),
    graphWheelZoomSensitivity: z.number().min(0.5).max(1.5).optional(),
    navigationCollapsed: z.boolean().optional(),
    wikiTreeWidth: z.number().int().min(240).max(520).optional(),
    debugMode: z.boolean().optional(),
    debugFullCapture: z.boolean().optional(),
    metadataEnrichmentEnabled: z.boolean().optional(),
    keepLocalEmbeddingModelsLoaded: z.boolean().optional(),
    bookMetadataProvider: z.enum(["auto", "open-library", "google-books"]).optional(),
    summaryMinimumWordCount: z.number().int().min(0).max(1_000).optional(),
    entityIdentitySimilarityThreshold: z.number().min(0).max(1).optional(),
    relationTypeSimilarityThreshold: z.number().min(0).max(1).optional(),
    knowledgeGraphMaxEntitiesPerSource: z.number().int().min(1).max(10_000).optional(),
    knowledgeGraphMaxRelationsPerSource: z.number().int().min(1).max(20_000).optional(),
    atomicNoteMatchingSettings: AtomicNoteMatchingSettingsSchema.optional(),
    canonicalMatchingSettings: CanonicalMatchingSettingsSchema.optional(),
    sourceRelationSettings: SourceRelationSettingsSchema.optional()
  })
  .strict();

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

/** Which sources the vault projection holds; every topic the projection reaches gets its map. */
export const obsidianWikiScopeSchema = z
  .object({
    sourceIds: z.array(z.string().uuid()).max(100).default([]),
    includeDescendants: z.boolean().default(true)
  })
  .strict();
/** The stored scope: a scope saved before topic maps replaced wiki pages may still name pages. */
export const storedObsidianWikiScopeSchema = z.preprocess((value) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const scope = { ...(value as Record<string, unknown>) };
  delete scope.pageIds;
  return scope;
}, obsidianWikiScopeSchema);
/** Old wiki files taken out of the projection: archived to recovery, absent, or kept because edited. */
export const obsidianWikiRetiredSchema = z
  .object({
    archived: z.number().int().nonnegative(),
    absent: z.number().int().nonnegative(),
    keptTotal: z.number().int().nonnegative(),
    kept: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            relativePath: z.string(),
            reason: z.enum(["edited", "unverified", "unsafe", "limit"])
          })
          .strict()
      )
      .max(200)
  })
  .strict();
export const obsidianWikiRetiredMoveSchema = z.object({ id: z.string().uuid() }).strict();
export const obsidianWikiStatusSchema = z
  .object({
    active: z.boolean(),
    job: z
      .object({
        status: z.enum(["queued", "running", "succeeded", "failed", "canceled", "retrying"]),
        error: z.string().nullable()
      })
      .nullable(),
    /** The current or last delivery pass: files delivered so far, of how many, and failed ones. */
    delivery: z
      .object({
        state: z.enum(["running", "done", "stopped"]),
        total: z.number().int().nonnegative(),
        delivered: z.number().int().nonnegative(),
        failed: z.number().int().nonnegative()
      })
      .strict()
      .nullable(),
    scope: obsidianWikiScopeSchema,
    conflicts: z.array(
      z.object({
        id: z.string().uuid(),
        memora_id: z.string().uuid(),
        relative_path: z.string(),
        status: z.string(),
        error: z.string().nullable()
      })
    ),
    retired: obsidianWikiRetiredSchema
  })
  .strict();
export const obsidianWikiDiffSchema = z
  .object({
    id: z.string().uuid(),
    relativePath: z.string(),
    base: z.string(),
    local: z.string(),
    proposed: z.string(),
    localHash: z.string().nullable()
  })
  .strict();
export const obsidianWikiRecoverSchema = z
  .object({ id: z.string().uuid(), expectedHash: z.string().nullable() })
  .strict();
export const obsidianSyncStatusSchema = z
  .object({
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
  })
  .strict();

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

export const manualIngestionInputSchema = z
  .object({
    descriptor: SourceDescriptorSchema,
    content: z.string().default(""),
    duplicatePolicy: duplicatePolicySchema.default("ignore"),
    processingPlan: ProcessingPlanRequestSchema.default({
      preset: "full_knowledge",
      requestedStages: [],
      scope: "source_only",
      targetSourceItemIds: [],
      forceRegeneration: false,
      previousArtifactPolicy: "reuse_valid"
    })
  })
  .strict()
  .superRefine((input, context) => {
    const containerType = ["Book", "PeriodicalIssue", "AcademicPaper"].includes(
      input.descriptor.type
    );
    if (!containerType && input.content.trim().length === 0) {
      context.addIssue({
        code: "custom",
        message: "Content is required for this source type.",
        path: ["content"]
      });
    }
  });

export const fileImportInputSchema = z
  .object({
    fileToken: z.string().uuid().optional(),
    descriptor: SourceDescriptorSchema,
    duplicatePolicy: duplicatePolicySchema.default("ignore"),
    processingPlan: ProcessingPlanRequestSchema.default({
      preset: "full_knowledge",
      requestedStages: [],
      scope: "source_only",
      targetSourceItemIds: [],
      forceRegeneration: false,
      previousArtifactPolicy: "reuse_valid"
    })
  })
  .strict();

export const containerSourceInputSchema = z
  .object({
    descriptor: SourceDescriptorSchema.refine(
      (descriptor) => ["Book", "PeriodicalIssue", "AcademicPaper"].includes(descriptor.type),
      "Only hierarchical root types can be containers."
    ),
    duplicatePolicy: duplicatePolicySchema.default("ignore")
  })
  .strict();

export const duplicateCheckInputSchema = z
  .object({
    descriptor: SourceDescriptorSchema,
    content: z.string().optional(),
    fileToken: z.string().uuid().optional()
  })
  .strict();

export const duplicateCandidateSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().min(1),
    type: SourceItemTypeSchema
  })
  .strict();

export const fileMetadataExtractionInputSchema = z
  .object({
    sourceType: SourceItemTypeSchema.default("GenericDocument"),
    requestId: z.string().uuid().optional()
  })
  .strict();

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

export const fileImportProgressSchema = z
  .object({
    requestId: z.string().uuid(),
    stage: fileImportProgressStageSchema,
    progress: z.number().min(0).max(1),
    completedPages: z.number().int().nonnegative().optional(),
    totalPages: z.number().int().positive().optional()
  })
  .strict()
  .superRefine((event, context) => {
    if (
      event.completedPages !== undefined &&
      event.totalPages !== undefined &&
      event.completedPages > event.totalPages
    ) {
      context.addIssue({
        code: "custom",
        message: "Completed pages cannot exceed total pages.",
        path: ["completedPages"]
      });
    }
  });

export const fileMetadataExtractionResultSchema = z
  .object({
    fileToken: z.string().uuid(),
    fileName: z.string().min(1),
    mimeType: z.string().min(1),
    draft: SourceDescriptorDraftSchema,
    preview: z
      .object({ text: z.string().max(20_000), truncated: z.boolean() })
      .strict()
      .optional()
  })
  .strict();

export const metadataEnrichmentInputSchema = MetadataEnrichmentQuerySchema;
export const fileStructurePreviewInputSchema = z
  .object({
    fileToken: z.string().uuid(),
    sourceType: z.enum(["Book", "AcademicPaper", "PeriodicalIssue"])
  })
  .strict();
export const metadataEnrichmentResultSchema = EnrichmentCandidateSchema.array();
export const enrichmentCoverInputSchema = z.object({ coverUrl: z.string().url() }).strict();
export const enrichmentCoverResultSchema = z
  .object({
    assetId: z.string().uuid(),
    mimeType: z.string().min(1)
  })
  .strict();

export const ingestionResultSchema = z
  .object({
    sourceItemId: z.string().uuid(),
    documentId: z.string().uuid().nullable(),
    ingestionRunId: z.string().uuid().nullable(),
    jobId: z.string().uuid().nullable(),
    batchId: z.string().uuid().nullable(),
    structureId: z.string().uuid().nullable(),
    requiresStructureReview: z.boolean(),
    duplicate: z.boolean()
  })
  .strict();

export const documentDivisionViewSchema = DocumentDivisionCandidateSchema.safeExtend({
  childSourceItemId: z.string().uuid().nullable(),
  childDocumentId: z.string().uuid().nullable()
});

export const documentStructureViewSchema = z
  .object({
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
    boundaries: z.array(
      z
        .object({
          offset: z.number().int().nonnegative(),
          label: z.string().min(1),
          kind: z.enum(["heading", "division", "page"]),
          page: z.number().int().positive().optional()
        })
        .strict()
    ),
    divisions: z.array(documentDivisionViewSchema),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .strict();

export const fileStructurePreviewSchema = documentStructureViewSchema
  .pick({ rootMarkdown: true, boundaries: true })
  .extend({ divisions: z.array(DocumentDivisionCandidateSchema) })
  .strict();
export type FileStructurePreview = z.infer<typeof fileStructurePreviewSchema>;
export type FileStructurePreviewInput = z.infer<typeof fileStructurePreviewInputSchema>;

export const structureConfirmInputSchema = z
  .object({
    structureId: z.string().uuid(),
    divisions: z.array(DocumentDivisionCandidateSchema),
    plan: ProcessingPlanRequestSchema
  })
  .strict();

export const structureSaveInputSchema = z
  .object({
    structureId: z.string().uuid(),
    divisions: z.array(DocumentDivisionCandidateSchema)
  })
  .strict();

export const processingRequestSchema = z
  .object({
    plan: ProcessingPlanRequestSchema,
    runKind: z.enum(["initial", "missing_stages", "reingestion"]),
    trigger: z.enum(["library_action", "interactive_import", "integration", "recovery"]).optional()
  })
  .strict();

export const processingQueueResultSchema = z
  .object({
    batchId: z.string().uuid(),
    queued: z.array(
      z
        .object({
          sourceItemId: z.string().uuid(),
          documentId: z.string().uuid(),
          ingestionRunId: z.string().uuid(),
          jobId: z.string().uuid().nullable()
        })
        .strict()
    )
  })
  .strict();

export const processingBatchSchema = z
  .object({
    id: z.string().uuid(),
    trigger: z.string(),
    requestedPlan: z.record(z.string(), z.unknown()),
    effectivePlan: z.record(z.string(), z.unknown()),
    reingestionPolicy: z.string(),
    status: z.string(),
    progress: z.number().min(0).max(1),
    totalItems: z.number().int().nonnegative(),
    completedItems: z.number().int().nonnegative(),
    failedItems: z.number().int().nonnegative(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .strict();

export const sourceSuggestionSchema = z
  .object({
    id: z.string().uuid(),
    title: z.string().min(1),
    type: SourceItemTypeSchema
  })
  .strict();

export const sourceLookupInputSchema = z
  .object({
    query: z.string().trim().min(1).max(200),
    sourceTypes: z.array(SourceItemTypeSchema).max(11).default([])
  })
  .strict();

export const jobRecordSchema = z
  .object({
    labelResult: z
      .object({ updated: z.number().int().nonnegative(), contentLanguage: languageCodeSchema })
      .nullable()
      .optional(),
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
    errorHistory: z
      .array(
        z
          .object({
            message: z.string().min(1),
            stage: z.string().min(1),
            attempt: z.number().int().nonnegative(),
            occurredAt: z.string().datetime()
          })
          .strict()
      )
      .default([]),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    aiExecution: z
      .object({
        provider: z.string().min(1),
        modelId: z.string().min(1),
        reasoningLevel: AiReasoningLevelSchema.nullable()
      })
      .strict()
      .nullable(),
    source: z
      .object({
        id: z.string().uuid(),
        title: z.string().min(1),
        type: SourceItemTypeSchema,
        origin: z.string().min(1)
      })
      .strict()
      .nullable()
      .optional(),
    ingestionRun: z
      .object({
        id: z.string().uuid(),
        batchId: z.string().uuid().nullable().default(null),
        status: z.enum(["pending", "running", "succeeded", "failed", "canceled"]),
        currentStage: z.string().min(1),
        effectiveStages: z.array(z.string()).default([]),
        stagesCheckpoint: z.record(z.string(), z.unknown())
      })
      .strict()
      .nullable()
      .optional()
  })
  .strict();

export const jobsClearResultSchema = z
  .object({
    deletedCount: z.number().int().nonnegative()
  })
  .strict();

export const jobsDeleteResultSchema = z
  .object({
    deletedJobs: z.number().int().nonnegative(),
    deletedRuns: z.number().int().nonnegative()
  })
  .strict();

export const libraryResetResultSchema = z
  .object({
    deletedSources: z.number().int().nonnegative(),
    deletedAtomicNotes: z.number().int().nonnegative(),
    deletedFiles: z.number().int().nonnegative(),
    failedFiles: z.number().int().nonnegative()
  })
  .strict();

export const sourceDeletionResultSchema = z
  .object({
    deletedSources: z.number().int().nonnegative(),
    deletedAtomicNotes: z.number().int().nonnegative(),
    deletedFiles: z.number().int().nonnegative(),
    failedFiles: z.number().int().nonnegative(),
    graphCleanupFailed: z.boolean()
  })
  .strict();

export const librarySourceSchema = z
  .object({
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
    graphScore: z.number().min(0).max(1).nullable().default(null),
    rankingScore: z.number().nonnegative().nullable().default(null),
    matchKind: z.enum(["traditional", "embedding", "graph", "combined"]).nullable().default(null),
    matchExcerpt: z.string().nullable().default(null),
    matchLocation: z.string().nullable().default(null),
    embeddingNeedsRefresh: z.boolean().default(false),
    updatedAt: z.string().datetime()
  })
  .strict();

export const libraryBrowseInputSchema = z
  .object({
    sourceTypes: SourceItemTypeSchema.array().default([]),
    query: z.string().max(500).default(""),
    searchMode: z.enum(["traditional", "hybrid"]).default("hybrid"),
    parentId: z.string().uuid().nullable().optional(),
    ids: z.string().uuid().array().max(100).optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(48)
  })
  .strict();
export const sourceUrlPreviewInputSchema = z
  .object({ type: z.enum(["WebArticle", "Video"]), url: z.string().url().max(4000) })
  .strict();
export const sourceUrlPreviewSchema = z
  .object({ draft: SourceDescriptorDraftSchema, markdown: z.string().max(20_000_000) })
  .strict();
export const sourceEditInputSchema = z
  .object({
    sourceItemId: z.string().uuid(),
    expectedUpdatedAt: z.string().datetime(),
    descriptor: SourceDescriptorSchema,
    content: z
      .object({
        documentId: z.string().uuid().nullable(),
        markdown: z.string().min(1).max(20_000_000)
      })
      .strict()
      .optional()
  })
  .strict();
export const sourceEditResultSchema = z
  .object({
    sourceItemId: z.string().uuid(),
    documentId: z.string().uuid().nullable(),
    contentChanged: z.boolean()
  })
  .strict();
export type LibraryBrowseInput = z.input<typeof libraryBrowseInputSchema>;
export type SourceEditInput = z.infer<typeof sourceEditInputSchema>;

export const atomicNoteViewSchema = z
  .object({
    ownership: z.enum(["source", "knowledge"]).default("source"),
    supersessionStatus: z.string().default("current"),
    id: z.string().uuid(),
    title: z.string().min(1),
    bodyMarkdown: z.string().min(1),
    ideaStatement: z.string().min(1),
    language: z.string().min(1),
    status: z.enum(["active", "pending_review", "approved", "rejected", "archived"]),
    sourceItemId: z.string().uuid(),
    sourceSpanId: z.string().uuid().nullable(),
    evidenceChunkId: z.string().uuid(),
    generationModel: z.string().min(1),
    generationPromptVersion: z.string().min(1),
    /** A person edited the note: it is theirs and automation leaves it alone. */
    humanProtected: z.boolean(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime()
  })
  .strict();

export const knowledgeGraphDashboardModeSchema = z.enum(["sources", "atomic_notes"]);
export const knowledgeGraphDashboardInputSchema = z
  .object({
    mode: knowledgeGraphDashboardModeSchema,
    sourceView: z.enum(["relations", "entities"]).default("relations")
  })
  .strict();
export const knowledgeGraphDashboardNodeSchema = z
  .object({
    id: z.string().uuid(),
    kind: z.enum(["source", "atomic_note"]),
    title: z.string().min(1),
    subtitle: z.string().nullable(),
    content: z.string().max(4_000).nullable(),
    sourceItemId: z.string().uuid(),
    sourceType: SourceItemTypeSchema.nullable(),
    noteStatus: z.enum(["active", "pending_review", "approved", "rejected", "archived"]).nullable(),
    detailCount: z.number().int().nonnegative(),
    parentSourceItemId: z.string().uuid().nullable(),
    childCount: z.number().int().nonnegative()
  })
  .strict();
export const knowledgeGraphDashboardEdgeSchema = z
  .object({
    id: z.string().min(1),
    source: z.string().uuid(),
    target: z.string().uuid(),
    kind: z.enum(["shared_entity", "semantic_relation", "atomic_note_relation", "source_relation"]),
    label: z.string().min(1),
    description: z.string().nullable(),
    weight: z.number().positive(),
    // Null when there is no percentage to show: a source relation promoted from note links, or a
    // relations v2 note relation (F3 D42, R4).
    confidence: z.number().min(0).max(1).nullable(),
    details: z.array(z.string()),
    /** A source relation nobody kept (decision 29); only source relation edges say so. */
    suggested: z.boolean().optional()
  })
  .strict();
export const knowledgeGraphDashboardSchema = z
  .object({
    mode: knowledgeGraphDashboardModeSchema,
    sourceView: z.enum(["relations", "entities"]).optional(),
    nodes: z.array(knowledgeGraphDashboardNodeSchema).max(20_000),
    edges: z.array(knowledgeGraphDashboardEdgeSchema).max(50_000),
    truncated: z.boolean()
  })
  .strict();
export const knowledgeGraphSourceConnectionDetailsInputSchema = z
  .object({
    sourceItemId: z.string().uuid(),
    targetSourceItemId: z.string().uuid()
  })
  .strict();
export const knowledgeGraphSourceConnectionDetailsSchema = z
  .object({
    sharedEntities: z.array(z.string().min(1)).max(20_000),
    semanticRelations: z.array(z.string().min(1)).max(20_000),
    entities: z
      .array(
        z.object({ id: z.string().uuid(), label: z.string().min(1), shared: z.boolean() }).strict()
      )
      .max(60_000),
    relations: z
      .array(
        z
          .object({
            id: z.string().uuid(),
            source: z.string().uuid(),
            target: z.string().uuid(),
            label: z.string().min(1)
          })
          .strict()
      )
      .max(20_000)
  })
  .strict();

export const pendingAtomicNoteSchema = atomicNoteViewSchema
  .extend({
    sourceTitle: z.string().nullable()
  })
  .strict();

export const sourceRelationsInputSchema = z
  .object({
    relationId: z.string().uuid().optional(),
    sourceItemId: z.string().uuid(),
    targetSourceItemId: z.string().uuid().nullable().default(null),
    offset: z.number().int().min(0).max(1_000_000).default(0),
    limit: z.number().int().min(1).max(100).default(30)
  })
  .strict();
export const sourceRelationsPageSchema = SourceRelationsPageSchema;
export const sourceRelationReviewSchema = SourceRelationReviewInputSchema;

export const sourceDocumentInputSchema = z
  .object({ sourceItemId: z.string().uuid(), documentId: z.string().uuid() })
  .strict();
export const sourceDocumentSchema = z.object({ title: z.string(), markdown: z.string() }).strict();
export const sourceDetailSchema = z
  .object({
    history: z
      .array(
        z.object({
          id: z.string().uuid(),
          title: z.string(),
          createdAt: z.string().datetime(),
          isCurrent: z.boolean()
        })
      )
      .default([]),
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
    assets: z.array(
      z
        .object({
          id: z.string().uuid(),
          originalFileName: z.string().min(1),
          mimeType: z.string().min(1),
          role: z.string().min(1)
        })
        .strict()
    ),
    documents: z.array(
      z
        .object({
          id: z.string().uuid(),
          title: z.string().min(1),
          canonicalMarkdown: z.string(),
          language: z.string().min(1),
          chunks: z.array(
            z
              .object({
                id: z.string().uuid(),
                content: z.string(),
                chunkIndex: z.number().int().nonnegative(),
                sourceSpanId: z.string().uuid().nullable(),
                // The SourceSpan of the chunk: where it sits in the document Markdown (offsets
                // into `canonicalMarkdown`) and its page, so a citation can highlight it.
                startOffset: z.number().int().nonnegative().nullable().default(null),
                endOffset: z.number().int().nonnegative().nullable().default(null),
                page: z.number().int().positive().nullable().default(null)
              })
              .strict()
          ),
          assets: z.array(
            z
              .object({
                id: z.string().uuid(),
                originalFileName: z.string().min(1),
                mimeType: z.string().min(1),
                role: z.string().min(1)
              })
              .strict()
          )
        })
        .strict()
    ),
    summaries: z.array(
      z
        .object({
          id: z.string().uuid(),
          summary: z.string().min(1),
          provider: z.string().min(1),
          model: z.string().min(1),
          promptVersion: z.string().min(1),
          generatedAt: z.string().datetime()
        })
        .strict()
    ),
    atomicNotes: z.array(atomicNoteViewSchema),
    graph: z
      .object({
        entities: z.array(
          z
            .object({
              id: z.string().uuid(),
              type: GraphEntityTypeSchema,
              name: z.string().min(1),
              confidence: z.number().min(0).max(1)
            })
            .strict()
        ),
        relations: z.array(
          z
            .object({
              id: z.string().uuid(),
              subjectEntityId: z.string().uuid().optional(),
              objectEntityId: z.string().uuid().optional(),
              subject: z.string().min(1),
              predicate: z.string().min(1),
              displayLabel: z.string().max(300).optional(),
              object: z.string().min(1),
              confidence: z.number().min(0).max(1)
            })
            .strict()
        ),
        sourceConnections: z.array(
          z
            .object({
              sourceItemId: z.string().uuid(),
              sourceTitle: z.string().min(1),
              entityId: z.string().uuid().optional(),
              relatedEntityId: z.string().uuid().optional(),
              entityName: z.string().min(1),
              relatedEntityName: z.string().min(1),
              predicate: z.string().min(1),
              displayLabel: z.string().max(300).optional(),
              confidence: z.number().min(0).max(1)
            })
            .strict()
        )
      })
      .strict()
      .default({ entities: [], relations: [], sourceConnections: [] }),
    relations: z.array(
      z
        .object({
          id: z.string().uuid(),
          sourceAtomicNoteId: z.string().uuid(),
          targetAtomicNoteId: z.string().uuid(),
          sourceTitle: z.string().min(1),
          targetTitle: z.string().min(1),
          sourceStatus: z.string().min(1),
          targetStatus: z.string().min(1),
          // The pair is sorted by ID; how it reads (F3 D8). `unknown`: linked, with no direction
          // (decision 31b).
          direction: z.enum(["lo_to_hi", "hi_to_lo", "symmetric", "unknown"]),
          relationType: z.string().min(1),
          // Automation's band and the calibration it was decided under (F3 D9, D42): null on a
          // legacy row, which keeps showing its stored score. A v2 row shows a band word instead.
          band: NoteRelationBandSchema.nullable(),
          calibration: NoteRelationCalibrationSchema.nullable(),
          state: NotePageRelationStateSchema,
          finalScore: z.number().min(0).max(1),
          explanation: z.string().min(1)
        })
        .strict()
    )
  })
  .strict();

export const atomicNoteReviewInputSchema = z
  .object({
    expectedUpdatedAt: z.string().datetime().optional(),
    id: z.string().uuid(),
    action: z.enum(["approve", "edit", "discard"]),
    title: z.string().trim().min(1).optional(),
    bodyMarkdown: z
      .string()
      .min(1)
      .refine((value) => Boolean(value.trim()))
      .optional(),
    ideaStatement: z.string().trim().min(1).optional()
  })
  .strict()
  .superRefine((input, context) => {
    if (input.action === "edit" && !input.expectedUpdatedAt)
      context.addIssue({
        code: "custom",
        message: "Edit requires its expected revision.",
        path: ["expectedUpdatedAt"]
      });
    if (
      input.action === "edit" &&
      input.title === undefined &&
      input.bodyMarkdown === undefined &&
      input.ideaStatement === undefined
    ) {
      context.addIssue({ code: "custom", message: "Edit requires content.", path: ["action"] });
    }
  });

export const searchInputSchema = z
  .object({
    text: z.string().trim().min(1),
    sourceTypes: z.array(SourceItemTypeSchema).default([]),
    rootSourceItemId: z.string().uuid().optional(),
    mode: z.enum(["text", "hybrid"]).default("hybrid"),
    limit: z.number().int().min(1).max(100).default(20)
  })
  .strict();

export const searchResultsSchema = z.array(SearchResultSchema);

export const localEmbeddingLoadStatusSchema = z
  .object({
    state: z.enum(["loading", "ready", "failed"]),
    modelId: z.string().min(1)
  })
  .strict();

export const similarityDebugResultSchema = z
  .object({
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
  })
  .strict();

export const similarityDebugRunSchema = z
  .object({
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
  })
  .strict();

export const similarityDebugClearResultSchema = z
  .object({
    deletedCount: z.number().int().nonnegative()
  })
  .strict();

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
export const aiProviderConfigInputSchema = z
  .object({
    id: z.string().uuid().optional(),
    provider: aiProviderKindSchema,
    displayName: z.string().trim().min(1),
    baseUrl: z.string().url().nullable().optional(),
    apiKey: z.string().min(1).optional(),
    modelId: z.string().trim().min(1),
    capabilities: z.array(AiCapabilitySchema).default([]),
    defaultParameters: aiModelParametersSchema.default({})
  })
  .strict();

export const aiModelDiscoveryInputSchema = z
  .object({
    provider: aiProviderKindSchema,
    baseUrl: z.string().url().nullable().optional(),
    apiKey: z.string().min(1).optional()
  })
  .strict()
  .superRefine((input, context) => {
    if (input.provider !== "openai-codex" && !input.apiKey) {
      context.addIssue({ code: "custom", message: "API key is required.", path: ["apiKey"] });
    }
  });

export const aiParameterCapabilitiesInputSchema = z
  .object({
    provider: aiProviderKindSchema,
    modelId: z.string().trim().min(1),
    baseUrl: z.string().url().nullable().optional(),
    capabilities: z.array(AiCapabilitySchema).default([])
  })
  .strict();

export const aiModelListSchema = z.array(z.string().min(1));

export const aiProviderConfigSchema = aiProviderConfigInputSchema
  .omit({ apiKey: true })
  .extend({
    id: z.string().uuid(),
    parameterCapabilities: aiModelParameterCapabilitiesSchema,
    secretConfigured: z.boolean(),
    status: z.string().min(1)
  })
  .strict();

export const aiProfileSchema = z
  .object({
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
  })
  .strict();

export const aiProfileCreateSchema = z
  .object({
    name: z.string().trim().min(1),
    description: z.string().nullable().optional(),
    isDefault: z.boolean().default(false),
    privacyMode: z.enum(["allow_remote", "offline_only"]).default("allow_remote"),
    outputLanguage: aiOutputLanguageSchema.default("ui")
  })
  .strict();

export const aiProfileUpdateSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string().trim().min(1).optional(),
    privacyMode: z.enum(["allow_remote", "offline_only"]).optional(),
    outputLanguage: aiOutputLanguageSchema.optional(),
    providerConfigId: z.string().uuid().nullable().optional(),
    localModelId: z.string().uuid().nullable().optional(),
    modelId: z.string().trim().min(1).nullable().optional(),
    runtime: z.enum(["remote", "gguf", "mlx"]).nullable().optional(),
    capabilities: z.array(AiCapabilitySchema).optional()
  })
  .strict()
  .superRefine((input, context) => {
    const updatesModel =
      input.providerConfigId !== undefined ||
      input.localModelId !== undefined ||
      input.modelId !== undefined ||
      input.runtime !== undefined ||
      input.capabilities !== undefined;
    if (updatesModel) {
      const hasRemote = Boolean(input.providerConfigId);
      const hasLocal = Boolean(input.localModelId);
      if (hasRemote === hasLocal) {
        context.addIssue({
          code: "custom",
          message: "Select exactly one remote or local model.",
          path: ["modelId"]
        });
      }
      if (!input.modelId || !input.runtime || input.capabilities === undefined) {
        context.addIssue({
          code: "custom",
          message: "Model id, runtime and capabilities are required together.",
          path: ["modelId"]
        });
      }
    }
  });

export const aiProfileCloneSchema = z
  .object({
    profileId: z.string().uuid(),
    name: z.string().trim().min(1)
  })
  .strict();

export const aiProfileTaskInputSchema = z
  .object({
    profileId: z.string().uuid(),
    task: aiConfigurableTaskSchema,
    parameters: aiModelParametersSchema.default({})
  })
  .strict();

export const aiProfileTaskSchema = z
  .object({
    profileId: z.string().uuid(),
    task: aiConfigurableTaskSchema,
    parameters: aiModelParametersSchema
  })
  .strict();

export const aiTaskRouteSchema = z
  .object({
    task: aiConfigurableTaskSchema,
    profileId: z.string().uuid()
  })
  .strict();

/** What can be routed from Settings: the five workload classes, or the generative judge row. */
export const aiClassRouteTargetSchema = z.union([AiClassIdSchema, z.literal("judge")]);
export const aiClassTestSchema = z
  .object({
    /** `none`: the class intentionally has no model (Cloud without a ranker). */
    state: z.enum(["untested", "passed", "failed", "none"]),
    model: z.string().nullable(),
    ms: z.number().int().nonnegative().nullable(),
    at: z.string().nullable(),
    /** A localized error key, or a short redacted reason. */
    error: z.string().nullable()
  })
  .strict();
export const aiClassRouteSchema = z
  .object({
    id: AiClassIdSchema,
    profileId: z.string().uuid().nullable(),
    profileName: z.string().nullable(),
    modelId: z.string().nullable(),
    runtime: z.enum(["remote", "gguf", "mlx"]).nullable(),
    remote: z.boolean(),
    test: aiClassTestSchema
  })
  .strict();
export const aiJudgeRouteSchema = z
  .object({
    profileId: z.string().uuid().nullable(),
    profileName: z.string().nullable(),
    modelId: z.string().nullable(),
    runtime: z.enum(["remote", "gguf", "mlx"]).nullable(),
    remote: z.boolean(),
    /** The remote provider's display name, for the disclosure of what is sent. */
    providerName: z.string().nullable(),
    /** The four generative-decide routes all exist and name the same profile. */
    routed: z.boolean(),
    /** Null while the library has no preset or choice: the derived mode applies. */
    deciderMode: NoteDeciderModeSchema.nullable(),
    test: aiClassTestSchema
  })
  .strict();
export const aiClassRoutesSchema = z
  .object({
    preset: AiPresetModeSchema.nullable(),
    presets: z.array(
      z
        .object({
          id: AiPresetIdSchema,
          available: z.boolean(),
          reason: z.literal("local_requires_apple_silicon").nullable()
        })
        .strict()
    ),
    classes: z.array(aiClassRouteSchema),
    judge: aiJudgeRouteSchema
  })
  .strict();
export const aiApplyPresetInputSchema = z
  .object({
    preset: z.union([AiPresetIdSchema, z.literal("custom")]),
    /** Test one call per class after seeding (the default); the settings view tests them one by one. */
    test: z.boolean().default(true)
  })
  .strict();
export const aiApplyPresetResultSchema = z
  .object({
    applied: z.boolean(),
    /** Why nothing was written: a model the preset needs is not installed or configured. */
    blocked: z.array(
      z
        .object({
          /** The class or judge that lacks a model; null when the whole preset is unavailable. */
          route: aiClassRouteTargetSchema.nullable(),
          reason: z.enum(["model_missing", "no_remote_profile", "local_requires_apple_silicon"]),
          catalogId: z.string().nullable(),
          /** The model's display name, for the message that asks to install it. */
          modelName: z.string().nullable()
        })
        .strict()
    ),
    view: aiClassRoutesSchema
  })
  .strict();
export const aiTestClassRouteInputSchema = z.object({ route: aiClassRouteTargetSchema }).strict();
export const aiSetClassRouteInputSchema = z
  .object({ route: aiClassRouteTargetSchema, profileId: z.string().uuid() })
  .strict();
export const aiSetDeciderModeInputSchema = z
  .object({ mode: NoteDeciderModeSchema.nullable() })
  .strict();

/**
 * The opt-in OpenAI Decisions decider (F3 plan decision 30). The renderer sends the OpenAI Platform
 * key once, when the person saves it, and never receives it back: every answer is the status.
 */
export const aiDecisionsStatusSchema = DecisionsStatusSchema;
export const aiDecisionsSetEnabledInputSchema = z.object({ enabled: z.boolean() }).strict();
export const aiDecisionsSaveKeyInputSchema = z
  .object({ apiKey: z.string().trim().min(16).max(400) })
  .strict();
export type AiDecisionsStatus = z.infer<typeof aiDecisionsStatusSchema>;

export const localModelStatusSchema = z.enum([
  "not_downloaded",
  "downloading",
  "verifying",
  "ready",
  "failed",
  "removing"
]);

export const localModelRecommendedParametersSchema = z
  .object({
    reasoning: aiModelParametersSchema.optional(),
    nonReasoning: aiModelParametersSchema.optional()
  })
  .strict()
  .refine((presets) => presets.reasoning !== undefined || presets.nonReasoning !== undefined, {
    message: "At least one recommended parameter preset is required."
  });

export const localModelViewSchema = z
  .object({
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
    download: z
      .object({
        jobId: z.string().uuid(),
        currentFile: z.string().nullable(),
        downloadedBytes: z.number().int().nonnegative(),
        totalBytes: z.number().int().nonnegative(),
        bytesPerSecond: z.number().int().nonnegative(),
        etaSeconds: z.number().int().nonnegative().nullable()
      })
      .strict()
      .nullable()
  })
  .strict();

/** Read-only readiness of installed models: never synchronizes the catalog. */
export const localModelStatusEntrySchema = z
  .object({ id: z.string().uuid(), status: localModelStatusSchema })
  .strict();

export const localModelDefaultsInputSchema = z
  .object({
    localModelId: z.string().uuid(),
    defaultParameters: aiModelParametersSchema
  })
  .strict();

export const localModelDownloadInputSchema = z
  .object({
    catalogId: z.string().min(1),
    acceptLicense: z.boolean().default(false)
  })
  .strict();

export const repositoryTokenInputSchema = z.object({ token: z.string().min(1) }).strict();

export const backupResultSchema = z
  .object({
    path: z.string().min(1),
    createdAt: z.string().datetime(),
    included: z.array(z.enum(["database", "obsidian", "uploadedFiles"])),
    /** True when a test restore of the dump matched the snapshot counts (see `BackupVerifier`). */
    verified: z.boolean()
  })
  .strict();

export const integrationGatewayStatusSchema = z
  .object({
    state: z.enum(["stopped", "starting", "ready", "failed"]),
    host: z.literal("127.0.0.1"),
    port: z.number().int().positive().nullable(),
    baseUrl: z.string().url().nullable()
  })
  .strict();

export const integrationPairingInputSchema = z
  .object({
    clientType: z.enum(["chrome-extension", "obsidian-plugin"]),
    displayName: z.string().trim().min(1).max(120)
  })
  .strict();

export const integrationPairingResultSchema = z
  .object({
    clientId: z.string().uuid(),
    token: z.string().min(32)
  })
  .strict();

export const integrationClientSchema = z
  .object({
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
  })
  .strict();

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
export type KnowledgeGraphDashboardMode = z.infer<typeof knowledgeGraphDashboardModeSchema>;
export type KnowledgeGraphDashboard = z.infer<typeof knowledgeGraphDashboardSchema>;
export type KnowledgeGraphSourceConnectionDetails = z.infer<
  typeof knowledgeGraphSourceConnectionDetailsSchema
>;
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
export type AiClassRouteTarget = z.infer<typeof aiClassRouteTargetSchema>;
export type AiClassTest = z.infer<typeof aiClassTestSchema>;
export type AiClassRoute = z.infer<typeof aiClassRouteSchema>;
export type AiJudgeRoute = z.infer<typeof aiJudgeRouteSchema>;
export type AiClassRoutes = z.infer<typeof aiClassRoutesSchema>;
export type AiApplyPresetInput = z.input<typeof aiApplyPresetInputSchema>;
export type AiApplyPresetResult = z.infer<typeof aiApplyPresetResultSchema>;
export type AiSetClassRouteInput = z.infer<typeof aiSetClassRouteInputSchema>;
export type AiConfigurableTask = z.infer<typeof aiConfigurableTaskSchema>;
export type AiModelParameters = z.infer<typeof aiModelParametersSchema>;
export type AiModelParameterCapabilities = z.infer<typeof aiModelParameterCapabilitiesSchema>;
export type AiOutputLanguage = z.infer<typeof aiOutputLanguageSchema>;
export type LocalModelView = z.infer<typeof localModelViewSchema>;
export type LocalModelStatusEntry = z.infer<typeof localModelStatusEntrySchema>;
export type LocalModelDownloadInput = z.infer<typeof localModelDownloadInputSchema>;
export type BackupResult = z.infer<typeof backupResultSchema>;
export type IntegrationGatewayStatus = z.infer<typeof integrationGatewayStatusSchema>;
export type IntegrationPairingInput = z.infer<typeof integrationPairingInputSchema>;
export type IntegrationPairingResult = z.infer<typeof integrationPairingResultSchema>;
export type IntegrationClient = z.infer<typeof integrationClientSchema>;
export type ObsidianSyncStatus = z.infer<typeof obsidianSyncStatusSchema>;
export type WindowNavigationDirection = z.infer<typeof windowNavigationDirectionSchema>;

export const defaultAppSettings = {
  contentLanguage: "en",
  themeMode: "system",
  graphWheelZoomSensitivity: 1,
  navigationCollapsed: false,
  wikiTreeWidth: 320,
  debugMode: false,
  debugFullCapture: false,
  metadataEnrichmentEnabled: true,
  keepLocalEmbeddingModelsLoaded: true,
  bookMetadataProvider: "auto",
  summaryMinimumWordCount: 40,
  knowledgeGraphMaxEntitiesPerSource: 250,
  knowledgeGraphMaxRelationsPerSource: 500,
  ...recommendedMatchingConfiguration,
  matchingPresets: [],
  activeMatchingPresetId: recommendedMatchingPresetId
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
  /**
   * Subscribes to one type of the typed push events (`app-events.ts`); the handler only receives
   * payloads that matched the schema in the preload. Returns what stops listening.
   */
  onAppEvent: <T extends AppEventType>(type: T, handler: AppEventHandler<T>) => () => void;
  consultation: {
    ask: (input: ConsultationInput) => Promise<ConsultationResult>;
    /** Ends the Ask and stops the statement it has running. */
    cancel: (id: string) => Promise<null>;
  };
  budget: {
    /** What an import plan of this many chunks would cost on the writer's route (F4 D14). */
    estimateImport: (input: ImportEstimateInput) => Promise<ImportEstimate>;
    /** The budget's meters now: the month's spend against the cap, the day's subscription calls. */
    snapshot: () => Promise<BudgetSnapshot>;
    /** Continues remote background work past the pause share for the rest of the month (D14). */
    continue: () => Promise<BudgetSnapshot>;
  };
  prompts: { command: (input: PromptCommand) => Promise<unknown> };
  objects: {
    /** Where an object is (primary path, other placements, citations); null when it does not exist. */
    locate: (input: ObjectLocateInput) => Promise<ObjectLocateResult | null>;
    /**
     * The bounded local graph around a note (F3 D43, R30): the note, its strongest related notes
     * and, at depth 2, theirs, with every shown relation among them (suggestions marked); null
     * when the note does not exist. Without AI.
     */
    neighborhood: (input: ObjectNeighborhoodInput) => Promise<ObjectNeighborhood | null>;
  };
  /** Note pages: one read-only read of everything a page shows, and further pages of relations. */
  notes: {
    page: (input: z.input<typeof NotePageInputSchema>) => Promise<NotePage | null>;
    relations: (input: z.input<typeof NoteRelationsInputSchema>) => Promise<NotePageRelations>;
  };
  /** Relations between notes or sources: their explanation, written when the owner opens one. */
  relations: {
    /**
     * The current explanation, written now when there is none; the veto when the writer found the
     * notes unrelated (the relation is withdrawn); `unrelated` when it found them so but the
     * relation stays (a human verdict, an earlier version): no explanation is available. Both
     * verdicts are cached with the relation, so a later open asks nobody. Null when the relation is
     * gone. A request with a `requestId` also receives the text as it is written, on
     * `subscribeExplanationDelta`.
     */
    explain: (input: RelationExplainInput) => Promise<RelationExplainOutcome | null>;
    /**
     * Stops the explanation being written; resolves true when one was stopped. With the `requestId`
     * of the request, only that card stops waiting: the call goes on while another card waits for it.
     */
    cancelExplain: (input: RelationExplainInput) => Promise<boolean>;
    /**
     * The owner keeps or removes a suggested or withdrawn note relation (F3 D15). The verdict is
     * final in both directions: it answers the verdict that stands, with `changed` false when the
     * relation already had one. Null when the relation is gone.
     */
    review: (input: RelationReviewInput) => Promise<RelationReviewResult | null>;
    /**
     * The current explanation of a source relation, written now when there is none; null when
     * there is none to write (rejected, gone, without current evidence or with stored prose).
     */
    explainSource: (input: RelationExplainInput) => Promise<RelationExplanationResult | null>;
    /** Stops the source relation's explanation being written; true when one was stopped. */
    cancelExplainSource: (input: RelationExplainInput) => Promise<boolean>;
    /** Pushed after a link job commits (F3 3.11), coalesced: the notes whose relations changed. */
    subscribeChanged: (listener: (event: RelationsChangedEvent) => void) => () => void;
    /** Pushed while an explanation is written (F3 D22): the text so far, for a request's id. */
    subscribeExplanationDelta: (
      listener: (event: RelationExplanationDeltaEvent) => void
    ) => () => void;
  };
  /**
   * The topic tree (docs/plan.md F2): reads without AI, human operations through the engine, and a
   * push after each committed change. A read answers null when the object is gone.
   */
  topics: {
    /** The children of a topic (the root's when `parentId` is null), with its own leaves on request. */
    tree: (input?: TopicTreeInput) => Promise<TopicTree | null>;
    /** The root-to-topic path; a retired topic resolves to its successor. */
    path: (input: TopicPathInput) => Promise<TopicPath | null>;
    /** The Topic page: a deterministic map of content. */
    page: (input: TopicPageInput) => Promise<TopicPage | null>;
    /** Pages of a topic's leaves, directly on it or in its whole subtree. */
    notes: (input: TopicNotesInput) => Promise<TopicNotes | null>;
    /** The cells of the tree (or one branch) with the shape verdict. */
    shape: (input?: TopicShapeInput) => Promise<TopicShape | null>;
    /** A textual before and after of one change-set. */
    changeSet: (input: TopicChangeSetInput) => Promise<TopicChangeSet | null>;
    /** One human operation, applied as one change-set (errors: `topics.errors.*`). */
    mutate: (input: TopicMutation) => Promise<TopicMutationResult>;
    undo: (input: TopicUndoInput) => Promise<TopicUndoResult>;
    /** Applies or dismisses a proposal that waits for the owner. */
    review: (input: TopicReviewInput) => Promise<TopicReviewResult>;
    status: () => Promise<TopicsStatus>;
    /** Re-embeds the library after the embedding space changed. */
    reembed: (input: TopicReembedInput) => Promise<TopicReembedResult>;
    /** The topic's overview: the cached one, or one written now (`force`: Update). Only writing calls AI. */
    overview: (input: TopicOverviewInput) => Promise<TopicOverviewState>;
    /** Stops the overview being written for a topic; true when one was stopped. */
    cancelOverview: (input: TopicOverviewCancelInput) => Promise<boolean>;
    /** Pushed after a change-set commits, coalesced; never polled. */
    subscribeChanged: (listener: (event: TopicsChangedEvent) => void) => () => void;
  };
  /**
   * Change-sets of every store (F4 D10): the topic engine's, relation passes and overview writes,
   * read through one view; each store undoes and reviews its own exactly. Errors: `changes.errors.*`
   * (and `topics.errors.*` from the topic engine).
   */
  changes: {
    /** Newest first, by kind, status or risk; `nextCursor` continues the page. */
    list: (input?: ChangesListInput) => Promise<ChangesList>;
    /** Change-sets that wait for the owner, per store and risk. */
    pendingCounts: () => Promise<ChangesPendingCounts>;
    /** Undoes one change-set exactly, or names what blocks it. */
    undo: (input: ChangesUndoInput) => Promise<ChangesUndoResult>;
    /** Applies or dismisses a change-set that waits for the owner. */
    review: (input: ChangesReviewInput) => Promise<ChangesReviewResult>;
    /** A bounded before and after (the icicle diff and its table); null when it is gone. */
    diff: (input: ChangesDiffInput) => Promise<ChangesDiff | null>;
  };
  /** The source search of the Ask and Obsidian scope pickers. */
  wiki: {
    search: (
      input: z.input<typeof import("@app/domain").WikiQuerySchema>
    ) => Promise<z.infer<typeof WikiResultsSchema>>;
  };
  system: {
    getInfo: () => Promise<SystemInfo>;
    subscribeNavigation: (listener: (direction: WindowNavigationDirection) => void) => () => void;
  };
  /** The application menu lives in the main process; the renderer receives its commands. */
  menu: {
    subscribeCommand: (listener: (command: AppMenuCommand) => void) => () => void;
    /** The menu follows the interface language the renderer shows. */
    setLanguage: (language: z.infer<typeof languageCodeSchema>) => Promise<void>;
  };
  /** Local, non-telemetry record of the objects that were opened (recents and pins). */
  viewHistory: {
    record: (input: ViewHistoryRecordInput) => Promise<ViewHistoryEntry>;
    list: (input?: ViewHistoryListInput) => Promise<ViewHistoryEntry[]>;
    setPinned: (address: string, pinned: boolean) => Promise<ViewHistoryEntry | null>;
    /** Forgets every unpinned entry; pins stay. Resolves with the number of entries removed. */
    clear: () => Promise<number>;
    subscribeChanged: (listener: () => void) => () => void;
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
    onOpen: (listener: (target: ObsidianDeepLink) => void) => () => void;
    pendingOpen: () => Promise<ObsidianDeepLink | null>;
    editorialConflicts: () => Promise<z.infer<typeof obsidianEditorialConflictsSchema>>;
    editorialComparison: (id: string) => Promise<ObsidianEditReceipt>;
    resolveEditorial: (
      input: z.infer<typeof obsidianResolveInputSchema>
    ) => Promise<ObsidianEditReceipt>;
    layoutStatus: () => Promise<z.infer<typeof obsidianLayoutStatusSchema>>;
    previewLayout: (
      input: z.infer<typeof obsidianLayoutConfigSchema>
    ) => Promise<z.infer<typeof obsidianLayoutStatusSchema>>;
    applyLayout: (
      input: z.infer<typeof obsidianLayoutApplyInputSchema>
    ) => Promise<z.infer<typeof obsidianLayoutStatusSchema>>;
    rollbackLayout: (
      input: z.infer<typeof obsidianLayoutApplyInputSchema>
    ) => Promise<z.infer<typeof obsidianLayoutStatusSchema>>;
    wikiStatus: () => Promise<z.infer<typeof obsidianWikiStatusSchema>>;
    saveWikiScope: (
      input: z.infer<typeof obsidianWikiScopeSchema>
    ) => Promise<z.infer<typeof obsidianWikiScopeSchema>>;
    wikiDiff: (id: string) => Promise<z.infer<typeof obsidianWikiDiffSchema>>;
    recoverWiki: (
      input: z.infer<typeof obsidianWikiRecoverSchema>
    ) => Promise<z.infer<typeof obsidianWikiStatusSchema>>;
    moveRetiredWiki: (
      input: z.infer<typeof obsidianWikiRetiredMoveSchema>
    ) => Promise<z.infer<typeof obsidianWikiStatusSchema>>;
    startSync: () => Promise<ObsidianSyncStatus>;
    getSyncStatus: () => Promise<ObsidianSyncStatus>;
  };
  monitoring: {
    list: (input: MonitoringQuery) => Promise<MonitoringPage>;
    detail: (id: string) => Promise<MonitoringDetail | null>;
    prune: (input: MonitoringPrune) => Promise<{ cutoff: string; count: number }>;
  };
  debug: {
    listSimilarityRuns: () => Promise<SimilarityDebugRun[]>;
    clearSimilarityRuns: () => Promise<{ deletedCount: number }>;
  };
  ingestion: {
    createManual: (input: ManualIngestionInput) => Promise<IngestionResult>;
    previewUrl: (
      input: z.infer<typeof sourceUrlPreviewInputSchema>
    ) => Promise<z.infer<typeof sourceUrlPreviewSchema>>;
    editSource: (input: SourceEditInput) => Promise<z.infer<typeof sourceEditResultSchema>>;
    extractFileMetadata: (
      input: FileMetadataExtractionInput,
      onProgress?: (progress: FileImportProgress) => void
    ) => Promise<FileMetadataExtractionResult | null>;
    previewFileStructure: (input: FileStructurePreviewInput) => Promise<FileStructurePreview>;
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
    cancel: (jobId: string) => Promise<JobRecord | null>;
    retry: (jobId: string) => Promise<JobRecord | null>;
    delete: (jobId: string) => Promise<JobsDeleteResult | null>;
    clearCompletedOrFailed: () => Promise<JobsClearResult>;
  };
  search: {
    query: (input: SearchInput) => Promise<SearchResult[]>;
  };
  knowledge: {
    startRelationLabels: (input: z.infer<typeof relationLabelsInputSchema>) => Promise<string>;
    relationLabelsStatus: () => Promise<JobRecord | null>;
    listLibrary: (sourceTypes?: SourceItemType[]) => Promise<LibrarySource[]>;
    browseLibrary: (input: LibraryBrowseInput) => Promise<LibrarySource[]>;
    getSourceDocument: (
      input: z.infer<typeof sourceDocumentInputSchema>
    ) => Promise<z.infer<typeof sourceDocumentSchema>>;
    getSourceDetail: (sourceItemId: string) => Promise<SourceDetail | null>;
    deleteSource: (sourceItemId: string) => Promise<SourceDeletionResult>;
    openAsset: (assetId: string) => Promise<boolean>;
    getAssetDataUrl: (assetId: string) => Promise<string | null>;
    listPendingNotes: () => Promise<PendingAtomicNote[]>;
    reviewNote: (input: AtomicNoteReviewInput) => Promise<AtomicNoteView | null>;
    getGraphDashboard: (
      mode: KnowledgeGraphDashboardMode,
      sourceView?: "relations" | "entities"
    ) => Promise<KnowledgeGraphDashboard>;
    listSourceRelations: (
      input: z.input<typeof sourceRelationsInputSchema>
    ) => Promise<z.infer<typeof sourceRelationsPageSchema>>;
    reviewSourceRelation: (input: z.infer<typeof sourceRelationReviewSchema>) => Promise<boolean>;
    getGraphSourceConnectionDetails: (
      sourceItemId: string,
      targetSourceItemId: string
    ) => Promise<KnowledgeGraphSourceConnectionDetails>;
  };
  ai: {
    listProviders: () => Promise<AiProviderConfig[]>;
    saveProvider: (input: AiProviderConfigInput) => Promise<AiProviderConfig>;
    deleteProvider: (providerId: string) => Promise<boolean>;
    testProvider: (providerId: string) => Promise<boolean>;
    listModels: (providerId: string) => Promise<string[]>;
    discoverModels: (input: AiModelDiscoveryInput) => Promise<string[]>;
    getParameterCapabilities: (
      input: AiParameterCapabilitiesInput
    ) => Promise<AiModelParameterCapabilities>;
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
    classRoutes: () => Promise<AiClassRoutes>;
    applyPreset: (input: AiApplyPresetInput) => Promise<AiApplyPresetResult>;
    testClassRoute: (route: AiClassRouteTarget) => Promise<AiClassRoutes>;
    setClassRoute: (input: AiSetClassRouteInput) => Promise<AiClassRoutes>;
    setDeciderMode: (mode: NoteDeciderMode | null) => Promise<AiClassRoutes>;
    decisionsStatus: () => Promise<AiDecisionsStatus>;
    setDecisionsEnabled: (enabled: boolean) => Promise<AiDecisionsStatus>;
    saveDecisionsKey: (apiKey: string) => Promise<AiDecisionsStatus>;
    removeDecisionsKey: () => Promise<AiDecisionsStatus>;
    testDecisionsKey: () => Promise<AiDecisionsStatus>;
    subscribeLocalEmbeddingLoadStatus: (
      listener: (status: LocalEmbeddingLoadStatus) => void
    ) => () => void;
  };
  localModels: {
    list: () => Promise<LocalModelView[]>;
    statuses: () => Promise<LocalModelStatusEntry[]>;
    download: (input: LocalModelDownloadInput) => Promise<LocalModelView>;
    cancel: (catalogId: string) => Promise<LocalModelView>;
    resume: (catalogId: string) => Promise<LocalModelView>;
    remove: (catalogId: string) => Promise<LocalModelView>;
    test: (catalogId: string) => Promise<string>;
    setDefaults: (
      localModelId: string,
      defaultParameters: AiModelParameters
    ) => Promise<LocalModelView>;
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
