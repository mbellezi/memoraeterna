import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { validateDivisionTree } from "@app/domain";

import type { ConversionBlock, MarkdownConversionResult } from "./types.js";
import {
  detectEpubStructure,
  detectMarkdownStructure,
  detectPdfStructure,
  readPdfPageCount
} from "./structure-detection.js";

describe("structure detection", () => {
  it("reads EPUB 3 navigation and preserves nested navigation", () => {
    const epub = zipSync({
      "META-INF/container.xml": strToU8('<?xml version="1.0"?><container><rootfiles><rootfile full-path="EPUB/package.opf"/></rootfiles></container>'),
      "EPUB/package.opf": strToU8('<package><manifest><item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/><item id="c1" href="c1.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="c1"/></spine></package>'),
      "EPUB/nav.xhtml": strToU8('<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol><li><a href="c1.xhtml">Chapter 1</a><ol><li><a href="c1.xhtml#s1">Section A</a></li></ol></li></ol></nav></body></html>'),
      "EPUB/c1.xhtml": strToU8('<html><body><h1>Chapter 1</h1><p>Text</p><h2 id="s1">Section A</h2></body></html>')
    });
    const result = detectEpubStructure(epub, "book");
    expect(result.divisions).toHaveLength(2);
    expect(result.divisions[0]?.kind).toBe("chapter");
    expect(result.divisions[1]?.parentId).toBe(result.divisions[0]?.id);
    expect(result.overallConfidence).toBeGreaterThan(0.9);
  });

  it("rejects EPUB traversal paths", () => {
    const epub = zipSync({
      "META-INF/container.xml": strToU8('<container><rootfiles><rootfile full-path="../package.opf"/></rootfiles></container>')
    });
    expect(() => detectEpubStructure(epub)).toThrow("epub_path_traversal_rejected");
  });

  it("aligns EPUB navigation to canonical Markdown instead of XHTML text offsets", () => {
    const epub = epubWithNavigation([
      '<li><a href="front.xhtml">Contents</a></li>',
      '<li><a href="part.xhtml">Part One</a><ol>',
      '<li><a href="chapter-1.xhtml">Chapter One</a><ol><li><a href="chapter-1.xhtml#detail">A detail</a></li></ol></li>',
      '<li><a href="chapter-2.xhtml">Chapter Two</a></li>',
      "</ol></li>"
    ].join(""));
    const markdown = [
      "# Contents", "", "Part One", "Chapter One", "A detail", "Chapter Two", "",
      "# PART ONE", "", "# Chapter One", "", "Opening.", "", "## A detail", "", "Detail text.", "",
      "# Chapter Two", "", "Second chapter."
    ].join("\n");
    const result = detectEpubStructure(epub, "book", epubConversion(markdown));
    const [contents, part, chapterOne, detail, chapterTwo] = result.divisions;

    expect(result.detectorVersion).toBe("epub-navigation-markdown-v2");
    expect(result.warnings).toEqual([]);
    expect([contents?.kind, part?.kind, chapterOne?.kind, detail?.kind, chapterTwo?.kind]).toEqual([
      "frontmatter", "part", "chapter", "subsection", "chapter"
    ]);
    expect(result.divisions.map((division) => division.isProcessable)).toEqual([false, false, true, false, true]);
    expect(chapterOne?.markdownStart).toBe(markdown.lastIndexOf("# Chapter One"));
    expect(chapterOne?.markdownEnd).toBe(markdown.lastIndexOf("# Chapter Two"));
    expect(detail?.parentId).toBe(chapterOne?.id);
    expect(chapterTwo?.markdownEnd).toBe(markdown.length);
    expect(validateDivisionTree(result.divisions)).toEqual([]);
  });

  it("aligns headingless EPUB Markdown and skips duplicate table-of-contents titles", () => {
    const epub = epubWithNavigation([
      '<li><a href="chapter-1.xhtml">Chapter One</a></li>',
      '<li><a href="chapter-2.xhtml">Chapter Two</a></li>'
    ].join(""));
    const markdown = [
      "CONTENTS", "Chapter One", "Chapter Two", "", "Chapter One", "Body one.", "", "Chapter Two", "Body two."
    ].join("\n");
    const result = detectEpubStructure(epub, "book", epubConversion(markdown));

    expect(result.divisions[0]?.markdownStart).toBe(markdown.lastIndexOf("Chapter One"));
    expect(result.divisions[1]?.markdownStart).toBe(markdown.lastIndexOf("Chapter Two"));
    expect(result.divisions.every((division) => division.isProcessable)).toBe(true);
    expect(validateDivisionTree(result.divisions)).toEqual([]);
  });

  it("detects Markdown heading boundaries", () => {
    const result = detectMarkdownStructure("# Chapter 1\n\nText\n\n## Detail\n\nMore", "book");
    expect(result.divisions.map((division) => division.kind)).toEqual(["chapter", "subsection"]);
    expect(result.divisions[1]?.parentId).toBe(result.divisions[0]?.id);
  });

  it("segments bookmarkless PDF books from canonical Markdown when Docling block offsets saturate", async () => {
    const markdown = [
      "## PREFACE", "", "Preface.", "", "## PART ONE", "", "## Chapter 1", "", "## First Principles", "",
      "Chapter one.", "", "## REFERENCES FOR SUPPLEMENTARY READING", "", "References.", "",
      "## Chapter 2", "", "## The Path", "", "Chapter two.", "", "## Appendix I", "", "Appendix."
    ].join("\n");
    const specs: PaperBlockSpec[] = [
      ["PREFACE", 3, 50], ["PART ONE", 5, 50], ["Chapter 1", 7, 50], ["First Principles", 7, 50],
      ["REFERENCES FOR SUPPLEMENTARY READING", 12, 50], ["Chapter 2", 15, 50], ["The Path", 15, 50],
      ["Appendix I", 22, 50]
    ];
    const blocks = paperBlocks(markdown, specs).map((block) => ({
      ...block,
      markdownStart: markdown.length,
      markdownEnd: markdown.length
    }));
    const result = await detectPdfStructure(paperConversion(markdown, blocks, 24), "book");

    expect(result.divisions.map((division) => [division.title, division.kind, division.level])).toEqual([
      ["PREFACE", "frontmatter", 0],
      ["PART ONE", "part", 0],
      ["Chapter 1: First Principles", "chapter", 1],
      ["Chapter 2: The Path", "chapter", 1],
      ["Appendix I", "appendix", 0]
    ]);
    expect(result.divisions.filter((division) => division.isProcessable).map((division) => division.title)).toEqual([
      "Chapter 1: First Principles", "Chapter 2: The Path", "Appendix I"
    ]);
    expect(result.divisions.every((division) => division.markdownEnd! > division.markdownStart!)).toBe(true);
    expect(validateDivisionTree(result.divisions)).toEqual([]);
  });

  it("ignores printed contents and recovers missing Roman book chapters after summaries", async () => {
    const markdown = [
      "## I - The model of variants", "", "## II - Pendulums", "", "## III - The wave of success", "",
      "## IV - Balance", "", "## V - Induced transition", "", "## PREFACE", "", "Opening.", "",
      "## 一 Model of variants", "", "Chapter one.", "", "## SUMMARY", "", "Summary one.", "",
      "## Pendulums and their destructive action", "", "Chapter two.", "", "## SUMMARY", "", "Summary two.", "",
      "## III The wave of success", "", "Chapter three.", "", "## SUMMARY", "", "Summary three.", "",
      "## The balance of opposing forces", "", "Chapter four.", "", "## SUMMARY", "", "Summary four.", "",
      "## V Induced transition", "", "Chapter five."
    ].join("\n");
    const blocks = paperBlocks(markdown, [
      ["I - The model of variants", 2, 50], ["II - Pendulums", 2, 50],
      ["III - The wave of success", 2, 50], ["IV - Balance", 2, 50], ["V - Induced transition", 2, 50],
      ["PREFACE", 5, 50], ["一 Model of variants", 12, 50], ["SUMMARY", 42, 50],
      ["Pendulums and their destructive action", 53, 50], ["SUMMARY", 86, 50],
      ["III The wave of success", 94, 50], ["SUMMARY", 106, 50],
      ["The balance of opposing forces", 111, 50], ["SUMMARY", 176, 50],
      ["V Induced transition", 183, 50]
    ]);
    const result = await detectPdfStructure(paperConversion(markdown, blocks, 214), "book");

    expect(result.divisions.filter((division) => division.isProcessable).map((division) => division.title)).toEqual([
      "一 Model of variants",
      "II - Pendulums",
      "III The wave of success",
      "IV - Balance",
      "V Induced transition"
    ]);
    expect(result.divisions.filter((division) => division.isProcessable).map((division) => division.startPage)).toEqual([
      12, 53, 94, 111, 183
    ]);
    expect(validateDivisionTree(result.divisions)).toEqual([]);
  });

  it("recognizes multilingual stanzas as chapters but ignores stanza headings inside the glossary", async () => {
    const markdown = [
      "## INTRODUÇÃO", "", "Opening.", "", "## PARTE I", "", "## ESTÂNCIA I", "", "First text.", "",
      "## ESTÂNCIA II", "", "Second text.", "", "## ESTÂNCIA III", "", "## O despertar", "", "Commentary.", "",
      "## BIBLIOGRAFIA", "", "References.", "", "## GLOSSÁRIO", "", "## ESTÂNCIA I", "", "Definition."
    ].join("\n");
    const blocks = paperBlocks(markdown, [
      ["INTRODUÇÃO", 4, 50], ["PARTE I", 10, 50], ["ESTÂNCIA I", 12, 50],
      ["ESTÂNCIA II", 18, 50], ["ESTÂNCIA III", 24, 50], ["O despertar", 24, 50],
      ["BIBLIOGRAFIA", 40, 50], ["GLOSSÁRIO", 44, 50], ["ESTÂNCIA I", 45, 50]
    ]);
    const result = await detectPdfStructure(paperConversion(markdown, blocks, 50), "book");

    expect(result.divisions.filter((division) => division.isProcessable).map((division) => division.title)).toEqual([
      "ESTÂNCIA I", "ESTÂNCIA II", "ESTÂNCIA III: O despertar"
    ]);
    expect(result.divisions.at(-1)?.title).toBe("GLOSSÁRIO");
    expect(validateDivisionTree(result.divisions)).toEqual([]);
  });

  it("segments concatenated chapter markers in a scanned book after its printed contents", async () => {
    const markdown = [
      "## SUMARIO", "", "## CAPITULOI", "", "## CAPITULOII", "", "## CAPITULOIII", "", "## CAPITULOIV", "",
      "## NOTAEXPLICATTVA", "", "Note.", "", "## CAPITULOI", "", "One.", "", "## CAPITULOII", "", "Two.", "",
      "## CAPITULOⅢI", "", "Three.", "", "## CAPITULOIV", "", "Four."
    ].join("\n");
    const blocks = paperBlocks(markdown, [
      ["SUMARIO", 4, 50], ["CAPITULOI", 4, 50], ["CAPITULOII", 4, 50], ["CAPITULOIII", 4, 50],
      ["CAPITULOIV", 4, 50], ["NOTAEXPLICATTVA", 12, 50], ["CAPITULOI", 14, 50],
      ["CAPITULOII", 37, 50], ["CAPITULOⅢI", 60, 50], ["CAPITULOIV", 83, 50]
    ]);
    const result = await detectPdfStructure(paperConversion(markdown, blocks, 100), "book");

    expect(result.divisions.filter((division) => division.isProcessable).map((division) => division.title)).toEqual([
      "CAPITULO I", "CAPITULO II", "CAPITULO III", "CAPITULO IV"
    ]);
    expect(result.divisions.filter((division) => division.isProcessable).map((division) => division.startPage)).toEqual([
      14, 37, 60, 83
    ]);
    expect(validateDivisionTree(result.divisions)).toEqual([]);
  });

  it("aligns same-page PDF outline siblings independently and processes paper sections, not the root", async () => {
    const markdown = [
      "## ORIGINAL ARTICLE", "", "## Paper title", "", "Metadata.", "", "## Abstract", "", "Abstract text.", "",
      "## Introduction", "", "Introduction text."
    ].join("\n");
    const blocks = paperBlocks(markdown, [
      ["ORIGINAL ARTICLE", 1, 50], ["Paper title", 1, 50], ["Abstract", 1, 50], ["Introduction", 1, 50]
    ]);
    const result = await detectPdfStructure(
      paperConversion(markdown, blocks, 2),
      "paper",
      pdfWithNestedOutline("Paper title", ["Abstract", "Introduction"])
    );

    expect(result.divisions.map((division) => [division.title, division.markdownStart, division.markdownEnd])).toEqual([
      ["Paper title", markdown.indexOf("## Paper title"), markdown.length],
      ["Abstract", markdown.indexOf("## Abstract"), markdown.indexOf("## Introduction")],
      ["Introduction", markdown.indexOf("## Introduction"), markdown.length]
    ]);
    expect(result.divisions.map((division) => division.isProcessable)).toEqual([false, true, true]);
    expect(validateDivisionTree(result.divisions)).toEqual([]);
  });

  it("reads a PDF page count before the full Docling conversion starts", async () => {
    await expect(readPdfPageCount(
      pdfWithNestedOutline("Paper title", ["Abstract", "Introduction"])
    )).resolves.toBe(2);
  });

  it("segments a paper from canonical Markdown and ignores title-page noise", async () => {
    const markdown = [
      "## MARCOS AUGUSTO BELLEZI", "", "## A ONTOLOGIA DO IDEALISMO E A FÍSICA QUÂNTICA", "",
      "## Autores", "", "Nomes", "", "## RESUMO", "", "Resumo.", "", "## ABSTRACT", "", "Abstract.", "",
      "## INTRODUÇÃO", "", "Introdução.", "", "## MATERIAL E MÉTODOS", "", "Métodos.", "",
      "## REVISÃO DE LITERATURA", "", "Revisão.", "", "## As anomalias", "", "Texto.", "",
      "## A Física Quântica, seus experimentos e interpretações", "", "Texto.", "", "## DISCUSSÃO", "",
      "Discussão.", "", "## CONSIDERAÇÕES FINAIS", "", "Conclusão.", "", "## REFERÊNCIAS", "", "Referências."
    ].join("\n");
    const blocks = paperBlocks(markdown, [
      ["MARCOS AUGUSTO BELLEZI", 1, 211],
      ["A ONTOLOGIA DO IDEALISMO E A FÍSICA QUÂNTICA", 1, 80],
      ["Autores", 2, 277],
      ["RESUMO", 2, 56], ["ABSTRACT", 2, 56], ["INTRODUÇÃO", 2, 56],
      ["MATERIAL E MÉTODOS", 3, 56], ["REVISÃO DE LITERATURA", 3, 56],
      ["As anomalias", 3, 99], ["A Física Quântica, seus experimentos e interpretações", 5, 99],
      ["DISCUSSÃO", 13, 56], ["CONSIDERAÇÕES FINAIS", 15, 56], ["REFERÊNCIAS", 16, 56]
    ]);
    const result = await detectPdfStructure(paperConversion(markdown, blocks, 16), "paper");

    expect(result.divisions.map((division) => division.title)).toEqual([
      "RESUMO", "ABSTRACT", "INTRODUÇÃO", "MATERIAL E MÉTODOS", "REVISÃO DE LITERATURA",
      "As anomalias", "A Física Quântica, seus experimentos e interpretações",
      "DISCUSSÃO", "CONSIDERAÇÕES FINAIS", "REFERÊNCIAS"
    ]);
    expect(result.divisions.map((division) => division.level)).toEqual([0, 0, 0, 0, 0, 1, 1, 0, 0, 0]);
    expect(result.divisions[5]?.parentId).toBe(result.divisions[4]?.id);
    expect(result.divisions.every((division) => division.markdownEnd! > division.markdownStart!)).toBe(true);
    expect(result.divisions.every((division) => division.isProcessable)).toBe(true);
    expect(validateDivisionTree(result.divisions)).toEqual([]);
    expect(result.metadata.rejectedMarkdownHeadingCount).toBe(3);
  });

  it("infers numbered section depth and parents from paper Markdown", () => {
    const result = detectMarkdownStructure([
      "## TÍTULO DO ARTIGO", "", "## SUMÁRIO", "", "## 1 INTRODUÇÃO", "", "Texto.", "",
      "## 1.1 CONTEXTO", "", "Texto.", "", "## 1.1.1 Detalhe", "", "Texto.", "",
      "## 2 CONCLUSÃO", "", "Texto.", "", "## REFERÊNCIAS", "", "Lista."
    ].join("\n"), "paper");

    expect(result.divisions.map((division) => [division.title, division.level])).toEqual([
      ["1 INTRODUÇÃO", 0], ["1.1 CONTEXTO", 1], ["1.1.1 Detalhe", 2], ["2 CONCLUSÃO", 0], ["REFERÊNCIAS", 0]
    ]);
    expect(result.divisions[1]?.parentId).toBe(result.divisions[0]?.id);
    expect(result.divisions[2]?.parentId).toBe(result.divisions[1]?.id);
    expect(result.divisions[3]?.parentId).toBeNull();
  });

  it.each([
    ["French", ["Résumé", "Introduction", "Matériel et méthodes", "Résultats", "Discussion", "Conclusions", "Références"]],
    ["Spanish", ["Resumen", "Introducción", "Materiales y métodos", "Resultados", "Discusión", "Conclusiones", "Referencias"]],
    ["Italian", ["Riassunto", "Introduzione", "Materiali e metodi", "Risultati", "Discussione", "Conclusioni", "Bibliografia"]],
    ["German", ["Zusammenfassung", "Einleitung", "Methoden", "Ergebnisse", "Diskussion", "Schlussfolgerungen", "Literatur"]]
  ])("recognizes %s paper sections", (_language, headings) => {
    const markdown = ["## Article title", "", ...headings.flatMap((heading) => [`## ${heading}`, "", "Text.", ""])]
      .join("\n");
    const result = detectMarkdownStructure(markdown, "paper");
    expect(result.divisions.map((division) => division.title)).toEqual(headings);
    expect(result.divisions[0]?.kind).toBe("frontmatter");
    expect(result.divisions.at(-1)?.kind).toBe("backmatter");
  });

  it("falls back to unique headings after repeated publication front matter", async () => {
    const title = "Social Evolution between Spielrein, Freud, and Jung";
    const markdown = [
      "## PROJECT MUSE", "", `## ${title}`, "", "Metadata.", "", `## ${title}`, "", "Article.", "",
      "## Social Evolution According to Jung", "", "Text.", "", "## Social Evolution According to Freud", "",
      "Text.", "", "## Sabina Spielrein, Evolution, and Social Politics", "", "Text.", "", "## Notes", "",
      "Notes.", "", "## References", "", "References."
    ].join("\n");
    const blocks = paperBlocks(markdown, [
      ["PROJECT MUSE", 1, 213], [title, 1, 30], [title, 2, 81],
      ["Social Evolution According to Jung", 3, 124], ["Social Evolution According to Freud", 9, 120],
      ["Sabina Spielrein, Evolution, and Social Politics", 15, 95], ["Notes", 22, 176], ["References", 23, 181]
    ]);
    const result = await detectPdfStructure(paperConversion(markdown, blocks, 24), "paper");
    expect(result.divisions.map((division) => division.title)).toEqual([
      "Social Evolution According to Jung", "Social Evolution According to Freud",
      "Sabina Spielrein, Evolution, and Social Politics", "Notes", "References"
    ]);
  });

  it("does not infer a subsection from indentation after a numbered section", async () => {
    const markdown = [
      "## Paper title", "", "Front matter.", "", "## Nine Technical Points", "", "## 1. First point", "",
      "Text.", "", "## 2. Second point", "", "Text.", "", "## Commentary", "", "Text.", "",
      "## References", "", "List."
    ].join("\n");
    const blocks = paperBlocks(markdown, [
      ["Paper title", 1, 48], ["Nine Technical Points", 3, 142], ["1. First point", 3, 48],
      ["2. Second point", 4, 60], ["Commentary", 13, 169], ["References", 15, 175]
    ]);
    const result = await detectPdfStructure(paperConversion(markdown, blocks, 16), "paper");
    expect(result.divisions.map((division) => [division.title, division.level])).toEqual([
      ["Nine Technical Points", 0], ["1. First point", 0], ["2. Second point", 0],
      ["Commentary", 0], ["References", 0]
    ]);
  });

  it("rejects figure labels, code markers and publisher boilerplate", async () => {
    const markdown = [
      "## REVIEW", "", "## Paper title", "", "## Abstract", "", "Text.", "", "## Keywords", "", "one; two", "",
      "## Introduction", "", "Text.", "", "```markdown", "## Fake heading", "Code.", "```", "",
      "## Disciplines", "", "Image text.", "", "## ```prompt", "", "Prompt.", "", "## Conclusion", "", "Text.", "",
      "## References", "", "List.", "", "## Terms and Conditions", "", "Legal."
    ].join("\n");
    const blocks = paperBlocks(markdown, [
      ["REVIEW", 1, 56], ["Paper title", 1, 51], ["Abstract", 1, 51], ["Keywords", 1, 51], ["Introduction", 1, 51],
      ["Disciplines", 20, 102, "#/pictures/29"], ["```prompt", 20, 114], ["Conclusion", 21, 51],
      ["References", 21, 306], ["Terms and Conditions", 28, 36]
    ]);
    const result = await detectPdfStructure(paperConversion(markdown, blocks, 28), "paper");
    expect(result.divisions.map((division) => division.title)).toEqual(["Abstract", "Introduction", "Conclusion", "References"]);
  });
});

