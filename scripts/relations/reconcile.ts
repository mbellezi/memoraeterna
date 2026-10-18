/**
 * Recalibration without deciding again (F3 D14, D18; spec 3.9, T58): re-applies a calibration's bands
 * to the stored raw ranker scores of a library's relations, with 0 model calls.
 *
 *   npx tsx scripts/relations/reconcile.ts --db <connection.json | postgres url>
 *       [--frozen .cache/f3/freeze/frozen.json | --proposal .cache/f3/freeze/proposal.json]
 *       [--runtime mlx|gguf] [--apply] [--json <out.json>] [--out <out.md>]
 *
 * `--dry-run` (the default) reports the transitions the calibration would make, by kind, in one
 * read-only snapshot. `--apply` (a frozen calibration only, DEV) writes them in one transaction: one
 * `relation_match_runs` row of kind `reconcile`, a `reconciled` event per change through the canonical
 * upsert, and for a relation that leaves the accept band its deletion with the event holding its row,
 * so the D14 helper (`revertRun`) reverts the run exactly. Rows a person reviewed are never touched.
 *
 * A stored score belongs to the new calibration only when the decider saw the same input: the stored
 * rendered-input hashes must equal the note text rendered with the calibration's body characters
 * (D13). A relation whose input changed (another template length, an edited note) is left to the next
 * match, which decides it again; the report counts it. The instruction cannot be read back from a
 * stored row: the report names the instruction hash it assumes. Pairs a stored score now puts in the
 * accept band that have no relation are counted, not created (they need typing, a model call).
 * Loopback connections only; the connection string is never printed.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { parseArgs } from "node:util";

import {
  closePgPool,
  createAtomicNoteRelationRepository,
  createPgPool,
  createRelationEventRepository,
  createRelationMatchRunRepository,
  noteRelationStateSql,
  shownNoteRelationSql,
  withTransaction,
  type JsonObject,
  type Queryable
} from "@app/db";
import {
  aggregateDirections,
  bandScore,
  reconcileBands,
  RelationCalibrationEntrySchema,
  relationsConfig,
  renderRelationPairText,
  type NoteRelationDirection,
  type RelationCalibrationEntry
} from "@app/domain";
import { z } from "zod";

import { frozenFileLocation } from "../golden/freeze-guard.ts";
import {
  createReadOnlyClient,
  resolveEvaluationConnection
} from "../golden/matching-evaluation-db.ts";

export const reconcileTask = "T58";

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

/** A banded relation with no human verdict, with the stored scores of its decider. */
export interface StoredRelation {
  id: string;
  lo: string;
  hi: string;
  band: "apply" | "suggest" | null;
  probability: number | null;
  deciderKey: string | null;
  direction: NoteRelationDirection;
  relationType: string | null;
  typerKey: string | null;
  vectorScore: number | null;
  graphScore: number | null;
  rerankScore: number | null;
  finalScore: number;
  explanation: string;
  matchingProfileId: string | null;
  matchingModel: string | null;
  metadata: JsonObject;
  /** The stored decision of `deciderKey`, null when there is none. */
  decision: {
    scoreScale: string;
    loToHi: number | null;
    hiToLo: number | null;
    loHash: string;
    hiHash: string;
  } | null;
}

export interface StoredNote {
  id: string;
  title: string;
  ideaStatement: string;
  bodyMarkdown: string;
}

/** A stored decision with no relation (any decider key the relations use). */
export interface StoredDecision {
  lo: string;
  hi: string;
  deciderKey: string;
  scoreScale: string;
  loToHi: number | null;
  hiToLo: number | null;
  loHash: string;
  hiHash: string;
}

export type TransitionKind = "apply->suggest" | "suggest->apply" | "apply->none" | "suggest->none";

export interface PlannedTransition {
  id: string;
  lo: string;
  hi: string;
  kind: TransitionKind;
  from: "apply" | "suggest";
  to: "apply" | "suggest" | null;
  score: number;
  probability: number | null;
}

