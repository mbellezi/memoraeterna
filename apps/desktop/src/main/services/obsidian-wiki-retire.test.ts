import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";

import type { ObsidianSyncFileRecord } from "@app/db";
import { afterEach, describe, expect, it, vi } from "vitest";

import { archiveObsidianFile } from "../workers/obsidian-sync.worker.js";
import {
  ObsidianWikiRetirement,
  retiredMetadata,
  type RetireContext,
  type RetiredMetadata,
  type RetirementStore
} from "./obsidian-wiki-retire.js";
import { projectionHash } from "./obsidian-wiki-projection.js";

const BINDING = "binding-of-this-vault";
const NOW = new Date("2026-10-15T12:00:00.000Z");
const STAMP = "2026-10-15T12-00-00-000Z";
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))
  );
});

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sha = (bytes: string | Buffer) => createHash("sha256").update(bytes).digest("hex");

/** An in-memory registry with the semantics the retirement relies on. */
class MemoryStore implements RetirementStore {
  readonly files = new Map<string, ObsidianSyncFileRecord>();
  readonly written = new Map<string, string>();
  readonly pages = new Set<string>();
  readonly events: string[] = [];
  failOn = new Set<string>();

  add(input: {
    n: number;
    type?: "wiki_page" | "wiki_index";
    path: string;
    status?: ObsidianSyncFileRecord["status"];
    metadata?: Record<string, unknown>;
  }) {
    const file = {
      id: `row-${input.n}`,
      memoraId: id(input.n),
      entityType: input.type ?? "wiki_page",
      entityId: id(input.n),
      sourceItemId: null,
      documentId: null,
      memoraType: input.type ?? "wiki_page",
      relativePath: input.path,
      frontmatterHash: "f",
      contentHash: "c",
      mtimeMs: 0,
      syncVersion: 1,
      status: input.status ?? "synced",
      lastSyncedAt: null,
      deletedAt: null,
      metadata: input.metadata ?? {},
      createdAt: NOW,
      updatedAt: NOW
    } as ObsidianSyncFileRecord;
    this.files.set(file.memoraId, file);
    return file;
  }
  async wikiFiles(retired: boolean) {
    return [...this.files.values()]
      .filter((file) => (file.status === "retired") === retired)
      .sort((a, b) => a.relativePath.localeCompare(b.relativePath));
  }
  async find(memoraId: string) {
    return this.files.get(memoraId) ?? null;
  }
  async retire(file: ObsidianSyncFileRecord, metadata: RetiredMetadata) {
    if (this.failOn.has(file.memoraId)) throw new Error("database is unavailable");
    this.files.set(file.memoraId, {
      ...file,
      status: "retired",
      metadata: { ...file.metadata, retired: { ...metadata } }
    });
  }
  async writtenHash(memoraId: string, binding: string) {
    return binding === BINDING ? (this.written.get(memoraId) ?? null) : null;
  }
  async existingPageIds(ids: string[]) {
    return ids.filter((pageId) => this.pages.has(pageId));
  }
  async withTarget<T>(memoraId: string, work: () => Promise<T>) {
    this.events.push(`lock:${memoraId}`);
    try {
      return await work();
    } finally {
      this.events.push(`unlock:${memoraId}`);
    }
  }
}

async function newVault() {
  const vaultPath = await mkdtemp(join(tmpdir(), "memora-retire-"));
  directories.push(vaultPath);
  return vaultPath;
}
async function put(vaultPath: string, path: string, content: string | Buffer) {
  await mkdir(dirname(join(vaultPath, path)), { recursive: true });
  await writeFile(join(vaultPath, path), content);
}
/** Every file under the vault with its content hash: what "wrote nothing" compares. */
async function snapshot(vaultPath: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) out[relative(vaultPath, path)] = sha(await readFile(path));
    }
  };
  await walk(vaultPath);
  return out;
}

