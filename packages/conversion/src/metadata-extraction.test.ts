import { zipSync } from "fflate";
import { describe, expect, it } from "vitest";

import {
  descriptorDraftFromVideoMetadata,
  descriptorDraftFromWebMetadata,
  extractFileMetadata
} from "./metadata-extraction.js";
import type { MarkdownConversionResult } from "./types.js";

const encoder = new TextEncoder();

describe("metadata extraction", () => {
  it("extracts EPUB OPF metadata, ISBN and cover", async () => {
    const epub = zipSync({
      "META-INF/container.xml": encoder.encode(`<?xml version="1.0"?><container><rootfiles><rootfile full-path="OEBPS/package.opf"/></rootfiles></container>`),
      "OEBPS/package.opf": encoder.encode(`<?xml version="1.0"?><package xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:opf="http://www.idpf.org/2007/opf"><metadata>
        <dc:title>Precise Book</dc:title><dc:creator opf:role="aut">Ada Author</dc:creator>
        <dc:publisher>Local Press</dc:publisher><dc:language>pt-BR</dc:language>
        <dc:identifier>0-306-40615-2</dc:identifier><dc:subject>Knowledge</dc:subject>
        <dc:description>A test book.</dc:description></metadata><manifest>
        <item id="cover" href="cover.jpg" media-type="image/jpeg" properties="cover-image"/>
        </manifest></package>`),
      "OEBPS/cover.jpg": new Uint8Array([0xff, 0xd8, 0xff, 0xd9])
    });
    const draft = await extractFileMetadata({
      sourceType: "Book",
      data: epub,
      fileName: "fallback-name.epub",
      mimeType: "application/epub+zip"
    });
    expect(draft.warnings).toEqual([]);
    expect(draft.values).toMatchObject({
      title: "Precise Book",
      publisher: "Local Press",
      language: "pt-BR",
      isbn10: "0306406152",
      isbn13: "9780306406157",
      creators: [{ name: "Ada Author", role: "author" }]
    });
    expect(draft.coverData?.mimeType).toBe("image/jpeg");
    expect(draft.provenance.title?.evidence).toBe("epub-opf");
  });

  it("uses PDF page heuristics when Info metadata is unavailable", async () => {
    const conversion = converted(`# Reliable Paper\n\nISBN 978-0-306-40615-7\n\nDOI: 10.5555/example.42`);
    const draft = await extractFileMetadata({
      sourceType: "AcademicPaper",
      data: new Uint8Array([1, 2, 3]),
      fileName: "Microsoft Word - final.pdf",
      mimeType: "application/pdf",
      conversion
    });
    expect(draft.values.title).toBe("Reliable Paper");
    expect(draft.values.isbn13).toBe("9780306406157");
    expect(draft.values.doi).toBe("10.5555/example.42");
    expect(draft.warnings[0]).toContain("metadata.extraction.failed");
  });

  it("never blocks an import when extraction fails", async () => {
    const draft = await extractFileMetadata({
      sourceType: "Book",
      data: new Uint8Array([1, 2, 3]),
      fileName: "my_book.epub",
      mimeType: "application/epub+zip"
    });
    expect(draft.values.title).toBe("my book");
    expect(draft.warnings).toHaveLength(1);
  });

  it("maps Defuddle and YouTube metadata into typed descriptor drafts", () => {
    const web = descriptorDraftFromWebMetadata({
      title: "Article",
      url: "https://example.test/article",
      metadata: { author: "Ada Author", site: "Example", published: "2026-07-15" }
    });
    expect(web.values).toMatchObject({
      creators: [{ name: "Ada Author", role: "author" }],
      siteName: "Example",
      publicationDate: "2026-07-15"
    });
    const video = descriptorDraftFromVideoMetadata({
      title: "Video",
      metadata: { channel: "Memora Channel", durationSeconds: 120, videoId: "abc" }
    });
    expect(video.values).toMatchObject({
      channel: "Memora Channel",
      durationSeconds: 120,
      creators: [{ name: "Memora Channel", role: "channel" }]
    });
  });
});

function converted(markdown: string): MarkdownConversionResult {
  return {
    status: "converted",
    markdown,
    contentHash: "a".repeat(64),
    blocks: [{
      id: "heading-1",
      type: "section_header",
      text: "Reliable Paper",
      page: 1,
      markdownStart: 0,
      markdownEnd: 16
    }, {
      id: "text-1",
      type: "text",
      text: markdown,
      page: 1,
      markdownStart: 0,
      markdownEnd: markdown.length
    }],
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
