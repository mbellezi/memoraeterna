import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, extname, join } from "node:path";

import { createDocumentAssetRepository, type PgPool } from "@app/db";
import {
  EnrichmentCandidateSchema,
  MetadataEnrichmentQuerySchema,
  normalizeDoi,
  normalizeIsbn,
  type Creator,
  type EnrichmentCandidate,
  type MetadataEnrichmentQuery
} from "@app/domain";

import { AssetStorageService } from "./asset-storage-service.js";

type Provider = EnrichmentCandidate["provider"];
type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export interface MetadataEnrichmentServiceOptions {
  getPool: () => PgPool | null;
  getEnabled: () => Promise<boolean>;
  userDataPath: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  cacheTtlMs?: number;
  logger?: Pick<Console, "debug" | "warn">;
}

interface CacheRecord {
  expiresAt: number;
  candidates: EnrichmentCandidate[];
}

interface CacheFile {
  version: 1;
  entries: Record<string, CacheRecord>;
}

export class MetadataEnrichmentService {
  private readonly fetch: FetchLike;
  private readonly timeoutMs: number;
  private readonly cacheTtlMs: number;
  private readonly cachePath: string;
  private readonly assetStorage = new AssetStorageService();
  private readonly coverPreviewCache = new Map<string, { expiresAt: number; dataUrl: string | null }>();
  private cache: CacheFile | null = null;

  public constructor(private readonly options: MetadataEnrichmentServiceOptions) {
    this.fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = options.timeoutMs ?? 5_000;
    this.cacheTtlMs = options.cacheTtlMs ?? 24 * 60 * 60_000;
    this.cachePath = join(options.userDataPath, "metadata-enrichment-cache.json");
  }

  public async search(input: MetadataEnrichmentQuery): Promise<EnrichmentCandidate[]> {
    const query = MetadataEnrichmentQuerySchema.parse(input);
    if (!(await this.options.getEnabled())) return [];
    const cacheKey = createCacheKey(query);
    const cached = await this.getCached(cacheKey);
    if (cached) return this.withCoverPreviews(cached);

    try {
      let candidates: EnrichmentCandidate[] = [];
      if (query.sourceType === "Book" || query.sourceType === "BookChapter") {
        candidates = await new OpenLibraryAdapter(this.requestJson.bind(this)).search(query);
        if (candidates.length === 0) {
          candidates = await new GoogleBooksAdapter(this.requestJson.bind(this)).search(query);
        }
      } else if (["AcademicPaper", "StandaloneArticle", "DocumentSection"].includes(query.sourceType)) {
        candidates = await new CrossrefAdapter(this.requestJson.bind(this)).search(query);
      }
      const parsed = EnrichmentCandidateSchema.array().parse(candidates).slice(0, 10);
      await this.putCached(cacheKey, parsed);
      return this.withCoverPreviews(parsed);
    } catch (error) {
      this.options.logger?.warn(`metadata_enrichment_failed:${safeErrorCode(error)}`);
      return [];
    }
  }

