import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  closePgPool,
  createPgPool,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "@app/db";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { evaluateMatching } from "./matching-evaluation.ts";
import {
  createReadOnlyClient,
  parseEvaluateArgs,
  readEvaluationInput,
  readLibrary,
  resolveEvaluationConnection
} from "./matching-evaluation-db.ts";
import { buildMatchingFixture, parseMatchingFixture, pairKey } from "./matching-fixture.ts";

const workspace = resolve(import.meta.dirname, "..", "..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

describe("parseEvaluateArgs", () => {
  it("needs a database and takes defaults for everything else", () => {
    expect(() => parseEvaluateArgs([])).toThrow("--db is required.");
    const command = parseEvaluateArgs(["--db", "x.json"]);
    expect(command).toMatchObject({
      kind: "run",
      db: "x.json",
      mapping: ".cache/golden/matching-fixture/mapping.json",
      ids: null,
      tasks: ["reranking"],
      check: false,
      options: { statuses: ["accepted", "pending_review"], minExpected: 27, maxForbidden: 0 }
    });
    expect(parseEvaluateArgs(["--help"])).toEqual({ kind: "help" });
  });

  it("reads windows, statuses, tasks and thresholds, and refuses nonsense", () => {
    const command = parseEvaluateArgs([
      "--db",
      "x.json",
      "--since",
      "2026-09-09T01:02:08Z",
      "--statuses",
      "accepted",
      "--task",
      "reranking",
      "--task",
      "decision",
      "--min-expected",
      "28",
      "--check"
    ]);
    expect(command).toMatchObject({
      tasks: ["reranking", "decision"],
      check: true,
      options: { statuses: ["accepted"], minExpected: 28 }
    });
    expect(command.kind === "run" && command.since?.toISOString()).toBe("2026-09-09T01:02:08.000Z");
    expect(() => parseEvaluateArgs(["--db", "x", "--since", "yesterday"])).toThrow("ISO timestamp");
    expect(() => parseEvaluateArgs(["--db", "x", "--statuses", "approved"])).toThrow("--statuses");
    expect(() => parseEvaluateArgs(["--db", "x", "--min-expected=-1"])).toThrow(">= 0");
    expect(() => parseEvaluateArgs(["--db", "x", "--surprise"])).toThrow();
  });
});

describe("resolveEvaluationConnection", () => {
  it("reads a dev-connection.json shape and describes it without the password", async () => {
    const dir = await mkdtemp(join(tmpdir(), "memora-eval-conn-"));
    try {
      const file = join(dir, "dev-connection.json");
      await writeFile(
        file,
        JSON.stringify({
          developmentOnly: true,
          connectionString: "postgresql://user:secret-pw@127.0.0.1:5544/memora_dev"
        })
      );
      const connection = await resolveEvaluationConnection(file);
      expect(connection.description).toBe("127.0.0.1:5544/memora_dev");
      expect(connection.description).not.toContain("secret");
      expect(connection.connectionString).toContain("secret-pw");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("accepts a loopback URL and refuses other hosts, stopped clusters and unreadable files", async () => {
    await expect(resolveEvaluationConnection("postgres://u:p@localhost/db")).resolves.toMatchObject(
      { description: "localhost:5432/db" }
    );
    await expect(resolveEvaluationConnection("postgres://u:p@db.example.com/x")).rejects.toThrow(
      "Only a loopback PostgreSQL"
    );
    await expect(resolveEvaluationConnection("/nonexistent/connection.json")).rejects.toThrow(
      "Cannot read the connection file"
    );
    const dir = await mkdtemp(join(tmpdir(), "memora-eval-conn-"));
    try {
      const stopped = join(dir, "scratch.json");
      await writeFile(
        stopped,
        JSON.stringify({ status: "stopped", connectionString: "postgres://u:p@127.0.0.1/x" })
      );
      await expect(resolveEvaluationConnection(stopped)).rejects.toThrow("is stopped");
      const empty = join(dir, "empty.json");
      await writeFile(empty, "{}");
      await expect(resolveEvaluationConnection(empty)).rejects.toThrow('no "connectionString"');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

const uid = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const fixturePath = "scripts/fixtures/matching-benchmark.json";
const fixtureText = readFileSync(resolve(workspace, fixturePath), "utf8");
const built = buildMatchingFixture(parseMatchingFixture(JSON.parse(fixtureText)), {
  path: fixturePath,
  text: fixtureText
});
const { mapping } = built;

describe.skipIf(!sidecarInstalled)("the evaluator on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager;
  let pool: PgPool;
  let connectionString = "";
  const rootSource = new Map<string, string>();
  const noteOf = new Map<string, string>();

  const q = (text: string, values: unknown[] = []) => pool.query(text, values);
  // The first labelled pairs of each kind, whatever the fixture holds.
  const expectedHoldout = mapping.expectedRootPairs.filter((e) => e.partition === "holdout");
  const forbiddenHoldout = mapping.forbiddenRootPairs.filter((e) => e.partition === "holdout");
  const expectedTuning = mapping.expectedRootPairs.filter((e) => e.partition === "tuning");

  async function addNote(n: number, root: string, status = "active", supersession = "current") {
    const record = mapping.roots.find((r) => r.id === root)!;
    const source = record.records[0] ? uid(1000 + n) : rootSource.get(root)!;
    if (record.records[0])
      await q(
        `insert into source_items (id, type, title, parent_source_item_id)
         values ($1, 'BookChapter', $2, $3)`,
        [source, record.records[0].title, rootSource.get(root)]
      );
    // The database requires a note's evidence chunk to belong to the note's source.
    await q(
      `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
       values ($1, $2, 'doc', 'body', $3)`,
      [uid(9000 + n), source, `doc-${n}`]
    );
    await q(
      `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
       values ($1, $2, $3, 0, 'body', $4)`,
      [uid(9500 + n), uid(9000 + n), source, `chunk-${n}`]
    );
    await q(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, created_from_source_item_id,
         evidence_chunk_id, generation_provider, generation_model, generation_runtime,
         generation_prompt_version, generation_key, status, supersession_status)
       values ($1, 'note', 'body', 'idea', $2, $3, 'p', 'm', 'remote', 'v', $4, $5::atomic_note_status, $6)`,
      [uid(n), source, uid(9500 + n), `key-${n}`, status, supersession]
    );
    return uid(n);
  }

  async function relate(a: string, b: string, status: string) {
    await q(
      `insert into atomic_note_relations (source_atomic_note_id, target_atomic_note_id, final_score, explanation, status)
       values ($1, $2, 0.9, 'x', $3::atomic_note_relation_status)`,
      [a, b, status]
    );
  }

  async function call(
    n: number,
    operation: string,
    context: Record<string, unknown>,
    options: {
      task?: string;
      ms?: number;
      startedAt?: string;
      usage?: Record<string, unknown>;
    } = {}
  ) {
    await q(
      `insert into ai_task_runs (id, task_type, provider, model_id, runtime, duration_ms, status,
         input_tokens, output_tokens, started_at, finished_at)
       values ($1, $2, 'p', 'm', 'remote', $3, 'succeeded', 100, 40, $4::timestamptz, now())`,
      [
        uid(n),
        options.task ?? "reranking",
        options.ms ?? 2000,
        options.startedAt ?? "2026-09-09T01:10:00Z"
      ]
    );
    await q(
      `insert into monitoring_operations (kind, operation, stage, status, ai_task_run_id, context, token_usage)
       values ('ai', $1, 'stage', 'succeeded', $2, $3::jsonb, $4::jsonb)`,
      [
        operation,
        uid(n),
        JSON.stringify(context),
        JSON.stringify(options.usage ?? { reasoningTokens: 8 })
      ]
    );
  }

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-golden-eval-"));
    manager = new PostgresSidecarManager({
      binDir: sidecar.binDir,
      dataDir: join(workDir, "data"),
      database: "golden_eval",
      user: "golden_eval",
      password: `eval-${randomUUID()}`,
      startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 10_000
    });
    connectionString = (await manager.start()).connectionString;
    pool = createPgPool({ connectionString, max: 2 });
    await runMigrations(pool, join(workspace, "packages/db/drizzle"), {
      seedFolder: join(workspace, "packages/db/seed")
    });

    // The library as the golden runner leaves it after the import: titles from the manifest.
    for (const [index, root] of mapping.roots.entries()) {
      const id = uid(100 + index);
      rootSource.set(root.id, id);
      await q(`insert into source_items (id, type, title) values ($1, $2::source_item_type, $3)`, [
        id,
        root.kind === "container" ? "Book" : "StandaloneArticle",
        root.title
      ]);
    }
    // Held-out: one expected pair linked (through a chapter when the root is a book) and one
    // forbidden pair only linked by a rejected relation.
    const [e0, e1] = expectedHoldout[0]!.pair;
    const [f0, f1] = forbiddenHoldout[0]!.pair;
    const roots = [...new Set([e0, e1, f0, f1])];
    let n = 1;
    for (const root of roots) noteOf.set(root, await addNote(n++, root));
    await relate(noteOf.get(e0)!, noteOf.get(e1)!, "accepted");
    await relate(noteOf.get(f0)!, noteOf.get(f1)!, "rejected");
    // A rejected and a superseded note of the library are not the library's notes.
    const rejectedNote = await addNote(50, f0, "rejected");
    const supersededNote = await addNote(51, f1, "active", "superseded");
    await relate(rejectedNote, noteOf.get(f1)!, "pending_review");
    await relate(noteOf.get(f0)!, supersededNote, "pending_review");
    // Tuning: an expected pair linked only through a source relation.
    const [t0, t1] = expectedTuning[0]!.pair;
    const [sa, sb] = [rootSource.get(t0)!, rootSource.get(t1)!].sort();
    await q(
      `insert into source_relations (source_item_id, target_source_item_id, identity_key, relation_type,
         source_idea, target_idea, explanation, importance, confidence, status)
       values ($1, $2, 'k1', 'related', 'a', 'b', 'c', 0.9, 0.9, 'pending_review')`,
      [sa, sb]
    );

    // Calls: two note matching (one replayed), one source matching, one other task, one outside the window.
    await call(200, "note_matching_reranking", {
      atomicNoteId: noteOf.get(e0),
      promptVersion: "v6"
    });
    await call(
      201,
      "note_matching_reranking",
      { atomicNoteId: noteOf.get(e1), promptVersion: "v6" },
      { usage: { reasoningTokens: 4, "cassette.replayed": 1 } }
    );
    await call(202, "source_relation_matching", { sourceItemId: rootSource.get(t0) }, { ms: 3000 });
    await call(203, "embedding", { atomicNoteId: noteOf.get(e0) }, { task: "embedding" });
    await call(
      204,
      "note_matching_reranking",
      { atomicNoteId: noteOf.get(e0) },
      { startedAt: "2026-08-01T00:00:00Z" }
    );
  }, 180_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool);
    if (manager) await manager.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("finds the roots by title and scores both layers", async () => {
    const input = await readLibrary({ connectionString, description: "test" }, mapping, {
      tasks: ["reranking"],
      since: null,
      until: null
    });
    const result = evaluateMatching(input);
    expect(result.resolution.roots).toMatchObject({ total: 60, resolved: 60 });
    // Four roots hold a live note; the rejected and the superseded note are not the library's.
    expect(result.resolution.notes).toBe(new Set(noteOf.values()).size);
    const holdout = result.partitions.holdout.layers;
    expect(holdout.notes.expected.hitPairs).toEqual([pairKey(...expectedHoldout[0]!.pair)]);
    expect(holdout.notes.forbidden.hit).toBe(0);
    expect(holdout.sources.relations).toBe(0);
    const tuning = result.partitions.tuning.layers;
    expect(tuning.sources.expected.hitPairs).toEqual([pairKey(...expectedTuning[0]!.pair)]);
    expect(tuning.notes.expected.hit).toBe(0);
  });

  it("splits the reranking calls into note and source matching, with tokens and replays", async () => {
    const input = await readLibrary({ connectionString, description: "test" }, mapping, {
      tasks: ["reranking"],
      since: null,
      until: null
    });
    const { cost } = evaluateMatching(input);
    expect(cost.noteMatching.group.calls).toBe(3);
    expect(cost.noteMatching.group.replayed).toBe(1);
    expect(cost.noteMatching.promptVersions).toEqual({ unknown: 1, v6: 2 });
    expect(cost.noteMatching.group.inputTokens).toMatchObject({ sum: 300, perCall: 100 });
    expect(cost.noteMatching.group.reasoningTokens).toMatchObject({ sum: 20, reported: 3 });
    expect(cost.sourceMatching).toMatchObject({ roots: 1 });
    expect(cost.sourceMatching.group.seconds.sum).toBe(3);
    expect(cost.unclassified.calls).toBe(0);
  });

  it("limits the AI calls to a window and to the requested task types", async () => {
    const connection = { connectionString, description: "test" };
    const window = await readLibrary(connection, mapping, {
      tasks: ["reranking"],
      since: new Date("2026-09-01T00:00:00Z"),
      until: null
    });
    expect(window.aiCalls).toHaveLength(3);
    const embeddings = await readLibrary(connection, mapping, {
      tasks: ["embedding"],
      since: null,
      until: new Date("2026-09-10T00:00:00Z")
    });
    expect(embeddings.aiCalls.map((c) => c.task)).toEqual(["embedding"]);
  });

  it("opens a session that cannot write", async () => {
    const client = createReadOnlyClient(connectionString);
    await client.connect();
    try {
      await expect(client.query("delete from source_items")).rejects.toThrow(/read-only/u);
      await expect(client.query("update atomic_notes set title = 'x'")).rejects.toThrow(
        /read-only/u
      );
    } finally {
      await client.end();
    }
    const count = await q("select count(*)::int as n from source_items");
    expect(count.rows[0]!.n).toBeGreaterThan(60);
  });

  it("reads a library of an older schema and reports what it could not measure", async () => {
    await q("create database old_library");
    const url = new URL(connectionString);
    url.pathname = "/old_library";
    const old = new pg.Client({ connectionString: url.toString() });
    await old.connect();
    try {
      await old.query(`
        create table source_items (id uuid primary key, title text not null, parent_source_item_id uuid);
        create table atomic_notes (id uuid primary key, created_from_source_item_id uuid not null);
        create table atomic_note_relations (source_atomic_note_id uuid, target_atomic_note_id uuid, status text);
        create table source_relations (source_item_id uuid, target_source_item_id uuid, status text);
        create table ai_task_runs (id uuid primary key, task_type text, status text, duration_ms integer,
          input_tokens integer, output_tokens integer, started_at timestamptz default now());
        insert into source_items values ('${uid(1)}', '${mapping.roots[0]!.title}', null);
        insert into atomic_notes values ('${uid(2)}', '${uid(1)}');
        insert into ai_task_runs (id, task_type, status, duration_ms) values ('${uid(3)}', 'reranking', 'succeeded', 900);`);
      const input = await readEvaluationInput(old, mapping, {
        tasks: ["reranking"],
        since: null,
        until: null
      });
      expect(input.gaps).toHaveLength(1);
      expect(input.gaps![0]).toContain("monitoring_operations is missing");
      expect(input.notes).toHaveLength(1);
      expect(input.aiCalls).toHaveLength(1);
      const result = evaluateMatching(input);
      expect(result.resolution.roots.resolved).toBe(1);
      expect(result.cost.noteMatching.secondsPerNote).toBeNull();
      await old.query("drop table source_relations");
      await expect(
        readEvaluationInput(old, mapping, { tasks: ["reranking"], since: null, until: null })
      ).rejects.toThrow("This is not a Memora library: source_relations lacks");
    } finally {
      await old.end();
    }
  });
});