export interface ReconcilePlan {
  calibration: {
    source: string;
    rule: string;
    bodyCharacters: number;
    instructionSha256: string;
    pApply: number;
    pSuggest: number | null;
  };
  considered: number;
  legacy: number;
  noScore: number;
  inputChanged: number;
  kept: number;
  /** Kept in `apply` by the hysteresis although the new band would move them. */
  heldByHysteresis: number;
  transitions: PlannedTransition[];
  byKind: Record<TransitionKind, number>;
  /** Stored scores without a relation that the new bands would accept (left to the next match). */
  entering: { apply: number; suggest: number; inputChanged: number };
}

const emptyKinds = (): Record<TransitionKind, number> => ({
  "apply->suggest": 0,
  "suggest->apply": 0,
  "apply->none": 0,
  "suggest->none": 0
});

/** The score of a stored decision under the calibration, or why there is none. */
function storedScore(
  decision: {
    scoreScale: string;
    loToHi: number | null;
    hiToLo: number | null;
    loHash: string;
    hiHash: string;
  } | null,
  lo: string,
  hi: string,
  notes: ReadonlyMap<string, StoredNote>,
  entry: RelationCalibrationEntry
): { score: number } | "no-score" | "input-changed" {
  if (
    !decision ||
    decision.scoreScale !== "log_odds" ||
    decision.loToHi === null ||
    decision.hiToLo === null
  )
    return "no-score";
  const render = (id: string) => {
    const note = notes.get(id);
    return note ? sha256(renderRelationPairText(note, entry.identity.bodyCharacters)) : null;
  };
  if (render(lo) !== decision.loHash || render(hi) !== decision.hiHash) return "input-changed";
  return { score: aggregateDirections(decision.loToHi, decision.hiToLo, entry.identity.rule) };
}

/** The transitions a calibration makes on stored scores (pure; `reconcileBands` with the hysteresis). */
export function planReconcile(input: {
  relations: readonly StoredRelation[];
  notes: ReadonlyMap<string, StoredNote>;
  entry: RelationCalibrationEntry;
  source: string;
  hysteresis?: number;
  uncalibratedPass?: number;
  decisionsWithoutRelation?: readonly StoredDecision[];
}): ReconcilePlan {
  const hysteresis = input.hysteresis ?? relationsConfig.hysteresisLogOdds;
  const pass =
    input.uncalibratedPass ??
    relationsConfig.decide.uncalibratedPass.logOdds[input.entry.identity.runtimeKind];
  let legacy = 0,
    noScore = 0,
    inputChanged = 0;
  const rows: Array<{
    id: string;
    score: number;
    band: "apply" | "suggest";
    relation: StoredRelation;
  }> = [];
  for (const relation of input.relations) {
    if (relation.band === null) {
      legacy++;
      continue;
    }
    const outcome = storedScore(
      relation.decision,
      relation.lo,
      relation.hi,
      input.notes,
      input.entry
    );
    if (outcome === "no-score") noScore++;
    else if (outcome === "input-changed") inputChanged++;
    else rows.push({ id: relation.id, score: outcome.score, band: relation.band, relation });
  }
  const transitions = reconcileBands({
    rows,
    entry: input.entry,
    uncalibratedPass: pass,
    hysteresis
  });
  const byId = new Map(rows.map((row) => [row.id, row]));
  const planned: PlannedTransition[] = transitions.map((transition) => {
    const row = byId.get(transition.id)!;
    return {
      id: transition.id,
      lo: row.relation.lo,
      hi: row.relation.hi,
      kind: `${transition.from}->${transition.to ?? "none"}` as TransitionKind,
      from: transition.from,
      to: transition.to,
      score: row.score,
      probability: transition.probability
    };
  });
  const byKind = emptyKinds();
  for (const transition of planned) byKind[transition.kind]++;
  const heldByHysteresis = rows.filter(
    (row) =>
      row.band === "apply" &&
      bandScore(row.score, input.entry, pass).band !== "apply" &&
      !planned.some((transition) => transition.id === row.id)
  ).length;
  const entering = { apply: 0, suggest: 0, inputChanged: 0 };
  for (const decision of input.decisionsWithoutRelation ?? []) {
    const outcome = storedScore(decision, decision.lo, decision.hi, input.notes, input.entry);
    if (outcome === "input-changed") {
      entering.inputChanged++;
      continue;
    }
    if (outcome === "no-score") continue;
    const band = bandScore(outcome.score, input.entry, pass).band;
    if (band) entering[band]++;
  }
  const entry = input.entry;
  return {
    calibration: {
      source: input.source,
      rule: entry.identity.rule,
      bodyCharacters: entry.identity.bodyCharacters,
      instructionSha256: entry.identity.instructionSha256,
      pApply: entry.kind === "isotonic" ? entry.pApply : entry.applyAt,
      pSuggest: entry.kind === "isotonic" ? entry.pSuggest : entry.suggestAt
    },
    considered: input.relations.length,
    legacy,
    noScore,
    inputChanged,
    kept: rows.length - planned.length,
    heldByHysteresis,
    transitions: planned,
    byKind,
    entering
  };
}

