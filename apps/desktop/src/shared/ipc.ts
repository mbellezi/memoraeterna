import { z } from "zod";
import {
  AiCapabilitySchema,
  AiModelParametersSchema,
  AiReasoningLevelSchema,
  SearchEvidenceSchema,
  SourceItemTypeSchema,
  type SourceItemType
} from "@app/domain";

export const ipcChannels = {
  systemGetInfo: "app:system:get-info",
  databaseGetStatus: "app:database:get-status",
  databaseStart: "app:database:start",
  appSettingsGet: "app:settings:app:get",
  appSettingsUpdate: "app:settings:app:update",
  settingsGet: "app:settings:get",
  settingsUpdate: "app:settings:update",
  debugSimilarityRunsList: "app:debug:similarity-runs:list",
  debugSimilarityRunsClear: "app:debug:similarity-runs:clear",
  libraryReset: "app:library:reset",
  ingestionCreateManual: "app:ingestion:create-manual",
  ingestionImportFile: "app:ingestion:import-file",
  ingestionLookupSources: "app:ingestion:lookup-sources",
  jobsList: "app:jobs:list",
  jobsCancel: "app:jobs:cancel",
  jobsRetry: "app:jobs:retry",
  jobsClearCompletedOrFailed: "app:jobs:clear-completed-or-failed",
  searchQuery: "app:search:query",
  libraryList: "app:library:list",
  librarySourceGet: "app:library:source:get",
  libraryAssetOpen: "app:library:asset:open",
  knowledgePendingNotesList: "app:knowledge:notes:pending:list",
  knowledgeNoteReview: "app:knowledge:notes:review",
  aiProvidersList: "app:ai:providers:list",
  aiProvidersSave: "app:ai:providers:save",
  aiProvidersTest: "app:ai:providers:test",
  aiModelsList: "app:ai:models:list",
  aiProfilesList: "app:ai:profiles:list",
  aiProfilesCreate: "app:ai:profiles:create",
  aiProfilesUpdate: "app:ai:profiles:update",
  aiProfilesClone: "app:ai:profiles:clone",
  aiProfilesDelete: "app:ai:profiles:delete",
  aiProfileTasksList: "app:ai:profiles:tasks:list",
  aiProfileTaskSet: "app:ai:profiles:task:set",
  aiTaskRoutesList: "app:ai:task-routes:list",
  aiTaskRouteSet: "app:ai:task-routes:set",
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

export const appSettingsSchema = z.object({
  language: languageCodeSchema,
  themeMode: themeModeSchema,
  debugMode: z.boolean().default(false),
  atomicNoteRelationThreshold: z.number().min(0).max(1).default(0.72),
  updatedAt: z.string().datetime()
});

export const appSettingsUpdateSchema = z.object({
  language: languageCodeSchema.optional(),
  themeMode: themeModeSchema.optional(),
  debugMode: z.boolean().optional(),
  atomicNoteRelationThreshold: z.number().min(0).max(1).optional()
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
  sourceType: SourceItemTypeSchema,
  title: z.string().trim().min(1),
  content: z.string().min(1),
  originalUri: z.string().url().nullable().optional(),
  language: z.string().min(2).max(16).default("und"),
  duplicatePolicy: duplicatePolicySchema.default("ignore"),
  parentSourceItemId: z.string().uuid().nullable().optional(),
  bibliographic: z.object({
    workId: z.string().uuid().optional(),
    workTitle: z.string().trim().min(1).optional(),
    workType: z.string().min(1).optional(),
    isbn: z.string().trim().min(1).optional(),
    issn: z.string().trim().min(1).optional(),
    doi: z.string().trim().min(1).optional(),
    pages: z.string().trim().min(1).optional()
  }).strict().optional(),
  metadata: z.record(z.string(), z.unknown()).default({})
}).strict();

export const fileImportInputSchema = z.object({
  sourceType: SourceItemTypeSchema.default("GenericDocument"),
  duplicatePolicy: duplicatePolicySchema.default("ignore")
}).strict();

export const ingestionResultSchema = z.object({
  sourceItemId: z.string().uuid(),
  documentId: z.string().uuid(),
  ingestionRunId: z.string().uuid(),
  jobId: z.string().uuid(),
  duplicate: z.boolean()
}).strict();

export const sourceSuggestionSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1),
  type: SourceItemTypeSchema
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
  error: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  ingestionRun: z.object({
    id: z.string().uuid(),
    status: z.enum(["pending", "running", "succeeded", "failed", "canceled"]),
    currentStage: z.string().min(1),
    stagesCheckpoint: z.record(z.string(), z.unknown())
  }).strict().nullable().optional()
}).strict();

