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

it('preserves local bytes on stale CAS and retains independent recovery copies after replacement',async()=>{
  const {writeFile,open}=await import('node:fs/promises');const {createHash,randomUUID}=await import('node:crypto');
  const vaultPath=await mkdtemp(join(tmpdir(),'memora-wiki-cas-'));directories.push(vaultPath);
  const relativePath='Memora/page.md',target=join(vaultPath,relativePath),recoveryId=randomUUID();
  await runObsidianSync({action:'write',vaultPath,relativePath,content:'base',expectedHash:null,managedRoot:'Memora',recoveryId:randomUUID()});
  await writeFile(target,'local edit');await expect(runObsidianSync({action:'write',vaultPath,relativePath,content:'new',expectedHash:createHash('sha256').update('base').digest('hex'),managedRoot:'Memora',recoveryId})).rejects.toThrow('conflict');expect(await readFile(target,'utf8')).toBe('local edit');
  const oldHandle=await open(target,'r+');await runObsidianSync({action:'write',vaultPath,relativePath,content:'new',expectedHash:createHash('sha256').update('local edit').digest('hex'),managedRoot:'Memora',recoveryId});await oldHandle.write('late buffer');await oldHandle.close();
  expect(await readFile(target,'utf8')).toBe('new');expect(await readFile(join(vaultPath,'Memora','.memora-recovery',`${recoveryId}.before.md`),'utf8')).toBe('local edit');expect(await readFile(join(vaultPath,'Memora','.memora-recovery',`${recoveryId}.after.md`),'utf8')).toBe('new');expect(await readFile(join(vaultPath,'Memora','.memora-recovery',`${recoveryId}.before.md.captured`),'utf8')).toContain('late buffer');
});
