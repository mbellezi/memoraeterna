import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  closePgPool,
  createNoteMatchStateRepository,
  createPgPool,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "@app/db";

import {
  cloneConnectionString,
  proofEdit,
  proofMarker,
  proofReport,
  proofRequest,
  proofVerdict,
  selectProofNotes,
  type ProofCandidate,
  type ProofPlan,
  type ProofReport
} from "./match-proof.ts";

const candidate = (noteId: string, rootId: string, title: string): ProofCandidate => ({
  noteId,
  rootId,
  title,
  idea: `Idea of ${title}`
});

describe("choosing the notes to edit", () => {
  it("takes one note of each root in turn, in content order", () => {
    const picked = selectProofNotes(
      [
        candidate("n5", "r2", "Echo"),
        candidate("n1", "r1", "Alpha"),
        candidate("n2", "r1", "Beta"),
        candidate("n3", "r1", "Gamma"),
        candidate("n4", "r2", "Delta"),
        candidate("n6", "r3", "Foxtrot")
      ],
      5
    );
    // The roots are met in the content order of their first note: r1 (Alpha), r2 (Delta), r3.
    expect(picked.map((note) => note.title)).toEqual(["Alpha", "Delta", "Foxtrot", "Beta", "Echo"]);
  });

  it("does not depend on the order or the IDs it is given, and stops at what exists", () => {
    const notes = [
      candidate("b", "r1", "Alpha"),
      candidate("a", "r1", "Beta"),
      candidate("c", "r2", "Gamma")
    ];
    const reversed = [...notes].reverse();
    expect(selectProofNotes(notes, 10).map((note) => note.title)).toEqual(
      selectProofNotes(reversed, 10).map((note) => note.title)
    );
    expect(selectProofNotes(notes, 10)).toHaveLength(3);
    expect(selectProofNotes([], 3)).toEqual([]);
  });
});

