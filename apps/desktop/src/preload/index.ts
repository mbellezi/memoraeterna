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
  IntegrationPairingInput
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
  integrationPairingResultSchema
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