// --- The database ------------------------------------------------------------------------------

interface RelationRow {
  id: string;
  lo: string;
  hi: string;
  band: "apply" | "suggest" | null;
  probability: number | null;
  deciderKey: string | null;
  direction: NoteRelationDirection;
  relationType: string | null;
  typerKey: string | null;
  vectorScore: number | null;
  graphScore: number | null;
  rerankScore: number | null;
  finalScore: number;
  explanation: string;
  matchingProfileId: string | null;
  matchingModel: string | null;
  metadata: JsonObject | null;
  scoreScale: string | null;
  loToHi: number | null;
  hiToLo: number | null;
  loHash: string | null;
  hiHash: string | null;
}

const numberOrNull = (value: unknown) =>
  value === null || value === undefined ? null : Number(value);

/** Shown relations with no human verdict (the D9 predicates), their stored scores and their notes. */
export async function readReconcileState(db: Queryable): Promise<{
  relations: StoredRelation[];
  notes: Map<string, StoredNote>;
  decisionsWithoutRelation: StoredDecision[];
}> {
  const relationRows = (
    await db.query<RelationRow>(
      `select r.id, r.source_atomic_note_id as lo, r.target_atomic_note_id as hi, r.band, r.probability,
              r.decider_key as "deciderKey", r.direction, r.relation_type as "relationType",
              r.typer_key as "typerKey", r.vector_score as "vectorScore", r.graph_score as "graphScore",
              r.rerank_score as "rerankScore", r.final_score as "finalScore", r.explanation,
              r.matching_profile_id as "matchingProfileId", r.matching_model as "matchingModel", r.metadata,
              d.score_scale as "scoreScale", d.lo_to_hi_score as "loToHi", d.hi_to_lo_score as "hiToLo",
              d.lo_content_hash as "loHash", d.hi_content_hash as "hiHash"
         from atomic_note_relations r
         left join relation_decisions d
           on d.lo_atomic_note_id = r.source_atomic_note_id and d.hi_atomic_note_id = r.target_atomic_note_id
          and d.decider_key = r.decider_key
        where ${shownNoteRelationSql("r")} and ${noteRelationStateSql.undecidedByHuman("r")}
        order by r.id`
    )
  ).rows;
  const relations: StoredRelation[] = relationRows.map((row) => ({
    id: row.id,
    lo: row.lo,
    hi: row.hi,
    band: row.band,
    probability: numberOrNull(row.probability),
    deciderKey: row.deciderKey,
    direction: row.direction,
    relationType: row.relationType,
    typerKey: row.typerKey,
    vectorScore: numberOrNull(row.vectorScore),
    graphScore: numberOrNull(row.graphScore),
    rerankScore: numberOrNull(row.rerankScore),
    finalScore: Number(row.finalScore),
    explanation: row.explanation,
    matchingProfileId: row.matchingProfileId,
    matchingModel: row.matchingModel,
    metadata: row.metadata ?? {},
    decision:
      row.scoreScale === null
        ? null
        : {
            scoreScale: row.scoreScale,
            loToHi: numberOrNull(row.loToHi),
            hiToLo: numberOrNull(row.hiToLo),
            loHash: row.loHash ?? "",
            hiHash: row.hiHash ?? ""
          }
  }));
  const keys = [
    ...new Set(relations.flatMap((relation) => (relation.deciderKey ? [relation.deciderKey] : [])))
  ];
  const decisionRows = keys.length
    ? (
        await db.query<{
          lo: string;
          hi: string;
          deciderKey: string;
          scoreScale: string;
          loToHi: number | null;
          hiToLo: number | null;
          loHash: string;
          hiHash: string;
        }>(
          `select d.lo_atomic_note_id as lo, d.hi_atomic_note_id as hi, d.decider_key as "deciderKey",
                  d.score_scale as "scoreScale", d.lo_to_hi_score as "loToHi", d.hi_to_lo_score as "hiToLo",
                  d.lo_content_hash as "loHash", d.hi_content_hash as "hiHash"
             from relation_decisions d
            where d.decider_key = any($1::text[])
              and not exists (select 1 from atomic_note_relations x
                               where x.source_atomic_note_id = d.lo_atomic_note_id
                                 and x.target_atomic_note_id = d.hi_atomic_note_id)
            order by d.lo_atomic_note_id, d.hi_atomic_note_id`,
          [keys]
        )
      ).rows
    : [];
  const decisionsWithoutRelation = decisionRows.map((row) => ({
    ...row,
    loToHi: numberOrNull(row.loToHi),
    hiToLo: numberOrNull(row.hiToLo)
  }));
  const ids = [
    ...new Set([...relations, ...decisionsWithoutRelation].flatMap((row) => [row.lo, row.hi]))
  ];
  const noteRows = ids.length
    ? (
        await db.query<StoredNote>(
          `select n.id, n.title, n.idea_statement as "ideaStatement", n.body_markdown as "bodyMarkdown"
             from atomic_notes n where n.id = any($1::uuid[])`,
          [ids]
        )
      ).rows
    : [];
  return {
    relations,
    notes: new Map(noteRows.map((note) => [note.id, note])),
    decisionsWithoutRelation
  };
}

