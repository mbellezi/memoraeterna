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
    return detectEpubStructure(input.data, input.documentKind, input.conversion);
  }
  if (extension === "pdf" || input.mimeType === "application/pdf") {
    return detectPdfStructure(input.conversion, input.documentKind, input.data, input.sourcePath);
  }
  return detectMarkdownStructure(input.conversion.markdown, input.documentKind);
}

export function detectEpubStructure(
  data: Uint8Array,
  documentKind: StructureDetectionInput["documentKind"] = "book",
  conversion?: MarkdownConversionResult
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
  const kinds = classifyEpubEntries(rawEntries, documentKind);
  const alignedOffsets = conversion
    ? alignEpubNavigationToMarkdown(rawEntries, conversion.markdown, contentByHref)
    : null;
  let fallbackMarkdownOffset = 0;
  const ids = rawEntries.map((entry, index) => stableUuid(`epub:${entry.href}#${entry.fragment ?? ""}:${index}`));
  const divisions = rawEntries.map((entry, index): DocumentDivisionCandidate => {
    const href = stripFragment(entry.href);
    const text = contentByHref.get(href) ?? "";
    const fallbackStart = fallbackMarkdownOffset;
    fallbackMarkdownOffset += text.length;
    const alignedStart = alignedOffsets?.[index];
    const start = alignedOffsets ? alignedStart : fallbackStart;
    const nextBoundary = alignedOffsets && alignedStart !== undefined
      ? findNextEpubBoundary(rawEntries, alignedOffsets, index, alignedStart)
      : undefined;
    const end = alignedOffsets
      ? alignedStart === undefined ? undefined : nextBoundary ?? conversion!.markdown.length
      : fallbackMarkdownOffset;
    const kind = kinds[index]!;
    const processableByKind = kind === "chapter" || kind === "article" || kind === "section" || kind === "appendix";
    const isProcessable = processableByKind && start !== undefined && end !== undefined && end > start;
    if (processableByKind && !isProcessable) warnings.push("structure.epub.unalignedProcessableDivision");
    return {
      id: ids[index]!,
      parentId: entry.parentIndex === null ? null : ids[entry.parentIndex] ?? null,
      kind,
      title: entry.title || fileTitle(href),
      level: entry.level,
      position: entry.position,
      startSelector: { format: "epub", href, ...(entry.fragment ? { fragment: entry.fragment } : {}),
        ...(start !== undefined ? { markdownOffset: start } : {}) },
      endSelector: { format: "epub", href, textLength: text.length,
        ...(end !== undefined ? { markdownOffset: end } : {}) },
      ...(start !== undefined ? { markdownStart: start } : {}),
      ...(end !== undefined ? { markdownEnd: end } : {}),
      confidence: alignedOffsets && alignedStart === undefined ? Math.min(entry.score, 0.58) : entry.score,
      evidence: [
        { kind: "native-navigation", source: entry.evidenceSource, score: entry.score, metadata: { href } },
        ...(alignedOffsets && alignedStart !== undefined
          ? [{ kind: "heading-alignment", source: "canonical-markdown", score: 0.9,
            metadata: { markdownOffset: alignedStart } }]
          : [])
      ],
      reviewStatus: alignedOffsets && alignedStart === undefined ? "proposed" : entry.score >= 0.6 ? "accepted" : "proposed",
      isProcessable,
      metadata: { spineIndex: spine.indexOf(href), ...(alignedOffsets ? { markdownAligned: alignedStart !== undefined } : {}) }
    };
  });
  const uniqueWarnings = [...new Set(warnings)];
  const processableKinds = divisions.filter((division) =>
    ["chapter", "article", "section", "appendix"].includes(division.kind)
  );
  const alignmentRatio = processableKinds.length === 0 ? 1
    : processableKinds.filter((division) => division.markdownStart !== undefined && division.markdownEnd! > division.markdownStart).length
      / processableKinds.length;
  return {
    format: "epub",
    detectorVersion: "epub-navigation-markdown-v2",
    overallConfidence: navigation.length > 0
      ? conversion ? 0.72 + (0.23 * alignmentRatio) : 0.95
      : conversion ? 0.45 + (0.1 * alignmentRatio) : 0.55,
    divisions,
    warnings: uniqueWarnings,
    metadata: { rootfile: normalizedRootfile, spineLength: spine.length,
      navigationKind: navItem ? "epub3-nav" : ncxItem ? "epub2-ncx" : "spine",
      ...(conversion ? { markdownAlignmentRatio: alignmentRatio } : {}) }
  };
}

interface EpubAlignmentCandidate {
  offset: number;
  score: number;
}

interface CanonicalMarkdownIndex {
  text: string;
  sourceOffsets: number[];
}

function alignEpubNavigationToMarkdown(
  entries: EpubNavigationEntry[],
  markdown: string,
  contentByHref: Map<string, string>
): Array<number | undefined> {
  const index = createCanonicalMarkdownIndex(markdown);
  const headings = parseMarkdownHeadingAnchors(markdown);
  const hrefCounts = new Map<string, number>();
  for (const entry of entries) {
    const href = stripFragment(entry.href);
    hrefCounts.set(href, (hrefCounts.get(href) ?? 0) + 1);
  }
  const candidates = entries.map((entry) => {
    const href = stripFragment(entry.href);
    return epubAlignmentCandidates(entry.title, markdown, index, headings,
      hrefCounts.get(href) === 1 || entry.fragment === null ? contentByHref.get(href) : undefined);
  });
  const selected: Array<number | undefined> = new Array(entries.length).fill(undefined);
  let upperBound = markdown.length + 1;

  // First establish only strong XHTML-body/Markdown-heading anchors. Missing titles are skipped
  // here so that one lossy conversion cannot drag every earlier entry back into the printed TOC.
  for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex -= 1) {
    const available = candidates[entryIndex]!
      .filter((candidate) => candidate.score >= 0.96 && candidate.offset < upperBound);
    if (available.length === 0) continue;
    const bestScore = Math.max(...available.map((candidate) => candidate.score));
    const best = available
      .filter((candidate) => candidate.score === bestScore)
      .toSorted((left, right) => right.offset - left.offset)[0];
    if (!best) continue;
    selected[entryIndex] = best.offset;
    upperBound = best.offset + 1;
  }

  // Fill each interval bounded by strong anchors. Choosing the latest equivalent occurrence
  // inside the interval skips duplicate chapter titles printed in a table of contents.
  let lowerBound = -1;
  for (let entryIndex = 0; entryIndex < entries.length; entryIndex += 1) {
    if (selected[entryIndex] !== undefined) {
      lowerBound = selected[entryIndex]!;
      continue;
    }
    const nextStrong = selected.slice(entryIndex + 1).find((offset) => offset !== undefined) ?? markdown.length + 1;
    const available = candidates[entryIndex]!
      .filter((candidate) => candidate.offset >= lowerBound && candidate.offset < nextStrong);
    if (available.length === 0) continue;
    const bestScore = Math.max(...available.map((candidate) => candidate.score));
    const best = available
      .filter((candidate) => candidate.score === bestScore)
      .toSorted((left, right) => right.offset - left.offset)[0];
    if (!best) continue;
    selected[entryIndex] = best.offset;
    lowerBound = best.offset;
  }
  for (let entryIndex = entries.length - 1; entryIndex >= 0; entryIndex -= 1) {
    if (selected[entryIndex] !== undefined) continue;
    for (let descendant = entryIndex + 1;
      descendant < entries.length && entries[descendant]!.level > entries[entryIndex]!.level;
      descendant += 1) {
      if (selected[descendant] !== undefined) {
        selected[entryIndex] = selected[descendant];
        break;
      }
    }
  }
  return selected;
}

