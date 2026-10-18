import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import {
  PostgresSidecarManager,
  closePgPool,
  createAiConfigRepository,
  createAtomicNoteRelationRepository,
  createPgPool,
  createRelationMatchRunRepository,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "@app/db";

import { findRealRemoteRoutes, startFakeRemote, explanationRoute } from "./fake-remote-install.js";
import { readSoakPlan } from "./soak-plan.js";
import {
  forgetExplanations,
  pickEditableNote,
  pickQuestionTitle,
  pickRelationsToExplain,
  readJobs,
  readTaskRuns
} from "./soak-queries.js";
import { MemoryEventSink, taskRunRecordSchema } from "./soak-records.js";

// The soak's SQL and the installation of its fake providers on a real PostgreSQL database with the
// product's schema (F3 T62): what the driver picks and the collector reads must run as written.
const workspace = resolve(import.meta.dirname, "../../../../../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

describe.skipIf(!sidecarInstalled)("the soak on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool | undefined;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-soak-"));
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_soak_test",
        user: "memora_soak_test",
        password: `soak-${randomUUID()}`,
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

  beforeEach(async () => {
    const db = pool!;
    await db.query("delete from atomic_note_relation_explanations");
    await db.query("delete from relation_events");
    await db.query("delete from relation_match_runs");
    await db.query("delete from atomic_note_relations");
    await db.query("delete from jobs");
  });

  const seedNote = async (title: string, status = "active") => {
    const db = pool!;
    const sourceId = randomUUID(),
      documentId = randomUUID(),
      chunkId = randomUUID(),
      id = randomUUID();
    await db.query(`insert into source_items (id, type, title) values ($1, 'PersonalNote', $2)`, [
      sourceId,
      title
    ]);
    await db.query(
      `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
       values ($1, $2, $3, 'seed', $4)`,
      [documentId, sourceId, title, `hash-${documentId}`]
    );
    await db.query(
      `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
       values ($1, $2, $3, 0, $4, $5)`,
      [chunkId, documentId, sourceId, `${title} passage.`, `chunk-${chunkId}`]
    );
    await db.query(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, status,
         supersession_status, ownership, created_from_source_item_id, owning_source_item_id,
         evidence_chunk_id, generation_provider, generation_model, generation_runtime,
         generation_prompt_version, generation_key)
       values ($1, $2, $3, $4, $6, 'current', 'source', $5, $5, $7, 'seed', 'seed', 'local', 'seed', $8)`,
      [id, title, `${title} body.`, `${title} idea.`, sourceId, status, chunkId, `key-${id}`]
    );
    return { id, sourceId };
  };

  const seedRelation = async (titles: [string, string]) => {
    const seeded = [await seedNote(titles[0]), await seedNote(titles[1])].sort((a, b) =>
      a.id < b.id ? -1 : 1
    );
    const run = await createRelationMatchRunRepository(pool!).start({ kind: "match" });
    const written = await createAtomicNoteRelationRepository(pool!).upsert({
      loAtomicNoteId: seeded[0]!.id,
      hiAtomicNoteId: seeded[1]!.id,
      direction: "lo_to_hi",
      relationType: "supports",
      band: "apply",
      finalScore: 0.9,
      explanation: "knowledge.relations.explanations.reranked",
      runId: run.id
    });
    return written.relation.id;
  };

  it("picks the relations without an explanation first, and forgets explanations to ask again", async () => {
    const fresh = await seedRelation(["Retrieval", "Feedback"]);
    const explained = await seedRelation(["Spacing", "Recall"]);
    await pool!.query(
      `insert into atomic_note_relation_explanations
         (relation_id, text, input_hash, prompt_version, provider, model, runtime, language, written_at)
       values ($1, 'n1 and n2 share a subject.', 'hash', 'v3', 'openai-codex', 'writer', 'remote', 'en', now())`,
      [explained]
    );

    const picked = await pickRelationsToExplain(pool!, 5, 20261021);
    expect(picked).toEqual([
      { id: fresh, explained: false },
      { id: explained, explained: true }
    ]);
    // The same seed picks the same order; one is enough when only one is asked.
    expect(await pickRelationsToExplain(pool!, 5, 20261021)).toEqual(picked);
    expect(await pickRelationsToExplain(pool!, 1, 20261021)).toEqual([picked[0]]);

    expect(await forgetExplanations(pool!, [explained])).toBe(1);
    expect(await forgetExplanations(pool!, [])).toBe(0);
    expect(
      (await pickRelationsToExplain(pool!, 5, 20261021)).every((entry) => !entry.explained)
    ).toBe(true);
  });

  it("picks a note nobody edited, a title to ask about, and reads jobs and audited calls", async () => {
    await pool!.query("delete from atomic_note_relations");
    await pool!.query("delete from atomic_notes");
    const note = await seedNote("Untouched");
    await seedNote("Rejected", "rejected");
    await pool!.query(
      `update atomic_notes set metadata = metadata || '{"humanProtected":true}'::jsonb where title = 'Untouched' and false`
    );
    const picked = await pickEditableNote(pool!, 1, 0);
    expect(picked?.id).toBe(note.id);
    expect(Date.parse(picked!.updatedAt)).not.toBeNaN();
    await pool!.query(
      `update atomic_notes set metadata = metadata || '{"humanProtected":true}'::jsonb where id = $1`,
      [note.id]
    );
    expect(await pickEditableNote(pool!, 1, 0)).toBeNull();

    const title = await pickQuestionTitle(pool!, 1, 0);
    expect(typeof title).toBe("string");
    expect(await pickQuestionTitle(pool!, 1, 0)).toBe(title);

    await pool!.query(
      `insert into jobs (type, status, lane, payload, attempts, locked_at)
       values ('note-embedding', 'running', 'light', jsonb_build_object('sourceItemId', $1::text), 1, now()),
              ('ingest', 'queued', 'heavy', '{}'::jsonb, 0, null),
              ('ingest', 'succeeded', 'heavy', '{}'::jsonb, 1, null)`,
      [note.sourceId]
    );
    const { jobs, counts } = await readJobs(pool!);
    expect(jobs.map((job) => [job.type, job.status, job.lane, job.sourceItemId])).toEqual([
      ["note-embedding", "running", "light", note.sourceId],
      ["ingest", "queued", "heavy", null]
    ]);
    expect(counts).toEqual({ running: 1, queued: 1, succeeded: 1 });
    expect(jobs[0]!.lockedAt).toBeGreaterThan(0);

    await pool!.query(
      `insert into ai_task_runs (task_type, provider, model_id, runtime, duration_ms, status, started_at, finished_at,
         lane, workload_class, priority, deadline_ms, deadline_outcome, is_repair, schema_mode, retry_wait_ms, requeue_ms, queue_ms, error)
       values ('summarization', 'local-mlx', 'writer', 'local', 900, 'succeeded', now() - interval '2 seconds', now() - interval '1 second',
         'local', 'write-fast', 2, 140000, 'met', false, 'none', 0, 0, 12, null),
              ('text-generation', 'openai-codex', 'dev', 'remote', 120000, 'failed', now() - interval '3 minutes', now() - interval '1 minute',
         'remote:abc', 'write-fast', 0, 120000, 'aborted', false, null, 4000, 0, 3, repeat('x', 500))`
    );
    const runs = await readTaskRuns(pool!, Date.now() - 600_000);
    expect(runs).toHaveLength(2);
    for (const run of runs) taskRunRecordSchema.parse(run);
    expect(runs.map((run) => [run.lane, run.deadlineOutcome, run.priority])).toEqual([
      ["remote:abc", "aborted", 0],
      ["local", "met", 2]
    ]);
    expect(runs[0]!.error).toHaveLength(300);
    expect(await readTaskRuns(pool!, Date.now() + 60_000)).toEqual([]);
  });

  it("refuses to install while a route or the default profile still leads to a real provider", async () => {
    const { profile } = readSoakPlan(join(workspace, "scripts/soak/plan.json"), "presoak4");
    const repository = createAiConfigRepository(pool!);
    const real = await repository.upsertProvider({
      provider: "openai-codex",
      displayName: "The owner's Codex",
      credentialRef: "ai:real",
      baseUrl: "https://chatgpt.com/backend-api/codex",
      metadata: { modelId: "gpt-real", capabilities: ["text-generation", "structured-output"] }
    });
    const realProfile = await repository.createProfile({
      name: "Hybrid writer",
      isDefault: true,
      privacyMode: "allow_remote",
      outputLanguage: "ui"
    });
    await repository.updateProfile({
      id: realProfile.id,
      providerConfigId: real.id,
      modelId: "gpt-real",
      runtime: "remote",
      capabilities: ["text-generation", "structured-output"]
    });
    await repository.setProfileTask({ profileId: realProfile.id, task: "class:write-quality" });
    await repository.setTaskRoute("class:write-quality", realProfile.id);
    expect(await findRealRemoteRoutes(pool!, [])).toEqual([
      "class:write-quality -> The owner's Codex (openai-codex)",
      "default profile -> The owner's Codex (openai-codex)"
    ]);

    const options = {
      pool: pool!,
      credentials: {
        save: async (_secret: string, existing?: string | null) => existing ?? `ai:${randomUUID()}`
      },
      setAnswerRoute: async (profileId: string) => {
        await repository.setProfileTask({ profileId, task: "class:answer" });
        await repository.setTaskRoute("class:answer", profileId);
      },
      sink: new MemoryEventSink(),
      workspaceRoot: workDir
    };
    const fixed = (latency: object) => ({ ...latency, fit: null, task: null }) as never;
    const withoutFit = {
      ...profile,
      remote: {
        openAiCompatible: {
          ...profile.remote.openAiCompatible,
          latency: fixed(profile.remote.openAiCompatible.latency)
        },
        codexWire: { ...profile.remote.codexWire, latency: fixed(profile.remote.codexWire.latency) }
      }
    };
    try {
      await expect(startFakeRemote(withoutFit, options)).rejects.toThrow(
        /still routes to a real remote provider.*Local preset/su
      );
    } finally {
      // Gone: the routes lead nowhere real, and the installation goes through.
      await repository.deleteTaskRoute("class:write-quality");
      await repository.deleteProfile(realProfile.id);
      await repository.deleteProvider(real.id);
    }
    const fakes = (await repository.listProviders())
      .filter((provider) => provider.displayName.startsWith("DEV fake"))
      .map((provider) => provider.id);
    expect(await findRealRemoteRoutes(pool!, fakes)).toEqual([]);
  });

  it("installs the fake providers and their routes, again on the next start without duplicating them", async () => {
    const { profile } = readSoakPlan(join(workspace, "scripts/soak/plan.json"), "presoak4");
    const sink = new MemoryEventSink();
    const saved: Array<{ secret: string; ref: string | null }> = [];
    const credentials = {
      save: async (secret: string, existing?: string | null) => {
        const ref = existing ?? `ai:${randomUUID()}`;
        saved.push({ secret, ref });
        return ref;
      }
    };
    const repository = createAiConfigRepository(pool!);
    const setAnswerRoute = async (profileId: string) => {
      for (const task of ["class:answer"]) {
        await repository.setProfileTask({ profileId, task });
        await repository.setTaskRoute(task, profileId);
      }
    };
    const options = {
      pool: pool!,
      credentials,
      setAnswerRoute,
      sink,
      workspaceRoot: join(workDir, "no-fit-needed")
    };
    // The plan reads its latency from a fit; without one a profile with fixed latency is used.
    const fixed = (latency: object) => ({ ...latency, fit: null, task: null });
    const withoutFit = {
      ...profile,
      remote: {
        openAiCompatible: {
          ...profile.remote.openAiCompatible,
          latency: fixed(profile.remote.openAiCompatible.latency) as never
        },
        codexWire: {
          ...profile.remote.codexWire,
          latency: fixed(profile.remote.codexWire.latency) as never
        }
      }
    };

    const first = await startFakeRemote(withoutFit, options);
    try {
      const providers = await repository.listProviders();
      expect(
        providers.map((provider) => [provider.provider, provider.metadata.treatAsRemote])
      ).toEqual([
        ["openai-codex", true],
        ["openai-compatible", true]
      ]);
      expect(saved.map((entry) => entry.secret)).toEqual([
        expect.stringContaining("dev-fake-remote-api-key"),
        expect.stringContaining("dev-fake-codex-access-token")
      ]);
      const asked = await repository.getDefaultTask("structured-output", undefined, [
        "op:wiki-consultation",
        "class:answer",
        "structured-output"
      ]);
      expect(asked).toMatchObject({
        provider: "openai-compatible",
        baseUrl: first.providers[0]!.baseUrl,
        providerMetadata: expect.objectContaining({ treatAsRemote: true })
      });
      const explained = await repository.getDefaultTask("text-generation", undefined, [
        explanationRoute,
        "class:write-fast",
        "text-generation"
      ]);
      expect(explained).toMatchObject({
        provider: "openai-codex",
        routeKey: explanationRoute,
        baseUrl: first.providers[1]!.baseUrl
      });
    } finally {
      await first.stop();
    }

    const second = await startFakeRemote(withoutFit, options);
    try {
      expect((await repository.listProviders()).length).toBe(2);
      expect(
        (await repository.listProfiles()).filter((entry) => entry.name.startsWith("DEV fake"))
          .length
      ).toBe(2);
      expect((await repository.listProviders()).map((provider) => provider.baseUrl).sort()).toEqual(
        second.providers.map((provider) => provider.baseUrl).sort()
      );
      // The credential entries were reused, not added.
      expect(new Set(saved.map((entry) => entry.ref)).size).toBe(2);
    } finally {
      await second.stop();
    }
  });
});
