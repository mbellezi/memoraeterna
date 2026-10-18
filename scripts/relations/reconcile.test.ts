import { createHash, randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  closePgPool,
  createAtomicNoteRelationRepository,
  createPgPool,
  createRelationDecisionRepository,
  createRelationEventRepository,
  createRelationMatchRunRepository,
  PostgresSidecarManager,
  resolvePostgresSidecarPaths,
  runMigrations,
  type PgPool
} from "@app/db";
import {
  provisionalRelationCalibrations,
  RelationCalibrationEntrySchema,
  renderRelationPairText,
  type RelationCalibrationEntry
} from "@app/domain";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  applyReconcilePlan,
  planReconcile,
  readCalibration,
  readReconcileState,
  renderReconcile,
  type StoredNote,
  type StoredRelation
} from "./reconcile.ts";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

const identity = {
  ...provisionalRelationCalibrations[0]!.identity,
  bodyCharacters: 600,
  rule: "mean" as const
};
const entry: RelationCalibrationEntry = RelationCalibrationEntrySchema.parse({
  kind: "isotonic",
  identity,
  blocks: [
    { fromScore: -10, probability: 0.02 },
    { fromScore: 0, probability: 0.45 },
    { fromScore: 2, probability: 0.83 },
    { fromScore: 4, probability: 0.96 }
  ],
  applyFrom: 4,
  suggestFrom: 2,
  basis: "test",
  labelSetHash: "1".repeat(64),
  freezeHash: "2".repeat(64),
  fittedAt: "2026-10-18T00:00:00.000Z",
  parity: { referenceHash: "3".repeat(64), scores: [0.5] }
});

const note = (id: string, body = "Short body."): StoredNote => ({
  id,
  title: `Title ${id}`,
  ideaStatement: `Idea ${id}`,
  bodyMarkdown: body
});
const hashOf = (value: StoredNote, body: number) => sha256(renderRelationPairText(value, body));

function relation(
  id: string,
  band: "apply" | "suggest" | null,
  loToHi: number | null,
  hiToLo: number | null,
  notes: Map<string, StoredNote>,
  body = 600
): StoredRelation {
  const lo = `${id}-lo`,
    hi = `${id}-hi`;
  if (!notes.has(lo)) notes.set(lo, note(lo));
  if (!notes.has(hi)) notes.set(hi, note(hi));
  return {
    id,
    lo,
    hi,
    band,
    probability: null,
    deciderKey: "key",
    direction: "lo_to_hi",
    directionSource: "typer",
    relationType: "supports",
    typerKey: null,
    vectorScore: null,
    graphScore: null,
    rerankScore: null,
    finalScore: 0.9,
    explanation: "x",
    matchingProfileId: null,
    matchingModel: null,
    metadata: {},
    decision:
      loToHi === null && hiToLo === null
        ? null
        : {
            scoreScale: "log_odds",
            loToHi,
            hiToLo,
            loHash: hashOf(notes.get(lo)!, body),
            hiHash: hashOf(notes.get(hi)!, body)
          }
  };
}

