import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  ConversionRouter,
  DoclingClient,
  normalizeMarkdown,
  sanitizeConversionResult,
  sha256,
  type MarkdownConversionResult
} from "./index.js";

const fakeDocling = fileURLToPath(new URL("./test-fixtures/fake-docling.mjs", import.meta.url));
const hasControl = (value: unknown) => JSON.stringify(value).includes("\\u0000");

describe("conversion output sanitization", () => {
  it("strips NUL from a Docling response and keeps block offsets aligned with the Markdown", async () => {
    const client = new DoclingClient({
      executablePath: process.execPath,
      sidecarScriptPath: fakeDocling
    });
    const result = await client.convert("nul.pdf");

    expect(hasControl(result)).toBe(false);
    expect(result.markdown).toBe("# Title\n\nQ = e  a\n\nNext block\n");
    expect(result.contentHash).toBe(createHash("sha256").update(result.markdown).digest("hex"));
    expect(result.metadata).toEqual({ title: "Fake title" });
    expect(result.blocks.map((block) => block.text)).toEqual(["Title", "Q = e  a", "Next block"]);
    for (const block of result.blocks) {
      expect(result.markdown.slice(block.markdownStart, block.markdownEnd)).toBe(block.text);
    }
    expect(result.rawStructuredResult).toEqual({
      texts: [
        { text: "Title", orig: "Title" },
        { text: "Q = e  a", orig: "Q = e  a" },
        { text: "Next block", orig: "Next block" }
      ]
    });
  });

  it("leaves a clean result untouched, hash included", async () => {
    const client = new DoclingClient({
      executablePath: process.execPath,
      sidecarScriptPath: fakeDocling
    });
    const result = await client.convert("success.pdf");
    expect(result.contentHash).toBe("a".repeat(64));
    expect(sanitizeConversionResult(result)).toBe(result);
  });

  it("shifts offsets by the characters removed before them", () => {
    const dirty = "a\0b\0c d\0e";
    const base: MarkdownConversionResult = {
      status: "converted",
      markdown: dirty,
      contentHash: sha256(dirty),
      blocks: [
        { id: "x", type: "text", text: "c d", markdownStart: 4, markdownEnd: 7 },
        { id: "y", type: "text", text: "e", markdownStart: 8, markdownEnd: 9 }
      ],
      assets: [],
      engine: "docling",
      engineVersion: "test",
      profile: "standard",
      options: {},
      warnings: [],
      quality: {},
      metadata: {}
    };
    const clean = sanitizeConversionResult(base);
    expect(clean.markdown).toBe("abc de");
    expect(clean.contentHash).toBe(sha256("abc de"));
    expect(
      clean.blocks.map((block) => clean.markdown.slice(block.markdownStart, block.markdownEnd))
    ).toEqual(["c d", "e"]);
    expect(base.markdown).toBe(dirty);
  });

  it("strips NUL from native converter output and keeps the hash of clean text", async () => {
    const encoder = new TextEncoder();
    const router = new ConversionRouter();
    const dirty = await router.convert({
      data: encoder.encode("# T\0itle\n\nbo\0dy\n"),
      fileName: "n.md"
    });
    expect(dirty.markdown).toBe("# Title\n\nbody\n");
    expect(dirty.contentHash).toBe(sha256("# Title\n\nbody\n"));
    expect(hasControl(dirty)).toBe(false);

    const clean = await router.convert({
      data: encoder.encode("# Title\r\n\r\nbody  \r\n"),
      fileName: "n.md"
    });
    expect(clean.markdown).toBe("# Title\n\nbody\n");
    expect(clean.contentHash).toBe(sha256("# Title\n\nbody\n"));
    expect(normalizeMarkdown("tab\there\u0007")).toBe("tab\there\n");
  });
});
