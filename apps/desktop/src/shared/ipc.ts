import { z } from "zod";

export const ipcChannels = {
  systemGetInfo: "app:system:get-info",
  databaseGetStatus: "app:database:get-status",
  databaseStart: "app:database:start",
  appSettingsGet: "app:settings:app:get",
  appSettingsUpdate: "app:settings:app:update",
  settingsGet: "app:settings:get",
  settingsUpdate: "app:settings:update"
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
}
