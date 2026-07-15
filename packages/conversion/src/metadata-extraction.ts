import { posix } from "node:path";

import {
  SourceDescriptorDraftSchema,
  isbn10To13,
  isValidIsbn10,
  isValidIsbn13,
  normalizeDoi,
  normalizeIsbn,
  type Creator,
  type MetadataFieldProvenance,
  type SourceDescriptorDraft,
  type SourceItemType
} from "@app/domain";
import { unzipSync } from "fflate";
import { DOMParser } from "linkedom";
import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";

import type { MarkdownConversionResult } from "./types.js";

export interface FileMetadataExtractionInput {
  sourceType: SourceItemType;
  data?: Uint8Array;
  sourcePath?: string;
  fileName: string;
  mimeType?: string;
  conversion?: MarkdownConversionResult;
}

const MAX_EPUB_ENTRIES = 4_000;
const MAX_EPUB_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_EPUB_TOTAL_BYTES = 512 * 1024 * 1024;

export async function extractFileMetadata(input: FileMetadataExtractionInput): Promise<SourceDescriptorDraft> {
  const fallbackTitle = cleanFileTitle(input.fileName);
  const values: Record<string, unknown> = { title: fallbackTitle };
  const provenance: Record<string, MetadataFieldProvenance> = {
    title: { source: "extracted", evidence: "file-name" }
  };
  const warnings: string[] = [];
  let coverData: SourceDescriptorDraft["coverData"];

  try {
    if (isEpub(input) && input.data?.byteLength) {
      const epub = extractEpubMetadata(input.data);
      mergeExtracted(values, provenance, epub.values, "epub-opf");
      coverData = epub.coverData;
    } else if (isPdf(input)) {
      const pdf = await extractPdfMetadata(input);
      mergeExtracted(values, provenance, pdf, "pdf-info");
    }
  } catch (error) {
    warnings.push(`metadata.extraction.failed:${error instanceof Error ? error.message : String(error)}`);
  }

  if (input.conversion) {
    const converted = extractConvertedMetadata(input.sourceType, input.conversion);
    for (const [key, value] of Object.entries(converted.values)) {
      if (values[key] === undefined || isWeakTitle(String(values[key]))) {
        values[key] = value;
        provenance[key] = { source: "extracted", evidence: converted.evidence[key] ?? "docling" };
      }
    }
    warnings.push(...input.conversion.warnings.map((warning) => warning.messageKey));
  }

  normalizeIdentifiers(values, provenance);
  return SourceDescriptorDraftSchema.parse({
    sourceType: input.sourceType,
    values,
    provenance,
    warnings: [...new Set(warnings)],
    ...(coverData ? { coverData } : {})
  });
}

export function descriptorDraftFromWebMetadata(input: {
  title: string;
  url?: string;
  metadata: Record<string, unknown>;
}): SourceDescriptorDraft {
  const values: Record<string, unknown> = { title: input.title, ...(input.url ? { url: input.url } : {}) };
  const mapping: Record<string, string> = {
    author: "creators",
    description: "description",
    published: "publicationDate",
    site: "siteName",
    siteName: "siteName",
    image: "imageUrl"
  };
  const provenance: Record<string, MetadataFieldProvenance> = {};
  for (const [sourceKey, targetKey] of Object.entries(mapping)) {
    const raw = input.metadata[sourceKey];
    if (raw === undefined || raw === null || raw === "") continue;
    values[targetKey] = targetKey === "creators" ? creatorsFromUnknown(raw, "author") : raw;
    provenance[targetKey] = { source: "extracted", evidence: "defuddle" };
  }
  provenance.title = { source: "extracted", evidence: "defuddle" };
  if (input.url) provenance.url = { source: "extracted", evidence: "defuddle" };
  return SourceDescriptorDraftSchema.parse({ sourceType: "WebArticle", values, provenance, warnings: [] });
}