function epubAlignmentCandidates(
  title: string,
  markdown: string,
  index: CanonicalMarkdownIndex,
  headings: Array<{ title: string; offset: number }>,
  bodyText?: string
): EpubAlignmentCandidate[] {
  const canonicalTitle = canonicalHeadingText(title);
  if (!canonicalTitle) return [];
  const byOffset = new Map<number, number>();
  const add = (offset: number, score: number) => {
    if (offset < 0 || offset >= markdown.length) return;
    byOffset.set(offset, Math.max(score, byOffset.get(offset) ?? 0));
  };

  for (let headingIndex = 0; headingIndex < headings.length; headingIndex += 1) {
    const heading = headings[headingIndex]!;
    const canonicalHeading = canonicalHeadingText(heading.title);
    if (canonicalHeading === canonicalTitle) add(heading.offset, 1);
    else if (similarCanonicalTitle(canonicalHeading, canonicalTitle)) add(heading.offset, 0.96);
    const next = headings[headingIndex + 1];
    if (next) {
      const combined = canonicalHeadingText(`${heading.title} ${next.title}`);
      if (combined === canonicalTitle || similarCanonicalTitle(combined, canonicalTitle)) add(heading.offset, 0.97);
    }
  }

  if (canonicalTitle.length >= 4) {
    let searchFrom = 0;
    let matchCount = 0;
    while (searchFrom < index.text.length && matchCount < 80) {
      const match = index.text.indexOf(canonicalTitle, searchFrom);
      if (match < 0) break;
      searchFrom = match + Math.max(1, canonicalTitle.length);
      if (!isCanonicalWordBoundary(index.text, match, canonicalTitle.length)) continue;
      const sourceOffset = index.sourceOffsets[match];
      if (sourceOffset === undefined) continue;
      const lineStart = markdown.lastIndexOf("\n", Math.max(0, sourceOffset - 1)) + 1;
      const lineEndMatch = markdown.indexOf("\n", sourceOffset);
      const lineEnd = lineEndMatch < 0 ? markdown.length : lineEndMatch;
      const canonicalLine = canonicalHeadingText(markdown.slice(lineStart, lineEnd));
      const standalone = canonicalLine === canonicalTitle
        || canonicalLine.startsWith(`${canonicalTitle} `) && /^\d+$/.test(canonicalLine.slice(canonicalTitle.length + 1));
      add(standalone ? lineStart : sourceOffset, standalone ? 0.94 : 0.72);
      matchCount += 1;
    }
  }
  addEpubBodyAnchors(canonicalTitle, bodyText, markdown, index, byOffset);
  return [...byOffset].map(([offset, score]) => ({ offset, score }));
}

function addEpubBodyAnchors(
  canonicalTitle: string,
  bodyText: string | undefined,
  markdown: string,
  index: CanonicalMarkdownIndex,
  candidates: Map<number, number>
): void {
  const canonicalBody = canonicalHeadingText(bodyText ?? "");
  const tokens = canonicalBody.split(" ").filter(Boolean);
  const titleTokenCount = canonicalTitle.split(" ").length;
  const bodyPrefix = tokens.slice(0, titleTokenCount).join(" ");
  const exactTitleOffset = canonicalBody.indexOf(canonicalTitle);
  const hrefAgreesWithTitle = exactTitleOffset >= 0 && exactTitleOffset <= 600
    || similarCanonicalTitle(bodyPrefix, canonicalTitle);
  if (canonicalTitle.length < 4 || !hrefAgreesWithTitle) return;
  if (tokens.length < 8) return;
  const windows = [0, 6, 14, 28, 48]
    .filter((start) => start + 8 <= tokens.length)
    .map((start) => tokens.slice(start, start + 8).join(" "));
  for (const phrase of windows) {
    const match = index.text.indexOf(phrase);
    if (match < 0 || index.text.indexOf(phrase, match + phrase.length) >= 0) continue;
    const sourceOffset = index.sourceOffsets[match];
    if (sourceOffset === undefined) continue;
    const precedingTitle = [...candidates]
      .filter(([offset]) => offset <= sourceOffset && sourceOffset - offset <= 12_000)
      .toSorted(([left], [right]) => right - left)[0]?.[0];
    if (precedingTitle !== undefined) {
      candidates.set(precedingTitle, Math.max(0.995, candidates.get(precedingTitle) ?? 0));
      continue;
    }
    const lineStart = markdown.lastIndexOf("\n", Math.max(0, sourceOffset - 1)) + 1;
    candidates.set(lineStart, Math.max(0.98, candidates.get(lineStart) ?? 0));
  }
}

function createCanonicalMarkdownIndex(markdown: string): CanonicalMarkdownIndex {
  const output: string[] = [];
  const sourceOffsets: number[] = [];
  let pendingSeparator: number | undefined;
  for (let offset = 0; offset < markdown.length;) {
    const codePoint = markdown.codePointAt(offset)!;
    const sourceCharacter = String.fromCodePoint(codePoint);
    const folded = foldHeadingText(sourceCharacter);
    for (const character of folded) {
      if (/^[\p{Letter}\p{Number}]$/u.test(character)) {
        if (pendingSeparator !== undefined && output.length > 0) {
          output.push(" ");
          sourceOffsets.push(pendingSeparator);
        }
        pendingSeparator = undefined;
        output.push(character);
        sourceOffsets.push(offset);
      } else if (output.length > 0 && pendingSeparator === undefined) {
        pendingSeparator = offset;
      }
    }
    offset += sourceCharacter.length;
  }
  return { text: output.join(""), sourceOffsets };
}