  public async downloadCover(coverUrl: string): Promise<{ assetId: string; mimeType: string }> {
    if (!(await this.options.getEnabled())) throw new Error("metadata_enrichment_disabled");
    const url = validateCoverUrl(coverUrl);
    const response = await this.request(url);
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > 10 * 1024 * 1024) throw new Error("metadata_cover_too_large");
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength === 0 || data.byteLength > 10 * 1024 * 1024) throw new Error("metadata_cover_too_large");
    const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim() || "image/jpeg";
    if (!mimeType.startsWith("image/")) throw new Error("metadata_cover_invalid_type");
    const extension = extensionForMimeType(mimeType) ?? (extname(url.pathname) || ".img");
    const originalFileName = `metadata-cover${extension}`;
    const stored = await this.assetStorage.store({
      data,
      originalFileName,
      basePath: join(this.options.userDataPath, "assets"),
      storageBase: "app_internal"
    });
    const asset = await createDocumentAssetRepository(this.requirePool()).create({
      originalFileName,
      sha256: stored.sha256,
      mimeType,
      sizeBytes: stored.sizeBytes,
      storageBase: stored.storageBase,
      relativePath: stored.relativePath,
      role: "cover",
      metadata: { sourceUrl: url.toString() }
    });
    return { assetId: asset.id, mimeType };
  }

  private async requestJson(url: URL): Promise<unknown> {
    const response = await this.request(url);
    return response.json();
  }

  private async withCoverPreviews(candidates: EnrichmentCandidate[]): Promise<EnrichmentCandidate[]> {
    return Promise.all(candidates.map(async (candidate, index) => {
      if (!candidate.coverUrl || index >= 5) return candidate;
      try {
        return { ...candidate, coverPreviewDataUrl: await this.loadCoverPreview(candidate.coverUrl) };
      } catch {
        this.coverPreviewCache.set(candidate.coverUrl, { expiresAt: Date.now() + 5 * 60_000, dataUrl: null });
        return candidate;
      }
    }));
  }

  private async loadCoverPreview(coverUrl: string): Promise<string> {
    const cached = this.coverPreviewCache.get(coverUrl);
    if (cached && cached.expiresAt > Date.now()) {
      if (cached.dataUrl) return cached.dataUrl;
      throw new Error("metadata_cover_preview_unavailable");
    }
    const response = await this.request(validateCoverUrl(coverUrl));
    const contentLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(contentLength) && contentLength > 2 * 1024 * 1024) throw new Error("metadata_cover_preview_too_large");
    const mimeType = response.headers.get("content-type")?.split(";", 1)[0]?.trim() || "";
    if (!mimeType.startsWith("image/")) throw new Error("metadata_cover_invalid_type");
    const data = new Uint8Array(await response.arrayBuffer());
    if (data.byteLength === 0 || data.byteLength > 2 * 1024 * 1024) throw new Error("metadata_cover_preview_too_large");
    const dataUrl = `data:${mimeType};base64,${Buffer.from(data).toString("base64")}`;
    this.coverPreviewCache.set(coverUrl, { expiresAt: Date.now() + this.cacheTtlMs, dataUrl });
    return dataUrl;
  }

  private async request(url: URL): Promise<Response> {
    this.options.logger?.debug(JSON.stringify({ event: "metadata_enrichment_request", url: url.toString() }));
    const response = await this.fetch(url, {
      signal: AbortSignal.timeout(this.timeoutMs),
      headers: { "User-Agent": "MemoraEterna/0.1 (mailto:metadata@memora.local)" }
    });
    if (!response.ok) throw new Error(`metadata_http_${response.status}`);
    return response;
  }

  private async getCached(key: string): Promise<EnrichmentCandidate[] | null> {
    const cache = await this.loadCache();
    const entry = cache.entries[key];
    if (!entry || entry.expiresAt <= Date.now()) return null;
    const parsed = EnrichmentCandidateSchema.array().safeParse(entry.candidates);
    return parsed.success ? parsed.data : null;
  }

  private async putCached(key: string, candidates: EnrichmentCandidate[]): Promise<void> {
    const cache = await this.loadCache();
    cache.entries[key] = { expiresAt: Date.now() + this.cacheTtlMs, candidates };
    for (const [entryKey, entry] of Object.entries(cache.entries)) {
      if (entry.expiresAt <= Date.now()) delete cache.entries[entryKey];
    }
    await mkdir(dirname(this.cachePath), { recursive: true });
    await writeFile(this.cachePath, JSON.stringify(cache), { encoding: "utf8", mode: 0o600 });
  }

  private async loadCache(): Promise<CacheFile> {
    if (this.cache) return this.cache;
    try {
      const parsed = JSON.parse(await readFile(this.cachePath, "utf8")) as CacheFile;
      this.cache = parsed.version === 1 && parsed.entries ? parsed : { version: 1, entries: {} };
    } catch {
      this.cache = { version: 1, entries: {} };
    }
    return this.cache;
  }

  private requirePool(): PgPool {
    const pool = this.options.getPool();
    if (!pool) throw new Error("errors.database.notReady");
    return pool;
  }
}

