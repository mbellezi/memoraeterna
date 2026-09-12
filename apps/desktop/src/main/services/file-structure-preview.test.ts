import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resolveProcessingPlan, SourceDescriptorSchema } from "@app/domain";
import { IngestionService } from "./ingestion-service.js";
import { fileStructurePreviewInputSchema, fileStructurePreviewSchema } from "../../shared/ipc.js";

let directory: string;
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), "memora-preview-")); });
afterEach(async () => { vi.restoreAllMocks(); await rm(directory, { recursive: true, force: true }); });

async function prepare(paper = false) {
  const getPool = vi.fn(() => { throw new Error("Preview must not access the database"); });
  const service = new IngestionService({ getPool,
    getStorageSettings: async () => ({ obsidianVaultPath: null, managedRoot: "Memora", obsidianSyncEnabled: false,
      obsidianSyncPaused: false, deletionPolicy: "delete", uploadCopiesEnabled: false, uploadCopiesFolderPath: null, updatedAt: new Date(0).toISOString() }),
    userDataPath: directory, resourcesPath: directory, workspaceRoot: directory, isPackaged: false,
    fetchExternalPage: async () => { throw new Error("Preview must not use the network"); }
  });
  const path = join(directory, "book.md");
  await writeFile(path, paper ? "# Paper title\n\nAna Author\n\n## Introduction\n\nFirst chapter.\n\n## Methods\n\nSecond chapter.\n" : "# Chapter One\n\nFirst chapter.\n\n# Chapter Two\n\nSecond chapter.\n");
  const file = await service.prepareFileMetadata(path, "GenericDocument");
  return { service, file, getPool };
}

describe("prepared file structure preview", () => {
  it.each(["Book", "AcademicPaper", "PeriodicalIssue"] as const)("previews %s using the full conversion without creating sources", async (sourceType) => {
    const { service, file, getPool } = await prepare(sourceType === "AcademicPaper");
    const input = { fileToken: file.fileToken, sourceType };
    const result = await service.previewPreparedFileStructure(input);
    expect(fileStructurePreviewSchema.safeParse(result).success).toBe(true);
    expect(result.divisions).toHaveLength(2);
    expect(result.rootMarkdown).toContain("Second chapter.");
    expect(result.boundaries.at(-1)?.offset).toBe(result.rootMarkdown.length);
    expect((await service.previewPreparedFileStructure(input)).divisions).toBe(result.divisions);
    expect(JSON.stringify(result)).not.toContain(directory);
    expect(getPool).not.toHaveBeenCalled();
  });

  it("reuses the preview division IDs for final import", async () => {
    const { service, file } = await prepare();
    const result = await service.previewPreparedFileStructure({ fileToken: file.fileToken, sourceType: "Book" });
    // Isolate persistence; exercise real preparation, conversion, detection and import routing.
    const persist = vi.spyOn(service as unknown as { persist: (input: unknown) => Promise<unknown> }, "persist").mockResolvedValue({ sourceItemId: "saved" });
    await service.importPreparedFile(file.fileToken, { descriptor: SourceDescriptorSchema.parse({ type: "Book", title: "Book" }), duplicatePolicy: "version", processingPlan: resolveProcessingPlan({ preset: "import_only", requestedStages: [], scope: "source_only", targetSourceItemIds: [], forceRegeneration: false, previousArtifactPolicy: "reuse_valid" }) });
    expect(persist.mock.calls[0]?.[0]).toMatchObject({ structureDetection: { divisions: result.divisions } });
    await expect(service.previewPreparedFileStructure({ fileToken: file.fileToken, sourceType: "Book" })).rejects.toThrow("fileSelectionExpired");
  });

  it("rejects expired tokens and nonhierarchical types", async () => {
    const { service, file } = await prepare();
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 31 * 60_000);
    await expect(service.previewPreparedFileStructure({ fileToken: file.fileToken, sourceType: "Book" })).rejects.toThrow("fileSelectionExpired");
    expect(fileStructurePreviewInputSchema.safeParse({ fileToken: file.fileToken, sourceType: "GenericDocument" }).success).toBe(false);
  });
});