function setup(vaultPath: string, store = new MemoryStore()) {
  const archive = vi.fn(archiveObsidianFile);
  const retirement = new ObsidianWikiRetirement({
    store,
    archive,
    hash: projectionHash,
    now: () => NOW
  });
  const context = (overrides: Partial<RetireContext> = {}): RetireContext => ({
    vaultPath,
    managedRoot: "Memora",
    binding: BINDING,
    assertBinding: async () => undefined,
    ...overrides
  });
  return { store, retirement, archive, context };
}

/** A page file as the projection wrote it, registered with the hash of those bytes. */
async function projectedPage(
  vaultPath: string,
  store: MemoryStore,
  n: number,
  extra: { type?: "wiki_page" | "wiki_index"; dir?: string } = {}
) {
  const path = `Memora/${extra.dir ?? "Wiki/Topics"}/Page ${String(n).padStart(2, "0")}.md`;
  const content = `---\nmemora_id: ${id(n)}\nmemora_type: wiki_page\n---\n# Page ${n}\n`;
  await put(vaultPath, path, content);
  store.add({ n, path, ...(extra.type ? { type: extra.type } : {}) });
  store.written.set(id(n), projectionHash(content));
  return { path, content };
}

describe("retiring the vault files of the old wiki", () => {
  it("archives 20 unchanged page files, keeps the 2 edited ones in place and deletes nothing", async () => {
    const vaultPath = await newVault();
    const { store, retirement, context } = setup(vaultPath);
    const pages = new Map<number, { path: string; content: string }>();
    for (let n = 1; n <= 22; n += 1) pages.set(n, await projectedPage(vaultPath, store, n));
    const edited = new Map([
      [5, pages.get(5)!.content + "\nMy own paragraph.\n"],
      [17, pages.get(17)!.content.replace("# Page 17", "# Page 17 (renamed)")]
    ]);
    for (const [n, text] of edited) await put(vaultPath, pages.get(n)!.path, text);

    const summary = await retirement.retire(context(), new Set());

    expect(summary).toEqual({ archived: 20, kept: 2, absent: 0, failed: 0 });
    for (let n = 1; n <= 22; n += 1) {
      const { path, content } = pages.get(n)!;
      const original = join(vaultPath, path);
      const copy = join(
        vaultPath,
        "Memora/.memora-recovery/retired-wiki",
        STAMP,
        path.slice("Memora/".length)
      );
      if (edited.has(n)) {
        expect(await readFile(original, "utf8")).toBe(edited.get(n));
        await expect(stat(copy)).rejects.toThrow("ENOENT");
      } else {
        await expect(stat(original)).rejects.toThrow("ENOENT");
        expect(await readFile(copy, "utf8")).toBe(content);
      }
      const row = store.files.get(id(n))!;
      expect(row.status).toBe("retired");
      expect(row.relativePath).toBe(path);
      expect(retiredMetadata(row)).toMatchObject(
        edited.has(n)
          ? { outcome: "kept", reason: "edited", previousStatus: "synced" }
          : { outcome: "archived", archivedPath: expect.stringContaining(STAMP) }
      );
    }
    // Every byte of the old wiki is still in the vault: 22 files, 2 of them where they were.
    const files = await snapshot(vaultPath);
    expect(Object.keys(files)).toHaveLength(22);
    expect(await retirement.report()).toEqual({
      archived: 20,
      absent: 0,
      keptTotal: 2,
      kept: [
        { id: id(5), relativePath: pages.get(5)!.path, reason: "edited" },
        { id: id(17), relativePath: pages.get(17)!.path, reason: "edited" }
      ]
    });
  });

  it("writes nothing the second time", async () => {
    const vaultPath = await newVault();
    const { store, retirement, archive, context } = setup(vaultPath);
    for (let n = 1; n <= 6; n += 1) await projectedPage(vaultPath, store, n);
    await put(vaultPath, "Memora/Wiki/Topics/Page 02.md", "edited");
    await retirement.retire(context(), new Set());
    const before = await snapshot(vaultPath);
    const retireWrites = vi.spyOn(store, "retire");
    archive.mockClear();

    expect(await retirement.retire(context(), new Set())).toEqual({
      archived: 0,
      kept: 0,
      absent: 0,
      failed: 0
    });

    expect(await snapshot(vaultPath)).toEqual(before);
    expect(archive).not.toHaveBeenCalled();
    expect(retireWrites).not.toHaveBeenCalled();
  });

  it("leaves what the plan still produces alone, and the file of a page that still exists", async () => {
    const vaultPath = await newVault();
    const { store, retirement, context } = setup(vaultPath);
    const index = await projectedPage(vaultPath, store, 1, { type: "wiki_index", dir: "Wiki" });
    const live = await projectedPage(vaultPath, store, 2);
    const gone = await projectedPage(vaultPath, store, 3);
    store.pages.add(id(2));

    const summary = await retirement.retire(context(), new Set([id(1)]));

    expect(summary).toEqual({ archived: 1, kept: 0, absent: 0, failed: 0 });
    expect(await readFile(join(vaultPath, index.path), "utf8")).toBe(index.content);
    expect(await readFile(join(vaultPath, live.path), "utf8")).toBe(live.content);
    await expect(stat(join(vaultPath, gone.path))).rejects.toThrow("ENOENT");
    expect(store.files.get(id(1))!.status).toBe("synced");
    expect(store.files.get(id(2))!.status).toBe("synced");
  });

  it("retires an index the plan stopped producing, which is not a page", async () => {
    const vaultPath = await newVault();
    const { store, retirement, context } = setup(vaultPath);
    await projectedPage(vaultPath, store, 1, { type: "wiki_index", dir: "Wiki/Old index" });
    expect(await retirement.retire(context(), new Set())).toMatchObject({ archived: 1 });
    expect(store.files.get(id(1))!.status).toBe("retired");
  });

  it("marks a row retired when its file is already gone, without writing a file", async () => {
    const vaultPath = await newVault();
    const { store, retirement, archive, context } = setup(vaultPath);
    store.add({ n: 1, path: "Memora/Wiki/Topics/Missing.md" });
    store.written.set(id(1), "h");
    expect(await retirement.retire(context(), new Set())).toMatchObject({ absent: 1, archived: 0 });
    expect(archive).not.toHaveBeenCalled();
    expect(retiredMetadata(store.files.get(id(1))!)).toMatchObject({ outcome: "absent" });
    expect(Object.keys(await snapshot(vaultPath))).toEqual([]);
  });

  it("keeps a file it cannot prove unedited, even when its bytes are what a projection would write", async () => {
    const vaultPath = await newVault();
    const { store, retirement, archive, context } = setup(vaultPath);
    await put(vaultPath, "Memora/Wiki/Topics/Unknown.md", "no delivery on record");
    store.add({ n: 1, path: "Memora/Wiki/Topics/Unknown.md" });
    expect(await retirement.retire(context(), new Set())).toMatchObject({ kept: 1 });
    expect(archive).not.toHaveBeenCalled();
    expect(retiredMetadata(store.files.get(id(1))!)).toMatchObject({
      outcome: "kept",
      reason: "unverified"
    });
    expect(await readFile(join(vaultPath, "Memora/Wiki/Topics/Unknown.md"), "utf8")).toBe(
      "no delivery on record"
    );
  });

  it("treats a file that differs only by line endings as unedited and archives its exact bytes", async () => {
    const vaultPath = await newVault();
    const { store, retirement, context } = setup(vaultPath);
    const crlf = "---\r\nmemora_id: x\r\n---\r\n# Page\r\n";
    await put(vaultPath, "Memora/Wiki/Topics/Windows.md", crlf);
    store.add({ n: 1, path: "Memora/Wiki/Topics/Windows.md" });
    store.written.set(id(1), projectionHash(crlf.replace(/\r\n/g, "\n")));
    expect(await retirement.retire(context(), new Set())).toMatchObject({ archived: 1 });
    const copy = join(
      vaultPath,
      "Memora/.memora-recovery/retired-wiki",
      STAMP,
      "Wiki/Topics/Windows.md"
    );
    expect(await readFile(copy, "utf8")).toBe(crlf);
  });

  it("never follows a symlink, and reports a path outside the managed root as unsafe", async () => {
    const vaultPath = await newVault();
    const { store, retirement, archive, context } = setup(vaultPath);
    await put(vaultPath, "outside/target.md", "outside the managed folder");
    await put(vaultPath, "Notes/Mine.md", "my own note");
    await mkdir(join(vaultPath, "Memora/Wiki"), { recursive: true });
    await symlink(join(vaultPath, "outside/target.md"), join(vaultPath, "Memora/Wiki/Link.md"));
    store.add({ n: 1, path: "Memora/Wiki/Link.md" });
    store.written.set(id(1), projectionHash("outside the managed folder"));
    store.add({ n: 2, path: "Notes/Mine.md" });
    store.written.set(id(2), projectionHash("my own note"));

    expect(await retirement.retire(context(), new Set())).toEqual({
      archived: 0,
      kept: 2,
      absent: 0,
      failed: 0
    });

    expect(archive).not.toHaveBeenCalled();
    expect(retiredMetadata(store.files.get(id(1))!)).toMatchObject({ reason: "unsafe" });
    expect(retiredMetadata(store.files.get(id(2))!)).toMatchObject({ reason: "unsafe" });
    expect(await readFile(join(vaultPath, "outside/target.md"), "utf8")).toBe(
      "outside the managed folder"
    );
    expect(await readFile(join(vaultPath, "Notes/Mine.md"), "utf8")).toBe("my own note");
  });

  it("keeps a file that grew past the size limit", async () => {
    const vaultPath = await newVault();
    const { store, retirement, context } = setup(vaultPath);
    await put(vaultPath, "Memora/Wiki/Big.md", "x".repeat(2_000_001));
    store.add({ n: 1, path: "Memora/Wiki/Big.md" });
    store.written.set(id(1), "h");
    expect(await retirement.retire(context(), new Set())).toMatchObject({ kept: 1 });
    expect(retiredMetadata(store.files.get(id(1))!)).toMatchObject({ reason: "limit" });
  });

  it("keeps a file edited between the check and the move, and the edit survives", async () => {
    const vaultPath = await newVault();
    const { store, context } = setup(vaultPath);
    const page = await projectedPage(vaultPath, store, 1);
    const retirement = new ObsidianWikiRetirement({
      store,
      hash: projectionHash,
      now: () => NOW,
      archive: (input) =>
        archiveObsidianFile(input, {
          afterCopy: () => writeFile(join(vaultPath, page.path), "typed a moment ago")
        })
    });
    expect(await retirement.retire(context(), new Set())).toMatchObject({ kept: 1, failed: 0 });
    expect(await readFile(join(vaultPath, page.path), "utf8")).toBe("typed a moment ago");
    expect(retiredMetadata(store.files.get(id(1))!)).toMatchObject({
      outcome: "kept",
      reason: "edited"
    });
  });

  it("serializes each file with the projection writes of the same target", async () => {
    const vaultPath = await newVault();
    const { store, retirement, context } = setup(vaultPath);
    for (let n = 1; n <= 3; n += 1) await projectedPage(vaultPath, store, n);
    await retirement.retire(context(), new Set());
    expect(store.events).toEqual([
      `lock:${id(1)}`,
      `unlock:${id(1)}`,
      `lock:${id(2)}`,
      `unlock:${id(2)}`,
      `lock:${id(3)}`,
      `unlock:${id(3)}`
    ]);
  });

  it("reads the row again under the lock and skips one that another pass already retired", async () => {
    const vaultPath = await newVault();
    const { store, retirement, archive, context } = setup(vaultPath);
    await projectedPage(vaultPath, store, 1);
    const find = store.find.bind(store);
    store.find = async (memoraId) => {
      const row = await find(memoraId);
      // Another pass retired it between the listing and the lock.
      await store.retire(row!, { at: NOW.toISOString(), outcome: "absent" });
      return find(memoraId);
    };
    expect(await retirement.retire(context(), new Set())).toEqual({
      archived: 0,
      kept: 0,
      absent: 0,
      failed: 0
    });
    expect(archive).not.toHaveBeenCalled();
  });

  it("counts a file it cannot handle, leaves its row alone and continues with the others", async () => {
    const vaultPath = await newVault();
    const { store, retirement, context } = setup(vaultPath);
    for (let n = 1; n <= 3; n += 1) await projectedPage(vaultPath, store, n);
    store.failOn.add(id(2));
    expect(await retirement.retire(context(), new Set())).toEqual({
      archived: 2,
      kept: 0,
      absent: 0,
      failed: 1
    });
    expect(store.files.get(id(2))!.status).toBe("synced");
    // The next pass finds its file gone (it was archived before the row update failed) and settles the row.
    store.failOn.clear();
    expect(await retirement.retire(context(), new Set())).toMatchObject({ absent: 1, failed: 0 });
    expect(store.files.get(id(2))!.status).toBe("retired");
  });

  it("stops the whole pass when the sync is paused or the vault changed", async () => {
    const vaultPath = await newVault();
    const { store, retirement, context } = setup(vaultPath);
    for (let n = 1; n <= 3; n += 1) await projectedPage(vaultPath, store, n);
    let calls = 0;
    const assertBinding = async () => {
      calls += 1;
      if (calls === 2) throw new Error("obsidianWiki.errors.paused");
    };
    await expect(retirement.retire(context({ assertBinding }), new Set())).rejects.toThrow(
      "obsidianWiki.errors.paused"
    );
    expect([...store.files.values()].map((file) => file.status)).toEqual([
      "retired",
      "synced",
      "synced"
    ]);
    const controller = new AbortController();
    controller.abort();
    await expect(
      retirement.retire(context({ signal: controller.signal }), new Set())
    ).rejects.toThrow("obsidianWiki.errors.paused");
  });

  it("does nothing when there is nothing to retire", async () => {
    const vaultPath = await newVault();
    const { store, retirement, context } = setup(vaultPath);
    const existing = vi.spyOn(store, "existingPageIds");
    expect(await retirement.retire(context(), new Set())).toEqual({
      archived: 0,
      kept: 0,
      absent: 0,
      failed: 0
    });
    expect(existing).not.toHaveBeenCalled();
  });
});

