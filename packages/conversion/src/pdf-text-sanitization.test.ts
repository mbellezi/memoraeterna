import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import { describe, expect, it } from "vitest";

import { extractFileMetadata } from "./metadata-extraction.js";
import { detectDocumentStructure, detectPdfStructure } from "./structure-detection.js";
import type { MarkdownConversionResult } from "./types.js";

/** PDF text strings are UTF-16BE with a BOM; producers often pad them with U+0000. */
const utf16 = (text: string) =>
  `<FEFF${[...text].map((character) => character.charCodeAt(0).toString(16).padStart(4, "0")).join("")}>`;
const hasNul = (value: unknown) => JSON.stringify(value).includes("\\u0000");

describe("PDF text sanitization", () => {
  it("uses a fixture whose strings pdfjs really decodes with U+0000", async () => {
    const loadingTask = getDocument({ data: nulPaddedPdf(), useSystemFonts: false });
    const document = await loadingTask.promise;
    try {
      const metadata = await document.getMetadata();
      const outline = await document.getOutline();
      expect((metadata.info as { Title: string }).Title).toContain("\0");
      expect(outline[0]?.title).toContain("\0");
    } finally {
      await loadingTask.destroy();
    }
  });

  it("strips NUL padding from PDF Info metadata before it becomes a descriptor", async () => {
    const draft = await extractFileMetadata({
      sourceType: "AcademicPaper",
      data: nulPaddedPdf(),
      fileName: "paper.pdf",
      mimeType: "application/pdf"
    });
    expect(draft.values).toMatchObject({
      title: "Ebbinghaus Forgetting Curve",
      description: "Memory",
      creators: [{ name: "Jaap Murre", role: "author" }],
      tags: ["memory", "forgetting"]
    });
    expect(hasNul(draft)).toBe(false);
  });

  it("strips NUL from the metadata a converter returned", async () => {
    const draft = await extractFileMetadata({
      sourceType: "AcademicPaper",
      fileName: "Microsoft Word - final.pdf",
      mimeType: "application/pdf",
      conversion: {
        ...conversion("## Abstract\n\nText.\n"),
        metadata: { title: "Converted\0 Title", author: "Ada\0 Author", language: "en\0" }
      }
    });
    expect(draft.values).toMatchObject({
      title: "Converted Title",
      creators: [{ name: "Ada Author", role: "author" }],
      language: "en"
    });
    expect(hasNul(draft)).toBe(false);
  });

  it("strips NUL padding from PDF outline titles in the detected structure", async () => {
    const markdown = "## Abstract\n\nAbstract text.\n\n## Introduction\n\nIntroduction text.\n";
    const result = await detectPdfStructure(conversion(markdown), "paper", nulPaddedPdf());
    expect(result.divisions.map((division) => division.title)).toEqual([
      "Paper title",
      "Abstract",
      "Introduction"
    ]);
    expect(result.divisions.map((division) => division.startSelector.bookmark)).toEqual([
      "Paper title",
      "Abstract",
      "Introduction"
    ]);
    expect(hasNul(result)).toBe(false);

    const viaDispatcher = await detectDocumentStructure({
      data: nulPaddedPdf(),
      fileName: "paper.pdf",
      mimeType: "application/pdf",
      conversion: conversion(markdown),
      documentKind: "paper"
    });
    expect(hasNul(viaDispatcher)).toBe(false);
  });

  it("strips NUL from titles of a structure detected in Markdown", async () => {
    const result = await detectDocumentStructure({
      fileName: "paper.md",
      conversion: conversion("## Intro\0duction\n\nText.\n"),
      documentKind: "paper"
    });
    expect(hasNul(result)).toBe(false);
  });
});

function conversion(markdown: string): MarkdownConversionResult {
  return {
    status: "converted",
    markdown,
    contentHash: "c".repeat(64),
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

function nulPaddedPdf(): Uint8Array {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R /Outlines 5 0 R >>",
    "<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 10 0 R /Resources << >> >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 10 0 R /Resources << >> >>",
    "<< /Type /Outlines /First 6 0 R /Last 6 0 R /Count 3 >>",
    `<< /Title ${utf16("Paper title\0\0")} /Parent 5 0 R /Dest [3 0 R /Fit] /First 7 0 R /Last 8 0 R /Count 2 >>`,
    `<< /Title ${utf16("\0Abstract\0")} /Parent 6 0 R /Dest [3 0 R /Fit] /Next 8 0 R >>`,
    `<< /Title ${utf16("Intro\0duction")} /Parent 6 0 R /Dest [3 0 R /Fit] /Prev 7 0 R >>`,
    `<< /Title ${utf16("Ebbinghaus Forgetting Curve\0\0")} /Author ${utf16("Jaap\0 Murre\0")} /Subject ${utf16("Memory\0")} /Keywords ${utf16("memory\0, forgetting\0")} >>`,
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
  pdf += offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join("");
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 9 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return new TextEncoder().encode(pdf);
}
