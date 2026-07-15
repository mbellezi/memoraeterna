import { createHash } from "node:crypto";
import { posix } from "node:path";

import type { DocumentDivisionCandidate, DocumentDivisionKind } from "@app/domain";
import { unzipSync } from "fflate";
import { DOMParser } from "linkedom";
import { getDocument, type PDFDocumentProxy } from "pdfjs-dist/legacy/build/pdf.mjs";

import type { ConversionBlock, MarkdownConversionResult } from "./types.js";

export interface StructureDetectionResult {
  format: "epub" | "pdf" | "markdown" | "other";
  detectorVersion: string;
  overallConfidence: number;
  divisions: DocumentDivisionCandidate[];
  warnings: string[];
  metadata: Record<string, unknown>;
}

export interface StructureDetectionInput {
  data?: Uint8Array;
  sourcePath?: string;
  fileName?: string;
  mimeType?: string;
  conversion: MarkdownConversionResult;
  documentKind: "book" | "periodical" | "paper" | "other";
}

const MAX_EPUB_ENTRIES = 4_000;
const MAX_EPUB_ENTRY_BYTES = 32 * 1024 * 1024;
const MAX_EPUB_TOTAL_BYTES = 512 * 1024 * 1024;

export async function detectDocumentStructure(input: StructureDetectionInput): Promise<StructureDetectionResult> {
  const extension = input.fileName?.toLowerCase().split(".").pop();
  if (input.data && (extension === "epub" || input.mimeType === "application/epub+zip")) {
    return detectEpubStructure(input.data, input.documentKind);
  }
  if (extension === "pdf" || input.mimeType === "application/pdf") {
    return detectPdfStructure(input.conversion, input.documentKind, input.data, input.sourcePath);
  }
  return detectMarkdownStructure(input.conversion.markdown, input.documentKind);
}

export function detectEpubStructure(
  data: Uint8Array,
  documentKind: StructureDetectionInput["documentKind"] = "book"
): StructureDetectionResult {
  const entries = readSafeEpubEntries(data);
  const container = decodeRequired(entries, "META-INF/container.xml");
  const containerDocument = parseXml(container);
  const rootfile = containerDocument.querySelector("rootfile")?.getAttribute("full-path");
  if (!rootfile) throw new Error("epub_container_missing_rootfile");
  const normalizedRootfile = safeArchivePath(rootfile);
  const opf = parseXml(decodeRequired(entries, normalizedRootfile));
  const opfDirectory = posix.dirname(normalizedRootfile);
  const manifest = new Map<string, { href: string; mediaType: string; properties: string }>();
  for (const item of opf.querySelectorAll("manifest item")) {
    const id = item.getAttribute("id");
    const href = item.getAttribute("href");
    if (!id || !href) continue;
    manifest.set(id, {
      href: resolveArchivePath(opfDirectory, href),
      mediaType: item.getAttribute("media-type") ?? "",
      properties: item.getAttribute("properties") ?? ""
    });
  }
  const spine = [...opf.querySelectorAll("spine itemref")]
    .map((item) => item.getAttribute("idref"))
    .filter((id): id is string => Boolean(id))
    .map((id) => manifest.get(id)?.href)
    .filter((href): href is string => Boolean(href));
  const navItem = [...manifest.values()].find((item) => item.properties.split(/\s+/).includes("nav"));
  const ncxId = opf.querySelector("spine")?.getAttribute("toc");
  const ncxItem = ncxId ? manifest.get(ncxId) : [...manifest.values()].find((item) => item.mediaType === "application/x-dtbncx+xml");
  const navigation = navItem
    ? readEpub3Navigation(entries, navItem.href, opfDirectory)
    : ncxItem
      ? readNcxNavigation(entries, ncxItem.href, opfDirectory)
      : [];
  const warnings: string[] = [];
  let rawEntries = navigation;
  if (rawEntries.length === 0) {
    warnings.push("structure.epub.navigationMissing");
    rawEntries = spine.map((href, index) => ({
      href, fragment: null, title: fileTitle(href), level: 0, parentIndex: null, position: index,
      evidenceSource: "epub-spine", score: 0.55
    }));
  }
  const contentByHref = new Map<string, string>();
  for (const href of new Set(rawEntries.map((entry) => stripFragment(entry.href)))) {
    const bytes = entries[href];
    if (!bytes) continue;
    const document = parseXml(new TextDecoder().decode(bytes));
    document.querySelectorAll("script, style, iframe, object, embed").forEach((element: Element) => element.remove());
    contentByHref.set(href, document.querySelector("body")?.textContent?.replace(/\s+/g, " ").trim() ?? "");
  }
  let markdownOffset = 0;
  const ids = rawEntries.map((entry, index) => stableUuid(`epub:${entry.href}#${entry.fragment ?? ""}:${index}`));
  const divisions = rawEntries.map((entry, index): DocumentDivisionCandidate => {
    const href = stripFragment(entry.href);
    const text = contentByHref.get(href) ?? "";
    const start = markdownOffset;
    markdownOffset += text.length;
    const kind = classifyDivision(entry.title, documentKind, entry.level);
    return {
      id: ids[index]!,
      parentId: entry.parentIndex === null ? null : ids[entry.parentIndex] ?? null,
      kind,
      title: entry.title || fileTitle(href),
      level: entry.level,
      position: entry.position,
      startSelector: { format: "epub", href, ...(entry.fragment ? { fragment: entry.fragment } : {}) },
      endSelector: { format: "epub", href, textLength: text.length },
      markdownStart: start,
      markdownEnd: markdownOffset,
      confidence: entry.score,
      evidence: [{ kind: "native-navigation", source: entry.evidenceSource, score: entry.score, metadata: { href } }],
      reviewStatus: entry.score >= 0.6 ? "accepted" : "proposed",
      isProcessable: isDefaultProcessable(kind, entry.level),
      metadata: { spineIndex: spine.indexOf(href) }
    };
  });
  return {
    format: "epub",
    detectorVersion: "epub-structure-v1",
    overallConfidence: navigation.length > 0 ? 0.95 : 0.55,
    divisions,
    warnings,
    metadata: { rootfile: normalizedRootfile, spineLength: spine.length, navigationKind: navItem ? "epub3-nav" : ncxItem ? "epub2-ncx" : "spine" }
  };
}

