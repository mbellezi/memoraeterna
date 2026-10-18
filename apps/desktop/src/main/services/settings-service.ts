import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  MatchingConfigurationSchema,
  matchingConfigurationsEqual,
  migrateMatchingSettingsV2,
  recommendedMatchingConfiguration,
  recommendedMatchingPresetId,
  retiredRecommendedMatchingConfiguration,
  retiredRecommendedMatchingPresetId
} from "@app/domain";
import {
  closePgPool,
  createPgPool,
  createSettingsRepository,
  createStorageSettingsRepository,
  type Queryable
} from "@app/db";
import { normalizeLanguageCode } from "@app/i18n";
import type {
  AppSettings,
  AppSettingsUpdate,
  StorageSettings,
  StorageSettingsUpdate
} from "../../shared/ipc";
import {
  appSettingsSchema,
  appSettingsUpdateSchema,
  defaultAppSettings,
  defaultStorageSettings,
  storageSettingsSchema,
  storageSettingsUpdateSchema
} from "../../shared/ipc";
import { validateAbsolutePath, validateManagedRoot } from "./path-validation";

const appSettingsKey = "app.preferences";
const importDirectoryKey = "import.lastDirectory";
const importDirectorySchema = z.object({ directory: z.string().refine(isAbsolute) });

export interface SettingsRepository {
  getAppSettings: () => Promise<AppSettings | null>;
  /**
   * Rewrites a stored app-settings document that still holds the matching settings the relations v2
   * migration retired (T53b); resolves true when it rewrote one. Reads migrate in memory regardless.
   */
  migrateAppSettings: () => Promise<boolean>;
  saveAppSettings: (settings: AppSettings) => Promise<AppSettings>;
  getStorageSettings: () => Promise<StorageSettings | null>;
  saveStorageSettings: (settings: StorageSettings) => Promise<StorageSettings>;
  getImportDirectory: () => Promise<unknown>;
  saveImportDirectory: (directory: string) => Promise<void>;
  dispose?: () => Promise<void>;
}

export interface SettingsServiceOptions {
  readonly getDatabasePool?: () => Queryable | null;
  readonly requireDatabase?: boolean;
  readonly desktopLocale?: string;
  /** Where a failed rewrite of the stored settings is reported, once. */
  readonly logger?: Pick<Console, "warn">;
}

/** Writes a file whole or not at all: a reader never sees a half-written document. */
async function writeFileAtomically(path: string, text: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, text, "utf8");
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

function createDefaultAppSettings(locale: string | null | undefined): AppSettings {
  return withAppTimestamp({
    ...defaultAppSettings,
    contentLanguage: normalizeLanguageCode(locale),
    language: normalizeLanguageCode(locale)
  });
}

/** The retired id is no valid selection: the stored values decide whether it upgrades or is preserved. */
function withoutRetiredPresetId(value: unknown): unknown {
  if (typeof value !== "object" || value === null) return value;
  const { activeMatchingPresetId, ...rest } = value as Record<string, unknown>;
  return activeMatchingPresetId === retiredRecommendedMatchingPresetId ? rest : value;
}

export function parseSavedAppSettings(value: unknown): AppSettings {
  const saved = appSettingsSchema.parse(withoutRetiredPresetId(migrateMatchingSettingsV2(value)));
  let configuration = MatchingConfigurationSchema.parse(saved);
  const active = saved.matchingPresets.find((preset) => preset.id === saved.activeMatchingPresetId);
  if (active) {
    // The effective fields remain authoritative for compatibility with older writers.
    active.settings = configuration;
  } else {
    // Values still equal to the retired recommendation follow the recommendation; any other are the owner's.
    // The comparison runs after the matching settings v2 migration (T53b), so a document that differs
    // from the recommendation only in a field that no longer exists now follows it too, instead of
    // becoming "Custom settings": there is nothing of the owner's left in it.
    if (matchingConfigurationsEqual(configuration, retiredRecommendedMatchingConfiguration)) {
      configuration = structuredClone(recommendedMatchingConfiguration);
      Object.assign(saved, structuredClone(configuration));
    }
    if (matchingConfigurationsEqual(configuration, recommendedMatchingConfiguration)) {
      saved.activeMatchingPresetId = recommendedMatchingPresetId;
    } else {
      const id = "00000000-0000-4000-8000-000000000001";
      const previous = saved.matchingPresets.find((preset) => preset.id === id);
      if (previous) previous.settings = configuration;
      else saved.matchingPresets.push({ id, name: null, settings: configuration });
      saved.activeMatchingPresetId = id;
    }
  }
  if (typeof value === "object" && value !== null && !("contentLanguage" in value)) {
    return { ...saved, contentLanguage: normalizeLanguageCode(saved.language) };
  }
  return saved;
}

