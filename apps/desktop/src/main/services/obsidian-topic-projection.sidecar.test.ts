import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";

import {
  closePgPool,
  createJobRepository,
  createObsidianSyncRepository,
  createPgPool,
  createSettingsRepository,
  createTopicTreeRepository,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "@app/db";
import { itemKey, placementRecord, topicRecord } from "@app/domain/topic-tree";
import { obsidianLayoutConfigSchema, parseObsidianMarkdown } from "@app/integration-contracts";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { StorageSettings } from "../../shared/ipc.js";
import { archiveObsidianFile, runObsidianSync } from "../workers/obsidian-sync.worker.js";
import { lightJobUpdate } from "./job-supervisor.js";
import { ObsidianSyncService } from "./obsidian-sync-service.js";
import { projectionHash } from "./obsidian-wiki-projection.js";

/**
 * T33 on a real database: the topic tree projected into a vault as folder-note maps of content,
 * delivered a few files per page on the light lane, through the real projection service and the
 * sync worker's writes.
 */
const workspaceRoot = resolve(import.meta.dirname, "../../../../..");
const sidecarPaths = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const sidecarAvailable = existsSync(join(sidecarPaths.binDir, "postgres"));
const u = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const ids = { tree: u(1), root: u(2), area: u(3), curve: u(4), spacing: u(5), merged: u(6) };
const note = (n: number) => u(100 + n);
const sources = [u(200), u(201)];
const PAGE = 4;
/** What one page job returns (the projection's result, as stored on the job). */
interface PageResult {
  projected: number;
  conflicts: number;
  failed: number;
  failures: Array<{ relativePath: string; error: string }>;
  targets: number;
  delivered: number;
  done: boolean;
  pass: Record<string, unknown>;
  retired?: Record<string, number>;
}

async function snapshot(vaultPath: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile())
        out[relative(vaultPath, path)] = projectionHash(await readFile(path, "utf8"));
    }
  };
  await walk(vaultPath);
  return out;
}

