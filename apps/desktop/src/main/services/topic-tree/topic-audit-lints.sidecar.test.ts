import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closePgPool,
  createGardenerFindingRepository,
  createPgPool,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "@app/db";
import { auditLintConfigWith } from "@app/domain";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { atomicNoteEmbeddingHash } from "../note-embedding-text.js";
import { AuditLints, auditCursorsSettingKey } from "./topic-audit-lints.js";
import type { AuditLintTree } from "./topic-audit-lints.js";

/**
 * The database lints of AUDIT (F4 T85, D19) alone, on a real PostgreSQL: how a scan is paced and
 * resumed from its cursor, that one lint failing leaves the others running, and when re-embedding
 * is not queued. The tree is a description of a space: the lints read notes and vectors only.
 */
const workspaceRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../../..");
const sidecarPaths = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
const sidecarAvailable = existsSync(join(sidecarPaths.binDir, "postgres"));

const tree: AuditLintTree = {
  id: randomUUID(),
  spaceKey: "audit-lints-space",
  dimensions: 256,
  embeddingModel: "audit-lints-model"
};
const axis = (angle: number): string =>
  `[${Array.from({ length: 256 }, (_, k) =>
    k === 0 ? Math.cos(angle) : k === 1 ? Math.sin(angle) : 0
  ).join(",")}]`;
const quiet = { warn: () => undefined };