type JsonRequest = (url: URL) => Promise<unknown>;

export class OpenLibraryAdapter {
  public constructor(private readonly requestJson: JsonRequest) {}

  public async search(query: MetadataEnrichmentQuery): Promise<EnrichmentCandidate[]> {
    if (query.isbn) return this.lookupIsbn(normalizeIsbn(query.isbn));
    if (!query.title) return [];
    const url = new URL("https://openlibrary.org/search.json");
    url.searchParams.set("title", query.title);
    if (query.author) url.searchParams.set("author", query.author);
    url.searchParams.set("limit", "8");
    url.searchParams.set("fields", "key,title,subtitle,author_name,isbn,publisher,first_publish_year,publish_year,edition_key,cover_i,language,subject,number_of_pages_median");
    const payload = asObject(await this.requestJson(url));
    return asArray(payload.docs).map((raw) => {
      const document = asObject(raw);
      const isbns = stringArray(document.isbn);
      const values: Record<string, unknown> = {
        title: stringValue(document.title) ?? query.title,
        subtitle: stringValue(document.subtitle),
        creators: stringArray(document.author_name).map(authorCreator),
        publisher: stringArray(document.publisher)[0],
        publicationDate: numberValue(document.first_publish_year)?.toString(),
        year: numberValue(document.first_publish_year),
        isbn10: isbns.find((isbn) => normalizeIsbn(isbn).length === 10),
        isbn13: isbns.find((isbn) => normalizeIsbn(isbn).length === 13),
        language: stringArray(document.language)[0],
        subjects: stringArray(document.subject).slice(0, 50),
        pageCount: numberValue(document.number_of_pages_median),
        coverUrl: numberValue(document.cover_i) ? `https://covers.openlibrary.org/b/id/${numberValue(document.cover_i)}-L.jpg` : undefined
      };
      return candidate("open-library", stringValue(document.key) ?? JSON.stringify(values), compact(values));
    });
  }

  private async lookupIsbn(isbn: string): Promise<EnrichmentCandidate[]> {
    const editionUrl = new URL(`https://openlibrary.org/isbn/${encodeURIComponent(isbn)}.json`);
    const edition = asObject(await this.requestJson(editionUrl));
    if (!stringValue(edition.title)) return [];
    const authors = await Promise.all(asArray(edition.authors).slice(0, 20).map(async (raw) => {
      const key = stringValue(asObject(raw).key);
      if (!key) return null;
      try {
        const author = asObject(await this.requestJson(new URL(`https://openlibrary.org${key}.json`)));
        const name = stringValue(author.name);
        return name ? authorCreator(name) : null;
      } catch { return null; }
    }));
    const workKey = stringValue(asObject(asArray(edition.works)[0]).key);
    let work: Record<string, unknown> = {};
    if (workKey) {
      try { work = asObject(await this.requestJson(new URL(`https://openlibrary.org${workKey}.json`))); } catch { work = {}; }
    }
    const covers = numberArray(edition.covers).length > 0 ? numberArray(edition.covers) : numberArray(work.covers);
    const values = compact({
      title: stringValue(edition.title),
      subtitle: stringValue(edition.subtitle),
      creators: authors.filter((author): author is Creator => author !== null),
      publisher: stringArray(edition.publishers)[0],
      publicationDate: stringValue(edition.publish_date),
      isbn10: stringArray(edition.isbn_10)[0],
      isbn13: stringArray(edition.isbn_13)[0],
      language: stringValue(asObject(asArray(edition.languages)[0]).key)?.split("/").at(-1),
      pageCount: numberValue(edition.number_of_pages),
      subjects: stringArray(work.subjects).slice(0, 50),
      description: descriptionValue(work.description),
      coverUrl: covers[0] ? `https://covers.openlibrary.org/b/id/${covers[0]}-L.jpg` : undefined
    });
    return [candidate("open-library", stringValue(edition.key) ?? isbn, values)];
  }
}