export function descriptorDraftFromVideoMetadata(input: {
  title: string;
  url?: string;
  metadata: Record<string, unknown>;
}): SourceDescriptorDraft {
  const values: Record<string, unknown> = { title: input.title, ...(input.url ? { url: input.url } : {}) };
  const mappings = [
    ["channel", "channel"], ["channelName", "channel"], ["durationSeconds", "durationSeconds"],
    ["publishedAt", "publicationDate"], ["platform", "platform"], ["videoId", "videoId"],
    ["thumbnail", "thumbnailUrl"], ["thumbnailUrl", "thumbnailUrl"]
  ] as const;
  const provenance: Record<string, MetadataFieldProvenance> = {
    title: { source: "extracted", evidence: "youtubei" }
  };
  for (const [sourceKey, targetKey] of mappings) {
    const value = input.metadata[sourceKey];
    if (value === undefined || value === null || value === "") continue;
    values[targetKey] = value;
    provenance[targetKey] = { source: "extracted", evidence: "youtubei" };
  }
  const channel = values.channel;
  if (typeof channel === "string") {
    values.creators = [{ name: channel, role: "channel" } satisfies Creator];
    provenance.creators = { source: "extracted", evidence: "youtubei" };
  }
  return SourceDescriptorDraftSchema.parse({ sourceType: "Video", values, provenance, warnings: [] });
}

export function cleanFileTitle(fileName: string): string {
  const withoutExtension = fileName.replace(/\.[^.]+$/, "");
  return withoutExtension
    .replace(/[_]+/g, " ")
    .replace(/\s+-\s+/g, " — ")
    .replace(/\s{2,}/g, " ")
    .trim() || "Untitled";
}

function extractEpubMetadata(data: Uint8Array): {
  values: Record<string, unknown>;
  coverData?: SourceDescriptorDraft["coverData"];
} {
  const entries = readSafeEpubEntries(data);
  const container = parseXml(decodeRequired(entries, "META-INF/container.xml"));
  const rootfile = container.querySelector("rootfile")?.getAttribute("full-path");
  if (!rootfile) throw new Error("epub_container_missing_rootfile");
  const opfPath = safeArchivePath(rootfile);
  const opf = parseXml(decodeRequired(entries, opfPath));
  const metadata = opf.querySelector("metadata");
  if (!metadata) throw new Error("epub_opf_missing_metadata");
  const values: Record<string, unknown> = {};
  const text = (name: string) => elementsByLocalName(metadata, name)[0]?.textContent?.trim() || undefined;
  const texts = (name: string) => elementsByLocalName(metadata, name)
    .map((element) => element.textContent?.trim())
    .filter((value): value is string => Boolean(value));

  assign(values, "title", text("title"));
  assign(values, "publisher", text("publisher"));
  assign(values, "language", text("language"));
  assign(values, "publicationDate", text("date"));
  assign(values, "description", text("description"));
  const subjects = texts("subject");
  if (subjects.length > 0) {
    values.subjects = subjects;
    values.tags = subjects;
  }
  const creators = elementsByLocalName(metadata, "creator")
    .map((element) => creatorFromEpub(element))
    .filter((creator): creator is Creator => creator !== null);
  if (creators.length > 0) values.creators = creators;

  for (const identifier of texts("identifier")) {
    const normalized = normalizeIsbn(identifier);
    if (isValidIsbn10(normalized)) values.isbn10 = normalized;
    if (isValidIsbn13(normalized)) values.isbn13 = normalized;
  }

  const opfDirectory = posix.dirname(opfPath);
  const manifestItems = [...opf.querySelectorAll("manifest item")];
  let coverItem = manifestItems.find((item) => (item.getAttribute("properties") ?? "").split(/\s+/).includes("cover-image"));
  if (!coverItem) {
    const coverId = [...metadata.querySelectorAll("meta")]
      .find((item) => item.getAttribute("name") === "cover")?.getAttribute("content");
    coverItem = coverId ? manifestItems.find((item) => item.getAttribute("id") === coverId) : undefined;
  }
  const coverHref = coverItem?.getAttribute("href");
  const coverPath = coverHref ? resolveArchivePath(opfDirectory, coverHref) : undefined;
  const coverBytes = coverPath ? entries[coverPath] : undefined;
  return {
    values,
    ...(coverBytes ? {
      coverData: {
        data: new Uint8Array(coverBytes),
        mimeType: coverItem?.getAttribute("media-type") ?? "application/octet-stream",
        fileName: posix.basename(coverPath!)
      }
    } : {})
  };
}

