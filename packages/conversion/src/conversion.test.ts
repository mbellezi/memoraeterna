import { describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";

import {
  chunkMarkdown,
  ConversionRouter,
  convertCsv,
  convertNotebook,
  convertWebHtml,
  DoclingClient
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
    const result = convertCsv({ data: encoder.encode('name,note\nAda,"one, two"'), fileName: "data.csv" });
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
      data: encoder.encode("<html><head><title>Article</title></head><body><article><h1>Article</h1><p>Main evidence with enough useful content for extraction.</p></article></body></html>"),
      fileName: "article.html",
      mimeType: "text/html",
      sourceUrl: "https://example.test/article"
    });
    expect(result.engine).toBe("defuddle");
    expect(result.markdown).toContain("Main evidence");
  });

  it("validates Docling JSONL responses and handles crash, timeout and cancellation", async () => {
    const client = new DoclingClient({
      executablePath: process.execPath,
      sidecarScriptPath: fileURLToPath(new URL("./test-fixtures/fake-docling.mjs", import.meta.url)),
      timeoutMs: 50
    });
    await expect(client.convert("success.pdf")).resolves.toMatchObject({ engine: "docling" });
    await expect(client.convert("crash.pdf")).rejects.toThrow("exited with code 2");
    await expect(client.convert("timeout.pdf")).rejects.toThrow();

    const controller = new AbortController();
    const canceled = client.convert("timeout.pdf", "standard", controller.signal);
    controller.abort();
    await expect(canceled).rejects.toMatchObject({ name: "AbortError" });
  });
});