export class GoogleBooksAdapter {
  public constructor(private readonly requestJson: JsonRequest) {}

  public async search(query: MetadataEnrichmentQuery): Promise<EnrichmentCandidate[]> {
    const terms = query.isbn ? `isbn:${normalizeIsbn(query.isbn)}` : `intitle:${query.title ?? ""}${query.author ? ` inauthor:${query.author}` : ""}`;
    const url = new URL("https://www.googleapis.com/books/v1/volumes");
    url.searchParams.set("q", terms);
    url.searchParams.set("maxResults", "8");
    const payload = asObject(await this.requestJson(url));
    return asArray(payload.items).map((raw) => {
      const item = asObject(raw);
      const info = asObject(item.volumeInfo);
      const identifiers = asArray(info.industryIdentifiers).map(asObject);
      const values = compact({
        title: stringValue(info.title),
        subtitle: stringValue(info.subtitle),
        creators: stringArray(info.authors).map(authorCreator),
        publisher: stringValue(info.publisher),
        publicationDate: stringValue(info.publishedDate),
        year: yearFromDate(stringValue(info.publishedDate)),
        language: stringValue(info.language),
        pageCount: numberValue(info.pageCount),
        subjects: stringArray(info.categories),
        description: stringValue(info.description),
        isbn10: identifier(identifiers, "ISBN_10"),
        isbn13: identifier(identifiers, "ISBN_13"),
        coverUrl: httpsUrl(stringValue(asObject(info.imageLinks).thumbnail))
      });
      return candidate("google-books", stringValue(item.id) ?? JSON.stringify(values), values);
    }).filter((item) => item.title.length > 0);
  }
}

export class CrossrefAdapter {
  public constructor(private readonly requestJson: JsonRequest) {}

  public async search(query: MetadataEnrichmentQuery): Promise<EnrichmentCandidate[]> {
    const url = query.doi
      ? new URL(`https://api.crossref.org/works/${encodeURIComponent(normalizeDoi(query.doi))}`)
      : new URL("https://api.crossref.org/works");
    if (!query.doi) {
      url.searchParams.set("query.bibliographic", [query.title, query.author].filter(Boolean).join(" "));
      url.searchParams.set("rows", "8");
    }
    url.searchParams.set("mailto", "metadata@memora.local");
    const payload = asObject(await this.requestJson(url));
    const message = asObject(payload.message);
    const items = query.doi ? [message] : asArray(message.items).map(asObject);
    return items.map((item) => {
      const publicationDate = crossrefDate(item);
      const values = compact({
        title: stringArray(item.title)[0],
        subtitle: stringArray(item.subtitle)[0],
        creators: asArray(item.author).map((raw) => crossrefCreator(asObject(raw))).filter((creator): creator is Creator => creator !== null),
        doi: stringValue(item.DOI)?.toLowerCase(),
        venue: stringArray(item["container-title"])[0],
        publicationDate,
        year: yearFromDate(publicationDate),
        publisher: stringValue(item.publisher),
        volume: stringValue(item.volume),
        issue: stringValue(item.issue),
        pages: pageRange(stringValue(item.page)),
        abstract: stripMarkup(stringValue(item.abstract)),
        keywords: stringArray(item.subject)
      });
      return candidate("crossref", stringValue(item.DOI) ?? JSON.stringify(values), values);
    }).filter((item) => item.title.length > 0);
  }
}

function candidate(provider: Provider, externalId: string, values: Record<string, unknown>): EnrichmentCandidate {
  const title = typeof values.title === "string" ? values.title : "";
  const creators = Array.isArray(values.creators) ? values.creators as Creator[] : [];
  const provenance = Object.fromEntries(Object.keys(values).map((key) => [key, { source: "enriched" as const, provider }]));
  return EnrichmentCandidateSchema.parse({
    id: createHash("sha256").update(`${provider}:${externalId}`).digest("hex").slice(0, 24),
    provider,
    title,
    creators,
    ...(typeof values.edition === "string" ? { edition: values.edition } : {}),
    ...(typeof values.year === "number" ? { year: values.year } : {}),
    ...(typeof values.coverUrl === "string" ? { coverUrl: values.coverUrl } : {}),
    values,
    provenance
  });
}

