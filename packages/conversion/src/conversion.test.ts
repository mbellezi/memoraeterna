import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

import {
  chunkMarkdown,
  ConversionRouter,
  convertCsv,
  convertNotebook,
  convertWebHtml,
  DoclingClient,
  doclingProgressSchema
} from "./index.js";

const encoder = new TextEncoder();

describe("conversion", () => {
  it("normalizes text and routes by extension", async () => {
    const result = await new ConversionRouter().convert({
      data: encoder.encode("# Title\r\n\r\nBody  \r\n"),
      fileName: "note.md"
    });
    expect(result.markdown).toBe("# Title\n\nBody\n");
    expect(result.contentHash).toHaveLength(64);
  });

  it("converts quoted CSV to a Markdown table", () => {
    const result = convertCsv({
      data: encoder.encode('name,note\nAda,"one, two"'),
      fileName: "data.csv"
    });
    expect(result.markdown).toContain("| Ada | one, two |");
  });

  it("converts notebook cells", () => {
    const result = convertNotebook({
      data: encoder.encode(JSON.stringify({ cells: [{ cell_type: "code", source: ["x = 1\n"] }] })),
      fileName: "sample.ipynb"
    });
    expect(result.markdown).toContain("```python");
  });

  it("chunks by heading and preserves offsets", () => {
    const markdown = "# One\n\nFirst section.\n\n# Two\n\nSecond section.\n";
    const chunks = chunkMarkdown(markdown, [], { targetCharacters: 20, maxCharacters: 40 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(markdown.slice(chunk.startOffset, chunk.endOffset)).toContain(chunk.content);
    }
  });

  it("extracts a rendered web article with Defuddle", async () => {
    const result = await convertWebHtml({
      data: encoder.encode(
        "<html><head><title>Article</title></head><body><article><h1>Article</h1><p>Main evidence with enough useful content for extraction.</p></article></body></html>"
      ),
      fileName: "article.html",
      mimeType: "text/html",
      sourceUrl: "https://example.test/article"
    });
    expect(result.engine).toBe("defuddle");
    expect(result.markdown).toContain("Main evidence");
  });

  it("extracts an HTML fragment that has no html or body tag", async () => {
    // A rendered article body (a Wikipedia action=render response, an element's outerHTML) parses to
    // a document Defuddle finds nothing in unless the fragment is given a document skeleton.
    const fragment =
      '<div class="mw-parser-output" lang="en"><section><p>The forgetting curve describes how memory retention declines over time without rehearsal.</p>' +
      "<h2>History</h2><p>Hermann Ebbinghaus measured retention of nonsense syllables across several days and described the exponential decline.</p></section></div>";
    const result = await convertWebHtml({
      data: encoder.encode(fragment),
      fileName: "capture.html",
      mimeType: "text/html",
      sourceUrl: "https://example.test/forgetting-curve"
    });
    expect(result.status).toBe("converted");
    expect(result.markdown).toContain("forgetting curve describes how memory retention declines");
    expect(result.markdown).toContain("Hermann Ebbinghaus");
    expect(result.warnings).toEqual([]);
  });

  describe("HTML files", () => {
    const convertFile = (html: string, fileName = "saved-page.html") =>
      new ConversionRouter().convert({
        data: encoder.encode(html),
        fileName,
        mimeType: "text/html",
        profile: "standard"
      });

    it("converts a rendered article fragment (no html or body tag) to Markdown", async () => {
      // A MediaWiki action=render response saved to disk: the same markup a web capture sends. It
      // used to parse to an empty body and convert to nothing, which the duplicate check then took
      // for the same document as every other empty conversion.
      const result = await convertFile(
        '<div class="mw-content-ltr mw-parser-output" lang="pt"><section><p>As chronicas da villa de Itaguahy dizem que em tempos remotos vivera alli um certo medico.</p>' +
          "<h2>Capitulo II</h2><p>Estudara em Coimbra e Padua, e regressou ao Brazil aos trinta e quatro annos.</p></section></div>"
      );
      expect(result.status).toBe("converted");
      expect(result.engine).toBe("defuddle");
      expect(result.markdown).toContain("chronicas da villa de Itaguahy");
      expect(result.markdown).toContain("## Capitulo II");
      expect(result.warnings).toEqual([]);
    });

    it("converts a whole saved page and keeps its structure", async () => {
      const result = await convertFile(
        "<!doctype html><html><head><title>Saved page</title></head><body><nav>Menu</nav><article><h1>Saved page</h1>" +
          "<p>First paragraph of the saved page with enough words.</p><h2>Section</h2><p>Second paragraph under the section.</p></article></body></html>",
        "saved-page.htm"
      );
      expect(result.markdown).toContain("First paragraph of the saved page");
      expect(result.markdown).toContain("## Section");
      expect(result.markdown).not.toContain("Menu");
    });

    it("falls back to the page text when no article is found", async () => {
      const result = await convertFile(
        "<html><body><aside>A side note that is the only text on this page.</aside></body></html>"
      );
      expect(result.status).toBe("converted");
      expect(result.engine).toBe("native-html");
      expect(result.markdown).toContain("only text on this page");
    });

    it("reports a file without text as an empty result instead of a conversion", async () => {
      for (const html of ["", "<div class='mw-parser-output'></div>", "<p>&nbsp;</p>"]) {
        const result = await convertFile(html);
        expect(result.markdown).toBe("");
        expect(result.status).toBe("requires_ocr");
        expect(result.warnings).toEqual([
          expect.objectContaining({ messageKey: "errors.conversion.emptyResult" })
        ]);
      }
    });
  });

  it("validates Docling JSONL responses and handles crash, timeout and cancellation", async () => {
    const client = new DoclingClient({
      executablePath: process.execPath,
      sidecarScriptPath: fileURLToPath(
        new URL("./test-fixtures/fake-docling.mjs", import.meta.url)
      ),
      timeoutMs: 50
    });
    const progress: import("./types.js").ConversionProgress[] = [];
    await expect(
      client.convert("success.pdf", "standard", undefined, (event) => progress.push(event))
    ).resolves.toMatchObject({ engine: "docling" });
    expect(progress).toEqual([
      expect.objectContaining({ stage: "loading_engine", progress: 0.05 }),
      expect.objectContaining({ stage: "processing_pages", completedPages: 2, totalPages: 4 }),
      expect.objectContaining({ stage: "serializing", completedPages: 4, totalPages: 4 })
    ]);
    await expect(client.convert("crash.pdf")).rejects.toThrow("exited with code 2");
    await expect(client.convert("timeout.pdf")).rejects.toThrow();

    const controller = new AbortController();
    const canceled = client.convert("timeout.pdf", "standard", controller.signal);
    controller.abort();
    await expect(canceled).rejects.toMatchObject({ name: "AbortError" });

    const limitedClient = new DoclingClient({
      executablePath: process.execPath,
      sidecarScriptPath: fileURLToPath(
        new URL("./test-fixtures/fake-docling.mjs", import.meta.url)
      ),
      maxOutputBytes: 128
    });
    await expect(limitedClient.convert("output-limit.pdf")).rejects.toThrow("output-limit");
  });

  it("rejects inconsistent Docling page progress", () => {
    expect(() =>
      doclingProgressSchema.parse({
        protocolVersion: 3,
        requestId: "00000000-0000-4000-8000-000000000001",
        type: "progress",
        stage: "processing_pages",
        progress: 0.5,
        completedPages: 5,
        totalPages: 4
      })
    ).toThrow();
  });
});