function withAppTimestamp(settings: AppSettingsUpdate): AppSettings {
  return appSettingsSchema.parse({
    ...defaultAppSettings,
    ...settings,
    language: normalizeLanguageCode(settings.language),
    updatedAt: new Date().toISOString()
  });
}

function withStorageTimestamp(settings: StorageSettingsUpdate): StorageSettings {
  return storageSettingsSchema.parse({
    ...defaultStorageSettings,
    ...settings,
    managedRoot: settings.managedRoot?.trim() || defaultStorageSettings.managedRoot,
    obsidianVaultPath: settings.obsidianVaultPath?.trim() || null,
    uploadCopiesFolderPath: settings.uploadCopiesFolderPath?.trim() || null,
    updatedAt: new Date().toISOString()
  });
}

function validateStorageSettings(settings: StorageSettingsUpdate): void {
  const managedRoot = validateManagedRoot(
    settings.managedRoot ?? defaultStorageSettings.managedRoot
  );
  if (!managedRoot.ok) {
    throw new Error(managedRoot.code ?? "errors.common.validationFailed");
  }

  if (settings.obsidianSyncEnabled) {
    const vaultPath = validateAbsolutePath(settings.obsidianVaultPath);
    if (!vaultPath.ok) {
      throw new Error(vaultPath.code ?? "errors.common.validationFailed");
    }
  }

  if (settings.uploadCopiesEnabled) {
    const copiesPath = validateAbsolutePath(settings.uploadCopiesFolderPath);
    if (!copiesPath.ok) {
      throw new Error(copiesPath.code ?? "errors.common.validationFailed");
    }
  }
}

function createFileSettingsRepository(userDataPath: string): SettingsRepository {
  const settingsPath = join(userDataPath, "storage-settings.json");
  const appSettingsPath = join(userDataPath, "app-settings.json");
  const importDirectoryPath = join(userDataPath, "import-dialog.json");

  return {
    async getImportDirectory() {
      try {
        return JSON.parse(await readFile(importDirectoryPath, "utf8"));
      } catch {
        return null;
      }
    },
    async saveImportDirectory(directory) {
      await mkdir(userDataPath, { recursive: true });
      await writeFile(importDirectoryPath, JSON.stringify({ directory }), "utf8");
    },
    async getAppSettings() {
      try {
        const raw = await readFile(appSettingsPath, "utf8");
        return parseSavedAppSettings(JSON.parse(raw));
      } catch {
        return null;
      }
    },
    async migrateAppSettings() {
      let stored: unknown;
      try {
        stored = JSON.parse(await readFile(appSettingsPath, "utf8"));
      } catch {
        return false;
      }
      const migrated = migrateMatchingSettingsV2(stored);
      if (migrated === stored) return false;
      await writeFileAtomically(appSettingsPath, JSON.stringify(migrated, null, 2));
      return true;
    },
    async saveAppSettings(settings) {
      await mkdir(dirname(appSettingsPath), { recursive: true });
      await writeFile(appSettingsPath, JSON.stringify(settings, null, 2), "utf8");
      return settings;
    },
    async getStorageSettings() {
      try {
        const raw = await readFile(settingsPath, "utf8");
        return storageSettingsSchema.parse(JSON.parse(raw));
      } catch {
        return null;
      }
    },
    async saveStorageSettings(settings) {
      await mkdir(dirname(settingsPath), { recursive: true });
      await writeFile(settingsPath, JSON.stringify(settings, null, 2), "utf8");
      return settings;
    }
  };
}

