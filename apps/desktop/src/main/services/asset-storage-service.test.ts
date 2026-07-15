import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { AssetStorageService, resolveInside } from "./asset-storage-service.js";

const paths: string[] = [];
afterEach(async () => Promise.all(paths.splice(0).map((path) => rm(path, { recursive: true, force: true }))));

describe("AssetStorageService", () => {
  it("stores by hash and deduplicates identical bytes", async () => {
    const basePath = await mkdtemp(join(tmpdir(), "memora-assets-"));
    paths.push(basePath);
    const service = new AssetStorageService();
    const first = await service.store({ data: new TextEncoder().encode("same"), originalFileName: "note.txt", basePath, storageBase: "uploaded_files" });
    const second = await service.store({ data: new TextEncoder().encode("same"), originalFileName: "note.txt", basePath, storageBase: "uploaded_files" });
    expect(first.relativePath).toBe(second.relativePath);
    expect(second.deduplicated).toBe(true);
    expect(await service.exists(basePath, first.relativePath)).toBe(true);
  });

  it("rejects traversal", () => {
    expect(() => resolveInside("/tmp/base", "../outside")).toThrow("errors.common.permissionDenied");
  });

  it("copies and hashes an original from a stream without loading it through the caller", async () => {
    const basePath = await mkdtemp(join(tmpdir(), "memora-assets-stream-"));
    paths.push(basePath);
    const sourcePath = join(basePath, "large-original.pdf");
    await writeFile(sourcePath, Buffer.alloc(2 * 1024 * 1024, 7));
    const stored = await new AssetStorageService().store({
      sourcePath, originalFileName: "large-original.pdf", basePath: join(basePath, "managed"), storageBase: "app_internal"
    });
    expect(stored.sizeBytes).toBe(2 * 1024 * 1024);
    expect(stored.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(await new AssetStorageService().exists(join(basePath, "managed"), stored.relativePath)).toBe(true);
  });
});