function parseMarkdownHeadingAnchors(markdown: string): Array<{ title: string; offset: number }> {
  return [...markdown.matchAll(/^(#{1,6})[ \t]+(.+?)\s*$/gm)].map((match) => ({
    title: match[2]!.replace(/[ \t]+#+[ \t]*$/, "").trim(),
    offset: match.index
  }));
}

function similarCanonicalTitle(left: string, right: string): boolean {
  left = normalizeTerminalOrdinal(normalizeEpubNotation(left));
  right = normalizeTerminalOrdinal(normalizeEpubNotation(right));
  if (left === right) return true;
  const leftOrdinal = /(?:^| )(\d+|[ivxlcdm]+)$/.exec(left)?.[1];
  const rightOrdinal = /(?:^| )(\d+|[ivxlcdm]+)$/.exec(right)?.[1];
  if (leftOrdinal && rightOrdinal && leftOrdinal !== rightOrdinal) return false;
  const significant = (token: string) => token.length > 1 || /^\d+$|^[ivxlcdm]+$/.test(token);
  const leftTokens = new Set(left.split(" ").filter(significant));
  const rightTokens = new Set(right.split(" ").filter(significant));
  if (leftTokens.size === 0 || rightTokens.size === 0) return false;
  const common = [...leftTokens].filter((token) => rightTokens.has(token)).length;
  return common / Math.max(leftTokens.size, rightTokens.size) >= 0.72;
}

function normalizeEpubNotation(value: string): string {
  return value.replace(/\b(\d+)x[oh]x\b/g, "$1");
}

function normalizeTerminalOrdinal(value: string): string {
  return value.replace(/(?:^| )([xvi\u03b9\u0456]+)$/u, (match, ordinal: string) =>
    match.slice(0, -ordinal.length) + ordinal.replace(/[\u03b9\u0456]/gu, "i"));
}

function isCanonicalWordBoundary(value: string, offset: number, length: number): boolean {
  return (offset === 0 || value[offset - 1] === " ")
    && (offset + length === value.length || value[offset + length] === " ");
}

function findNextEpubBoundary(
  entries: EpubNavigationEntry[],
  offsets: Array<number | undefined>,
  index: number,
  start: number
): number | undefined {
  for (let candidate = index + 1; candidate < entries.length; candidate += 1) {
    const offset = offsets[candidate];
    if (offset !== undefined && offset > start && entries[candidate]!.level <= entries[index]!.level) return offset;
  }
  return undefined;
}

function classifyEpubEntries(
  entries: EpubNavigationEntry[],
  documentKind: StructureDetectionInput["documentKind"]
): DocumentDivisionKind[] {
  if (documentKind === "book") return classifyBookHierarchyEntries(entries);
  const kinds: DocumentDivisionKind[] = [];
  for (const entry of entries) {
    kinds.push(classifyDivision(entry.title, documentKind, entry.level));
  }
  return kinds;
}

function classifyBookHierarchyEntries(
  entries: Array<{ title: string; level: number; parentIndex: number | null }>
): DocumentDivisionKind[] {
  const explicitRoles = entries.map((entry) => bookHeadingRole(entry.title));
  const kinds: DocumentDivisionKind[] = [];
  const contentsIndex = entries.findIndex((entry) => /^(contents|table of contents|sumario|indice geral|sommaire|inhaltsverzeichnis)(\b|$)/
    .test(canonicalHeadingText(entry.title)));
  const firstExplicitChapter = explicitRoles.findIndex((role) => role === "chapter" || role === "part");
  for (const [index, entry] of entries.entries()) {
    const role = explicitRoles[index]!;
    const parentKind = entry.parentIndex === null ? undefined : kinds[entry.parentIndex];
    if (role !== "unknown") kinds.push(role);
    else if (entry.level === 0 && (contentsIndex >= 0 && index < contentsIndex
        || firstExplicitChapter >= 0 && index < firstExplicitChapter)) kinds.push("frontmatter");
    else if (parentKind === "part") kinds.push("chapter");
    else if (parentKind === "chapter" || parentKind === "subsection") kinds.push("subsection");
    else kinds.push(entry.level === 0 ? "chapter" : "subsection");
  }
  return kinds;
}

function bookHeadingRole(title: string): DocumentDivisionKind | "unknown" {
  const normalized = canonicalHeadingText(title);
  if (/^(?:(?:part|parte|partie|teil|livro|libro|book)\s+(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez)|(?:first|second|third|fourth|fifth|primeira|segunda|terceira|quarta|quinta)\s+(?:part|parte)|\d+\s+a\s+parte)(\b|$)/.test(normalized)) return "part";
  if (/^(appendix|appendices|apendice|apendices|annexe|annexes|appendice|appendici|anexo|anexos)(\b|$)/.test(normalized)) return "appendix";
  if (/^(cover|capa|couverture|copertina|umschlag|title page|folha de rosto|pagina de titulo|copyright|direitos autorais|credits?|creditos|ficha catalografica|dedication|dedicatoria|epigraph|epigrafe|contents|table of contents|sumario|indice geral|sommaire|inhaltsverzeichnis|list of illustrations|illustrations tables and diagrams|list of figures|lista de ilustracoes|lista de figuras|insert with full color images|preface|prefacio|foreword|avant propos|premessa|presentation|apresentacao|prologue|prologo|introduction|introducao|introduccion|introduzione|einleitung|explanatory note|nota ?explic)(\b|$)/.test(normalized)) return "frontmatter";
  if (/^(afterword|posfacio|epilogue|epilogo|conclusion|conclusao|acknowledg(e)?ments?|agradecimentos?|bibliography|bibliografia|bibliographie|references|referencias|notes|notas|biographical notes|notas biograficas|endnotes|glossary|glossario|glossaire|index|indice|about the authors?|sobre (?:a|as|o|os) autor(?:a|as|es)?|fourth way centers|centros do quarto caminho|about the publisher|also by|colophon|colofao|e mail sign up|email sign up|conheca outros? titulos?|informacoes sobre os proximos lancamentos|saiba mais)(\b|$)/.test(normalized)) return "backmatter";
  if (/^(chapter|capitulo|chapitre|capitolo|kapitel)\s*(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez)(\b|$)/.test(normalized)) return "chapter";
  if (/^(?:stanza|estancia|strophe|strofe)\s+(?:\d+|[ivxlcdm]+)(\b|$)/.test(normalized)) return "chapter";
  if (/^\s*(?:\d{1,3}|[ivxlcdm]+)\s*[-–—:]\s*\S/i.test(foldHeadingText(title))) return "chapter";
  if (/^\s*[ivx]{1,5}\s+\p{Letter}/iu.test(foldHeadingText(title))
      || /^\s*[一二三四五六七八九十]\s*\S/u.test(title)) return "chapter";
  return "unknown";
}

export async function detectPdfStructure(
  conversion: MarkdownConversionResult,
  documentKind: StructureDetectionInput["documentKind"] = "other",
  data?: Uint8Array,
  sourcePath?: string
): Promise<StructureDetectionResult> {
  const headingBlocks = conversion.blocks.filter(isHeadingBlock);
  const doclingDivisions = divisionsFromBlocks(headingBlocks, conversion.markdown.length, documentKind, "docling-heading");
  const paperMarkdown = documentKind === "paper"
    ? divisionsFromPaperMarkdown(conversion.markdown, headingBlocks, conversion.documentStructure?.pageCount)
    : null;
  const bookMarkdown = documentKind === "book"
    ? divisionsFromBookMarkdown(conversion.markdown, conversion.blocks, conversion.documentStructure?.pageCount)
    : null;
  let native: Awaited<ReturnType<typeof readPdfNavigation>> | null = null;
  if (data?.byteLength || sourcePath) {
    try { native = await readPdfNavigation(sourcePath ?? data!); } catch { native = null; }
  }
  const divisions = native?.outline.length
    ? divisionsFromPdfOutline(native.outline, native.pageCount, native.pageLabels,
      headingBlocks, conversion.markdown, documentKind)
    : paperMarkdown?.divisions ?? bookMarkdown?.divisions ?? doclingDivisions;
  const warnings = divisions.length === 0 ? ["structure.pdf.noReliableDivisions"] : [];
  return {
    format: "pdf",
    detectorVersion: "pdf-outline-canonical-markdown-v5",
    overallConfidence: native?.outline.length ? 0.88 : divisions.length > 0 ? averageConfidence(divisions) : 0.2,
    divisions,
    warnings,
    metadata: { blockCount: conversion.blocks.length, headingCount: headingBlocks.length,
      markdownHeadingCount: paperMarkdown?.headingCount,
      rejectedMarkdownHeadingCount: paperMarkdown?.rejectedCount,
      bookMarkdownHeadingCount: bookMarkdown?.headingCount,
      rejectedBookMarkdownHeadingCount: bookMarkdown?.rejectedCount,
      outlineCount: native?.outline.length ?? 0, pageCount: native?.pageCount ?? conversion.documentStructure?.pageCount,
      pageLabels: native?.pageLabels ?? [] }
  };
}

interface PdfOutlineEntry { title: string; page: number; level: number; parentIndex: number | null; position: number }

export async function readPdfPageCount(input: Uint8Array | string): Promise<number> {
  const loadingTask = createPdfLoadingTask(input);
  const document = await loadingTask.promise;
  try {
    return document.numPages;
  } finally {
    await loadingTask.destroy();
  }
}

async function readPdfNavigation(input: Uint8Array | string) {
  const loadingTask = createPdfLoadingTask(input);
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

function createPdfLoadingTask(input: Uint8Array | string) {
  return getDocument(typeof input === "string"
    ? { url: input, useSystemFonts: false }
    : { data: new Uint8Array(input), useSystemFonts: false });
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
  outline: PdfOutlineEntry[], pageCount: number, pageLabels: string[], blocks: ConversionBlock[], markdown: string,
  documentKind: StructureDetectionInput["documentKind"]
): DocumentDivisionCandidate[] {
  const ids = outline.map((entry) => stableUuid(`pdf-outline:${entry.page}:${entry.title}:${entry.position}`));
  const headingAnchors = parseCanonicalMarkdownHeadings(markdown, blocks);
  const kinds = documentKind === "book"
    ? classifyBookHierarchyEntries(outline)
    : outline.map((entry) => classifyDivision(entry.title, documentKind, entry.level));
  const starts = outline.map((entry) => resolvePdfOutlineMarkdownStart(entry, headingAnchors, markdown.length));
  return outline.map((entry, index) => {
    const start = starts[index]!;
    const nextIndex = outline.findIndex((candidate, candidateIndex) =>
      candidateIndex > index && candidate.level <= entry.level && starts[candidateIndex]! > start);
    const nextPage = nextIndex >= 0 ? outline[nextIndex]!.page : undefined;
    const matchingHeading = findMatchingPdfHeading(entry, headingAnchors);
    const followingOffset = nextIndex >= 0 ? starts[nextIndex] : undefined;
    const end = followingOffset !== undefined && followingOffset > start ? followingOffset : markdown.length;
    const score = matchingHeading ? 0.97 : 0.86;
    const kind = kinds[index]!;
    const hasChildren = outline.some((candidate) => candidate.parentIndex === index);
    const isProcessable = documentKind === "book"
      ? ["chapter", "appendix"].includes(kind) && end > start
      : documentKind === "paper"
        ? entry.level > 0 && !hasChildren && end > start
      : isDefaultProcessable(kind, entry.level) && end > start;
    return {
      id: ids[index]!, parentId: entry.parentIndex === null ? null : ids[entry.parentIndex] ?? null,
      kind, title: entry.title, level: entry.level, position: entry.position,
      startSelector: { format: "pdf", page: entry.page, ...(pageLabels[entry.page - 1] ? { pageLabel: pageLabels[entry.page - 1] } : {}), bookmark: entry.title,
        ...(matchingHeading?.block ? { blockId: matchingHeading.block.id } : {}), markdownOffset: start },
      endSelector: { format: "pdf", page: nextPage ? nextPage - 1 : pageCount,
        ...(pageLabels[(nextPage ? nextPage - 1 : pageCount) - 1] ? { pageLabel: pageLabels[(nextPage ? nextPage - 1 : pageCount) - 1] } : {}),
        markdownOffset: end },
      startPage: entry.page, endPage: nextPage ? Math.max(entry.page, nextPage - 1) : pageCount,
      markdownStart: start, markdownEnd: end,
      confidence: score,
      evidence: [
        { kind: "native-outline", source: "pdfjs-outline", score: 0.86, metadata: { page: entry.page, ...(pageLabels[entry.page - 1] ? { pageLabel: pageLabels[entry.page - 1] } : {}) } },
        ...(matchingHeading ? [{ kind: "heading-agreement", source: "canonical-markdown", score: 0.97,
          metadata: { markdownOffset: matchingHeading.markdownStart,
            ...(matchingHeading.block ? { blockId: matchingHeading.block.id, page: matchingHeading.block.page } : {}) } }] : [])
      ],
      reviewStatus: score >= 0.9 ? "accepted" : "proposed",
      isProcessable, metadata: {}
    } satisfies DocumentDivisionCandidate;
  });
}

interface CanonicalMarkdownHeading {
  title: string;
  markdownStart: number;
  headingEnd: number;
  markdownLevel: number;
  block?: ConversionBlock;
}

function parseCanonicalMarkdownHeadings(markdown: string, blocks: ConversionBlock[]): CanonicalMarkdownHeading[] {
  const blockQueues = new Map<string, ConversionBlock[]>();
  for (const block of blocks.filter(isHeadingBlock)) {
    const key = canonicalHeadingText(block.text);
    const queue = blockQueues.get(key) ?? [];
    queue.push(block);
    blockQueues.set(key, queue);
  }
  return [...markdown.matchAll(/^(#{1,6})[ \t]+(.+?)\s*$/gm)].map((match) => {
    const title = match[2]!.replace(/[ \t]+#+[ \t]*$/, "").trim();
    const block = blockQueues.get(canonicalHeadingText(title))?.shift();
    return {
      title,
      markdownStart: match.index,
      headingEnd: match.index + match[0].length,
      markdownLevel: match[1]!.length,
      ...(block ? { block } : {})
    };
  });
}

function findMatchingPdfHeading(
  entry: PdfOutlineEntry,
  headings: CanonicalMarkdownHeading[]
): CanonicalMarkdownHeading | undefined {
  const candidates = headings.filter((heading, index) => {
    if (similarTitle(heading.title, entry.title)) return true;
    const next = headings[index + 1];
    return next !== undefined && isGenericChapterMarker(heading.title)
      && heading.block?.page === next.block?.page
      && similarTitle(`${heading.title} ${next.title}`, entry.title);
  });
  return candidates.toSorted((left, right) => {
    const leftDistance = left.block?.page === undefined ? Number.MAX_SAFE_INTEGER : Math.abs(left.block.page - entry.page);
    const rightDistance = right.block?.page === undefined ? Number.MAX_SAFE_INTEGER : Math.abs(right.block.page - entry.page);
    return leftDistance - rightDistance || left.markdownStart - right.markdownStart;
  })[0];
}

function resolvePdfOutlineMarkdownStart(
  entry: PdfOutlineEntry,
  headings: CanonicalMarkdownHeading[],
  markdownLength: number
): number {
  const matching = findMatchingPdfHeading(entry, headings);
  if (matching) return matching.markdownStart;
  const onOrAfterPage = headings.find((heading) => heading.block?.page !== undefined && heading.block.page >= entry.page);
  if (onOrAfterPage) return onOrAfterPage.markdownStart;
  const preceding = headings.findLast((heading) => heading.block?.page !== undefined && heading.block.page <= entry.page);
  return preceding?.markdownStart ?? markdownLength;
}

function similarTitle(left: string, right: string): boolean {
  const normalize = (value: string) => value.normalize("NFD").replace(/\p{Diacritic}/gu, "").replace(/\W+/g, " ").trim().toLowerCase();
  const a = normalize(left); const b = normalize(right);
  return a === b || (a.length > 5 && b.length > 5 && (a.includes(b) || b.includes(a)));
}

interface BookMarkdownDetection {
  divisions: DocumentDivisionCandidate[];
  headingCount: number;
  rejectedCount: number;
}

interface SelectedBookHeading extends CanonicalMarkdownHeading {
  kind: DocumentDivisionKind;
  displayTitle: string;
}

function divisionsFromBookMarkdown(
  markdown: string,
  blocks: ConversionBlock[],
  pageCount?: number
): BookMarkdownDetection {
  const headings = parseCanonicalMarkdownHeadings(markdown, blocks);
  const sessionRich = headings.filter((heading) => /^sess(?:ao|ão)\b/i.test(foldHeadingText(heading.title))).length >= 8;
  const selected = sessionRich
    ? selectSessionBookHeadings(headings)
    : selectExplicitBookHeadings(headings, markdown, blocks);
  const ids = selected.map((heading) => stableUuid(
    `book-markdown:${heading.markdownStart}:${canonicalHeadingText(heading.displayTitle)}`
  ));
  const resolved = selected.map((heading, index) => {
    let parentIndex: number | null = null;
    let level = 0;
    if (heading.kind === "chapter") {
      for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
        if (selected[candidate]!.kind === "part") {
          parentIndex = candidate;
          level = 1;
          break;
        }
      }
    }
    return { heading, parentIndex, level };
  });
  const divisions = resolved.map(({ heading, parentIndex, level }, index): DocumentDivisionCandidate => {
    const nextIndex = resolved.findIndex((candidate, candidateIndex) =>
      candidateIndex > index && candidate.level <= level);
    const next = nextIndex >= 0 ? resolved[nextIndex] : undefined;
    const end = next?.heading.markdownStart ?? markdown.length;
    const startPage = heading.block?.page;
    const nextPage = next?.heading.block?.page;
    const endPage = nextPage !== undefined ? Math.max(startPage ?? 1, nextPage - 1) : pageCount ?? startPage;
    const confidence = heading.kind === "chapter" || heading.kind === "appendix" ? 0.9 : 0.82;
    return {
      id: ids[index]!,
      parentId: parentIndex === null ? null : ids[parentIndex]!,
      kind: heading.kind,
      title: heading.displayTitle,
      level,
      position: index,
      startSelector: { format: "pdf", markdownOffset: heading.markdownStart,
        ...(heading.block ? { blockId: heading.block.id } : {}) },
      endSelector: { format: "pdf", markdownOffset: end,
        ...(next?.heading.block ? { blockId: next.heading.block.id } : {}) },
      ...(startPage !== undefined ? { startPage } : {}),
      ...(endPage !== undefined ? { endPage } : {}),
      markdownStart: heading.markdownStart,
      markdownEnd: end,
      confidence,
      evidence: [
        { kind: "heading", source: "canonical-markdown", score: 0.82,
          metadata: { offset: heading.markdownStart, level: heading.markdownLevel } },
        ...(heading.block ? [{ kind: "heading-agreement", source: "docling-heading", score: 0.88,
          metadata: { blockId: heading.block.id, ...(heading.block.page ? { page: heading.block.page } : {}) } }] : [])
      ],
      reviewStatus: confidence >= 0.9 ? "accepted" : "proposed",
      isProcessable: ["chapter", "appendix"].includes(heading.kind) && end > heading.markdownStart,
      metadata: { bookHeadingHeuristic: sessionRich ? "session-chapters" : "explicit-chapters" }
    };
  });
  return { divisions, headingCount: headings.length, rejectedCount: headings.length - selected.length };
}

function selectExplicitBookHeadings(
  headings: CanonicalMarkdownHeading[],
  markdown: string,
  blocks: ConversionBlock[]
): SelectedBookHeading[] {
  const roles = headings.map((heading) => bookHeadingRole(heading.title));
  const openingFrontIndex = headings.findLastIndex((heading) => /^(preface|prefacio|foreword|avant propos|premessa|presentation|apresentacao|prologue|prologo|introduction|introducao|introduccion|introduzione|einleitung|explanatory note|nota ?explic\w*)$/
    .test(canonicalHeadingText(heading.title)));
  const firstUnboundedCore = roles.findIndex((role, index) =>
    ["chapter", "part", "appendix"].includes(role) && index > openingFrontIndex);
  const terminalBackmatterIndex = roles.findIndex((role, index) => {
    if (role !== "backmatter" || index <= firstUnboundedCore) return false;
    const nextCore = roles.findIndex((candidate, candidateIndex) =>
      candidateIndex > index && ["chapter", "part", "appendix"].includes(candidate));
    const nextBackmatter = roles.findIndex((candidate, candidateIndex) =>
      candidateIndex > index && candidate === "backmatter");
    return nextCore < 0 || nextBackmatter >= 0 && nextBackmatter < nextCore;
  });
  const coreIndexes = roles.flatMap((role, index) =>
    ["chapter", "part", "appendix"].includes(role) && index > openingFrontIndex
      && (terminalBackmatterIndex < 0 || index < terminalBackmatterIndex) ? [index] : []);
  if (coreIndexes.length === 0) return [];
  const firstCore = coreIndexes[0]!;
  const lastChapter = coreIndexes.findLast((index) => roles[index] === "chapter") ?? -1;
  const selected: SelectedBookHeading[] = [];
  for (const [index, heading] of headings.entries()) {
    const role = roles[index]!;
    const structural = ["chapter", "part", "appendix"].includes(role) && index > openingFrontIndex
        && (terminalBackmatterIndex < 0 || index < terminalBackmatterIndex)
      || role === "frontmatter" && index < firstCore
      || role === "backmatter" && index > lastChapter;
    if (!structural) continue;
    let displayTitle = normalizeOcrBookChapterTitle(heading.title);
    if (role === "chapter" && isGenericChapterMarker(heading.title)) {
      const subtitle = headings[index + 1];
      if (subtitle && subtitle.block?.page === heading.block?.page
          && bookHeadingRole(subtitle.title) === "unknown" && !isBookHeadingNoise(subtitle.title)) {
        displayTitle = `${heading.title}: ${subtitle.title}`;
      }
    }
    selected.push({ ...heading, kind: role, displayTitle });
  }
  return supplementMissingOrdinalChapters(markdown, headings,
    supplementNumberedBookHeadings(markdown, blocks, selected));
}

function supplementMissingOrdinalChapters(
  markdown: string,
  headings: CanonicalMarkdownHeading[],
  selected: SelectedBookHeading[]
): SelectedBookHeading[] {
  const numbered = selected.flatMap((heading) => {
    const ordinal = bookChapterOrdinal(heading.displayTitle);
    return ordinal === null || heading.kind !== "chapter" ? [] : [{ ordinal, heading }];
  }).toSorted((left, right) => left.heading.markdownStart - right.heading.markdownStart);
  for (let index = 0; index + 1 < numbered.length; index += 1) {
    const current = numbered[index]!;
    const next = numbered[index + 1]!;
    if (next.ordinal - current.ordinal !== 2) continue;
    const between = headings.filter((heading) =>
      heading.markdownStart > current.heading.markdownStart && heading.markdownStart < next.heading.markdownStart);
    const summaryIndex = between.findIndex((heading) => /^(summary|resumo|resumen|resume)$/.test(canonicalHeadingText(heading.title)));
    const boundary = summaryIndex >= 0 ? between[summaryIndex + 1] : undefined;
    if (!boundary) continue;
    const missingOrdinal = current.ordinal + 1;
    const tocTitle = findRomanTocTitle(markdown.slice(0, current.heading.markdownStart), missingOrdinal);
    selected.push({
      ...boundary,
      kind: "chapter",
      displayTitle: tocTitle ?? `${romanNumeral(missingOrdinal)}: ${boundary.title}`
    });
  }
  return selected.toSorted((left, right) => left.markdownStart - right.markdownStart);
}

function bookChapterOrdinal(title: string): number | null {
  const normalized = canonicalHeadingText(title);
  const match = /^(?:(?:chapter|capitulo|chapitre|capitolo|kapitel)\s+)?(\d{1,3}|[ivxlcdm]+|[一二三四五六七八九十])(?=\s|$)/u.exec(normalized);
  if (!match?.[1]) return null;
  if (/^\d+$/.test(match[1])) return Number(match[1]);
  const cjk = "一二三四五六七八九十".indexOf(match[1]);
  if (cjk >= 0) return cjk + 1;
  return parseRomanNumeral(match[1]);
}

function parseRomanNumeral(value: string): number | null {
  const values: Record<string, number> = { i: 1, v: 5, x: 10, l: 50, c: 100, d: 500, m: 1_000 };
  let total = 0;
  for (let index = 0; index < value.length; index += 1) {
    const current = values[value[index]!] ?? 0;
    const next = values[value[index + 1]!] ?? 0;
    total += current < next ? -current : current;
  }
  return total > 0 ? total : null;
}

function romanNumeral(value: number): string {
  const numerals: Array<[number, string]> = [[10, "X"], [9, "IX"], [5, "V"], [4, "IV"], [1, "I"]];
  let remaining = value;
  let output = "";
  for (const [amount, numeral] of numerals) {
    while (remaining >= amount) {
      output += numeral;
      remaining -= amount;
    }
  }
  return output;
}

function findRomanTocTitle(markdownPrefix: string, ordinal: number): string | undefined {
  const numeral = romanNumeral(ordinal);
  const matches = [...markdownPrefix.matchAll(new RegExp(`^\\s*(?:#{1,6}\\s*)?${numeral}\\s*[-–—]\\s*([^\\n]{3,100})$`, "gmi"))];
  const title = matches.at(-1)?.[1]?.replace(/\s+/g, " ").trim();
  return title ? `${numeral} - ${title}` : undefined;
}

function supplementNumberedBookHeadings(
  markdown: string,
  blocks: ConversionBlock[],
  selected: SelectedBookHeading[]
): SelectedBookHeading[] {
  const represented = new Set(selected.flatMap((heading) => {
    const match = /^\s*(\d{1,3})\s*[-–—:]/.exec(foldHeadingText(heading.title));
    return match?.[1] ? [Number(match[1])] : [];
  }));
  if (represented.size < 5) return selected;
  const numberedSelected = selected.flatMap((heading) => {
    const match = /^\s*(\d{1,3})\s*[-–—:]/.exec(foldHeadingText(heading.title));
    return match?.[1] ? [{ number: Number(match[1]), heading }] : [];
  });
  const searchIndex = createCanonicalMarkdownIndex(markdown);
  const prefix = markdown.slice(0, Math.min(markdown.length, 50_000));
  for (const match of prefix.matchAll(/(?:^|\s)(\d{1,3})\s*[-–—]\s*([\p{Letter}][\s\S]{2,100}?)(?=\s+\d{1,3}\s*[-–—]|\n{2}|$)/gu)) {
    const number = Number(match[1]);
    const title = match[2]!.replace(/\s+/g, " ").trim();
    if (represented.has(number) || title.length < 3 || title.length > 100) continue;
    const canonicalTitle = canonicalHeadingText(title);
    const lowerHeading = numberedSelected
      .filter((candidate) => candidate.number < number)
      .toSorted((left, right) => right.number - left.number)[0]?.heading;
    const upperHeading = numberedSelected
      .filter((candidate) => candidate.number > number)
      .toSorted((left, right) => left.number - right.number)[0]?.heading;
    const lowerOffset = lowerHeading?.markdownStart ?? prefix.length;
    const upperOffset = upperHeading?.markdownStart ?? markdown.length;
    const occurrences: Array<{ offset: number; standalone: boolean }> = [];
    let searchFrom = 0;
    while (searchFrom < searchIndex.text.length) {
      const canonicalMatch = searchIndex.text.indexOf(canonicalTitle, searchFrom);
      if (canonicalMatch < 0) break;
      searchFrom = canonicalMatch + canonicalTitle.length;
      if (!isCanonicalWordBoundary(searchIndex.text, canonicalMatch, canonicalTitle.length)) continue;
      const offset = searchIndex.sourceOffsets[canonicalMatch];
      if (offset === undefined || offset <= lowerOffset || offset >= upperOffset) continue;
      const lineStart = markdown.lastIndexOf("\n", Math.max(0, offset - 1)) + 1;
      const lineEndMatch = markdown.indexOf("\n", offset);
      const lineEnd = lineEndMatch < 0 ? markdown.length : lineEndMatch;
      occurrences.push({ offset, standalone: canonicalHeadingText(markdown.slice(lineStart, lineEnd)) === canonicalTitle });
    }
    const sourceOffset = occurrences
      .toSorted((left, right) => Number(right.standalone) - Number(left.standalone) || left.offset - right.offset)[0]?.offset;
    if (sourceOffset === undefined) continue;
    const lineStart = markdown.lastIndexOf("\n", Math.max(0, sourceOffset - 1)) + 1;
    const lowerPage = lowerHeading?.block?.page ?? 1;
    const upperPage = upperHeading?.block?.page ?? Number.MAX_SAFE_INTEGER;
    const block = blocks.find((candidate) => {
      const candidateTitle = canonicalHeadingText(candidate.text);
      return (candidateTitle === canonicalTitle || candidateTitle.endsWith(` ${canonicalTitle}`))
        && candidate.page !== undefined && candidate.page >= lowerPage && candidate.page <= upperPage;
    });
    selected.push({
      title: `${number} - ${title}`,
      displayTitle: `${number} - ${title}`,
      kind: "chapter",
      markdownStart: lineStart,
      headingEnd: sourceOffset + title.length,
      markdownLevel: 2,
      ...(block ? { block } : {})
    });
    represented.add(number);
  }
  return selected.toSorted((left, right) => left.markdownStart - right.markdownStart);
}

function selectSessionBookHeadings(headings: CanonicalMarkdownHeading[]): SelectedBookHeading[] {
  const partIndexes = headings.flatMap((heading, index) => bookHeadingRole(heading.title) === "part" ? [index] : []);
  const firstSessionIndex = headings.findIndex((heading) => isSessionHeading(heading.title));
  const contentPartIndex = partIndexes.findLast((index) => index < firstSessionIndex) ?? -1;
  const appendixIndex = headings.findIndex((heading, index) =>
    index > contentPartIndex && bookHeadingRole(heading.title) === "appendix");
  const selected: SelectedBookHeading[] = [];
  const introductionIndex = headings.findLastIndex((heading, index) =>
    index < contentPartIndex && /^(introduction|introducao|introduccion|introduzione|einleitung)$/
      .test(canonicalHeadingText(heading.title)));
  if (introductionIndex >= 0) {
    const heading = headings[introductionIndex]!;
    selected.push({ ...heading, kind: "frontmatter", displayTitle: heading.title });
  }
  if (contentPartIndex >= 0) {
    const heading = headings[contentPartIndex]!;
    selected.push({ ...heading, kind: "part", displayTitle: heading.title });
  }

  const end = appendixIndex >= 0 ? appendixIndex : headings.length;
  for (let index = Math.max(0, contentPartIndex + 1); index < end; index += 1) {
    const heading = headings[index]!;
    if (isSessionHeading(heading.title) || isBookHeadingNoise(heading.title)
        || isGenericChapterMarker(heading.title)) continue;
    const sessionMatch = /\s+sess(?:ao|ão)\b/i.exec(foldHeadingText(heading.title));
    const nextSessionIndex = headings.findIndex((candidate, candidateIndex) =>
      candidateIndex > index && isSessionHeading(candidate.title));
    const nextSession = nextSessionIndex >= 0 ? headings[nextSessionIndex] : undefined;
    const page = heading.block?.page;
    const closeToSession = nextSession?.block?.page !== undefined && page !== undefined
      && nextSession.block.page - page >= 0 && nextSession.block.page - page <= 8;
    if (!sessionMatch && !closeToSession) continue;

    const titleParts = [sessionMatch ? heading.title.slice(0, sessionMatch.index).trim() : heading.title];
    while (index + 1 < end) {
      const following = headings[index + 1]!;
      if (following.block?.page !== heading.block?.page || isSessionHeading(following.title)
          || isBookHeadingNoise(following.title) || isGenericChapterMarker(following.title)) break;
      titleParts.push(following.title);
      index += 1;
    }
    const displayTitle = titleParts.join(" ").replace(/\s+/g, " ").trim();
    if (canonicalHeadingText(displayTitle).length < 5) continue;
    selected.push({ ...heading, kind: "chapter", displayTitle });
  }

  if (appendixIndex >= 0) {
    const heading = headings[appendixIndex]!;
    selected.push({ ...heading, kind: "appendix", displayTitle: heading.title });
  }
  const aboutIndex = headings.findIndex((heading, index) =>
    index > appendixIndex && bookHeadingRole(heading.title) === "backmatter");
  if (aboutIndex >= 0) {
    const heading = headings[aboutIndex]!;
    selected.push({ ...heading, kind: "backmatter", displayTitle: heading.title });
  }
  return selected.toSorted((left, right) => left.markdownStart - right.markdownStart);
}

function isSessionHeading(title: string): boolean {
  return /^sess(?:ao|ão)\b/i.test(foldHeadingText(title));
}

function isGenericChapterMarker(title: string): boolean {
  const normalized = canonicalHeadingText(title);
  return /^(?:chapter|capitulo|chapitre|capitolo|kapitel)\s*(?:\d+|[ivxlcdm]+|one|two|three|four|five|six|seven|eight|nine|ten|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez)$/
    .test(normalized) || /^(?:stanza|estancia|strophe|strofe)\s+(?:\d+|[ivxlcdm]+)$/.test(normalized)
    || /^\d{1,3}$/.test(normalized);
}

function normalizeOcrBookChapterTitle(title: string): string {
  const unicode = /^((?:chapter|cap[ií]tulo|chapitre|capitolo|kapitel)\s*)([Ⅰ-Ⅻ]+)[ivx]?$/iu.exec(title.trim());
  if (unicode?.[1] && unicode[2]) return `${unicode[1].trim()} ${unicode[2].normalize("NFKC")}`;
  const concatenated = /^((?:chapter|cap[ií]tulo|chapitre|capitolo|kapitel))\s*([ivxlcdm]+|\d{1,3})$/iu.exec(title.trim());
  return concatenated?.[1] && concatenated[2] ? `${concatenated[1]} ${concatenated[2]}` : title;
}

function isBookHeadingNoise(title: string): boolean {
  const normalized = canonicalHeadingText(title);
  return normalized.length < 2 || /^\d{1,2}h\d{0,2}\b/.test(normalized)
    || /^\(.+\)$/.test(title.trim()) || /^[qa]\s*:/i.test(title.trim())
    || /^_{3,}$/.test(title.trim()) || /^(contents?|conteudo|sumario)$/.test(normalized);
}

type PaperHeadingRole = "frontmatter" | "core" | "backmatter" | "appendix" | "toc" | "metadata" | "unknown";

interface PaperMarkdownHeading {
  title: string;
  markdownStart: number;
  headingEnd: number;
  markdownLevel: number;
  block?: ConversionBlock;
  numberLevel: number | null;
  role: PaperHeadingRole;
}

interface PaperMarkdownDetection {
  divisions: DocumentDivisionCandidate[];
  headingCount: number;
  rejectedCount: number;
}

function divisionsFromPaperMarkdown(
  markdown: string,
  blocks: ConversionBlock[],
  pageCount?: number,
  selectorFormat: "pdf" | "markdown" = "pdf"
): PaperMarkdownDetection {
  const parsed = parsePaperMarkdownHeadings(markdown, blocks);
  const titleCounts = new Map<string, number>();
  for (const heading of parsed) {
    const key = canonicalHeadingText(heading.title);
    titleCounts.set(key, (titleCounts.get(key) ?? 0) + 1);
  }
  const structuralIndex = parsed.findIndex((heading) =>
    heading.numberLevel !== null || ["frontmatter", "core", "appendix"].includes(heading.role)
  );
  const terminalBackmatterIndex = parsed.findIndex((heading) => isTerminalBackmatter(heading.title));
  const fallbackUnknown = parsed.filter((heading) =>
    heading.role === "unknown"
    && (titleCounts.get(canonicalHeadingText(heading.title)) ?? 0) === 1
    && !isRejectedPaperHeading(heading)
  );
  const fallbackPage = structuralIndex < 0
    ? fallbackUnknown.map((heading) => heading.block?.page).find((page): page is number => page !== undefined && page > 1)
    : undefined;
  const fallbackOffset = structuralIndex < 0 && fallbackPage === undefined
    ? (fallbackUnknown.length > 1 ? fallbackUnknown[1]?.markdownStart : fallbackUnknown[0]?.markdownStart)
    : undefined;

  const accepted = parsed.filter((heading, index) => {
    if (isRejectedPaperHeading(heading)) return false;
    const repeatedUnknown = heading.role === "unknown"
      && (titleCounts.get(canonicalHeadingText(heading.title)) ?? 0) > 1;
    if (repeatedUnknown) return false;
    if (heading.role !== "unknown" || heading.numberLevel !== null) return true;
    if (terminalBackmatterIndex >= 0 && index > terminalBackmatterIndex) return false;
    if (structuralIndex >= 0) {
      if (index > structuralIndex) return true;
      const next = parsed[structuralIndex];
      return index === structuralIndex - 1 && next !== undefined
        && next.numberLevel !== null
        && next.markdownStart - heading.headingEnd <= 240
        && (heading.block?.page === undefined || next.block?.page === undefined || heading.block.page === next.block.page);
    }
    if (fallbackPage !== undefined) return heading.block?.page !== undefined && heading.block.page >= fallbackPage;
    return fallbackOffset !== undefined && heading.markdownStart >= fallbackOffset;
  });

  const resolved: Array<PaperMarkdownHeading & { id: string; level: number }> = [];
  let latestTopLevel: (PaperMarkdownHeading & { id: string; level: number }) | undefined;
  for (const heading of accepted) {
    let level = heading.numberLevel ?? 0;
    if (heading.numberLevel === null && heading.role === "unknown" && latestTopLevel) {
      const markdownDelta = heading.markdownLevel - latestTopLevel.markdownLevel;
      const left = heading.block?.boundingBox?.left;
      const parentLeft = latestTopLevel.block?.boundingBox?.left;
      const indentation = left !== undefined && parentLeft !== undefined ? left - parentLeft : 0;
      if (markdownDelta > 0) level = Math.min(5, markdownDelta);
      else if (latestTopLevel.role === "core" && indentation >= 24 && indentation <= 120) level = 1;
    }
    const item = {
      ...heading,
      id: stableUuid(`paper-markdown:${heading.markdownStart}:${canonicalHeadingText(heading.title)}`),
      level
    };
    resolved.push(item);
    if (level === 0) latestTopLevel = item;
  }

  const divisions = resolved.map((heading, index): DocumentDivisionCandidate => {
    const next = resolved[index + 1];
    const end = next?.markdownStart ?? markdown.length;
    const startPage = heading.block?.page;
    const endPage = next?.block?.page ?? pageCount ?? startPage;
    const confidence = paperHeadingConfidence(heading);
    const kind = classifyDivision(heading.title, "paper", heading.level);
    const parent = findResolvedHeadingParent(resolved, index);
    const startSelector = selectorFormat === "pdf"
      ? { format: "pdf", markdownOffset: heading.markdownStart, ...(heading.block ? { blockId: heading.block.id } : {}) }
      : { format: "markdown", offset: heading.markdownStart };
    const endSelector = selectorFormat === "pdf"
      ? { format: "pdf", markdownOffset: end, ...(next?.block ? { blockId: next.block.id } : {}) }
      : { format: "markdown", offset: end };
    return {
      id: heading.id,
      parentId: parent?.id ?? null,
      kind,
      title: heading.title,
      level: heading.level,
      position: index,
      startSelector,
      endSelector,
      ...(startPage !== undefined ? { startPage } : {}),
      ...(endPage !== undefined ? { endPage } : {}),
      markdownStart: heading.markdownStart,
      markdownEnd: end,
      confidence,
      evidence: paperHeadingEvidence(heading),
      reviewStatus: confidence >= 0.8 ? "accepted" : "proposed",
      isProcessable: true,
      metadata: {
        paperHeadingRole: heading.role,
        markdownHeadingLevel: heading.markdownLevel,
        ...(heading.numberLevel !== null ? { numberingDepth: heading.numberLevel + 1 } : {})
      }
    };
  });
  return { divisions, headingCount: parsed.length, rejectedCount: parsed.length - divisions.length };
}

function parsePaperMarkdownHeadings(markdown: string, blocks: ConversionBlock[]): PaperMarkdownHeading[] {
  const blockQueues = new Map<string, ConversionBlock[]>();
  for (const block of blocks.filter(isHeadingBlock)) {
    const key = canonicalHeadingText(block.text);
    const queue = blockQueues.get(key) ?? [];
    queue.push(block);
    blockQueues.set(key, queue);
  }
  const fencedRanges = markdownFencedRanges(markdown);
  return [...markdown.matchAll(/^(#{1,6})[ \t]+(.+?)\s*$/gm)]
    .filter((match) => !fencedRanges.some(([start, end]) => match.index >= start && match.index < end))
    .map((match) => {
      const title = match[2]!.replace(/[ \t]+#+[ \t]*$/, "").trim();
      const key = canonicalHeadingText(title);
      const queue = blockQueues.get(key);
      const block = queue?.shift();
      return {
        title,
        markdownStart: match.index,
        headingEnd: match.index + match[0].length,
        markdownLevel: match[1]!.length,
        ...(block ? { block } : {}),
        numberLevel: sectionNumberLevel(title),
        role: paperHeadingRole(title)
      };
    });
}

function markdownFencedRanges(markdown: string): Array<[start: number, end: number]> {
  const ranges: Array<[start: number, end: number]> = [];
  let open: { character: string; length: number; start: number } | null = null;
  for (const match of markdown.matchAll(/^ {0,3}(`{3,}|~{3,})[^\n]*$/gm)) {
    const fence = match[1]!;
    if (!open) {
      open = { character: fence[0]!, length: fence.length, start: match.index };
    } else if (fence[0] === open.character && fence.length >= open.length) {
      ranges.push([open.start, match.index + match[0].length]);
      open = null;
    }
  }
  if (open) ranges.push([open.start, markdown.length]);
  return ranges;
}

function paperHeadingRole(title: string): PaperHeadingRole {
  const normalized = canonicalHeadingBody(title);
  if (/^(table of contents|contents|sumario|indice|sommaire|list of figures|list of tables|lista de figuras|lista de tabelas)$/.test(normalized)) return "toc";
  if (/^(abstract|summary|resumo|resumen|resume|riassunto|sommario|sintesi|zusammenfassung)(\b|$)/.test(normalized)) return "frontmatter";
  if (/^(appendix|appendices|apendice|apendices|annexe|annexes|appendice|appendici|anexo|anexos)(\b|$)/.test(normalized)) return "appendix";
  if (/^(references|reference list|referencias|referencias bibliograficas|bibliography|bibliografia|bibliographie|riferimenti bibliografici|literatur|literaturverzeichnis|notes|notas|note)(\b|$)/.test(normalized)) return "backmatter";
  if (/^(acknowledg(e)?ments?|agradecimentos?|agradecimientos?|remerciements|ringraziamenti|danksagung|declarations?|declaracoes|declaraciones|dichiarazioni|funding|financiamento|financiacion|competing interests|conflicts? of interest|conflitos? de interesses|conflits? d interets|conflitti? di interesse|data availability|availability of data and materials|disponibilidade de dados|author contributions?|contribuicoes? dos autores|supplementary materials?|supplementary information)(\b|$)/.test(normalized)) return "backmatter";
  if (/^(introduction|introducao|introduccion|introduzione|einleitung|background|antecedentes|fundamentacao teorica|referencial teorico|theoretical framework|marco teorico|cadre theorique|quadro teorico|theoretischer rahmen|revisao de literatura|literature review|review of the literature|revue de la litterature|etat de l art|stato dell arte|hintergrund)(\b|$)/.test(normalized)) return "core";
  if (/^(materials? and methods?|materials? methods?|methods? and materials?|methods?|methodology|materiais? e metodos?|metodos?|metodologia|materiales? y metodos?|metodos? y materiales?|metodologia|materiels? et methodes|materiaux et methodes|methodologie|materiali e metodi|metodologia|methoden)(\b|$)/.test(normalized)) return "core";
  if (/^(results?|resultados|resultats|risultati|ergebnisse|discussion|discussao|discusion|discussione|diskussion)(\b|$)/.test(normalized)) return "core";
  if (/^(conclusions?|conclusao|conclusoes|consideracoes finais|conclusiones|consideraciones finales|conclusioni|considerazioni finali|schlussfolgerungen|fazit|outlook|perspectives|future work|trabalhos futuros|travaux futurs|lavori futuri)(\b|$)/.test(normalized)) return "core";
  if (/^(authors?|autores?|auteurs?|autori|author information|corresponding author|autor correspondente|autor de correspondencia|auteur correspondant|autore corrispondente|affiliations?|correspondence|keywords?|palavras chave|palabras clave|mots cles|parole chiave|schlusselworter|jel classification|how to cite|suggested citation|citation)(\b|$)/.test(normalized)) return "metadata";
  if (/^(review|original article|research article|review article|article|artigo|articulo|case report|short communication|project muse|modelo institucional|artigo cientifico|terms and conditions|rights and permissions|publisher s note)(\b|$)/.test(normalized)) return "metadata";
  return "unknown";
}

function isRejectedPaperHeading(heading: PaperMarkdownHeading): boolean {
  if (heading.role === "toc" || heading.role === "metadata") return true;
  if (heading.title.length > 300 || /^(```|~~~|[-*_]{3,}|https?:\/\/)/i.test(heading.title)) return true;
  if (/^#\/(pictures|tables)\//.test(heading.block?.parentRef ?? "")) return true;
  return /^(figure|fig\.?|figura|abbildung|table|tabela|tabla|tableau|tabella|quadro)\s*(?:\d+|[ivxlcdm]+)?\s*[:.\-]/i
    .test(heading.title.trim());
}

function isTerminalBackmatter(title: string): boolean {
  return /^(references|reference list|referencias|referencias bibliograficas|bibliography|bibliografia|bibliographie|riferimenti bibliografici|literatur|literaturverzeichnis)(\b|$)/
    .test(canonicalHeadingBody(title));
}

function sectionNumberLevel(title: string): number | null {
  const folded = foldHeadingText(title);
  const arabic = /^\s*(?:(?:section|secao|seccion|sezione)\s+)?(\d+(?:\s*\.\s*\d+)*)(?:\s*[.)])?(?=\s+)/.exec(folded);
  if (arabic?.[1]) return Math.max(0, arabic[1].split(".").length - 1);
  return /^\s*[ivxlcdm]+[.)]\s+/i.test(folded) ? 0 : null;
}

function canonicalHeadingBody(title: string): string {
  const folded = foldHeadingText(title)
    .replace(/^\s*(?:(?:section|secao|seccion|sezione)\s+)?\d+(?:\s*\.\s*\d+)*(?:\s*[.)])?\s+/, "")
    .replace(/^\s*[ivxlcdm]+[.)]\s+/i, "");
  return canonicalHeadingText(folded);
}

function foldHeadingText(value: string): string {
  return value.normalize("NFKD").replace(/\p{Diacritic}/gu, "").replace(/[\u00a0\u2007\u202f]/g, " ").toLowerCase();
}

function canonicalHeadingText(value: string): string {
  return foldHeadingText(value).replace(/[^\p{Letter}\p{Number}]+/gu, " ").replace(/\s+/g, " ").trim();
}

function paperHeadingConfidence(heading: PaperMarkdownHeading): number {
  const structured = heading.block !== undefined;
  if (heading.numberLevel !== null) return structured ? 0.92 : 0.84;
  if (heading.role !== "unknown") return structured ? 0.9 : 0.82;
  return structured ? 0.76 : 0.62;
}

function paperHeadingEvidence(heading: PaperMarkdownHeading): DocumentDivisionCandidate["evidence"] {
  return [
    { kind: "heading", source: "canonical-markdown", score: 0.72,
      metadata: { offset: heading.markdownStart, level: heading.markdownLevel } },
    ...(heading.block ? [{ kind: "heading-agreement", source: "docling-heading", score: 0.86,
      metadata: { blockId: heading.block.id, ...(heading.block.page ? { page: heading.block.page } : {}),
        ...(heading.block.boundingBox ? { boundingBox: heading.block.boundingBox } : {}) } }] : []),
    ...(heading.numberLevel !== null ? [{ kind: "section-numbering", source: "paper-numbering", score: 0.9,
      metadata: { depth: heading.numberLevel + 1 } }] : []),
    ...(["frontmatter", "core", "backmatter", "appendix"].includes(heading.role)
      ? [{ kind: "lexical-heading", source: "multilingual-paper-lexicon", score: 0.82,
        metadata: { role: heading.role } }]
      : [])
  ];
}

function findResolvedHeadingParent<T extends { level: number }>(headings: T[], index: number): T | null {
  const level = headings[index]?.level ?? 0;
  if (level === 0) return null;
  for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
    if ((headings[candidate]?.level ?? level) < level) return headings[candidate] ?? null;
  }
  return null;
}

function averageConfidence(divisions: DocumentDivisionCandidate[]): number {
  return divisions.reduce((total, division) => total + division.confidence, 0) / Math.max(1, divisions.length);
}

export function detectMarkdownStructure(
  markdown: string,
  documentKind: StructureDetectionInput["documentKind"] = "other"
): StructureDetectionResult {
  if (documentKind === "paper") {
    const detected = divisionsFromPaperMarkdown(markdown, [], undefined, "markdown");
    return {
      format: "markdown", detectorVersion: "markdown-paper-v2",
      overallConfidence: detected.divisions.length > 0 ? averageConfidence(detected.divisions) : 0.1,
      divisions: detected.divisions,
      warnings: detected.divisions.length > 0 ? [] : ["structure.markdown.noHeadings"],
      metadata: { headingCount: detected.headingCount, rejectedHeadingCount: detected.rejectedCount }
    };
  }
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
  const normalized = canonicalHeadingBody(title);
  const paperRole = paperHeadingRole(title);
  if (/^(part|parte|partie)\b/.test(normalized)) return "part";
  if (paperRole === "appendix") return "appendix";
  if (paperRole === "frontmatter" || /^(preface|prefacio|foreword|avant propos|premessa)\b/.test(normalized)) return "frontmatter";
  if (paperRole === "backmatter" || /^(index|indice)\b/.test(normalized)) return "backmatter";
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
