import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { archiveObsidianFile, runObsidianSync } from "./obsidian-sync.worker.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
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
    expect(await readFile(join(vaultPath, "Memora/Atomic/2026/05/10/idea.md"), "utf8")).toContain(
      "Idea"
    );
  });

  it("rejects path traversal", async () => {
    const vaultPath = await mkdtemp(join(tmpdir(), "memora-vault-"));
    directories.push(vaultPath);
    await expect(
      runObsidianSync({ action: "write", vaultPath, relativePath: "../outside.md", content: "x" })
    ).rejects.toThrow("unsafe_obsidian_path");
  });
});

it("preserves local bytes on stale CAS and retains independent recovery copies after replacement", async () => {
  const { writeFile, open } = await import("node:fs/promises");
  const { createHash, randomUUID } = await import("node:crypto");
  const vaultPath = await mkdtemp(join(tmpdir(), "memora-wiki-cas-"));
  directories.push(vaultPath);
  const relativePath = "Memora/page.md",
    target = join(vaultPath, relativePath),
    recoveryId = randomUUID();
  await runObsidianSync({
    action: "write",
    vaultPath,
    relativePath,
    content: "base",
    expectedHash: null,
    managedRoot: "Memora",
    recoveryId: randomUUID()
  });
  await writeFile(target, "local edit");
  await expect(
    runObsidianSync({
      action: "write",
      vaultPath,
      relativePath,
      content: "new",
      expectedHash: createHash("sha256").update("base").digest("hex"),
      managedRoot: "Memora",
      recoveryId
    })
  ).rejects.toThrow("conflict");
  expect(await readFile(target, "utf8")).toBe("local edit");
  const oldHandle = await open(target, "r+");
  await runObsidianSync({
    action: "write",
    vaultPath,
    relativePath,
    content: "new",
    expectedHash: createHash("sha256").update("local edit").digest("hex"),
    managedRoot: "Memora",
    recoveryId
  });
  await oldHandle.write("late buffer");
  await oldHandle.close();
  expect(await readFile(target, "utf8")).toBe("new");
  expect(
    await readFile(join(vaultPath, "Memora", ".memora-recovery", `${recoveryId}.before.md`), "utf8")
  ).toBe("local edit");
  expect(
    await readFile(join(vaultPath, "Memora", ".memora-recovery", `${recoveryId}.after.md`), "utf8")
  ).toBe("new");
  expect(
    await readFile(
      join(vaultPath, "Memora", ".memora-recovery", `${recoveryId}.before.md.captured`),
      "utf8"
    )
  ).toContain("late buffer");
});

