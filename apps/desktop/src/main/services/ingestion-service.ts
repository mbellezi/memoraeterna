import { existsSync } from "node:fs";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import {
  createBibliographicRepository,
  createDocumentAssetRepository,
  createDocumentRepository,
  createIngestionRunRepository,
  createJobRepository,
  createSourceItemRepository,
  type PgPool
} from "@app/db";
import {
  ConversionRouter,
  DoclingClient,
  createTextBlocks,
  normalizeMarkdown,
  sha256,
  type MarkdownConversionResult
} from "@app/conversion";
import type {
  FileImportInput,
  IngestionResult,
  ManualIngestionInput,
  StorageSettings
} from "../../shared/ipc.js";

import { AssetStorageService } from "./asset-storage-service.js";

export interface IngestionServiceOptions {
  getPool: () => PgPool | null;
  getStorageSettings: () => Promise<StorageSettings>;
  userDataPath: string;
  resourcesPath: string;
  workspaceRoot: string;
  isPackaged: boolean;
}

export class IngestionService {
  private readonly assetStorage = new AssetStorageService();
  private readonly router: ConversionRouter;

  public constructor(private readonly options: IngestionServiceOptions) {
    const docling = resolveDoclingRuntime(options);
    this.router = new ConversionRouter({
      ...(docling ? { doclingClient: new DoclingClient(docling) } : {}),
      materializeForDocling: async (input) => {
        const directory = join(options.userDataPath, "tmp", "conversion");
        await mkdir(directory, { recursive: true });
        const path = join(directory, `${randomUUID()}${extname(input.fileName ?? "")}`);
        await writeFile(path, input.data, { mode: 0o600 });
        return { path, cleanup: () => rm(path, { force: true }) };
      }
    });
  }

  public async createManual(input: ManualIngestionInput): Promise<IngestionResult> {
    const markdown = normalizeMarkdown(input.content);
    const conversion: MarkdownConversionResult = {
      status: "converted",
      markdown,
      contentHash: sha256(markdown),
      blocks: createTextBlocks(markdown),
      assets: [],
      engine: "manual",
      engineVersion: "1",
      profile: "standard",
      options: {}, warnings: [], quality: { textCoverage: 1 }, metadata: {}
    };
    return this.persist({
      sourceType: input.sourceType,
      title: input.title,
      sourceOrigin: "manual",
      sourceUri: input.originalUri ?? null,
      language: input.language,
      duplicatePolicy: input.duplicatePolicy,
      parentSourceItemId: input.parentSourceItemId ?? null,
      metadata: input.metadata,
      bibliographic: input.bibliographic,
      conversion
    });
  }

  public async importFile(path: string, input: FileImportInput): Promise<IngestionResult> {
    const data = await readFile(path);
    const fileName = basename(path);
    const mimeType = detectMimeType(fileName, data);
    const conversion = await this.router.convert({ data, fileName, mimeType, profile: "standard" });
    return this.persist({
      sourceType: input.sourceType,
      title: fileName.replace(/\.[^.]+$/, ""),
      sourceOrigin: "file_upload",
      sourceUri: null,
      language: "und",
      duplicatePolicy: input.duplicatePolicy,
      metadata: { originalFileName: fileName, mimeType },
      conversion,
      originalAsset: { data, fileName, mimeType }
    });
  }

  public async lookupSources(query: string) {
    return (await createSourceItemRepository(this.requirePool()).lookup(query, 10)).map((source) => ({
      id: source.id,
      title: source.title,
      type: source.type
    }));
  }