async function extractPdfMetadata(input: FileMetadataExtractionInput): Promise<Record<string, unknown>> {
  if (!input.sourcePath && !input.data?.byteLength) return {};
  const loadingTask = getDocument(input.sourcePath
    ? { url: input.sourcePath, useSystemFonts: false }
    : { data: new Uint8Array(input.data!), useSystemFonts: false });
  const document = await loadingTask.promise;
  try {
    const metadata = await document.getMetadata();
    const info = metadata.info as Record<string, unknown>;
    const xmp = metadata.metadata;
    const read = (...names: string[]): string | undefined => {
      for (const name of names) {
        const infoValue = info[name];
        if (typeof infoValue === "string" && infoValue.trim()) return infoValue.trim();
        const xmpValue = xmp?.get(name);
        if (typeof xmpValue === "string" && xmpValue.trim()) return xmpValue.trim();
      }
      return undefined;
    };
    const values: Record<string, unknown> = {};
    const title = read("Title", "dc:title");
    if (title && !isWeakTitle(title)) values.title = title;
    const author = read("Author", "dc:creator");
    if (author) values.creators = creatorsFromUnknown(author, "author");
    assign(values, "description", read("Subject", "dc:description"));
    const keywords = splitKeywords(read("Keywords", "pdf:Keywords"));
    if (keywords.length > 0) {
      values.tags = keywords;
      values.keywords = keywords;
    }
    assign(values, "creationDate", normalizePdfDate(read("CreationDate", "xmp:CreateDate")));
    return values;
  } finally {
    await loadingTask.destroy();
  }
}

function extractConvertedMetadata(sourceType: SourceItemType, conversion: MarkdownConversionResult): {
  values: Record<string, unknown>;
  evidence: Record<string, string>;
} {
  const values: Record<string, unknown> = {};
  const evidence: Record<string, string> = {};
  const metadata = conversion.metadata;
  const title = readString(metadata, "title") ?? firstHeading(conversion);
  if (title && !isWeakTitle(title)) {
    values.title = title;
    evidence.title = readString(metadata, "title") ? "docling" : "pdf-page-scan";
  }
  const author = readString(metadata, "author");
  if (author) {
    values.creators = creatorsFromUnknown(author, "author");
    evidence.creators = conversion.engine === "defuddle" ? "defuddle" : "docling";
  }
  for (const [sourceKey, targetKey] of [["description", "description"], ["published", "publicationDate"], ["language", "language"]] as const) {
    const value = readString(metadata, sourceKey);
    if (value) {
      values[targetKey] = value;
      evidence[targetKey] = conversion.engine === "defuddle" ? "defuddle" : "docling";
    }
  }
  const pageText = conversion.blocks
    .filter((block) => block.page === undefined || block.page <= 10)
    .map((block) => block.text)
    .join("\n") || conversion.markdown.slice(0, 30_000);
  const isbnCandidates = pageText.match(/(?:ISBN(?:-1[03])?\s*:?\s*)?(?:97[89][\s-]?)?\d[\d\s-]{7,15}[\dXx]/g) ?? [];
  for (const candidate of isbnCandidates) {
    const isbn = normalizeIsbn(candidate.replace(/^ISBN(?:-1[03])?\s*:?\s*/i, ""));
    if (isValidIsbn10(isbn)) {
      values.isbn10 = isbn;
      evidence.isbn10 = "pdf-page-scan";
    } else if (isValidIsbn13(isbn)) {
      values.isbn13 = isbn;
      evidence.isbn13 = "pdf-page-scan";
    }
  }
  const doi = pageText.match(/\b10\.\d{4,9}\/[-._;()/:A-Z0-9]+\b/i)?.[0];
  if (doi && ["AcademicPaper", "StandaloneArticle"].includes(sourceType)) {
    values.doi = normalizeDoi(doi.replace(/[.,;]$/, ""));
    evidence.doi = "pdf-page-scan";
  }
  return { values, evidence };
}

function normalizeIdentifiers(values: Record<string, unknown>, provenance: Record<string, MetadataFieldProvenance>): void {
  if (typeof values.isbn10 === "string" && values.isbn13 === undefined) {
    const isbn13 = isbn10To13(values.isbn10);
    if (isbn13) {
      values.isbn13 = isbn13;
      provenance.isbn13 = provenance.isbn10 ?? { source: "extracted", evidence: "isbn-normalization" };
    }
  }
  if (typeof values.doi === "string") values.doi = normalizeDoi(values.doi);
}

function mergeExtracted(
  target: Record<string, unknown>,
  provenance: Record<string, MetadataFieldProvenance>,
  incoming: Record<string, unknown>,
  evidence: string
): void {
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined) continue;
    target[key] = value;
    provenance[key] = { source: "extracted", evidence };
  }
}

