import { existsSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";

import {
  createBibliographicRepository,
  createDocumentAssetRepository,
  createDocumentRepository,
  createIngestionRunRepository,
  createSourceItemRepository,
  type PgPool
} from "@app/db";
import {
  ConversionRouter,
  DoclingClient,
  createTextBlocks,
  detectDocumentStructure,
  detectMarkdownStructure,
  descriptorDraftFromVideoMetadata,
  descriptorDraftFromWebMetadata,
  extractFileMetadata as extractLocalFileMetadata,
  normalizeMarkdown,
  readPdfPageCount,
  sha256,
  type ConversionProgress,
  type MarkdownConversionResult
} from "@app/conversion";
import {
  resolveProcessingPlan,
  SourceDescriptorSchema,
  type SourceDescriptor,
  type SourceDescriptorDraft,
  type SourceItemType,
  type ProcessingPlanRequest
} from "@app/domain";
import type {
  CaptureSelectionRequest,
  CaptureWebPageRequest,
  CaptureYouTubeVideoRequest,
  ImportObsidianNoteRequest
} from "@app/integration-contracts";
import type {
  FileImportInput,
  FileImportProgress,
  ContainerSourceInput,
  DuplicateCandidate,
  DuplicateCheckInput,
  DuplicatePolicy,
  IngestionResult,
  ManualIngestionInput,
  StorageSettings
} from "../../shared/ipc.js";

import { AssetStorageService } from "./asset-storage-service.js";
import { YouTubeService } from "./youtube-service.js";
import { HierarchicalIngestionService } from "./hierarchical-ingestion-service.js";

export interface IngestionServiceOptions {
  getPool: () => PgPool | null;
  getStorageSettings: () => Promise<StorageSettings>;
  userDataPath: string;
  resourcesPath: string;
  workspaceRoot: string;
  isPackaged: boolean;
  youtubeService?: YouTubeService;
  hierarchicalIngestionService?: HierarchicalIngestionService;
}

interface PreparedFileImport {
  path: string;
  fileName: string;
  mimeType: string;
  data: Uint8Array;
  conversion: MarkdownConversionResult;
  draft: SourceDescriptorDraft;
  preparedAt: number;
}

type FileImportProgressUpdate = Omit<FileImportProgress, "requestId">;
type FileImportProgressListener = (progress: FileImportProgressUpdate) => void;

export class IngestionService {
  private readonly assetStorage = new AssetStorageService();
  private readonly router: ConversionRouter;
  private readonly youtube: YouTubeService;
  private readonly hierarchical: HierarchicalIngestionService;
  private readonly preparedFiles = new Map<string, PreparedFileImport>();

  public constructor(private readonly options: IngestionServiceOptions) {
    this.youtube = options.youtubeService ?? new YouTubeService();
    this.hierarchical = options.hierarchicalIngestionService ?? new HierarchicalIngestionService({ getPool: options.getPool });
    const docling = resolveDoclingRuntime(options);
    this.router = new ConversionRouter({
      ...(docling ? { doclingClient: new DoclingClient(docling) } : {}),
      materializeForDocling: async (input) => {
        if (input.sourcePath && existsSync(input.sourcePath)) {
          return { path: resolve(input.sourcePath), cleanup: async () => undefined };
        }
        const directory = join(options.userDataPath, "tmp", "conversion");
        await mkdir(directory, { recursive: true });
        const path = join(directory, `${randomUUID()}${extname(input.fileName ?? "")}`);
        await writeFile(path, input.data, { mode: 0o600 });
        return { path, cleanup: () => rm(path, { force: true }) };
      }
    });
  }

  public async createManual(input: ManualIngestionInput): Promise<IngestionResult> {
    if (input.content.trim().length === 0 && isHierarchicalSourceType(input.descriptor.type)) {
      return this.createContainerSource({ descriptor: input.descriptor, duplicatePolicy: input.duplicatePolicy });
    }
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
    const descriptor = input.descriptor;
    const detection = isHierarchicalSourceType(descriptor.type)
      ? detectMarkdownStructure(markdown, documentKind(descriptor.type))
      : undefined;
    return this.persist({
      descriptor,
      sourceOrigin: "manual",
      duplicatePolicy: input.duplicatePolicy,
      conversion,
      processingPlan: input.processingPlan,
      ...(detection ? { structureDetection: detection } : {})
    });
  }

  public async createContainerSource(input: ContainerSourceInput): Promise<IngestionResult> {
    const pool = this.requirePool();
    const sources = createSourceItemRepository(pool);
    const descriptor = input.descriptor;
    const duplicate = await sources.findDescriptorDuplicate({
      type: descriptor.type,
      title: descriptor.title,
      identifiers: descriptorIdentifiers(descriptor)
    });
    if (duplicate && input.duplicatePolicy === "ignore") return containerResult(duplicate.id, true);

    const values = sourceValues(descriptor, "manual", null);
    const sourceItem = duplicate && input.duplicatePolicy === "update"
      ? await sources.update(duplicate.id, values)
      : await sources.create(values);
    if (!sourceItem) throw new Error("Source item persistence failed.");
    await this.persistBibliographic(sourceItem.id, descriptor);
    await this.attachDescriptorCover(sourceItem.id, descriptor);
    return containerResult(sourceItem.id, Boolean(duplicate));
  }

  public async findDuplicate(input: DuplicateCheckInput): Promise<DuplicateCandidate | null> {
    const sources = createSourceItemRepository(this.requirePool());
    const prepared = input.fileToken ? this.preparedFiles.get(input.fileToken) : undefined;
    const normalized = input.content === undefined ? undefined : normalizeMarkdown(input.content);
    const byContent = await sources.findDuplicate({
      sourceUri: descriptorSourceUri(input.descriptor),
      contentHash: prepared?.conversion.contentHash ?? (normalized ? sha256(normalized) : null)
    });
    const duplicate = byContent ?? await sources.findDescriptorDuplicate({
      type: input.descriptor.type,
      title: input.descriptor.title,
      identifiers: descriptorIdentifiers(input.descriptor)
    });
    return duplicate ? { id: duplicate.id, title: duplicate.title, type: duplicate.type } : null;
  }

  public async prepareFileMetadata(
    path: string,
    sourceType: SourceItemType,
    onProgress?: FileImportProgressListener
  ) {
    reportFileImportProgress(onProgress, { stage: "inspecting_file", progress: 0.02 });
    const file = await stat(path);
    assertImportSize(file.size, readPositiveInteger(process.env.MEMORA_MAX_IMPORT_BYTES, 512 * 1024 * 1024));
    const fileName = basename(path);
    const extension = extname(fileName).toLowerCase();
    const isPdf = extension === ".pdf";
    const totalPages = isPdf ? await readPdfPageCount(path).catch(() => undefined) : undefined;
    reportFileImportProgress(onProgress, {
      stage: "inspecting_file",
      progress: 0.06,
      ...(totalPages ? { totalPages } : {})
    });
    const data = isPdf ? new Uint8Array() : await readFile(path);
    const mimeType = detectMimeType(fileName, data);
    reportFileImportProgress(onProgress, {
      stage: "loading_engine",
      progress: 0.08,
      ...(totalPages ? { totalPages } : {})
    });
    const conversion = await this.router.convert(
      { data, sourcePath: path, fileName, mimeType, profile: "standard" },
      undefined,
      (progress) => reportFileImportProgress(
        onProgress,
        mapConversionProgress(progress, totalPages)
      )
    );
    reportFileImportProgress(onProgress, {
      stage: "extracting_metadata",
      progress: 0.9,
      ...(totalPages ? { completedPages: totalPages, totalPages } : {})
    });
    let draft = await extractLocalFileMetadata({
      sourceType,
      data,
      sourcePath: path,
      fileName,
      mimeType,
      conversion
    });
    if (draft.coverData) {
      reportFileImportProgress(onProgress, {
        stage: "storing_cover",
        progress: 0.96,
        ...(totalPages ? { completedPages: totalPages, totalPages } : {})
      });
      const stored = await this.assetStorage.store({
        data: draft.coverData.data,
        originalFileName: draft.coverData.fileName,
        basePath: join(this.options.userDataPath, "assets"),
        storageBase: "app_internal"
      });
      const asset = await createDocumentAssetRepository(this.requirePool()).create({
        originalFileName: draft.coverData.fileName,
        sha256: stored.sha256,
        mimeType: draft.coverData.mimeType,
        sizeBytes: stored.sizeBytes,
        storageBase: stored.storageBase,
        relativePath: stored.relativePath,
        role: "cover",
        metadata: { origin: "embedded_file_metadata" }
      });
      draft = {
        ...draft,
        values: { ...draft.values, cover: { assetId: asset.id, mimeType: draft.coverData.mimeType } },
        provenance: {
          ...draft.provenance,
          cover: { source: "extracted", evidence: "embedded file cover" }
        },
        coverData: undefined
      };
    }
    this.removeExpiredPreparedFiles();
    const fileToken = randomUUID();
    this.preparedFiles.set(fileToken, { path, fileName, mimeType, data, conversion, draft, preparedAt: Date.now() });
    reportFileImportProgress(onProgress, {
      stage: "completed",
      progress: 1,
      ...(totalPages ? { completedPages: totalPages, totalPages } : {})
    });
    return { fileToken, fileName, mimeType, draft };
  }

  public async importFile(path: string, input: FileImportInput): Promise<IngestionResult> {
    const prepared = await this.prepareFileMetadata(path, input.descriptor.type);
    return this.importPreparedFile(prepared.fileToken, input);
  }

  public async importPreparedFile(fileToken: string, input: FileImportInput): Promise<IngestionResult> {
    this.removeExpiredPreparedFiles();
    const prepared = this.preparedFiles.get(fileToken);
    if (!prepared) throw new Error("errors.ingestion.fileSelectionExpired");
    const sourceType = input.descriptor.type;
    const detection = isHierarchicalSourceType(sourceType)
      ? await detectDocumentStructure({
          data: prepared.data,
          sourcePath: prepared.path,
          fileName: prepared.fileName,
          mimeType: prepared.mimeType,
          conversion: prepared.conversion,
          documentKind: sourceType === "Book" ? "book" : sourceType === "PeriodicalIssue" ? "periodical" : "paper"
        })
      : undefined;
    const result = await this.persist({
      descriptor: input.descriptor,
      sourceOrigin: "file_upload",
      duplicatePolicy: input.duplicatePolicy,
      metadata: { originalFileName: prepared.fileName, mimeType: prepared.mimeType },
      conversion: prepared.conversion,
      originalAsset: { sourcePath: prepared.path, fileName: prepared.fileName, mimeType: prepared.mimeType },
      processingPlan: input.processingPlan,
      ...(detection ? { structureDetection: detection } : {})
    });
    this.preparedFiles.delete(fileToken);
    return result;
  }

  public async captureWebPage(input: CaptureWebPageRequest): Promise<IngestionResult> {
    const conversion = input.markdown
      ? markdownResult(input.markdown, "chrome-defuddle")
      : input.html
        ? await this.router.convert({
            data: new TextEncoder().encode(input.html),
            fileName: "capture.html",
            mimeType: "text/html",
            sourceUrl: input.url,
            profile: "standard"
          })
        : markdownResult(input.textContent ?? "", "chrome-text");
    const descriptor = descriptorDraftFromWebMetadata({
      title: input.title,
      url: input.url,
      metadata: { ...input.metadata, ...conversion.metadata }
    });
    return this.persist({
      descriptor: descriptorFromDraft(descriptor, readMetadataLanguage(input.metadata)),
      sourceOrigin: "web_capture",
      duplicatePolicy: "ignore",
      metadata: {
        ...input.metadata,
        capturedAt: input.capturedAt,
        captureRequestId: input.requestId,
        descriptor: { ...descriptor.values, provenance: descriptor.provenance }
      },
      conversion,
      processingPlan: importOnlyPlan()
    });
  }

  public async captureSelection(input: CaptureSelectionRequest): Promise<IngestionResult> {
    const markdown = [
      `# ${input.title}`,
      `> ${input.selection.replace(/\n/g, "\n> ")}`,
      input.surroundingText ? `## Context\n\n${input.surroundingText}` : "",
      `[Source](${input.url})`
    ].filter(Boolean).join("\n\n");
    return this.persist({
      descriptor: SourceDescriptorSchema.parse({
        type: "WebArticle", title: input.title, url: input.url,
        language: readMetadataLanguage(input.metadata), creators: [], tags: [],
        provenance: { title: { source: "extracted", evidence: "selection capture" } }
      }),
      sourceOrigin: "web_capture",
      sourceUriOverride: `${input.url}#selection=${input.requestId}`,
      duplicatePolicy: "ignore",
      metadata: { ...input.metadata, capturedAt: input.capturedAt, selectionCapture: true },
      conversion: markdownResult(markdown, "chrome-selection"),
      processingPlan: importOnlyPlan()
    });
  }

  public async captureYouTube(input: CaptureYouTubeVideoRequest): Promise<IngestionResult> {
    const captured = await this.youtube.capture(input.videoId, input.title);
    const descriptor = descriptorDraftFromVideoMetadata({
      title: captured.title,
      url: input.url,
      metadata: { ...input.visibleMetadata, ...captured.metadata, videoId: input.videoId, platform: "youtube" }
    });
    return this.persist({
      descriptor: descriptorFromDraft(descriptor, captured.language),
      sourceOrigin: "youtube",
      duplicatePolicy: "ignore",
      metadata: {
        ...input.visibleMetadata,
        ...captured.metadata,
        capturedAt: input.capturedAt,
        captureRequestId: input.requestId,
        descriptor: { ...descriptor.values, provenance: descriptor.provenance }
      },
      conversion: markdownResult(captured.markdown, "youtubei.js"),
      processingPlan: importOnlyPlan()
    });
  }

  public async importObsidianNote(input: ImportObsidianNoteRequest): Promise<IngestionResult> {
    return this.persist({
      descriptor: SourceDescriptorSchema.parse({
        type: "PersonalNote",
        title: input.title ?? basename(input.relativePath, extname(input.relativePath)),
        language: "und", creators: [], tags: [], provenance: {}
      }),
      sourceOrigin: "obsidian",
      sourceUriOverride: `obsidian://${input.relativePath}`,
      duplicatePolicy: "ignore",
      metadata: { obsidianRelativePath: input.relativePath, obsidianMtimeMs: input.mtimeMs },
      conversion: markdownResult(input.markdown, "obsidian"),
      processingPlan: importOnlyPlan()
    });
  }

  public async lookupSources(query: string, sourceTypes: SourceItemType[] = []) {
    return (await createSourceItemRepository(this.requirePool()).lookup(query, 10, sourceTypes)).map((source) => ({
      id: source.id,
      title: source.title,
      type: source.type
    }));
  }

  private async persist(input: {
    descriptor: SourceDescriptor;
    sourceOrigin: string;
    sourceUriOverride?: string | null;
    duplicatePolicy: DuplicatePolicy;
    metadata?: Record<string, unknown>;
    conversion: MarkdownConversionResult;
    originalAsset?: { data?: Uint8Array; sourcePath?: string; fileName: string; mimeType: string };
    processingPlan: ProcessingPlanRequest;
    structureDetection?: Awaited<ReturnType<typeof detectDocumentStructure>>;
  }): Promise<IngestionResult> {
    const pool = this.requirePool();
    const sources = createSourceItemRepository(pool);
    const documents = createDocumentRepository(pool);
    const runs = createIngestionRunRepository(pool);
    const descriptor = input.descriptor;
    const sourceUri = input.sourceUriOverride ?? descriptorSourceUri(descriptor);
    const duplicate = await sources.findDuplicate({ sourceUri, contentHash: input.conversion.contentHash })
      ?? await sources.findDescriptorDuplicate({
        type: descriptor.type,
        title: descriptor.title,
        identifiers: descriptorIdentifiers(descriptor)
      });
    if (duplicate && input.duplicatePolicy === "ignore") {
      const existingDocuments = await documents.listBySourceItem(duplicate.id);
      const existingRuns = await runs.listBySourceItem(duplicate.id);
      const document = existingDocuments[0];
      const run = existingRuns[0];
      if (document) {
        const structureResult = await pool.query<{ id: string; status: string }>(
          `select id, status::text from document_structures where root_source_item_id = $1 order by revision desc limit 1`,
          [duplicate.id]
        );
        const existingStructure = structureResult.rows[0];
        return {
          sourceItemId: duplicate.id, documentId: document.id, ingestionRunId: run?.id ?? null, jobId: run?.jobId ?? null,
          batchId: run?.batchId ?? null, structureId: existingStructure?.id ?? null,
          requiresStructureReview: existingStructure?.status === "draft" || existingStructure?.status === "in_review", duplicate: true
        };
      }
      return containerResult(duplicate.id, true);
    }

    let sourceItem = duplicate && input.duplicatePolicy === "update"
      ? await sources.update(duplicate.id, {
          ...sourceValues(descriptor, input.sourceOrigin, input.conversion.contentHash, input.metadata),
          sourceUri
        })
      : await sources.create({
          ...sourceValues(descriptor, input.sourceOrigin, input.conversion.contentHash, input.metadata),
          sourceUri
        });
    sourceItem ??= duplicate;
    if (!sourceItem) throw new Error("Source item persistence failed.");

    const existingDocuments = duplicate && input.duplicatePolicy === "update"
      ? await documents.listBySourceItem(sourceItem.id)
      : [];
    const document = existingDocuments[0]
      ? await documents.update(existingDocuments[0].id, {
          title: descriptor.title,
          canonicalMarkdown: input.conversion.markdown,
          contentHash: input.conversion.contentHash,
          language: descriptor.language,
          metadata: conversionMetadata(input.conversion)
        })
      : await documents.create({
          sourceItemId: sourceItem.id,
          title: descriptor.title,
          canonicalMarkdown: input.conversion.markdown,
          contentHash: input.conversion.contentHash,
          language: descriptor.language,
          metadata: conversionMetadata(input.conversion)
        });
    if (!document) throw new Error("Document persistence failed.");

    await this.persistBibliographic(sourceItem.id, descriptor);
    await this.attachDescriptorCover(sourceItem.id, descriptor, document.id);
    if (input.originalAsset) await this.persistOriginalAsset(sourceItem.id, document.id, input.originalAsset);
    if (input.conversion.rawStructuredResult !== undefined) {
      await this.persistStructuredAsset(sourceItem.id, document.id, input.conversion.rawStructuredResult);
    }

    if (input.structureDetection) {
      const structure = await this.hierarchical.createStructureDraft(sourceItem.id, document.id, input.structureDetection);
      return {
        sourceItemId: sourceItem.id, documentId: document.id, ingestionRunId: null, jobId: null,
        batchId: null, structureId: structure.id, requiresStructureReview: true, duplicate: Boolean(duplicate)
      };
    }
    const queued = await this.hierarchical.process({
      plan: { ...input.processingPlan, targetSourceItemIds: [sourceItem.id], scope: "source_only" },
      runKind: "initial",
      trigger: input.sourceOrigin === "manual" || input.sourceOrigin === "file_upload" ? "interactive_import" : "integration"
    });
    const first = queued.queued[0];
    if (!first) throw new Error("ingestion_queue_failed");
    return {
      sourceItemId: sourceItem.id,
      documentId: document.id,
      ingestionRunId: first.ingestionRunId,
      jobId: first.jobId,
      batchId: queued.batchId,
      structureId: null,
      requiresStructureReview: false,
      duplicate: Boolean(duplicate)
    };
  }

  private async persistBibliographic(
    sourceItemId: string,
    descriptor: SourceDescriptor
  ): Promise<void> {
    if (!["Book", "BookChapter", "PeriodicalIssue", "AcademicPaper", "StandaloneArticle"].includes(descriptor.type)) {
      return;
    }
    const repository = createBibliographicRepository(this.requirePool());
    if ((descriptor.type === "BookChapter" || descriptor.type === "StandaloneArticle") && descriptor.parentSourceItemId) {
      const parent = await this.requirePool().query<{ workId: string; instanceId: string | null }>(
        `select work_id as "workId", instance_id as "instanceId"
         from source_item_bibliographic_links where source_item_id = $1 limit 1`,
        [descriptor.parentSourceItemId]
      );
      const link = parent.rows[0];
      if (link) {
        await repository.linkSource({
          sourceItemId, workId: link.workId, instanceId: link.instanceId,
          relationType: descriptor.type === "BookChapter" ? "chapter_of" : "article_in",
          ...(descriptor.pages ? { pages: formatPageRange(descriptor.pages) } : {})
        });
        return;
      }
    }

    const identifiers = descriptorIdentifierMap(descriptor);
    const existing = await this.requirePool().query<{ workId: string; instanceId: string | null }>(
      `select work_id as "workId", instance_id as "instanceId"
       from source_item_bibliographic_links where source_item_id = $1 limit 1`,
      [sourceItemId]
    );
    const existingLink = existing.rows[0];
    if (existingLink) {
      await this.requirePool().query(
        `update bibliographic_works set type = $2, title = $3, subtitle = $4, language = $5,
           creators = $6::jsonb, identifiers = $7::jsonb,
           metadata = metadata || $8::jsonb, updated_at = now() where id = $1`,
        [existingLink.workId, bibliographicWorkType(descriptor.type),
          descriptor.type === "PeriodicalIssue" ? descriptor.publicationTitle : descriptor.title,
          descriptor.subtitle ?? null, descriptor.language, JSON.stringify(descriptor.creators), identifiers,
          { sourceDescriptorType: descriptor.type }]
      );
      if (existingLink.instanceId) {
        await this.updateBibliographicInstance(existingLink.instanceId, descriptor);
      }
      return;
    }
    const work = await repository.createWork({
      type: bibliographicWorkType(descriptor.type),
      title: descriptor.type === "PeriodicalIssue" ? descriptor.publicationTitle : descriptor.title,
      subtitle: descriptor.subtitle ?? null,
      language: descriptor.language,
      creators: descriptor.creators,
      identifiers,
      metadata: { sourceDescriptorType: descriptor.type }
    });
    const instanceId = descriptor.type === "Book"
      ? await repository.createInstance({
          workId: work.id, type: "book_edition", creators: descriptor.creators,
          ...(descriptor.edition ? { edition: descriptor.edition } : {}),
          ...(descriptor.volume ? { volume: descriptor.volume } : {}),
          ...(descriptor.publicationDate ? { publicationDate: descriptor.publicationDate } : {}),
          ...(descriptor.publisher ? { publisher: descriptor.publisher } : {}),
          ...((descriptor.isbn13 ?? descriptor.isbn10) ? { isbn: (descriptor.isbn13 ?? descriptor.isbn10)! } : {}),
          ...(descriptor.pageCount ? { pageCount: descriptor.pageCount } : {}),
          ...(descriptor.series ? { series: descriptor.series } : {})
        })
      : descriptor.type === "PeriodicalIssue"
        ? await repository.createInstance({
            workId: work.id, type: "periodical_issue", creators: descriptor.creators,
            ...(descriptor.volume ? { volume: descriptor.volume } : {}),
            ...(descriptor.issue ? { issue: descriptor.issue } : {}),
            ...(descriptor.publicationDate ? { publicationDate: descriptor.publicationDate } : {}),
            ...(descriptor.publisher ? { publisher: descriptor.publisher } : {}),
            ...(descriptor.issn ? { issn: descriptor.issn } : {}),
            ...(descriptor.pageCount ? { pageCount: descriptor.pageCount } : {})
          })
        : descriptor.type === "AcademicPaper" || descriptor.type === "StandaloneArticle"
          ? await repository.createInstance({
              workId: work.id, type: "article", creators: descriptor.creators,
              ...(descriptor.publicationDate ? { publicationDate: descriptor.publicationDate } : {}),
              ...(descriptor.doi ? { doi: descriptor.doi } : {})
            })
          : null;
    await repository.linkSource({
      sourceItemId,
      workId: work.id,
      instanceId,
      ...("pages" in descriptor && descriptor.pages ? { pages: formatPageRange(descriptor.pages) } : {})
    });
  }

  private async updateBibliographicInstance(instanceId: string, descriptor: SourceDescriptor): Promise<void> {
    if (descriptor.type !== "Book" && descriptor.type !== "PeriodicalIssue"
        && descriptor.type !== "AcademicPaper" && descriptor.type !== "StandaloneArticle") return;
    await this.requirePool().query(
      `update bibliographic_instances set type = $2, edition = $3, volume = $4, issue = $5,
         publication_date = $6, publisher = $7, isbn = $8, issn = $9, doi = $10,
         creators = $11::jsonb, page_count = $12, series = $13, updated_at = now() where id = $1`,
      [
        instanceId,
        descriptor.type === "Book" ? "book_edition" : descriptor.type === "PeriodicalIssue" ? "periodical_issue" : "article",
        descriptor.type === "Book" ? descriptor.edition ?? null : null,
        "volume" in descriptor ? descriptor.volume ?? null : null,
        "issue" in descriptor ? descriptor.issue ?? null : null,
        descriptor.publicationDate ?? null,
        "publisher" in descriptor ? descriptor.publisher ?? null : null,
        descriptor.type === "Book" ? descriptor.isbn13 ?? descriptor.isbn10 ?? null : null,
        descriptor.type === "PeriodicalIssue" ? descriptor.issn ?? null : null,
        descriptor.type === "AcademicPaper" || descriptor.type === "StandaloneArticle" ? descriptor.doi ?? null : null,
        JSON.stringify(descriptor.creators),
        "pageCount" in descriptor ? descriptor.pageCount ?? null : null,
        descriptor.type === "Book" ? descriptor.series ?? null : null
      ]
    );
  }

  private async attachDescriptorCover(
    sourceItemId: string,
    descriptor: SourceDescriptor,
    documentId?: string
  ): Promise<void> {
    const assetId = descriptor.cover?.assetId;
    if (!assetId) return;
    await createDocumentAssetRepository(this.requirePool()).update(assetId, {
      sourceItemId,
      ...(documentId ? { documentId } : {}),
      role: "cover"
    });
  }

  private async persistOriginalAsset(
    sourceItemId: string,
    documentId: string,
    input: { data?: Uint8Array; sourcePath?: string; fileName: string; mimeType: string }
  ): Promise<void> {
    const internal = await this.assetStorage.store({
      ...(input.data ? { data: input.data } : {}), ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}),
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
        ...(input.data ? { data: input.data } : {}), ...(input.sourcePath ? { sourcePath: input.sourcePath } : {}), originalFileName: input.fileName,
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

  private removeExpiredPreparedFiles(): void {
    const cutoff = Date.now() - 30 * 60_000;
    for (const [token, prepared] of this.preparedFiles) {
      if (prepared.preparedAt < cutoff) this.preparedFiles.delete(token);
    }
    const excess = this.preparedFiles.size - 10;
    if (excess > 0) {
      for (const token of [...this.preparedFiles.keys()].slice(0, excess)) this.preparedFiles.delete(token);
    }
  }
}

function importOnlyPlan(): ProcessingPlanRequest {
  return resolveProcessingPlan({
    preset: "import_only", requestedStages: [], scope: "source_only", targetSourceItemIds: [],
    forceRegeneration: false, previousArtifactPolicy: "reuse_valid"
  });
}

function isHierarchicalSourceType(type: SourceItemType): type is "Book" | "PeriodicalIssue" | "AcademicPaper" {
  return type === "Book" || type === "PeriodicalIssue" || type === "AcademicPaper";
}

function documentKind(type: SourceItemType): "book" | "periodical" | "paper" | "other" {
  if (type === "Book") return "book";
  if (type === "PeriodicalIssue") return "periodical";
  if (type === "AcademicPaper") return "paper";
  return "other";
}

function descriptorFromDraft(draft: SourceDescriptorDraft, language = "und"): SourceDescriptor {
  const candidate = SourceDescriptorSchema.safeParse({
    type: draft.sourceType,
    language,
    creators: [],
    tags: [],
    ...draft.values,
    provenance: draft.provenance
  });
  if (candidate.success) return candidate.data;
  const title = typeof draft.values.title === "string" && draft.values.title.trim()
    ? draft.values.title.trim()
    : "Untitled";
  if (draft.sourceType === "WebArticle") {
    const url = typeof draft.values.url === "string" && URL.canParse(draft.values.url) ? draft.values.url : undefined;
    return SourceDescriptorSchema.parse({
      type: "WebArticle", title, language, creators: [], tags: [], provenance: draft.provenance,
      ...(url ? { url } : {})
    });
  }
  if (draft.sourceType === "Video") {
    const url = typeof draft.values.url === "string" && URL.canParse(draft.values.url) ? draft.values.url : undefined;
    return SourceDescriptorSchema.parse({
      type: "Video", title, language, creators: [], tags: [], provenance: draft.provenance,
      ...(url ? { url } : {})
    });
  }
  throw new Error("source_descriptor_draft_invalid");
}

function descriptorSourceUri(descriptor: SourceDescriptor): string | null {
  return "url" in descriptor ? descriptor.url ?? null : null;
}

function descriptorIdentifiers(descriptor: SourceDescriptor): string[] {
  return Object.values(descriptorIdentifierMap(descriptor));
}

function descriptorIdentifierMap(descriptor: SourceDescriptor): Record<string, string> {
  if (descriptor.type === "Book") {
    return {
      ...(descriptor.isbn10 ? { isbn10: descriptor.isbn10 } : {}),
      ...(descriptor.isbn13 ? { isbn13: descriptor.isbn13 } : {})
    };
  }
  if (descriptor.type === "PeriodicalIssue") return descriptor.issn ? { issn: descriptor.issn } : {};
  if (descriptor.type === "AcademicPaper" || descriptor.type === "StandaloneArticle") {
    return descriptor.doi ? { doi: descriptor.doi } : {};
  }
  if (descriptor.type === "Video" && descriptor.videoId) return { videoId: descriptor.videoId };
  return {};
}

function sourceValues(
  descriptor: SourceDescriptor,
  sourceOrigin: string,
  contentHash: string | null,
  extraMetadata: Record<string, unknown> = {}
) {
  return {
    type: descriptor.type,
    title: descriptor.title,
    subtitle: descriptor.subtitle ?? null,
    sourceOrigin,
    sourceUri: descriptorSourceUri(descriptor),
    parentSourceItemId: "parentSourceItemId" in descriptor ? descriptor.parentSourceItemId ?? null : null,
    contentHash,
    language: descriptor.language,
    metadata: { ...extraMetadata, descriptor }
  };
}

function containerResult(sourceItemId: string, duplicate: boolean): IngestionResult {
  return {
    sourceItemId, documentId: null, ingestionRunId: null, jobId: null, batchId: null,
    structureId: null, requiresStructureReview: false, duplicate
  };
}

function formatPageRange(pages: { start: string; end?: string | undefined }): string {
  return pages.end && pages.end !== pages.start ? `${pages.start}-${pages.end}` : pages.start;
}

function bibliographicWorkType(type: SourceDescriptor["type"]): string {
  if (type === "Book" || type === "BookChapter") return "book";
  if (type === "PeriodicalIssue") return "periodical";
  if (type === "AcademicPaper" || type === "StandaloneArticle") return "article";
  return "generic_work";
}

function conversionMetadata(result: MarkdownConversionResult): Record<string, unknown> {
  return {
    status: result.status, engine: result.engine, engineVersion: result.engineVersion,
    profile: result.profile, options: result.options, warnings: result.warnings,
    quality: result.quality, metadata: result.metadata
  };
}

function markdownResult(markdownInput: string, engine: string): MarkdownConversionResult {
  const markdown = normalizeMarkdown(markdownInput);
  return {
    status: "converted",
    markdown,
    contentHash: sha256(markdown),
    blocks: createTextBlocks(markdown),
    assets: [],
    engine,
    engineVersion: "1",
    profile: "standard",
    options: {},
    warnings: [],
    quality: { textCoverage: markdown ? 1 : 0 },
    metadata: {}
  };
}

function readMetadataLanguage(metadata: Record<string, unknown>): string {
  const language = metadata.language;
  return typeof language === "string" && language.length >= 2 && language.length <= 16 ? language : "und";
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
  return {
    executablePath,
    sidecarScriptPath,
    timeoutMs: readPositiveInteger(process.env.MEMORA_DOCLING_TIMEOUT_MS, 5 * 60_000),
    maxOutputBytes: readPositiveInteger(process.env.MEMORA_DOCLING_MAX_OUTPUT_BYTES, 256 * 1024 * 1024),
    conversionOptions: {
      maxPages: readPositiveInteger(process.env.MEMORA_DOCLING_MAX_PAGES, 500)
    },
    env: {
      PATH: process.platform === "win32" ? root : join(root, "bin"),
      HOME: join(options.userDataPath, "docling-home"),
      TMPDIR: join(options.userDataPath, "tmp", "conversion"),
      LANG: "en_US.UTF-8",
      DOCLING_ARTIFACTS_PATH: join(root, "artifacts"),
      DOCLING_NUM_THREADS: String(readPositiveInteger(process.env.MEMORA_DOCLING_NUM_THREADS, 4)),
      HF_HUB_OFFLINE: "1",
      TRANSFORMERS_OFFLINE: "1",
      HF_HUB_DISABLE_TELEMETRY: "1",
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      ALL_PROXY: "http://127.0.0.1:9",
      NO_PROXY: ""
    }
  };
}

function mapConversionProgress(
  event: ConversionProgress,
  fallbackTotalPages?: number
): FileImportProgressUpdate {
  const totalPages = event.totalPages ?? fallbackTotalPages;
  return {
    stage: event.stage,
    progress: Math.min(0.88, 0.08 + (event.progress * 0.8)),
    ...(event.completedPages !== undefined ? { completedPages: event.completedPages } : {}),
    ...(totalPages !== undefined ? { totalPages } : {})
  };
}

function reportFileImportProgress(
  listener: FileImportProgressListener | undefined,
  progress: FileImportProgressUpdate
): void {
  try {
    listener?.(progress);
  } catch {
    // Progress reporting is best-effort and must never invalidate the import.
  }
}

export function assertImportSize(sizeBytes: number, maxBytes: number): void {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > maxBytes) {
    throw new Error("errors.common.fileTooLarge");
  }
}

function readPositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function detectMimeType(fileName: string, data: Uint8Array): string {
  const extension = extname(fileName).toLowerCase();
  if (data[0] === 0x25 && data[1] === 0x50 && data[2] === 0x44 && data[3] === 0x46) return "application/pdf";
  return ({
    ".md": "text/markdown", ".markdown": "text/markdown", ".txt": "text/plain",
    ".html": "text/html", ".htm": "text/html", ".csv": "text/csv",
    ".json": "application/json", ".xml": "application/xml", ".rss": "application/rss+xml",
    ".atom": "application/atom+xml", ".ipynb": "application/x-ipynb+json",
    ".pdf": "application/pdf", ".epub": "application/epub+zip", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    ".zip": "application/zip"
  } as Record<string, string>)[extension] ?? "application/octet-stream";
}