describe("the verdict", () => {
  const plan: ProofPlan = {
    createdAt: "2026-10-24T00:00:00.000Z",
    clearedRelations: true,
    notes: ["n1", "n2"].map((noteId) => ({
      ...candidate(noteId, "r1", noteId),
      editedIdea: `Idea of ${noteId}${proofMarker}`
    }))
  };
  const job = (
    noteId: string,
    outcome: string,
    extra: Partial<ProofReport["matchJobs"][0]> = {}
  ) => ({
    noteId,
    status: "succeeded",
    outcome,
    resultStatus: outcome === "skipped" ? "skipped" : "completed",
    attempts: 1,
    fingerprinted: true,
    backlog: false,
    accepted: 1,
    ...extra
  });
  const report = (extra: Partial<ProofReport> = {}): ProofReport => ({
    since: plan.createdAt,
    matchJobs: [job("n1", "done"), job("n2", "no_change", { accepted: 0 })],
    linkJobs: [{ status: "succeeded", outcome: "done", applied: 0, suggested: 1 }],
    runs: [
      {
        kind: "link",
        titleKey: "changes.titles.relationMatched",
        titleParams: { note: "n1" },
        jobId: randomUUID()
      }
    ],
    relations: [
      { band: "suggest", relationType: "supports", directionSource: "typer", shown: "unknown" }
    ],
    states: [
      { noteId: "n1", hasHash: true },
      { noteId: "n2", hasHash: true }
    ],
    calls: [],
    ...extra
  });
  const failed = (verdict: ReturnType<typeof proofVerdict>) =>
    verdict.checks.filter((check) => !check.ok).map((check) => check.name);

  it("passes after the edits when each note had one job and left suggestions with no direction", () => {
    const verdict = proofVerdict(plan, report(), { requested: false });
    expect(failed(verdict)).toEqual([]);
    expect(verdict.ok).toBe(true);
  });

  it("counts a suggestion of a type that reads both ways as one with no direction (MATCHP 10-24)", () => {
    // MATCHP's 21 relations: 20 directed suggestions shown with no arrow, one same_as (symmetric).
    const verdict = proofVerdict(
      plan,
      report({
        relations: [
          { band: "suggest", relationType: "extends", directionSource: "typer", shown: "unknown" },
          { band: "suggest", relationType: "same_as", directionSource: null, shown: "symmetric" }
        ]
      }),
      { requested: false }
    );
    expect(failed(verdict)).toEqual([]);
    expect(verdict.checks.find((check) => check.name.startsWith("the relations"))?.detail).toBe(
      '2 relations (band/direction source/shown): {"suggest/typer/unknown":1,"suggest/none/symmetric":1}'
    );
  });

  it("wants a skipped second job per note once the request was made", () => {
    const requested = report({
      matchJobs: [
        job("n1", "done"),
        job("n2", "no_change"),
        job("n1", "skipped"),
        job("n2", "skipped")
      ]
    });
    expect(proofVerdict(plan, requested, { requested: true }).ok).toBe(true);
    // A request that decided again, or no request at all, fails.
    const decidedAgain = report({
      matchJobs: [
        job("n1", "done"),
        job("n2", "no_change"),
        job("n1", "done"),
        job("n2", "skipped")
      ]
    });
    expect(failed(proofVerdict(plan, decidedAgain, { requested: true }))).toEqual([
      "an unchanged text is skipped by its fingerprint without a decision"
    ]);
    expect(failed(proofVerdict(plan, report(), { requested: true }))).toContain(
      "one MATCH job per edit (and one per request)"
    );
  });

  it("fails a job that failed or ran twice, a missing hash, and a relation that applied or has a direction", () => {
    expect(
      failed(
        proofVerdict(
          plan,
          report({
            matchJobs: [job("n1", "done", { status: "failed", outcome: null }), job("n2", "done")]
          }),
          { requested: false }
        )
      )
    ).toEqual([
      "each edit's job ended done or with no change, decided once",
      "no MATCH or link job failed"
    ]);
    expect(
      failed(
        proofVerdict(
          plan,
          report({ matchJobs: [job("n1", "done", { attempts: 2 }), job("n2", "done")] }),
          { requested: false }
        )
      )
    ).toEqual(["each edit's job ended done or with no change, decided once"]);
    expect(
      failed(
        proofVerdict(
          plan,
          report({
            states: [
              { noteId: "n1", hasHash: false },
              { noteId: "n2", hasHash: true }
            ]
          }),
          { requested: false }
        )
      )
    ).toEqual(["every planned note keeps the hash of the text it was matched with"]);
    for (const relation of [
      { band: "apply", relationType: "supports", directionSource: "typer", shown: "unknown" },
      { band: "suggest", relationType: "supports", directionSource: "decider", shown: "lo_to_hi" },
      { band: "suggest", relationType: "extends", directionSource: "typer", shown: "hi_to_lo" }
    ])
      expect(
        failed(proofVerdict(plan, report({ relations: [relation] }), { requested: false }))
      ).toEqual(["the relations MATCH left are suggestions with no direction of a decider's"]);
    // Pairs were accepted, but no run is named after a note.
    expect(failed(proofVerdict(plan, report({ runs: [] }), { requested: false }))).toEqual([
      "a link run persisted for the notes MATCH handed over is named after its note"
    ]);
  });
});