export interface ReconcileApplied {
  runId: string;
  changed: number;
  deleted: number;
  /** Rows a person reviewed in the meantime: left as they are. */
  skipped: number;
  events: Record<string, number>;
}

/**
 * Writes a plan as one `reconcile` run in one transaction (D14): a band change through the canonical
 * upsert (its `reconciled` event in the same statement), a relation leaving the accept band deleted
 * with an event that keeps its row.
 */
export async function applyReconcilePlan(input: {
  pool: Parameters<typeof withTransaction>[0];
  plan: ReconcilePlan;
  relations: readonly StoredRelation[];
  calibrationVersion: string;
}): Promise<ReconcileApplied> {
  const byId = new Map(input.relations.map((relation) => [relation.id, relation]));
  const events = createRelationEventRepository(input.pool);
  const result = await withTransaction(input.pool, async (client) => {
    const runs = createRelationMatchRunRepository(client);
    const run = await runs.start({
      kind: "reconcile",
      calibrationVersion: input.calibrationVersion
    });
    const relations = createAtomicNoteRelationRepository(client);
    let changed = 0,
      deleted = 0,
      skipped = 0;
    for (const transition of input.plan.transitions) {
      const relation = byId.get(transition.id)!;
      if (transition.to) {
        const written = await relations.upsert({
          loAtomicNoteId: relation.lo,
          hiAtomicNoteId: relation.hi,
          direction: relation.direction as Exclude<NoteRelationDirection, "unknown">,
          relationType: relation.relationType,
          band: transition.to,
          probability: transition.probability,
          deciderKey: relation.deciderKey,
          typerKey: relation.typerKey,
          vectorScore: relation.vectorScore,
          graphScore: relation.graphScore,
          rerankScore: relation.rerankScore,
          finalScore: transition.probability ?? relation.finalScore,
          explanation: relation.explanation,
          matchingProfileId: relation.matchingProfileId,
          matchingModel: relation.matchingModel,
          metadata: relation.metadata,
          runId: run.id
        });
        if (written.change === "updated") changed++;
        else skipped++;
        continue;
      }
      const removed = (
        await client.query<{ image: JsonObject; pairKey: string }>(
          `delete from atomic_note_relations r
            where r.id = $1::uuid and ${noteRelationStateSql.undecidedByHuman("r")}
           returning to_jsonb(r) as image, r.source_atomic_note_id::text || ':' || r.target_atomic_note_id::text as "pairKey"`,
          [transition.id]
        )
      ).rows[0];
      if (!removed) {
        skipped++;
        continue;
      }
      await events.append(
        {
          runId: run.id,
          relationKind: "note",
          relationId: transition.id,
          pairKey: removed.pairKey,
          kind: "reconciled",
          before: removed.image,
          after: null
        },
        client
      );
      deleted++;
    }
    const counts = { changed, deleted, skipped, ...input.plan.byKind };
    await runs.finish(run.id, { outcome: "completed", counts });
    return { runId: run.id, changed, deleted, skipped };
  });
  return { ...result, events: await events.countByKind(result.runId) };
}