export async function detectPdfStructure(
  conversion: MarkdownConversionResult,
  documentKind: StructureDetectionInput["documentKind"] = "other",
  data?: Uint8Array,
  sourcePath?: string
): Promise<StructureDetectionResult> {
  const headingBlocks = conversion.blocks.filter(isHeadingBlock);
  const doclingDivisions = divisionsFromBlocks(headingBlocks, conversion.markdown.length, documentKind, "docling-heading");
  let native: Awaited<ReturnType<typeof readPdfNavigation>> | null = null;
  if (data?.byteLength || sourcePath) {
    try { native = await readPdfNavigation(sourcePath ?? data!); } catch { native = null; }
  }
  const divisions = native?.outline.length
    ? divisionsFromPdfOutline(native.outline, native.pageCount, native.pageLabels, headingBlocks, conversion.markdown.length, documentKind)
    : doclingDivisions;
  const warnings = divisions.length === 0 ? ["structure.pdf.noReliableDivisions"] : [];
  return {
    format: "pdf",
    detectorVersion: "pdf-outline-docling-v2",
    overallConfidence: native?.outline.length ? 0.88 : divisions.length > 0 ? 0.65 : 0.2,
    divisions,
    warnings,
    metadata: { blockCount: conversion.blocks.length, headingCount: headingBlocks.length,
      outlineCount: native?.outline.length ?? 0, pageCount: native?.pageCount, pageLabels: native?.pageLabels ?? [] }
  };
}

interface PdfOutlineEntry { title: string; page: number; level: number; parentIndex: number | null; position: number }

async function readPdfNavigation(input: Uint8Array | string) {
  const loadingTask = getDocument(typeof input === "string"
    ? { url: input, useSystemFonts: false }
    : { data: new Uint8Array(input), useSystemFonts: false });
  const document = await loadingTask.promise;
  try {
    const [outline, pageLabels] = await Promise.all([document.getOutline(), document.getPageLabels()]);
    const flattened: PdfOutlineEntry[] = [];
    const visit = async (items: Awaited<ReturnType<PDFDocumentProxy["getOutline"]>>, level: number, parentIndex: number | null) => {
      for (const item of items) {
        const page = await resolvePdfDestinationPage(document, item.dest);
        let currentParent = parentIndex;
        if (page !== null && item.title.trim()) {
          flattened.push({ title: item.title.trim(), page, level, parentIndex, position: flattened.length });
          currentParent = flattened.length - 1;
        }
        if (item.items.length > 0) await visit(item.items, level + 1, currentParent);
      }
    };
    await visit(outline, 0, null);
    return { outline: flattened, pageLabels: pageLabels ?? [], pageCount: document.numPages };
  } finally {
    await loadingTask.destroy();
  }
}