export const jobsClearResultSchema = z.object({
  deletedCount: z.number().int().nonnegative()
}).strict();

export const libraryResetResultSchema = z.object({
  deletedSources: z.number().int().nonnegative(),
  deletedAtomicNotes: z.number().int().nonnegative(),
  deletedFiles: z.number().int().nonnegative(),
  failedFiles: z.number().int().nonnegative()
}).strict();

export const librarySourceSchema = z.object({
  id: z.string().uuid(),
  type: SourceItemTypeSchema,
  title: z.string().min(1),
  subtitle: z.string().nullable(),
  sourceUri: z.string().nullable(),
  language: z.string().min(1),
  summary: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  processingStatus: z.string().min(1),
  currentStage: z.string().min(1),
  updatedAt: z.string().datetime()
}).strict();

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

export const sourceDetailSchema = z.object({
  id: z.string().uuid(),
  type: SourceItemTypeSchema,
  title: z.string().min(1),
  subtitle: z.string().nullable(),
  sourceUri: z.string().nullable(),
  language: z.string().min(1),
  summary: z.string().nullable(),
  metadata: z.record(z.string(), z.unknown()),
  updatedAt: z.string().datetime(),
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
  mode: z.enum(["text", "hybrid"]).default("hybrid"),
  limit: z.number().int().min(1).max(100).default(20)
}).strict();

export const searchResultsSchema = z.array(SearchEvidenceSchema);

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

export const aiProviderKindSchema = z.enum(["google", "openai-compatible"]);
export const aiReasoningLevelSchema = AiReasoningLevelSchema;
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

