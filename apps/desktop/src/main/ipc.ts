import type { IpcMain } from "electron";
import { app, dialog, shell, webContents } from "electron";
import { z } from "zod";
import { createTranslator } from "@app/i18n";
import {
  databaseStatusSchema,
  ipcChannels,
  appSettingsUpdateSchema,
  aiProfileCloneSchema,
  aiProfileCreateSchema,
  aiProfileUpdateSchema,
  aiProfileTaskInputSchema,
  aiTaskRouteSchema,
  aiProviderConfigInputSchema,
  aiModelDiscoveryInputSchema,
  atomicNoteReviewInputSchema,
  fileImportInputSchema,
  manualIngestionInputSchema,
  searchInputSchema,
  storageSettingsUpdateSchema,
  integrationPairingInputSchema,
  localModelDownloadInputSchema,
  localModelDefaultsInputSchema,
  repositoryTokenInputSchema,
  processingRequestSchema,
  structureSaveInputSchema,
  structureConfirmInputSchema,
  type DatabaseStatus
} from "../shared/ipc";
import { AiReasoningLevelSchema, SourceItemTypeSchema } from "@app/domain";
import type { SettingsService } from "./services/settings-service";
import type { AiService } from "./services/ai-service.js";
import type { IngestionService } from "./services/ingestion-service.js";
import type { JobSupervisor } from "./services/job-supervisor.js";
import { canManuallyRetryJob } from "./services/job-retry.js";
import type { SearchService } from "./services/search-service.js";
import type { KnowledgeService } from "./services/knowledge-service.js";
import type { IntegrationGateway } from "./services/integration-gateway.js";
import type { LocalModelService } from "./services/local-model-service.js";
import type { BackupService } from "./services/backup-service.js";
import type { LibraryResetService } from "./services/library-reset-service.js";
import type { SimilarityDebugService } from "./services/similarity-debug-service.js";
import type { ObsidianSyncService } from "./services/obsidian-sync-service.js";
import type { HierarchicalIngestionService } from "./services/hierarchical-ingestion-service.js";

export interface DatabaseServicePort {
  getStatus: () => DatabaseStatus;
  start: () => Promise<DatabaseStatus>;
}

