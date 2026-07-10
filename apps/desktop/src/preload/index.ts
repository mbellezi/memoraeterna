import { contextBridge, ipcRenderer } from "electron";
import type {
  AiProfileCreate,
  AiProfileTaskInput,
  AiProviderConfigInput,
  AtomicNoteReviewInput,
  AppSettingsUpdate,
  DesktopApi,
  FileImportInput,
  ManualIngestionInput,
  SearchInput,
  StorageSettingsUpdate,
  IntegrationPairingInput,
  LocalModelDownloadInput
} from "../shared/ipc";
import type { SourceItemType } from "@app/domain";
import {
  appSettingsSchema,
  appSettingsUpdateSchema,
  aiProfileCreateSchema,
  aiProfileTaskInputSchema,
  aiProfileSchema,
  aiProviderConfigInputSchema,
  aiProviderConfigSchema,
  atomicNoteReviewInputSchema,
  atomicNoteViewSchema,
  databaseStatusSchema,
  ipcChannels,
  fileImportInputSchema,
  ingestionResultSchema,
  jobRecordSchema,
  jobsClearResultSchema,
  librarySourceSchema,
  manualIngestionInputSchema,
  searchInputSchema,
  searchResultsSchema,
  pendingAtomicNoteSchema,
  sourceDetailSchema,
  sourceSuggestionSchema,
  storageSettingsSchema,
  storageSettingsUpdateSchema,
  systemInfoSchema,
  integrationClientSchema,
  integrationGatewayStatusSchema,
  integrationPairingInputSchema,
  integrationPairingResultSchema,
  backupResultSchema,
  localModelDownloadInputSchema,
  localModelViewSchema,
  repositoryTokenInputSchema
} from "../shared/ipc";