describe("moving a kept file to recovery", () => {
  async function keptFile() {
    const vaultPath = await newVault();
    const ctx = setup(vaultPath);
    const page = await projectedPage(vaultPath, ctx.store, 1);
    await put(vaultPath, page.path, "my own words");
    await ctx.retirement.retire(ctx.context(), new Set());
    return { vaultPath, page, ...ctx };
  }

  it("archives the bytes the file holds now and records it", async () => {
    const { vaultPath, page, store, retirement, context } = await keptFile();
    expect(retiredMetadata(store.files.get(id(1))!)).toMatchObject({ outcome: "kept" });

    await expect(retirement.moveToRecovery(context(), id(1))).resolves.toBe("archived");

    await expect(stat(join(vaultPath, page.path))).rejects.toThrow("ENOENT");
    const copy = join(
      vaultPath,
      "Memora/.memora-recovery/retired-wiki",
      STAMP,
      page.path.slice("Memora/".length)
    );
    expect(await readFile(copy, "utf8")).toBe("my own words");
    const metadata = retiredMetadata(store.files.get(id(1))!);
    expect(metadata).toMatchObject({ outcome: "archived", movedAt: NOW.toISOString() });
    expect(metadata).not.toHaveProperty("reason");
    expect(await retirement.report()).toMatchObject({ archived: 1, keptTotal: 0, kept: [] });
  });

  it("refuses a row that is not a kept file, or a path outside the managed root", async () => {
    const { store, retirement, context } = await keptFile();
    await expect(retirement.moveToRecovery(context(), id(99))).rejects.toThrow(
      "obsidianWiki.errors.binding"
    );
    await retirement.moveToRecovery(context(), id(1));
    await expect(retirement.moveToRecovery(context(), id(1))).rejects.toThrow(
      "obsidianWiki.errors.binding"
    );
    store.add({
      n: 7,
      path: "Notes/Mine.md",
      status: "retired",
      metadata: { retired: { at: NOW.toISOString(), outcome: "kept", reason: "unsafe" } }
    });
    await expect(retirement.moveToRecovery(context(), id(7))).rejects.toThrow(
      "obsidianWiki.errors.binding"
    );
  });

  it("checks the vault binding first and does not touch the file when it fails", async () => {
    const { vaultPath, page, retirement, context } = await keptFile();
    await expect(
      retirement.moveToRecovery(
        context({
          assertBinding: async () => {
            throw new Error("obsidianWiki.errors.paused");
          }
        }),
        id(1)
      )
    ).rejects.toThrow("obsidianWiki.errors.paused");
    expect(await readFile(join(vaultPath, page.path), "utf8")).toBe("my own words");
  });

  it("answers absent when the person already removed the file", async () => {
    const { vaultPath, page, store, retirement, context } = await keptFile();
    await rm(join(vaultPath, page.path));
    await expect(retirement.moveToRecovery(context(), id(1))).resolves.toBe("absent");
    expect(retiredMetadata(store.files.get(id(1))!)).toMatchObject({ outcome: "absent" });
  });

  it("refuses a file that is now a symlink and leaves it", async () => {
    const { vaultPath, page, retirement, context } = await keptFile();
    await rm(join(vaultPath, page.path));
    await put(vaultPath, "outside/target.md", "elsewhere");
    await symlink(join(vaultPath, "outside/target.md"), join(vaultPath, page.path));
    await expect(retirement.moveToRecovery(context(), id(1))).rejects.toThrow(
      "unsafe_obsidian_symlink"
    );
    expect(await readFile(join(vaultPath, "outside/target.md"), "utf8")).toBe("elsewhere");
  });
});