describe.skipIf(!sidecarAvailable)("projecting the topic tree into a vault on PostgreSQL", () => {
  let workDir = "";
  let manager: PostgresSidecarManager;
  let pool: PgPool;
  let vaultPath = "";
  let settings: StorageSettings;
  let writes = 0;
  /** Kills the running page right after this many writes (the next file never starts). */
  let crash: { after: number; controller: AbortController } | null = null;
  let generation = 1;
  const service = (delivery: { fileBytes?: number; pageMs?: number } = {}) =>
    new ObsidianSyncService({
      getPool: () => pool,
      getStorageSettings: async () => settings,
      getLocale: async () => "en",
      writeProjection: async (input) => {
        writes += 1;
        const result = await runObsidianSync({ action: "write", ...input });
        if (crash && writes === crash.after) crash.controller.abort();
        return { mtimeMs: Number(result.mtimeMs) };
      },
      archiveProjection: (input) => archiveObsidianFile(input),
      delivery: { pageTargets: PAGE, pageMs: 60_000, ...delivery }
    });
  let obsidian: ObsidianSyncService;

  /** One pass, page after page, the way the light lane's compute worker claims them. */
  async function pass(target = obsidian, force = true) {
    const queued = await target.wiki.enqueue(force);
    const jobs = createJobRepository(pool);
    const results: PageResult[] = [];
    expect((await jobs.findById(queued!))?.lane).toBe("light");
    for (;;) {
      const job = await jobs.claimNext("t33-test", ["obsidian-wiki"], "light");
      if (!job) throw new Error("no page queued");
      const result = (await target.wiki.execute(job)) as unknown as PageResult;
      await jobs.update(job.id, lightJobUpdate(job, { ...result }));
      results.push(result);
      if (result.done) return results;
    }
  }
  const moc = async (path: string) => {
    const parsed = parseObsidianMarkdown(await readFile(join(vaultPath, path), "utf8"));
    if (!parsed) throw new Error(`not a managed file: ${path}`);
    return parsed;
  };
  const registered = async (id: string) =>
    (await createObsidianSyncRepository(pool).findByMemoraId(id))!;
  async function change(
    events: Parameters<ReturnType<typeof createTopicTreeRepository>["applyChangeSet"]>[0]["events"]
  ) {
    const result = await createTopicTreeRepository(pool).applyChangeSet({
      treeId: ids.tree,
      expectedGeneration: generation,
      origin: "human",
      titleKey: "topics.changeSets.human",
      events
    });
    expect(result).toMatchObject({ kind: "applied" });
    generation += 1;
  }

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-topic-projection-"));
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecarPaths.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_topic_projection",
        user: "memora_topic_projection",
        password: `topic-projection-${randomUUID()}`,
        startupTimeoutMs: 30_000,
        shutdownTimeoutMs: 10_000
      });
      try {
        connection = await manager.start();
      } catch (error) {
        await manager.stop().catch(() => undefined);
        if (attempt >= 3) throw error;
      }
    }
    pool = createPgPool({ connectionString: connection.connectionString, max: 6 });
    await runMigrations(pool, join(workspaceRoot, "packages/db/drizzle"), {
      seedFolder: join(workspaceRoot, "packages/db/seed")
    });
    // Two sources with a document, a chunk and three notes each.
    for (const [index, source] of sources.entries()) {
      const document = randomUUID();
      const chunk = randomUUID();
      await pool.query("insert into source_items (id, type, title) values ($1, 'WebArticle', $2)", [
        source,
        `Source ${index + 1}`
      ]);
      await pool.query(
        `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
         values ($1, $2, 'Document', 'Original text.', $3)`,
        [document, source, `hash-${index}`]
      );
      await pool.query(
        `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
         values ($1, $2, $3, 0, 'Passage', $4)`,
        [chunk, document, source, `chunk-${index}`]
      );
      for (let n = index * 3 + 1; n <= index * 3 + 3; n += 1)
        await pool.query(
          `insert into atomic_notes (id, title, body_markdown, idea_statement, status, supersession_status,
             ownership, created_from_source_item_id, owning_source_item_id, evidence_chunk_id,
             generation_provider, generation_model, generation_runtime, generation_prompt_version, generation_key)
           values ($1, $2, 'Body', $3, 'active', 'current', 'source', $4, $4, $5, 'seed', 'seed', 'local', 'seed', $6)`,
          [note(n), `Note ${n}`, `Idea ${n}`, source, chunk, `key-${n}`]
        );
    }
    const repo = createTopicTreeRepository(pool);
    await repo.createTree({
      id: ids.tree,
      rootId: ids.root,
      spaceKey: "local:test:256",
      embeddingProvider: "test",
      embeddingModel: "test",
      embeddingRuntime: "none",
      dimensions: 256,
      config: {},
      configHash: "hash",
      seed: 1
    });
    const named = (title: string, position: number) => ({
      role: "topic" as const,
      title,
      nameState: "named" as const,
      nameSource: "llm" as const,
      nameLanguage: "en",
      position
    });
    const placed: Array<[number, string]> = [
      [1, ids.curve],
      [2, ids.curve],
      [3, ids.curve],
      [4, ids.spacing],
      [5, ids.spacing],
      [6, ids.merged]
    ];
    const built = await repo.bootstrapSnapshot({
      treeId: ids.tree,
      expectedGeneration: 0,
      titleKey: "topics.changeSets.build",
      topics: [
        topicRecord(ids.area, ids.root, named("Memory", 0)),
        topicRecord(ids.curve, ids.area, named("Forgetting curve", 0)),
        topicRecord(ids.spacing, ids.area, named("Spacing", 1)),
        topicRecord(ids.merged, ids.area, named("Merged away", 2))
      ],
      placements: placed.map(([n, topicId]) => ({
        item: itemKey("note", note(n)),
        placement: placementRecord(topicId)
      })),
      // Centrality orders a map's notes: note 3 is the most central of its topic.
      stats: [ids.root, ids.area, ids.curve, ids.spacing, ids.merged].map((topicId) => ({
        topicId,
        n: 0,
        ls: new Float64Array(256),
        cosSqSum: 0,
        lowCosPercentiles: [],
        ...(topicId === ids.curve
          ? {
              centralities: [1, 2, 3].map((n) => ({
                item: itemKey("note", note(n)),
                centrality: n / 10
              }))
            }
          : {})
      }))
    });
    expect(built).toMatchObject({ kind: "applied", generation: 1 });
    vaultPath = await mkdtemp(join(workDir, "vault-"));
    settings = {
      obsidianVaultPath: vaultPath,
      managedRoot: "Memora",
      obsidianSyncEnabled: true,
      obsidianSyncPaused: false,
      uploadCopiesEnabled: false,
      uploadCopiesFolderPath: null,
      updatedAt: new Date().toISOString()
    };
    await createSettingsRepository(pool).set(
      "obsidian.layout",
      obsidianLayoutConfigSchema.parse({ version: 2, language: "en", attachments: "omit" })
    );
    obsidian = service();
  }, 180_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool).catch(() => undefined);
    await manager?.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  }, 30_000);

  it("delivers every topic as a folder-note map, a few files per page", async () => {
    const results = await pass();
    const total = results[0]!.targets as number;
    // 2 sources, 6 notes, 5 topic maps (root included) and 6 indexes.
    expect(total).toBe(19);
    expect(results).toHaveLength(Math.ceil(total / PAGE));
    expect(results.slice(0, -1).every((r) => r.done === false)).toBe(true);
    expect(results.reduce((n, r) => n + r.projected, 0)).toBe(total);
    expect(results.every((r) => r.failed === 0 && r.conflicts === 0)).toBe(true);
    expect(results.at(-1)!.pass).toMatchObject({ total, delivered: total, failed: 0 });

    const root = await moc("Memora/Topics/Topics.md");
    expect(root.frontmatter).toMatchObject({ memoraId: ids.root, memoraType: "topic" });
    expect(root.bodyMarkdown).toContain("# All topics");
    expect(root.bodyMarkdown).toContain("[[Memora/Topics/Memory/Memory|Memory]] · 6 notes");

    const curve = await moc("Memora/Topics/Memory/Forgetting curve/Forgetting curve.md");
    expect(curve.frontmatter).toMatchObject({
      memoraId: ids.curve,
      memoraType: "topic",
      memoraLayout: 2,
      memoraWikiSchema: 2
    });
    expect(curve.userFrontmatter).toBe("");
    expect(curve.bodyMarkdown).toContain("Up: [[Memora/Topics/Memory/Memory|Memory]]");
    expect(curve.bodyMarkdown).toContain(`(memora://topic/${ids.curve})`);
    const notes = curve.bodyMarkdown
      .split("\n")
      .filter((line) => line.startsWith("- [[Memora/Atomic notes/"));
    expect(notes).toEqual([
      "- [[Memora/Atomic notes/Note 3|Note 3]]",
      "- [[Memora/Atomic notes/Note 2|Note 2]]",
      "- [[Memora/Atomic notes/Note 1|Note 1]]"
    ]);
    expect(curve.bodyMarkdown).toMatch(
      /## Contributing sources\n\n- \[\[Memora\/Sources\/.*\|Source 1\]\]/
    );
    // A note links up to the map that holds it.
    const noteFile = await readFile(
      join(vaultPath, (await registered(note(1))).relativePath),
      "utf8"
    );
    expect(noteFile).toContain(
      "[[Memora/Topics/Memory/Forgetting curve/Forgetting curve|Forgetting curve]]"
    );
    // Its evidence: the primary chunk, quoted, with its source.
    expect(noteFile).toMatch(/\[1\] \[\[Memora\/Sources\/[^\]]*\|Source 1\]\][^\n]*\n\n> Passage/);
    expect((await registered(ids.curve)).memoraType).toBe("topic");

    const status = await obsidian.wiki.status();
    expect(status.delivery).toEqual({ state: "done", total, delivered: total, failed: 0 });
    expect(status.conflicts).toEqual([]);
  }, 120_000);

  it("writes nothing on a second pass, and admits none while nothing changed", async () => {
    const before = await snapshot(vaultPath);
    const written = writes;
    const results = await pass();
    expect(results.reduce((n, r) => n + r.projected, 0)).toBe(0);
    expect(writes).toBe(written);
    expect(await snapshot(vaultPath)).toEqual(before);
    const latest = await createJobRepository(pool).latestByType("obsidian-wiki");
    expect(await obsidian.wiki.enqueue()).toBe(latest!.id);
  }, 120_000);

  it("renames a topic in its map and its aliases, never in its path", async () => {
    const path = "Memora/Topics/Memory/Spacing/Spacing.md";
    const before = (await registered(ids.spacing)).relativePath;
    expect(before).toBe(path);
    const name = {
      title: "Spacing",
      nameState: "named" as const,
      nameSource: "llm" as const,
      nameLanguage: "en",
      namedChangeSetId: null,
      aliases: []
    };
    await change([
      {
        op: "topic.rename",
        topicId: ids.spacing,
        before: name,
        after: { ...name, title: "Spaced repetition", nameSource: "human" }
      }
    ]);
    // The committed change-set made the projection stale: a pass is admitted without forcing.
    const latest = await createJobRepository(pool).latestByType("obsidian-wiki");
    const admitted = await obsidian.wiki.enqueue();
    expect(admitted).not.toBe(latest!.id);
    await createJobRepository(pool).requestCancel(admitted!);
    await pass();
    expect((await registered(ids.spacing)).relativePath).toBe(path);
    const map = await moc(path);
    expect(map.bodyMarkdown).toContain("# Spaced repetition");
    expect(map.userFrontmatter).toBe('aliases: ["Spaced repetition"]');
    expect(await moc("Memora/Topics/Memory/Memory.md")).toMatchObject({
      bodyMarkdown: expect.stringContaining(
        "[[Memora/Topics/Memory/Spacing/Spacing|Spaced repetition]] · 2 notes"
      )
    });
  }, 120_000);

  it("retires the map of a merged topic through recovery and gives its title to the successor", async () => {
    const mergedPath = (await registered(ids.merged)).relativePath;
    await change([
      {
        op: "item.move",
        item: itemKey("note", note(6)),
        topicId: ids.spacing,
        before: placementRecord(ids.merged),
        after: placementRecord(ids.spacing)
      },
      {
        op: "topic.retire",
        topicId: ids.merged,
        before: { retiredAt: null, redirectTo: null },
        after: { retiredAt: new Date().toISOString(), redirectTo: ids.spacing }
      }
    ]);
    const results = await pass();
    expect(results[0]!.retired).toEqual({ archived: 1, kept: 0, absent: 0, failed: 0 });
    await expect(stat(join(vaultPath, mergedPath))).rejects.toThrow("ENOENT");
    const files = Object.keys(await snapshot(vaultPath));
    expect(
      files.filter(
        (file) => file.includes(".memora-recovery/retired-wiki/") && file.endsWith("Merged away.md")
      )
    ).toHaveLength(1);
    expect((await registered(ids.merged)).status).toBe("retired");
    const successor = await moc("Memora/Topics/Memory/Spacing/Spacing.md");
    expect(successor.userFrontmatter).toBe('aliases: ["Spaced repetition","Merged away"]');
    expect(successor.bodyMarkdown).toContain("[[Memora/Atomic notes/Note 6|Note 6]]");
    expect((await obsidian.wiki.status()).retired).toMatchObject({ archived: 1, keptTotal: 0 });
  }, 120_000);

  it("resumes a pass killed mid-page from its checkpoint, writing each file once", async () => {
    // Every note changes, so the pass rewrites all six note files.
    await pool.query("update atomic_notes set body_markdown = 'Body, revised', updated_at = now()");
    expect(await obsidian.wiki.enqueue()).toBeTruthy();
    const jobs = createJobRepository(pool);
    const first = await jobs.claimNext("t33-test", ["obsidian-wiki"], "light");
    await jobs.update(first!.id, lightJobUpdate(first!, await obsidian.wiki.execute(first!)));
    // The second page dies right after its first write: the process is gone, the job still running.
    const page = await jobs.claimNext("t33-test", ["obsidian-wiki"], "light");
    const cursor = page?.payload.cursor;
    expect(cursor).toBeTruthy();
    crash = { after: writes + 1, controller: new AbortController() };
    await expect(obsidian.wiki.execute(page!, crash.controller.signal)).rejects.toThrow(
      "obsidianWiki.errors.paused"
    );
    crash = null;
    // A restart re-queues the running page with its checkpoint, in a fresh process.
    expect(await jobs.recoverInterrupted()).toBe(1);
    const restarted = service();
    const beforeResume = writes;
    const resumed: PageResult[] = [];
    for (;;) {
      const job = await jobs.claimNext("t33-test", ["obsidian-wiki"], "light");
      if (!job) throw new Error("no page queued");
      if (resumed.length === 0) expect(job.payload.cursor).toBe(cursor);
      const result = (await restarted.wiki.execute(job)) as unknown as PageResult;
      await jobs.update(job.id, lightJobUpdate(job, { ...result }));
      resumed.push(result);
      if (result.done) break;
    }
    // The page's file that was written before the crash is not written again.
    expect(writes - beforeResume).toBe(resumed.reduce((n, r) => n + r.projected, 0));
    for (let n = 1; n <= 6; n += 1) {
      const file = await readFile(
        join(vaultPath, (await registered(note(n))).relativePath),
        "utf8"
      );
      expect(file).toContain("Body, revised");
    }
    const files = Object.keys(await snapshot(vaultPath));
    expect(files.some((file) => file.endsWith(".tmp"))).toBe(false);
    expect(resumed.every((r) => r.conflicts === 0 && r.failed === 0)).toBe(true);
    // Nothing is left to write: a clean pass now changes nothing.
    const written = writes;
    await pass();
    expect(writes).toBe(written);
    expect((await obsidian.wiki.status()).conflicts).toEqual([]);
  }, 120_000);

  it("ends a page at its time budget, and skips what was deleted after the pass was planned", async () => {
    await pool.query("update atomic_notes set body_markdown = 'Body, budget', updated_at = now()");
    const timed = service({ pageMs: 0 });
    expect(await timed.wiki.enqueue()).toBeTruthy();
    const jobs = createJobRepository(pool);
    const first = await jobs.claimNext("t33-test", ["obsidian-wiki"], "light");
    const page = (await timed.wiki.execute(first!)) as unknown as PageResult;
    await jobs.update(first!.id, lightJobUpdate(first!, { ...page }));
    // With no time to spend, a page still delivers one target, then hands over to the next page.
    expect(page).toMatchObject({ done: false, delivered: 1 });
    // A note deleted now is skipped by the pages that follow; nothing fails or conflicts.
    await pool.query("delete from atomic_notes where id = $1", [note(5)]);
    const results: PageResult[] = [];
    for (;;) {
      const job = await jobs.claimNext("t33-test", ["obsidian-wiki"], "light");
      const result = (await timed.wiki.execute(job!)) as unknown as PageResult;
      await jobs.update(job!.id, lightJobUpdate(job!, { ...result }));
      results.push(result);
      if (result.done) break;
    }
    expect(results.length).toBe(page.targets - 1);
    expect(results.every((r) => r.failed === 0 && r.conflicts === 0)).toBe(true);
    expect((await timed.wiki.status()).conflicts).toEqual([]);
    // The next pass plans without the deleted note.
    const next = await pass();
    expect(next[0]!.targets).toBe(page.targets - 1);
  }, 120_000);

  it("goes on after the app stopped a pass, but not after the person canceled it", async () => {
    await pool.query("update atomic_notes set body_markdown = 'Body, quit', updated_at = now()");
    const jobs = createJobRepository(pool);
    const queued = await obsidian.wiki.enqueue();
    const first = await jobs.claimNext("t33-test", ["obsidian-wiki"], "light");
    expect(first?.id).toBe(queued);
    await jobs.update(first!.id, lightJobUpdate(first!, await obsidian.wiki.execute(first!)));
    // Quitting aborts the running page: the supervisor records the job as canceled.
    const page = await jobs.claimNext("t33-test", ["obsidian-wiki"], "light");
    const quit = new AbortController();
    quit.abort();
    await expect(obsidian.wiki.execute(page!, quit.signal)).rejects.toThrow("paused");
    await jobs.update(page!.id, { status: "canceled", lockedAt: null, lockedBy: null });
    const resumed = await obsidian.wiki.enqueue();
    expect(resumed).not.toBe(page!.id);
    expect((await jobs.findById(resumed!))?.payload).toEqual(page!.payload);
    // A cancel the person asked for is respected until something changes.
    await jobs.requestCancel(resumed!);
    expect(await obsidian.wiki.enqueue()).toBe(resumed);
    await pass();
    for (let n = 1; n <= 4; n += 1) {
      const file = await readFile(
        join(vaultPath, (await registered(note(n))).relativePath),
        "utf8"
      );
      expect(file).toContain("Body, quit");
    }
  }, 120_000);

  it("fails an oversized file alone and by name, and delivers the rest", async () => {
    const small = service({ fileBytes: 1_500 });
    // One note grows past the cap; the four others change but stay small.
    await pool.query(
      `update atomic_notes set updated_at = now(), body_markdown = case when id = $1
         then repeat('A long passage. ', 200) else 'Body, again' end`,
      [note(1)]
    );
    const results = await pass(small);
    const failed = results.flatMap((r) => r.failures);
    expect(failed).toEqual([
      { relativePath: (await registered(note(1))).relativePath, error: "obsidianWiki.errors.limit" }
    ]);
    expect(results.reduce((n, r) => n + r.projected, 0)).toBe(4);
    for (const n of [2, 3, 4, 6]) {
      const file = await readFile(
        join(vaultPath, (await registered(note(n))).relativePath),
        "utf8"
      );
      expect(file).toContain("Body, again");
    }
    const status = await small.wiki.status();
    expect(status.delivery).toMatchObject({ state: "done", failed: failed.length });
    expect(status.conflicts.map((c) => c.relative_path).sort()).toEqual(
      failed.map((f) => f.relativePath).sort()
    );
    expect(status.conflicts.every((c) => c.error === "obsidianWiki.errors.limit")).toBe(true);
    // With the usual cap the next pass writes them and the list empties.
    await pass();
    expect((await obsidian.wiki.status()).conflicts).toEqual([]);
  }, 120_000);
});