async function resolvePdfDestinationPage(document: PDFDocumentProxy, destination: string | unknown[] | null): Promise<number | null> {
  const resolved = typeof destination === "string" ? await document.getDestination(destination) : destination;
  const reference = resolved?.[0];
  if (typeof reference === "number") return reference + 1;
  if (reference && typeof reference === "object" && "num" in reference && "gen" in reference) {
    return (await document.getPageIndex(reference as { num: number; gen: number })) + 1;
  }
  return null;
}

function divisionsFromPdfOutline(
  outline: PdfOutlineEntry[], pageCount: number, pageLabels: string[], blocks: ConversionBlock[], markdownLength: number,
  documentKind: StructureDetectionInput["documentKind"]
): DocumentDivisionCandidate[] {
  const ids = outline.map((entry) => stableUuid(`pdf-outline:${entry.page}:${entry.title}:${entry.position}`));
  return outline.map((entry, index) => {
    const nextPage = outline.slice(index + 1).find((candidate) => candidate.page > entry.page)?.page;
    const matchingHeading = blocks.find((block) => block.page === entry.page && similarTitle(block.text, entry.title));
    const pageStartBlock = matchingHeading ?? blocks.find((block) => block.page !== undefined && block.page >= entry.page);
    const nextHeading = nextPage ? blocks.find((block) => block.page !== undefined && block.page >= nextPage) : undefined;
    const score = matchingHeading ? 0.97 : 0.86;
    const kind = classifyDivision(entry.title, documentKind, entry.level);
    return {
      id: ids[index]!, parentId: entry.parentIndex === null ? null : ids[entry.parentIndex] ?? null,
      kind, title: entry.title, level: entry.level, position: entry.position,
      startSelector: { format: "pdf", page: entry.page, ...(pageLabels[entry.page - 1] ? { pageLabel: pageLabels[entry.page - 1] } : {}), bookmark: entry.title,
        ...(matchingHeading ? { blockId: matchingHeading.id } : {}) },
      endSelector: { format: "pdf", page: nextPage ? nextPage - 1 : pageCount,
        ...(pageLabels[(nextPage ? nextPage - 1 : pageCount) - 1] ? { pageLabel: pageLabels[(nextPage ? nextPage - 1 : pageCount) - 1] } : {}) },
      startPage: entry.page, endPage: nextPage ? Math.max(entry.page, nextPage - 1) : pageCount,
      markdownStart: pageStartBlock?.markdownStart ?? 0, markdownEnd: nextHeading?.markdownStart ?? markdownLength,
      confidence: score,
      evidence: [
        { kind: "native-outline", source: "pdfjs-outline", score: 0.86, metadata: { page: entry.page, ...(pageLabels[entry.page - 1] ? { pageLabel: pageLabels[entry.page - 1] } : {}) } },
        ...(matchingHeading ? [{ kind: "heading-agreement", source: "docling-heading", score: 0.97,
          metadata: { blockId: matchingHeading.id, page: matchingHeading.page } }] : [])
      ],
      reviewStatus: score >= 0.9 ? "accepted" : "proposed", isProcessable: isDefaultProcessable(kind, entry.level), metadata: {}
    } satisfies DocumentDivisionCandidate;
  });
}

function similarTitle(left: string, right: string): boolean {
  const normalize = (value: string) => value.normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/\W+/g, " ").trim().toLowerCase();
  const a = normalize(left); const b = normalize(right);
  return a === b || (a.length > 5 && b.length > 5 && (a.includes(b) || b.includes(a)));
}

