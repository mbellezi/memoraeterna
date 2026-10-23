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
  runMigrations,
  type PgPool
} from "@app/db";
import type { KnowledgeGraphGenerationOutput } from "@app/domain";

import type { DefaultAiTaskResult } from "./ai-service.js";
import { createEntityIdentityResolver } from "./entity-identity-resolution.js";

// Entity identity grouped per source (F4 D20) against the real catalog: one group spans batches with
// batch-namespaced keys, and a crash between groups resumes from `entity_identity_keys`.
const workspace = resolve(import.meta.dirname, "../../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

describe.skipIf(!sidecarInstalled)("grouped entity identity on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool | undefined;
  const sourceItemId = randomUUID();

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-identity-groups-"));
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_identity_groups_test",
        user: "memora_identity_groups_test",
        password: `identity-groups-${randomUUID()}`,
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
    await pool.query(
      "insert into source_items (id, type, title) values ($1, 'PersonalNote', 'Analytical engine')",
      [sourceItemId]
    );
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool);
    await manager?.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  const chunks = [randomUUID(), randomUUID(), randomUUID()];
  const person = (key: string, name: string, batch: number) => ({
    key,
    type: "Person" as const,
    canonicalName: name,
    aliases: [],
    identityDescription: `${name}, who worked on the Analytical Engine.`,
    confidence: 0.9,
    evidenceChunkIds: [chunks[batch]!]
  });
  // Ada appears in three batches; the model's keys repeat across batches.
  const batches = (): KnowledgeGraphGenerationOutput[] => [
    { entities: [person("e1", "Ada Lovelace", 0)], relations: [] },
    {
      entities: [person("e1", "Charles Babbage", 1), person("e2", "Ada Lovelace", 1)],
      relations: []
    },
    { entities: [person("e1", "Ada Lovelace", 2)], relations: [] }
  ];
  /** Embeds each text on its own axis and confirms every row with its first candidate. */
  const writer = (failOnCall?: number) => {
    const axes = new Map<string, number>();
    let calls = 0;
    const runDefaultTask = vi.fn(
      async (task: string, input: string): Promise<DefaultAiTaskResult> => {
        const base = {
          providerId: "test",
          modelId: "model",
          runtime: "remote" as const,
          durationMs: 1,
          aiTaskRunId: randomUUID(),
          profileId: randomUUID(),
          outputLanguage: "en"
        };
        if (task === "embedding") {
          if (!axes.has(input)) axes.set(input, axes.size);
          const vector = Array<number>(256).fill(0);
          vector[axes.get(input)!] = 1;
          return { ...base, taskType: "embedding", output: vector, embeddingSpaceKey: "space" };
        }
        if (++calls === failOnCall) throw new Error("provider_unavailable");
        const rows = JSON.parse(input.split("\n").at(-1)!).relations as Array<
          [string, string, string, string[]]
        >;
        return {
          ...base,
          taskType: "knowledge-graph-generation",
          output: { matches: rows.map((row) => [row[0], row[3][0] ?? null]) }
        };
      }
    );
    return {
      runDefaultTask,
      generative: () => runDefaultTask.mock.calls.filter(([task]) => task !== "embedding")
    };
  };
  const resolver = (ai: ReturnType<typeof writer>) =>
    createEntityIdentityResolver({
      pool: pool!,
      ai,
      threshold: 0.92,
      language: "en",
      context: { sourceItemId },
      // One row per call, so the source takes two groups.
      group: { maxRows: 1, maxCharacters: 24_000 }
    });

  it("commits a group across batches and resumes after a crash between groups", async () => {
    const first = writer(2);
    await expect(resolver(first)(batches())).rejects.toThrow("provider_unavailable");
    // The first group (both batches' Adas and Charles) is stored; the third batch is not.
    const keys = async () =>
      (
        await pool!.query<{ fingerprint: string; entityId: string }>(
          `select fingerprint, entity_id::text as "entityId" from entity_identity_keys
           where source_item_id = $1`,
          [sourceItemId]
        )
      ).rows;
    expect(await keys()).toHaveLength(3);

    const retry = writer();
    const resolved = await resolver(retry)(batches());
    expect(retry.generative()).toHaveLength(1);
    const stored = await keys();
    expect(stored).toHaveLength(4);
    // M = rows - distinct entities: the three Adas are one entity.
    expect(stored.length - new Set(stored.map((row) => row.entityId)).size).toBe(2);
    const ada = resolved[0]!.entities[0]!.canonicalEntityId;
    expect(resolved[1]!.entities[1]!.canonicalEntityId).toBe(ada);
    expect(resolved[2]!.entities[0]!.canonicalEntityId).toBe(ada);
    expect(resolved[1]!.entities[0]!.canonicalEntityId).not.toBe(ada);
  });
});