function createCacheKey(query: MetadataEnrichmentQuery): string {
  return createHash("sha256").update(JSON.stringify({
    sourceType: query.sourceType,
    isbn: query.isbn ? normalizeIsbn(query.isbn) : undefined,
    doi: query.doi ? normalizeDoi(query.doi).toLowerCase() : undefined,
    title: query.title?.trim().toLocaleLowerCase(),
    author: query.author?.trim().toLocaleLowerCase()
  })).digest("hex");
}

function validateCoverUrl(value: string): URL {
  const url = new URL(value);
  const host = url.hostname.toLowerCase();
  const allowed = host === "covers.openlibrary.org" || host === "books.google.com"
    || host.endsWith(".googleusercontent.com");
  if (url.protocol !== "https:" || !allowed || url.username || url.password) throw new Error("metadata_cover_url_not_allowed");
  return url;
}

function extensionForMimeType(value: string): string | null {
  return ({ "image/jpeg": ".jpg", "image/png": ".png", "image/webp": ".webp", "image/gif": ".gif" } as Record<string, string>)[value] ?? null;
}

function asObject(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function asArray(value: unknown): unknown[] { return Array.isArray(value) ? value : []; }
function stringArray(value: unknown): string[] { return asArray(value).filter((item): item is string => typeof item === "string" && item.length > 0); }
function numberArray(value: unknown): number[] { return asArray(value).map(Number).filter((item) => Number.isFinite(item)); }
function stringValue(value: unknown): string | undefined { return typeof value === "string" && value.trim() ? value.trim() : undefined; }
function numberValue(value: unknown): number | undefined { const number = Number(value); return Number.isFinite(number) ? number : undefined; }
function authorCreator(name: string): Creator { return { name, role: "author" }; }
function identifier(values: Record<string, unknown>[], type: string): string | undefined {
  return stringValue(values.find((entry) => entry.type === type)?.identifier);
}
function descriptionValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : stringValue(asObject(value).value);
}
function yearFromDate(value: string | undefined): number | undefined { const year = Number(value?.slice(0, 4)); return year >= 1000 && year <= 9999 ? year : undefined; }
function httpsUrl(value: string | undefined): string | undefined { return value ? value.replace(/^http:/, "https:") : undefined; }
function compact(value: Record<string, unknown>): Record<string, unknown> { return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined && item !== null && item !== "")); }
function pageRange(value: string | undefined): { start: string; end?: string } | undefined {
  if (!value) return undefined;
  const [start, end] = value.split(/\s*[-–]\s*/, 2);
  return start ? { start, ...(end ? { end } : {}) } : undefined;
}
function crossrefCreator(value: Record<string, unknown>): Creator | null {
  const name = [stringValue(value.given), stringValue(value.family)].filter(Boolean).join(" ");
  if (!name) return null;
  const affiliation = stringValue(asObject(asArray(value.affiliation)[0]).name);
  const orcid = stringValue(value.ORCID)?.split("/").at(-1);
  return { name, role: "author", ...(affiliation ? { affiliation } : {}), ...(orcid ? { externalIds: { orcid } } : {}) };
}
function crossrefDate(value: Record<string, unknown>): string | undefined {
  const date = asArray(asObject(value.published)["date-parts"])[0];
  return Array.isArray(date) ? date.map(Number).filter(Number.isFinite).map((part, index) => index === 0 ? String(part) : String(part).padStart(2, "0")).join("-") : undefined;
}
function stripMarkup(value: string | undefined): string | undefined { return value?.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim(); }
function safeErrorCode(error: unknown): string { const value = error instanceof Error ? error.message : String(error); return /^[a-zA-Z0-9_.:-]{1,120}$/.test(value) ? value : "metadata_enrichment_error"; }