export function detectMarkdownStructure(
  markdown: string,
  documentKind: StructureDetectionInput["documentKind"] = "other"
): StructureDetectionResult {
  const headings = [...markdown.matchAll(/^(#{1,6})\s+(.+)$/gm)];
  const divisions = headings.map((match, index): DocumentDivisionCandidate => {
    const start = match.index;
    const end = headings[index + 1]?.index ?? markdown.length;
    const level = match[1]!.length - 1;
    const title = match[2]!.trim();
    const kind = classifyDivision(title, documentKind, level);
    return {
      id: stableUuid(`markdown:${start}:${title}`), parentId: findHeadingParent(headings, index), kind, title,
      level, position: index, startSelector: { format: "markdown", offset: start },
      endSelector: { format: "markdown", offset: end }, markdownStart: start, markdownEnd: end,
      confidence: 0.7, evidence: [{ kind: "heading", source: "markdown", score: 0.7, metadata: { level: level + 1 } }],
      reviewStatus: "accepted", isProcessable: isDefaultProcessable(kind, level), metadata: {}
    };
  });
  return {
    format: "markdown", detectorVersion: "markdown-heading-v1",
    overallConfidence: divisions.length > 0 ? 0.7 : 0.1, divisions,
    warnings: divisions.length > 0 ? [] : ["structure.markdown.noHeadings"], metadata: { headingCount: headings.length }
  };
}

interface EpubNavigationEntry {
  href: string;
  fragment: string | null;
  title: string;
  level: number;
  parentIndex: number | null;
  position: number;
  evidenceSource: string;
  score: number;
}

function readEpub3Navigation(entries: Record<string, Uint8Array>, navPath: string, opfDirectory: string): EpubNavigationEntry[] {
  const document = parseXml(decodeRequired(entries, navPath));
  const nav = [...document.querySelectorAll("nav")].find((element) =>
    (element.getAttribute("epub:type") ?? element.getAttribute("type") ?? "").split(/\s+/).includes("toc")
  ) ?? document.querySelector("nav");
  if (!nav) return [];
  const output: EpubNavigationEntry[] = [];
  const visit = (list: Element, level: number, parentIndex: number | null) => {
    for (const item of list.children) {
      if (item.localName !== "li") continue;
      const anchor = [...item.children].find((child) => child.localName === "a");
      const nested = [...item.children].find((child) => child.localName === "ol");
      let currentParent = parentIndex;
      if (anchor) {
        const rawHref = anchor.getAttribute("href") ?? "";
        const [pathPart, fragment] = rawHref.split("#", 2);
        const href = resolveArchivePath(posix.dirname(navPath), pathPart || navPath);
        output.push({ href, fragment: fragment ?? null, title: anchor.textContent?.replace(/\s+/g, " ").trim() ?? "",
          level, parentIndex, position: output.length, evidenceSource: "epub3-nav", score: 0.98 });
        currentParent = output.length - 1;
      }
      if (nested) visit(nested, level + 1, currentParent);
    }
  };
  const list = nav.querySelector("ol");
  if (list) visit(list, 0, null);
  void opfDirectory;
  return output;
}

function readNcxNavigation(entries: Record<string, Uint8Array>, ncxPath: string, opfDirectory: string): EpubNavigationEntry[] {
  const document = parseXml(decodeRequired(entries, ncxPath));
  const output: EpubNavigationEntry[] = [];
  const visit = (points: Element[], level: number, parentIndex: number | null) => {
    for (const point of points) {
      const src = point.querySelector("content")?.getAttribute("src") ?? "";
      const [pathPart, fragment] = src.split("#", 2);
      output.push({ href: resolveArchivePath(posix.dirname(ncxPath), pathPart ?? ""), fragment: fragment ?? null,
        title: point.querySelector("navLabel text")?.textContent?.replace(/\s+/g, " ").trim() ?? "",
        level, parentIndex, position: output.length, evidenceSource: "epub2-ncx", score: 0.94 });
      const current = output.length - 1;
      visit([...point.children].filter((child) => child.localName === "navPoint"), level + 1, current);
    }
  };
  visit([...document.querySelectorAll("navMap > navPoint")], 0, null);
  void opfDirectory;
  return output;
}

function readSafeEpubEntries(data: Uint8Array): Record<string, Uint8Array> {
  const entries = unzipSync(data);
  const names = Object.keys(entries);
  if (names.length > MAX_EPUB_ENTRIES) throw new Error("epub_entry_limit_exceeded");
  let total = 0;
  for (const name of names) {
    safeArchivePath(name);
    const entry = entries[name];
    if (!entry) continue;
    if (entry.byteLength > MAX_EPUB_ENTRY_BYTES) throw new Error("epub_entry_size_limit_exceeded");
    total += entry.byteLength;
    if (total > MAX_EPUB_TOTAL_BYTES) throw new Error("epub_total_size_limit_exceeded");
  }
  return entries;
}

function divisionsFromBlocks(
  blocks: ConversionBlock[],
  markdownLength: number,
  documentKind: StructureDetectionInput["documentKind"],
  evidenceSource: string
): DocumentDivisionCandidate[] {
  return blocks.map((block, index) => {
    const next = blocks[index + 1];
    const level = headingLevel(block.type);
    const kind = classifyDivision(block.text, documentKind, level);
    return {
      id: stableUuid(`block:${block.id}`), parentId: null, kind, title: block.text.trim(), level, position: index,
      startSelector: { format: "pdf", blockId: block.id, markdownOffset: block.markdownStart },
      endSelector: { format: "pdf", blockId: next?.id ?? block.id, markdownOffset: next?.markdownStart ?? markdownLength },
      ...(block.page ? { startPage: block.page } : {}), ...(next?.page ? { endPage: next.page } : block.page ? { endPage: block.page } : {}),
      markdownStart: block.markdownStart, markdownEnd: next?.markdownStart ?? markdownLength,
      confidence: block.confidence ? Math.min(0.85, Math.max(0.4, block.confidence)) : 0.65,
      evidence: [{ kind: "structured-heading", source: evidenceSource, score: block.confidence ?? 0.65,
        metadata: { blockId: block.id, blockType: block.type, ...(block.page ? { page: block.page } : {}) } }],
      reviewStatus: "proposed", isProcessable: isDefaultProcessable(kind, level), metadata: {}
    } satisfies DocumentDivisionCandidate;
  });
}

function classifyDivision(title: string, documentKind: StructureDetectionInput["documentKind"], level: number): DocumentDivisionKind {
  const normalized = title.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();
  if (/^(part|parte)\b/.test(normalized)) return "part";
  if (/^(appendix|apendice|annexe|appendice|apendice)\b/.test(normalized)) return "appendix";
  if (/^(preface|prefacio|foreword|introduzione|avant-propos)\b/.test(normalized)) return "frontmatter";
  if (/^(index|indice|references|referencias|bibliography|bibliografia)\b/.test(normalized)) return "backmatter";
  if (documentKind === "periodical") return level === 0 ? "article" : "subsection";
  if (documentKind === "paper") return level === 0 ? "section" : "subsection";
  if (documentKind === "book" || /^(chapter|capitulo|chapitre|capitolo)\b/.test(normalized)) return level === 0 ? "chapter" : "subsection";
  return level === 0 ? "section" : "subsection";
}

function isDefaultProcessable(kind: DocumentDivisionKind, level: number): boolean {
  return level === 0 && ["chapter", "article", "section", "appendix"].includes(kind);
}

function isHeadingBlock(block: ConversionBlock): boolean {
  return /^(title|section_header|heading|h[1-6])$/i.test(block.type) && block.text.trim().length > 0;
}

function headingLevel(type: string): number {
  const match = /^h([1-6])$/i.exec(type);
  return match ? Number(match[1]) - 1 : type === "title" ? 0 : 1;
}

function findHeadingParent(headings: RegExpMatchArray[], index: number): string | null {
  const level = headings[index]?.[1]?.length ?? 1;
  for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
    const parent = headings[candidate];
    if ((parent?.[1]?.length ?? 7) < level) return stableUuid(`markdown:${parent!.index}:${parent![2]!.trim()}`);
  }
  return null;
}

function parseXml(value: string) {
  return new DOMParser().parseFromString(value, "text/xml");
}

function decodeRequired(entries: Record<string, Uint8Array>, path: string): string {
  const value = entries[safeArchivePath(path)];
  if (!value) throw new Error(`epub_entry_missing:${path}`);
  return new TextDecoder().decode(value);
}

function resolveArchivePath(directory: string, value: string): string {
  return safeArchivePath(posix.normalize(posix.join(directory === "." ? "" : directory, decodeURIComponent(value))));
}

function safeArchivePath(value: string): string {
  const normalized = posix.normalize(value.replace(/\\/g, "/"));
  if (!normalized || normalized.startsWith("/") || normalized === ".." || normalized.startsWith("../")) {
    throw new Error("epub_path_traversal_rejected");
  }
  return normalized;
}

function stripFragment(value: string): string {
  return value.split("#", 1)[0]!;
}

function fileTitle(value: string): string {
  return posix.basename(stripFragment(value)).replace(/\.[^.]+$/, "").replace(/[-_]+/g, " ").trim();
}

function stableUuid(value: string): string {
  const hash = createHash("sha256").update(value).digest("hex");
  return `${hash.slice(0, 8)}-${hash.slice(8, 12)}-5${hash.slice(13, 16)}-8${hash.slice(17, 20)}-${hash.slice(20, 32)}`;
}
