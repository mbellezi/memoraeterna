import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { defaultAuditLintConfig } from "@app/domain";
import {
  canonicalStateDump,
  compressRedirects,
  createTopicTreeEditor,
  createTopicTreeState,
  getTopic,
  planRedirectCompression,
  topicRecordOf
} from "@app/domain/topic-tree";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { closePgPool, createPgPool, type PgPool } from "../client.js";
import { runMigrations } from "../migrations.js";
import { PostgresSidecarManager, resolvePostgresSidecarPaths } from "../sidecar/index.js";
import { addressTargets, formatObjectAddress } from "@app/domain";
import { createAuditLintRepository } from "./auditLintRepository.js";
import { topicDiffNodes } from "./changeSetRepository.js";
import { createTopicTreeRepository, topicTreeRecordsDump } from "./topicTreeRepository.js";

/**
 * Redirect chains compressed through the engine (F4 T85, D19 (2)) on a real PostgreSQL: a retired
 * topic is re-pointed at the live topic its chain ends at, as one change-set of structure events
 * the repository checks against the stored rows, with an exact undo. The re-point is a `topic.retire`
 * of a retired topic, so the vocabulary of `topic_structure_events.op` (and its check) is unchanged.
 */
const workspace = resolve(import.meta.dirname, "../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

const uuidOf = (n: number): string => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const rootId = uuidOf(0);
const [a, b, c, d, e, f] = [1, 2, 3, 4, 5, 6].map(uuidOf) as [
  string,
  string,
  string,
  string,
  string,
  string
];
const at = "2026-10-20T12:00:00.000Z";

describe.skipIf(!sidecarInstalled)("redirect compression on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool | undefined;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-redirects-"));
    manager = new PostgresSidecarManager({
      binDir: sidecar.binDir,
      dataDir: join(workDir, "data"),
      database: "memora_redirects",
      user: "memora_redirects",
      password: `redirects-${randomUUID()}`,
      startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 10_000
    });
    const connection = await manager.start();
    pool = createPgPool({ connectionString: connection.connectionString, max: 4 });
    await runMigrations(pool, join(workspace, "packages/db/drizzle"), {
      seedFolder: join(workspace, "packages/db/seed")
    });
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool);
    if (manager) await manager.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("re-points the chain, keeps the vocabulary of events and undoes exactly", async () => {
    const repo = createTopicTreeRepository(pool!);
    const state = createTopicTreeState({ dim: 4, rootId });
    const builder = createTopicTreeEditor(state, { record: false });
    for (const id of [a, b, c, d, e, f]) builder.createTopic(id, rootId);
    const tree = await repo.createTree({
      rootId,
      spaceKey: "local:test:256",
      embeddingProvider: "test",
      embeddingModel: "test",
      embeddingRuntime: "none",
      dimensions: 256,
      config: {},
      configHash: "hash",
      seed: 1
    });
    const built = await repo.bootstrapSnapshot({
      treeId: tree.id,
      expectedGeneration: 0,
      titleKey: "topics.changeSets.build",
      topics: [a, b, c, d, e, f].map((id) => topicRecordOf(getTopic(state, id))),
      placements: []
    });
    expect(built).toMatchObject({ kind: "applied", generation: 1 });
    const dump = async () => topicTreeRecordsDump(await repo.readTreeRecords(tree.id));

    // Merges that leave a -> b -> c -> d and e -> d: each one retires its topic into the next.
    const merges = createTopicTreeEditor(state);
    merges.retireTopic(c, d, at);
    merges.retireTopic(b, c, at);
    merges.retireTopic(a, b, at);
    merges.retireTopic(e, d, at);
    // A topic retired with no successor is a dead end, not a chain.
    merges.retireTopic(f, null, at);
    const merged = await repo.applyChangeSet({
      treeId: tree.id,
      expectedGeneration: 1,
      origin: "rebalance",
      titleKey: "topics.changeSets.rebalance",
      events: merges.events
    });
    expect(merged).toMatchObject({ kind: "applied", generation: 2 });
    expect(await dump()).toBe(canonicalStateDump(state));

    const plan = planRedirectCompression(state, defaultAuditLintConfig);
    expect(plan.chains.map((chain) => [chain.topicId, chain.to])).toEqual([
      [a, d],
      [b, d]
    ]);
    const events = compressRedirects(state, plan.chains);
    const compressed = await repo.applyChangeSet({
      treeId: tree.id,
      expectedGeneration: 2,
      origin: "audit",
      titleKey: "topics.changeSets.redirects",
      titleParams: { topics: events.length },
      risk: "low",
      events
    });
    // A redirect moves no member and no child: no statistic is marked for a recompute.
    expect(compressed).toMatchObject({
      kind: "applied",
      generation: 3,
      events: 2,
      dirtyTopicIds: []
    });
    expect(await dump()).toBe(canonicalStateDump(state));
    const stored = await pool!.query<{ id: string; redirect_to: string; retired: boolean }>(
      `select id, redirect_to, retired_at is not null as retired from topics
        where id = any($1::uuid[]) order by id`,
      [[a, b, c, e]]
    );
    expect(stored.rows).toEqual([
      { id: a, redirect_to: d, retired: true },
      { id: b, redirect_to: d, retired: true },
      { id: c, redirect_to: d, retired: true },
      { id: e, redirect_to: d, retired: true }
    ]);
    // Written with the op the table already knows, and nothing but the redirect changed.
    const ops = await pool!.query<{ op: string; before: unknown; after: unknown }>(
      `select op, before, after from topic_structure_events
        where change_set_id = $1 order by seq`,
      [compressed.kind === "applied" ? compressed.changeSetId : ""]
    );
    expect(ops.rows.map((row) => row.op)).toEqual(["topic.retire", "topic.retire"]);
    expect(ops.rows[0]).toMatchObject({
      before: { retiredAt: at, redirectTo: b },
      after: { retiredAt: at, redirectTo: d }
    });
    // The links to those topics resolve through the redirects, and a dead end does not.
    const targets = addressTargets(
      [a, b, c, e, f, uuidOf(77)].map((id) => ({
        address: formatObjectAddress({ kind: "topic", id }),
        role: "entry" as const
      }))
    );
    const resolutions = await createAuditLintRepository(pool!).addressResolutions(targets, 64);
    const resolution = (id: string) => resolutions.get(formatObjectAddress({ kind: "topic", id }));
    expect([a, b, c, e].map(resolution)).toEqual(["ok", "ok", "ok", "ok"]);
    expect(resolution(f)).toBe("no_successor");
    expect(resolution(uuidOf(77))).toBe("missing");
    // A retired topic that was re-pointed is no removal in the change-set's diff.
    const diff = topicDiffNodes(
      ops.rows.map((row, index) => ({
        op: row.op,
        topicId: index === 0 ? a : b,
        before: row.before as Record<string, unknown>,
        after: row.after as Record<string, unknown>
      })),
      [],
      new Map()
    );
    expect(diff.nodes.map((node) => node.change)).toEqual(["changed", "changed"]);

    // A stale re-point (the stored redirect is no longer the one the event names) is refused.
    const refused = await repo.applyChangeSet({
      treeId: tree.id,
      expectedGeneration: 3,
      origin: "audit",
      titleKey: "topics.changeSets.redirects",
      events: [
        {
          op: "topic.retire",
          topicId: a,
          before: { retiredAt: at, redirectTo: b },
          after: { retiredAt: at, redirectTo: e }
        }
      ]
    });
    expect(refused).toMatchObject({ kind: "conflict", reason: "event" });
    expect(await dump()).toBe(canonicalStateDump(state));

    const undone = await repo.undoChangeSet({
      treeId: tree.id,
      changeSetId: compressed.kind === "applied" ? compressed.changeSetId : "",
      expectedGeneration: 3,
      titleKey: "topics.changeSets.undo"
    });
    expect(undone).toMatchObject({ kind: "applied", generation: 4 });
    const restored = await pool!.query<{ id: string; redirect_to: string }>(
      "select id, redirect_to from topics where id = any($1::uuid[]) order by id",
      [[a, b, c, e]]
    );
    expect(restored.rows).toEqual([
      { id: a, redirect_to: b },
      { id: b, redirect_to: c },
      { id: c, redirect_to: d },
      { id: e, redirect_to: d }
    ]);
    // The chain can be compressed again after the undo.
    const records = await repo.readTreeRecords(tree.id);
    expect(records.topics.find((topic) => topic.id === a)?.redirectTo).toBe(b);
  });
});