const api: DesktopApi = {
  system: {
    async getInfo() {
      const result = await ipcRenderer.invoke(ipcChannels.systemGetInfo);
      return systemInfoSchema.parse(result);
    }
  },
  database: {
    async getStatus() {
      const result = await ipcRenderer.invoke(ipcChannels.databaseGetStatus);
      return databaseStatusSchema.parse(result);
    },
    async start() {
      const result = await ipcRenderer.invoke(ipcChannels.databaseStart);
      return databaseStatusSchema.parse(result);
    }
  },
  settings: {
    async getApp() {
      const result = await ipcRenderer.invoke(ipcChannels.appSettingsGet);
      return appSettingsSchema.parse(result);
    },
    async updateApp(settings: AppSettingsUpdate) {
      const payload = appSettingsUpdateSchema.parse(settings);
      const result = await ipcRenderer.invoke(ipcChannels.appSettingsUpdate, payload);
      return appSettingsSchema.parse(result);
    },
    async get() {
      const result = await ipcRenderer.invoke(ipcChannels.settingsGet);
      return storageSettingsSchema.parse(result);
    },
    async update(settings: StorageSettingsUpdate) {
      const payload = storageSettingsUpdateSchema.parse(settings);
      const result = await ipcRenderer.invoke(ipcChannels.settingsUpdate, payload);
      return storageSettingsSchema.parse(result);
    }
  },
  ingestion: {
    async createManual(input: ManualIngestionInput) {
      const result = await ipcRenderer.invoke(ipcChannels.ingestionCreateManual, manualIngestionInputSchema.parse(input));
      return ingestionResultSchema.parse(result);
    },
    async importFile(input: FileImportInput) {
      const result = await ipcRenderer.invoke(ipcChannels.ingestionImportFile, fileImportInputSchema.parse(input));
      return result === null ? null : ingestionResultSchema.parse(result);
    },
    async lookupSources(query: string) {
      return sourceSuggestionSchema.array().parse(await ipcRenderer.invoke(ipcChannels.ingestionLookupSources, query));
    }
  },
  jobs: {
    async list() {
      return jobRecordSchema.array().parse(await ipcRenderer.invoke(ipcChannels.jobsList));
    },
    async cancel(jobId: string) {
      const result = await ipcRenderer.invoke(ipcChannels.jobsCancel, jobId);
      return result === null ? null : jobRecordSchema.parse(result);
    },
    async retry(jobId: string) {
      const result = await ipcRenderer.invoke(ipcChannels.jobsRetry, jobId);
      return result === null ? null : jobRecordSchema.parse(result);
    },
    async clearCompletedOrFailed() {
      return jobsClearResultSchema.parse(
        await ipcRenderer.invoke(ipcChannels.jobsClearCompletedOrFailed)
      );
    }
  },
  search: {
    async query(input: SearchInput) {
      return searchResultsSchema.parse(await ipcRenderer.invoke(ipcChannels.searchQuery, searchInputSchema.parse(input)));
    }
  },
  knowledge: {
    async listLibrary(sourceTypes: SourceItemType[] = []) {
      return librarySourceSchema.array().parse(await ipcRenderer.invoke(ipcChannels.libraryList, sourceTypes));
    },
    async getSourceDetail(sourceItemId: string) {
      const result = await ipcRenderer.invoke(ipcChannels.librarySourceGet, sourceItemId);
      return result === null ? null : sourceDetailSchema.parse(result);
    },
    async openAsset(assetId: string) {
      return Boolean(await ipcRenderer.invoke(ipcChannels.libraryAssetOpen, assetId));
    },
    async listPendingNotes() {
      return pendingAtomicNoteSchema.array().parse(
        await ipcRenderer.invoke(ipcChannels.knowledgePendingNotesList)
      );
    },
    async reviewNote(input: AtomicNoteReviewInput) {
      const result = await ipcRenderer.invoke(
        ipcChannels.knowledgeNoteReview,
        atomicNoteReviewInputSchema.parse(input)
      );
      return result === null ? null : atomicNoteViewSchema.parse(result);
    }
  },
  ai: {
    async listProviders() {
      return aiProviderConfigSchema.array().parse(await ipcRenderer.invoke(ipcChannels.aiProvidersList));
    },
    async saveProvider(input: AiProviderConfigInput) {
      return aiProviderConfigSchema.parse(await ipcRenderer.invoke(ipcChannels.aiProvidersSave, aiProviderConfigInputSchema.parse(input)));
    },
    async testProvider(providerId: string) {
      return Boolean(await ipcRenderer.invoke(ipcChannels.aiProvidersTest, providerId));
    },
    async listModels(providerId: string) {
      return (await ipcRenderer.invoke(ipcChannels.aiModelsList, providerId)) as string[];
    },
    async listProfiles() {
      return aiProfileSchema.array().parse(await ipcRenderer.invoke(ipcChannels.aiProfilesList));
    },
    async createProfile(input: AiProfileCreate) {
      return aiProfileSchema.parse(await ipcRenderer.invoke(ipcChannels.aiProfilesCreate, aiProfileCreateSchema.parse(input)));
    },
    async cloneProfile(profileId: string, name: string) {
      return aiProfileSchema.parse(await ipcRenderer.invoke(ipcChannels.aiProfilesClone, { profileId, name }));
    },
    async setProfileTask(input: AiProfileTaskInput) {
      await ipcRenderer.invoke(ipcChannels.aiProfileTaskSet, aiProfileTaskInputSchema.parse(input));
    }
  },
  localModels: {
    async list() {
      return localModelViewSchema.array().parse(await ipcRenderer.invoke(ipcChannels.localModelsList));
    },
    async download(input: LocalModelDownloadInput) {
      return localModelViewSchema.parse(await ipcRenderer.invoke(
        ipcChannels.localModelsDownload,
        localModelDownloadInputSchema.parse(input)
      ));
    },
    async cancel(catalogId: string) {
      return localModelViewSchema.parse(await ipcRenderer.invoke(ipcChannels.localModelsCancel, catalogId));
    },
    async resume(catalogId: string) {
      return localModelViewSchema.parse(await ipcRenderer.invoke(ipcChannels.localModelsResume, catalogId));
    },
    async remove(catalogId: string) {
      return localModelViewSchema.parse(await ipcRenderer.invoke(ipcChannels.localModelsRemove, catalogId));
    },
    async test(catalogId: string) {
      return String(await ipcRenderer.invoke(ipcChannels.localModelsTest, catalogId));
    },
    async importGguf() {
      const result = await ipcRenderer.invoke(ipcChannels.localModelsImportGguf);
      return result === null ? null : localModelViewSchema.parse(result);
    },
    async setRepositoryToken(token: string) {
      return Boolean(await ipcRenderer.invoke(
        ipcChannels.localModelsRepositoryTokenSet,
        repositoryTokenInputSchema.parse({ token })
      ));
    },
    async hasRepositoryToken() {
      return Boolean(await ipcRenderer.invoke(ipcChannels.localModelsRepositoryTokenStatus));
    }
  },
  backup: {
    async create() {
      const result = await ipcRenderer.invoke(ipcChannels.backupCreate);
      return result === null ? null : backupResultSchema.parse(result);
    }
  },
  integrations: {
    async getGatewayStatus() {
      return integrationGatewayStatusSchema.parse(await ipcRenderer.invoke(ipcChannels.integrationGatewayStatus));
    },
    async listClients() {
      return integrationClientSchema.array().parse(await ipcRenderer.invoke(ipcChannels.integrationClientsList));
    },
    async createPairing(input: IntegrationPairingInput) {
      return integrationPairingResultSchema.parse(
        await ipcRenderer.invoke(ipcChannels.integrationPairingCreate, integrationPairingInputSchema.parse(input))
      );
    },
    async revokeClient(clientId: string) {
      return Boolean(await ipcRenderer.invoke(ipcChannels.integrationClientRevoke, clientId));
    }
  }
};

contextBridge.exposeInMainWorld("app", api);
