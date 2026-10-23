import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closePgPool,
  createIntegrationClientRepository,
  createJobRepository,
  createObsidianSyncRepository,
  createObsidianWikiRepository,
  createPgPool,
  createSettingsRepository,
  createSourceItemRepository,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations,
  type JobRecord,
  type PgPool
} from "@app/db";
import { obsidianEditingCapability, obsidianLayoutConfigSchema } from "@app/integration-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { StorageSettings } from "../../shared/ipc.js";
import { archiveObsidianFile, runObsidianSync } from "../workers/obsidian-sync.worker.js";
import { buildObsidianMirror } from "./obsidian-mirror.js";
import { ObsidianSyncService } from "./obsidian-sync-service.js";
import { projectionHash } from "./obsidian-wiki-projection.js";

/**
 * T34a proof on a real database: a synthetic vault of 22 old wiki page files, 2 of them edited by
 * hand, registered the way the projection registers them, on a database with no wiki pages. One
 * projection job retires the files; a second one writes nothing.
 */
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../..");
const sidecarPaths = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const sidecarAvailable = existsSync(join(sidecarPaths.binDir, "postgres"));
const PAGES = 22;
const EDITED = [4, 15];

const sha = (bytes: Buffer) => projectionHash(bytes.toString("utf8"));
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

