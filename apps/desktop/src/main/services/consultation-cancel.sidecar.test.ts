import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  PostgresSidecarManager,
  closePgPool,
  createPgPool,
  resolvePostgresSidecarPaths,
  type PgPool
} from "@app/db";

import { consultationSnapshot } from "./consultation-fixture.js";
import { ConsultationService } from "./consultation-service.js";

// Canceling an Ask while its statement runs, through the real service and a real PostgreSQL
// database: the retrieval below is one slow statement (`pg_sleep`) on the Ask's own queries, so the
// cancel has to find that statement by its marker and stop it, not wait for it to end.
const sourceId = "00000000-0000-4000-8000-00000000000a";
vi.mock("@app/db", async (original) => {
  const db = await original<typeof import("@app/db")>();
  return {
    ...db,
    createConsultationRepository: (queries: { query(text: string): Promise<unknown> }) => ({
      candidates: async () => {
        await queries.query("select pg_sleep(30)");
        return [];
      },
      vector: async () => []
    }),
    createKnowledgeConsultationRepository: () => ({ scope: async () => [sourceId] })
  };
});

const workspace = resolve(import.meta.dirname, "../../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

describe.skipIf(!sidecarInstalled)("canceling an Ask on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool;
  const runOrganizationTask = vi.fn();
  const activeMarked = async () =>
    (
      await pool.query<{ n: string }>(
        `select count(*) as n from pg_stat_activity
          where datname = current_database() and state = 'active' and starts_with(query, '/* ask:')`
      )
    ).rows[0]!.n;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-ask-cancel-"));
    // Parallel test files pick free ports the same way; a lost race needs only a fresh attempt.
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_ask_cancel_test",
        user: "memora_ask_cancel_test",
        password: `ask-cancel-${randomUUID()}`,
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
    pool = createPgPool({ connectionString: connection.connectionString, max: 4 });
  }, 60_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool);
    await manager?.stop();
    if (workDir) await rm(workDir, { recursive: true, force: true });
  }, 30_000);

  it("ends a question as canceled in well under a second, with no statement left running", async () => {
    const ask = new ConsultationService({
      getPool: () => pool,
      ai: {
        pinOrganizationProfile: vi.fn(async () => consultationSnapshot().profile),
        runOrganizationTask,
        runConsultationEmbedding: vi.fn(async () => null)
      } as never,
      contentLanguage: async () => "en"
    });
    const requestId = randomUUID();
    const settled = ask
      .ask({ requestId, question: "Does retrieval practice help?" } as never)
      .catch((error: unknown) => error);
    await expect.poll(activeMarked, { interval: 20, timeout: 5_000 }).toBe("1");
    const started = Date.now();
    await ask.cancel(requestId);
    const failure = await settled;
    expect((failure as Error).message).toBe("consultation.errors.canceled");
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(runOrganizationTask).not.toHaveBeenCalled();
    await expect(activeMarked()).resolves.toBe("0");
    // The connection the statement used goes back with no setting changed.
    const sessions = await Promise.all(
      [1, 2, 3, 4].map(() => pool.query<{ statement_timeout: string }>("show statement_timeout"))
    );
    expect(sessions.map((result) => result.rows[0]!.statement_timeout)).toEqual([
      "0",
      "0",
      "0",
      "0"
    ]);
  });
});
