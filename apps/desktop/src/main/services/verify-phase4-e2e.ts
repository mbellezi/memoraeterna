import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closePgPool,
  createAiConfigRepository,
  createAtomicNoteRepository,
  createChunkRepository,
  createDocumentRepository,
  createEmbeddingRepository,
  createIngestionRunRepository,
  createJobRepository,
  createObsidianSyncRepository,
  createPgPool,
  createSearchRepository,
  createSettingsRepository,
  createSourceItemRepository,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "@app/db";
import { AiProviderError } from "@app/ai";
import { sha256 } from "@app/conversion";
import {
  AtomicNoteMatchingSettingsSchema,
  DocumentDivisionCandidateSchema,
  isSymmetricNoteRelationType,
  ProcessingPlanRequestSchema,
  SourceDescriptorSchema,
  processingPresetStages
} from "@app/domain";
import {
  integrationContractVersion,
  integrationHandshakeResponseSchema,
  obsidianEditingCapability,
  obsidianLayoutCapability,
  obsidianManifestSchema,
  parseObsidianMarkdown,
  type IntegrationHandshakeResponse,
  type ObsidianEditOperation
} from "@app/integration-contracts";

import "./verify-worker-host.js";
import { HierarchicalIngestionService } from "./hierarchical-ingestion-service.js";
import { IngestionService } from "./ingestion-service.js";
import { IntegrationGateway } from "./integration-gateway.js";
import { JobSupervisor, lightJobUpdate } from "./job-supervisor.js";
import type { AiService } from "./ai-service.js";
import { KnowledgeService } from "./knowledge-service.js";
import { ObjectsService } from "./objects-service.js";
import { SourceEditorialService } from "./source-editorial-service.js";
import { ObsidianSyncService } from "./obsidian-sync-service.js";
import { YouTubeService } from "./youtube-service.js";
import { runObsidianSync } from "../workers/obsidian-sync.worker.js";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const workspaceRoot = resolve(desktopRoot, "../..");
const workDir = await mkdtemp(join(tmpdir(), "memora-phase4-e2e-"));
const vaultPath = join(workDir, "vault");
const sidecarPaths = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const manager = new PostgresSidecarManager({
  binDir: sidecarPaths.binDir,
  dataDir: join(workDir, "database"),
  database: "memora_phase4_e2e",
  user: "memora_phase4_e2e",
  password: `phase4-${randomUUID()}`,
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 10_000
});

