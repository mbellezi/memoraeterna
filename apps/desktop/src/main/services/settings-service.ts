import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
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

export interface SettingsRepository {
  getAppSettings: () => Promise<AppSettings | null>;
  saveAppSettings: (settings: AppSettings) => Promise<AppSettings>;
  getStorageSettings: () => Promise<StorageSettings | null>;
  saveStorageSettings: (settings: StorageSettings) => Promise<StorageSettings>;
  dispose?: () => Promise<void>;
}

export interface SettingsServiceOptions {
  readonly getDatabasePool?: () => Queryable | null;
  readonly requireDatabase?: boolean;
  readonly desktopLocale?: string;
}

function createDefaultAppSettings(locale: string | null | undefined): AppSettings {
  return withAppTimestamp({
    ...defaultAppSettings,
    language: normalizeLanguageCode(locale)
  });
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
  const managedRoot = validateManagedRoot(settings.managedRoot ?? defaultStorageSettings.managedRoot);
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

  return {
    async getAppSettings() {
      try {
        const raw = await readFile(appSettingsPath, "utf8");
        return appSettingsSchema.parse(JSON.parse(raw));
      } catch {
        return null;
      }
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

function createDbSettingsRepository(pool: Queryable, dispose?: () => Promise<void>): SettingsRepository {
  const appRepository = createSettingsRepository(pool);
  const storageRepository = createStorageSettingsRepository(pool);

  return {
    async getAppSettings() {
      const value = await appRepository.get(appSettingsKey);
      return value ? appSettingsSchema.parse(value) : null;
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
  private readonly defaultLocale: string | undefined;

  public constructor(
    private readonly userDataPath: string,
    private readonly options: SettingsServiceOptions = {}
  ) {
    this.defaultLocale = options.desktopLocale;
  }

  public async getApp(): Promise<AppSettings> {
    const repository = await this.getRepository();
    return (await repository.getAppSettings()) ?? createDefaultAppSettings(this.defaultLocale);
  }

  public async updateApp(update: AppSettingsUpdate): Promise<AppSettings> {
    const current = await this.getApp();
    const parsedUpdate = appSettingsUpdateSchema.parse(update);
    const next = withAppTimestamp({
      ...current,
      ...parsedUpdate
    });

    return this.getRepository().then((repository) => repository.saveAppSettings(next));
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
    const disposableRepository = this.repository as (SettingsRepository & { dispose?: () => Promise<void> }) | null;
    await disposableRepository?.dispose?.();
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

    this.repository = (await createEnvDbSettingsRepository()) ?? createFileSettingsRepository(this.userDataPath);
    return this.repository;
  }
}