function createDbSettingsRepository(
  pool: Queryable,
  dispose?: () => Promise<void>
): SettingsRepository {
  const appRepository = createSettingsRepository(pool);
  const storageRepository = createStorageSettingsRepository(pool);

  return {
    getImportDirectory: () => appRepository.get(importDirectoryKey),
    async saveImportDirectory(directory) {
      await appRepository.set(importDirectoryKey, { directory });
    },
    async getAppSettings() {
      const value = await appRepository.get(appSettingsKey);
      return value ? parseSavedAppSettings(value) : null;
    },
    async migrateAppSettings() {
      const stored = await appRepository.get(appSettingsKey);
      if (!stored) return false;
      const migrated = migrateMatchingSettingsV2(stored);
      if (migrated === stored) return false;
      // Only while the row still holds what was read: a concurrent change to the document (a
      // `jsonb_set` of the re-match tool, say) is never overwritten with the older copy.
      return appRepository.replaceIfUnchanged(appSettingsKey, stored, migrated);
    },
    async saveAppSettings(settings) {
      await appRepository.set(appSettingsKey, settings);
      return settings;
    },
    async getStorageSettings() {
      const record = await storageRepository.get();
      if (!record) {
        return null;
      }
      return storageSettingsSchema.parse({
        obsidianVaultPath: record.obsidianVaultPath,
        managedRoot: record.obsidianManagedRoot,
        obsidianSyncEnabled: record.obsidianSyncEnabled,
        obsidianSyncPaused: record.obsidianSyncPaused,
        deletionPolicy: record.deletePolicy,
        uploadCopiesEnabled: record.uploadCopyEnabled,
        uploadCopiesFolderPath: record.uploadCopyBasePath,
        updatedAt: record.updatedAt.toISOString()
      });
    },
    async saveStorageSettings(settings) {
      const record = await storageRepository.upsert({
        obsidianVaultPath: settings.obsidianVaultPath,
        obsidianManagedRoot: settings.managedRoot,
        obsidianSyncEnabled: settings.obsidianSyncEnabled,
        obsidianSyncPaused: settings.obsidianSyncPaused,
        deletePolicy: settings.deletionPolicy,
        uploadCopyEnabled: settings.uploadCopiesEnabled,
        uploadCopyBasePath: settings.uploadCopiesFolderPath
      });
      return storageSettingsSchema.parse({
        obsidianVaultPath: record.obsidianVaultPath,
        managedRoot: record.obsidianManagedRoot,
        obsidianSyncEnabled: record.obsidianSyncEnabled,
        obsidianSyncPaused: record.obsidianSyncPaused,
        deletionPolicy: record.deletePolicy,
        uploadCopiesEnabled: record.uploadCopyEnabled,
        uploadCopiesFolderPath: record.uploadCopyBasePath,
        updatedAt: record.updatedAt.toISOString()
      });
    },
    ...(dispose ? { dispose } : {})
  };
}

async function createEnvDbSettingsRepository(): Promise<SettingsRepository | null> {
  const connectionString = process.env.MEMORA_DATABASE_URL;
  if (!connectionString) {
    return null;
  }

  const pool = createPgPool({ connectionString, max: 2 });
  return createDbSettingsRepository(pool, () => closePgPool(pool));
}

export class SettingsService {
  private repository: SettingsRepository | null = null;
  private appSettingsMigration: Promise<void> | null = null;
  private appUpdateQueue: Promise<unknown> = Promise.resolve();
  private readonly defaultLocale: string | undefined;

  public constructor(
    private readonly userDataPath: string,
    private readonly options: SettingsServiceOptions = {}
  ) {
    this.defaultLocale = options.desktopLocale;
  }

  public async getImportDirectory(): Promise<string | undefined> {
    try {
      const saved = importDirectorySchema.safeParse(
        await (await this.getRepository()).getImportDirectory()
      );
      if (saved.success && (await stat(saved.data.directory)).isDirectory())
        return saved.data.directory;
    } catch {
      /* An unavailable folder or preference must not prevent file selection. */
    }
    return undefined;
  }

  public async rememberImportFile(filePath: string): Promise<void> {
    if (!isAbsolute(filePath)) return;
    try {
      await (await this.getRepository()).saveImportDirectory(dirname(filePath));
    } catch {
      /* Remembering dialog location is best effort; continue the import. */
    }
  }