describe("archiving a retired file into recovery", () => {
  const stamp = "2026-10-15T12-00-00-000Z";
  const sha = (text: string) => createHash("sha256").update(text).digest("hex");
  const recovery = (vaultPath: string, rest: string, managed = "Memora") =>
    join(vaultPath, managed, ".memora-recovery", "retired-wiki", stamp, rest);
  async function vault(files: Record<string, string | Buffer> = {}) {
    const vaultPath = await mkdtemp(join(tmpdir(), "memora-archive-"));
    directories.push(vaultPath);
    for (const [path, content] of Object.entries(files)) {
      await mkdir(dirname(join(vaultPath, path)), { recursive: true });
      await writeFile(join(vaultPath, path), content);
    }
    return vaultPath;
  }
  const input = (vaultPath: string, relativePath: string, extra: Record<string, unknown> = {}) => ({
    vaultPath,
    relativePath,
    managedRoot: "Memora",
    stamp,
    ...extra
  });

  it("copies an unchanged file to recovery under its own path and moves the original out", async () => {
    const page = "---\nmemora_id: a\n---\n# Page\n";
    const vaultPath = await vault({ "Memora/Wiki/Topics/Page.md": page });
    const result = await archiveObsidianFile(
      input(vaultPath, "Memora/Wiki/Topics/Page.md", { expectedHash: sha(page) })
    );
    expect(result).toEqual({
      outcome: "archived",
      archivedPath: `Memora/.memora-recovery/retired-wiki/${stamp}/Wiki/Topics/Page.md`
    });
    const copy = recovery(vaultPath, "Wiki/Topics/Page.md");
    expect(await readFile(copy, "utf8")).toBe(page);
    expect(((await stat(copy)).mode & 0o777).toString(8)).toBe("600");
    await expect(stat(join(vaultPath, "Memora/Wiki/Topics/Page.md"))).rejects.toThrow("ENOENT");
    await expect(stat(`${copy}.captured`)).rejects.toThrow("ENOENT");
  });

  it("keeps the exact bytes of a file that is not valid UTF-8", async () => {
    const bytes = Buffer.from([0x23, 0x20, 0xff, 0xfe, 0x0a, 0xc3, 0x28]);
    const vaultPath = await vault({ "Memora/Wiki/Odd.md": bytes });
    await archiveObsidianFile(input(vaultPath, "Memora/Wiki/Odd.md"));
    expect((await readFile(recovery(vaultPath, "Wiki/Odd.md"))).equals(bytes)).toBe(true);
  });

  it("works under a nested managed root", async () => {
    const vaultPath = await vault({ "Apps/Memora/Wiki/Page.md": "body" });
    const result = await archiveObsidianFile({
      ...input(vaultPath, "Apps/Memora/Wiki/Page.md"),
      managedRoot: "Apps/Memora"
    });
    expect(result).toMatchObject({
      archivedPath: `Apps/Memora/.memora-recovery/retired-wiki/${stamp}/Wiki/Page.md`
    });
    expect(await readFile(recovery(vaultPath, "Wiki/Page.md", "Apps/Memora"), "utf8")).toBe("body");
  });

  it("refuses a file whose bytes differ from the registered hash and leaves it untouched", async () => {
    const vaultPath = await vault({ "Memora/Wiki/Page.md": "edited by hand" });
    await expect(
      archiveObsidianFile(
        input(vaultPath, "Memora/Wiki/Page.md", { expectedHash: sha("what was projected") })
      )
    ).rejects.toThrow("obsidianWiki.errors.conflict");
    expect(await readFile(join(vaultPath, "Memora/Wiki/Page.md"), "utf8")).toBe("edited by hand");
    await expect(stat(join(vaultPath, "Memora/.memora-recovery"))).rejects.toThrow("ENOENT");
  });

  it("puts a late edit back instead of removing it", async () => {
    const vaultPath = await vault({ "Memora/Wiki/Page.md": "projected" });
    await expect(
      archiveObsidianFile(
        input(vaultPath, "Memora/Wiki/Page.md", { expectedHash: sha("projected") }),
        {
          afterCopy: () => writeFile(join(vaultPath, "Memora/Wiki/Page.md"), "typed a moment ago")
        }
      )
    ).rejects.toThrow("obsidianWiki.errors.conflict");
    expect(await readFile(join(vaultPath, "Memora/Wiki/Page.md"), "utf8")).toBe(
      "typed a moment ago"
    );
    // The copy of the earlier bytes and the captured newer bytes both stay in recovery.
    expect(await readFile(recovery(vaultPath, "Wiki/Page.md"), "utf8")).toBe("projected");
    expect(await readFile(recovery(vaultPath, "Wiki/Page.md.captured"), "utf8")).toBe(
      "typed a moment ago"
    );
  });

  it("detects a late edit when moving a kept file on request, with no registered hash", async () => {
    const vaultPath = await vault({ "Memora/Wiki/Page.md": "projected" });
    await expect(
      archiveObsidianFile(input(vaultPath, "Memora/Wiki/Page.md"), {
        afterCopy: async () => {
          await writeFile(join(vaultPath, "Memora/Wiki/Page.md"), "changed");
        }
      })
    ).rejects.toThrow("obsidianWiki.errors.conflict");
    expect(await readFile(join(vaultPath, "Memora/Wiki/Page.md"), "utf8")).toBe("changed");
  });

  it("reports an absent file without creating anything", async () => {
    const vaultPath = await vault({ "Memora/Other.md": "x" });
    await expect(archiveObsidianFile(input(vaultPath, "Memora/Wiki/Gone.md"))).resolves.toEqual({
      outcome: "absent"
    });
    await expect(stat(join(vaultPath, "Memora/.memora-recovery"))).rejects.toThrow("ENOENT");
  });

  it("never overwrites an existing recovery file", async () => {
    const vaultPath = await vault({
      "Memora/Wiki/Page.md": "projected",
      [`Memora/.memora-recovery/retired-wiki/${stamp}/Wiki/Page.md`]: "older copy"
    });
    await expect(archiveObsidianFile(input(vaultPath, "Memora/Wiki/Page.md"))).rejects.toThrow(
      "EEXIST"
    );
    expect(await readFile(join(vaultPath, "Memora/Wiki/Page.md"), "utf8")).toBe("projected");
    expect(await readFile(recovery(vaultPath, "Wiki/Page.md"), "utf8")).toBe("older copy");
  });

  it("rejects a symlinked file and a symlinked directory without touching their targets", async () => {
    const vaultPath = await vault({
      "Memora/Wiki/Real.md": "real",
      "outside/secret.md": "secret"
    });
    await symlink(join(vaultPath, "Memora/Wiki/Real.md"), join(vaultPath, "Memora/Wiki/Link.md"));
    await expect(archiveObsidianFile(input(vaultPath, "Memora/Wiki/Link.md"))).rejects.toThrow(
      "unsafe_obsidian_symlink"
    );
    await symlink(join(vaultPath, "outside"), join(vaultPath, "Memora/Linked"));
    await expect(archiveObsidianFile(input(vaultPath, "Memora/Linked/secret.md"))).rejects.toThrow(
      "unsafe_obsidian_symlink"
    );
    expect(await readFile(join(vaultPath, "Memora/Wiki/Real.md"), "utf8")).toBe("real");
    expect(await readFile(join(vaultPath, "outside/secret.md"), "utf8")).toBe("secret");
    await expect(stat(join(vaultPath, "Memora/.memora-recovery"))).rejects.toThrow("ENOENT");
  });

  it("refuses a recovery directory that is a symlink out of the vault", async () => {
    const vaultPath = await vault({ "Memora/Wiki/Page.md": "projected", "outside/keep": "x" });
    await symlink(join(vaultPath, "outside"), join(vaultPath, "Memora/.memora-recovery"));
    await expect(archiveObsidianFile(input(vaultPath, "Memora/Wiki/Page.md"))).rejects.toThrow(
      "unsafe_obsidian_symlink"
    );
    expect(await readFile(join(vaultPath, "Memora/Wiki/Page.md"), "utf8")).toBe("projected");
  });

  it("only touches files below the managed root", async () => {
    const vaultPath = await vault({ "Notes/Mine.md": "mine", "Memora/Wiki/Page.md": "p" });
    for (const relativePath of ["Notes/Mine.md", "Memora", "Memora/", "../Notes/Mine.md"])
      await expect(archiveObsidianFile(input(vaultPath, relativePath))).rejects.toThrow(
        /unsafe_obsidian_path/
      );
    expect(await readFile(join(vaultPath, "Notes/Mine.md"), "utf8")).toBe("mine");
  });

  it("is reachable through the worker entry point and validates its payload", async () => {
    const vaultPath = await vault({ "Memora/Wiki/Page.md": "projected" });
    await expect(
      runObsidianSync({ action: "archive", ...input(vaultPath, "Memora/Wiki/Page.md") })
    ).resolves.toMatchObject({ outcome: "archived" });
    await expect(
      runObsidianSync({
        action: "archive",
        ...input(vaultPath, "Memora/Wiki/Page.md"),
        stamp: "../escape"
      })
    ).rejects.toThrow();
    await expect(
      runObsidianSync({ action: "archive", ...input(vaultPath, "Memora/Wiki/Page.md"), extra: 1 })
    ).rejects.toThrow();
  });
});