describe("the clone", () => {
  it("is refused outside the repository's .cache, and needs a running scratch sidecar", async () => {
    const outside = await mkdtemp(join(tmpdir(), "match-proof-"));
    try {
      await writeFile(join(outside, "t44-connection.json"), '{"connectionString":"x"}');
      await expect(cloneConnectionString(outside)).rejects.toThrow("Refusing");
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
    const inside = resolve(import.meta.dirname, "../../.cache/match-proof-test-clone");
    await mkdir(inside, { recursive: true });
    try {
      await writeFile(join(inside, "t44-connection.json"), '{"connectionString":""}');
      await expect(cloneConnectionString(inside)).rejects.toThrow("not running");
      await writeFile(join(inside, "t44-connection.json"), '{"connectionString":"postgres://x"}');
      expect(await cloneConnectionString(inside)).toBe("postgres://x");
    } finally {
      await rm(inside, { recursive: true, force: true });
    }
  });
});

const workspace = resolve(import.meta.dirname, "../..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

describe.skipIf(!sidecarInstalled)("the proof on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool | undefined;
  let editedPlan: ProofPlan | undefined;

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-match-proof-"));
    manager = new PostgresSidecarManager({
      binDir: sidecar.binDir,
      dataDir: join(workDir, "data"),
      database: "memora_match_proof_test",
      user: "memora_match_proof_test",
      password: `match-proof-${randomUUID()}`,
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
    await manager?.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  async function seed(title: string, parent?: string) {
    const db = pool!;
    const sourceId = randomUUID(),
      documentId = randomUUID(),
      chunkId = randomUUID(),
      noteId = randomUUID();
    await db.query(
      "insert into source_items (id, type, title, parent_source_item_id) values ($1, $2, $3, $4)",
      [sourceId, parent ? "DocumentSection" : "PersonalNote", title, parent ?? null]
    );
    await db.query(
      "insert into documents (id, source_item_id, title, canonical_markdown, content_hash) values ($1, $2, $3, 'seed', $4)",
      [documentId, sourceId, title, `hash-${documentId}`]
    );
    await db.query(
      "insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash) values ($1, $2, $3, 0, $4, $5)",
      [chunkId, documentId, sourceId, `${title} passage.`, `chunk-${chunkId}`]
    );
    await db.query(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, status, supersession_status,
         ownership, created_from_source_item_id, owning_source_item_id, evidence_chunk_id,
         generation_provider, generation_model, generation_runtime, generation_prompt_version,
         generation_key)
       values ($1, $2, $3, $4, 'active', 'current', 'source', $5, $5, $6, 'seed', 'seed', 'local',
               'seed', $7)`,
      [noteId, title, `${title} body.`, `${title} idea.`, sourceId, chunkId, `key-${noteId}`]
    );
    await createNoteMatchStateRepository(db).record({
      noteId,
      deciderKey: "decider",
      spaceKey: "space-1",
      kthCosine: null
    });
    return { sourceId, noteId };
  }

  it("edits the planned notes as a person does, clears their relations, and asks again", async () => {
    const book = await seed("Proof book");
    const chapter = await seed("Proof chapter", book.sourceId);
    const other = await seed("Proof other");
    await pool!.query(
      `insert into atomic_note_relations (source_atomic_note_id, target_atomic_note_id, band,
         relation_type, direction, direction_source, final_score, explanation)
       select least($1::uuid, $2::uuid), greatest($1::uuid, $2::uuid), 'suggest', 'supports',
              'lo_to_hi', 'typer', 0.8, 'seed'`,
      [chapter.noteId, other.noteId]
    );
    const plan = await proofEdit(pool!, {
      count: 2,
      clearRelations: true,
      now: () => new Date(Date.now() - 60_000)
    });
    // One note per root in turn: the first of the book's root (a chapter's note comes second), then the loose source's.
    expect(plan.notes.map((note) => note.rootId).sort()).toEqual(
      [book.sourceId, other.sourceId].sort()
    );
    const rows = (
      await pool!.query<{ id: string; idea: string; protected: boolean }>(
        `select id::text, idea_statement as idea, metadata ->> 'humanProtected' = 'true' as protected
           from atomic_notes where id = any($1::uuid[])`,
        [plan.notes.map((note) => note.noteId)]
      )
    ).rows;
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.idea.endsWith(proofMarker)).toBe(true);
      expect(row.protected).toBe(true);
    }
    // The edit's vectors are gone and its re-embedding job is queued, as a person's edit leaves them.
    expect(
      (await pool!.query("select 1 from jobs where type = 'note-embedding' and status = 'queued'"))
        .rowCount
    ).toBe(2);
    expect((await pool!.query("select 1 from atomic_note_relations")).rowCount).toBe(0);
    // Ask again: MATCH is queued once per note (debounced), the second time into the same job.
    expect(await proofRequest(pool!, plan)).toBe(2);
    expect(await proofRequest(pool!, plan)).toBe(2);
    expect(
      (await pool!.query("select 1 from jobs where type = 'relation-match' and status = 'queued'"))
        .rowCount
    ).toBe(2);
    editedPlan = plan;
    // Nothing ran yet: the report reads empty jobs, no relation, and the planned notes' states.
    const report = await proofReport(pool!, plan);
    expect(report.matchJobs).toHaveLength(2);
    expect(report.matchJobs[0]).toMatchObject({
      status: "queued",
      outcome: null,
      fingerprinted: false
    });
    expect(report.relations).toEqual([]);
    expect(report.states).toHaveLength(2);
    expect(proofVerdict(plan, report, { requested: false }).ok).toBe(false);
  });

  it("reads what the app's jobs did and passes a run that left suggestions", async () => {
    const plan = editedPlan!;
    const db = pool!;
    const [first] = plan.notes;
    const [, second] = plan.notes;
    // The app's run: both notes' MATCH jobs decided, the first accepted a pair and its link run
    // left a suggestion named after the note; both notes keep the hash of the text they matched.
    await db.query(
      `update jobs set status = 'succeeded', outcome = 'done', attempts = 1, finished_at = now(),
         input_fingerprint = $1, result = '{"status":"completed","accepted":1}'::jsonb
       where type = 'relation-match'`,
      [`gf1:${"a".repeat(64)}`]
    );
    const jobId = (
      await db.query<{ id: string }>(
        "select id::text from jobs where type = 'relation-match' limit 1"
      )
    ).rows[0]!.id;
    await db.query(
      `insert into relation_match_runs (kind, root_id, title_key, title_params, job_id, finished_at, outcome)
       values ('link', $1, 'changes.titles.relationMatched', $2::jsonb, $3, now(), 'succeeded')`,
      [first!.rootId, JSON.stringify({ note: first!.title }), jobId]
    );
    await db.query(
      `insert into atomic_note_relations (source_atomic_note_id, target_atomic_note_id, band,
         relation_type, direction, direction_source, final_score, explanation)
       select least($1::uuid, $2::uuid), greatest($1::uuid, $2::uuid), 'suggest', 'supports',
              'lo_to_hi', 'typer', 0.8, 'seed'`,
      [first!.noteId, second!.noteId]
    );
    await db.query(
      "update note_match_state set input_hash = 'hash' where note_id = any($1::uuid[])",
      [plan.notes.map((note) => note.noteId)]
    );
    const report = await proofReport(db, plan);
    expect(report.matchJobs).toHaveLength(2);
    expect(report.matchJobs[0]).toMatchObject({
      status: "succeeded",
      outcome: "done",
      resultStatus: "completed",
      attempts: 1,
      fingerprinted: true,
      backlog: false,
      accepted: 1
    });
    expect(report.runs).toEqual([
      expect.objectContaining({ titleKey: "changes.titles.relationMatched", jobId })
    ]);
    expect(report.relations).toEqual([
      { band: "suggest", relationType: "supports", directionSource: "typer", shown: "unknown" }
    ]);
    expect(report.states.every((state) => state.hasHash)).toBe(true);
    expect(proofVerdict(plan, report, { requested: false })).toMatchObject({ ok: true });
    // The second round: a request for the same text is skipped by its fingerprint.
    await db.query(
      `insert into jobs (type, lane, status, outcome, attempts, finished_at, payload)
       select 'relation-match', 'light', 'succeeded', 'skipped', 1, now(),
              jsonb_build_object('noteId', n.id::text, 'rootId', n.id::text)
         from unnest($1::uuid[]) as n(id)`,
      [plan.notes.map((note) => note.noteId)]
    );
    const again = await proofReport(db, plan);
    expect(proofVerdict(plan, again, { requested: true })).toMatchObject({ ok: true });
    expect(proofVerdict(plan, again, { requested: false }).ok).toBe(false);
  });

  it("refuses to edit more notes than qualify", async () => {
    await expect(proofEdit(pool!, { count: 50, clearRelations: false })).rejects.toThrow("qualify");
  });
});