type PaperBlockSpec = [title: string, page: number, left: number, parentRef?: string];

function paperBlocks(markdown: string, specs: PaperBlockSpec[]): ConversionBlock[] {
  return specs.map(([title, page, left, parentRef], index) => ({
    id: `heading-${index}`,
    type: "section_header",
    text: title,
    page,
    boundingBox: { left, top: 700, right: left + 180, bottom: 688 },
    markdownStart: markdown.indexOf(`## ${title}`),
    markdownEnd: markdown.indexOf(`## ${title}`) + title.length + 3,
    ...(parentRef ? { parentRef } : {})
  }));
}

function paperConversion(markdown: string, blocks: ConversionBlock[], pageCount: number): MarkdownConversionResult {
  return {
    status: "converted",
    markdown,
    contentHash: "a".repeat(64),
    blocks,
    assets: [],
    engine: "docling",
    engineVersion: "test",
    profile: "standard",
    options: {},
    warnings: [],
    quality: {},
    metadata: {},
    documentStructure: { body: [], groups: [], pageCount }
  };
}

function epubWithNavigation(navigationItems: string): Uint8Array {
  return zipSync({
    "META-INF/container.xml": strToU8('<?xml version="1.0"?><container><rootfiles><rootfile full-path="EPUB/package.opf"/></rootfiles></container>'),
    "EPUB/package.opf": strToU8([
      "<package><manifest>",
      '<item id="nav" href="nav.xhtml" properties="nav" media-type="application/xhtml+xml"/>',
      '<item id="front" href="front.xhtml" media-type="application/xhtml+xml"/>',
      '<item id="part" href="part.xhtml" media-type="application/xhtml+xml"/>',
      '<item id="c1" href="chapter-1.xhtml" media-type="application/xhtml+xml"/>',
      '<item id="c2" href="chapter-2.xhtml" media-type="application/xhtml+xml"/>',
      '</manifest><spine><itemref idref="front"/><itemref idref="part"/><itemref idref="c1"/><itemref idref="c2"/></spine></package>'
    ].join("")),
    "EPUB/nav.xhtml": strToU8(`<html xmlns:epub="http://www.idpf.org/2007/ops"><body><nav epub:type="toc"><ol>${navigationItems}</ol></nav></body></html>`),
    "EPUB/front.xhtml": strToU8("<html><body><h1>Contents</h1></body></html>"),
    "EPUB/part.xhtml": strToU8("<html><body><h1>Part One</h1></body></html>"),
    "EPUB/chapter-1.xhtml": strToU8('<html><body><h1>Chapter One</h1><h2 id="detail">A detail</h2></body></html>'),
    "EPUB/chapter-2.xhtml": strToU8("<html><body><h1>Chapter Two</h1></body></html>")
  });
}

