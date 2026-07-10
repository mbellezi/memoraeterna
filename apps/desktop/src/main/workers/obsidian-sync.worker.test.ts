import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { runObsidianSync } from "./obsidian-sync.worker.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("obsidian sync worker", () => {
  it("creates a managed Markdown file atomically in a temporary vault", async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), "memora-vault-"));
    directories.push(vaultPath);
    const result = await runObsidianSync({
      action: "write",
      vaultPath,
      relativePath: "Memora/Atomic/2026/05/10/idea.md",
      content: "---\nmemora_managed: true\n---\nIdea\n"
    });
    expect(result.mtimeMs).toEqual(expect.any(Number));
    expect(await readFile(join(vaultPath, "Memora/Atomic/2026/05/10/idea.md"), "utf8")).toContain("Idea");
  });

  it("rejects path traversal", async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), "memora-vault-"));
    directories.push(vaultPath);
    await expect(runObsidianSync({ action: "write", vaultPath, relativePath: "../outside.md", content: "x" }))
      .rejects.toThrow("unsafe_obsidian_path");
  });
});