export const aiProviderConfigSchema = aiProviderConfigInputSchema.omit({ apiKey: true }).extend({
  id: z.string().uuid(),
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
  defaultParameters: aiModelParametersSchema,
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
export type ManualIngestionInput = z.infer<typeof manualIngestionInputSchema>;
export type FileImportInput = z.infer<typeof fileImportInputSchema>;
export type IngestionResult = z.infer<typeof ingestionResultSchema>;
export type SourceSuggestion = z.infer<typeof sourceSuggestionSchema>;
export type JobRecord = z.infer<typeof jobRecordSchema>;
export type JobsClearResult = z.infer<typeof jobsClearResultSchema>;
export type LibraryResetResult = z.infer<typeof libraryResetResultSchema>;
export type SearchInput = z.infer<typeof searchInputSchema>;
export type SearchResult = z.infer<typeof SearchEvidenceSchema>;
export type SimilarityDebugRun = z.infer<typeof similarityDebugRunSchema>;
export type LibrarySource = z.infer<typeof librarySourceSchema>;
export type SourceDetail = z.infer<typeof sourceDetailSchema>;
export type AtomicNoteView = z.infer<typeof atomicNoteViewSchema>;
export type PendingAtomicNote = z.infer<typeof pendingAtomicNoteSchema>;
export type AtomicNoteReviewInput = z.infer<typeof atomicNoteReviewInputSchema>;
export type AiProviderConfigInput = z.infer<typeof aiProviderConfigInputSchema>;
export type AiProviderConfig = z.infer<typeof aiProviderConfigSchema>;
export type AiProfile = z.infer<typeof aiProfileSchema>;
export type AiProfileCreate = z.infer<typeof aiProfileCreateSchema>;
export type AiProfileUpdate = z.infer<typeof aiProfileUpdateSchema>;
export type AiProfileTaskInput = z.infer<typeof aiProfileTaskInputSchema>;
export type AiProfileTask = z.infer<typeof aiProfileTaskSchema>;
export type AiTaskRoute = z.infer<typeof aiTaskRouteSchema>;
export type AiConfigurableTask = z.infer<typeof aiConfigurableTaskSchema>;
export type AiModelParameters = z.infer<typeof aiModelParametersSchema>;
export type AiOutputLanguage = z.infer<typeof aiOutputLanguageSchema>;
export type LocalModelView = z.infer<typeof localModelViewSchema>;
export type LocalModelDownloadInput = z.infer<typeof localModelDownloadInputSchema>;
export type BackupResult = z.infer<typeof backupResultSchema>;
export type IntegrationGatewayStatus = z.infer<typeof integrationGatewayStatusSchema>;
export type IntegrationPairingInput = z.infer<typeof integrationPairingInputSchema>;
export type IntegrationPairingResult = z.infer<typeof integrationPairingResultSchema>;
export type IntegrationClient = z.infer<typeof integrationClientSchema>;

export const defaultAppSettings = {
  themeMode: "dark",
  debugMode: false,
  atomicNoteRelationThreshold: 0.72
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
  };
  database: {
    getStatus: () => Promise<DatabaseStatus>;
    start: () => Promise<DatabaseStatus>;
  };
  settings: {
    getApp: () => Promise<AppSettings>;
    updateApp: (settings: AppSettingsUpdate) => Promise<AppSettings>;
    get: () => Promise<StorageSettings>;
    update: (settings: StorageSettingsUpdate) => Promise<StorageSettings>;
    resetLibrary: () => Promise<LibraryResetResult>;
  };
  debug: {
    listSimilarityRuns: () => Promise<SimilarityDebugRun[]>;
    clearSimilarityRuns: () => Promise<{ deletedCount: number }>;
  };
  ingestion: {
    createManual: (input: ManualIngestionInput) => Promise<IngestionResult>;
    importFile: (input: FileImportInput) => Promise<IngestionResult | null>;
    lookupSources: (query: string) => Promise<SourceSuggestion[]>;
  };
  jobs: {
    list: () => Promise<JobRecord[]>;
    cancel: (jobId: string) => Promise<JobRecord | null>;
    retry: (jobId: string) => Promise<JobRecord | null>;
    clearCompletedOrFailed: () => Promise<JobsClearResult>;
  };
  search: {
    query: (input: SearchInput) => Promise<SearchResult[]>;
  };
  knowledge: {
    listLibrary: (sourceTypes?: SourceItemType[]) => Promise<LibrarySource[]>;
    getSourceDetail: (sourceItemId: string) => Promise<SourceDetail | null>;
    openAsset: (assetId: string) => Promise<boolean>;
    listPendingNotes: () => Promise<PendingAtomicNote[]>;
    reviewNote: (input: AtomicNoteReviewInput) => Promise<AtomicNoteView | null>;
  };
  ai: {
    listProviders: () => Promise<AiProviderConfig[]>;
    saveProvider: (input: AiProviderConfigInput) => Promise<AiProviderConfig>;
    testProvider: (providerId: string) => Promise<boolean>;
    listModels: (providerId: string) => Promise<string[]>;
    listProfiles: () => Promise<AiProfile[]>;
    createProfile: (input: AiProfileCreate) => Promise<AiProfile>;
    updateProfile: (input: AiProfileUpdate) => Promise<AiProfile>;
    cloneProfile: (profileId: string, name: string) => Promise<AiProfile>;
    deleteProfile: (profileId: string) => Promise<boolean>;
    listProfileTasks: (profileId?: string) => Promise<AiProfileTask[]>;
    setProfileTask: (input: AiProfileTaskInput) => Promise<void>;
    listTaskRoutes: () => Promise<AiTaskRoute[]>;
    setTaskRoute: (input: AiTaskRoute) => Promise<void>;
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