function epubConversion(markdown: string): MarkdownConversionResult {
  return {
    status: "converted",
    markdown,
    contentHash: "b".repeat(64),
    blocks: [],
    assets: [],
    engine: "docling",
    engineVersion: "test",
    profile: "standard",
    options: {},
    warnings: [],
    quality: {},
    metadata: {}
  };
}

function pdfWithNestedOutline(rootTitle: string, childTitles: [string, string]): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R /Outlines 5 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 10 0 R /Resources << >> >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 10 0 R /Resources << >> >>",
    "<< /Type /Outlines /First 6 0 R /Last 6 0 R /Count 3 >>",
    `<< /Title (${rootTitle}) /Parent 5 0 R /Dest [3 0 R /Fit] /First 7 0 R /Last 8 0 R /Count 2 >>`,
    `<< /Title (${childTitles[0]}) /Parent 6 0 R /Dest [3 0 R /Fit] /Next 8 0 R >>`,
    `<< /Title (${childTitles[1]}) /Parent 6 0 R /Dest [3 0 R /Fit] /Prev 7 0 R >>`,
    "<< >>",
    "<< /Length 0 >>\nstream\n\nendstream"
  ];
  let pdf = "%PDF-1.4\n";
  const offsets = [0];
  for (const [index, object] of objects.entries()) {
    offsets.push(pdf.length);
    pdf += `${index + 1} 0 obj\n${object}\nendobj\n`;
  }
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  pdf += offsets.slice(1).map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`).join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}
