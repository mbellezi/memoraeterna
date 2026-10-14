import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closePgPool,
  createChunkRepository,
  createDocumentRepository,
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
import { sha256 } from "@app/conversion";
import { processingPresetStages } from "@app/domain";
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

import { IngestionService } from "./ingestion-service.js";
import { IntegrationGateway } from "./integration-gateway.js";
import { JobSupervisor } from "./job-supervisor.js";
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
  const projectVault = async () => {
    const jobId = await obsidian!.wiki.enqueue(true);
    const job = jobId ? await jobsRepository.findById(jobId) : null;
    if (!jobId || !job) throw new Error("Projection job was not queued.");
    await jobsRepository.update(jobId, { status: "running" });
    const result = await obsidian!.wiki.execute(job);
    await jobsRepository.update(jobId, { status: "succeeded", result });
    return result;
  };
  const countIngestionJobs = async () =>
    (await jobsRepository.list()).filter((job) => job.type === "ingestion").length;
  const ingestionJobsBeforeProjection = await countIngestionJobs();
  const projection = await projectVault();
  if (projection.conflicts !== 0 || projection.projected < 3) {
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