describe("the retired report", () => {
  it("counts each outcome, lists kept files by path and caps the list with an exact total", async () => {
    const vaultPath = await newVault();
    const { store, retirement } = setup(vaultPath);
    const at = NOW.toISOString();
    store.add({
      n: 1,
      path: "Memora/a.md",
      status: "retired",
      metadata: { retired: { at, outcome: "archived", archivedPath: "x" } }
    });
    store.add({
      n: 2,
      path: "Memora/b.md",
      status: "retired",
      metadata: { retired: { at, outcome: "absent" } }
    });
    for (let n = 3; n < 3 + 205; n += 1)
      store.add({
        n,
        path: `Memora/kept-${String(n).padStart(3, "0")}.md`,
        status: "retired",
        metadata: { retired: { at, outcome: "kept", reason: "unsafe" } }
      });
    // A retired row without valid retirement metadata is not reported as anything.
    store.add({ n: 500, path: "Memora/odd.md", status: "retired", metadata: { retired: 5 } });
    store.add({ n: 501, path: "Memora/live.md" });

    const report = await retirement.report();

    expect(report).toMatchObject({ archived: 1, absent: 1, keptTotal: 205 });
    expect(report.kept).toHaveLength(200);
    expect(report.kept[0]).toEqual({
      id: id(3),
      relativePath: "Memora/kept-003.md",
      reason: "unsafe"
    });
  });

  it("reads an empty registry as nothing retired", async () => {
    const vaultPath = await newVault();
    const { retirement } = setup(vaultPath);
    expect(await retirement.report()).toEqual({ archived: 0, absent: 0, keptTotal: 0, kept: [] });
  });
});

describe("hashing", () => {
  it("is the same hash for the worker's expected-hash check and the projection's registered hash", async () => {
    // The retirement compares with the projection hash and the worker checks that same hash again.
    const vaultPath = await newVault();
    const text = "---\r\nmemora_id: x\r\n---\r\nbody\r\n";
    await put(vaultPath, "Memora/Wiki/P.md", text);
    await expect(
      archiveObsidianFile({
        vaultPath,
        relativePath: "Memora/Wiki/P.md",
        managedRoot: "Memora",
        stamp: STAMP,
        expectedHash: projectionHash(text)
      })
    ).resolves.toMatchObject({ outcome: "archived" });
  });
});
