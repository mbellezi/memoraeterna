import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";

import { detectEpubStructure, detectMarkdownStructure } from "./structure-detection.js";

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

  it("detects Markdown heading boundaries", () => {
    const result = detectMarkdownStructure("# Chapter 1\n\nText\n\n## Detail\n\nMore", "book");
    expect(result.divisions.map((division) => division.kind)).toEqual(["chapter", "subsection"]);
    expect(result.divisions[1]?.parentId).toBe(result.divisions[0]?.id);
  });
});