  public async getApp(): Promise<AppSettings> {
    const repository = await this.getRepository();
    await this.migrateStoredAppSettings(repository);
    const saved = await repository.getAppSettings();
    return saved ?? repository.saveAppSettings(createDefaultAppSettings(this.defaultLocale));
  }

  public async updateApp(update: AppSettingsUpdate): Promise<AppSettings> {
    const parsedUpdate = appSettingsUpdateSchema.parse(update);
    const operation = this.appUpdateQueue.then(async () => {
      const current = await this.getApp();
      const next = withAppTimestamp({ ...current, ...parsedUpdate });
      const configuration = MatchingConfigurationSchema.parse(next);
      if (
        parsedUpdate.matchingPresets !== undefined ||
        parsedUpdate.activeMatchingPresetId !== undefined
      ) {
        const selected =
          next.activeMatchingPresetId === recommendedMatchingPresetId
            ? recommendedMatchingConfiguration
            : next.matchingPresets.find((preset) => preset.id === next.activeMatchingPresetId)
                ?.settings;
        if (!selected) throw new Error("errors.common.validationFailed");
        const hasMatchingPatch = Object.keys(MatchingConfigurationSchema.shape).some(
          (key) => key in parsedUpdate
        );
        if (hasMatchingPatch && !matchingConfigurationsEqual(configuration, selected))
          throw new Error("errors.common.validationFailed");
        Object.assign(next, structuredClone(selected));
      } else if (
        !matchingConfigurationsEqual(configuration, MatchingConfigurationSchema.parse(current))
      ) {
        const active = next.matchingPresets.find(
          (preset) => preset.id === next.activeMatchingPresetId
        );
        if (active) active.settings = configuration;
        else {
          const id = randomUUID();
          next.matchingPresets.push({ id, name: null, settings: configuration });
          next.activeMatchingPresetId = id;
        }
      }
      const validated = appSettingsSchema.parse(next);
      return (await this.getRepository()).saveAppSettings(validated);
    });
    this.appUpdateQueue = operation.catch(() => undefined);
    return operation;
  }

  public async get(): Promise<StorageSettings> {
    const repository = await this.getRepository();
    return (await repository.getStorageSettings()) ?? withStorageTimestamp(defaultStorageSettings);
  }

  public async update(update: StorageSettingsUpdate): Promise<StorageSettings> {
    const current = await this.get();
    const parsedUpdate = storageSettingsUpdateSchema.parse(update);
    const nextInput = {
      ...current,
      ...parsedUpdate
    } satisfies StorageSettingsUpdate;

    validateStorageSettings(nextInput);

    const next = withStorageTimestamp(nextInput);
    return this.getRepository().then((repository) => repository.saveStorageSettings(next));
  }

  public async dispose(): Promise<void> {
    const disposableRepository = this.repository as
      (SettingsRepository & { dispose?: () => Promise<void> }) | null;
    await disposableRepository?.dispose?.();
  }

  /**
   * Matching settings v2 (T53b): the first read of a service drops the retired matching settings
   * from the stored document, once, before anything else reads or saves it. A failure is not fatal
   * and is reported once, not retried: every read migrates in memory and the next save writes the
   * clean document.
   */
  private migrateStoredAppSettings(repository: SettingsRepository): Promise<void> {
    this.appSettingsMigration ??= repository.migrateAppSettings().then(
      () => undefined,
      (error: unknown) => {
        (this.options.logger ?? console).warn(
          "The stored matching settings could not be rewritten; they are read migrated in memory.",
          error instanceof Error ? error.message : String(error)
        );
      }
    );
    return this.appSettingsMigration;
  }

  private async getRepository(): Promise<SettingsRepository> {
    if (this.repository) {
      return this.repository;
    }

    const databasePool = this.options.getDatabasePool?.();
    if (databasePool) {
      this.repository = createDbSettingsRepository(databasePool);
      return this.repository;
    }

    if (this.options.requireDatabase) {
      throw new Error("errors.database.notReady");
    }

    this.repository =
      (await createEnvDbSettingsRepository()) ?? createFileSettingsRepository(this.userDataPath);
    return this.repository;
  }
}
