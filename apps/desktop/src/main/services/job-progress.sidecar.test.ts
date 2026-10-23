import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  PostgresSidecarManager,
  closePgPool,
  createJobRepository,
  createPgPool,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "@app/db";

import type { AppEvent, AppEventOf } from "../../shared/app-events.js";
import { AppEventBus } from "./app-events.js";
import { connectJobProgress } from "./job-progress.js";
import { JobSupervisor } from "./job-supervisor.js";

// F4 D26 against a real database: a state change the supervisor announces reaches the windows as
// one `job.progress` event with the counts of the table and the jobs that moved.
const workspace = resolve(import.meta.dirname, "../../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

describe.skipIf(!sidecarInstalled)("job.progress on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool | undefined;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-job-progress-"));
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_job_progress_test",
        user: "memora_job_progress_test",
        password: `job-progress-${randomUUID()}`,
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
    await runMigrations(pool, join(workspace, "packages/db/drizzle"), {
      seedFolder: join(workspace, "packages/db/seed")
    });
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool);
    await manager?.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("publishes the counts and the changed jobs once per burst of the supervisor's notices", async () => {
    const sent: AppEvent[] = [];
    const bus = new AppEventBus({ send: (event) => sent.push(event), windowMs: 30 });
    const supervisor = new JobSupervisor({ getPool: () => pool ?? null });
    const progress = connectJobProgress({
      supervisor,
      getPool: () => pool ?? null,
      publish: (event) => bus.publish(event),
      windowMs: 30
    });
    const jobs = createJobRepository(pool!);
    const last = () => sent.at(-1) as AppEventOf<"job.progress"> | undefined;

    // The first notice reads the counts and sets the cursor; it names no job.
    const first = await jobs.create({ type: "ingestion" });
    supervisor.wake();
    await vi.waitFor(() => expect(last()?.lanes.heavy.queued).toBe(1));
    expect(last()?.changedIds).toEqual([]);

    // A burst of notices after it: one more event, naming the job that moved.
    const second = await jobs.create({ type: "ingestion" });
    await supervisor.requestCancel(second.id);
    supervisor.wake();
    supervisor.wake();
    await vi.waitFor(() => expect(last()?.lanes.heavy.canceled).toBe(1));

    expect(last()?.lanes.heavy).toMatchObject({ queued: 1, canceled: 1, running: 0 });
    expect(last()?.lanes.light).toMatchObject({ queued: 0, running: 0 });
    expect(last()?.changedIds).toContain(second.id);
    expect(last()?.changedIdsTruncated).toBe(false);
    expect(sent.every((event) => event.type === "job.progress")).toBe(true);
    // The burst of notices read the table once (plus at most one read for a notice that arrived
    // while it ran), never once per notice.
    expect(sent.length).toBeLessThanOrEqual(3);
    expect(first.id).not.toBe(second.id);

    progress.dispose();
    bus.dispose();
  });
});