export function registerIpcHandlers(
  ipcMain: IpcMain,
  settingsService: SettingsService,
  databaseService: DatabaseServicePort,
  ingestionService: IngestionService,
  hierarchicalIngestionService: HierarchicalIngestionService,
  jobSupervisor: JobSupervisor,
  searchService: SearchService,
  aiService: AiService,
  knowledgeService: KnowledgeService,
  integrationGateway: IntegrationGateway,
  localModelService: LocalModelService,
  backupService: BackupService,
  libraryResetService: LibraryResetService,
  similarityDebugService: SimilarityDebugService,
  obsidianSyncService: ObsidianSyncService
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

  ipcMain.handle(ipcChannels.settingsSelectObsidianVault, async () => {
    const selection = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    const path = selection.filePaths[0];
    if (selection.canceled || !path) return null;
    const settings = await settingsService.update({
      obsidianVaultPath: path,
      obsidianSyncEnabled: true,
      obsidianSyncPaused: false
    });
    obsidianSyncService.startSynchronization();
    return settings;
  });

  ipcMain.handle(ipcChannels.obsidianSyncStart, () => obsidianSyncService.startSynchronization());
  ipcMain.handle(ipcChannels.obsidianSyncStatus, () => obsidianSyncService.getSynchronizationStatus());

  ipcMain.handle(ipcChannels.debugSimilarityRunsList, () => similarityDebugService.list());
  ipcMain.handle(ipcChannels.debugSimilarityRunsClear, () => similarityDebugService.clear());

  ipcMain.handle(ipcChannels.libraryReset, async () => {
    await Promise.all([integrationGateway.stop(), jobSupervisor.stop(), localModelService.shutdown()]);
    try {
      return await libraryResetService.reset();
    } finally {
      await Promise.all([localModelService.start(), jobSupervisor.start(), integrationGateway.start()]);
    }
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
  ipcMain.handle(ipcChannels.ingestionStructureGet, async (_event, payload: unknown) => {
    const structure = await hierarchicalIngestionService.getStructure(z.string().uuid().parse(payload));
    return structure ? serializeStructure(structure) : null;
  });
  ipcMain.handle(ipcChannels.ingestionStructureSave, async (_event, payload: unknown) => {
    const input = structureSaveInputSchema.parse(payload);
    return serializeStructure(await hierarchicalIngestionService.saveStructure(input.structureId, input.divisions));
  });
  ipcMain.handle(ipcChannels.ingestionStructureConfirm, async (_event, payload: unknown) => {
    const input = structureConfirmInputSchema.parse(payload);
    const result = await hierarchicalIngestionService.confirmStructure(input);
    return { batchId: result.batchId, queued: result.queued };
  });
  ipcMain.handle(ipcChannels.ingestionProcess, (_event, payload: unknown) => {
    const input = processingRequestSchema.parse(payload);
    return hierarchicalIngestionService.process({
      plan: input.plan,
      runKind: input.runKind,
      ...(input.trigger ? { trigger: input.trigger } : {})
    });
  });
  ipcMain.handle(ipcChannels.ingestionBatchesList, async () =>
    (await hierarchicalIngestionService.listBatches()).map((batch) => ({
      ...batch,
      createdAt: batch.createdAt.toISOString(),
      updatedAt: batch.updatedAt.toISOString()
    }))
  );

  ipcMain.handle(ipcChannels.jobsList, async () => (await jobSupervisor.listWithRuns()).map(({ job, ingestionRun, source }) =>
    serializeJob(job, ingestionRun, source)
  ));
  jobSupervisor.subscribe(() => {
    for (const contents of webContents.getAllWebContents()) {
      if (!contents.isDestroyed()) contents.send(ipcChannels.jobsChanged);
    }
  });
  ipcMain.handle(ipcChannels.jobsCancel, async (_event, payload: unknown) => {
    const job = await jobSupervisor.requestCancel(z.string().uuid().parse(payload));
    return job ? serializeJob(job) : null;
  });
  ipcMain.handle(ipcChannels.jobsRetry, async (_event, payload: unknown) => {
    const job = await jobSupervisor.retry(z.string().uuid().parse(payload));
    return job ? serializeJob(job) : null;
  });
  ipcMain.handle(ipcChannels.jobsClearCompletedOrFailed, async () => ({
    deletedCount: await jobSupervisor.clearCompletedOrFailed()
  }));

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
  ipcMain.handle(ipcChannels.aiProvidersDelete, (_event, payload: unknown) =>
    aiService.deleteProvider(z.string().uuid().parse(payload))
  );
  ipcMain.handle(ipcChannels.aiProvidersTest, (_event, payload: unknown) =>
    aiService.testProvider(z.string().uuid().parse(payload))
  );
  ipcMain.handle(ipcChannels.aiModelsList, (_event, payload: unknown) =>
    aiService.listModels(z.string().uuid().parse(payload))
  );
  ipcMain.handle(ipcChannels.aiModelsDiscover, (_event, payload: unknown) =>
    aiService.discoverModels(aiModelDiscoveryInputSchema.parse(payload))
  );
  ipcMain.handle(ipcChannels.aiOpenAiCodexConnect, () => aiService.connectOpenAiCodex());
  ipcMain.handle(ipcChannels.aiOpenAiCodexDisconnect, () => aiService.disconnectOpenAiCodex());
  ipcMain.handle(ipcChannels.aiProfilesList, () => aiService.listProfiles());
  ipcMain.handle(ipcChannels.aiProfilesCreate, (_event, payload: unknown) =>
    aiService.createProfile(aiProfileCreateSchema.parse(payload))
  );
  ipcMain.handle(ipcChannels.aiProfilesUpdate, (_event, payload: unknown) =>
    aiService.updateProfile(aiProfileUpdateSchema.parse(payload))
  );
  ipcMain.handle(ipcChannels.aiProfilesClone, (_event, payload: unknown) => {
    const input = aiProfileCloneSchema.parse(payload);
    return aiService.cloneProfile(input.profileId, input.name);
  });
  ipcMain.handle(ipcChannels.aiProfilesDelete, (_event, payload: unknown) =>
    aiService.deleteProfile(z.string().uuid().parse(payload))
  );
  ipcMain.handle(ipcChannels.aiProfileTasksList, (_event, payload: unknown) =>
    aiService.listProfileTasks(payload === undefined ? undefined : z.string().uuid().parse(payload))
  );
  ipcMain.handle(ipcChannels.aiProfileTaskSet, (_event, payload: unknown) =>
    aiService.setProfileTask(aiProfileTaskInputSchema.parse(payload))
  );
  ipcMain.handle(ipcChannels.aiTaskRoutesList, () => aiService.listTaskRoutes());
  ipcMain.handle(ipcChannels.aiTaskRouteSet, (_event, payload: unknown) =>
    aiService.setTaskRoute(aiTaskRouteSchema.parse(payload))
  );

  ipcMain.handle(ipcChannels.localModelsList, () => localModelService.list());
  ipcMain.handle(ipcChannels.localModelsDownload, (_event, payload: unknown) =>
    localModelService.requestDownload(localModelDownloadInputSchema.parse(payload))
  );
  ipcMain.handle(ipcChannels.localModelsCancel, (_event, payload: unknown) =>
    localModelService.cancel(z.string().min(1).parse(payload))
  );
  ipcMain.handle(ipcChannels.localModelsResume, (_event, payload: unknown) =>
    localModelService.resume(z.string().min(1).parse(payload))
  );
  ipcMain.handle(ipcChannels.localModelsRemove, (_event, payload: unknown) =>
    localModelService.remove(z.string().min(1).parse(payload))
  );
  ipcMain.handle(ipcChannels.localModelsTest, (_event, payload: unknown) =>
    localModelService.test(z.string().min(1).parse(payload))
  );
  ipcMain.handle(ipcChannels.localModelsDefaultsSet, (_event, payload: unknown) => {
    const input = localModelDefaultsInputSchema.parse(payload);
    return localModelService.setDefaults(input.localModelId, input.defaultParameters);
  });
  ipcMain.handle(ipcChannels.localModelsImportGguf, async () => {
    const selection = await dialog.showOpenDialog({
      properties: ["openFile"],
      filters: [{ name: "GGUF", extensions: ["gguf"] }]
    });
    const path = selection.filePaths[0];
    return selection.canceled || !path ? null : localModelService.importGguf(path);
  });
  ipcMain.handle(ipcChannels.localModelsRepositoryTokenSet, (_event, payload: unknown) =>
    localModelService.setRepositoryToken(repositoryTokenInputSchema.parse(payload).token)
  );
  ipcMain.handle(ipcChannels.localModelsRepositoryTokenStatus, () => localModelService.hasRepositoryToken());

  ipcMain.handle(ipcChannels.backupCreate, async () => {
    const selection = await dialog.showOpenDialog({ properties: ["openDirectory", "createDirectory"] });
    const path = selection.filePaths[0];
    return selection.canceled || !path ? null : backupService.create(path);
  });

  ipcMain.handle(ipcChannels.integrationGatewayStatus, () => integrationGateway.getStatus());
  ipcMain.handle(ipcChannels.integrationClientsList, () => integrationGateway.listClients());
  ipcMain.handle(ipcChannels.integrationPairingCreate, (_event, payload: unknown) =>
    integrationGateway.createPairing(integrationPairingInputSchema.parse(payload))
  );
  ipcMain.handle(ipcChannels.integrationClientRevoke, (_event, payload: unknown) =>
    integrationGateway.revokeClient(z.string().uuid().parse(payload))
  );
}

function serializeStructure(structure: NonNullable<Awaited<ReturnType<HierarchicalIngestionService["getStructure"]>>>) {
  const rawWarnings = structure.rawEvidence.warnings;
  return {
    id: structure.id,
    rootSourceItemId: structure.rootSourceItemId,
    rootDocumentId: structure.rootDocumentId,
    format: structure.format,
    detectorVersion: structure.detectorVersion,
    status: structure.status,
    overallConfidence: structure.overallConfidence,
    revision: structure.revision,
    warnings: Array.isArray(rawWarnings) ? rawWarnings.filter((item): item is string => typeof item === "string") : [],
    divisions: structure.divisions.map((division) => ({
      id: division.id,
      parentId: division.parentId,
      kind: division.kind,
      title: division.title,
      level: division.level,
      position: division.position,
      startSelector: division.startSelector,
      endSelector: division.endSelector,
      ...(division.startPage === undefined ? {} : { startPage: division.startPage }),
      ...(division.endPage === undefined ? {} : { endPage: division.endPage }),
      ...(division.markdownStart === undefined ? {} : { markdownStart: division.markdownStart }),
      ...(division.markdownEnd === undefined ? {} : { markdownEnd: division.markdownEnd }),
      confidence: division.confidence,
      evidence: division.evidence,
      reviewStatus: division.reviewStatus,
      isProcessable: division.isProcessable,
      metadata: division.metadata,
      childSourceItemId: division.childSourceItemId,
      childDocumentId: division.childDocumentId
    })),
    createdAt: structure.createdAt.toISOString(),
    updatedAt: structure.updatedAt.toISOString()
  };
}

function serializeJob(
  job: Awaited<ReturnType<JobSupervisor["list"]>>[number],
  ingestionRun: Awaited<ReturnType<JobSupervisor["listWithRuns"]>>[number]["ingestionRun"] = null,
  source: Awaited<ReturnType<JobSupervisor["listWithRuns"]>>[number]["source"] = null
) {
  const errorHistory = readJobErrorHistory(job.payload, job.error, job.type, job.attempts, job.updatedAt);
  return {
    id: job.id,
    type: job.type,
    status: job.status,
    progress: job.progress,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    canCancel: (job.type === "ingestion" || isCancelableAiStage(job.type))
      && (job.status === "queued" || job.status === "running"),
    canRetry: canManuallyRetryJob(job, ingestionRun),
    error: job.error,
    errorHistory,
    createdAt: job.createdAt.toISOString(),
    updatedAt: job.updatedAt.toISOString(),
    aiExecution: readJobAiExecution(job.payload),
    source: source ? {
      id: source.id,
      title: source.title,
      type: source.type,
      origin: source.sourceOrigin
    } : null,
    ingestionRun: ingestionRun ? {
      id: ingestionRun.id,
      batchId: ingestionRun.batchId,
      status: ingestionRun.status,
      currentStage: ingestionRun.currentStage,
      effectiveStages: ingestionRun.effectiveStages.filter((stage): stage is string => typeof stage === "string"),
      stagesCheckpoint: ingestionRun.stagesCheckpoint
    } : null
  };
}

function readJobAiExecution(payload: Record<string, unknown>) {
  const value = payload.aiExecution;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.provider !== "string" || typeof record.modelId !== "string") return null;
  const reasoningLevel = record.reasoningLevel === null
    ? null
    : AiReasoningLevelSchema.safeParse(record.reasoningLevel);
  if (reasoningLevel !== null && !reasoningLevel.success) return null;
  return {
    provider: record.provider,
    modelId: record.modelId,
    reasoningLevel: reasoningLevel === null ? null : reasoningLevel.data
  };
}

function readJobErrorHistory(
  payload: Record<string, unknown>,
  currentError: string | null,
  stage: string,
  attempt: number,
  updatedAt: Date
) {
  const history = Array.isArray(payload.errorHistory)
    ? payload.errorHistory.flatMap((item) => {
        if (typeof item !== "object" || item === null) return [];
        const record = item as Record<string, unknown>;
        if (typeof record.message !== "string" || typeof record.stage !== "string"
            || typeof record.attempt !== "number" || typeof record.occurredAt !== "string") return [];
        return [{ message: record.message, stage: record.stage, attempt: record.attempt, occurredAt: record.occurredAt }];
      })
    : [];
  if (currentError && !history.some((item) => item.message === currentError && item.attempt === attempt)) {
    history.push({ message: currentError, stage, attempt, occurredAt: updatedAt.toISOString() });
  }
  return history;
}

function isCancelableAiStage(type: string): boolean {
  return ["summarization", "atomic-note-generation", "knowledge-graph-generation", "atomic-note-matching"].includes(type);
}
