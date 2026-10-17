import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closePgPool, createPgPool, type PgPool } from "../client.js";
import { runMigrations } from "../migrations.js";
import { createAtomicNoteRelationRepository } from "../repositories/atomicNoteRelationRepository.js";
import { PostgresSidecarManager, resolvePostgresSidecarPaths } from "../sidecar/index.js";
import {
  legacyRelationShapes,
  migrationsBefore,
  relationsV2Tag,
  seedLegacyLibrary,
  verifyExistingDatabase,
  verifyPendingPath
} from "./verify-relations-v2.js";

// Migration 0056 as a pending migration on a library at 0055: the direction backfill on synthetic
// rows of every metadata shape, untouched metadata, statuses and types, and equal current source
// evidence under the facts-only fingerprint (`npm run db:relations:verify` adds the constraints,
// the baseline path and a killed migration). Gate M's `--db` mode on a database at 0055 with later
// migrations pending (T47's and T49's arrive after 0056), then on the migrated database.
const workspace = resolve(import.meta.dirname, "../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

describe.skipIf(!sidecarInstalled)(
  "migration 0056 relations_v2 on a real PostgreSQL database",
  () => {
    let workDir = "";
    let manager: PostgresSidecarManager | undefined;
    let pool: PgPool | undefined;
    let connectionString = "";
    const extra: PgPool[] = [];
    const urlOf = (name: string) => {
      const url = new URL(connectionString);
      url.pathname = `/${name}`;
      return url.toString();
    };
    /** A new empty database of the test cluster. */
    async function database(name: string): Promise<PgPool> {
      await pool!.query(`create database ${name}`);
      const created = createPgPool({ connectionString: urlOf(name), max: 3 });
      extra.push(created);
      return created;
    }
    /** The repository's migrations plus one more after the last, as T47 and T49 add. */
    async function migrationsWithLater(): Promise<string> {
      const folder = join(workDir, "drizzle-with-later");
      await cp(resolve(workspace, "packages/db/drizzle"), folder, { recursive: true });
      const journalPath = join(folder, "meta/_journal.json");
      const journal = JSON.parse(await readFile(journalPath, "utf8")) as {
        entries: Array<{ idx: number; when: number; tag: string }>;
      };
      const last = journal.entries.at(-1)!;
      journal.entries.push({ ...last, idx: last.idx + 1, when: last.when + 1, tag: "9999_later" });
      await writeFile(journalPath, JSON.stringify(journal));
      await writeFile(
        join(folder, "9999_later.sql"),
        'CREATE TABLE "verify_later" ("id" integer);'
      );
      return folder;
    }

    beforeAll(async () => {
      workDir = await mkdtemp(join(tmpdir(), "memora-relations-v2-test-"));
      let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
      for (let attempt = 1; !connection; attempt += 1) {
        manager = new PostgresSidecarManager({
          binDir: sidecar.binDir,
          dataDir: join(workDir, `data-${attempt}`),
          database: "memora_relations_v2_test",
          user: "memora_relations_v2_test",
          password: `relations-v2-${randomUUID()}`,
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
      pool = createPgPool({ connectionString, max: 3 });
    }, 60_000);

    afterAll(async () => {
      for (const created of extra) await closePgPool(created).catch(() => undefined);
      if (pool) await closePgPool(pool);
      if (manager) await manager.stop().catch(() => undefined);
      if (workDir) await rm(workDir, { recursive: true, force: true });
    });

    it("backfills the direction of every metadata shape and keeps current evidence current", async () => {
      const { evidence, counts } = await verifyPendingPath(pool!, workDir);
      expect(counts.relations).toBe(legacyRelationShapes.length);
      expect(counts.unknown).toBe(
        legacyRelationShapes.filter((shape) => shape.expected === "unknown").length
      );
      expect(counts.swapped).toBe(
        legacyRelationShapes.filter((shape) => shape.storedHighToLow).length
      );
      expect(evidence.report).toMatchObject({
        current_evidence_lost: 0,
        metadata_direction_disagreements: 0
      });
      expect(evidence.report.current_evidence_after).toBe(evidence.report.current_evidence_before);
    }, 60_000);

    it("keeps the pending path when later migrations follow 0056", async () => {
      const db = await database("relations_v2_pending_later");
      const { counts } = await verifyPendingPath(db, workDir, await migrationsWithLater());
      expect(counts.relations).toBe(legacyRelationShapes.length);
      expect((await db.query("select to_regclass('verify_later')::text as t")).rows[0]).toEqual({
        t: "verify_later"
      });
    }, 60_000);

    it("migrates a restore at 0055 with later migrations pending, then checks it as migrated (gate M)", async () => {
      const later = await migrationsWithLater();
      const db = await database("relations_v2_existing");
      await runMigrations(db, await migrationsBefore(workDir, relationsV2Tag, "existing", later));
      const library = await seedLegacyLibrary(db);
      const migrated = await verifyExistingDatabase(urlOf("relations_v2_existing"), later);
      expect(migrated).toMatchObject({ migrated: true, report: { current_evidence_lost: 0 } });
      expect(migrated.history.after).toBe(migrated.history.total);
      expect(migrated.history.before).toBe(migrated.history.total - 2);
      expect(migrated.counts?.relations).toBe(legacyRelationShapes.length);
      expect(migrated.invariants).toMatchObject({
        automaticEventsOnReviewed: 0,
        bandedWithoutEvent: 0,
        vetoedWithoutEvent: 0
      });
      expect((await db.query("select to_regclass('verify_later')::text as t")).rows[0]).toEqual({
        t: "verify_later"
      });

      // Already migrated: the state is checked, nothing is applied.
      const repeat = await verifyExistingDatabase(urlOf("relations_v2_existing"), later);
      expect(repeat).toMatchObject({ migrated: false, counts: null, report: null });
      // A relations v2 write through the canonical upsert carries its event (I-R8).
      const run = (
        await db.query<{ id: string }>(
          "insert into relation_match_runs (kind) values ('link') returning id"
        )
      ).rows[0]!.id;
      const directed = library.relations.find(
        (relation) => relation.shape.name === "directed, decided lo -> hi"
      )!;
      const typed = await createAtomicNoteRelationRepository(db).upsertDecided({
        subjectAtomicNoteId: directed.lo,
        objectAtomicNoteId: directed.hi,
        relationType: "extends",
        band: "apply",
        probability: 0.9,
        finalScore: 0.9,
        explanation: "x",
        runId: run
      });
      expect(typed.change).toBe("updated");
      expect(
        (await verifyExistingDatabase(urlOf("relations_v2_existing"), later)).invariants
          .bandedWithoutEvent
      ).toBe(0);
      // A banded row without its event, or an automatic event on a reviewed pair, fails the gate.
      const accepted = library.relations.find((relation) => relation.shape.status === "accepted")!;
      await db.query("delete from relation_events where relation_id = $1", [typed.relation.id]);
      await expect(verifyExistingDatabase(urlOf("relations_v2_existing"), later)).rejects.toThrow(
        "I-R8: bandedWithoutEvent"
      );
      await db.query(
        `insert into relation_events (run_id, relation_kind, relation_id, pair_key, kind, before, after)
         select $1, 'note', r.id, 'pair', 'typed', to_jsonb(r), to_jsonb(r)
           from atomic_note_relations r where r.id in ($2, $3)`,
        [run, accepted.id, typed.relation.id]
      );
      await expect(verifyExistingDatabase(urlOf("relations_v2_existing"), later)).rejects.toThrow(
        "I-R2, I-R3: automaticEventsOnReviewed"
      );

      // A database before 0055 is refused: 0056 must follow 0055.
      const old = await database("relations_v2_too_old");
      const at0055 = await migrationsBefore(workDir, relationsV2Tag, "too-old-0055", later);
      const tags = JSON.parse(await readFile(join(at0055, "meta/_journal.json"), "utf8")).entries;
      await runMigrations(
        old,
        await migrationsBefore(workDir, tags.at(-1).tag, "too-old-0054", later)
      );
      await expect(verifyExistingDatabase(urlOf("relations_v2_too_old"), later)).rejects.toThrow(
        "needs at least"
      );
    }, 120_000);
  }
);
