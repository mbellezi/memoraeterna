import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { DroppedFilesSchema } from "../../shared/ipc-drop.js";
import {
  acceptedDropExtensions,
  importMaxBytes,
  prepareDroppedFiles,
  validateDroppedPath,
  type DropLstat,
  type PreparedFile
} from "./import-drop.js";

const stat =
  (over: { file?: boolean; link?: boolean; size?: number }): DropLstat =>
  async () => ({
    isFile: () => over.file ?? true,
    isSymbolicLink: () => over.link ?? false,
    size: over.size ?? 100
  });

describe("validateDroppedPath (the table)", () => {
  const cases: Array<[string, string, Parameters<typeof stat>[0], string | "ok"]> = [
    ["a PDF", "/Users/a/aula-05.pdf", {}, "ok"],
    ["an upper-case extension", "/Users/a/Notas.MD", {}, "ok"],
    ["a folder", "/Users/a/Pasta", { file: false }, "notAFile"],
    ["a symlink to a file", "/Users/a/link.pdf", { link: true }, "symlink"],
    ["an empty file", "/Users/a/vazio.txt", { size: 0 }, "empty"],
    ["a file over the cap", "/Users/a/grande.pdf", { size: 600 }, "tooLarge"],
    ["a zip archive", "/Users/a/pacote.zip", {}, "unsupported"],
    ["a file with no extension", "/Users/a/LEIAME", {}, "unsupported"],
    ["a relative path", "aula.pdf", {}, "notAFile"],
    ["a traversal path", "/Users/a/../b/aula.pdf", {}, "notAFile"],
    ["a null byte", "/Users/a/au\0la.pdf", {}, "notAFile"]
  ];
  it.each(cases)("%s", async (_label, path, stats, expected) => {
    const result = await validateDroppedPath(path, { lstat: stat(stats), maxBytes: 500 });
    if (expected === "ok") expect(result.ok).toBe(true);
    else expect(result).toMatchObject({ ok: false, reason: expected });
  });

  it("says the file's kind and size, never its path", async () => {
    const result = await validateDroppedPath("/Users/a/livro.epub", {
      lstat: stat({ size: 42 }),
      maxBytes: 500
    });
    expect(result).toEqual({ ok: true, name: "livro.epub", size: 42, kind: "epub" });
  });

  it("refuses a path the file system cannot read", async () => {
    const result = await validateDroppedPath("/Users/a/sumiu.pdf", {
      lstat: async () => {
        throw new Error("ENOENT");
      }
    });
    expect(result).toMatchObject({ ok: false, reason: "unreadable" });
  });

  it("does not accept an archive among its extensions", () => {
    expect(acceptedDropExtensions).not.toContain(".zip");
    expect(acceptedDropExtensions).toContain(".pdf");
  });

  it("reads the cap from the environment like the dialog path does", () => {
    expect(importMaxBytes({ MEMORA_MAX_IMPORT_BYTES: "1000" })).toBe(1000);
    expect(importMaxBytes({ MEMORA_MAX_IMPORT_BYTES: "-1" })).toBe(512 * 1024 * 1024);
    expect(importMaxBytes({})).toBe(512 * 1024 * 1024);
  });
});

describe("validateDroppedPath on a real folder", () => {
  let root = "";
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "memora-drop-"));
    await writeFile(join(root, "nota.md"), "# Uma nota\n");
    await mkdir(join(root, "pasta"));
    await symlink(join(root, "nota.md"), join(root, "atalho.md"));
  });
  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("takes a regular file, refuses a folder, a symlink and a missing path", async () => {
    expect(await validateDroppedPath(join(root, "nota.md"))).toMatchObject({
      ok: true,
      kind: "markdown"
    });
    expect(await validateDroppedPath(join(root, "pasta"))).toMatchObject({ reason: "notAFile" });
    expect(await validateDroppedPath(join(root, "atalho.md"))).toMatchObject({
      reason: "symlink"
    });
    expect(await validateDroppedPath(join(root, "nada.md"))).toMatchObject({
      reason: "unreadable"
    });
  });
});

describe("prepareDroppedFiles", () => {
  const prepared = (name: string): PreparedFile => ({
    fileToken: "8f2f9a3e-6a64-4c24-9b4a-0c2f5b6f3b11",
    fileName: name,
    mimeType: "application/pdf",
    draft: {
      sourceType: "GenericDocument",
      values: { title: "Aula 05" },
      provenance: {},
      warnings: []
    }
  });

  it("answers one result per path, in order, and keeps going after a refusal", async () => {
    const prepare = vi.fn(async (path: string) => {
      if (path.endsWith("quebrado.pdf")) throw new Error("errors.ingestion.noText");
      return prepared("aula-05.pdf");
    });
    const results = await prepareDroppedFiles(
      ["/Users/a/aula-05.pdf", "/Users/a/quebrado.pdf", "/Users/a/pacote.zip", "/Users/a/b.md"],
      { prepare, lstat: stat({}) }
    );
    expect(results.map((result) => result.status)).toEqual([
      "ready",
      "refused",
      "refused",
      "ready"
    ]);
    expect(results[1]).toMatchObject({ name: "quebrado.pdf", reason: "unreadable" });
    expect(results[2]).toMatchObject({ name: "pacote.zip", reason: "unsupported" });
    // A refused file never reaches the converter.
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(DroppedFilesSchema.parse(results)).toHaveLength(4);
  });

  it("calls the converter one file at a time", async () => {
    let running = 0;
    let peak = 0;
    const prepare = async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, 1));
      running -= 1;
      return prepared("a.pdf");
    };
    await prepareDroppedFiles(["/a/1.pdf", "/a/2.pdf", "/a/3.pdf"], { prepare, lstat: stat({}) });
    expect(peak).toBe(1);
  });

  it("names a too-large conversion as too large", async () => {
    const results = await prepareDroppedFiles(["/Users/a/aula.pdf"], {
      prepare: async () => {
        throw new Error("errors.common.fileTooLarge");
      },
      lstat: stat({})
    });
    expect(results[0]).toMatchObject({ status: "refused", reason: "tooLarge" });
  });

  it("returns the token, the name, the size and the kind, and no path", async () => {
    const [result] = await prepareDroppedFiles(["/Users/secreto/aula-05.pdf"], {
      prepare: async () => prepared("aula-05.pdf"),
      lstat: stat({ size: 2048 })
    });
    expect(result).toMatchObject({
      status: "ready",
      name: "aula-05.pdf",
      size: 2048,
      kind: "pdf"
    });
    expect(JSON.stringify(result)).not.toContain("secreto");
  });
});