describe.skipIf(!sidecarAvailable)("retiring the old wiki files on PostgreSQL", () => {
  let workDir = "";
  let manager: PostgresSidecarManager;
  let pool: PgPool;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-retire-sidecar-"));
    manager = new PostgresSidecarManager({
      binDir: sidecarPaths.binDir,
      dataDir: join(workDir, "data"),
      database: "memora_retire",
      user: "memora_retire",
      password: `retire-${randomUUID()}`,
      startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 10_000
    });
    const connection = await manager.start();
    pool = createPgPool({ connectionString: connection.connectionString, max: 4 });
    await runMigrations(pool, join(workspaceRoot, "packages/db/drizzle"), {
      seedFolder: join(workspaceRoot, "packages/db/seed")
    });
    // Migration 0052 adds this value; until it is merged the test adds it itself (a no-op after).
    await pool.query("alter type obsidian_sync_status add value if not exists 'retired'");
  }, 180_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool).catch(() => undefined);
    await manager?.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  }, 30_000);

  async function reset() {
    for (const table of [
      "obsidian_editorial_operations",
      "obsidian_projection_revisions",
      "obsidian_sync_files",
      "jobs",
      "source_items"
    ])
      await pool.query(`delete from ${table}`);
    await pool.query("delete from settings where key like 'obsidian.%'");
  }

  describe.each([
    ["the layout v2 mirror", true],
    ["the first-generation plan", false]
  ])("through %s", (_name, layoutV2) => {
    let vaultPath = "";
    let settings: StorageSettings;
    let service: ObsidianSyncService;
    let job: JobRecord;
    const pageIds: string[] = [];
    const paths: string[] = [];
    const projected: string[] = [];
    const edited = (n: number) => projected[n]! + "\nMy own paragraph.\n";
    let binding = "";
    let before: Record<string, string> = {};

    beforeAll(async () => {
      await reset();
      vaultPath = await mkdtemp(join(workDir, "vault-"));
      settings = {
        obsidianVaultPath: vaultPath,
        managedRoot: "Memora",
        obsidianSyncEnabled: true,
        obsidianSyncPaused: false,
        deletionPolicy: "tombstone",
        uploadCopiesEnabled: false,
        uploadCopiesFolderPath: null,
        updatedAt: new Date().toISOString()
      };
      service = new ObsidianSyncService({
        getPool: () => pool,
        getStorageSettings: async () => settings,
        getLocale: async () => "en",
        writeProjection: async (input) => {
          const result = await runObsidianSync({ action: "write", ...input });
          return { mtimeMs: Number(result.mtimeMs) };
        },
        archiveProjection: (input) => archiveObsidianFile(input),
        // One job run delivers the whole small vault, however busy the machine is.
        delivery: { pageMs: 60_000 }
      });
      if (layoutV2)
        await createSettingsRepository(pool).set(
          "obsidian.layout",
          obsidianLayoutConfigSchema.parse({ version: 2, language: "en", attachments: "omit" })
        );
      // The vault binding the projection records deliveries under.
      binding = projectionHash(JSON.stringify([vaultPath, "Memora"]));
      const sync = createObsidianSyncRepository(pool);
      const wiki = createObsidianWikiRepository(pool);
      for (let n = 1; n <= PAGES; n += 1) {
        const id = randomUUID();
        const path = `Memora/Wiki/Topics/Topic ${String(n).padStart(2, "0")}.md`;
        const content = `---\nmemora_id: ${id}\nmemora_type: wiki_page\nmemora_managed: true\n---\n# Topic ${n}\n`;
        await mkdir(dirname(join(vaultPath, path)), { recursive: true });
        await writeFile(join(vaultPath, path), content);
        await sync.create({
          memoraId: id,
          entityId: id,
          entityType: "wiki_page",
          memoraType: "wiki_page",
          relativePath: path,
          frontmatterHash: "f",
          contentHash: "c",
          mtimeMs: 1,
          status: "synced",
          metadata: { projectionFormat: layoutV2 ? 2 : 1, bindingHash: binding }
        });
        const delivery = await wiki.prepare({
          memora_id: id,
          revision_id: "revision-1",
          binding_hash: binding,
          relative_path: path,
          content,
          editable_hash: "e",
          generated_hash: "g",
          rendered_hash: projectionHash(content),
          base_hash: null,
          before_content: null
        });
        await wiki.finish(delivery.id, "written");
        pageIds.push(id);
        paths.push(path);
        projected.push(content);
      }
      // A person edited two of them in Obsidian; one also has an unresolved projection conflict.
      for (const n of EDITED) await writeFile(join(vaultPath, paths[n]!), edited(n));
      const conflicted = await wiki.prepare({
        memora_id: pageIds[EDITED[0]!]!,
        revision_id: "revision-2",
        binding_hash: binding,
        relative_path: paths[EDITED[0]!]!,
        content: "newer",
        editable_hash: "e",
        generated_hash: "g",
        rendered_hash: projectionHash("newer"),
        base_hash: projectionHash(projected[EDITED[0]!]!),
        before_content: null
      });
      await wiki.finish(conflicted.id, "conflict", "obsidianWiki.errors.conflict");
      const queued = await service.wiki.enqueue(true);
      job = (await createJobRepository(pool).findById(queued!))!;
      before = await snapshot(vaultPath);
    }, 60_000);

    it("starts with 22 registered page files, no wiki table and a projection conflict", async () => {
      expect(Object.keys(before)).toHaveLength(PAGES);
      expect(
        (await pool.query("select to_regclass('public.wiki_pages') is null as gone")).rows[0].gone
      ).toBe(true);
      const status = await service.wiki.status();
      expect(status.conflicts.map((c) => c.memora_id)).toEqual([pageIds[EDITED[0]!]]);
      expect(status.retired).toEqual({ archived: 0, absent: 0, keptTotal: 0, kept: [] });
    });

    it("archives the 20 unchanged files, keeps the 2 edited ones and deletes nothing", async () => {
      const result = (await service.wiki.execute(job)) as {
        retired: unknown;
        projected: number;
        conflicts: number;
      };

      expect(result.retired).toEqual({ archived: 20, kept: 2, absent: 0, failed: 0 });
      // The projection went on to write its own index files, and none of them collided.
      expect(result.conflicts).toBe(0);
      expect(result.projected).toBeGreaterThan(0);
      const rows = await createObsidianSyncRepository(pool).listRetirableFiles(true);
      expect(rows).toHaveLength(PAGES);
      expect(rows.every((row) => row.status === "retired" && row.metadata.retired)).toBe(true);
      const files = await snapshot(vaultPath);
      const recovered = Object.keys(files).filter((path) =>
        path.startsWith("Memora/.memora-recovery/retired-wiki/")
      );
      expect(recovered).toHaveLength(20);
      for (let n = 0; n < PAGES; n += 1) {
        if (EDITED.includes(n)) {
          expect(await readFile(join(vaultPath, paths[n]!), "utf8")).toBe(edited(n));
          expect(recovered.some((path) => path.endsWith(paths[n]!.slice(7)))).toBe(false);
        } else {
          await expect(stat(join(vaultPath, paths[n]!))).rejects.toThrow("ENOENT");
          const copy = recovered.filter((path) => path.endsWith(paths[n]!.slice(7)));
          expect(copy).toHaveLength(1);
          expect(files[copy[0]!]).toBe(projectionHash(projected[n]!));
        }
      }
      // Nothing of the old wiki is lost: 20 copies in recovery and the 2 edited files in place.
      const inPlace = Object.keys(files).filter((path) => path.startsWith("Memora/Wiki/Topics/"));
      expect(inPlace.sort()).toEqual(EDITED.map((n) => paths[n]!).sort());
    });

    it("reports what happened, lists the kept files and drops their stale conflict", async () => {
      const status = await service.wiki.status();
      expect(status.retired).toEqual({
        archived: 20,
        absent: 0,
        keptTotal: 2,
        kept: EDITED.map((n) => ({ id: pageIds[n], relativePath: paths[n], reason: "edited" }))
      });
      expect(status.conflicts).toEqual([]);
    });

    it("writes nothing the second time", async () => {
      const after = await snapshot(vaultPath);
      const result = (await service.wiki.execute(job)) as { retired: unknown; projected: number };
      expect(result).toMatchObject({
        retired: { archived: 0, kept: 0, absent: 0, failed: 0 },
        projected: 0
      });
      expect(await snapshot(vaultPath)).toEqual(after);
    });

    it("reserves the path of a kept file so no new target can take it", async () => {
      const kept = paths[EDITED[1]!]!;
      const source = await createSourceItemRepository(pool).create({
        type: "Book",
        title: "Reserved by a kept file"
      });
      const config = obsidianLayoutConfigSchema.parse({
        version: 2,
        language: "en",
        attachments: "omit"
      });
      const scope = { sourceIds: [], includeDescendants: true };
      const where = async (migrate = false) =>
        (await buildObsidianMirror(pool, "Memora", scope, config, { migrate })).find(
          (t) => t.id === source.id
        )!.path;
      const wanted = await where();
      // Put a retired, kept page file exactly where that source wants to go.
      const row = (await createObsidianSyncRepository(pool).listRetirableFiles(true)).find(
        (file) => file.relativePath === kept
      )!;
      await pool.query("update obsidian_sync_files set relative_path=$2 where id=$1", [
        row.id,
        wanted
      ]);
      try {
        expect(await where()).not.toBe(wanted);
        expect(await where()).toMatch(/ — [0-9a-f]{8}\.md$/);
        // Also while a layout migration re-places the rest: a retired file never moves.
        expect(await where(true)).toMatch(/ — [0-9a-f]{8}\.md$/);
      } finally {
        await pool.query("update obsidian_sync_files set relative_path=$2 where id=$1", [
          row.id,
          kept
        ]);
        await pool.query("delete from source_items where id=$1", [source.id]);
      }
    });

    it("answers an edit of a retired file with an ignored receipt, and lists it nowhere", async () => {
      const client = await createIntegrationClientRepository(pool).create({
        clientType: "obsidian-plugin",
        displayName: "Retire test",
        tokenHash: `hash-${randomUUID()}`,
        scopes: [obsidianEditingCapability],
        contractVersion: "1"
      });
      const vaultId = randomUUID();
      const bound = await service.editorial.bind(client.id, vaultId);
      const target = pageIds[EDITED[0]!]!;
      const receipt = await service.editorial.apply(client.id, {
        version: 1,
        operationId: randomUUID(),
        vaultId,
        binding: bound.binding,
        targetId: target,
        targetType: "wiki_page",
        kind: "edit",
        relativePath: paths[EDITED[0]!]!,
        baseRevision: "revision-1",
        baseVersion: 1,
        baseHash: "a".repeat(64),
        content: "---\n---\nA local edit the plugin wants to save",
        occurredAt: new Date().toISOString()
      });
      expect(receipt).toMatchObject({
        status: "ignored",
        targetId: target,
        reason: "obsidianWiki.errors.retired",
        projection: "synced"
      });
      const manifest = await service.editorial.manifest(client.id, vaultId, 0, undefined, true);
      expect(manifest.files.map((file) => file.targetId)).not.toContain(target);
      expect(await service.editorial.conflicts()).toEqual([]);
    });

    it("moves a kept file to recovery on request and leaves the other one", async () => {
      const status = await service.wiki.moveRetiredToRecovery(pageIds[EDITED[0]!]!);
      expect(status.retired).toMatchObject({ archived: 21, keptTotal: 1 });
      expect(status.retired.kept.map((file) => file.relativePath)).toEqual([paths[EDITED[1]!]]);
      await expect(stat(join(vaultPath, paths[EDITED[0]!]!))).rejects.toThrow("ENOENT");
      const files = await snapshot(vaultPath);
      const copy = Object.keys(files).find(
        (path) => path.includes(".memora-recovery/retired-wiki/") && path.endsWith("Topic 05.md")
      )!;
      expect(files[copy]).toBe(projectionHash(edited(EDITED[0]!)));
      expect(await readFile(join(vaultPath, paths[EDITED[1]!]!), "utf8")).toBe(edited(EDITED[1]!));
      await expect(service.wiki.moveRetiredToRecovery(pageIds[EDITED[0]!]!)).rejects.toThrow(
        "obsidianWiki.errors.binding"
      );
    });
  });
});