  private async persist(input: {
    sourceType: ManualIngestionInput["sourceType"];
    title: string;
    sourceOrigin: string;
    sourceUri: string | null;
    language: string;
    duplicatePolicy: ManualIngestionInput["duplicatePolicy"];
    parentSourceItemId?: string | null;
    metadata: Record<string, unknown>;
    bibliographic?: ManualIngestionInput["bibliographic"];
    conversion: MarkdownConversionResult;
    originalAsset?: { data: Uint8Array; fileName: string; mimeType: string };
  }): Promise<IngestionResult> {
    const pool = this.requirePool();
    const sources = createSourceItemRepository(pool);
    const documents = createDocumentRepository(pool);
    const runs = createIngestionRunRepository(pool);
    const jobs = createJobRepository(pool);
    const duplicate = await sources.findDuplicate({ sourceUri: input.sourceUri, contentHash: input.conversion.contentHash });
    if (duplicate && input.duplicatePolicy === "ignore") {
      const existingDocuments = await documents.listBySourceItem(duplicate.id);
      const existingRuns = await runs.listBySourceItem(duplicate.id);
      const document = existingDocuments[0];
      const run = existingRuns[0];
      if (document && run?.jobId) {
        return { sourceItemId: duplicate.id, documentId: document.id, ingestionRunId: run.id, jobId: run.jobId, duplicate: true };
      }
    }

    let sourceItem = duplicate && input.duplicatePolicy === "update"
      ? await sources.update(duplicate.id, {
          type: input.sourceType, title: input.title, sourceUri: input.sourceUri,
          parentSourceItemId: input.parentSourceItemId ?? null,
          contentHash: input.conversion.contentHash, language: input.language, metadata: input.metadata
        })
      : await sources.create({
          type: input.sourceType, title: input.title, sourceOrigin: input.sourceOrigin,
          sourceUri: input.sourceUri, contentHash: input.conversion.contentHash,
          parentSourceItemId: input.parentSourceItemId ?? null,
          language: input.language, metadata: input.metadata
        });
    sourceItem ??= duplicate;
    if (!sourceItem) throw new Error("Source item persistence failed.");

    const existingDocuments = duplicate && input.duplicatePolicy === "update"
      ? await documents.listBySourceItem(sourceItem.id)
      : [];
    const document = existingDocuments[0]
      ? await documents.update(existingDocuments[0].id, {
          title: input.title,
          canonicalMarkdown: input.conversion.markdown,
          contentHash: input.conversion.contentHash,
          language: input.language,
          metadata: conversionMetadata(input.conversion)
        })
      : await documents.create({
          sourceItemId: sourceItem.id,
          title: input.title,
          canonicalMarkdown: input.conversion.markdown,
          contentHash: input.conversion.contentHash,
          language: input.language,
          metadata: conversionMetadata(input.conversion)
        });
    if (!document) throw new Error("Document persistence failed.");

    if (input.bibliographic) await this.persistBibliographic(sourceItem.id, input.title, input.bibliographic);
    if (input.originalAsset) await this.persistOriginalAsset(sourceItem.id, document.id, input.originalAsset);
    if (input.conversion.rawStructuredResult !== undefined) {
      await this.persistStructuredAsset(sourceItem.id, document.id, input.conversion.rawStructuredResult);
    }

    const ingestionRun = await runs.create({
      sourceItemId: sourceItem.id,
      currentStage: "chunking",
      stagesCheckpoint: {
        conversion: { status: "completed", completedAt: new Date().toISOString(), metadata: conversionMetadata(input.conversion) }
      }
    });
    const job = await jobs.create({
      type: "ingestion",
      payload: {
        ingestionRunId: ingestionRun.id,
        sourceItemId: sourceItem.id,
        documentId: document.id,
        markdown: input.conversion.markdown,
        blocks: input.conversion.blocks
      }
    });
    await runs.update(ingestionRun.id, { jobId: job.id });
    return {
      sourceItemId: sourceItem.id,
      documentId: document.id,
      ingestionRunId: ingestionRun.id,
      jobId: job.id,
      duplicate: Boolean(duplicate)
    };
  }

  private async persistBibliographic(
    sourceItemId: string,
    sourceTitle: string,
    input: NonNullable<ManualIngestionInput["bibliographic"]>
  ): Promise<void> {
    const repository = createBibliographicRepository(this.requirePool());
    const workId = input.workId ?? (await repository.createWork({
      type: input.workType ?? "generic_work",
      title: input.workTitle ?? sourceTitle,
      identifiers: { ...(input.isbn ? { isbn: input.isbn } : {}), ...(input.issn ? { issn: input.issn } : {}), ...(input.doi ? { doi: input.doi } : {}) }
    })).id;
    const instanceId = input.isbn || input.issn || input.doi
      ? await repository.createInstance({
          workId,
          type: "generic_instance",
          ...(input.isbn ? { isbn: input.isbn } : {}),
          ...(input.issn ? { issn: input.issn } : {}),
          ...(input.doi ? { doi: input.doi } : {})
        })
      : null;
    await repository.linkSource({
      sourceItemId,
      workId,
      instanceId,
      ...(input.pages ? { pages: input.pages } : {})
    });
  }

