import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closePgPool, createPgPool, type PgPool } from "../client.js";
import { PostgresSidecarManager, resolvePostgresSidecarPaths } from "../sidecar/index.js";
import { legacyRelationShapes, verifyPendingPath } from "./verify-relations-v2.js";

// Migration 0056 as a pending migration on a library at 0055: the direction backfill on synthetic
// rows of every metadata shape, untouched metadata, statuses and types, and equal current source
// evidence under the facts-only fingerprint (`npm run db:relations:verify` adds the constraints,
// the baseline path and a killed migration).
const workspace = resolve(import.meta.dirname, "../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

describe.skipIf(!sidecarInstalled)(
  "migration 0056 relations_v2 on a real PostgreSQL database",
  () => {
    let workDir = "";
    let manager: PostgresSidecarManager | undefined;
    let pool: PgPool | undefined;

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
      pool = createPgPool({ connectionString: connection.connectionString, max: 3 });
    }, 60_000);

    afterAll(async () => {
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
  }
);