describe.skipIf(!sidecarAvailable)("AUDIT's database lints on the PostgreSQL sidecar", () => {
  let workDir = "";
  let manager: PostgresSidecarManager;
  let pool: PgPool;
  let sourceId = "";
  let chunkId = "";
  let minute = 0;

  async function insertNote(title: string, angle: number | null): Promise<string> {
    const id = randomUUID();
    await pool.query(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, created_from_source_item_id,
         evidence_chunk_id, generation_provider, generation_model, generation_runtime,
         generation_prompt_version, generation_key, updated_at)
       values ($1::uuid, $2, 'Body', 'Idea', $3, $4, 'test', 'test', 'test', 'test', $1::text,
               '2026-10-20T09:00:00Z')`,
      [id, title, sourceId, chunkId]
    );
    if (angle !== null) {
      minute += 1;
      await pool.query(
        `insert into embeddings_256 (target_type, target_id, provider, model, runtime, strategy,
           content_hash, embedding, created_at)
         values ('atomic_note', $1, 'test', $2, 'none', $3, $4, $5::vector,
                 '2026-10-20T10:00:00Z'::timestamptz + make_interval(secs => $6::int))`,
        [
          id,
          tree.embeddingModel,
          `native-v2:${tree.spaceKey}`,
          atomicNoteEmbeddingHash({ title, ideaStatement: "Idea", bodyMarkdown: "Body" }),
          axis(angle),
          minute
        ]
      );
    }
    return id;
  }

  const lints = (overrides: Parameters<typeof auditLintConfigWith>[0] = {}, pool_ = () => pool) =>
    new AuditLints({ getPool: pool_, config: auditLintConfigWith(overrides), logger: quiet });
  const allowed = { spaceChanged: false, allowEmbedding: true };
  const findings = () => createGardenerFindingRepository(pool);

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-audit-lints-service-"));
    for (let attempt = 1; ; attempt += 1) {
      const candidate = new PostgresSidecarManager({
        binDir: sidecarPaths.binDir,
        dataDir: join(workDir, `database-${attempt}`),
        database: "memora_audit_lints_service",
        user: "memora_audit_lints_service",
        password: `audit-lints-${randomUUID()}`,
        startupTimeoutMs: 30_000,
        shutdownTimeoutMs: 10_000
      });
      try {
        const connection = await candidate.start();
        manager = candidate;
        pool = createPgPool({ connectionString: connection.connectionString, max: 4 });
        break;
      } catch (error) {
        await candidate.stop().catch(() => undefined);
        if (attempt >= 3) throw error;
      }
    }
    await runMigrations(pool, join(workspaceRoot, "packages/db/drizzle"), {
      seedFolder: join(workspaceRoot, "packages/db/seed")
    });
    sourceId = randomUUID();
    const documentId = randomUUID();
    chunkId = randomUUID();
    await pool.query("insert into source_items (id, type, title) values ($1, 'Book', 'Source')", [
      sourceId
    ]);
    await pool.query(
      `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
       values ($1, $2, 'Document', 'text', 'doc-hash')`,
      [documentId, sourceId]
    );
    await pool.query(
      `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
       values ($1, $2, $3, 0, 'text', 'chunk-hash')`,
      [chunkId, documentId, sourceId]
    );
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool).catch(() => undefined);
    await manager?.stop().catch(() => undefined);
    await rm(workDir, { recursive: true, force: true });
  }, 30_000);

  beforeEach(async () => {
    minute = 0;
    await pool.query("delete from jobs");
    await pool.query("delete from view_history");
    await pool.query("delete from gardener_findings");
    await pool.query("delete from settings where key = $1", [auditCursorsSettingKey]);
    await pool.query("delete from atomic_notes");
  });

  it("resumes a scan from its cursor, and asks for another audit while notes are left", async () => {
    for (let n = 0; n < 7; n += 1) await insertNote(`Note ${n}`, n * 0.4);
    const service = lints({ duplicates: { perRun: 3, batch: 2 } });
    const first = await service.run(tree, allowed);
    expect(first.duplicates).toMatchObject({ state: "done", examined: 3, exhausted: false });
    expect(first.more).toBe(true);
    const second = await service.run(tree, allowed);
    expect(second.duplicates).toMatchObject({ examined: 3, exhausted: false });
    const third = await service.run(tree, allowed);
    expect(third.duplicates).toMatchObject({ examined: 1, exhausted: true });
    expect(third.more).toBe(false);
    // Seven notes were read once each; a note embedded since is the only one the next audit reads.
    const added = await insertNote("Late note", 2.9);
    await pool.query(
      "update embeddings_256 set created_at = now() where target_id = $1 and target_type = 'atomic_note'",
      [added]
    );
    const fourth = await service.run(tree, allowed);
    expect(fourth.duplicates).toMatchObject({ examined: 1, exhausted: true });
    // Another space starts the scan over.
    const other = await service.run({ ...tree, spaceKey: "another" }, allowed);
    expect(other.duplicates).toMatchObject({ examined: 0 });
  });

  it("stops a scan after the batch that reached the findings it may record at once", async () => {
    // Ten pairs of identical notes, one pair per batch of two.
    for (let n = 0; n < 10; n += 1) {
      await insertNote(`Pair ${n} first`, n * 0.3);
      await insertNote(`Pair ${n} second`, n * 0.3);
    }
    const service = lints({ duplicates: { batch: 2, findingsPerRun: 3, perRun: 100 } });
    const first = await service.run(tree, allowed);
    expect(first.duplicates.pairs).toBeGreaterThanOrEqual(3);
    expect(first.duplicates.pairs).toBeLessThan(10);
    expect(first.duplicates.exhausted).toBe(false);
    expect(first.more).toBe(true);
    let rounds = 0;
    for (let again = first; again.more && rounds < 20; rounds += 1) {
      again = await service.run(tree, allowed);
    }
    expect((await findings().counts()).duplicate).toBe(10);
  });

  it("leaves the other lints running when one fails, and says which", async () => {
    await insertNote("Alone", 0.1);
    const real = pool;
    const failing = new Proxy(real, {
      get(target, property, receiver) {
        if (property === "query") {
          return (text: string, values?: unknown[]) => {
            if (typeof text === "string" && text.includes("from view_history")) {
              return Promise.reject(new Error("the recents are unreadable"));
            }
            return target.query(text, values);
          };
        }
        const value = Reflect.get(target, property, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      }
    });
    const report = await lints({}, () => failing).run(tree, allowed);
    expect(report.brokenLinks).toEqual({ state: "failed", error: "the recents are unreadable" });
    expect(report.duplicates).toMatchObject({ state: "done" });
    expect(report.staleEmbeddings).toMatchObject({ state: "done" });
  });

  it("queues no re-embedding in a deterministic run or while the space moves", async () => {
    await insertNote("No vector", null);
    const service = lints();
    const deterministic = await service.run(tree, { spaceChanged: false, allowEmbedding: false });
    expect(deterministic.staleEmbeddings).toEqual({ state: "off", reason: "deterministic" });
    const moving = await service.run(tree, { spaceChanged: true, allowEmbedding: true });
    expect(moving.staleEmbeddings).toEqual({ state: "off", reason: "space_changed" });
    const queuedNone = await pool.query("select 1 from jobs where type = 'note-embedding'");
    expect(queuedNone.rowCount).toBe(0);
    const allowedRun = await service.run(tree, allowed);
    expect(allowedRun.staleEmbeddings).toMatchObject({ state: "done", missing: 1, queued: 1 });
  });

  it("queues at most the re-embeddings one audit may, and the next audit takes the rest", async () => {
    for (let n = 0; n < 5; n += 1) await insertNote(`Bare ${n}`, null);
    const service = lints({ staleEmbeddings: { perRun: 2 } });
    const first = await service.run(tree, allowed);
    expect(first.staleEmbeddings).toMatchObject({ queued: 2, missing: 2 });
    expect(first.more).toBe(true);
    const second = await service.run(tree, allowed);
    expect(second.staleEmbeddings).toMatchObject({ queued: 2 });
    const third = await service.run(tree, allowed);
    expect(third.staleEmbeddings).toMatchObject({ queued: 1, deferred: 0 });
    expect(third.more).toBe(false);
    const jobs = await pool.query("select 1 from jobs where type = 'note-embedding'");
    expect(jobs.rowCount).toBe(5);
  });

  it("records unfixable redirects as findings and resolves them once they are gone", async () => {
    const service = lints();
    const topic = randomUUID();
    const finding = {
      kind: "redirect_chain" as const,
      fingerprint: `redirect:${topic}`,
      objectRefs: [`memora://topic/${topic}`],
      params: { reason: "cycle", hops: 2 },
      risk: "medium" as const
    };
    expect(await service.recordRedirectFindings([finding])).toMatchObject({
      unresolved: 1,
      created: 1,
      resolved: 0
    });
    expect(await service.recordRedirectFindings([finding])).toMatchObject({
      created: 0,
      unchanged: 1
    });
    expect(await service.recordRedirectFindings([])).toMatchObject({ unresolved: 0, resolved: 1 });
    expect((await findings().counts()).redirect_chain).toBeUndefined();
  });
});
