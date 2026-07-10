import { z } from "zod";
import { AiCapabilitySchema, SearchEvidenceSchema, SourceItemTypeSchema } from "@app/domain";

export const ipcChannels = {
  systemGetInfo: "app:system:get-info",
  databaseGetStatus: "app:database:get-status",
  databaseStart: "app:database:start",
  appSettingsGet: "app:settings:app:get",
  appSettingsUpdate: "app:settings:app:update",
  settingsGet: "app:settings:get",
  settingsUpdate: "app:settings:update",
  ingestionCreateManual: "app:ingestion:create-manual",
  ingestionImportFile: "app:ingestion:import-file",
  ingestionLookupSources: "app:ingestion:lookup-sources",
  jobsList: "app:jobs:list",
  jobsCancel: "app:jobs:cancel",
  jobsRetry: "app:jobs:retry",
  searchQuery: "app:search:query",
  aiProvidersList: "app:ai:providers:list",
  aiProvidersSave: "app:ai:providers:save",
  aiProvidersTest: "app:ai:providers:test",
  aiModelsList: "app:ai:models:list",
  aiProfilesList: "app:ai:profiles:list",
  aiProfilesCreate: "app:ai:profiles:create",
  aiProfilesClone: "app:ai:profiles:clone",
  aiProfileTaskSet: "app:ai:profiles:task:set"
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
  updatedAt: z.string().datetime()
});

export const appSettingsUpdateSchema = appSettingsSchema
  .omit({ updatedAt: true })
  .partial()
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
  error: z.string().nullable(),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime()
}).strict();

export const searchInputSchema = z.object({
  text: z.string().trim().min(1),
  sourceTypes: z.array(SourceItemTypeSchema).default([]),
  mode: z.enum(["text", "hybrid"]).default("hybrid"),
  limit: z.number().int().min(1).max(100).default(20)
}).strict();

export const searchResultsSchema = z.array(SearchEvidenceSchema);

export const aiProviderKindSchema = z.enum(["google", "openai-compatible"]);
export const aiProviderConfigInputSchema = z.object({
  id: z.string().uuid().optional(),
  provider: aiProviderKindSchema,
  displayName: z.string().trim().min(1),
  baseUrl: z.string().url().nullable().optional(),
  apiKey: z.string().min(1).optional(),
  modelId: z.string().trim().min(1),
  capabilities: z.array(AiCapabilitySchema).default([])
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
  status: z.string().min(1)
}).strict();

export const aiProfileCreateSchema = z.object({
  name: z.string().trim().min(1),
  description: z.string().nullable().optional(),
  isDefault: z.boolean().default(false),
  privacyMode: z.enum(["allow_remote", "offline_only"]).default("allow_remote")
}).strict();

export const aiProfileCloneSchema = z.object({
  profileId: z.string().uuid(),
  name: z.string().trim().min(1)
}).strict();

export const aiProfileTaskInputSchema = z.object({
  profileId: z.string().uuid(),
  task: z.enum(["embedding", "summarization", "text-generation", "structured-output", "atomic-note-generation"]),
  providerConfigId: z.string().uuid(),
  modelId: z.string().trim().min(1),
  requiredCapabilities: z.array(AiCapabilitySchema).default([])
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
export type SearchInput = z.infer<typeof searchInputSchema>;
export type SearchResult = z.infer<typeof SearchEvidenceSchema>;
export type AiProviderConfigInput = z.infer<typeof aiProviderConfigInputSchema>;
export type AiProviderConfig = z.infer<typeof aiProviderConfigSchema>;
export type AiProfile = z.infer<typeof aiProfileSchema>;
export type AiProfileCreate = z.infer<typeof aiProfileCreateSchema>;
export type AiProfileTaskInput = z.infer<typeof aiProfileTaskInputSchema>;

export const defaultAppSettings = {
  themeMode: "dark"
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
  };
  search: {
    query: (input: SearchInput) => Promise<SearchResult[]>;
  };
  ai: {
    listProviders: () => Promise<AiProviderConfig[]>;
    saveProvider: (input: AiProviderConfigInput) => Promise<AiProviderConfig>;
    testProvider: (providerId: string) => Promise<boolean>;
    listModels: (providerId: string) => Promise<string[]>;
    listProfiles: () => Promise<AiProfile[]>;
    createProfile: (input: AiProfileCreate) => Promise<AiProfile>;
    cloneProfile: (profileId: string, name: string) => Promise<AiProfile>;
    setProfileTask: (input: AiProfileTaskInput) => Promise<void>;
  };
}