describe("the reconcile plan (D18)", () => {
  it("re-bands stored scores by kind, with the hysteresis and no model call", () => {
    const notes = new Map<string, StoredNote>();
    const relations = [
      relation("a", "apply", 5, 5, notes), // 5 -> 0.96: stays apply
      relation("b", "apply", 4, 3.2, notes), // mean 3.6 -> 0.83: suggest by band, held (>= 4 - 0.5)
      relation("c", "apply", 3, 1, notes), // mean 2 -> 0.83: below 3.5, so suggest
      relation("d", "suggest", 6, 4, notes), // mean 5 -> apply
      relation("e", "suggest", 0, -1, notes), // mean -0.5 -> 0.02: leaves the accept band
      relation("f", "apply", -3, -3, notes), // leaves
      relation("g", null, 5, 5, notes), // legacy
      relation("h", "suggest", null, null, notes) // no stored score
    ];
    const plan = planReconcile({ relations, notes, entry, source: "test" });
    expect(plan.considered).toBe(8);
    expect(plan.legacy).toBe(1);
    expect(plan.noScore).toBe(1);
    expect(plan.byKind).toEqual({
      "apply->suggest": 1,
      "suggest->apply": 1,
      "apply->none": 1,
      "suggest->none": 1
    });
    expect(
      plan.transitions.map((transition) => `${transition.id}:${transition.kind}`).sort()
    ).toEqual(["c:apply->suggest", "d:suggest->apply", "e:suggest->none", "f:apply->none"]);
    expect(plan.heldByHysteresis).toBe(1);
    expect(plan.kept).toBe(2);
    expect(plan.transitions.find((transition) => transition.id === "d")!.probability).toBe(0.96);
  });

  it("leaves a relation whose rendered input changed to the next match", () => {
    const notes = new Map<string, StoredNote>();
    const long = "x".repeat(700);
    notes.set("i-lo", note("i-lo", long));
    // Scored with the 400-character text: at 600 characters the decider would see another input.
    const changed = relation("i", "apply", 5, 5, notes, 400);
    const plan = planReconcile({ relations: [changed], notes, entry, source: "test" });
    expect(plan.inputChanged).toBe(1);
    expect(plan.transitions).toEqual([]);
    // A short note renders the same at 400 and 600 characters: its stored score still belongs.
    const notesShort = new Map<string, StoredNote>();
    const same = relation("j", "suggest", 5, 5, notesShort, 400);
    expect(
      planReconcile({ relations: [same], notes: notesShort, entry, source: "test" }).byKind[
        "suggest->apply"
      ]
    ).toBe(1);
  });

  it("counts stored scores without a relation that the bands would now accept", () => {
    const notes = new Map<string, StoredNote>([
      ["x", note("x")],
      ["y", note("y")],
      ["z", note("z")]
    ]);
    const decision = (lo: string, hi: string, score: number) => ({
      lo,
      hi,
      deciderKey: "key",
      scoreScale: "log_odds",
      loToHi: score,
      hiToLo: score,
      loHash: hashOf(notes.get(lo)!, 600),
      hiHash: hashOf(notes.get(hi)!, 600)
    });
    const plan = planReconcile({
      relations: [],
      notes,
      entry,
      source: "test",
      decisionsWithoutRelation: [
        decision("x", "y", 3),
        decision("x", "z", 9),
        decision("y", "z", -4)
      ]
    });
    expect(plan.entering).toEqual({ apply: 1, suggest: 1, inputChanged: 0 });
    expect(renderReconcile(plan, null)).toContain("Model calls: 0.");
  });

  it("reads a proposal for a dry run only, and a freeze record's entry", async () => {
    const directory = await mkdtemp(join(tmpdir(), "memora-reconcile-"));
    try {
      const proposal = {
        format: "memora-f3-bakeoff-proposal",
        computedAt: "2026-10-18T00:00:00.000Z",
        inputs: { labelSetSha256: "1".repeat(64) },
        deciders: [
          {
            runtime: "mlx",
            identity,
            blocks: entry.kind === "isotonic" ? entry.blocks : [],
            threshold: { edge: 2, basis: "plan decision 29" }
          }
        ]
      };
      await writeFile(join(directory, "proposal.json"), JSON.stringify(proposal));
      const fromProposal = await readCalibration({
        proposal: join(directory, "proposal.json"),
        runtime: "mlx"
      });
      expect(fromProposal.frozen).toBe(false);
      expect(fromProposal.entry).toMatchObject({
        kind: "isotonic",
        applyFrom: null,
        suggestFrom: 2
      });
      await writeFile(
        join(directory, "frozen.json"),
        JSON.stringify({
          configHash: "c".repeat(64),
          frozenAt: "2026-10-19T00:00:00.000Z",
          calibrations: [entry]
        })
      );
      const fromFreeze = await readCalibration({
        frozen: join(directory, "frozen.json"),
        runtime: "mlx"
      });
      expect(fromFreeze).toMatchObject({ frozen: true, version: "c".repeat(64) });
      await expect(
        readCalibration({ frozen: join(directory, "frozen.json"), runtime: "gguf" })
      ).rejects.toThrow("no gguf calibration");
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});

const workspace = resolve(import.meta.dirname, "..", "..");
const sidecar = resolvePostgresSidecarPaths({ cwd: workspace, env: process.env });
const sidecarInstalled = existsSync(join(sidecar.binDir, "postgres"));

describe.skipIf(!sidecarInstalled)("reconcile on a real PostgreSQL database", () => {
  let workDir = "";
  let manager: PostgresSidecarManager | undefined;
  let pool: PgPool | undefined;
  const db = () => pool!;
  const work = { source: "", chunk: "" };

  async function addNote(title: string, body: string): Promise<StoredNote> {
    const id = randomUUID();
    await db().query(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, status, supersession_status,
       created_from_source_item_id, evidence_chunk_id, generation_provider, generation_model,
       generation_runtime, generation_prompt_version, generation_key, ownership)
       values ($1::uuid, $2, $3, $4, 'active', 'current', $5, $6, 'test', 'test', 'local', 'test', $1::uuid::text, 'source')`,
      [id, title, body, `Idea of ${title}`, work.source, work.chunk]
    );
    return { id, title, ideaStatement: `Idea of ${title}`, bodyMarkdown: body };
  }

  /** A relation decided by key `ranker`, with its stored scores at `body` characters. */
  async function decided(
    band: "apply" | "suggest",
    score: number,
    runId: string,
    status?: "accepted"
  ) {
    const [a, b] = [await addNote("A", "Body a"), await addNote("B", "Body b")];
    const [lo, hi] = a.id < b.id ? [a, b] : [b, a];
    await createRelationDecisionRepository(db()).recordRankerScores({
      loAtomicNoteId: lo.id,
      hiAtomicNoteId: hi.id,
      loInputHash: sha256(renderRelationPairText(lo, 600)),
      hiInputHash: sha256(renderRelationPairText(hi, 600)),
      deciderKey: "ranker",
      loToHi: score,
      hiToLo: score,
      aiTaskRunId: null
    });
    const written = await createAtomicNoteRelationRepository(db()).upsert({
      loAtomicNoteId: lo.id,
      hiAtomicNoteId: hi.id,
      direction: "lo_to_hi",
      relationType: "supports",
      band,
      probability: null,
      deciderKey: "ranker",
      finalScore: 0.9,
      explanation: "knowledge.relations.explanations.reranked",
      runId,
      ...(status ? { status } : {})
    });
    return written.relation.id;
  }

  const snapshot = async () =>
    (
      await db().query<{ image: string }>(
        "select to_jsonb(r)::text as image from atomic_note_relations r order by r.id"
      )
    ).rows.map((row) => row.image);

  beforeAll(async () => {
    workDir = await mkdtemp(join(tmpdir(), "memora-reconcile-db-"));
    manager = new PostgresSidecarManager({
      binDir: sidecar.binDir,
      dataDir: join(workDir, "data"),
      database: "memora_reconcile_test",
      user: "memora_reconcile_test",
      password: `reconcile-${randomUUID()}`,
      startupTimeoutMs: 30_000,
      shutdownTimeoutMs: 10_000
    });
    const connection = await manager.start();
    pool = createPgPool({ connectionString: connection.connectionString, max: 4 });
    await runMigrations(pool, resolve(workspace, "packages/db/drizzle"), {
      seedFolder: resolve(workspace, "packages/db/seed")
    });
    work.source = randomUUID();
    const document = randomUUID();
    work.chunk = randomUUID();
    await db().query(
      "insert into source_items (id, type, title) values ($1, 'StandaloneArticle', 'Work')",
      [work.source]
    );
    await db().query(
      `insert into documents (id, source_item_id, title, canonical_markdown, content_hash) values ($1, $2, 'Document', 'text', 'doc')`,
      [document, work.source]
    );
    await db().query(
      `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash) values ($1, $2, $3, 0, 'Passage', 'chunk')`,
      [work.chunk, document, work.source]
    );
  }, 120_000);

  afterAll(async () => {
    if (pool) await closePgPool(pool);
    if (manager) await manager.stop().catch(() => undefined);
    if (workDir) await rm(workDir, { recursive: true, force: true });
  });

  it("writes one reconcile run with its events, never touches a reviewed row, and reverts exactly", async () => {
    const runs = createRelationMatchRunRepository(db());
    const link = await runs.start({ kind: "link" });
    const promoted = await decided("suggest", 5, link.id); // -> apply
    const demoted = await decided("apply", 2.5, link.id); // mean 2.5 -> suggest (below 4 - 0.5)
    const dropped = await decided("suggest", -3, link.id); // -> leaves the band
    const reviewed = await decided("apply", -3, link.id, "accepted"); // a human verdict: not considered
    await runs.finish(link.id, { outcome: "completed" });
    // A recalibration decides no direction: the decider's stays what it was (decision 31b).
    await db().query(
      "update atomic_note_relations set direction_source = 'decider' where id = $1",
      [promoted]
    );
    const before = await snapshot();

    const state = await readReconcileState(db());
    expect(state.relations.map((row) => row.id).sort()).toEqual(
      [promoted, demoted, dropped].sort()
    );
    expect(state.relations.find((row) => row.id === reviewed)).toBeUndefined();
    const plan = planReconcile({ ...state, entry, source: "test" });
    expect(plan.byKind).toEqual({
      "apply->suggest": 1,
      "suggest->apply": 1,
      "apply->none": 0,
      "suggest->none": 1
    });

    const applied = await applyReconcilePlan({
      pool: db(),
      plan,
      relations: state.relations,
      calibrationVersion: "f".repeat(64)
    });
    expect(applied).toMatchObject({
      changed: 2,
      deleted: 1,
      skipped: 0,
      events: { reconciled: 3 }
    });
    const run = await runs.get(applied.runId);
    expect(run).toMatchObject({
      kind: "reconcile",
      outcome: "completed",
      calibrationVersion: "f".repeat(64)
    });
    const bands = new Map(
      (
        await db().query<{ id: string; band: string }>("select id, band from atomic_note_relations")
      ).rows.map((row) => [row.id, row.band])
    );
    expect(bands.get(promoted)).toBe("apply");
    expect(bands.get(demoted)).toBe("suggest");
    expect(bands.has(dropped)).toBe(false);
    expect(bands.get(reviewed)).toBe("apply");
    expect(
      (
        await db().query<{ direction_source: string }>(
          "select direction_source from atomic_note_relations where id = $1",
          [promoted]
        )
      ).rows[0]
    ).toEqual({ direction_source: "decider" });

    const reverted = await createRelationEventRepository(db()).revertRun(applied.runId);
    expect(reverted.kind).toBe("reverted");
    expect(await snapshot()).toEqual(before);
  });
});
