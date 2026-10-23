import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  closePgPool,
  createPgPool,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "@app/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  identitySnapshotSchema,
  mergedEntityStatistic,
  partitionAgreement,
  readIdentitySnapshot,
  runIdentityMerges
} from "./identity-merges.ts";

// The snapshot's SQL on a real PostgreSQL database built from the product's migrations: the roots
// are found by title with their chapters, only their identity keys and mentions are read, and a
// library that was not reset first is flagged.
const workspace = resolve(import.meta.dirname, "..", "..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

describe.skipIf(!sidecarInstalled)("identity-merges on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager;
  let pool: PgPool;
  let connectionString = "";
  const id = {
    rootA: randomUUID(),
    chapterA: randomUUID(),
    rootB: randomUUID(),
    rootC: randomUUID()
  };

  const addSource = (sourceId: string, type: string, title: string, parent: string | null) =>
    pool.query(
      "insert into source_items (id, type, title, parent_source_item_id) values ($1, $2, $3, $4)",
      [sourceId, type, title, parent]
    );
  const addChunk = async (sourceId: string, hash: string, index = 0) => {
    const documentId = randomUUID();
    const chunkId = randomUUID();
    await pool.query(
      `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
       values ($1, $2, 'Document', 'text', $3)`,
      [documentId, sourceId, `document-${hash}`]
    );
    await pool.query(
      `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
       values ($1, $2, $3, $4, 'text', $5)`,
      [chunkId, documentId, sourceId, index, hash]
    );
    return chunkId;
  };
  const addEntity = async (type: string, name: string) => {
    const entityId = randomUUID();
    await pool.query(
      `insert into entities (id, type, canonical_name, normalized_name, confidence)
       values ($1, $2, $3, lower($3), 0.9)`,
      [entityId, type, name]
    );
    return entityId;
  };
  const addKey = (fingerprint: string, entityId: string, sourceId: string) =>
    pool.query(
      "insert into entity_identity_keys (fingerprint, entity_id, source_item_id) values ($1, $2, $3)",
      [fingerprint, entityId, sourceId]
    );
  const addMention = (entityId: string, sourceId: string, chunkId: string, surface: string) =>
    pool.query(
      `insert into entity_mentions (entity_id, source_item_id, chunk_id, surface_text, confidence)
       values ($1, $2, $3, $4, 0.9)`,
      [entityId, sourceId, chunkId, surface]
    );

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-identity-merges-"));
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_identity_merges_test",
        user: "memora_identity_merges_test",
        password: `identity-merges-${randomUUID()}`,
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
    connectionString = connection.connectionString;
    pool = createPgPool({ connectionString, max: 2 });
    await runMigrations(pool, join(workspace, "packages/db/drizzle"), {
      seedFolder: join(workspace, "packages/db/seed")
    });

    // Root A is a book with a chapter, root B an article, root C a library the snapshot is not
    // asked about. Ana is one entity folded from A's chapter and from B (a merge across roots),
    // Maria another of B, Memória a third of A, and Zed belongs to C alone.
    await addSource(id.rootA, "Book", "Root A", null);
    await addSource(id.chapterA, "BookChapter", "Chapter of A", id.rootA);
    await addSource(id.rootB, "WebArticle", "Root B", null);
    await addSource(id.rootC, "WebArticle", "Root C", null);
    const chunkA = await addChunk(id.chapterA, "hash-a", 3);
    const chunkB = await addChunk(id.rootB, "hash-b", 0);
    const chunkC = await addChunk(id.rootC, "hash-c", 0);
    const ana = await addEntity("Person", "Ana");
    const maria = await addEntity("Person", "Maria");
    const memoria = await addEntity("Concept", "Memória");
    const zed = await addEntity("Person", "Zed");
    await addKey("fp-1", ana, id.chapterA);
    await addKey("fp-2", ana, id.rootB);
    await addKey("fp-3", maria, id.rootB);
    await addKey("fp-4", memoria, id.chapterA);
    await addKey("fp-5", zed, id.rootC);
    await addMention(ana, id.chapterA, chunkA, "Ana");
    await addMention(memoria, id.chapterA, chunkA, "Memória");
    await addMention(ana, id.rootB, chunkB, "ana");
    await addMention(maria, id.rootB, chunkB, "Maria");
    await addMention(zed, id.rootC, chunkC, "Zed");
  }, 180_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool);
    if (manager) await manager.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("reads the identity rows and mentions of the roots asked for, chapters included", async () => {
    const snapshot = await readIdentitySnapshot(connectionString, {
      label: "fixture",
      rootTitles: ["Root A", "Root B"]
    });
    expect(identitySnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(snapshot.roots).toEqual(["Root A", "Root B"]);
    expect(
      snapshot.rows.map((item) => [item.fingerprint, item.root, item.type, item.name])
    ).toEqual([
      ["fp-1", "Root A", "Person", "Ana"],
      ["fp-4", "Root A", "Concept", "Memória"],
      ["fp-2", "Root B", "Person", "Ana"],
      ["fp-3", "Root B", "Person", "Maria"]
    ]);
    // Four rows, three entities: Ana folded across the two roots.
    expect(mergedEntityStatistic(snapshot.rows)).toEqual({ rows: 4, entities: 3, merged: 1 });
    expect(snapshot.mentions).toHaveLength(4);
    expect(
      snapshot.mentions.find((item) => item.chunkHash === "hash-a" && item.surface === "Ana")
    ).toMatchObject({ root: "Root A", chunkIndex: 3 });
    expect(snapshot.mentions.some((item) => item.chunkHash === "hash-c")).toBe(false);
    // Zed is in the library and keyed outside the roots: the library was not reset first.
    expect(snapshot.catalog).toEqual({ entities: 4, entitiesWithoutKeysInRoots: 1 });
  });

  it("reads each root alone, and its mentions agree with themselves", async () => {
    const a = await readIdentitySnapshot(connectionString, { label: "a", rootTitles: ["Root A"] });
    expect(mergedEntityStatistic(a.rows)).toEqual({ rows: 2, entities: 2, merged: 0 });
    expect(a.catalog.entitiesWithoutKeysInRoots).toBe(2);
    expect(partitionAgreement(a.mentions, a.mentions)).toMatchObject({
      commonMentions: 2,
      rand: 1
    });
  });

  it("refuses a title that names no root, or several", async () => {
    await expect(
      readIdentitySnapshot(connectionString, { label: "x", rootTitles: ["Root A", "Missing"] })
    ).rejects.toThrow('The library holds 0 roots titled "Missing"; expected exactly one.');
    const duplicate = randomUUID();
    await addSource(duplicate, "WebArticle", "Root B", null);
    try {
      await expect(
        readIdentitySnapshot(connectionString, { label: "x", rootTitles: ["Root B"] })
      ).rejects.toThrow('The library holds 2 roots titled "Root B"');
    } finally {
      await pool.query("delete from source_items where id = $1", [duplicate]);
    }
  });

  it("runs as the snapshot command from a connection file, then reports it", async () => {
    const connectionFile = join(workDir, "connection.json");
    await writeFile(connectionFile, JSON.stringify({ connectionString }));
    const out = join(workDir, "snapshot.json");
    const message = await runIdentityMerges([
      "snapshot",
      "--db",
      connectionFile,
      "--out",
      out,
      "--label",
      "per-batch",
      "--root-title",
      "Root A",
      "--root-title",
      "Root B"
    ]);
    expect(message).toContain("2 roots read from 127.0.0.1:");
    expect(message).toContain("4 identity rows, 3 entities, M = 1, 4 mentions");
    const written = identitySnapshotSchema.parse(JSON.parse(await readFile(out, "utf8")));
    expect(written.label).toBe("per-batch");
    const report = await runIdentityMerges(["report", "--snapshot", out, "--expect-merges", "1"]);
    expect(report).toContain("| **M, rows folded into another** | **1** |");
    expect(report).toContain("1 (equal to M)");
  });

  it("writes nothing to the database it reads", async () => {
    const before = await pool.query<{ keys: string; mentions: string; entities: string }>(
      `select (select count(*) from entity_identity_keys)::text as keys,
              (select count(*) from entity_mentions)::text as mentions,
              (select count(*) from entities)::text as entities`
    );
    await readIdentitySnapshot(connectionString, { label: "x", rootTitles: ["Root A"] });
    const after = await pool.query(
      `select (select count(*) from entity_identity_keys)::text as keys,
              (select count(*) from entity_mentions)::text as mentions,
              (select count(*) from entities)::text as entities`
    );
    expect(after.rows[0]).toEqual(before.rows[0]);
  });
});