function creatorsFromUnknown(value: unknown, role: Creator["role"]): Creator[] {
  const names = Array.isArray(value) ? value : typeof value === "string" ? value.split(/\s*(?:;|\band\b|\be\b)\s*/i) : [];
  return names
    .map((name) => typeof name === "string" ? name.trim() : "")
    .filter(Boolean)
    .map((name) => ({ name, role }));
}

function creatorFromEpub(element: Element): Creator | null {
  const name = element.textContent?.trim();
  if (!name) return null;
  const roleValue = element.getAttribute("opf:role") ?? element.getAttribute("role") ?? "author";
  const roleMap: Record<string, Creator["role"]> = {
    aut: "author", author: "author", edt: "editor", editor: "editor", trl: "translator",
    translator: "translator", com: "organizer", organizer: "organizer"
  };
  return { name, role: roleMap[roleValue.toLowerCase()] ?? "contributor" };
}

function readSafeEpubEntries(data: Uint8Array): Record<string, Uint8Array> {
  let count = 0;
  let total = 0;
  return unzipSync(data, { filter: (file) => {
    count += 1;
    if (count > MAX_EPUB_ENTRIES) throw new Error("epub_entry_limit_exceeded");
    safeArchivePath(file.name);
    if (!Number.isSafeInteger(file.originalSize) || file.originalSize < 0
        || file.originalSize > MAX_EPUB_ENTRY_BYTES) throw new Error("epub_entry_size_limit_exceeded");
    total += file.originalSize;
    if (!Number.isSafeInteger(total) || total > MAX_EPUB_TOTAL_BYTES) throw new Error("epub_total_size_limit_exceeded");
    return true;
  } });
}

function parseXml(value: string) {
  const document = new DOMParser().parseFromString(value, "text/xml");
  if (!document) throw new Error("invalid_xml");
  return document;
}

function elementsByLocalName(root: Element, name: string): Element[] {
  return [...root.querySelectorAll("*")].filter((element) =>
    element.localName.toLowerCase().split(":").at(-1) === name.toLowerCase()
  );
}

function decodeRequired(entries: Record<string, Uint8Array>, path: string): string {
  const bytes = entries[safeArchivePath(path)];
  if (!bytes) throw new Error(`epub_missing_entry:${path}`);
  return new TextDecoder().decode(bytes);
}

function safeArchivePath(value: string): string {
  const normalized = posix.normalize(value.replace(/\\/g, "/")).replace(/^\.\//, "");
  if (!normalized || normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) {
    throw new Error("epub_unsafe_path");
  }
  return normalized;
}

function resolveArchivePath(base: string, value: string): string {
  return safeArchivePath(posix.join(base, decodeURIComponent(value.split("#", 1)[0] ?? "")));
}

function isEpub(input: FileMetadataExtractionInput): boolean {
  return input.mimeType === "application/epub+zip" || input.fileName.toLowerCase().endsWith(".epub");
}

function isPdf(input: FileMetadataExtractionInput): boolean {
  return input.mimeType === "application/pdf" || input.fileName.toLowerCase().endsWith(".pdf");
}

function firstHeading(conversion: MarkdownConversionResult): string | undefined {
  const block = conversion.blocks.find((candidate) => /title|heading|section_header/i.test(candidate.type) && candidate.text.trim());
  return block?.text.trim() ?? conversion.markdown.match(/^#{1,2}\s+(.+)$/m)?.[1]?.trim();
}

function isWeakTitle(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return !normalized || /^microsoft word\b/.test(normalized)
    || /^(document|untitled|final)(?:\s*[-_.—].*)?$/.test(normalized)
    || /\.(?:docx?|pdf)$/i.test(normalized);
}

function splitKeywords(value: string | undefined): string[] {
  return value?.split(/[,;]\s*/).map((item) => item.trim()).filter(Boolean) ?? [];
}

function normalizePdfDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = value.match(/^D:(\d{4})(\d{2})?(\d{2})?/);
  return match ? [match[1], match[2], match[3]].filter(Boolean).join("-") : value;
}

function readString(metadata: Record<string, unknown>, key: string): string | undefined {
  const value = metadata[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function assign(target: Record<string, unknown>, key: string, value: unknown): void {
  if (value !== undefined && value !== null && value !== "") target[key] = value;
}
