import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closePgPool,
  createChunkRepository,
  createDocumentRepository,
  createJobRepository,
  createObsidianSyncRepository,
  createPgPool,
  createSearchRepository,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "@app/db";
import { sha256 } from "@app/conversion";
import {
  integrationContractVersion,
  integrationHandshakeResponseSchema,
  type IntegrationHandshakeResponse
} from "@app/integration-contracts";

import { IngestionService } from "./ingestion-service.js";
import { IntegrationGateway } from "./integration-gateway.js";
import { JobSupervisor } from "./job-supervisor.js";
import { parseManagedMarkdown } from "./obsidian-projection.js";
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
    youtubeService: new YouTubeService(async () => ({
      basic_info: { title: "Phase 4 video", author: "Memora channel" },
      getTranscript: async () => ({ transcript: { segments: [
        { start_ms: 0, snippet: { text: "External capture keeps traceable knowledge." } }
      ] } })
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
  if (!gatewayStatus.baseUrl) throw new Error("Gateway did not start.");

  const chromePairing = await gateway.createPairing({ clientType: "chrome-extension", displayName: "E2E Chrome" });
  const chrome = await handshake(gatewayStatus.baseUrl, chromePairing, "chrome-extension", [
    "capture-web-page", "capture-selection", "capture-youtube-video", "receive-job-progress"
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
  const firstCapture = await post(gatewayStatus.baseUrl, chrome.sessionToken, "/v1/capture/web-page", webPayload);
  const repeatedCapture = await post(gatewayStatus.baseUrl, chrome.sessionToken, "/v1/capture/web-page", {
    ...webPayload,
    requestId: randomUUID()
  });
  const webSourceId = requiredString(firstCapture, "sourceItemId");
  if (webSourceId !== requiredString(repeatedCapture, "sourceItemId") || repeatedCapture.duplicate !== true) {
    throw new Error("Repeated web capture was not deduplicated.");
  }
  const youtubeCapture = await post(gatewayStatus.baseUrl, chrome.sessionToken, "/v1/capture/youtube", {
    requestId: randomUUID(),
    url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
    videoId: "dQw4w9WgXcQ",
    title: "Visible title",
    capturedAt,
    visibleMetadata: {}
  });
  await post(gatewayStatus.baseUrl, chrome.sessionToken, "/v1/capture/selection", {
    requestId: randomUUID(),
    url: "https://example.com/phase-4",
    title: "Phase 4 selection",
    capturedAt,
    selection: "A selected external idea.",
    metadata: {}
  });
  const youtubeSourceId = requiredString(youtubeCapture, "sourceItemId");
  await obsidian.projectSource(webSourceId);
  await obsidian.projectSource(youtubeSourceId);

  const syncRepository = createObsidianSyncRepository(pool);
  const webSync = await syncRepository.findByMemoraId(webSourceId);
  const videoSync = await syncRepository.findByMemoraId(youtubeSourceId);
  if (!webSync || !videoSync) throw new Error("Captured sources were not projected to Obsidian.");
  const webPath = join(vaultPath, webSync.relativePath);
  const projected = parseManagedMarkdown(await readFile(webPath, "utf8"));
  if (!projected) throw new Error("Projected web frontmatter was invalid.");

  const offlineBody = "# Phase 4 article\n\nOffline Obsidian edit is searchable evidence.";
  await writeFile(webPath, (await readFile(webPath, "utf8")).replace(projected.bodyMarkdown, offlineBody));
  const reconcileEdit = await obsidian.reconcileVault();
  if (reconcileEdit.synced < 1) throw new Error("Offline Obsidian edit was not reconciled.");
  const webDocument = await createDocumentRepository(pool).findById(webSync.documentId!);
  if (!webDocument?.canonicalMarkdown.includes("Offline Obsidian edit")) {
    throw new Error("Obsidian edit did not update canonical Markdown.");
  }
  await indexDocument(pool, webDocument.id, webDocument.sourceItemId, webDocument.canonicalMarkdown);
  const search = await createSearchRepository(pool).search({ text: "offline obsidian edit", limit: 5 });
  if (search[0]?.sourceItemId !== webSourceId) throw new Error("Search did not reflect the Obsidian edit.");

  const movedPath = join(dirname(webPath), "phase-4-article-moved.md");
  await rename(webPath, movedPath);
  await obsidian.reconcileVault();
  const movedRecord = await syncRepository.findByMemoraId(webSourceId);
  if (!movedRecord?.relativePath.endsWith("phase-4-article-moved.md")) {
    throw new Error("Offline Obsidian move was not reconciled.");
  }

  const obsidianPairing = await gateway.createPairing({ clientType: "obsidian-plugin", displayName: "E2E Obsidian" });
  const obsidianClient = await handshake(gatewayStatus.baseUrl, obsidianPairing, "obsidian-plugin", [
    "import-obsidian-note", "watch-obsidian-files", "reconcile-obsidian-vault", "receive-job-progress"
  ]);
  const videoRaw = await readFile(join(vaultPath, videoSync.relativePath), "utf8");
  const videoManaged = parseManagedMarkdown(videoRaw);
  if (!videoManaged) throw new Error("Projected video frontmatter was invalid.");
  const conflictBody = `${videoManaged.bodyMarkdown}\n\nConflicting edit.`;
  const conflict = await post(gatewayStatus.baseUrl, obsidianClient.sessionToken, "/v1/obsidian/file-changed", {
    eventId: randomUUID(),
    kind: "modified",
    occurredAt: new Date().toISOString(),
    note: {
      requestId: randomUUID(),
      relativePath: videoSync.relativePath,
      markdown: conflictBody,
      frontmatter: { ...videoManaged.frontmatter, memoraSyncVersion: videoManaged.frontmatter.memoraSyncVersion + 1 },
      contentHash: sha256(`${conflictBody.trim()}\n`),
      mtimeMs: Math.trunc((await stat(join(vaultPath, videoSync.relativePath))).mtimeMs)
    }
  });
  if (conflict.syncStatus !== "conflict") throw new Error("Version conflict was not explicit.");

  await unlink(movedPath);
  const reconcileDelete = await obsidian.reconcileVault();
  if (reconcileDelete.deleted < 1 || (await syncRepository.findByMemoraId(webSourceId))?.status !== "deleted") {
    throw new Error("Offline Obsidian delete did not create a tombstone.");
  }
  const queuedAfterEdit = (await createJobRepository(pool).list()).some((job) =>
    job.type === "ingestion" && job.payload.sourceItemId === webSourceId
  );
  if (!queuedAfterEdit) throw new Error("Obsidian edit did not queue reprocessing.");

  console.info(JSON.stringify({
    gateway: gatewayStatus.baseUrl,
    deduplicatedWebSource: webSourceId,
    youtubeSource: youtubeSourceId,
    projectedFiles: (await syncRepository.list()).length,
    offlineEditReconciled: reconcileEdit.synced,
    movedPath: movedRecord.relativePath,
    explicitConflict: conflict.syncStatus,
    tombstones: reconcileDelete.deleted,
    searchEvidence: search[0]?.excerpt
  }, null, 2));
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

async function post(baseUrl: string, token: string, path: string, body: unknown): Promise<Record<string, unknown>> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  const result = await response.json() as Record<string, unknown>;
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
  await createChunkRepository(db).replaceDocumentChunks(documentId, sourceItemId, [{
    id: randomUUID(),
    sourceSpanId,
    chunkIndex: 0,
    content: markdown,
    tokenCount: markdown.split(/\s+/).length,
    contentHash: sha256(markdown),
    span: { id: sourceSpanId, startOffset: 0, endOffset: markdown.length }
  }]);
}

function requiredString(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== "string" || value.length === 0) throw new Error(`Missing ${key}.`);
  return value;
}
