import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { parseArgs } from "node:util";

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
  type JobRecord,
  type PgPool,
  type TopicStatsWrite
} from "@app/db";
import {
  createRng,
  deriveSeed,
  itemKey,
  placementRecord,
  topicRecord
} from "@app/domain/topic-tree";
import { obsidianLayoutConfigSchema, parseObsidianMarkdown } from "@app/integration-contracts";

import type { StorageSettings } from "../../shared/ipc.js";
import { archiveObsidianFile, runObsidianSync } from "../workers/obsidian-sync.worker.js";
import { lightJobUpdate } from "./job-supervisor.js";
import { ObsidianSyncService } from "./obsidian-sync-service.js";
import { obsidianDeliveryConfig } from "./obsidian-wiki-projection.js";
import { loadCorpus, seedArticle } from "./topic-tree/corpus-library.js";

/**
 * T33 proof on a scratch PostgreSQL: the ENV-C corpus (the Wikipedia pseudo-notes, 800 root sources
 * and 18,632 notes, seeded through the product's repositories, no model call) under a topic tree of
 * about 1.5k topics written through `topicTreeRepository`, projected into a temporary vault by the
 * real projection service, page by page, the way the light lane's compute worker runs it. It reports
 * the cap errors (none expected), the main-process peak RSS, the per-page timing, the writes of a
 * second pass (0 expected), a pass killed mid-page and resumed from its checkpoint, and a rename
 * that changes the map and its aliases but not its path. It starts its own PostgreSQL sidecar and
 * touches no other database; the vault is a temporary folder.
 *
 *   npx tsx apps/desktop/src/main/services/verify-obsidian-topics.ts [--articles 800]
 *     [--corpus <folder with manifest.json and notes.jsonl>] [--profile] [--keep]
 *
 * `--profile` reports where the first and second passes spend their time, by statement.
 */
const { values: args } = parseArgs({
  options: {
    articles: { type: "string", default: "800" },
    corpus: { type: "string" },
    leaf: { type: "string", default: "14" },
    keep: { type: "boolean", default: false },
    profile: { type: "boolean", default: false }
  }
});
const workspace = resolve(import.meta.dirname, "../../../../..");
const corpusDir = resolve(args.corpus ?? join(workspace, ".cache/corpus"));
const leafSize = Number(args.leaf);
const articleLimit = Number(args.articles);
const seed = 20261014;
const dimensions = 256;

const workDir = await mkdtemp(join(tmpdir(), "memora-obsidian-topics-"));
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const manager = new PostgresSidecarManager({
  binDir: sidecar.binDir,
  dataDir: join(workDir, "data"),
  database: "memora_obsidian_topics",
  user: "memora_obsidian_topics",
  password: `obsidian-topics-${randomUUID()}`,
  startupTimeoutMs: 30_000,
  shutdownTimeoutMs: 20_000
});
const log = (line: string) => console.log(`[${new Date().toISOString()}] ${line}`);
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
};
const mb = (bytes: number) => Math.round((bytes / 1024 / 1024) * 10) / 10;

let peakRss = process.memoryUsage().rss;
const sampler = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 50);

