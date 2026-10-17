import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  PostgresSidecarManager,
  closePgPool,
  createPgPool,
  createRelationTypingRepository,
  relationDecisionPair,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "@app/db";

import {
  typeRelationPairs,
  type RelationTypingDeps,
  type TyperRoute,
  type TypingNote
} from "./relation-typing.js";

// The typing step against the real typing cache (`relation_typings`): every type the contract can
// answer, a veto, a symmetric type and both directions pass the table's CHECK, a stored verdict is
// reused with no call while both notes' hashes hold, and a changed note is typed again.
const workspace = resolve(import.meta.dirname, "../../../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

const route: TyperRoute = {
  lane: "remote",
  provider: "openai-codex",
  modelId: "gpt-test",
  runtime: "remote",
  repository: null,
  revision: null,
  quantization: null,
  parameters: { reasoningLevel: "off" }
};

const note = (title: string): TypingNote => {
  const text = `${title}\nIdea of ${title}`;
  return { id: randomUUID(), text, hash: createHash("sha256").update(text).digest("hex") };
};

describe.skipIf(!sidecarInstalled)("relation typing on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool | undefined;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-relation-typing-"));
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_relation_typing_test",
        user: "memora_relation_typing_test",
        password: `relation-typing-${randomUUID()}`,
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

  it("caches typed and vetoed verdicts under the typer key and reuses them with no call", async () => {
    const db = pool!;
    const run = (
      await db.query<{ id: string }>(
        `insert into ai_task_runs (task_type, provider, model_id, runtime, duration_ms, status, finished_at)
         values ('structured-output', 'verify', 'verify-model', 'remote', 1, 'succeeded', now()) returning id`
      )
    ).rows[0]!.id;
    const answers: Record<string, { t: string; d: string }> = {
      Supports: { t: "supports", d: "ab" },
      Contradicts: { t: "contradicts", d: "both" },
      Extends: { t: "extends", d: "ba" },
      Depends: { t: "depends_on", d: "ab" },
      Example: { t: "example_of", d: "ba" },
      Clarifies: { t: "clarifies", d: "ab" },
      Same: { t: "same_as", d: "both" },
      Vetoed: { t: "none", d: "none" }
    };
    const pairs = Object.keys(answers).map((name) => ({
      first: note(`${name} left`),
      second: note(`${name} right`),
      band: "apply" as const
    }));
    const runDefaultTask = vi.fn(async (_task: string, prompt: string) => {
      const wire = JSON.parse(/PAIRS:\n(\[.*\])/u.exec(prompt)![1]!) as Array<{
        p: string;
        a: string;
      }>;
      return {
        taskType: "structured-output" as const,
        output: {
          pairs: wire.map((entry) => ({ p: entry.p, ...answers[entry.a.split(" ")[0]!]! }))
        },
        providerId: "openai-codex" as const,
        modelId: "gpt-test",
        runtime: "remote" as const,
        durationMs: 1,
        profileId: randomUUID(),
        aiTaskRunId: run,
        outputLanguage: "en"
      };
    });
    const deps: RelationTypingDeps = {
      ai: { runDefaultTask } as unknown as RelationTypingDeps["ai"],
      store: createRelationTypingRepository(db),
      resolveRoute: async () => route
    };

    const first = await typeRelationPairs(deps, pairs);
    expect(runDefaultTask).toHaveBeenCalledTimes(1);
    expect(first.pairs.size).toBe(8);
    expect([...first.pairs.values()].every((entry) => entry.outcome.kind !== "untyped")).toBe(true);

    const stored = (
      await db.query<{ pair_key: string; relation_type: string; direction: string | null }>(
        "select pair_key, relation_type, direction from relation_typings where typer_key = $1",
        [first.typerKey]
      )
    ).rows;
    expect(stored).toHaveLength(8);
    const byType = Object.fromEntries(stored.map((row) => [row.relation_type, row.direction]));
    expect(byType.contradicts).toBe("symmetric");
    expect(byType.same_as).toBe("symmetric");
    expect(byType.none).toBeNull();
    for (const type of ["supports", "extends", "depends_on", "example_of", "clarifies"])
      expect(["lo_to_hi", "hi_to_lo"]).toContain(byType[type]);

    // "ab" makes the note shown first the subject: it is the lower or the higher ID.
    const supports = pairs[0]!;
    const { lo } = relationDecisionPair(supports.first.id, supports.second.id);
    const supportsRow = stored.find((row) => row.relation_type === "supports")!;
    const subjectIsLo =
      supports.first.text < supports.second.text
        ? supports.first.id === lo
        : supports.second.id === lo;
    expect(supportsRow.direction).toBe(subjectIsLo ? "lo_to_hi" : "hi_to_lo");

    // The same pairs again: every verdict, the veto included, is served from the table.
    const again = await typeRelationPairs(deps, pairs);
    expect(runDefaultTask).toHaveBeenCalledTimes(1);
    expect(again.cacheHits).toBe(8);
    expect(again.calls).toBe(0);
    expect(
      [...again.pairs.values()]
        .map((entry) => entry.outcome)
        .filter((outcome) => outcome.kind === "none")
    ).toHaveLength(1);

    // An edited note changes its hash: only its pair is typed again.
    const edited = note("Supports left edited");
    const changed = { ...pairs[0]!, first: { ...edited, id: pairs[0]!.first.id } };
    await typeRelationPairs(deps, [changed, ...pairs.slice(1)]);
    expect(runDefaultTask).toHaveBeenCalledTimes(2);
    const lastPrompt = runDefaultTask.mock.calls[1]![1];
    expect(JSON.parse(/PAIRS:\n(\[.*\])/u.exec(lastPrompt)![1]!)).toHaveLength(1);
  });
});