  private async persistOriginalAsset(
    sourceItemId: string,
    documentId: string,
    input: { data: Uint8Array; fileName: string; mimeType: string }
  ): Promise<void> {
    const internal = await this.assetStorage.store({
      data: input.data,
      originalFileName: input.fileName,
      basePath: join(this.options.userDataPath, "assets"),
      storageBase: "app_internal"
    });
    const assets = createDocumentAssetRepository(this.requirePool());
    await assets.create({
      sourceItemId, documentId, originalFileName: input.fileName, sha256: internal.sha256,
      mimeType: input.mimeType, sizeBytes: internal.sizeBytes, storageBase: internal.storageBase,
      relativePath: internal.relativePath, role: "original"
    });
    const storageSettings = await this.options.getStorageSettings();
    if (storageSettings.uploadCopiesEnabled && storageSettings.uploadCopiesFolderPath) {
      const copy = await this.assetStorage.store({
        data: input.data, originalFileName: input.fileName,
        basePath: storageSettings.uploadCopiesFolderPath, storageBase: "uploaded_files"
      });
      await assets.create({
        sourceItemId, documentId, originalFileName: input.fileName, sha256: copy.sha256,
        mimeType: input.mimeType, sizeBytes: copy.sizeBytes, storageBase: copy.storageBase,
        relativePath: copy.relativePath, role: "original"
      });
    }
  }

  private async persistStructuredAsset(sourceItemId: string, documentId: string, raw: unknown): Promise<void> {
    const data = new TextEncoder().encode(JSON.stringify(raw));
    const stored = await this.assetStorage.store({
      data, originalFileName: `${documentId}.docling.json`,
      basePath: join(this.options.userDataPath, "assets"), storageBase: "app_internal"
    });
    await createDocumentAssetRepository(this.requirePool()).create({
      sourceItemId, documentId, originalFileName: `${documentId}.docling.json`, sha256: stored.sha256,
      mimeType: "application/json", sizeBytes: stored.sizeBytes, storageBase: stored.storageBase,
      relativePath: stored.relativePath, role: "derived", metadata: { engine: "docling" }
    });
  }

  private requirePool(): PgPool {
    const pool = this.options.getPool();
    if (!pool) throw new Error("errors.database.notReady");
    return pool;
  }
}

function conversionMetadata(result: MarkdownConversionResult): Record<string, unknown> {
  return {
    status: result.status, engine: result.engine, engineVersion: result.engineVersion,
    profile: result.profile, options: result.options, warnings: result.warnings,
    quality: result.quality, metadata: result.metadata
  };
}

function resolveDoclingRuntime(options: IngestionServiceOptions) {
  const platform = `${process.platform}-${process.arch}`;
  const root = options.isPackaged
    ? join(options.resourcesPath, "sidecars", "docling", platform)
    : join(options.workspaceRoot, "vendor", "sidecars", "docling", platform);
  const executablePath = process.platform === "win32"
    ? join(root, "python.exe")
    : join(root, "bin", "python3.13");
  const sidecarScriptPath = options.isPackaged
    ? join(options.resourcesPath, "docling", "docling_sidecar.py")
    : join(options.workspaceRoot, "packages", "conversion", "sidecar", "docling_sidecar.py");
  if (!existsSync(executablePath) || !existsSync(sidecarScriptPath)) return null;
  return { executablePath, sidecarScriptPath };
}

function detectMimeType(fileName: string, data: Uint8Array): string {
  const extension = extname(fileName).toLowerCase();
  if (data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46) return "application/pdf";
  return ({
    ".md": "text/markdown", ".markdown": "text/markdown", ".txt": "text/plain",
    ".html": "text/html", ".htm": "text/html", ".csv": "text/csv",
    ".json": "application/json", ".xml": "application/xml", ".rss": "application/rss+xml",
    ".atom": "application/atom+xml", ".ipynb": "application/x-ipynb+json",
    ".pdf": "application/pdf", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".zip": "application/zip"
  } as Record<string, string>)[extension] ?? "application/octet-stream";
}