let pool: PgPool | null = null;
let gateway: IntegrationGateway | null = null;
let jobs: JobSupervisor | null = null;
let obsidian: ObsidianSyncService | null = null;
try {
  await mkdir(vaultPath, { recursive: true });
  const connection = await manager.start();
  pool = createPgPool({ connectionString: connection.connectionString, max: 5 });
  await runMigrations(pool, resolve(workspaceRoot, "packages/db/drizzle"), {
    seedFolder: resolve(workspaceRoot, "packages/db/seed")
  });
  const settings = async () => ({
    obsidianVaultPath: vaultPath,
    managedRoot: "Memora",
    obsidianSyncEnabled: true,
    obsidianSyncPaused: false,
    deletionPolicy: "tombstone" as const,
    uploadCopiesEnabled: false,
    uploadCopiesFolderPath: null,
    updatedAt: new Date().toISOString()
  });
  const ingestion = new IngestionService({
    getPool: () => pool ?? null,
    getStorageSettings: settings,
    userDataPath: workDir,
    resourcesPath: workspaceRoot,
    workspaceRoot,
    isPackaged: false,
    fetchExternalPage: async () => new Response("", { status: 500 }),
    youtubeService: new YouTubeService(async () => ({
      basic_info: { title: "Phase 4 video", author: "Memora channel" },
      getTranscript: async () => ({
        transcript: {
          segments: [
            { start_ms: 0, snippet: { text: "External capture keeps traceable knowledge." } }
          ]
        }
      })
    }))
  });
  obsidian = new ObsidianSyncService({
    getPool: () => pool ?? null,
    getStorageSettings: settings,
    writeProjection: async (input) => {
      const result = await runObsidianSync({ action: "write", ...input });
      return { mtimeMs: Number(result.mtimeMs) };
    }
  });
  jobs = new JobSupervisor({ getPool: () => pool ?? null, obsidianSyncService: obsidian });
  gateway = new IntegrationGateway({
    getPool: () => pool ?? null,
    ingestionService: ingestion,
    obsidianSyncService: obsidian,
    jobSupervisor: jobs,
    preferredPort: 0
  });
  const gatewayStatus = await gateway.start();
  const baseUrl = gatewayStatus.baseUrl;
  if (!baseUrl) throw new Error("Gateway did not start.");

  const chromePairing = await gateway.createPairing({
    clientType: "chrome-extension",
    displayName: "E2E Chrome"
  });
  const chrome = await handshake(baseUrl, chromePairing, "chrome-extension", [
    "capture-web-page",
    "capture-selection",
    "capture-youtube-video",
    "receive-job-progress"
  ]);
  const capturedAt = new Date().toISOString();
  const webPayload = {
    requestId: randomUUID(),
    url: "https://example.com/phase-4",
    title: "Phase 4 article",
    capturedAt,
    html: "<html><head><title>Phase 4 article</title></head><body><main><h1>Phase 4</h1><p>Gateway evidence is searchable.</p></main></body></html>",
    metadata: { language: "en" }
  };
  const firstCapture = await post(baseUrl, chrome.sessionToken, "/v1/capture/web-page", webPayload);
  const repeatedCapture = await post(baseUrl, chrome.sessionToken, "/v1/capture/web-page", {
    ...webPayload,
    requestId: randomUUID()
  });
  const webSourceId = requiredString(firstCapture, "sourceItemId");
  if (
    webSourceId !== requiredString(repeatedCapture, "sourceItemId") ||
    repeatedCapture.duplicate !== true
  ) {
    throw new Error("Repeated web capture was not deduplicated.");
  }
  const youtubeCapture = await post(baseUrl, chrome.sessionToken, "/v1/capture/youtube", {
    requestId: randomUUID(),
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    videoId: "dQw4w9WgXcQ",
    title: "Visible title",
    capturedAt,
    visibleMetadata: {}
  });
  const selectionCapture = await post(baseUrl, chrome.sessionToken, "/v1/capture/selection", {
    requestId: randomUUID(),
    url: "https://example.com/phase-4",
    title: "Phase 4 selection",
    capturedAt,
    selection: "A selected external idea.",
    metadata: {}
  });
  const selectionSourceId = requiredString(selectionCapture, "sourceItemId");
  const youtubeSourceId = requiredString(youtubeCapture, "sourceItemId");

  // Extracted text can carry U+0000 (Docling emits it for unmapped math glyphs); PostgreSQL cannot
  // store it, so it is stripped on the way in instead of aborting the import.
  const nulCapture = await post(baseUrl, chrome.sessionToken, "/v1/capture/selection", {
    requestId: randomUUID(),
    url: "https://example.com/phase-4-nul",
    title: "Phase 4 \u0000NUL selection",
    capturedAt,
    selection: "A selected idea with a \u0000 math minus glyph.",
    metadata: {}
  });
  const nulSourceId = requiredString(nulCapture, "sourceItemId");
  const nulDocument = (await createDocumentRepository(pool).listBySourceItem(nulSourceId))[0];
  const nulSource = await createSourceItemRepository(pool).findById(nulSourceId);
  if (
    !nulDocument?.canonicalMarkdown.includes("math minus glyph") ||
    nulDocument.canonicalMarkdown.includes("\u0000") ||
    nulSource?.title.includes("\u0000")
  ) {
    throw new Error("A capture containing U+0000 was not stored without it.");
  }

  // A source import persists in one transaction: when any step fails (a trigger rejects the insert
  // in this throwaway database), no source, document, asset, structure, bibliographic row or stored
  // file remains, and the structure confirmation leaves the draft retryable instead of half done.
  const hierarchy = new HierarchicalIngestionService({ getPool: () => pool ?? null });
  const importOnly = ProcessingPlanRequestSchema.parse({
    preset: "import_only",
    requestedStages: []
  });
  const atomicPath = join(workDir, "atomic-source.md");
  await writeFile(
    atomicPath,
    "# Chapter One\n\nFirst chapter of the atomic import.\n\n# Chapter Two\n\nSecond chapter of the atomic import.\n"
  );
  const count = async (table: string) =>
    Number(
      (await pool!.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0]?.n
    );
  const persistedRows = async () =>
    JSON.stringify(
      await Promise.all(
        [
          "source_items",
          "documents",
          "document_assets",
          "document_structures",
          "document_divisions",
          "bibliographic_works",
          "bibliographic_instances",
          "source_item_bibliographic_links"
        ].map(count)
      )
    );
  const storedFiles = async () =>
    (
      await readdir(join(workDir, "assets"), { recursive: true, withFileTypes: true }).catch(
        () => []
      )
    )
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name)
      .sort();
  await pool.query(
    `create function phase4_reject() returns trigger language plpgsql as $$
     begin raise exception 'simulated % failure', tg_argv[0]; end $$`
  );
  const importAtomicBook = () =>
    ingestion.importFile(atomicPath, {
      descriptor: SourceDescriptorSchema.parse({ type: "Book", title: "Phase 4 atomic book" }),
      duplicatePolicy: "version",
      processingPlan: importOnly
    });
  const rowsBefore = await persistedRows();
  const filesBefore = await storedFiles();
  for (const [step, table, condition] of [
    ["document", "documents", "new.title = 'Phase 4 atomic book'"],
    ["asset", "document_assets", "new.original_file_name = 'atomic-source.md'"],
    ["structure", "document_structures", "true"]
  ] as const) {
    await pool.query(
      `create trigger phase4_reject before insert on ${table}
       for each row when (${condition}) execute function phase4_reject('${step}')`
    );
    const failure = await importAtomicBook().then(
      () => null,
      (error: unknown) => error
    );
    await pool.query(`drop trigger phase4_reject on ${table}`);
    if (!(failure instanceof Error) || !failure.message.includes(`simulated ${step} failure`)) {
      throw new Error(`The ${step} insert failure did not fail the import: ${String(failure)}`);
    }
    if (
      (await persistedRows()) !== rowsBefore ||
      (await storedFiles()).join() !== filesBefore.join()
    ) {
      throw new Error(`A failed import at the ${step} step left rows or files behind.`);
    }
  }
  const atomicImport = await importAtomicBook();
  if (
    !atomicImport.documentId ||
    !atomicImport.structureId ||
    !atomicImport.requiresStructureReview ||
    (await storedFiles()).length !== filesBefore.length + 1 ||
    (await count("document_assets")) !== 1 ||
    (await count("document_structures")) !== 1
  ) {
    throw new Error("The import that follows the failures did not persist completely.");
  }

  // The confirmation saves the reviewed divisions, confirms and materializes the children together.
  const draft = await hierarchy.getStructure(atomicImport.structureId);
  if (!draft || draft.divisions.length !== 2) throw new Error("The structure draft is missing.");
  const reviewed = draft.divisions.map((division) =>
    DocumentDivisionCandidateSchema.parse({
      id: division.id,
      parentId: division.parentId,
      kind: division.kind,
      title: division.title,
      level: division.level,
      position: division.position,
      startSelector: division.startSelector,
      endSelector: division.endSelector,
      ...(division.markdownStart === undefined ? {} : { markdownStart: division.markdownStart }),
      ...(division.markdownEnd === undefined ? {} : { markdownEnd: division.markdownEnd }),
      confidence: division.confidence,
      evidence: division.evidence,
      reviewStatus: division.reviewStatus,
      isProcessable: division.isProcessable,
      metadata: division.metadata
    })
  );
  const sourcesBeforeConfirmation = await count("source_items");
  await pool.query(
    `create trigger phase4_reject before insert on documents
     for each row when (new.metadata ? 'derivedFromDocumentId') execute function phase4_reject('materialization')`
  );
  const confirmFailure = await hierarchy
    .confirmStructure({
      structureId: atomicImport.structureId,
      divisions: reviewed,
      plan: importOnly
    })
    .then(
      () => null,
      (error: unknown) => error
    );
  await pool.query(`drop trigger phase4_reject on documents`);
  const afterFailedConfirmation = await createDocumentRepository(pool).listBySourceItem(
    atomicImport.sourceItemId
  );
  const draftAfterFailure = await hierarchy.getStructure(atomicImport.structureId);
  if (
    !(confirmFailure instanceof Error) ||
    !confirmFailure.message.includes("simulated materialization failure") ||
    draftAfterFailure?.status !== "in_review" ||
    (await count("source_items")) !== sourcesBeforeConfirmation ||
    afterFailedConfirmation.length !== 1
  ) {
    throw new Error("A failed confirmation did not leave the structure in review.");
  }
  const confirmed = await hierarchy.confirmStructure({
    structureId: atomicImport.structureId,
    divisions: reviewed,
    plan: importOnly
  });
  if (
    confirmed.structure.status !== "materialized" ||
    confirmed.materialized.length !== 2 ||
    (await count("source_items")) !== sourcesBeforeConfirmation + 2
  ) {
    throw new Error("The retried confirmation did not materialize the chapters.");
  }

  // Updating a duplicate is atomic too: the editorial revision and the refreshed document are one
  // transaction, so a failure after the revision was written (the document refresh is rejected
  // here) leaves the previous version current and untouched.
  const noteDescriptor = SourceDescriptorSchema.parse({
    type: "PersonalNote",
    title: "Phase 4 atomic note"
  });
  const saveNote = (content: string) =>
    ingestion.createManual({
      descriptor: noteDescriptor,
      content,
      duplicatePolicy: "update",
      processingPlan: importOnly
    });
  const firstNote = await saveNote("First version of the atomic note.");
  const secondNote = await saveNote("Second version of the atomic note.");
  const documentHistory = () => createDocumentRepository(pool!).listHistory(firstNote.sourceItemId);
  const noteBefore = await createSourceItemRepository(pool).findById(firstNote.sourceItemId);
  const historyBefore = (await documentHistory()).length;
  if (
    secondNote.sourceItemId !== firstNote.sourceItemId ||
    !secondNote.duplicate ||
    historyBefore !== 2
  ) {
    throw new Error("Updating a duplicate did not create a revision of the same source.");
  }
  await pool.query(
    `create trigger phase4_reject before update on documents
     for each row when (new.canonical_markdown like 'Third version%')
     execute function phase4_reject('update')`
  );
  const updateFailure = await saveNote("Third version of the atomic note.").then(
    () => null,
    (error: unknown) => error
  );
  await pool.query(`drop trigger phase4_reject on documents`);
  const noteAfter = await createSourceItemRepository(pool).findById(firstNote.sourceItemId);
  const currentNote = (
    await createDocumentRepository(pool).listBySourceItem(firstNote.sourceItemId)
  )[0];
  if (
    !(updateFailure instanceof Error) ||
    !updateFailure.message.includes("simulated update failure") ||
    (await documentHistory()).length !== historyBefore ||
    noteAfter?.updatedAt.getTime() !== noteBefore?.updatedAt.getTime() ||
    currentNote?.id !== secondNote.documentId ||
    !currentNote.canonicalMarkdown.includes("Second version")
  ) {
    throw new Error("A failed update changed the source or its current document.");
  }
  await pool.query(`drop function phase4_reject()`);

  // Captures are import-only: no generative stage is planned for a non-interactive capture.
  const runs = createIngestionRunRepository(pool);
  const importOnlyStages: readonly string[] = processingPresetStages.import_only;
  for (const sourceId of [webSourceId, youtubeSourceId, selectionSourceId]) {
    const [run] = await runs.listBySourceItem(sourceId);
    if (!run || run.effectiveStages.join() !== importOnlyStages.join()) {
      throw new Error(`Capture ${sourceId} was not queued with the import-only plan.`);
    }
  }

  const obsidianPairing = await gateway.createPairing({
    clientType: "obsidian-plugin",
    displayName: "E2E Obsidian"
  });
  const obsidianClient = await handshake(baseUrl, obsidianPairing, "obsidian-plugin", [
    "import-obsidian-note",
    "watch-obsidian-files",
    "reconcile-obsidian-vault",
    "receive-job-progress",
    obsidianLayoutCapability,
    obsidianEditingCapability
  ]);
  const importMarkdown = "# Phase 4 vault note\n\nA user note written inside Obsidian.";
  const importPayload = {
    requestId: randomUUID(),
    relativePath: "Inbox/Phase 4 vault note.md",
    markdown: importMarkdown,
    contentHash: sha256(importMarkdown),
    mtimeMs: Date.now()
  };
  const imported = await post(
    baseUrl,
    obsidianClient.sessionToken,
    "/v1/obsidian/import",
    importPayload
  );
  const importedSourceId = requiredString(imported, "sourceItemId");
  const importedAgain = await post(baseUrl, obsidianClient.sessionToken, "/v1/obsidian/import", {
    ...importPayload,
    requestId: randomUUID()
  });
  if (importedAgain.sourceItemId !== importedSourceId || importedAgain.duplicate !== true) {
    throw new Error("Repeated Obsidian import was not deduplicated.");
  }
  const importedSource = await createSourceItemRepository(pool).findById(importedSourceId);
  if (importedSource?.sourceOrigin !== "obsidian") {
    throw new Error("Imported Obsidian note did not keep its origin.");
  }

  // The projection is a mirror job: it creates the layout on a fresh install and writes the vault.
  const jobsRepository = createJobRepository(pool);
  // A pass is one light job delivered page by page: each page queues the job again.
  const projectVault = async () => {
    const jobId = await obsidian!.wiki.enqueue(true);
    if (!jobId) throw new Error("Projection job was not queued.");
    const total = { projected: 0, conflicts: 0, failed: 0 };
    for (;;) {
      const job = await jobsRepository.claimNext("phase4-e2e", ["obsidian-wiki"], "light");
      if (!job) throw new Error("A projection page was not queued on the light lane.");
      const result = await obsidian!.wiki.execute(job);
      await jobsRepository.update(job.id, lightJobUpdate(job, result));
      total.projected += result.projected;
      total.conflicts += result.conflicts;
      total.failed += result.failed;
      if (result.done) return total;
    }
  };
  const countIngestionJobs = async () =>
    (await jobsRepository.list()).filter((job) => job.type === "ingestion").length;
  const ingestionJobsBeforeProjection = await countIngestionJobs();
  const projection = await projectVault();
  if (projection.conflicts !== 0 || projection.failed !== 0 || projection.projected < 3) {
    throw new Error(`Unexpected projection result: ${JSON.stringify(projection)}`);
  }
  const layout = await createSettingsRepository(pool).get<{ version?: number }>("obsidian.layout");
  if (layout?.version !== 2) throw new Error("A fresh install did not start on layout version 2.");
  if ((await countIngestionJobs()) !== ingestionJobsBeforeProjection) {
    throw new Error("Projection queued ingestion work.");
  }

  const syncRepository = createObsidianSyncRepository(pool);
  const webSync = await syncRepository.findByMemoraId(webSourceId);
  const videoSync = await syncRepository.findByMemoraId(youtubeSourceId);
  const selectionSync = await syncRepository.findByMemoraId(selectionSourceId);
  if (!webSync || !videoSync || !selectionSync) {
    throw new Error("Captured sources were not projected to Obsidian.");
  }
  const webPath = join(vaultPath, webSync.relativePath);
  const projected = parseObsidianMarkdown(await readFile(webPath, "utf8"));
  const webDocument = (await createDocumentRepository(pool).listBySourceItem(webSourceId))[0];
  if (!webDocument) throw new Error("Captured web source has no document.");
  if (
    !webSync.relativePath.startsWith("Memora/Sources/") ||
    !videoSync.relativePath.startsWith("Memora/Sources/") ||
    projected?.frontmatter.memoraId !== webSourceId ||
    projected.frontmatter.memoraType !== "source_item" ||
    projected.frontmatter.memoraManaged !== true ||
    projected.frontmatter.memoraLayout !== 2 ||
    projected.frontmatter.memoraDocumentId !== webDocument.id ||
    !projected.bodyMarkdown.includes("<!-- memora:original:start -->")
  ) {
    throw new Error("Projected web source does not follow the layout 2 identity contract.");
  }

  // A projection never echoes back as an import, a move or a deletion.
  const echo = await obsidian.reconcileVault();
  if (echo.synced !== 0 || echo.conflicts !== 0 || echo.deleted !== 0) {
    throw new Error(`Projection echoed back as a change: ${JSON.stringify(echo)}`);
  }

  // Editorial writeback is a separately granted, vault-bound capability.
  const vaultId = randomUUID();
  await post(baseUrl, obsidianClient.sessionToken, "/v1/obsidian/layout/presence", {
    vaultId,
    openPaths: [],
    pendingTargetIds: []
  });
  const manifestFor = async (targetId: string) => {
    const manifest = obsidianManifestSchema.parse(
      await post(baseUrl, obsidianClient.sessionToken, "/v1/obsidian/editorial/manifest", {
        vaultId,
        cursor: 0
      })
    );
    const file = manifest.files.find((entry) => entry.targetId === targetId);
    if (!file) throw new Error(`Editorial manifest does not list ${targetId}.`);
    return { binding: manifest.binding.binding, file };
  };
  const operationFrom = (
    manifest: Awaited<ReturnType<typeof manifestFor>>,
    content: string
  ): ObsidianEditOperation => ({
    version: 1,
    operationId: randomUUID(),
    vaultId,
    binding: manifest.binding,
    targetId: manifest.file.targetId,
    targetType: manifest.file.targetType,
    kind: "edit",
    relativePath: manifest.file.relativePath,
    baseRevision: manifest.file.revision,
    baseVersion: manifest.file.syncVersion,
    baseHash: manifest.file.contentHash,
    content,
    occurredAt: new Date().toISOString()
  });

  const webManifest = await manifestFor(webSourceId);
  const offlineMarker = "Offline Obsidian edit is searchable evidence.";
  const offlineContent = webManifest.file.content.replace(
    "Gateway evidence is searchable.",
    offlineMarker
  );
  if (offlineContent === webManifest.file.content) {
    throw new Error("The projected original region changed shape.");
  }
  await writeFile(webPath, offlineContent);
  const accepted = await post(
    baseUrl,
    obsidianClient.sessionToken,
    "/v1/obsidian/editorial/operation",
    operationFrom(webManifest, offlineContent)
  );
  if (accepted.status !== "synced") {
    throw new Error(`Editorial edit was not accepted: ${JSON.stringify(accepted)}`);
  }
  await writeFile(webPath, requiredString(accepted, "content"));
  await post(baseUrl, obsidianClient.sessionToken, "/v1/obsidian/editorial/acknowledge", {
    operationId: requiredString(accepted, "operationId"),
    vaultId
  });
  const editedDocument = (await createDocumentRepository(pool).listBySourceItem(webSourceId))[0];
  if (!editedDocument?.canonicalMarkdown.includes(offlineMarker)) {
    throw new Error("Obsidian edit did not update canonical Markdown.");
  }
  const acceptedFrame = parseObsidianMarkdown(requiredString(accepted, "content"));
  const revisionId = acceptedFrame?.frontmatter.memoraDocumentRevisionId;
  const revision = revisionId
    ? await pool.query("select 1 from document_revisions where id = $1 and document_id = $2", [
        revisionId,
        editedDocument.id
      ])
    : null;
  if (revision?.rowCount !== 1) throw new Error("The edit did not become a document revision.");
  if ((await countIngestionJobs()) !== ingestionJobsBeforeProjection) {
    throw new Error("An editorial edit queued ingestion work.");
  }
  await indexDocument(
    pool,
    editedDocument.id,
    editedDocument.sourceItemId,
    editedDocument.canonicalMarkdown
  );
  const search = await createSearchRepository(pool).searchText({
    text: "offline obsidian edit",
    limit: 5
  });
  if (search[0]?.sourceItemId !== webSourceId)
    throw new Error("Search did not reflect the Obsidian edit.");

  // A desktop edit made while Obsidian still holds an older base is an explicit conflict.
  const staleManifest = await manifestFor(webSourceId);
  const staleLocal = staleManifest.file.content.replace(offlineMarker, "A stale local rewrite.");
  const desktopMarkdown = `${editedDocument.canonicalMarkdown.trim()}\n\nDesktop edit wins.\n`;
  const webSource = await createSourceItemRepository(pool).findById(webSourceId);
  if (!webSource) throw new Error("Captured web source disappeared.");
  await new SourceEditorialService(pool).saveProjected(
    webSourceId,
    webSource.updatedAt.toISOString(),
    desktopMarkdown
  );
  const conflict = await post(
    baseUrl,
    obsidianClient.sessionToken,
    "/v1/obsidian/editorial/operation",
    operationFrom(staleManifest, staleLocal)
  );
  const comparison = conflict.comparison as Record<string, string> | null;
  if (
    conflict.status !== "conflict" ||
    !comparison?.base?.includes(offlineMarker) ||
    !comparison.local?.includes("A stale local rewrite.") ||
    !comparison.app?.includes("Desktop edit wins.")
  ) {
    throw new Error(`Version conflict was not explicit: ${JSON.stringify(conflict)}`);
  }
  const afterConflict = (await createDocumentRepository(pool).listBySourceItem(webSourceId))[0];
  if (!afterConflict?.canonicalMarkdown.includes("Desktop edit wins.")) {
    throw new Error("A conflicting Obsidian edit overwrote the desktop version.");
  }

  // Registered paths are stable and absence is never evidence of deletion.
  const movedPath = join(dirname(webPath), "phase-4-article-moved.md");
  await rename(webPath, movedPath);
  const afterMove = await obsidian.reconcileVault();
  const movedRecord = await syncRepository.findByMemoraId(webSourceId);
  if (movedRecord?.relativePath !== webSync.relativePath || movedRecord.status === "deleted") {
    throw new Error("An Obsidian rename silently moved or retired the registered path.");
  }
  await unlink(movedPath);
  const afterDelete = await obsidian.reconcileVault();
  if (
    afterMove.deleted !== 0 ||
    afterDelete.deleted !== 0 ||
    (await syncRepository.findByMemoraId(webSourceId))?.status === "deleted"
  ) {
    throw new Error("A missing file was incorrectly treated as an explicit deletion.");
  }

  // The sections below add many sources; they run last so that they cannot reorder or crowd the
  // projection and editorial manifests the Obsidian checks above rely on.
  // A captured page is processed later from the Library with a knowledge plan, so it must hold
  // canonical Markdown. An article body without html/body tags (Wikipedia's action=render, an
  // element's outerHTML) used to convert to nothing and fail at chunking as "missing_markdown".
  const processing = new JobSupervisor({ getPool: () => pool ?? null });
  const runUntilSettled = async (jobId: string) => {
    let job = await createJobRepository(pool!).findById(jobId);
    for (let attempt = 0; attempt < 20; attempt += 1) {
      await processing.runOnce();
      job = await createJobRepository(pool!).findById(jobId);
      if (job && !["queued", "running"].includes(job.status)) return job;
    }
    throw new Error(
      `Job ${jobId} did not settle: ${JSON.stringify({ status: job?.status, attempts: job?.attempts, error: job?.error, errorHistory: job?.payload.errorHistory })}`
    );
  };
  const processFromLibrary = async (sourceId: string) => {
    const queued = await hierarchy.process({
      plan: ProcessingPlanRequestSchema.parse({
        preset: "search_ready",
        requestedStages: [],
        scope: "source_only",
        targetSourceItemIds: [sourceId]
      }),
      runKind: "initial",
      trigger: "library_action"
    });
    const first = queued.queued[0];
    if (!first?.jobId) throw new Error(`Processing ${sourceId} queued no job.`);
    const job = await runUntilSettled(first.jobId);
    const run = await createIngestionRunRepository(pool!).findById(first.ingestionRunId);
    if (!run) throw new Error("The processing run disappeared.");
    return { job, run };
  };
  const captureWith = async (title: string, content: Record<string, string>) =>
    post(baseUrl, chrome.sessionToken, "/v1/capture/web-page", {
      requestId: randomUUID(),
      url: `https://example.com/${encodeURIComponent(title)}`,
      title,
      capturedAt,
      ...content,
      metadata: { language: "en" }
    });
  const fragmentCapture = await captureWith("Rendered article body", {
    html:
      '<div class="mw-content-ltr mw-parser-output" lang="en"><section><p>The forgetting curve describes how memory retention declines over time without rehearsal.</p>' +
      "<h2>History</h2><p>Hermann Ebbinghaus measured retention of nonsense syllables across several days.</p></section></div>"
  });
  const fragmentSourceId = requiredString(fragmentCapture, "sourceItemId");
  const fragmentDocument = (
    await createDocumentRepository(pool).listBySourceItem(fragmentSourceId)
  )[0];
  if (!fragmentDocument?.canonicalMarkdown.includes("forgetting curve describes how memory")) {
    throw new Error("An HTML fragment capture was not stored as canonical Markdown.");
  }
  const fragmentProcessing = await processFromLibrary(fragmentSourceId);
  if (
    fragmentProcessing.run.status !== "succeeded" ||
    (fragmentProcessing.run.stagesCheckpoint.chunking as { status?: string } | undefined)
      ?.status !== "completed" ||
    (await createChunkRepository(pool).listByDocument(fragmentDocument.id)).length === 0
  ) {
    throw new Error(
      `A captured page did not chunk with a search-ready plan: ${JSON.stringify(fragmentProcessing.run)}`
    );
  }
  // The extension sends the HTML and the visible text: the text is used when Defuddle finds nothing.
  const visibleTextCapture = await captureWith("Application page", {
    html: "<html><body><div id='app'></div></body></html>",
    textContent: "Visible text of an application page that Defuddle cannot read."
  });
  const visibleTextDocument = (
    await createDocumentRepository(pool).listBySourceItem(
      requiredString(visibleTextCapture, "sourceItemId")
    )
  )[0];
  if (!visibleTextDocument?.canonicalMarkdown.includes("Visible text of an application page")) {
    throw new Error("A capture whose HTML was empty did not fall back to the visible text.");
  }
  // A capture without any text is refused, retryable by nobody, and leaves no source behind.
  const sourcesBeforeBlank = await count("source_items");
  const blank = await fetch(`${baseUrl}/v1/capture/web-page`, {
    method: "POST",
    headers: { authorization: `Bearer ${chrome.sessionToken}`, "content-type": "application/json" },
    body: JSON.stringify({
      requestId: randomUUID(),
      url: "https://example.com/blank",
      title: "Blank page",
      capturedAt,
      html: "<html><body><div></div></body></html>",
      metadata: {}
    })
  });
  const blankBody = (await blank.json()) as Record<string, unknown>;
  if (
    blank.status !== 422 ||
    blankBody.messageKey !== "errors.conversion.emptyResult" ||
    blankBody.retryable !== false ||
    (await count("source_items")) !== sourcesBeforeBlank
  ) {
    throw new Error(`A capture without text was not refused cleanly: ${JSON.stringify(blankBody)}`);
  }
  // A library that already holds an empty document (stored before the capture was guarded) fails
  // its processing run with a localized reason, once, instead of an internal "missing_markdown".
  const legacyEmpty = await createSourceItemRepository(pool).create({
    type: "WebArticle",
    title: "Legacy empty capture",
    sourceOrigin: "web_capture",
    language: "en"
  });
  await createDocumentRepository(pool).create({
    sourceItemId: legacyEmpty.id,
    title: legacyEmpty.title,
    canonicalMarkdown: "",
    contentHash: sha256(""),
    language: "en",
    metadata: {}
  });
  const emptyProcessing = await processFromLibrary(legacyEmpty.id);
  if (
    emptyProcessing.run.status !== "failed" ||
    emptyProcessing.run.error !== "errors.conversion.emptyResult" ||
    emptyProcessing.job.status !== "failed" ||
    emptyProcessing.job.attempts !== 1
  ) {
    throw new Error(
      `An empty document did not fail cleanly: ${JSON.stringify([emptyProcessing.run, emptyProcessing.job])}`
    );
  }

  // A file import is held to the standard of a capture. HTML saved from a rendered article body
  // converts to Markdown (it used to convert to nothing), a file without text is refused and stores
  // no source, and empty content never identifies a duplicate: two empty conversions were taken for
  // the same document, so a chapter was rejected as a duplicate of an unrelated article.
  const legacyEmptyImport = await createSourceItemRepository(pool).create({
    type: "StandaloneArticle",
    title: "Legacy empty import",
    sourceOrigin: "file_upload",
    contentHash: sha256(""),
    language: "en"
  });
  if (
    (await createSourceItemRepository(pool).findDuplicate({ contentHash: sha256("") })) !== null ||
    (await createSourceItemRepository(pool).findDuplicate({
      sourceUri: null,
      contentHash: sha256("")
    })) !== null
  ) {
    throw new Error("The hash of empty content was reported as a duplicate.");
  }
  const writeHtml = async (name: string, html: string) => {
    const path = join(workDir, name);
    await writeFile(path, html);
    return path;
  };
  const fragmentFile = (title: string, text: string) =>
    `<div class="mw-content-ltr mw-parser-output" lang="en"><section><p>${text}</p><h2>${title}</h2>` +
    "<p>Retention declines with time unless the memory is rehearsed at spaced intervals.</p></section></div>";
  const importHtml = (
    name: string,
    html: string,
    descriptor: Record<string, unknown> = { type: "StandaloneArticle", title: name }
  ) =>
    writeHtml(`${name}.html`, html).then((path) =>
      ingestion.importFile(path, {
        descriptor: SourceDescriptorSchema.parse({ title: name, ...descriptor }),
        duplicatePolicy: "ignore",
        processingPlan: importOnly
      })
    );
  const articleImport = await importHtml(
    "Memory and Language",
    fragmentFile("Naming", "Memory and language interact when a speaker retrieves a word.")
  );
  const articleDocument = (
    await createDocumentRepository(pool).listBySourceItem(articleImport.sourceItemId)
  )[0];
  if (
    articleImport.duplicate ||
    articleImport.sourceItemId === legacyEmptyImport.id ||
    !articleDocument?.canonicalMarkdown.includes("Memory and language interact")
  ) {
    throw new Error(
      `An HTML fragment file was not stored as Markdown: ${JSON.stringify(articleImport)}`
    );
  }
  const articleProcessing = await processFromLibrary(articleImport.sourceItemId);
  if (
    articleProcessing.run.status !== "succeeded" ||
    (await createChunkRepository(pool).listByDocument(articleDocument.id)).length === 0
  ) {
    throw new Error(
      `An imported HTML fragment did not chunk: ${JSON.stringify(articleProcessing.run)}`
    );
  }
  // Chapters of a book come from the same kind of file and are different sources.
  const book = await ingestion.createContainerSource({
    descriptor: SourceDescriptorSchema.parse({ type: "Book", title: "Phase 4 fragment book" }),
    duplicatePolicy: "ignore"
  });
  const chapterDescriptor = (title: string, chapterNumber: string) => ({
    type: "BookChapter",
    title,
    chapterNumber,
    parentSourceItemId: book.sourceItemId
  });
  const firstChapter = await importHtml(
    "Chapter I",
    fragmentFile("First", "The first chapter describes how the asylum was founded."),
    chapterDescriptor("Chapter I", "I")
  );
  const secondChapter = await importHtml(
    "Chapter II",
    fragmentFile("Second", "The second chapter describes how the patients arrived."),
    chapterDescriptor("Chapter II", "II")
  );
  if (
    firstChapter.duplicate ||
    secondChapter.duplicate ||
    firstChapter.sourceItemId === articleImport.sourceItemId ||
    firstChapter.sourceItemId === secondChapter.sourceItemId
  ) {
    throw new Error("Chapters imported from HTML files were taken for duplicates.");
  }
  // Two different files that convert to nothing are each refused as empty, never as duplicates of
  // each other or of the library's empty rows, and they leave no source or document behind.
  const sourcesBeforeEmpty = await count("source_items");
  const documentsBeforeEmpty = await count("documents");
  for (const [name, html, descriptor] of [
    ["Empty article", "<div class='mw-parser-output'></div>", undefined],
    ["Another empty article", "<div class='mw-parser-output'><span> </span></div>", undefined],
    [
      "Empty chapter",
      "<div class='mw-parser-output'></div>",
      chapterDescriptor("Empty chapter", "III")
    ],
    ["Another empty chapter", "<p>&nbsp;</p>", chapterDescriptor("Another empty chapter", "IV")]
  ] as const) {
    const failure = await importHtml(name, html, descriptor).then(
      () => null,
      (error: unknown) => error
    );
    if (!(failure instanceof Error) || failure.message !== "errors.conversion.emptyResult") {
      throw new Error(`The empty file "${name}" was not refused as empty: ${String(failure)}`);
    }
  }
  if (
    (await count("source_items")) !== sourcesBeforeEmpty ||
    (await count("documents")) !== documentsBeforeEmpty
  ) {
    throw new Error("A file without text left a source or document behind.");
  }

  await processing.stop();

  // Note and source matching are collective stages: the last job of a batch runs them for every
  // run, and the earlier runs park theirs. A run that failed or was canceled for good must neither
  // hold the others behind it (a first sibling that fails) nor leave the parked ones with nobody
  // to run them (a last sibling that fails). The fake knowledge service stands in for the AI.
  const matched = { notes: [] as string[], sources: [] as string[] };
  // Sources whose note generation fails once (a transient provider error) or whose note matching
  // always fails, and the source each generated note belongs to.
  const generationFailsOnce = new Set<string>();
  const matchingFails = new Set<string>();
  const noteSource = new Map<string, string>();
  const knowledge = {
    isHierarchicalRoot: async () => false,
    summarizeSource: async () => ({ configured: true, generated: false }),
    summarizeHierarchiesForBatch: async () => ({ generatedCount: 0 }),
    generateKnowledgeGraph: async () => ({ configured: true, generated: false }),
    generateAtomicNotes: async (sourceItemId: string, documentId: string) => {
      if (generationFailsOnce.delete(sourceItemId))
        throw new AiProviderError("provider_unavailable", {
          kind: "http",
          transient: true,
          status: 503
        });
      const [chunk] = await createChunkRepository(pool!).listByDocument(documentId);
      if (!chunk) throw new Error("The chunking stage left no chunk.");
      const note = await createAtomicNoteRepository(pool!).upsertGenerated({
        title: "Note",
        bodyMarkdown: "A fact.",
        ideaStatement: "A fact.",
        sourceItemId,
        evidenceChunkId: chunk.id,
        evidenceLinks: [{ chunkId: chunk.id }],
        generationProvider: "verify",
        generationModel: "verify",
        generationRuntime: "local",
        generationPromptVersion: "verify",
        generationKey: "verify"
      });
      noteSource.set(note.id, sourceItemId);
      return { configured: true, generatedCount: 1, noteIds: [note.id] };
    },
    matchAtomicNotes: async (noteIds: string[]) => {
      if (noteIds.some((id) => matchingFails.has(noteSource.get(id) ?? "")))
        throw new Error("matching_failed");
      matched.notes.push(...noteIds);
      return { persistedCount: 0 };
    },
    matchSourceRelations: async (sourceIds: string[]) => {
      matched.sources.push(...sourceIds);
      return { persistedCount: 0 };
    }
  };
  const matching = new JobSupervisor({
    getPool: () => pool ?? null,
    knowledgeService: knowledge as unknown as KnowledgeService
  });
  const matchingStages = [
    "chunking",
    "embedding",
    "summarization",
    "atomicNotes",
    "knowledgeGraph",
    "atomicNoteMatching",
    "sourceMatching"
  ] as const;
  const newSource = async (title: string, content: string) => {
    const sourceId = (
      await ingestion.createManual({
        descriptor: SourceDescriptorSchema.parse({ type: "PersonalNote", title }),
        content: content || "placeholder",
        duplicatePolicy: "ignore",
        processingPlan: importOnly
      })
    ).sourceItemId;
    // An empty document is what an earlier version stored for a page it could not convert.
    if (!content)
      await pool!.query(
        `update documents set canonical_markdown = '', content_hash = $2 where source_item_id = $1`,
        [sourceId, sha256("")]
      );
    return sourceId;
  };
  const queueBatch = async (sourceIds: string[]) => {
    const batch = await hierarchy.process({
      plan: ProcessingPlanRequestSchema.parse({
        preset: "custom",
        requestedStages: [...matchingStages],
        scope: "source_only",
        targetSourceItemIds: sourceIds
      }),
      runKind: "initial",
      trigger: "library_action"
    });
    return batch.queued.map((item) => ({
      sourceItemId: item.sourceItemId,
      runId: item.ingestionRunId,
      jobId: item.jobId!
    }));
  };
  const stageStatus = async (runId: string, stage: string) =>
    (
      await pool!.query<{ status: string }>(
        `select status::text from ingestion_run_stages where ingestion_run_id = $1 and stage = $2`,
        [runId, stage]
      )
    ).rows[0]?.status;
  const jobStatus = async (jobId: string) =>
    (await createJobRepository(pool!).findById(jobId))?.status;
  const drainBatch = async (queued: Array<{ jobId: string }>) => {
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const statuses = await Promise.all(queued.map((item) => jobStatus(item.jobId)));
      if (statuses.every((status) => status !== "queued" && status !== "running")) return;
      await matching.runOnce();
    }
    throw new Error("The batch jobs did not settle.");
  };
  const expectMatched = async (
    healthy: Array<{ sourceItemId: string; runId: string }>,
    context: string
  ) => {
    for (const item of healthy) {
      const statuses = [
        await stageStatus(item.runId, "atomicNoteMatching"),
        await stageStatus(item.runId, "sourceMatching")
      ];
      if (statuses.join() !== "completed,completed" || !matched.sources.includes(item.sourceItemId))
        throw new Error(`${context}: matching of ${item.sourceItemId} was ${statuses.join()}.`);
    }
    const notes = await createAtomicNoteRepository(pool!).listBySourceItem(
      healthy[0]!.sourceItemId
    );
    if (!notes.every((note) => matched.notes.includes(note.id)) || notes.length === 0)
      throw new Error(`${context}: the notes of a healthy source were not matched.`);
  };

  // A sibling that fails first: its pending stages must not hold the others.
  matched.notes.length = matched.sources.length = 0;
  const firstFails = await queueBatch([
    await newSource("Matching A", ""),
    await newSource("Matching B", "Matching batch B holds its own fact."),
    await newSource("Matching C", "Matching batch C holds its own fact.")
  ]);
  const [failedFirst, ...healthyFirst] = firstFails;
  await drainBatch(firstFails);
  if (
    (await createIngestionRunRepository(pool).findById(failedFirst!.runId))?.status !== "failed" ||
    matched.sources.includes(failedFirst!.sourceItemId)
  ) {
    throw new Error("The failed sibling was matched or did not fail.");
  }
  await expectMatched(healthyFirst, "A sibling that failed first");

  // A sibling that fails last: the others park, then the failure releases them.
  matched.notes.length = matched.sources.length = 0;
  const lastFails = await queueBatch([
    await newSource("Matching D", "Matching batch D holds its own fact."),
    await newSource("Matching E", "Matching batch E holds its own fact."),
    await newSource("Matching F", "")
  ]);
  const [parkedD, parkedE, failedLast] = lastFails;
  await matching.runOnce();
  await matching.runOnce();
  if (
    (await stageStatus(parkedD!.runId, "atomicNoteMatching")) !== "waiting_for_review" ||
    (await stageStatus(parkedE!.runId, "atomicNoteMatching")) !== "waiting_for_review" ||
    matched.sources.length !== 0
  ) {
    throw new Error("The runs did not park their matching behind the pending sibling.");
  }
  await matching.runOnce();
  if ((await jobStatus(failedLast!.jobId)) !== "failed") {
    throw new Error("The last sibling did not fail.");
  }
  await drainBatch(lastFails);
  await expectMatched([parkedD!, parkedE!], "A sibling that failed last");

  // A sibling whose job was canceled before it ran leaves its run pending: it is out as well.
  matched.notes.length = matched.sources.length = 0;
  const canceledSibling = await queueBatch([
    await newSource("Matching G", "Matching batch G holds its own fact."),
    await newSource("Matching H", "Matching batch H holds its own fact."),
    await newSource("Matching I", "Matching batch I holds its own fact.")
  ]);
  await matching.requestCancel(canceledSibling[0]!.jobId);
  await drainBatch(canceledSibling);
  await expectMatched(canceledSibling.slice(1), "A canceled sibling");

  // A sibling whose own note matching fails is isolated: it neither stops the others' note
  // matching nor, being settled, their source matching.
  matched.notes.length = matched.sources.length = 0;
  const matchingFailure = await queueBatch([
    await newSource("Matching J", "Matching batch J holds its own fact."),
    await newSource("Matching K", "Matching batch K holds its own fact."),
    await newSource("Matching L", "Matching batch L holds its own fact.")
  ]);
  matchingFails.add(matchingFailure[0]!.sourceItemId);
  await drainBatch(matchingFailure);
  matchingFails.clear();
  if ((await stageStatus(matchingFailure[0]!.runId, "atomicNoteMatching")) !== "failed") {
    throw new Error("The note matching failure of one sibling was not recorded on its run.");
  }
  await expectMatched(matchingFailure.slice(1), "A sibling whose matching failed");

  // A sibling that fails transiently is coming back: the others still wait for its retry, and the
  // matching then covers all of them together.
  matched.notes.length = matched.sources.length = 0;
  const retrying = await queueBatch([
    await newSource("Matching M", "Matching batch M holds its own fact."),
    await newSource("Matching N", "Matching batch N holds its own fact."),
    await newSource("Matching O", "Matching batch O holds its own fact.")
  ]);
  generationFailsOnce.add(retrying[0]!.sourceItemId);
  for (let step = 0; step < 3; step += 1) await matching.runOnce();
  const retryingStatus = [
    await jobStatus(retrying[0]!.jobId),
    await stageStatus(retrying[1]!.runId, "atomicNoteMatching"),
    await stageStatus(retrying[2]!.runId, "atomicNoteMatching")
  ].join();
  if (retryingStatus !== "queued,waiting_for_review,waiting_for_review" || matched.sources.length) {
    throw new Error(`The siblings did not wait for the retry: ${retryingStatus}.`);
  }
  await pool.query(`update jobs set run_after = now() where id = $1`, [retrying[0]!.jobId]);
  await drainBatch(retrying);
  await expectMatched(retrying, "A sibling that is retried");
  await matching.stop();

  // Notes are embedded when they are created, and a generative decider judges each unordered pair
  // once. Real database, retrieval, scoring and decision storage; only the model calls are fakes.
  // Before this, a note was embedded only when it was matched: an earlier note never saw the notes
  // that came after it, and each of those pairs was lost.
  const pairAi = createAiConfigRepository(pool);
  const pairProvider = await pairAi.upsertProvider({
    provider: "openai-compatible",
    displayName: "Pair decider",
    baseUrl: "http://127.0.0.1:9/v1",
    metadata: { modelId: "pair-decider", capabilities: ["text-generation", "structured-output"] }
  });
  const pairProfile = await pairAi.createProfile({ name: "Pair decider", isDefault: true });
  await pairAi.updateProfile({
    id: pairProfile.id,
    providerConfigId: pairProvider.id,
    modelId: "pair-decider",
    runtime: "remote",
    capabilities: ["text-generation", "structured-output"]
  });
  await pairAi.seedTaskRoute("reranking", pairProfile.id);
  // The notes of the sections above are not part of this check.
  await pool.query("update atomic_notes set status = 'rejected'");
  const pairCalls = { embedding: [] as string[], generation: 0, rerankAliases: [] as number[] };
  const pairAiService = {
    runDefaultTask: async (
      task: string,
      input: string,
      context: { operation?: string } = {}
    ): Promise<Record<string, unknown> | null> => {
      const execution = {
        providerId: "fake",
        modelId: task === "embedding" ? "fake-embedding" : "pair-decider",
        runtime: task === "embedding" ? "local" : "remote",
        profileId: pairProfile.id
      };
      if (task === "embedding") {
        pairCalls.embedding.push(context.operation ?? "");
        // Every note is about the same topic, so they all sit close together in vector space.
        const vector = Array.from({ length: 256 }, (_, index) => (index < 8 ? 1 : 0.01));
        return { ...execution, output: vector, embeddingSpaceKey: "pair-space", aiTaskRunId: "x" };
      }
      const aiTaskRunId = await pairAi.recordTaskRun({
        profileId: pairProfile.id,
        taskType: task,
        provider: "fake",
        modelId: "pair-decider",
        runtime: "remote",
        durationMs: 1_500,
        status: "succeeded"
      });
      if (task === "atomic-note-generation") {
        pairCalls.generation += 1;
        const chunkId = input.match(/\[([0-9a-f-]{36})\]/u)?.[1];
        const count = input.includes("Pair source one") ? 2 : 1;
        return {
          ...execution,
          aiTaskRunId,
          outputLanguage: "en",
          output: {
            notes: Array.from({ length: count }, (_, index) => ({
              title: `Retrieval practice ${pairCalls.generation}.${index}`,
              ideaStatement: `Retrieval practice strengthens memory retention ${pairCalls.generation}.${index}.`,
              bodyMarkdown: `Retrieval practice strengthens memory retention, variant ${index}.`,
              evidenceChunkIds: [chunkId]
            }))
          }
        };
      }
      const aliases = [...input.matchAll(/^\[(\d+)\]$/gmu)].map((match) => Number(match[1]));
      pairCalls.rerankAliases.push(aliases.length);
      return {
        ...execution,
        aiTaskRunId,
        // The decide-only contract: one [number, score 0-100, type] item per candidate.
        output: { results: aliases.map((alias) => [alias, 90, "supports"]) }
      };
    }
  };
  const pairKnowledge = new KnowledgeService({
    getPool: () => pool ?? null,
    aiService: pairAiService as unknown as AiService,
    userDataPath: workDir,
    getStorageSettings: settings as never,
    getUploadedFilesBasePath: async () => null,
    getAtomicNoteMatchingSettings: async () =>
      AtomicNoteMatchingSettingsSchema.parse({ graphCandidateLimit: 0 })
  });
  const pairSources: Array<{ sourceId: string; documentId: string }> = [];
  for (const title of ["Pair source one", "Pair source two"]) {
    const sourceId = await newSource(title, `${title} explains how retrieval practice works.`);
    const document = (
      await pool.query<{ id: string; canonical_markdown: string }>(
        `select id, canonical_markdown from documents where source_item_id = $1`,
        [sourceId]
      )
    ).rows[0]!;
    await indexDocument(pool, document.id, sourceId, document.canonical_markdown);
    pairSources.push({ sourceId, documentId: document.id });
  }
  const generatedPair = [];
  for (const { sourceId, documentId } of pairSources)
    generatedPair.push(await pairKnowledge.generateAtomicNotes(sourceId, documentId));
  const pairNoteIds = generatedPair.flatMap((result) => result.noteIds);
  if (pairNoteIds.length !== 3 || generatedPair.some((r) => !("embeddedCount" in r)))
    throw new Error("The pair sources did not generate three notes.");
  // Every note has its vector the moment it exists: one embedding call each, none for matching.
  const storedVectors = await pool.query<{ target_id: string; content_hash: string }>(
    `select target_id, content_hash from embeddings_256
     where target_type = 'atomic_note' and target_id = any($1::uuid[])`,
    [pairNoteIds]
  );
  if (
    storedVectors.rows.length !== 3 ||
    pairCalls.embedding.length !== 3 ||
    pairCalls.embedding.some((operation) => operation !== "note_creation_embedding") ||
    storedVectors.rows.some((row) => !/^[0-9a-f]{64}$/u.test(row.content_hash))
  )
    throw new Error(`The notes were not embedded when created: ${pairCalls.embedding.join()}.`);

  // The earlier notes are matched first, and still find the note of the later source.
  const [firstOfOne, secondOfOne, onlyOfTwo] = pairNoteIds as [string, string, string];
  await pairKnowledge.matchAtomicNotes([firstOfOne, secondOfOne]);
  if (pairCalls.embedding.length !== 3)
    throw new Error("Matching embedded notes that were embedded when created.");
  const decided = async () =>
    (
      await pool!.query<{ lo: string; hi: string; both: boolean }>(
        `select lo_atomic_note_id as lo, hi_atomic_note_id as hi,
           (lo_to_hi_score is not null and hi_to_lo_score is not null) as both
         from relation_decisions`
      )
    ).rows;
  const afterEarlier = await decided();
  if (!afterEarlier.some((row) => [row.lo, row.hi].includes(onlyOfTwo)))
    throw new Error("An earlier note did not retrieve and judge the later note.");
  // The later note is then matched: the pairs it shares with the earlier notes are already judged.
  const rerankCallsBefore = pairCalls.rerankAliases.length;
  await pairKnowledge.matchAtomicNotes([onlyOfTwo]);
  if (pairCalls.rerankAliases.length !== rerankCallsBefore)
    throw new Error("The later note asked the decider again about pairs it had already judged.");
  const afterAll = await decided();
  if (
    afterAll.length !== 3 ||
    afterAll.some((row) => row.both) ||
    pairCalls.rerankAliases.reduce((total, count) => total + count, 0) !== 3
  )
    throw new Error(
      `Three notes make three pairs and one judgment each: ${JSON.stringify(afterAll)} ${pairCalls.rerankAliases.join()}.`
    );
  const pairRelations = await pool.query<{
    source: string;
    target: string;
    sem: string | null;
    type: string | null;
  }>(
    `select source_atomic_note_id as source, target_atomic_note_id as target, relation_type as type,
       (case direction when 'lo_to_hi' then source_atomic_note_id
                       when 'hi_to_lo' then target_atomic_note_id end)::text as sem
       from atomic_note_relations
     where source_atomic_note_id = any($1::uuid[]) and target_atomic_note_id = any($1::uuid[])`,
    [pairNoteIds]
  );
  // Each pair was judged when its earlier note was matched, and keeps that direction (the stored
  // `direction` of relations v2; a symmetric type reads both ways).
  if (
    pairRelations.rows.length !== 3 ||
    pairRelations.rows.some(
      (row) => row.sem === onlyOfTwo || (row.sem === null && !isSymmetricNoteRelationType(row.type))
    )
  )
    throw new Error("The judged pairs did not become relations with their semantic direction.");
  // An AI run is written when the call ends: its start is the end minus its duration.
  const runTimes = await pool.query<{ total: number; wrong: number }>(
    `select count(*)::int as total,
       count(*) filter (where abs(extract(epoch from finished_at - started_at) * 1000 - duration_ms) > 1
         or started_at >= finished_at)::int as wrong
     from ai_task_runs where task_type = 'reranking' and provider = 'fake'`
  );
  if (runTimes.rows[0]!.total < 1 || runTimes.rows[0]!.wrong !== 0)
    throw new Error("An AI task run did not start before it finished.");
  // A stored vector is found by the hash of the note's current text, with the space it lives in;
  // a candidate without a vector in that space is told apart from a dissimilar one.
  const firstVector = await createEmbeddingRepository(pool).findCurrentNoteVectors([
    {
      id: firstOfOne,
      contentHash: storedVectors.rows.find((r) => r.target_id === firstOfOne)!.content_hash
    },
    { id: secondOfOne, contentHash: "text-that-changed" }
  ]);
  if (
    [...firstVector.keys()].join() !== firstOfOne ||
    firstVector.get(firstOfOne)!.strategy !== "native-v2:pair-space" ||
    firstVector.get(firstOfOne)!.model !== "fake-embedding"
  )
    throw new Error("The stored vector was not found by the hash of the current text.");
  const queryVector = firstVector.get(firstOfOne)!.embedding;
  const scoredIn = async (space: string) =>
    (
      await createAtomicNoteRepository(pool!).scoreMatchingCandidates({
        noteId: firstOfOne,
        candidateIds: [secondOfOne],
        embedding: queryVector,
        embeddingModel: "fake-embedding",
        embeddingSpaceKey: space,
        embeddingProvider: "fake",
        embeddingRuntime: "local"
      })
    )[0]!;
  const inSpace = await scoredIn("pair-space");
  const elsewhere = await scoredIn("another-space");
  if (
    !inSpace.hasVector ||
    inSpace.vectorScore < 0.99 ||
    elsewhere.hasVector ||
    elsewhere.vectorScore !== 0
  )
    throw new Error("A candidate without a vector was not told apart from a dissimilar one.");

  // objects.locate answers from the same database: a note hangs from its source, which keeps its
  // own place; an anchored address locates the object it names; a missing object locates nothing.
  const objects = new ObjectsService(() => pool);
  const locatedNote = await objects.locate({ address: `memora://note/${firstOfOne}` });
  const notePath = locatedNote?.primaryPath ?? [];
  const owningSource = notePath.at(-2);
  if (
    !locatedNote ||
    notePath.at(-1)?.id !== firstOfOne ||
    !owningSource ||
    notePath.slice(0, -1).some((item) => item.kind !== "source") ||
    locatedNote.counts.passages < 1
  )
    throw new Error(
      `objects.locate did not place the note under its source: ${JSON.stringify(locatedNote)}.`
    );
  const anchoredId = randomUUID();
  const locatedSource = await objects.locate({
    address: `memora://source/${owningSource.id}#passage=${anchoredId}`
  });
  if (
    !locatedSource ||
    locatedSource.object.id !== owningSource.id ||
    locatedSource.primaryPath.at(-1)?.id !== owningSource.id ||
    locatedSource.counts.notes < 1 ||
    locatedSource.counts.passages < 1
  )
    throw new Error(`objects.locate did not locate the source: ${JSON.stringify(locatedSource)}.`);
  if (
    (await objects.locate({ address: `memora://source/${randomUUID()}` })) !== null ||
    (await objects.locate({ address: `memora://note/${randomUUID()}` })) !== null
  )
    throw new Error("objects.locate invented an object that does not exist.");

  console.info(
    JSON.stringify(
      {
        gateway: baseUrl,
        deduplicatedWebSource: webSourceId,
        youtubeSource: youtubeSourceId,
        importedObsidianSource: importedSourceId,
        projectedFiles: (await syncRepository.list()).length,
        layoutVersion: layout.version,
        webPath: webSync.relativePath,
        editorialEdit: accepted.status,
        explicitConflict: conflict.status,
        stablePath: movedRecord.relativePath,
        inferredDeletions: afterDelete.deleted,
        searchEvidence: search[0]?.excerpt
      },
      null,
      2
    )
  );
} finally {
  await gateway?.stop().catch(() => undefined);
  await jobs?.stop().catch(() => undefined);
  await obsidian?.shutdown().catch(() => undefined);
  if (pool) await closePgPool(pool);
  await manager.stop().catch(() => undefined);
  await rm(workDir, { recursive: true, force: true });
}

