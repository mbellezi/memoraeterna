import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  closePgPool,
  createPgPool,
  createTopicTreeRepository,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "@app/db";
import { itemKey, placementRecord, topicRecord } from "@app/domain/topic-tree";
import type { ItemKey } from "@app/domain/topic-tree";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { sampleRun } from "./rating-commands.js";
import { drawProfileTopics } from "./rating-core.js";
import { readNoteDetails, readRatingSnapshot, RatingReadError } from "./rating-db.js";
import { ratingFiles, readRun } from "./rating-run.js";

// The sampling against a real database: the rows a tree really has, read by the SQL the command
// really runs. The tree is written through the topic repository (the single writer); only the
// notes and sources, which are not topic tables, are inserted directly.
const root = resolve(import.meta.dirname, "../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: root, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

const uid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const noteId = (n: number): string => uid(10_000 + n);
const rootTopic = uid(1);
const configHash = "hash-db-test";

describe.skipIf(!sidecarInstalled)("the rating sample on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager;
  let pool: PgPool;
  let connectionString = "";
  let treeId = "";
  // Topic ids by role in the test tree.
  const areaIds: string[] = [];
  let unnamedId = "";
  let provisionalId = "";
  /** Notes placed twice: primary in one leaf, "also in" another. */
  let alsoInNote = "";
  let alsoInLeaf = "";

  const q = (text: string, values: unknown[] = []) => pool.query(text, values);

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-rating-db-"));
    manager = new PostgresSidecarManager({
      binDir: sidecar.binDir,
      dataDir: join(workDir, "data"),
      database: "rating_fixture",
      user: "rating_fixture",
      password: `rating-${randomUUID()}`,
      startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 10_000
    });
    connectionString = (await manager.start()).connectionString;
    pool = createPgPool({ connectionString, max: 4 });
    await runMigrations(pool, join(root, "packages/db/drizzle"), {
      seedFolder: join(root, "packages/db/seed")
    });

    await q(
      `insert into source_items (id, type, title) values ($1, 'Book', 'Livro de origem'),
         ($2, 'StandaloneArticle', 'Artigo de origem')`,
      [uid(2), uid(3)]
    );
    await q(
      `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
       values ($1, $2, 'Document', 'seed', 'doc')`,
      [uid(90), uid(2)]
    );
    await q(
      `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
       values ($1, $2, $3, 0, 'Passage', 'chunk')`,
      [uid(91), uid(90), uid(2)]
    );

    await q(
      `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
       values ($1, $2, 'Document', 'seed', 'doc3')`,
      [uid(92), uid(3)]
    );
    await q(
      `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
       values ($1, $2, $3, 0, 'Passage', 'chunk3')`,
      [uid(93), uid(92), uid(3)]
    );
    const chunkOf = (source: string): string => (source === uid(2) ? uid(91) : uid(93));

    // 24 leaves (6 Areas x 2 x 2) of 3 current notes, plus 3 notes that are not current.
    const topics = [];
    const placements: { item: ItemKey; placement: ReturnType<typeof placementRecord> }[] = [];
    let noteCount = 0;
    const leaves: string[] = [];
    const insertNote = async (n: number, status: string, supersession: string, source: string) =>
      q(
        `insert into atomic_notes (id, title, body_markdown, idea_statement, status, supersession_status,
           ownership, created_from_source_item_id, owning_source_item_id, evidence_chunk_id,
           generation_provider, generation_model, generation_runtime, generation_prompt_version, generation_key)
         values ($1, $2, 'Corpo', $3, $4::atomic_note_status, $5, 'source', $6, $6, $7, 'seed', 'seed',
           'local', 'seed', $8)`,
        [
          noteId(n),
          `Nota ${n}`,
          `Ideia ${n}`,
          status,
          supersession,
          source,
          chunkOf(source),
          `key-${n}`
        ]
      );
    for (let a = 0; a < 6; a += 1) {
      const area = uid(100 + a);
      areaIds.push(area);
      topics.push(
        topicRecord(area, rootTopic, {
          title: `Área ${a}`,
          nameState: "named",
          nameSource: "llm",
          nameLanguage: "pt-BR",
          description: `Descrição da área ${a}`,
          aliases: [`Apelido ${a}`],
          position: a
        })
      );
      for (let b = 0; b < 2; b += 1) {
        const second = uid(200 + a * 10 + b);
        topics.push(
          topicRecord(second, area, {
            title: `Subárea ${a}.${b}`,
            nameState: "named",
            nameSource: "llm",
            nameLanguage: "pt-BR",
            position: b
          })
        );
        for (let c = 0; c < 2; c += 1) {
          const leaf = uid(1000 + a * 100 + b * 10 + c);
          leaves.push(leaf);
          topics.push(
            topicRecord(leaf, second, {
              title: `Folha ${a}.${b}.${c}`,
              nameState: "named",
              nameSource: "llm",
              nameLanguage: "pt-BR",
              position: c
            })
          );
          for (let d = 0; d < 3; d += 1) {
            noteCount += 1;
            await insertNote(noteCount, "active", "current", noteCount % 2 === 0 ? uid(2) : uid(3));
            placements.push({
              item: itemKey("note", noteId(noteCount)),
              placement: placementRecord(leaf, { decidedBy: "build" })
            });
          }
        }
      }
    }
    // Topics that must never be sampled: unnamed and provisional, with notes.
    unnamedId = uid(900);
    provisionalId = uid(901);
    topics.push(topicRecord(unnamedId, rootTopic, { position: 10 }));
    topics.push(
      topicRecord(provisionalId, rootTopic, {
        title: "termos tfidf",
        nameState: "provisional",
        nameSource: "tfidf",
        position: 11
      })
    );
    for (const [target, n] of [
      [unnamedId, 1000],
      [provisionalId, 1001]
    ] as const) {
      await insertNote(n, "active", "current", uid(2));
      placements.push({
        item: itemKey("note", noteId(n)),
        placement: placementRecord(target, { decidedBy: "build" })
      });
    }
    // Notes that are not current stay out of every topic's members.
    for (const [n, status, supersession] of [
      [2000, "rejected", "current"],
      [2001, "archived", "current"],
      [2002, "active", "superseded"]
    ] as const) {
      await insertNote(n, status, supersession, uid(2));
      placements.push({
        item: itemKey("note", noteId(n)),
        placement: placementRecord(leaves[0] as string, { decidedBy: "build" })
      });
    }
    // The first note is also in another leaf ("also in"): not a member there.
    alsoInNote = noteId(1);
    alsoInLeaf = leaves[23] as string;
    placements.push({
      item: itemKey("note", alsoInNote),
      placement: placementRecord(alsoInLeaf, { rank: 1, decidedBy: "build" })
    });

    const repository = createTopicTreeRepository(pool);
    const tree = await repository.createTree({
      rootId: rootTopic,
      spaceKey: "local:test:256",
      embeddingProvider: "test",
      embeddingModel: "test",
      embeddingRuntime: "none",
      dimensions: 256,
      config: {},
      configHash,
      seed: 1
    });
    treeId = tree.id;
    const result = await repository.bootstrapSnapshot({
      treeId,
      expectedGeneration: 0,
      titleKey: "topics.changeSets.build",
      topics,
      placements
    });
    expect(result.kind).toBe("applied");
  }, 180_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool);
    if (manager) await manager.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("reads the active tree, its topics with description and aliases, and primary current notes only", async () => {
    const snapshot = await readRatingSnapshot(pool, "env-c");
    expect(snapshot.tree).toEqual({ id: treeId, configHash, generation: 1, areasApplied: false });
    expect(snapshot.topics.filter((topic) => topic.role === "root")).toHaveLength(1);
    const area = snapshot.topics.find((topic) => topic.id === areaIds[0]);
    expect(area).toMatchObject({
      title: "Área 0",
      nameState: "named",
      nameSource: "llm",
      nameLanguage: "pt-BR",
      description: "Descrição da área 0",
      aliases: ["Apelido 0"],
      retiredAt: null,
      parentId: rootTopic
    });
    // 72 current notes + the unnamed and provisional topics' one each; no rejected, archived,
    // superseded or secondary placement.
    expect(snapshot.placements).toHaveLength(74);
    expect(snapshot.placements.map((placement) => placement.noteId)).not.toContain(noteId(2000));
    expect(snapshot.placements.filter((placement) => placement.noteId === alsoInNote)).toEqual([
      { topicId: expect.any(String), noteId: alsoInNote }
    ]);
    expect(
      snapshot.placements.find((placement) => placement.noteId === alsoInNote)?.topicId
    ).not.toBe(alsoInLeaf);
  });

  it("reads title, idea statement and source title of the notes to show, current ones only", async () => {
    const details = await readNoteDetails(pool, [noteId(1), noteId(2), noteId(2000), noteId(2002)]);
    expect([...details.keys()].sort()).toEqual([noteId(1), noteId(2)].sort());
    expect(details.get(noteId(1))).toEqual({
      title: "Nota 1",
      idea: "Ideia 1",
      sourceTitle: "Artigo de origem"
    });
    expect(details.get(noteId(2))?.sourceTitle).toBe("Livro de origem");
    expect((await readNoteDetails(pool, [])).size).toBe(0);
  });

  it("has no tree to read before one is active", async () => {
    const empty = { query: async () => ({ rows: [] }) };
    await expect(readRatingSnapshot(empty, "env-c")).rejects.toThrow(RatingReadError);
  });

  it("draws the E4 strata from what the database holds", async () => {
    const draw = drawProfileTopics(await readRatingSnapshot(pool, "env-c"), 20261016);
    const count = (stratum: string) => draw.topics.filter((t) => t.stratum === stratum).length;
    expect([count("area"), count("level-2"), count("level-3-plus")]).toEqual([6, 6, 8]);
    expect(draw.topics.map((topic) => topic.topicId)).not.toContain(unnamedId);
    expect(draw.topics.map((topic) => topic.topicId)).not.toContain(provisionalId);
    expect(draw.counts).toMatchObject({ provisional: 1, unnamed: 1 });
    const alsoInDraw = draw.topics.find((topic) => topic.topicId === alsoInLeaf);
    if (alsoInDraw) expect(alsoInDraw.memberIds).not.toContain(alsoInNote);
  });

  it("runs the sample command over three connection files, read-only, and never draws a run twice", async () => {
    vi.stubEnv("MEMORA_TOPICS_CACHE", workDir);
    try {
      const files: Record<string, string> = {};
      for (const profile of ["env-c", "env-g", "env-f"]) {
        files[profile] = join(workDir, `${profile}-dev-connection.json`);
        await writeFile(files[profile] as string, JSON.stringify({ connectionString }), "utf8");
      }
      const connections = {
        "env-c": files["env-c"] as string,
        "env-g": files["env-g"] as string,
        "env-f": files["env-f"] as string
      };
      const before = await q(
        "select (select count(*) from topics) as t, generation from topic_trees"
      );
      const logs: string[] = [];
      const first = await sampleRun(
        { connections, seed: 20261016, run: "db-run-a" },
        (line) => logs.push(line),
        () => new Date("2026-10-16T12:00:00.000Z")
      );
      expect(first.directory).toBe(join(workDir, "topics", "rating", "db-run-a"));
      expect(first.manifest.profiles.map((profile) => profile.configHash)).toEqual([
        configHash,
        configHash,
        configHash
      ]);
      expect(first.manifest.profiles.every((profile) => profile.treeId === treeId)).toBe(true);
      expect(logs.some((line) => line.includes(`config_hash ${configHash}`))).toBe(true);
      expect(logs.some((line) => line.includes("same database"))).toBe(true);
      expect(logs.some((line) => line.includes("no applied Areas change-set"))).toBe(true);

      const run = await readRun(first.directory, { needSealed: true });
      expect(run.sample.topics).toHaveLength(30);
      expect(run.sealed.entries.filter((entry) => entry.profile === "env-c")).toHaveLength(20);
      expect(
        run.sealed.entries
          .filter((entry) => entry.profile !== "env-c")
          .every((entry) => entry.leaf && entry.level === 3)
      ).toBe(true);
      const sampleText = await readFile(join(first.directory, ratingFiles.sample), "utf8");
      expect(sampleText).not.toContain(treeId);
      expect(sampleText).not.toContain(configHash);
      // Members carry the note title, idea and source title.
      const member = run.sample.topics[0]?.members[0];
      expect(member?.title).toMatch(/^Nota \d+$/u);
      expect(member?.idea).toMatch(/^Ideia \d+$/u);
      expect(member?.source).toMatch(/de origem$/u);

      // The same seed over the same database is the same sample, under another run name.
      const second = await sampleRun({ connections, seed: 20261016, run: "db-run-b" }, () => {});
      const keyOf = (entries: typeof run.sealed.entries) =>
        entries.map((entry) => [entry.key, entry.topicId, entry.memberNoteIds]);
      expect(keyOf((await readRun(second.directory, { needSealed: true })).sealed.entries)).toEqual(
        keyOf(run.sealed.entries)
      );

      await expect(
        sampleRun({ connections, seed: 20261016, run: "db-run-a" }, () => {})
      ).rejects.toThrow(/never redrawn/u);

      // Reading changed nothing.
      const after = await q(
        "select (select count(*) from topics) as t, generation from topic_trees"
      );
      expect(after.rows).toEqual(before.rows);
    } finally {
      vi.unstubAllEnvs();
    }
  }, 120_000);
});