let pool: PgPool | undefined;
try {
  const connection = await manager.start();
  pool = createPgPool({ connectionString: connection.connectionString, max: 8 });
  // --profile: where a pass spends its time, by statement (and in the vault writes).
  const timings = new Map<string, { n: number; ms: number }>();
  const timed = (key: string, ms: number) => {
    const entry = timings.get(key) ?? { n: 0, ms: 0 };
    entry.n += 1;
    entry.ms += ms;
    timings.set(key, entry);
  };
  if (args.profile) {
    const query = pool.query.bind(pool) as (...a: unknown[]) => Promise<unknown>;
    (pool as unknown as { query: (...a: unknown[]) => Promise<unknown> }).query = async (
      ...a: unknown[]
    ) => {
      const started = performance.now();
      try {
        return await query(...a);
      } finally {
        const text = typeof a[0] === "string" ? a[0] : JSON.stringify(a[0]).slice(0, 80);
        timed(text.replace(/\s+/g, " ").trim().slice(0, 90), performance.now() - started);
      }
    };
  }
  const profileReport = () =>
    [...timings]
      .sort((a, b) => b[1].ms - a[1].ms)
      .slice(0, 20)
      .map(([sql, t]) => `${Math.round(t.ms)} ms / ${t.n} · ${sql}`);
  await runMigrations(pool, join(workspace, "packages/db/drizzle"), {
    seedFolder: join(workspace, "packages/db/seed")
  });
  // Seeding only: commits need not wait for the disk. Measurements run with the default again.
  await pool.query("alter system set synchronous_commit = off");
  await pool.query("select pg_reload_conf()");

  const corpus = await loadCorpus(corpusDir);
  const articles = corpus.articles.slice(0, articleLimit);
  const seedStarted = performance.now();
  const seeded: Array<{
    key: string;
    domain: string;
    lang: string;
    title: string;
    notes: string[];
  }> = [];
  for (const [index, article] of articles.entries()) {
    const result = await seedArticle(pool, corpus, article);
    seeded.push({
      key: article.key,
      domain: article.domain,
      lang: article.lang,
      title: article.title,
      notes: result.noteIds
    });
    if ((index + 1) % 100 === 0) log(`seeded ${index + 1} of ${articles.length} articles`);
  }
  // The proof needs no vectors: drop the embedding jobs the seeding queued.
  await pool.query("delete from jobs where type = 'note-embedding'");
  const noteCount = seeded.reduce((n, a) => n + a.notes.length, 0);
  log(
    `library: ${seeded.length} sources, ${noteCount} notes in ${Math.round(performance.now() - seedStarted)} ms`
  );

  // The topic tree: 12 Areas of domains, a topic per (language, domain), leaves of <= leafSize notes.
  const rng = createRng(deriveSeed(seed, "t33-proof"));
  const treeId = randomUUID();
  const rootId = randomUUID();
  const domains = [...new Set(seeded.map((a) => a.domain))].sort();
  const areaIds: string[] = Array.from({ length: Math.min(12, domains.length) }, () =>
    randomUUID()
  );
  const topics: ReturnType<typeof topicRecord>[] = [];
  const named = (title: string, position: number) => ({
    role: "topic" as const,
    title,
    nameState: "named" as const,
    nameSource: "llm" as const,
    nameLanguage: "en",
    position
  });
  areaIds.forEach((id, n) =>
    topics.push(
      topicRecord(
        id,
        rootId,
        named(domains.filter((_, d) => d % areaIds.length === n).join(" · "), n)
      )
    )
  );
  const groups = new Map<string, { id: string; leaves: number; titles: Set<string> }>();
  const placements: Array<{
    item: ReturnType<typeof itemKey>;
    placement: ReturnType<typeof placementRecord>;
  }> = [];
  const centralities = new Map<
    string,
    Array<{ item: ReturnType<typeof itemKey>; centrality: number }>
  >();
  for (const article of seeded) {
    const groupKey = `${article.lang}:${article.domain}`;
    let group = groups.get(groupKey);
    if (!group) {
      const area = areaIds[domains.indexOf(article.domain) % areaIds.length]!;
      group = { id: randomUUID(), leaves: 0, titles: new Set() };
      groups.set(groupKey, group);
      topics.push(
        topicRecord(group.id, area, named(`${article.domain} (${article.lang})`, groups.size))
      );
    }
    const chunks = Math.ceil(article.notes.length / leafSize);
    for (let chunk = 0; chunk < chunks; chunk += 1) {
      let title = chunks > 1 ? `${article.title} · ${chunk + 1}` : article.title;
      for (let n = 2; group.titles.has(title.toLocaleLowerCase("und")); n += 1)
        title = `${article.title} (${n})`;
      group.titles.add(title.toLocaleLowerCase("und"));
      const leaf = randomUUID();
      topics.push(topicRecord(leaf, group.id, named(title.slice(0, 120), group.leaves++)));
      const members = article.notes.slice(chunk * leafSize, (chunk + 1) * leafSize);
      for (const note of members) {
        placements.push({ item: itemKey("note", note), placement: placementRecord(leaf) });
        const list = centralities.get(leaf) ?? [];
        list.push({
          item: itemKey("note", note),
          centrality: Math.round(rng.next() * 1000) / 1000
        });
        centralities.set(leaf, list);
      }
    }
  }
  const repo = createTopicTreeRepository(pool);
  const tree = await repo.createTree({
    id: treeId,
    rootId,
    spaceKey: `proof:${dimensions}`,
    embeddingProvider: "proof",
    embeddingModel: "proof",
    embeddingRuntime: "none",
    dimensions,
    config: {},
    configHash: "proof",
    seed
  });
  const stats: TopicStatsWrite[] = [rootId, ...topics.map((t) => t.id)].map((topicId) => ({
    topicId,
    n: 0,
    ls: new Float64Array(dimensions),
    cosSqSum: 0,
    lowCosPercentiles: [],
    ...(centralities.has(topicId) ? { centralities: centralities.get(topicId)! } : {})
  }));
  const built = await repo.bootstrapSnapshot({
    treeId: tree.id,
    expectedGeneration: tree.generation,
    titleKey: "topics.changeSets.build",
    topics,
    placements,
    stats
  });
  assert.equal(built.kind, "applied", JSON.stringify(built));
  let generation = built.kind === "applied" ? built.generation : 0;
  log(`tree: ${topics.length + 1} topics (root included), ${placements.length} placements`);
  await pool.query("alter system reset synchronous_commit");
  await pool.query("select pg_reload_conf()");

  // The vault and the real projection service, its writes through the sync worker's code.
  const vaultPath = await mkdtemp(join(workDir, "vault-"));
  const settings: StorageSettings = {
    obsidianVaultPath: vaultPath,
    managedRoot: "Memora",
    obsidianSyncEnabled: true,
    obsidianSyncPaused: false,
    deletionPolicy: "tombstone",
    uploadCopiesEnabled: false,
    uploadCopiesFolderPath: null,
    updatedAt: new Date().toISOString()
  };
  await createSettingsRepository(pool).set(
    "obsidian.layout",
    obsidianLayoutConfigSchema.parse({ version: 2, language: "pt-BR", attachments: "omit" })
  );
  let writes = 0;
  let kill: { after: number; controller: AbortController } | null = null;
  const service = () =>
    new ObsidianSyncService({
      getPool: () => pool ?? null,
      getStorageSettings: async () => settings,
      getLocale: async () => "pt-BR",
      writeProjection: async (input) => {
        writes += 1;
        const writeStarted = performance.now();
        const result = await runObsidianSync({ action: "write", ...input });
        timed("vault write (worker code)", performance.now() - writeStarted);
        if (kill && writes === kill.after) kill.controller.abort();
        return { mtimeMs: Number(result.mtimeMs) };
      },
      archiveProjection: (input) => archiveObsidianFile(input)
    });
  const jobs = createJobRepository(pool);
  const claim = () => jobs.claimNext("t33-proof", ["obsidian-wiki"], "light");
  interface PageResult {
    projected: number;
    conflicts: number;
    failed: number;
    failures: Array<{ relativePath: string; error: string }>;
    targets: number;
    page: number;
    done: boolean;
    ms: number;
  }
  async function runPage(target: ObsidianSyncService, job: JobRecord, signal?: AbortSignal) {
    const started = performance.now();
    const result = (await target.wiki.execute(job, signal)) as unknown as PageResult;
    await jobs.update(job.id, lightJobUpdate(job, { ...result }));
    return { ...result, wallMs: performance.now() - started };
  }
  async function pass(target: ObsidianSyncService, force = true) {
    const started = performance.now();
    const before = writes;
    assert.ok(await target.wiki.enqueue(force));
    const pages: Array<PageResult & { wallMs: number }> = [];
    for (;;) {
      const job = await claim();
      assert.ok(job, "a page is queued until the pass is done");
      pages.push(await runPage(target, job));
      if (pages.at(-1)!.done) break;
    }
    return { pages, writes: writes - before, ms: performance.now() - started };
  }
  const summary = (label: string, run: Awaited<ReturnType<typeof pass>>) => {
    const ms = run.pages.map((p) => p.wallMs);
    return {
      label,
      targets: run.pages[0]?.targets ?? 0,
      pages: run.pages.length,
      writes: run.writes,
      projected: run.pages.reduce((n, p) => n + p.projected, 0),
      conflicts: run.pages.reduce((n, p) => n + p.conflicts, 0),
      failed: run.pages.reduce((n, p) => n + p.failed, 0),
      failures: run.pages.flatMap((p) => p.failures).slice(0, 5),
      totalMs: Math.round(run.ms),
      pageMs: {
        p50: Math.round(percentile(ms, 50)),
        p95: Math.round(percentile(ms, 95)),
        max: Math.round(Math.max(...ms)),
        first: Math.round(ms[0] ?? 0)
      }
    };
  };
  const report: Record<string, unknown> = {
    library: { sources: seeded.length, notes: noteCount, topics: topics.length + 1 },
    config: obsidianDeliveryConfig
  };

  const obsidian = service();
  const rssBefore = process.memoryUsage().rss;
  peakRss = rssBefore;
  timings.clear();
  const first = await pass(obsidian);
  if (args.profile) log(JSON.stringify((report.firstPassProfile = profileReport()), null, 1));
  timings.clear();
  report.firstPass = {
    ...summary("first pass", first),
    rssBeforeMb: mb(rssBefore),
    peakRssMb: mb(peakRss)
  };
  log(JSON.stringify(report.firstPass));
  assert.equal(
    first.pages.reduce((n, p) => n + p.failed, 0),
    0,
    "no file over the cap"
  );
  assert.equal(
    first.pages.reduce((n, p) => n + p.conflicts, 0),
    0,
    "no conflict"
  );

  // A second pass changes nothing.
  peakRss = process.memoryUsage().rss;
  const second = await pass(obsidian);
  report.secondPass = { ...summary("second pass", second), peakRssMb: mb(peakRss) };
  if (args.profile) log(JSON.stringify((report.secondPassProfile = profileReport()), null, 1));
  log(JSON.stringify(report.secondPass));
  assert.equal(second.writes, 0, "a second pass writes 0 files");

  // A pass killed mid-page resumes from its checkpoint and writes each file once.
  const changed = (
    await pool.query<{ id: string }>(
      "update atomic_notes set body_markdown = body_markdown || ' (revised)', updated_at = now() where id = any($1::uuid[]) returning id",
      [seeded.slice(0, 40).flatMap((a) => a.notes)]
    )
  ).rows.map((row) => row.id);
  assert.ok(await obsidian.wiki.enqueue());
  // The process dies a few writes into the pass: the page that was running stays `running`.
  const before = writes;
  kill = { after: writes + 5, controller: new AbortController() };
  let killed: JobRecord | null = null;
  let pagesBeforeKill = 0;
  for (;;) {
    const job = await claim();
    assert.ok(job, "a page is queued until the pass is done");
    try {
      pagesBeforeKill += 1;
      if ((await runPage(obsidian, job, kill.controller.signal)).done) break;
    } catch (error) {
      assert.match(String(error), /paused/);
      killed = job;
      break;
    }
  }
  kill = null;
  assert.ok(killed, "the pass was killed mid-page");
  const cursor = killed.payload.cursor ?? null;
  const writtenBeforeCrash = writes - before;
  // A restart queues the running page again, with its checkpoint, in a fresh service.
  assert.equal(await jobs.recoverInterrupted(), 1, "the killed page is queued again");
  const restarted = service();
  const resumed: Array<PageResult & { wallMs: number }> = [];
  for (;;) {
    const job = await claim();
    assert.ok(job);
    if (!resumed.length) {
      assert.equal(job.id, killed.id, "the same job runs again");
      assert.equal(job.payload.cursor ?? null, cursor, "it resumes from the checkpoint");
    }
    resumed.push(await runPage(restarted, job));
    if (resumed.at(-1)!.done) break;
  }
  const crashWrites = writes - before;
  const syncRepo = createObsidianSyncRepository(pool);
  let revised = 0;
  for (const id of changed) {
    const file = await syncRepo.findByMemoraId(id);
    if ((await readFile(join(vaultPath, file!.relativePath), "utf8")).includes("(revised)"))
      revised += 1;
  }
  report.killAndResume = {
    changedNotes: changed.length,
    writtenBeforeKill: writtenBeforeCrash,
    writesInAll: crashWrites,
    revisedOnDisk: revised,
    pagesBeforeKill,
    resumedPages: resumed.length,
    resumedFrom: cursor
  };
  log(JSON.stringify(report.killAndResume));
  assert.equal(revised, changed.length, "every changed note is on disk");
  const third = await pass(obsidian);
  assert.equal(third.writes, 0, "nothing is left to write after the resume");

  // A rename changes the map and its aliases, never its path.
  const leaf = topics.find(
    (t) => t.parentId !== rootId && !areaIds.includes(t.parentId!) && t.title
  )!;
  const leafFile = (await syncRepo.findByMemoraId(leaf.id))!;
  const name = {
    title: leaf.title,
    nameState: leaf.nameState,
    nameSource: leaf.nameSource,
    nameLanguage: leaf.nameLanguage,
    namedChangeSetId: leaf.namedChangeSetId,
    aliases: leaf.aliases
  };
  const renamed = await repo.applyChangeSet({
    treeId,
    expectedGeneration: generation,
    origin: "human",
    titleKey: "topics.changeSets.human",
    events: [
      {
        op: "topic.rename",
        topicId: leaf.id,
        before: name,
        after: { ...name, title: "Renamed by the proof", nameSource: "human" }
      }
    ]
  });
  assert.equal(renamed.kind, "applied");
  generation += 1;
  const latest = await jobs.latestByType("obsidian-wiki");
  const admitted = await obsidian.wiki.enqueue();
  assert.notEqual(admitted, latest!.id, "the change-set admits a pass");
  await jobs.requestCancel(admitted!);
  const renamePass = await pass(obsidian);
  const after = (await syncRepo.findByMemoraId(leaf.id))!;
  const parsed = parseObsidianMarkdown(
    await readFile(join(vaultPath, after.relativePath), "utf8")
  )!;
  report.rename = {
    pathBefore: leafFile.relativePath,
    pathAfter: after.relativePath,
    heading: parsed.bodyMarkdown.split("\n")[0],
    aliases: parsed.userFrontmatter,
    writes: renamePass.writes
  };
  log(JSON.stringify(report.rename));
  assert.equal(after.relativePath, leafFile.relativePath, "the path does not change");
  assert.equal(parsed.bodyMarkdown.split("\n")[0], "# Renamed by the proof");
  assert.match(parsed.userFrontmatter, /^aliases: \["Renamed by the proof"\]/);

  // What is on disk: one file per target, no temporary files.
  const files: string[] = [];
  const walk = async (directory: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await walk(path);
      else files.push(relative(vaultPath, path));
    }
  };
  await walk(vaultPath);
  report.vault = {
    files: files.filter((f) => !f.includes(".memora-recovery")).length,
    topicMaps: files.filter((f) => f.startsWith("Memora/Tópicos/")).length,
    temporary: files.filter((f) => f.endsWith(".tmp")).length,
    status: (await obsidian.wiki.status()).delivery
  };
  report.peakRssMb = mb(Math.max(peakRss, process.resourceUsage().maxRSS * 1024));
  console.log(JSON.stringify(report, null, 2));
} finally {
  clearInterval(sampler);
  if (pool) await closePgPool(pool).catch(() => undefined);
  await manager.stop().catch(() => undefined);
  if (!args.keep) await rm(workDir, { recursive: true, force: true });
  else console.log(`kept ${workDir}`);
}
