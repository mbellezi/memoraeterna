import type { IpcMain } from "electron";
import { app, dialog, shell } from "electron";
import { z } from "zod";
import { createTranslator } from "@app/i18n";
import {
  databaseStatusSchema,
  ipcChannels,
  appSettingsUpdateSchema,
  aiProfileCloneSchema,
  aiProfileCreateSchema,
  aiProfileTaskInputSchema,
  aiProviderConfigInputSchema,
  atomicNoteReviewInputSchema,
  fileImportInputSchema,
  manualIngestionInputSchema,
  searchInputSchema,
  storageSettingsUpdateSchema,
  type DatabaseStatus
} from "../shared/ipc";
import { SourceItemTypeSchema } from "@app/domain";
import type { SettingsService } from "./services/settings-service";
import type { AiService } from "./services/ai-service.js";
import type { IngestionService } from "./services/ingestion-service.js";
import type { JobSupervisor } from "./services/job-supervisor.js";
import type { SearchService } from "./services/search-service.js";
import type { KnowledgeService } from "./services/knowledge-service.js";

export interface DatabaseServicePort {
  getStatus: () => DatabaseStatus;
  start: () => Promise<DatabaseStatus>;
}

export function registerIpcHandlers(
  ipcMain: IpcMain,
  settingsService: SettingsService,
  databaseService: DatabaseServicePort,
  ingestionService: IngestionService,
  jobSupervisor: JobSupervisor,
  searchService: SearchService,
  aiService: AiService,
  knowledgeService: KnowledgeService
): void {
  const t = createTranslator(app.getLocale());

  ipcMain.handle(ipcChannels.systemGetInfo, () => ({
    appName: t("app.title"),
    locale: app.getLocale(),
    platform: process.platform,
    versions: {
      chrome: process.versions.chrome,
      electron: process.versions.electron,
      node: process.versions.node
    }
  }));

  ipcMain.handle(ipcChannels.databaseGetStatus, () => databaseStatusSchema.parse(databaseService.getStatus()));

  ipcMain.handle(ipcChannels.databaseStart, async () => databaseStatusSchema.parse(await databaseService.start()));

  ipcMain.handle(ipcChannels.appSettingsGet, () => settingsService.getApp());

  ipcMain.handle(ipcChannels.appSettingsUpdate, (_event, payload: unknown) => {
    const settings = appSettingsUpdateSchema.parse(payload);
    return settingsService.updateApp(settings);
  });

  ipcMain.handle(ipcChannels.settingsGet, () => settingsService.get());

  ipcMain.handle(ipcChannels.settingsUpdate, (_event, payload: unknown) => {
    const settings = storageSettingsUpdateSchema.parse(payload);
    return settingsService.update(settings);
  });

  ipcMain.handle(ipcChannels.ingestionCreateManual, (_event, payload: unknown) =>
    ingestionService.createManual(manualIngestionInputSchema.parse(payload))
  );

  ipcMain.handle(ipcChannels.ingestionImportFile, async (_event, payload: unknown) => {
    const input = fileImportInputSchema.parse(payload);
    const selection = await dialog.showOpenDialog({ properties: ["openFile"] });
    const path = selection.filePaths[0];
    return selection.canceled || !path ? null : ingestionService.importFile(path, input);
  });
  ipcMain.handle(ipcChannels.ingestionLookupSources, (_event, payload: unknown) =>
    ingestionService.lookupSources(z.string().trim().min(1).max(200).parse(payload))
  );

  ipcMain.handle(ipcChannels.jobsList, async () => (await jobSupervisor.listWithRuns()).map(({ job, ingestionRun }) =>
    serializeJob(job, ingestionRun)
  ));
  ipcMain.handle(ipcChannels.jobsCancel, async (_event, payload: unknown) => {
    const job = await jobSupervisor.requestCancel(z.string().uuid().parse(payload));
    return job ? serializeJob(job) : null;
  });
  ipcMain.handle(ipcChannels.jobsRetry, async (_event, payload: unknown) => {
    const job = await jobSupervisor.retry(z.string().uuid().parse(payload));
    return job ? serializeJob(job) : null;
  });

  ipcMain.handle(ipcChannels.searchQuery, (_event, payload: unknown) =>
    searchService.search(searchInputSchema.parse(payload))
  );

  ipcMain.handle(ipcChannels.libraryList, (_event, payload: unknown) =>
    knowledgeService.listLibrary(SourceItemTypeSchema.array().parse(payload ?? []))
  );
  ipcMain.handle(ipcChannels.librarySourceGet, (_event, payload: unknown) =>
    knowledgeService.getSourceDetail(z.string().uuid().parse(payload))
  );
  ipcMain.handle(ipcChannels.libraryAssetOpen, async (_event, payload: unknown) => {
    const path = await knowledgeService.resolveAssetPath(z.string().uuid().parse(payload));
    return (await shell.openPath(path)).length === 0;
  });
  ipcMain.handle(ipcChannels.knowledgePendingNotesList, () => knowledgeService.listPendingNotes());
  ipcMain.handle(ipcChannels.knowledgeNoteReview, (_event, payload: unknown) =>
    knowledgeService.reviewNote(atomicNoteReviewInputSchema.parse(payload))
  );

  ipcMain.handle(ipcChannels.aiProvidersList, () => aiService.listProviders());
  ipcMain.handle(ipcChannels.aiProvidersSave, (_event, payload: unknown) =>
    aiService.saveProvider(aiProviderConfigInputSchema.parse(payload))
  );
  ipcMain.handle(ipcChannels.aiProvidersTest, (_event, payload: unknown) =>
    aiService.testProvider(z.string().uuid().parse(payload))
  );
  ipcMain.handle(ipcChannels.aiModelsList, (_event, payload: unknown) =>
    aiService.listModels(z.string().uuid().parse(payload))
  );
  ipcMain.handle(ipcChannels.aiProfilesList, () => aiService.listProfiles());
  ipcMain.handle(ipcChannels.aiProfilesCreate, (_event, payload: unknown) =>
    aiService.createProfile(aiProfileCreateSchema.parse(payload))
  );
  ipcMain.handle(ipcChannels.aiProfilesClone, (_event, payload: unknown) => {
    const input = aiProfileCloneSchema.parse(payload);
    return aiService.cloneProfile(input.profileId, input.name);
  });
  ipcMain.handle(ipcChannels.aiProfileTaskSet, (_event, payload: unknown) =>
    aiService.setProfileTask(aiProfileTaskInputSchema.parse(payload))
  );
}

function serializeJob(
  job: Awaited<ReturnType<JobSupervisor["list"]>>[number],
  ingestionRun: Awaited<ReturnType<JobSupervisor["listWithRuns"]>>[number]["ingestionRun"] = null
) {
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    canCancel: job.type === "ingestion" && (job.status === "queued" || job.status === "running"),
    canRetry: job.type === "ingestion" && job.status === "failed" && job.attempts < job.maxAttempts,
    error: job.error,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    ingestionRun: ingestionRun ? {
      id: ingestionRun.id,
      status: ingestionRun.status,
      currentStage: ingestionRun.currentStage,
      stagesCheckpoint: ingestionRun.stagesCheckpoint
    } : null
  };
}
