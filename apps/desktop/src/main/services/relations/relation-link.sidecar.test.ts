import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  PostgresSidecarManager,
  closePgPool,
  createAiConfigRepository,
  createIngestionRunRepository,
  createJobRepository,
  createPgPool,
  createRelationTypingRepository,
  resolvePostgresSidecarPaths,
  runMigrations,
  type JobRecord,
  type PgPool
} from "@app/db";
import { relationsDailyCallsSettingKey } from "@app/domain";

import { InFlightRegistry } from "./in-flight-registry.js";
import type { RelationLinkRuntime } from "./link-runtime.js";
import { createRelationCallBudget, localDay } from "./relation-call-budget.js";
import {
  enqueueRelationLink,
  RelationLinker,
  type RelationDiscoveryInput,
  type StoredDecidedNote
} from "./relation-link.js";
import { typeRelationPairs, type TyperRoute } from "./relation-typing.js";

// The link job against a real database (F3 D20, D21, D24, D26): parked runs hand their decided
// pairs over, the typing step runs for real on a fake writer, and the relations, events, typing
// rows, run completion and the daily counter are read back from PostgreSQL.
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

describe.skipIf(!sidecarInstalled)("the link job on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool | undefined;
  let profileId = "";
  let aiRunId = "";

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-relation-link-"));
    let connection: Awaited<ReturnType<PostgresSidecarManager["start"]>> | undefined;
    for (let attempt = 1; !connection; attempt += 1) {
      manager = new PostgresSidecarManager({
        binDir: sidecar.binDir,
        dataDir: join(workDir, `data-${attempt}`),
        database: "memora_relation_link_test",
        user: "memora_relation_link_test",
        password: `relation-link-${randomUUID()}`,
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
    pool = createPgPool({ connectionString: connection.connectionString, max: 6 });
    await runMigrations(pool, join(workspace, "packages/db/drizzle"), {
      seedFolder: join(workspace, "packages/db/seed")
    });
    profileId = (await createAiConfigRepository(pool).createProfile({ name: "Link decider" })).id;
    aiRunId = (
      await pool.query<{ id: string }>(
        `insert into ai_task_runs (task_type, provider, model_id, runtime, duration_ms, status, finished_at)
         values ('structured-output', 'verify', 'gpt-test', 'remote', 1, 'succeeded', now()) returning id`
      )
    ).rows[0]!.id;
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool);
    await manager?.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const db = pool!;
    await db.query(`delete from jobs`);
    await db.query(`delete from relation_events`);
    await db.query(`delete from relation_match_runs`);
    await db.query(`delete from relation_typings`);
    await db.query(`delete from atomic_note_relations`);
    await db.query(`delete from settings where key = $1`, [relationsDailyCallsSettingKey]);
  });

  // --- the library ----------------------------------------------------------------------------

  /** A source with one document and chunk; `parent` makes it a record of a book. */
  const seedSource = async (title: string, parent?: string) => {
    const db = pool!;
    const sourceId = randomUUID(),
      documentId = randomUUID(),
      chunkId = randomUUID();
    await db.query(
      `insert into source_items (id, type, title, parent_source_item_id) values ($1, $2, $3, $4)`,
      [sourceId, parent ? "DocumentSection" : "PersonalNote", title, parent ?? null]
    );
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
    return { sourceId, chunkId };
  };

  const seedNote = async (source: { sourceId: string; chunkId: string }, title: string) => {
    const id = randomUUID();
    await pool!.query(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, status,
         supersession_status, ownership, created_from_source_item_id, owning_source_item_id,
         evidence_chunk_id, generation_provider, generation_model, generation_runtime,
         generation_prompt_version, generation_key)
       values ($1, $2, $3, $4, 'pending_review', 'current', 'source', $5, $5, $6, 'seed', 'seed',
               'local', 'seed', $7)`,
      [id, title, `${title} body.`, `${title} idea.`, source.sourceId, source.chunkId, `key-${id}`]
    );
    return { id, sourceId: source.sourceId };
  };

  type Note = Awaited<ReturnType<typeof seedNote>>;

  /** A decided note with its accepted pairs, as the matching checkpoint keeps it. */
  const decided = (
    note: Note,
    pairs: Array<{
      with: Note;
      relationType?: StoredDecidedNote["pairs"][number]["relationType"];
      subject?: Note;
      band?: "apply" | "suggest";
    }>
  ): StoredDecidedNote => ({
    noteId: note.id,
    sourceItemId: note.sourceId,
    decider: {
      kind: pairs.some((pair) => pair.relationType) ? "generative" : "ranker",
      mode: "ranker",
      deciderKey: "decider-key",
      calibration: "provisional",
      profileId,
      modelId: "decider"
    },
    pairs: pairs.map((pair) => ({
      noteId: note.id,
      candidateId: pair.with.id,
      candidateSourceItemId: pair.with.sourceId,
      band: pair.band ?? "apply",
      probability: null,
      score: pair.relationType ? 0.9 : 4.5,
      calibration: "provisional",
      relationType: pair.relationType ?? null,
      subjectId: pair.subject?.id ?? (pair.relationType ? note.id : null),
      decisionSource: "model",
      vectorScore: 0.8,
      graphScore: null
    }))
  });

  /** A run that decided `notes` and parked its source stage, and its root's queued link job. */
  const park = async (
    sourceId: string,
    rootId: string,
    notes: StoredDecidedNote[],
    trigger = "library_action",
    effectiveStages = ["atomicNoteMatching", "sourceMatching"]
  ) => {
    const runs = createIngestionRunRepository(pool!);
    const run = await runs.create({
      sourceItemId: sourceId,
      status: "running",
      trigger,
      effectiveStages
    });
    await runs.completeStage(run.id, "atomicNoteMatching", { decided: notes });
    await runs.parkForLinking(run.id, { rootId });
    return { run, job: await enqueueRelationLink(pool!, { rootId }) };
  };

  // --- the link job's steps ------------------------------------------------------------------

  /** The writer answers every pair `supports` from the note shown first, or `none` for a title. */
  const writer = (options: { veto?: string; fail?: number; gate?: Promise<void> } = {}) => {
    let failures = options.fail ?? 0;
    return vi.fn(async (_task: string, prompt: string, context: { priority?: string } = {}) => {
      void context;
      await options.gate;
      if (failures > 0) {
        failures -= 1;
        throw new Error("writer_unavailable");
      }
      const wire = JSON.parse(/PAIRS:\n(\[.*\])/u.exec(prompt)![1]!) as Array<{
        p: string;
        a: string;
        b: string;
      }>;
      return {
        taskType: "structured-output" as const,
        output: {
          pairs: wire.map((entry) =>
            options.veto && (entry.a.includes(options.veto) || entry.b.includes(options.veto))
              ? { p: entry.p, t: "none", d: "none" }
              : { p: entry.p, t: "supports", d: "ab" }
          )
        },
        providerId: "openai-codex" as const,
        modelId: "gpt-test",
        runtime: "remote" as const,
        durationMs: 1,
        profileId,
        aiTaskRunId: aiRunId,
        outputLanguage: "en"
      };
    });
  };

  const linker = (
    input: {
      ai?: ReturnType<typeof writer>;
      noRoute?: boolean;
      cap?: number;
      runtime?: RelationLinkRuntime;
      registry?: InFlightRegistry;
      discover?: (input: RelationDiscoveryInput) => Promise<Record<string, unknown>>;
    } = {}
  ) => {
    const ai = input.ai ?? writer();
    const discovered: RelationDiscoveryInput[] = [];
    const changed: string[][] = [];
    const instance = new RelationLinker({
      getPool: () => pool!,
      steps: {
        typeRelationPairs: (pairs, options, signal) =>
          typeRelationPairs(
            {
              ai: { runDefaultTask: ai } as never,
              store: createRelationTypingRepository(pool!),
              resolveRoute: async () => (input.noRoute ? null : route)
            },
            pairs,
            options,
            signal
          ),
        discoverSourceRelations: async (discovery) => {
          discovered.push(discovery);
          return input.discover ? input.discover(discovery) : { persistedCount: 0 };
        }
      },
      registry: input.registry ?? new InFlightRegistry(),
      budget: createRelationCallBudget({ db: () => pool!, cap: () => input.cap ?? 500 }),
      runtime: () => input.runtime ?? { drain: false, remoteCallsOff: false },
      relationsChanged: (ids) => void changed.push([...ids].sort())
    });
    return { instance, ai, discovered, changed };
  };

  /** Claims the root's queued link job, as the `relations` worker does. */
  const claim = async (rootId: string): Promise<JobRecord> => {
    const job = (
      await pool!.query<{ id: string }>(
        `select id from jobs where type = 'relation-link' and status = 'queued'
           and payload->>'rootId' = $1`,
        [rootId]
      )
    ).rows[0];
    expect(job).toBeDefined();
    await pool!.query(
      `update jobs set status = 'running', locked_at = now(), dedupe_key = null where id = $1`,
      [job!.id]
    );
    return (await createJobRepository(pool!).findById(job!.id))!;
  };

  const relations = async () =>
    (
      await pool!.query<{
        lo: string;
        hi: string;
        type: string | null;
        direction: string;
        band: string;
        typerKey: string | null;
      }>(
        `select source_atomic_note_id as lo, target_atomic_note_id as hi, relation_type as type,
                direction, band, typer_key as "typerKey"
         from atomic_note_relations order by source_atomic_note_id, target_atomic_note_id`
      )
    ).rows;

  const events = async () =>
    (
      await pool!.query<{ kind: string; relationId: string | null; runKind: string }>(
        `select event.kind, event.relation_id as "relationId", run.kind as "runKind"
         from relation_events event join relation_match_runs run on run.id = event.run_id
         order by event.seq`
      )
    ).rows;

  const signal = () => new AbortController().signal;

  // --- tests ---------------------------------------------------------------------------------

  it("types and persists a root's accepted pairs, records each change, and completes its run", async () => {
    const a = await seedSource("Alpha");
    const b = await seedSource("Beta");
    const a1 = await seedNote(a, "Alpha one");
    const a2 = await seedNote(a, "Alpha two");
    const b1 = await seedNote(b, "Beta one");
    const { run } = await park(a.sourceId, a.sourceId, [
      decided(a1, [{ with: b1 }]),
      // The generative decider's own type keeps its judged direction (D20): no typing call.
      decided(a2, [{ with: a1, relationType: "extends", subject: a2 }]),
      // The same pair handed on again by its other note is persisted once.
      decided(b1, [{ with: a1 }])
    ]);
    const { instance, ai, discovered, changed } = linker();
    const result = await instance.link(await claim(a.sourceId), signal());

    expect(ai).toHaveBeenCalledOnce();
    expect(ai.mock.calls[0]![2]).toMatchObject({ priority: "P2", workloadClass: "write-fast" });
    const stored = await relations();
    expect(stored).toHaveLength(2);
    const typed = stored.find((row) => [row.lo, row.hi].includes(b1.id))!;
    expect(typed).toMatchObject({ type: "supports", band: "apply" });
    expect(typed.typerKey).toMatch(/^[0-9a-f]{64}$/u);
    const extended = stored.find((row) => row.type === "extends")!;
    expect(extended.direction).toBe(a2.id === extended.lo ? "lo_to_hi" : "hi_to_lo");
    expect((await events()).map((event) => [event.kind, event.runKind])).toEqual([
      ["applied", "link"],
      ["applied", "link"]
    ]);
    expect(result).toMatchObject({ runs: 1, completedRuns: 1, applied: 2, priority: "P2" });
    // The run completes with its link job (D24), and discovery ran once for the root.
    const after = await createIngestionRunRepository(pool!).findById(run.id);
    expect(after).toMatchObject({ status: "succeeded", currentStage: "completed" });
    expect(after!.stagesCheckpoint.sourceMatching).toMatchObject({ status: "completed" });
    expect(discovered.map((entry) => entry.rootId)).toEqual([a.sourceId]);
    expect(changed).toEqual([[a1.id, a2.id, b1.id].sort()]);
  });

  it("persists the pairs of a run whose plan stops at note matching, and discovers nothing", async () => {
    const a = await seedSource("Sigma");
    const b = await seedSource("Tau");
    const s1 = await seedNote(a, "Sigma one");
    const t1 = await seedNote(b, "Tau one");
    const { run } = await park(
      a.sourceId,
      a.sourceId,
      [decided(s1, [{ with: t1 }])],
      "library_action",
      ["atomicNotes", "atomicNoteMatching"]
    );
    const { instance, discovered } = linker();
    const result = await instance.link(await claim(a.sourceId), signal());
    expect(await relations()).toEqual([expect.objectContaining({ type: "supports" })]);
    expect((await events()).map((event) => event.kind)).toEqual(["applied"]);
    // Source relations were not asked for: no discovery, and the run completes with its job.
    expect(discovered).toEqual([]);
    expect(result.discovery).toEqual({ status: "skipped", reason: "not_in_plan" });
    expect((await createIngestionRunRepository(pool!).findById(run.id))!.status).toBe("succeeded");
  });

  it("keeps a typing row and a vetoed event for a pair the typer answers none, and no relation", async () => {
    const a = await seedSource("Gamma");
    const g1 = await seedNote(a, "Gamma one");
    const g2 = await seedNote(a, "Unrelated gamma");
    await park(a.sourceId, a.sourceId, [decided(g1, [{ with: g2 }])]);
    const { instance } = linker({ ai: writer({ veto: "Unrelated" }) });
    await instance.link(await claim(a.sourceId), signal());
    expect(await relations()).toEqual([]);
    expect(await events()).toEqual([{ kind: "vetoed", relationId: null, runKind: "link" }]);
    const typings = await pool!.query(`select relation_type from relation_typings`);
    expect(typings.rows).toEqual([{ relation_type: "none" }]);
  });

  it("records the vetoed event of a none read from the typing cache, once per pair", async () => {
    // Coalescing: Rho's small job types Upsilon's pending pair, which the typer vetoes.
    const a = await seedSource("Rho");
    const b = await seedSource("Upsilon");
    const r1 = await seedNote(a, "Rho one");
    const r2 = await seedNote(a, "Rho two");
    const u1 = await seedNote(b, "Upsilon one");
    const u2 = await seedNote(b, "Unrelated upsilon");
    await park(a.sourceId, a.sourceId, [decided(r1, [{ with: r2 }])]);
    await park(b.sourceId, b.sourceId, [decided(u1, [{ with: u2 }])]);
    const product = linker({ ai: writer({ veto: "Unrelated" }) });
    await product.instance.link(await claim(a.sourceId), signal());
    expect(product.ai).toHaveBeenCalledOnce();
    expect((await events()).map((event) => event.kind)).toEqual(["applied"]);
    // Upsilon's own job reads the veto from the cache, with no call, and records it.
    const upsilon = await product.instance.link(await claim(b.sourceId), signal());
    expect(product.ai).toHaveBeenCalledOnce();
    expect(upsilon).toMatchObject({ typingCalls: 0, typingCacheHits: 1, vetoed: 1 });
    expect(await events()).toEqual([
      { kind: "applied", relationId: expect.any(String), runKind: "link" },
      { kind: "vetoed", relationId: null, runKind: "link" }
    ]);

    // A retry after a commit that failed: the typing row survived, the events did not.
    await pool!.query(`delete from relation_events`);
    await pool!.query(`delete from relation_match_runs`);
    await park(b.sourceId, b.sourceId, [decided(u1, [{ with: u2 }])]);
    const retry = await product.instance.link(await claim(b.sourceId), signal());
    expect(retry).toMatchObject({ typingCalls: 0, typingCacheHits: 1, vetoed: 1 });
    // The pair handed on again (by its other note's run) records no second veto.
    await park(b.sourceId, b.sourceId, [decided(u2, [{ with: u1 }])]);
    const again = await product.instance.link(await claim(b.sourceId), signal());
    expect(again).toMatchObject({ vetoed: 0 });
    expect(await events()).toEqual([{ kind: "vetoed", relationId: null, runKind: "link" }]);
    expect(await relations()).toHaveLength(1);
  });

  it.each([
    ["without a writer route", { noRoute: true }],
    ["at the daily cap", { cap: 0 }],
    ["after two failed typing attempts", { ai: "failing" as const }],
    ["with relation remote calls off", { runtime: { drain: true, remoteCallsOff: true } }]
  ])(
    "persists the pair untyped %s, and the root's next link job types it",
    async (_name, setup) => {
      const a = await seedSource("Delta");
      const b = await seedSource("Epsilon");
      const d1 = await seedNote(a, "Delta one");
      const e1 = await seedNote(b, "Epsilon one");
      await park(a.sourceId, a.sourceId, [decided(d1, [{ with: e1 }])]);
      const failing = "ai" in setup ? writer({ fail: 2 }) : undefined;
      const first = linker({
        ...("noRoute" in setup ? { noRoute: true } : {}),
        ...("cap" in setup ? { cap: setup.cap } : {}),
        ...("runtime" in setup ? { runtime: setup.runtime } : {}),
        ...(failing ? { ai: failing } : {})
      });
      const result = await first.instance.link(await claim(a.sourceId), signal());
      // A link job never fails for typing (D20): shown untyped with a neutral stance.
      expect(await relations()).toEqual([
        expect.objectContaining({ type: null, direction: "symmetric", band: "apply" })
      ]);
      expect((await events()).map((event) => event.kind)).toEqual(["untyped"]);
      if ("runtime" in setup) {
        // No remote relation call at all, and discovery waits (5.6).
        expect(first.ai).not.toHaveBeenCalled();
        expect(result.discovery).toEqual({ status: "deferred", reason: "remote_calls_off" });
      }
      if ("cap" in setup) {
        expect(first.ai).not.toHaveBeenCalled();
        expect(result.discovery).toEqual({ status: "deferred", reason: "daily_cap" });
      }
      if (failing) expect(failing).toHaveBeenCalledTimes(2);

      // The root's next link job types its untyped relation (the event says `typed`).
      await enqueueRelationLink(pool!, { rootId: a.sourceId });
      const next = linker();
      await next.instance.link(await claim(a.sourceId), signal());
      expect(await relations()).toEqual([expect.objectContaining({ type: "supports" })]);
      expect((await events()).map((event) => event.kind)).toEqual(["untyped", "typed"]);
    }
  );

  it("calls at P1 for an interactive import and counts the call, never refusing it at the cap", async () => {
    const a = await seedSource("Zeta");
    const b = await seedSource("Eta");
    const z1 = await seedNote(a, "Zeta one");
    const h1 = await seedNote(b, "Eta one");
    await park(a.sourceId, a.sourceId, [decided(z1, [{ with: h1 }])], "interactive_import");
    const { instance, ai, discovered } = linker({ cap: 0 });
    const result = await instance.link(await claim(a.sourceId), signal());
    expect(result.priority).toBe("P1");
    expect(ai).toHaveBeenCalledOnce();
    expect(ai.mock.calls[0]![2]).toMatchObject({ priority: "P1" });
    expect(discovered[0]).toMatchObject({ priority: "P1" });
    const counter = await pool!.query<{ value: unknown }>(
      `select value from settings where key = $1`,
      [relationsDailyCallsSettingKey]
    );
    expect(counter.rows[0]!.value).toEqual({
      day: localDay(new Date()),
      calls: 1,
      interactiveCalls: 1
    });
  });

  it("refuses background calls at the cap with one counter shared by concurrent jobs", async () => {
    const budget = createRelationCallBudget({ db: () => pool!, cap: () => 3 });
    const granted = await Promise.all(
      Array.from({ length: 8 }, () => budget.reserve({ lane: "remote", priority: "P2" }))
    );
    expect(granted.filter(Boolean)).toHaveLength(3);
    expect(await budget.reserve({ lane: "local", priority: "P2" })).toBe(true);
    expect(await budget.reserve({ lane: "remote", priority: "P2", drain: true })).toBe(true);
    expect(await budget.reserve({ lane: "remote", priority: "P1" })).toBe(true);
    expect(await budget.status()).toMatchObject({
      calls: 4,
      interactiveCalls: 1,
      cap: 3,
      capped: true
    });
    // A new local day starts a new count.
    const tomorrow = createRelationCallBudget({
      db: () => pool!,
      cap: () => 3,
      now: () => new Date(Date.now() + 86_400_000)
    });
    expect(await tomorrow.reserve({ lane: "remote", priority: "P2" })).toBe(true);
    expect(await tomorrow.status()).toMatchObject({ calls: 1, capped: false });
  });

  it("types a pair two roots hold at once with one call: the second waits for the first", async () => {
    const a = await seedSource("Theta");
    const b = await seedSource("Iota");
    const t1 = await seedNote(a, "Theta one");
    const i1 = await seedNote(b, "Iota one");
    await park(a.sourceId, a.sourceId, [decided(t1, [{ with: i1 }])]);
    await park(b.sourceId, b.sourceId, [decided(i1, [{ with: t1 }])]);
    let open!: () => void;
    const gate = new Promise<void>((resolve) => {
      open = resolve;
    });
    const ai = writer({ gate });
    const registry = new InFlightRegistry();
    const first = linker({ ai, registry });
    const second = linker({ ai, registry });
    const [jobA, jobB] = [await claim(a.sourceId), await claim(b.sourceId)];
    // Pool 2: both jobs type at once.
    const both = Promise.all([
      first.instance.link(jobA, signal()),
      second.instance.link(jobB, signal())
    ]);
    await vi.waitFor(() => expect(ai).toHaveBeenCalledOnce());
    open();
    const [resultA, resultB] = await both;
    expect(ai).toHaveBeenCalledOnce();
    expect(Number(resultA.typingCalls) + Number(resultB.typingCalls)).toBe(1);
    expect(Number(resultA.typingCacheHits) + Number(resultB.typingCacheHits)).toBe(1);
    // The pair is persisted once; the other job writes nothing for it.
    expect(await relations()).toHaveLength(1);
    expect((await events()).map((event) => event.kind)).toEqual(["applied"]);
    expect(registry.size).toBe(0);
  });

  it("coalesces a small source with another due link job's pairs, except in drain mode", async () => {
    const a = await seedSource("Kappa");
    const b = await seedSource("Lambda");
    const k1 = await seedNote(a, "Kappa one");
    const l1 = await seedNote(b, "Lambda one");
    const l2 = await seedNote(b, "Lambda two");
    const k2 = await seedNote(a, "Kappa two");
    await park(a.sourceId, a.sourceId, [decided(k1, [{ with: k2 }])]);
    await park(b.sourceId, b.sourceId, [decided(l1, [{ with: l2 }, { with: k1 }])]);
    const product = linker();
    await product.instance.link(await claim(a.sourceId), signal());
    // One call typed Kappa's pair and Lambda's two; Lambda's own job then pays nothing.
    expect(product.ai).toHaveBeenCalledOnce();
    expect(JSON.parse(/PAIRS:\n(\[.*\])/u.exec(product.ai.mock.calls[0]![1])![1]!)).toHaveLength(3);
    const lambda = await product.instance.link(await claim(b.sourceId), signal());
    expect(product.ai).toHaveBeenCalledOnce();
    expect(lambda).toMatchObject({ typingCalls: 0, typingCacheHits: 2 });

    // Drain mode: each job types only its own pairs.
    await pool!.query(`delete from relation_typings`);
    await pool!.query(`delete from relation_events`);
    await pool!.query(`delete from atomic_note_relations`);
    await park(a.sourceId, a.sourceId, [decided(k1, [{ with: k2 }])]);
    await park(b.sourceId, b.sourceId, [decided(l1, [{ with: l2 }])]);
    const drain = linker({ runtime: { drain: true, remoteCallsOff: false } });
    await drain.instance.link(await claim(a.sourceId), signal());
    expect(drain.ai).toHaveBeenCalledOnce();
    expect(JSON.parse(/PAIRS:\n(\[.*\])/u.exec(drain.ai.mock.calls[0]![1])![1]!)).toHaveLength(1);
  });

  it("links a book's records first in, first out, one record at a time in drain mode", async () => {
    const book = await seedSource("Book");
    const one = await seedSource("Chapter one", book.sourceId);
    const two = await seedSource("Chapter two", book.sourceId);
    const other = await seedSource("Mu");
    const c1 = await seedNote(one, "Chapter one note");
    const c2 = await seedNote(two, "Chapter two note");
    const m1 = await seedNote(other, "Mu one");
    const { run: first } = await park(one.sourceId, book.sourceId, [decided(c1, [{ with: m1 }])]);
    const { run: second } = await park(two.sourceId, book.sourceId, [decided(c2, [{ with: m1 }])]);
    // The second record's request joined the root's queued link job (deduplicated per root).
    const queued = await pool!.query(
      `select id from jobs where type = 'relation-link' and status = 'queued'`
    );
    expect(queued.rows).toHaveLength(1);
    const drain = linker({ runtime: { drain: true, remoteCallsOff: false } });
    const result = await drain.instance.link(await claim(book.sourceId), signal());
    // One call per record, in the order they parked; both runs complete with the job.
    expect(drain.ai).toHaveBeenCalledTimes(2);
    const prompts = drain.ai.mock.calls.map(([, prompt]) => prompt);
    expect(prompts[0]).toContain("Chapter one note");
    expect(prompts[1]).toContain("Chapter two note");
    expect(result).toMatchObject({ runs: 2, completedRuns: 2 });
    for (const run of [first, second])
      expect((await createIngestionRunRepository(pool!).findById(run.id))!.status).toBe(
        "succeeded"
      );
  });

  it("waits with a book's discovery until its last record has decided", async () => {
    const book = await seedSource("Atlas");
    const one = await seedSource("Atlas one", book.sourceId);
    const two = await seedSource("Atlas two", book.sourceId);
    const a1 = await seedNote(one, "Atlas one note");
    const a2 = await seedNote(two, "Atlas two note");
    await park(one.sourceId, book.sourceId, [decided(a1, [{ with: a2 }])]);
    // The second chapter is still generating its notes.
    await createIngestionRunRepository(pool!).create({
      sourceItemId: two.sourceId,
      status: "running",
      effectiveStages: ["atomicNotes", "atomicNoteMatching", "sourceMatching"]
    });
    const { instance, discovered } = linker();
    const result = await instance.link(await claim(book.sourceId), signal());
    expect(discovered).toEqual([]);
    expect(result.discovery).toEqual({ status: "deferred", reason: "records_pending" });
    expect(result.completedRuns).toBe(1);
  });

  it("ends only the runs a failed link job was linking, retryably", async () => {
    const a = await seedSource("Nu");
    const n1 = await seedNote(a, "Nu one");
    const n2 = await seedNote(a, "Nu two");
    const { run: linking } = await park(a.sourceId, a.sourceId, [decided(n1, [{ with: n2 }])]);
    const failing = linker({
      discover: async () => {
        throw new Error("errors.sourceRelations.invalidOutput");
      }
    });
    const job = await claim(a.sourceId);
    await expect(failing.instance.link(job, signal())).rejects.toThrow(
      "errors.sourceRelations.invalidOutput"
    );
    // The relations were committed before discovery (each step commits before the next).
    expect(await relations()).toHaveLength(1);
    // A run that parks after the job was claimed has its own link job.
    await pool!.query(`select pg_sleep(0.01)`);
    const { run: later } = await park(a.sourceId, a.sourceId, []);
    await failing.instance.linkEnded(job, new Error("errors.sourceRelations.invalidOutput"), false);
    const runs = createIngestionRunRepository(pool!);
    expect(await runs.findById(linking.id)).toMatchObject({
      status: "failed",
      error: "errors.sourceRelations.invalidOutput"
    });
    expect((await runs.findById(later.id))!.status).toBe("running");
  });

  it("types untyped relations in the daily sweep, and a none there withdraws the relation", async () => {
    const a = await seedSource("Omicron");
    const b = await seedSource("Pi");
    const o1 = await seedNote(a, "Omicron one");
    const p1 = await seedNote(b, "Pi one");
    const p2 = await seedNote(b, "Unrelated pi");
    await park(a.sourceId, a.sourceId, [decided(o1, [{ with: p1 }, { with: p2 }])]);
    await linker({ noRoute: true }).instance.link(await claim(a.sourceId), signal());
    expect((await relations()).map((row) => row.type)).toEqual([null, null]);
    const sweep = linker({ ai: writer({ veto: "Unrelated" }) });
    const job = { id: randomUUID(), payload: {} } as unknown as JobRecord;
    const result = await sweep.instance.sweep(job, signal());
    // One call at P3 types the page; the veto withdraws its relation (D20).
    expect(sweep.ai).toHaveBeenCalledOnce();
    expect(sweep.ai.mock.calls[0]![2]).toMatchObject({ priority: "P3" });
    expect(result).toMatchObject({ swept: 2, typed: 1, vetoed: 1, typingCalls: 1 });
    expect(result).not.toHaveProperty("continueWith");
    const rows = await pool!.query<{ type: string | null; vetoed: boolean }>(
      `select relation_type as type, vetoed_at is not null as vetoed from atomic_note_relations
       order by relation_type nulls last`
    );
    expect(rows.rows).toEqual([
      { type: "supports", vetoed: false },
      { type: null, vetoed: true }
    ]);
    expect(
      (await events())
        .filter((event) => event.runKind === "retype")
        .map((event) => event.kind)
        .sort()
    ).toEqual(["typed", "vetoed"]);
    // Nothing is left to sweep.
    const again = await sweep.instance.sweep(job, signal());
    expect(again).toMatchObject({ swept: 0, typingCalls: 0 });
  });

  it("gives the same directed relations and prompts on two replays of the same arrivals", async () => {
    const replay = async (tag: string) => {
      await pool!.query(`delete from jobs`);
      const a = await seedSource(`Replay A ${tag}`);
      const b = await seedSource(`Replay B ${tag}`);
      const a1 = await seedNote(a, "Replay first");
      const a2 = await seedNote(a, "Replay second");
      const b1 = await seedNote(b, "Replay third");
      await park(a.sourceId, a.sourceId, [
        decided(a1, [{ with: a2 }]),
        decided(a2, [{ with: a1 }])
      ]);
      await park(b.sourceId, b.sourceId, [decided(b1, [{ with: a1 }, { with: a2 }])]);
      const runtime = { drain: true, remoteCallsOff: false };
      const run = linker({ runtime });
      await run.instance.link(await claim(a.sourceId), signal());
      await run.instance.link(await claim(b.sourceId), signal());
      const titles = new Map<string, string>([
        [a1.id, "first"],
        [a2.id, "second"],
        [b1.id, "third"]
      ]);
      const rows = await pool!.query<{ lo: string; hi: string; type: string; direction: string }>(
        `select source_atomic_note_id as lo, target_atomic_note_id as hi, relation_type as type,
                direction from atomic_note_relations
         where source_atomic_note_id = any($1::uuid[])`,
        [[a1.id, a2.id, b1.id]]
      );
      // The digest names notes by content, never by ID: subject -> object and type.
      const digest = rows.rows
        .map((row) => {
          const [subject, object] =
            row.direction === "hi_to_lo" ? [row.hi, row.lo] : [row.lo, row.hi];
          return `${titles.get(subject)}->${titles.get(object)}:${row.type}`;
        })
        .sort();
      return { digest, prompts: run.ai.mock.calls.map(([, prompt]) => prompt) };
    };
    const first = await replay("one");
    await pool!.query(`delete from relation_typings`);
    const second = await replay("two");
    expect(first.digest).toHaveLength(3);
    expect(second).toEqual(first);
  });
});