async function handshake(
  baseUrl: string,
  pairing: { clientId: string; token: string },
  kind: "chrome-extension" | "obsidian-plugin",
  capabilities: string[]
): Promise<IntegrationHandshakeResponse> {
  const response = await fetch(`${baseUrl}/v1/handshake`, {
    method: "POST",
    headers: { authorization: `Bearer ${pairing.token}`, "content-type": "application/json" },
    body: JSON.stringify({
      contractVersion: integrationContractVersion,
      clientId: pairing.clientId,
      client: { kind, name: `E2E ${kind}`, contractVersion: integrationContractVersion },
      capabilities
    })
  });
  if (!response.ok) throw new Error(`Handshake failed: ${response.status}`);
  return integrationHandshakeResponseSchema.parse(await response.json());
}

async function post(
  baseUrl: string,
  token: string,
  path: string,
  body: unknown
): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const result = (await response.json()) as Record<string, unknown>;
  if (!response.ok) throw new Error(`${path} failed: ${response.status} ${JSON.stringify(result)}`);
  return result;
}

async function indexDocument(
  db: PgPool,
  documentId: string,
  sourceItemId: string,
  markdown: string
): Promise<void> {
  const sourceSpanId = randomUUID();
  await createChunkRepository(db).replaceDocumentChunks(documentId, sourceItemId, [
    {
      id: randomUUID(),
      sourceSpanId,
      chunkIndex: 0,
      content: markdown,
      tokenCount: markdown.split(/\s+/).length,
      contentHash: sha256(markdown),
      span: { id: sourceSpanId, startOffset: 0, endOffset: markdown.length }
    }
  ]);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing ${key}.`);
  return value;
}