// --- The calibration to reconcile to ---------------------------------------------------------------

const freezeRecordSchema = z
  .object({
    configHash: z.string().min(8),
    frozenAt: z.string(),
    calibrations: z.array(RelationCalibrationEntrySchema)
  })
  .passthrough();

const proposalSchema = z
  .object({
    format: z.literal("memora-f3-bakeoff-proposal"),
    computedAt: z.string(),
    inputs: z.record(z.string(), z.string()),
    deciders: z.array(
      z
        .object({
          runtime: z.enum(["mlx", "gguf"]),
          identity: z.unknown(),
          blocks: z.unknown(),
          bands: z
            .object({ pApply: z.number().nullable(), pSuggest: z.number().nullable() })
            .passthrough()
        })
        .passthrough()
    )
  })
  .passthrough();

const zeroHash = "0".repeat(64);

/** The entry of a runtime from a freeze record (apply allowed) or a proposal (dry run only). */
export async function readCalibration(input: {
  frozen?: string;
  proposal?: string;
  runtime: "mlx" | "gguf";
}): Promise<{ entry: RelationCalibrationEntry; version: string; frozen: boolean; source: string }> {
  if (input.proposal) {
    const proposal = proposalSchema.parse(JSON.parse(await readFile(input.proposal, "utf8")));
    const decider = proposal.deciders.find((candidate) => candidate.runtime === input.runtime);
    if (!decider) throw new Error(`The proposal has no ${input.runtime} decider.`);
    const entry = RelationCalibrationEntrySchema.parse({
      kind: "isotonic",
      identity: decider.identity,
      blocks: decider.blocks,
      pApply: decider.bands.pApply ?? 1,
      pSuggest: decider.bands.pSuggest,
      labelSetHash: proposal.inputs.labelSetSha256 ?? zeroHash,
      freezeHash: zeroHash,
      fittedAt: proposal.computedAt,
      parity: { referenceHash: zeroHash, scores: [0] }
    });
    return {
      entry,
      version: `proposal:${proposal.computedAt}`,
      frozen: false,
      source: `proposal ${input.proposal} (not frozen)`
    };
  }
  const path = input.frozen ?? frozenFileLocation();
  const record = freezeRecordSchema.parse(JSON.parse(await readFile(path, "utf8")));
  const entry = record.calibrations.find(
    (candidate) => candidate.identity.runtimeKind === input.runtime
  );
  if (!entry) throw new Error(`The freeze has no ${input.runtime} calibration.`);
  return {
    entry,
    version: record.configHash,
    frozen: true,
    source: `frozen ${record.configHash.slice(0, 16)} (${record.frozenAt})`
  };
}

// --- Report and CLI ------------------------------------------------------------------------------

