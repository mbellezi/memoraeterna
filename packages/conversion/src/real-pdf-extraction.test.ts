import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, describe, expect, it } from "vitest";

import { DoclingClient } from "./docling-client.js";
import { sha256 } from "./markdown-normalizer.js";
import { extractFileMetadata } from "./metadata-extraction.js";
import { detectPdfStructure, readPdfPageCount } from "./structure-detection.js";
import type { MarkdownConversionResult } from "./types.js";

/**
 * Runs the real extraction code over the public PLOS ONE golden source (Murre and Dros, 2015),
 * downloaded by `scripts/golden/fetch.ts` into the git-ignored `.cache/golden/sources`. Its math
 * font minus signs come out of Docling as U+0000, which used to abort the import in PostgreSQL.
 * Both blocks skip when the PDF (or, for Docling, the bundled runtime) is not on this machine.
 * The Docling block takes about a minute, so it also needs MEMORA_REAL_DOCLING=1.
 */
const repositoryRoot = fileURLToPath(new URL("../../../", import.meta.url));
const plosPdf = join(repositoryRoot, ".cache/golden/sources/plos-one-murre-dros-2015.pdf");
const doclingRoot = join(
  repositoryRoot,
  "vendor/sidecars/docling",
  `${process.platform}-${process.arch}`
);
const doclingPython = join(doclingRoot, "bin/python3.13");
const doclingScript = join(repositoryRoot, "packages/conversion/sidecar/docling_sidecar.py");
const hasNul = (value: unknown) => JSON.stringify(value).includes("\\u0000");

describe.skipIf(!existsSync(plosPdf))("PLOS ONE reference PDF without Docling", () => {
  it("reads metadata, page count and structure without U+0000", async () => {
    const draft = await extractFileMetadata({
      sourceType: "AcademicPaper",
      sourcePath: plosPdf,
      fileName: "plos-one-murre-dros-2015.pdf",
      mimeType: "application/pdf"
    });
    expect(draft.values.title).toBe("Replication and Analysis of Ebbinghaus’ Forgetting Curve");
    expect(hasNul(draft)).toBe(false);

    await expect(readPdfPageCount(plosPdf)).resolves.toBe(23);
    const structure = await detectPdfStructure(
      emptyConversion("## Abstract\n\nText.\n"),
      "paper",
      undefined,
      plosPdf
    );
    expect(hasNul(structure)).toBe(false);
  });
});

const doclingAvailable =
  process.env.MEMORA_REAL_DOCLING === "1" &&
  existsSync(plosPdf) &&
  existsSync(doclingPython) &&
  existsSync(doclingScript);

describe.skipIf(!doclingAvailable)("PLOS ONE reference PDF through the bundled Docling", () => {
  let workDir: string | undefined;
  afterAll(async () => {
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("converts to storable text and a storable detected structure", async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-plos-docling-"));
    await mkdir(join(workDir, "home"));
    await mkdir(join(workDir, "tmp"));
    const conversion = await new DoclingClient({
      executablePath: doclingPython,
      sidecarScriptPath: doclingScript,
      timeoutMs: 5 * 60_000,
      conversionOptions: { maxPages: 500 },
      env: {
        PATH: join(doclingRoot, "bin"),
        HOME: join(workDir, "home"),
        TMPDIR: join(workDir, "tmp"),
        LANG: "en_US.UTF-8",
        DOCLING_ARTIFACTS_PATH: join(doclingRoot, "artifacts"),
        HF_HUB_OFFLINE: "1",
        TRANSFORMERS_OFFLINE: "1",
        HTTP_PROXY: "http://127.0.0.1:9",
        HTTPS_PROXY: "http://127.0.0.1:9",
        ALL_PROXY: "http://127.0.0.1:9",
        NO_PROXY: ""
      }
    }).convert(plosPdf);

    expect(conversion.markdown).toContain("Ebbinghaus");
    expect(conversion.contentHash).toBe(sha256(conversion.markdown));
    expect(hasNul(conversion)).toBe(false);

    const draft = await extractFileMetadata({
      sourceType: "AcademicPaper",
      sourcePath: plosPdf,
      fileName: "plos-one-murre-dros-2015.pdf",
      mimeType: "application/pdf",
      conversion
    });
    expect(hasNul(draft)).toBe(false);
    const structure = await detectPdfStructure(conversion, "paper", undefined, plosPdf);
    expect(structure.divisions.length).toBeGreaterThan(0);
    expect(hasNul(structure)).toBe(false);
  }, 600_000);
});

function emptyConversion(markdown: string): MarkdownConversionResult {
  return {
    status: "converted",
    markdown,
    contentHash: sha256(markdown),
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