export function renderReconcile(plan: ReconcilePlan, applied: ReconcileApplied | null): string {
  const lines = [
    `# Reconcile ${applied ? "applied" : "dry run"} (${reconcileTask})`,
    "",
    `Calibration: ${plan.calibration.source}; rule ${plan.calibration.rule}, ${plan.calibration.bodyCharacters} body characters, instruction sha256 ${plan.calibration.instructionSha256.slice(0, 12)}... (assumed for the stored scores), p_apply ${plan.calibration.pApply}, p_suggest ${plan.calibration.pSuggest ?? "none"}. Model calls: 0.`,
    "",
    "| Relations (shown, no human verdict) | Count |",
    "| --- | ---: |",
    `| Considered | ${plan.considered} |`,
    `| Legacy (no band; never reconciled) | ${plan.legacy} |`,
    `| No stored log-odds of both directions | ${plan.noScore} |`,
    `| Input changed (rendered text differs at ${plan.calibration.bodyCharacters} characters: decided again by the next match) | ${plan.inputChanged} |`,
    `| Unchanged band | ${plan.kept} |`,
    `| Held in apply by the hysteresis | ${plan.heldByHysteresis} |`,
    ...Object.entries(plan.byKind).map(([kind, count]) => `| ${kind} | ${count} |`),
    "",
    `Stored scores with no relation that the bands would accept (left to the next match, which types them): apply ${plan.entering.apply}, suggest ${plan.entering.suggest}; ${plan.entering.inputChanged} more have another rendered input.`,
    ""
  ];
  if (applied)
    lines.push(
      `Run ${applied.runId}: ${applied.changed} re-banded, ${applied.deleted} left the accept band, ${applied.skipped} skipped (reviewed meanwhile); events ${JSON.stringify(applied.events)}. Revert with the D14 helper (relationEventRepository.revertRun).`,
      ""
    );
  return `${lines.join("\n")}\n`;
}

export async function runReconcileCli(argv: string[]): Promise<void> {
  const { values } = parseArgs({
    args: argv,
    options: {
      db: { type: "string" },
      frozen: { type: "string" },
      proposal: { type: "string" },
      runtime: { type: "string" },
      apply: { type: "boolean" },
      "dry-run": { type: "boolean" },
      json: { type: "string" },
      out: { type: "string" }
    },
    strict: true
  });
  if (!values.db)
    throw new Error("--db is required (a loopback connection file or postgres:// URL).");
  if (values.apply && values["dry-run"])
    throw new Error("--apply and --dry-run exclude each other.");
  if (values.apply && values.proposal)
    throw new Error("--apply writes a frozen calibration only (D3): drop --proposal.");
  const runtime = z.enum(["mlx", "gguf"]).parse(values.runtime ?? "mlx");
  const calibration = await readCalibration({
    runtime,
    ...(values.frozen ? { frozen: resolve(values.frozen) } : {}),
    ...(values.proposal ? { proposal: resolve(values.proposal) } : {})
  });
  const connection = await resolveEvaluationConnection(
    /^postgres(ql)?:\/\//iu.test(values.db) ? values.db : resolve(values.db)
  );
  let plan: ReconcilePlan;
  let applied: ReconcileApplied | null = null;
  if (!values.apply) {
    const client = createReadOnlyClient(connection.connectionString);
    await client.connect();
    try {
      await client.query("begin transaction isolation level repeatable read read only");
      const state = await readReconcileState(client);
      await client.query("commit");
      plan = planReconcile({ ...state, entry: calibration.entry, source: calibration.source });
    } finally {
      await client.end();
    }
  } else {
    const pool = createPgPool({ connectionString: connection.connectionString, max: 2 });
    try {
      const state = await readReconcileState(pool);
      plan = planReconcile({ ...state, entry: calibration.entry, source: calibration.source });
      applied = await applyReconcilePlan({
        pool,
        plan,
        relations: state.relations,
        calibrationVersion: calibration.version
      });
    } finally {
      await closePgPool(pool);
    }
  }
  const report = renderReconcile(plan, applied);
  if (values.out) await writeFile(resolve(values.out), report);
  if (values.json)
    await writeFile(resolve(values.json), `${JSON.stringify({ plan, applied }, null, 1)}\n`);
  console.info(report);
}

if (import.meta.main) {
  try {
    await runReconcileCli(process.argv.slice(2));
  } catch (error) {
    console.error(
      `[relations/reconcile] ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
}
