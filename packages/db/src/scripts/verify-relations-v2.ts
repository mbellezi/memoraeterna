import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";

import pg from "pg";

import { closePgPool, createPgPool, type PgPool } from "../client.js";
import { runMigrations } from "../migrations.js";
import { createChunkRepository } from "../repositories/chunkRepository.js";
import { createDocumentRepository } from "../repositories/documentRepository.js";
import {
  currentSourceRelationEvidenceSql,
  noteRelationFingerprintSql,
  sourceRelationEvidenceJoins
} from "../repositories/sourceRelationRepository.js";
import { createRelationEventRepository } from "../repositories/relationEventRepository.js";
import { createSourceItemRepository } from "../repositories/sourceItemRepository.js";
import { PostgresSidecarManager, resolvePostgresSidecarPaths } from "../sidecar/index.js";

/**
 * Real-PostgreSQL verification of migration 0056 `relations_v2` (F3 T48; docs/f3-decisions.md D8-D12,
 * D14 and the F3 spec, section 4.1). This file and the migration are the only code that reads the
 * legacy direction keys of a relation's `metadata` (`relation-direction-metadata.test.ts`).
 *
 *   npm run db:relations:verify
 *       A temporary PostgreSQL sidecar (never an existing database): a library at 0055 with note
 *       relations of every metadata shape and current, stale, rejected and discarded-note source
 *       evidence gets 0056 (and any later migration) as pending; the direction backfill, untouched
 *       metadata, the facts-only evidence fingerprint and equal current-evidence counts are
 *       checked, then the constraints, an empty database through the baseline seed (same shape),
 *       and a migration killed mid-transaction (nothing changes).
 *   npm run db:relations:verify -- --db <postgres URL | scratch connection .json>
 *       An existing scratch database (a restore or an APFS clone, never a live profile, gate M). At
 *       0055 every pending migration (0056 first, then 0057 and 0058) is applied here, timed, with
 *       0056's report captured, and every relation is compared with its state before; with 0056
 *       already applied the state is checked. Prints one JSON summary.
 *
 * Migration 0059 `relation_direction_source` (plan decision 31b) is verified here too: a library at
 * 0058 with automatic relations of every kind gets it as pending, and an existing database that
 * holds 0056 and not 0059 gets it before its invariants are read.
 *
 * Database invariants: I-R1 (canonical pair and direction, and where a direction came from), I-R7 (the same current evidence under
 * the facts-only fingerprint, when this run migrates), and the stored halves of I-R2/I-R3 (no event
 * of an automatic run on a pair with a human verdict) and I-R8 (every banded or vetoed note relation
 * has its event). I-R4 to I-R6, I-R8's exact revert and I-R9 are properties of code, proven by their
 * tests (`elsewhere` in the summary).
 */
export const relationsV2Tag = "0056_relations_v2";
/** Plan decision 31b: where a note relation's direction came from. */
export const directionSourceTag = "0059_relation_direction_source";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const workspaceRoot = resolve(packageRoot, "../..");
const migrationsFolder = resolve(packageRoot, "drizzle");
const seedFolder = resolve(packageRoot, "seed");

const semanticSource = "semanticSourceAtomicNoteId";
const semanticTarget = "semanticTargetAtomicNoteId";

type Direction = "lo_to_hi" | "hi_to_lo" | "symmetric" | "unknown";

/** How a legacy relation's matching metadata names (or fails to name) its pair. */
type MetadataShape =
  | "lo_hi"
  | "hi_lo"
  | "lo_hi_upper"
  | "none"
  | "third"
  | "source_only"
  | "same_twice"
  | "not_strings";

/** Note relations as matchers before relations v2 left them, with the direction 0056 gives each. */
export interface LegacyRelationShape {
  name: string;
  type: string;
  status: "pending_review" | "accepted" | "rejected";
  metadata: MetadataShape;
  /** Stored with the higher UUID in the source column (no matcher did; the migration sorts it). */
  storedHighToLow?: boolean;
  expected: Direction;
}

export const legacyRelationShapes: readonly LegacyRelationShape[] = [
  {
    name: "directed, decided lo -> hi",
    type: "supports",
    status: "pending_review",
    metadata: "lo_hi",
    expected: "lo_to_hi"
  },
  {
    name: "directed, decided hi -> lo",
    type: "extends",
    status: "pending_review",
    metadata: "hi_lo",
    expected: "hi_to_lo"
  },
  {
    name: "stored high-to-low, decided hi -> lo",
    type: "depends_on",
    status: "pending_review",
    metadata: "hi_lo",
    storedHighToLow: true,
    expected: "hi_to_lo"
  },
  {
    name: "stored high-to-low, decided lo -> hi",
    type: "clarifies",
    status: "pending_review",
    metadata: "lo_hi",
    storedHighToLow: true,
    expected: "lo_to_hi"
  },
  {
    name: "symmetric type with metadata",
    type: "contrasts",
    status: "pending_review",
    metadata: "hi_lo",
    expected: "symmetric"
  },
  {
    name: "symmetric type without metadata",
    type: "similar_to",
    status: "pending_review",
    metadata: "none",
    expected: "symmetric"
  },
  {
    name: "neutral type keeps its decided direction",
    type: "related",
    status: "pending_review",
    metadata: "hi_lo",
    expected: "hi_to_lo"
  },
  {
    name: "legacy mentions",
    type: "mentions",
    status: "pending_review",
    metadata: "lo_hi",
    expected: "lo_to_hi"
  },
  {
    name: "no decision metadata",
    type: "supports",
    status: "pending_review",
    metadata: "none",
    expected: "unknown"
  },
  {
    name: "metadata naming another note",
    type: "clarifies",
    status: "pending_review",
    metadata: "third",
    expected: "unknown"
  },
  {
    name: "metadata with only one key",
    type: "supports",
    status: "pending_review",
    metadata: "source_only",
    expected: "unknown"
  },
  {
    name: "metadata naming one note twice",
    type: "extends",
    status: "pending_review",
    metadata: "same_twice",
    expected: "unknown"
  },
  {
    name: "metadata IDs that are not strings",
    type: "supports",
    status: "pending_review",
    metadata: "not_strings",
    expected: "unknown"
  },
  {
    name: "metadata IDs in upper case",
    type: "extends",
    status: "pending_review",
    metadata: "lo_hi_upper",
    expected: "lo_to_hi"
  },
  {
    name: "owner accepted",
    type: "supports",
    status: "accepted",
    metadata: "hi_lo",
    expected: "hi_to_lo"
  },
  {
    name: "owner rejected",
    type: "extends",
    status: "rejected",
    metadata: "lo_hi",
    expected: "lo_to_hi"
  }
];

function metadataFor(shape: MetadataShape, lo: string, hi: string, third: string) {
  const base = { version: "atomic-notes-matching-v9", decisionSource: "model" };
  switch (shape) {
    case "lo_hi":
      return { ...base, [semanticSource]: lo, [semanticTarget]: hi };
    case "hi_lo":
      return { ...base, [semanticSource]: hi, [semanticTarget]: lo };
    case "lo_hi_upper":
      return { ...base, [semanticSource]: lo.toUpperCase(), [semanticTarget]: hi.toUpperCase() };
    case "none":
      return {};
    case "third":
      return { ...base, [semanticSource]: lo, [semanticTarget]: third };
    case "source_only":
      return { ...base, [semanticSource]: lo };
    case "same_twice":
      return { ...base, [semanticSource]: lo, [semanticTarget]: lo };
    case "not_strings":
      return { ...base, [semanticSource]: 1, [semanticTarget]: 2 };
  }
}

/** The pre-0056 currentness of source evidence (`relations_v2_current_evidence` of the migration). */
export const formerCurrentEvidenceSql = `select e.id from source_relation_evidence e ${sourceRelationEvidenceJoins}
 where (sc.id is not null and tc.id is not null
   and sd.metadata->>'supersededByDocumentId' is null and td.metadata->>'supersededByDocumentId' is null
   and sc.content_hash = e.snapshot->>'sourceHash' and tc.content_hash = e.snapshot->>'targetHash'
   and (e.origin = 'source_analysis' or (n.id is not null and n.status <> 'rejected'
     and a.status not in ('rejected','archived') and b.status not in ('rejected','archived')
     and a.supersession_status = 'current' and b.supersession_status = 'current'
     and md5(concat_ws('|',n.id::text,n.relation_type,n.status::text,n.metadata::text,
       least(concat_ws('|',a.id::text,a.idea_statement,a.body_markdown,a.supersession_status),
             concat_ws('|',b.id::text,b.idea_statement,b.body_markdown,b.supersession_status)),
       greatest(concat_ws('|',a.id::text,a.idea_statement,a.body_markdown,a.supersession_status),
                concat_ws('|',b.id::text,b.idea_statement,b.body_markdown,b.supersession_status))))
         = e.snapshot->>'noteFingerprint')))`;

const currentEvidenceSql = `select e.id from source_relation_evidence e ${sourceRelationEvidenceJoins}
 where ${currentSourceRelationEvidenceSql}`;

/**
 * Note-origin evidence whose stored fingerprint is the pre-0056 formula's, current or not
 * (`relations_v2_rekey` of the migration): 0056 re-keys exactly these rows.
 */
const formerFingerprintSql = `select e.id from source_relation_evidence e
  join atomic_note_relations n on n.id = e.note_relation_id
  join atomic_notes a on a.id = e.source_note_id join atomic_notes b on b.id = e.target_note_id
 where e.origin = 'atomic_notes'
   and md5(concat_ws('|',n.id::text,n.relation_type,n.status::text,n.metadata::text,
       least(concat_ws('|',a.id::text,a.idea_statement,a.body_markdown,a.supersession_status),
             concat_ws('|',b.id::text,b.idea_statement,b.body_markdown,b.supersession_status)),
       greatest(concat_ws('|',a.id::text,a.idea_statement,a.body_markdown,a.supersession_status),
                concat_ws('|',b.id::text,b.idea_statement,b.body_markdown,b.supersession_status))))
       = e.snapshot->>'noteFingerprint'`;

const storedFingerprints = async (db: PgPool) =>
  new Map(
    (
      await db.query<{ id: string; fingerprint: string | null }>(
        "select id, snapshot->>'noteFingerprint' as fingerprint from source_relation_evidence"
      )
    ).rows.map((row) => [row.id, row.fingerprint])
  );

/** The direction a row's metadata names for its pair (null when it names no exact pair). */
const metadataDirectionSql = `case
  when lower(metadata->>'${semanticSource}') = source_atomic_note_id::text
   and lower(metadata->>'${semanticTarget}') = target_atomic_note_id::text then 'lo_to_hi'
  when lower(metadata->>'${semanticSource}') = target_atomic_note_id::text
   and lower(metadata->>'${semanticTarget}') = source_atomic_note_id::text then 'hi_to_lo' end`;

export function captureNotices(pool: PgPool): string[] {
  const notices: string[] = [];
  pool.on("connect", (client) =>
    client.on("notice", (notice) => notices.push(notice.message ?? ""))
  );
  return notices;
}

export function parseReport(notices: readonly string[]): Record<string, number> {
  const line = notices.find((notice) => notice.startsWith("relations_v2 report "));
  assert.ok(line, "0056 reports its counts");
  return JSON.parse(line.slice("relations_v2 report ".length)) as Record<string, number>;
}

async function journalTags(folder = migrationsFolder): Promise<string[]> {
  const journal = JSON.parse(await readFile(join(folder, "meta/_journal.json"), "utf8")) as {
    entries: Array<{ tag: string }>;
  };
  return journal.entries.map((entry) => entry.tag);
}

/** How many migrations come before `tag` in the journal of `folder`: the history right before it. */
async function migrationsBeforeCount(tag: string, folder = migrationsFolder): Promise<number> {
  const index = (await journalTags(folder)).indexOf(tag);
  assert.ok(index > 0, `${tag} is in the journal`);
  return index;
}

/** A copy of the migrations of `from` that ends right before `tag`. */
export async function migrationsBefore(
  workDir: string,
  tag: string,
  name: string,
  from = migrationsFolder
): Promise<string> {
  const journal = JSON.parse(await readFile(join(from, "meta/_journal.json"), "utf8"));
  const index = await migrationsBeforeCount(tag, from);
  const folder = join(workDir, name);
  await cp(from, folder, { recursive: true });
  await writeFile(
    join(folder, "meta/_journal.json"),
    JSON.stringify({ ...journal, entries: journal.entries.slice(0, index) })
  );
  return folder;
}

async function journalLength(folder = migrationsFolder): Promise<number> {
  return (await journalTags(folder)).length;
}

const historyCount = async (db: PgPool | pg.Client) =>
  Number(
    (await db.query<{ n: string }>("select count(*)::text as n from drizzle.__drizzle_migrations"))
      .rows[0]?.n
  );

const columnExists = async (db: PgPool, table: string, column: string) =>
  (
    await db.query(
      "select 1 from information_schema.columns where table_name = $1 and column_name = $2",
      [table, column]
    )
  ).rowCount === 1;

export interface LegacyLibrary {
  relations: Array<{
    shape: LegacyRelationShape;
    id: string;
    lo: string;
    hi: string;
    subject: string;
  }>;
  /**
   * `discarded`: evidence of an applied relation whose fingerprint is the former formula's, stale
   * only because its `note` is discarded; approving the note again revives it.
   */
  evidence: {
    current: string[];
    stale: string;
    rejected: string;
    discarded: { id: string; note: string };
  };
}

/**
 * A library at migration 0055: three works with chunks, notes, one legacy note relation per shape
 * and source relations whose evidence is current, stale or rests on a rejected note relation.
 */
export async function seedLegacyLibrary(db: PgPool): Promise<LegacyLibrary> {
  const sources = createSourceItemRepository(db);
  const documents = createDocumentRepository(db);
  const chunks = createChunkRepository(db);
  const works: Array<{ id: string; chunks: Array<{ id: string; hash: string }> }> = [];
  for (const title of ["Alpha retrieval", "Beta feedback", "Gamma spacing"]) {
    const source = await sources.create({ type: "StandaloneArticle", title });
    const text = `${title}: one claim. ${title}: another claim.`;
    const document = await documents.create({
      sourceItemId: source.id,
      title,
      canonicalMarkdown: text,
      contentHash: `doc-${title}`
    });
    const rows = [0, 1].map((index) => ({
      id: randomUUID(),
      sourceSpanId: randomUUID(),
      chunkIndex: index,
      content: `${title} chunk ${index}`,
      contentHash: `hash-${title}-${index}`,
      span: { id: "", startOffset: index * 10, endOffset: index * 10 + 9 }
    }));
    for (const row of rows) row.span.id = row.sourceSpanId;
    await chunks.replaceDocumentChunks(document.id, source.id, rows);
    works.push({
      id: source.id,
      chunks: rows.map((row) => ({ id: row.id, hash: row.contentHash }))
    });
  }
  const noteIds: string[] = [];
  const noteCount = legacyRelationShapes.length * 2 + 1;
  for (let index = 0; index < noteCount; index += 1) {
    const work = works[index % works.length]!;
    const id = randomUUID();
    await db.query(
      `insert into atomic_notes (id, title, body_markdown, idea_statement, created_from_source_item_id,
         evidence_chunk_id, generation_provider, generation_model, generation_runtime,
         generation_prompt_version, generation_key)
       values ($1::uuid, $2, $3, $4, $5, $6, 'verify', 'verify', 'local', 'verify', $1::uuid::text)`,
      [id, `Note ${index}`, `Body ${index}`, `Idea ${index}`, work.id, work.chunks[index % 2]!.id]
    );
    noteIds.push(id);
  }
  const third = noteIds[noteCount - 1]!;
  const relations: LegacyLibrary["relations"] = [];
  for (const [index, shape] of legacyRelationShapes.entries()) {
    const [lo, hi] = [noteIds[2 * index]!, noteIds[2 * index + 1]!].sort() as [string, string];
    const [source, target] = shape.storedHighToLow ? [hi, lo] : [lo, hi];
    const metadata = metadataFor(shape.metadata, lo, hi, third);
    const id = (
      await db.query<{ id: string }>(
        `insert into atomic_note_relations (source_atomic_note_id, target_atomic_note_id, relation_type,
           final_score, explanation, status, metadata)
         values ($1, $2, $3, $4, 'knowledge.relations.explanations.reranked', $5, $6) returning id`,
        [source, target, shape.type, 0.5 + index / 100, shape.status, metadata]
      )
    ).rows[0]!.id;
    const subject = shape.metadata === "hi_lo" ? hi : lo;
    relations.push({ shape, id, lo, hi, subject });
  }

  const noteChunk = async (note: string) =>
    (
      await db.query<{ id: string; hash: string }>(
        `select c.id, c.content_hash as hash from atomic_notes n join chunks c on c.id = n.evidence_chunk_id
          where n.id = $1`,
        [note]
      )
    ).rows[0]!;
  const sourceRelation = async (key: string, left: string, right: string) =>
    (
      await db.query<{ id: string }>(
        `insert into source_relations (source_item_id, target_source_item_id, identity_key, relation_type,
           importance, confidence) values ($1, $2, $3, 'supports', 0.8, 0.7) returning id`,
        [left, right, key]
      )
    ).rows[0]!.id;
  const noteEvidence = async (key: string, relationIndex: number) => {
    const relation = relations[relationIndex]!;
    const [a, b] =
      relation.subject === relation.lo ? [relation.lo, relation.hi] : [relation.hi, relation.lo];
    const [ca, cb] = [await noteChunk(a), await noteChunk(b)];
    const homes = (
      await db.query<{ id: string; home: string }>(
        "select id, created_from_source_item_id as home from atomic_notes where id = any($1::uuid[])",
        [[a, b]]
      )
    ).rows;
    const home = (note: string) => homes.find((row) => row.id === note)!.home;
    const relationId = await sourceRelation(key, home(a), home(b));
    return (
      await db.query<{ id: string }>(
        `insert into source_relation_evidence (relation_id, evidence_key, origin, source_chunk_id,
           target_chunk_id, note_relation_id, source_note_id, target_note_id, snapshot)
         values ($1, $2, 'atomic_notes', $3, $4, $5, $6, $7,
                 jsonb_build_object('sourceHash', $8::text, 'targetHash', $9::text)) returning id`,
        [relationId, key, ca.id, cb.id, relation.id, a, b, ca.hash, cb.hash]
      )
    ).rows[0]!.id;
  };
  const byName = (name: string) => legacyRelationShapes.findIndex((shape) => shape.name === name);
  const current = [
    await noteEvidence("current-directed", byName("directed, decided lo -> hi")),
    await noteEvidence("current-swapped", byName("stored high-to-low, decided hi -> lo")),
    await noteEvidence("current-symmetric", byName("symmetric type with metadata")),
    await noteEvidence("current-unknown", byName("no decision metadata")),
    await noteEvidence("current-accepted", byName("owner accepted"))
  ];
  const stale = await noteEvidence("stale", byName("directed, decided hi -> lo"));
  const rejected = await noteEvidence("rejected", byName("owner rejected"));
  const mentions = relations[byName("legacy mentions")]!;
  const discarded = {
    id: await noteEvidence("discarded", byName("legacy mentions")),
    note: mentions.hi
  };
  // The former fingerprint leaves the notes' review status out (0048): discarding a note makes the
  // evidence stale through the status check only.
  await db.query("update atomic_notes set status = 'rejected' where id = $1", [discarded.note]);
  // The fingerprints the pre-F3 code wrote (status and metadata included), except the stale one.
  await db.query(
    `update source_relation_evidence e set snapshot = jsonb_set(e.snapshot, '{noteFingerprint}',
       to_jsonb(md5(concat_ws('|',n.id::text,n.relation_type,n.status::text,n.metadata::text,
         least(concat_ws('|',a.id::text,a.idea_statement,a.body_markdown,a.supersession_status),
               concat_ws('|',b.id::text,b.idea_statement,b.body_markdown,b.supersession_status)),
         greatest(concat_ws('|',a.id::text,a.idea_statement,a.body_markdown,a.supersession_status),
                  concat_ws('|',b.id::text,b.idea_statement,b.body_markdown,b.supersession_status))))))
       from atomic_note_relations n, atomic_notes a, atomic_notes b
      where n.id = e.note_relation_id and a.id = e.source_note_id and b.id = e.target_note_id`
  );
  await db.query(
    `update source_relation_evidence set snapshot = jsonb_set(snapshot, '{noteFingerprint}', '"stale"')
      where id = $1`,
    [stale]
  );
  // Evidence the source analysis found on its own: current, and never re-keyed.
  const [first, second] = works as [(typeof works)[0], (typeof works)[0]];
  const analysis = await sourceRelation("analysis", first.id, second.id);
  current.push(
    (
      await db.query<{ id: string }>(
        `insert into source_relation_evidence (relation_id, evidence_key, origin, source_chunk_id,
           target_chunk_id, snapshot)
         values ($1, 'analysis', 'source_analysis', $2, $3,
                 jsonb_build_object('sourceHash', $4::text, 'targetHash', $5::text)) returning id`,
        [
          analysis,
          first.chunks[0]!.id,
          second.chunks[0]!.id,
          first.chunks[0]!.hash,
          second.chunks[0]!.hash
        ]
      )
    ).rows[0]!.id
  );
  return { relations, evidence: { current, stale, rejected, discarded } };
}

interface RelationState {
  id: string;
  source: string;
  target: string;
  type: string;
  status: string;
  metadata: string;
  metadataDirection: "lo_to_hi" | "hi_to_lo" | null;
}

async function relationStates(db: PgPool): Promise<Map<string, RelationState>> {
  const rows = (
    await db.query<RelationState>(
      `select id, source_atomic_note_id as source, target_atomic_note_id as target,
              relation_type as type, status::text as status, metadata::text as metadata,
              ${metadataDirectionSql} as "metadataDirection"
         from atomic_note_relations`
    )
  ).rows;
  return new Map(rows.map((row) => [row.id, row]));
}

const ids = async (db: PgPool, sql: string) =>
  new Set((await db.query<{ id: string }>(sql)).rows.map((row) => row.id));

interface MigrationEvidence {
  report: Record<string, number>;
  before: Map<string, RelationState>;
  formerCurrent: Set<string>;
  /** Evidence whose stored fingerprint was the former formula's, and every stored fingerprint. */
  formerFingerprint: Set<string>;
  fingerprintsBefore: Map<string, string | null>;
  ms: number;
}

/**
 * Applies every pending migration (0056 first, then any later one) with 0056's report captured and
 * the state before kept.
 */
async function migrateCapturing(
  db: PgPool,
  notices: string[],
  folder = migrationsFolder
): Promise<MigrationEvidence> {
  const before = await relationStates(db);
  const formerCurrent = await ids(db, formerCurrentEvidenceSql);
  const formerFingerprint = await ids(db, formerFingerprintSql);
  const fingerprintsBefore = await storedFingerprints(db);
  notices.length = 0;
  const started = performance.now();
  await runMigrations(db, folder);
  const ms = Math.round(performance.now() - started);
  return {
    report: parseReport(notices),
    before,
    formerCurrent,
    formerFingerprint,
    fingerprintsBefore,
    ms
  };
}

/**
 * Invariants of a migrated library, against its state before 0056: the canonical pair (I-R1),
 * untouched metadata, statuses and types, the direction its metadata named, `unknown` only where
 * none was named, and the same current source evidence under the facts-only fingerprint (I-R7).
 */
async function checkMigrated(db: PgPool, evidence: MigrationEvidence) {
  const { report, before, formerCurrent, formerFingerprint, fingerprintsBefore } = evidence;
  const after = (
    await db.query<{
      id: string;
      source: string;
      target: string;
      type: string;
      status: string;
      metadata: string;
      direction: Direction;
      band: string | null;
      probability: number | null;
      keys: string | null;
      vetoed: boolean;
    }>(
      `select id, source_atomic_note_id as source, target_atomic_note_id as target, relation_type as type,
              status::text as status, metadata::text as metadata, direction, band, probability,
              coalesce(decider_key, typer_key) as keys, veto_source is not null as vetoed
         from atomic_note_relations`
    )
  ).rows;
  assert.equal(after.length, before.size, "no note relation is lost or added");
  const counts = { agreements: 0, symmetric: 0, unknown: 0, swapped: 0 };
  for (const row of after) {
    const old = before.get(row.id);
    assert.ok(old, `relation ${row.id} existed before`);
    assert.ok(row.source < row.target, "I-R1: the pair is stored once, lower UUID first");
    assert.deepEqual(
      [row.source, row.target].sort(),
      [old.source, old.target].sort(),
      "the endpoints are the same notes"
    );
    if (row.source !== old.source) counts.swapped += 1;
    assert.equal(row.metadata, old.metadata, "metadata is never rewritten");
    assert.equal(row.status, old.status, "the human review status is unchanged");
    assert.equal(row.type, old.type, "no relation type is rewritten");
    assert.deepEqual(
      [row.band, row.probability, row.keys, row.vetoed],
      [null, null, null, false],
      "legacy rows have no band, probability, keys or veto"
    );
    const symmetric = ["contrasts", "similar_to", "contradicts", "same_as"].includes(row.type);
    // The direction the metadata named, relative to the sorted pair after the migration.
    const named =
      old.metadataDirection === null
        ? null
        : old.source === row.source
          ? old.metadataDirection
          : old.metadataDirection === "lo_to_hi"
            ? "hi_to_lo"
            : "lo_to_hi";
    if (symmetric) {
      assert.equal(row.direction, "symmetric", `a ${row.type} relation reads both ways`);
      counts.symmetric += 1;
    } else if (named) {
      assert.equal(row.direction, named, "the direction agrees with the old metadata");
      counts.agreements += 1;
    } else {
      assert.equal(row.direction, "unknown", "a direction no metadata named is unknown");
      counts.unknown += 1;
    }
  }
  const current = await ids(db, currentEvidenceSql);
  assert.deepEqual(
    [...current].sort(),
    [...formerCurrent].sort(),
    "the same source evidence is current under the facts-only fingerprint and applied relations"
  );
  assert.equal(report.current_evidence_before, formerCurrent.size);
  assert.equal(report.current_evidence_after, current.size);
  assert.equal(report.current_evidence_lost, 0);
  assert.equal(report.current_source_relations_after, report.current_source_relations_before);
  assert.equal(report.metadata_direction_disagreements ?? 0, 0);
  assert.equal(report.swapped ?? 0, counts.swapped);
  // Every row of the former formula is re-keyed (all current note evidence among them), so a row
  // stale only for a reversible reason still revives; any other stored fingerprint is untouched.
  assert.equal(report.evidence_former_fingerprint, formerFingerprint.size);
  assert.equal(
    report.evidence_recomputed,
    formerFingerprint.size,
    "every evidence row of the former formula is re-keyed"
  );
  const computed = new Map(
    (
      await db.query<{ id: string; computed: string }>(
        `select e.id, ${noteRelationFingerprintSql("n", "a", "b")} as computed
           from source_relation_evidence e
           join atomic_note_relations n on n.id = e.note_relation_id
           join atomic_notes a on a.id = e.source_note_id join atomic_notes b on b.id = e.target_note_id
          where e.id = any($1::uuid[])`,
        [[...formerFingerprint]]
      )
    ).rows.map((row) => [row.id, row.computed])
  );
  const fingerprintsAfter = await storedFingerprints(db);
  const notRekeyed = (
    await db.query<{ origin: string }>(
      "select distinct origin from source_relation_evidence where id = any($1::uuid[])",
      [[...formerCurrent].filter((id) => !formerFingerprint.has(id))]
    )
  ).rows.map((row) => row.origin);
  assert.ok(
    notRekeyed.every((origin) => origin === "source_analysis"),
    "every current note evidence had the former fingerprint"
  );
  for (const [id, stored] of fingerprintsBefore)
    assert.equal(
      fingerprintsAfter.get(id),
      formerFingerprint.has(id) ? computed.get(id) : stored,
      formerFingerprint.has(id)
        ? "the re-keyed fingerprint is the code's formula"
        : "a fingerprint of no known formula is left as it is"
    );
  const sources = (
    await db.query<{ origins: string[]; scales: string[] }>(
      `select (select coalesce(array_agg(distinct origin), '{}') from source_relations) as origins,
              (select coalesce(array_agg(distinct score_scale), '{}') from relation_decisions) as scales`
    )
  ).rows[0]!;
  assert.ok(
    sources.origins.every((origin) => origin === "judged"),
    "every source relation was judged"
  );
  assert.ok(
    sources.scales.every((scale) => scale === "probability"),
    "every decision is a probability"
  );
  return { ...counts, currentEvidence: current.size, relations: after.length };
}

/** Columns, constraints and indexes of the relation tables, for comparing two databases. */
async function shape(db: PgPool) {
  const tables = [
    "atomic_note_relations",
    "relation_decisions",
    "source_relations",
    "relation_typings",
    "note_match_state",
    "source_match_state",
    "relation_match_runs",
    "relation_events"
  ];
  const columns = (
    await db.query<{ line: string }>(
      `select table_name || '.' || column_name || ':' || data_type || ':' || is_nullable || ':' ||
              coalesce(column_default, '') as line
         from information_schema.columns where table_schema = 'public' and table_name = any($1::text[])
        order by 1`,
      [tables]
    )
  ).rows.map((row) => row.line);
  const constraints = (
    await db.query<{ line: string }>(
      `select c.conrelid::regclass::text || '.' || c.conname || ':' || c.contype::text || ':' ||
              pg_get_constraintdef(c.oid) as line
         from pg_constraint c where c.conrelid::regclass::text = any($1::text[]) order by 1`,
      [tables]
    )
  ).rows.map((row) => row.line);
  const indexes = (
    await db.query<{ line: string }>(
      "select indexdef as line from pg_indexes where schemaname = 'public' and tablename = any($1::text[]) order by 1",
      [tables]
    )
  ).rows.map((row) => row.line);
  return { columns, constraints, indexes };
}

async function checkConstraints(db: PgPool, library: LegacyLibrary) {
  const [noteA, noteB] = [library.relations[0]!.lo, library.relations[0]!.hi];
  // A free pair of existing notes for inserts (the relation of shape 1 is removed first).
  await db.query("delete from atomic_note_relations where id = $1", [library.relations[1]!.id]);
  const [lo, hi] = [library.relations[1]!.lo, library.relations[1]!.hi];
  const insert = (values: Record<string, unknown>) => {
    const row = {
      source_atomic_note_id: lo,
      target_atomic_note_id: hi,
      relation_type: "supports",
      direction: "lo_to_hi",
      direction_source: "typer",
      band: "apply",
      probability: 0.9,
      vetoed_at: null,
      veto_source: null,
      ...values
    };
    const names = Object.keys(row);
    return db.query(
      `insert into atomic_note_relations (${names.join(", ")}, final_score, explanation)
       values (${names.map((_, index) => `$${index + 1}`).join(", ")}, 0.9, 'verify') returning id`,
      Object.values(row)
    );
  };
  const refused = async (label: string, values: Record<string, unknown>) =>
    assert.rejects(insert(values), /check constraint|violates/, label);
  const accepted = async (label: string, values: Record<string, unknown>) => {
    const row = (await insert(values)).rows[0] as { id: string };
    assert.ok(row.id, label);
    await db.query("delete from atomic_note_relations where id = $1", [row.id]);
  };
  await refused("the pair is sorted", { source_atomic_note_id: hi, target_atomic_note_id: lo });
  await refused("a direction from the list", { direction: "sideways" });
  await refused("a band from the list", { band: "maybe" });
  await refused("a probability in [0, 1]", { probability: 1.5 });
  await refused("a type from the read vocabulary", { band: null, relation_type: "invented" });
  await refused("a banded row uses the write vocabulary", {
    relation_type: "contrasts",
    direction: "symmetric"
  });
  await refused("a directed write type has a direction", { direction: "symmetric" });
  await refused("a symmetric write type reads both ways", {
    relation_type: "same_as",
    direction_source: null
  });
  await refused("a symmetric write type has no direction source", {
    relation_type: "same_as",
    direction: "symmetric"
  });
  await refused("an untyped row reads both ways", { relation_type: null, direction_source: null });
  await refused("unknown only on legacy rows", { direction: "unknown" });
  await refused("a banded directed row names where its direction came from", {
    direction_source: null
  });
  await refused("only the owner leaves a directed type without a direction", {
    direction: "symmetric",
    direction_source: "decider"
  });
  await refused("a direction source from the list", { direction_source: "someone" });
  await refused("a legacy row has no direction source", { band: null, probability: null });
  await refused("only v2 rows are untyped", {
    relation_type: null,
    band: null,
    direction: "symmetric"
  });
  await refused("a veto has a source", { vetoed_at: new Date() });
  await refused("a veto source has a time", { veto_source: "typer" });
  await refused("a veto source from the list", { vetoed_at: new Date(), veto_source: "owner" });
  await accepted("an applied directed v2 row", {});
  await accepted("a directed row whose direction the decider or the owner gave", {
    direction_source: "decider"
  });
  await accepted("a directed row whose direction the owner left out", {
    direction: "symmetric",
    direction_source: "owner"
  });
  await accepted("a suggested symmetric v2 row", {
    band: "suggest",
    relation_type: "contradicts",
    direction: "symmetric",
    direction_source: null
  });
  await accepted("an untyped v2 row", {
    relation_type: null,
    direction: "symmetric",
    direction_source: null
  });
  await accepted("a withdrawn row", { vetoed_at: new Date(), veto_source: "explainer" });
  await accepted("a legacy row in any stored direction", {
    band: null,
    probability: null,
    relation_type: "related",
    direction: "unknown",
    direction_source: null
  });

  const [left, right] = (
    await db.query<{ id: string }>("select id from source_items order by title limit 2")
  ).rows.map((row) => row.id) as [string, string];
  const source = (values: Record<string, unknown>) => {
    const row = {
      source_item_id: left,
      target_source_item_id: right,
      identity_key: `verify-${randomUUID()}`,
      relation_type: "same_as",
      importance: null,
      confidence: null,
      origin: "promoted",
      support_count: 2,
      ...values
    };
    const names = Object.keys(row);
    return db.query(
      `insert into source_relations (${names.join(", ")}) values (${names.map((_, i) => `$${i + 1}`).join(", ")})`,
      Object.values(row)
    );
  };
  await source({});
  await source({ origin: "judged", importance: 0.5, confidence: 0.5, support_count: 3 });
  for (const [label, values] of [
    ["a promoted relation counts its support", { support_count: null }],
    ["a support count is positive", { support_count: 0 }],
    ["a judged relation has scores", { origin: "judged" }],
    ["an origin from the list", { origin: "guessed" }],
    ["a type from the read vocabulary", { relation_type: "invented" }],
    ["scores in [0, 1]", { origin: "judged", importance: 2, confidence: 0.5 }]
  ] as const)
    await assert.rejects(source(values), /check constraint/, label);

  const typing = (relationType: string, direction: string | null) =>
    db.query(
      `insert into relation_typings (pair_key, typer_key, lo_hash, hi_hash, relation_type, direction)
       values ($1, 'typer', 'a', 'b', $2, $3)`,
      [`${noteA}:${noteB}:${randomUUID()}`.slice(0, 200), relationType, direction]
    );
  await typing("none", null);
  await typing("same_as", "symmetric");
  await typing("extends", "hi_to_lo");
  for (const [label, type, direction] of [
    ["a veto has no direction", "none", "lo_to_hi"],
    ["a directed type has a direction", "supports", "symmetric"],
    ["a symmetric type reads both ways", "contradicts", "lo_to_hi"],
    ["a typing writes the write vocabulary", "contrasts", "symmetric"]
  ] as const)
    await assert.rejects(typing(type, direction), /check constraint/, label);

  const run = (
    await db.query<{ id: string }>(
      "insert into relation_match_runs (kind) values ('link') returning id"
    )
  ).rows[0]!.id;
  await db.query(
    `insert into relation_events (run_id, relation_kind, relation_id, pair_key, kind, before, after)
     values ($1, 'note', $2, 'pair', 'applied', null, '{}')`,
    [run, randomUUID()]
  );
  await assert.rejects(
    db.query("insert into relation_match_runs (kind) values ('guess')"),
    /check constraint/,
    "a run kind from the list"
  );
  await assert.rejects(
    db.query(
      `insert into relation_events (run_id, relation_kind, pair_key, kind) values ($1, 'note', 'pair', 'moved')`,
      [run]
    ),
    /check constraint/,
    "an event kind from the list"
  );
  await db.query("delete from relation_match_runs where id = $1", [run]);
  assert.equal(
    (await db.query("select 1 from relation_events where run_id = $1", [run])).rowCount,
    0,
    "a run's events go with it"
  );
}

/**
 * A migration killed mid-transaction leaves the database as it was: 0056 waits on a lock of a
 * table it alters after it changed `atomic_note_relations`, and its connection is terminated there.
 */
async function checkKilledMigration(connectionString: string, workDir: string) {
  const db = createPgPool({ connectionString, max: 3 });
  // The terminated connection reports its end on the checked-out client as well as to the query.
  db.on("connect", (client) => client.on("error", () => undefined));
  const admin = new pg.Client({ connectionString });
  const holder = new pg.Client({ connectionString });
  try {
    await runMigrations(db, await migrationsBefore(workDir, relationsV2Tag, "drizzle-before-kill"));
    await seedLegacyLibrary(db);
    const before = await relationStates(db);
    const history = await historyCount(db);
    await Promise.all([admin.connect(), holder.connect()]);
    await holder.query("begin");
    await holder.query("lock table relation_decisions in access exclusive mode");
    const migration = runMigrations(db, migrationsFolder).then(
      () => "applied",
      (error: unknown) => error
    );
    let victim: number | null = null;
    for (let attempt = 0; attempt < 300 && victim === null; attempt += 1) {
      const waiting = await admin.query<{ pid: number }>(
        `select pid from pg_stat_activity
          where datname = current_database() and pid not in (pg_backend_pid(), $1)
            and wait_event_type = 'Lock'`,
        [(holder as unknown as { processID: number }).processID]
      );
      victim = waiting.rows[0]?.pid ?? null;
      if (victim === null) await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    assert.ok(victim, "the migration waits inside its transaction");
    // It has already added the direction column in its own (uncommitted) transaction.
    await admin.query("select pg_terminate_backend($1)", [victim]);
    const outcome = await migration;
    assert.ok(outcome instanceof Error, "the killed migration fails");
    await holder.query("rollback");
    assert.equal(await historyCount(admin), history, "no migration is recorded");
    assert.equal(
      await columnExists(db, "atomic_note_relations", "direction"),
      false,
      "no column added"
    );
    assert.equal(await columnExists(db, "relation_decisions", "score_scale"), false);
    const after = await relationStates(db);
    assert.deepEqual([...after.entries()].sort(), [...before.entries()].sort(), "rows unchanged");
    // The same database then migrates cleanly.
    await runMigrations(db, migrationsFolder);
    assert.equal(await columnExists(db, "atomic_note_relations", "direction"), true);
  } finally {
    await holder.end().catch(() => undefined);
    await admin.end().catch(() => undefined);
    await closePgPool(db).catch(() => undefined);
  }
}

/**
 * The pending path on an empty database `db`: migrated to 0055, seeded with a legacy library of
 * every metadata shape, then migrated with 0056 (and any later migration of `folder`) pending and
 * 0056's report captured. Asserts the backfill of every shape, untouched metadata, statuses and
 * types, and the same current source evidence.
 */
/**
 * A library at migration 0058 holding automatic (banded) relations of every kind, and legacy ones:
 * what 0059 gives a direction source (decision 31b).
 */
async function seedBandedLibrary(db: PgPool): Promise<{ ids: string[]; runId: string }> {
  const sources = createSourceItemRepository(db);
  const documents = createDocumentRepository(db);
  const chunks = createChunkRepository(db);
  const source = await sources.create({ type: "StandaloneArticle", title: "Banded" });
  const document = await documents.create({
    sourceItemId: source.id,
    title: "Banded",
    canonicalMarkdown: "One claim.",
    contentHash: "doc-banded"
  });
  const chunk = { id: randomUUID(), sourceSpanId: randomUUID() };
  await chunks.replaceDocumentChunks(document.id, source.id, [
    {
      ...chunk,
      chunkIndex: 0,
      content: "One claim.",
      contentHash: "hash-banded",
      span: { id: chunk.sourceSpanId, startOffset: 0, endOffset: 9 }
    }
  ]);
  const shapes: Array<{
    type: string | null;
    direction: Direction;
    band: "apply" | "suggest" | null;
    status?: "pending_review" | "accepted";
    vetoed?: boolean;
  }> = [
    { type: "extends", direction: "lo_to_hi", band: "apply" },
    { type: "supports", direction: "hi_to_lo", band: "suggest" },
    { type: "depends_on", direction: "lo_to_hi", band: "suggest", status: "accepted" },
    { type: "example_of", direction: "hi_to_lo", band: "apply", vetoed: true },
    { type: "same_as", direction: "symmetric", band: "apply" },
    { type: "contradicts", direction: "symmetric", band: "suggest" },
    { type: null, direction: "symmetric", band: "suggest" },
    { type: "supports", direction: "lo_to_hi", band: null },
    { type: "related", direction: "unknown", band: null },
    { type: "similar_to", direction: "symmetric", band: null }
  ];
  const ids: string[] = [];
  const runId = (
    await db.query<{ id: string }>(
      "insert into relation_match_runs (kind, outcome, finished_at) values ('link', 'succeeded', now()) returning id"
    )
  ).rows[0]!.id;
  for (const [index, shape] of shapes.entries()) {
    const notes: string[] = [];
    for (const side of [0, 1]) {
      const id = randomUUID();
      await db.query(
        `insert into atomic_notes (id, title, body_markdown, idea_statement, created_from_source_item_id,
           evidence_chunk_id, generation_provider, generation_model, generation_runtime,
           generation_prompt_version, generation_key)
         values ($1::uuid, $2, 'Body', $3, $4, $5, 'verify', 'verify', 'local', 'verify', $1::uuid::text)`,
        [id, `Banded ${index}.${side}`, `Idea ${index}.${side}`, source.id, chunk.id]
      );
      notes.push(id);
    }
    const [lo, hi] = notes.sort() as [string, string];
    const id = (
      await db.query<{ id: string }>(
        `insert into atomic_note_relations (source_atomic_note_id, target_atomic_note_id, relation_type,
           direction, band, probability, status, vetoed_at, veto_source, final_score, explanation)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, 0.8, 'verify') returning id`,
        [
          lo,
          hi,
          shape.type,
          shape.direction,
          shape.band,
          shape.band ? 0.8 : null,
          shape.status ?? "pending_review",
          shape.vetoed ? new Date() : null,
          shape.vetoed ? "explainer" : null
        ]
      )
    ).rows[0]!.id;
    ids.push(id);
    // An automatic change is recorded with the row it left, as the link job's writes were (D14).
    if (shape.band)
      await db.query(
        `insert into relation_events (run_id, relation_kind, relation_id, pair_key, kind, before, after)
         select $1, 'note', r.id, r.source_atomic_note_id::text || ':' || r.target_atomic_note_id::text,
                'applied', null, to_jsonb(r)
           from atomic_note_relations r where r.id = $2`,
        [runId, id]
      );
  }
  return { ids, runId };
}

/**
 * Migration 0059 on a database that has not seen it (decision 31b): every automatic relation of a
 * directed type becomes a `typer` guess, nothing else changes (every other column of every row is
 * equal before and after), and no relation is lost. Null when the database already has the column.
 */
async function migrateDirectionSource(db: PgPool, folder = migrationsFolder) {
  if (await columnExists(db, "atomic_note_relations", "direction_source")) return null;
  // The images of the relation events: those of an automatic directed relation get the value its row
  // gets, so a run recorded before still reverts byte for byte (I-R8); nothing else in them changes.
  const images = `select count(*) filter (where relation_kind = 'note' and (
           (before->>'band' is not null and before->>'direction' in ('lo_to_hi','hi_to_lo'))
        or (after->>'band' is not null and after->>'direction' in ('lo_to_hi','hi_to_lo'))))::int as "toPatch",
       count(*) filter (where (before ? 'direction_source') or (after ? 'direction_source'))::int as "patched",
       md5(coalesce(string_agg(coalesce((before - 'direction_source')::text, '') || '|' ||
         coalesce((after - 'direction_source')::text, ''), ',' order by id), '')) as digest
    from relation_events`;
  const eventsBefore = (
    await db.query<{ toPatch: number; patched: number; digest: string }>(images)
  ).rows[0]!;
  const image = `select count(*)::int as total,
       count(*) filter (where band is not null and direction in ('lo_to_hi','hi_to_lo'))::int as "bandedDirected",
       md5(coalesce(string_agg(to_jsonb(r)::text, '' order by r.id), '')) as digest
    from atomic_note_relations r`;
  const imageAfter = image.replace("to_jsonb(r)::text", "(to_jsonb(r) - 'direction_source')::text");
  const before = (await db.query<{ total: number; bandedDirected: number; digest: string }>(image))
    .rows[0]!;
  const started = performance.now();
  await runMigrations(db, folder);
  const ms = Math.round(performance.now() - started);
  const after = (
    await db.query<{ total: number; bandedDirected: number; digest: string }>(imageAfter)
  ).rows[0]!;
  assert.equal(after.total, before.total, "0059 keeps every relation");
  assert.equal(after.digest, before.digest, "0059 changes no column but the new one");
  const count = async (where: string) =>
    Number(
      (
        await db.query<{ n: string }>(
          `select count(*)::text as n from atomic_note_relations where ${where}`
        )
      ).rows[0]!.n
    );
  const typer = await count("direction_source = 'typer'");
  assert.equal(typer, before.bandedDirected, "every automatic directed relation is a typer guess");
  assert.equal(
    await count("direction_source is not null and direction_source <> 'typer'"),
    0,
    "no direction is shown that nobody gave"
  );
  const eventsAfter = (await db.query<{ toPatch: number; patched: number; digest: string }>(images))
    .rows[0]!;
  assert.equal(eventsBefore.patched, 0, "no event image knew the column before");
  assert.equal(eventsAfter.digest, eventsBefore.digest, "0059 changes no event image but the key");
  const stale = Number(
    (
      await db.query<{ n: string }>(
        `select count(*)::text as n from relation_events where relation_kind = 'note' and (
           (before->>'band' is not null and before->>'direction' in ('lo_to_hi','hi_to_lo')
              and before->>'direction_source' is distinct from 'typer')
        or (after->>'band' is not null and after->>'direction' in ('lo_to_hi','hi_to_lo')
              and after->>'direction_source' is distinct from 'typer'))`
      )
    ).rows[0]!.n
  );
  assert.equal(stale, 0, "every image of an automatic directed relation names its source");
  return {
    relations: before.total,
    typer,
    eventImagesPatched: eventsBefore.toPatch,
    ms
  };
}

export async function verifyPendingPath(db: PgPool, workDir: string, folder = migrationsFolder) {
  const notices = captureNotices(db);
  await runMigrations(
    db,
    await migrationsBefore(workDir, relationsV2Tag, "drizzle-before-0056", folder)
  );
  assert.equal(
    await historyCount(db),
    await migrationsBeforeCount(relationsV2Tag, folder),
    "history before 0056"
  );
  const library = await seedLegacyLibrary(db);
  const evidence = await migrateCapturing(db, notices, folder);
  assert.equal(await historyCount(db), await journalLength(folder), "0056 applied as pending");
  const counts = await checkMigrated(db, evidence);
  for (const relation of library.relations) {
    const { direction } = (
      await db.query<{ direction: Direction }>(
        "select direction from atomic_note_relations where id = $1",
        [relation.id]
      )
    ).rows[0]!;
    assert.equal(direction, relation.shape.expected, relation.shape.name);
  }
  const current = await ids(db, currentEvidenceSql);
  assert.deepEqual([...current].sort(), [...library.evidence.current].sort(), "current evidence");
  assert.equal(current.has(library.evidence.stale), false, "stale evidence stays stale");
  assert.equal(
    current.has(library.evidence.rejected),
    false,
    "a rejected relation supports nothing"
  );
  assert.equal(
    (
      await db.query<{ fingerprint: string }>(
        "select snapshot->>'noteFingerprint' as fingerprint from source_relation_evidence where id = $1",
        [library.evidence.stale]
      )
    ).rows[0]!.fingerprint,
    "stale",
    "evidence of no known fingerprint is not re-keyed"
  );
  // Stale only because a note is discarded, it was re-keyed and revives when the note is approved.
  const { discarded } = library.evidence;
  assert.equal(current.has(discarded.id), false, "evidence of a discarded note is not current");
  await db.query("update atomic_notes set status = 'approved' where id = $1", [discarded.note]);
  assert.equal(
    (await ids(db, currentEvidenceSql)).has(discarded.id),
    true,
    "approving the discarded note again revives its evidence"
  );
  await db.query("update atomic_notes set status = 'rejected' where id = $1", [discarded.note]);
  return { library, evidence, counts };
}

async function selfContained() {
  const workDir = await mkdtemp(join(tmpdir(), "memora-relations-v2-"));
  const sidecar = resolvePostgresSidecarPaths({ cwd: workspaceRoot, env: process.env });
  const manager = new PostgresSidecarManager({
    binDir: sidecar.binDir,
    dataDir: join(workDir, "data"),
    database: "memora_relations_v2",
    user: "memora_relations_v2",
    password: `relations-v2-${randomUUID()}`,
    startupTimeoutMs: 30_000,
    shutdownTimeoutMs: 10_000
  });
  const pools: PgPool[] = [];
  try {
    const connection = await manager.start();
    const database = (name: string) => {
      const url = new URL(connection.connectionString);
      url.pathname = `/${name}`;
      return url.toString();
    };
    // 1. Pending path: a library at 0055 gets 0056.
    const db = createPgPool({ connectionString: connection.connectionString, max: 3 });
    pools.push(db);
    const { library, evidence, counts } = await verifyPendingPath(db, workDir);

    // 2. I-R7 and C3: status, band, probability, veto and metadata are not facts of the evidence;
    // type and direction are; a vetoed (withdrawn) note relation supports nothing, a suggestion
    // supports a suggested source relation (decision 29).
    const directed = library.relations[0]!;
    const evidenceRow = (
      await db.query<{ id: string }>(
        "select id from source_relation_evidence where note_relation_id = $1",
        [directed.id]
      )
    ).rows[0]!.id;
    const fingerprint = async () =>
      (
        await db.query<{ value: string }>(
          `select ${noteRelationFingerprintSql("n", "a", "b")} as value
             from source_relation_evidence e join atomic_note_relations n on n.id = e.note_relation_id
             join atomic_notes a on a.id = e.source_note_id join atomic_notes b on b.id = e.target_note_id
            where e.id = $1`,
          [evidenceRow]
        )
      ).rows[0]!.value;
    const isCurrent = async () => (await ids(db, currentEvidenceSql)).has(evidenceRow);
    const original = await fingerprint();
    for (const change of [
      "status = 'accepted'",
      "band = 'apply', direction_source = 'typer', probability = 0.93",
      "status = 'pending_review', band = 'suggest'",
      "direction_source = 'decider'",
      "direction_source = 'owner'",
      "band = null, direction_source = null, probability = null",
      'metadata = metadata || \'{"reviewNote": "seen"}\'::jsonb',
      "decider_key = 'ranker', typer_key = 'typer'"
    ]) {
      await db.query(`update atomic_note_relations set ${change} where id = $1`, [directed.id]);
      assert.equal(await fingerprint(), original, `I-R7: ${change} keeps the fingerprint`);
    }
    await db.query(
      "update atomic_note_relations set vetoed_at = now(), veto_source = 'explainer' where id = $1",
      [directed.id]
    );
    assert.equal(await fingerprint(), original, "I-R7: a veto keeps the fingerprint");
    assert.equal(
      await isCurrent(),
      false,
      "C3: a withdrawn note relation supports no source evidence"
    );
    await db.query(
      "update atomic_note_relations set vetoed_at = null, veto_source = null where id = $1",
      [directed.id]
    );
    assert.equal(await isCurrent(), true, "kept again, it supports its evidence again");
    await db.query(
      "update atomic_note_relations set band = 'suggest', direction_source = 'typer' where id = $1",
      [directed.id]
    );
    assert.equal(
      await isCurrent(),
      true,
      "decision 29: a suggestion supports its evidence (a suggested source relation)"
    );
    await db.query(
      "update atomic_note_relations set band = null, direction_source = null where id = $1",
      [directed.id]
    );
    await db.query("update atomic_note_relations set direction = 'hi_to_lo' where id = $1", [
      directed.id
    ]);
    assert.notEqual(await fingerprint(), original, "a change of direction is a new fact");
    await db.query(
      "update atomic_note_relations set direction = 'lo_to_hi', relation_type = 'extends' where id = $1",
      [directed.id]
    );
    assert.notEqual(await fingerprint(), original, "a change of type is a new fact");

    // 3. Constraints of the new columns and tables.
    await checkConstraints(db, library);

    // 4. Baseline path: an empty database gets the same shape from the seed.
    await db.query("create database relations_v2_empty");
    const empty = createPgPool({ connectionString: database("relations_v2_empty"), max: 2 });
    pools.push(empty);
    const seeded = await runMigrations(empty, migrationsFolder, { seedFolder });
    assert.ok(seeded.seed.seededMigrations.includes(relationsV2Tag), "the baseline holds 0056");
    assert.equal(await historyCount(empty), await journalLength());
    assert.deepEqual(await shape(empty), await shape(db), "baseline and pending paths agree");

    // 5. A migration killed mid-transaction changes nothing.
    await db.query("create database relations_v2_kill");
    await checkKilledMigration(database("relations_v2_kill"), workDir);

    // 6. Decision 31b: a library at 0058 with automatic relations gets 0059 as pending.
    await db.query("create database relations_v2_source");
    const sourcePool = createPgPool({ connectionString: database("relations_v2_source"), max: 2 });
    pools.push(sourcePool);
    await runMigrations(
      sourcePool,
      await migrationsBefore(workDir, directionSourceTag, "drizzle-before-0059")
    );
    assert.equal(
      await columnExists(sourcePool, "atomic_note_relations", "direction_source"),
      false
    );
    const banded = await seedBandedLibrary(sourcePool);
    const directionSource = await migrateDirectionSource(sourcePool);
    assert.ok(directionSource && directionSource.typer === 4, "four banded directed relations");
    assert.equal(directionSource.eventImagesPatched, 4, "four images name their source");
    assert.equal(await historyCount(sourcePool), await journalLength(), "0059 applied as pending");
    // A run recorded before the migration still reverts: its rows equal their images again.
    const reverted = await createRelationEventRepository(sourcePool).revertRun(banded.runId);
    assert.equal(
      reverted.kind,
      "reverted",
      `a run recorded before 0059 reverts: ${JSON.stringify(reverted)}`
    );

    console.info(
      JSON.stringify(
        {
          verified: [
            "0059 applied as a pending migration on a library at 0058: every automatic directed relation is a typer guess",
            "its event images name the source too; no other column or image key changed; a run recorded before 0059 reverts",
            "0056 applied as a pending migration on a library at 0055 with data",
            `direction backfill on ${legacyRelationShapes.length} metadata shapes; metadata, statuses and types untouched`,
            "the pair sorted (lo < hi) for rows stored high-to-low, with their decided direction",
            "current source evidence identical before and after under the facts-only fingerprint",
            "every fingerprint of the former formula re-keyed, current or not: a discarded note's evidence revives on approval",
            "I-R7: status, band, probability, veto, keys and metadata keep the fingerprint; type and direction change it",
            "C3: a withdrawn note relation supports no source evidence; a suggested one supports a suggested source relation",
            "constraints of note relations (direction and its source), source relations, typings, runs and events",
            "0056 through the baseline seed on an empty database: identical shape",
            "a migration killed mid-transaction leaves the database unchanged and migrates later"
          ],
          report: evidence.report,
          counts,
          directionSource,
          migrationMs: evidence.ms
        },
        null,
        2
      )
    );
  } finally {
    for (const pool of pools.reverse()) await closePgPool(pool).catch(() => undefined);
    await manager.stop().catch(() => undefined);
    await rm(workDir, { recursive: true, force: true });
  }
}

async function connectionStringOf(value: string): Promise<string> {
  if (/^postgres(ql)?:\/\//u.test(value)) return value;
  const file = JSON.parse(await readFile(resolve(value), "utf8")) as { connectionString?: unknown };
  if (typeof file.connectionString !== "string")
    throw new Error(`${value} has no connectionString.`);
  return file.connectionString;
}

/**
 * The stored state of automatic relation writes: no event of an automatic run on a pair with a human
 * verdict (I-R2, I-R3), and an event behind every banded or vetoed note relation (I-R8).
 */
const automationStateSql = `select
  (select count(*)::int from relation_events e join relation_match_runs run on run.id = e.run_id
    where e.relation_kind = 'note' and run.kind <> 'review'
      and e.before->>'status' in ('accepted', 'rejected')) as "automaticEventsOnReviewed",
  (select count(*)::int from atomic_note_relations n where n.band is not null
      and not exists (select 1 from relation_events e
                       where e.relation_kind = 'note' and e.relation_id = n.id)) as "bandedWithoutEvent",
  (select count(*)::int from atomic_note_relations n where n.vetoed_at is not null
      and not exists (select 1 from relation_events e where e.relation_kind = 'note'
                         and e.relation_id = n.id and e.kind = 'vetoed')) as "vetoedWithoutEvent"`;

/** The invariants this script cannot read from a database, and what proves each. */
const provenElsewhere = {
  "I-R4": "reconcile and recalibration tests: 0 model calls (T51, T58)",
  "I-R5": "relationDecisionRepository tests: reuse only with an equal decider key and hashes",
  "I-R6": "the order-independence property test and replay (T51, T52)",
  "I-R8 revert": "relationEventRepository revertRun tests (T48b)",
  "I-R9": "note-relation-visibility.test.ts (static)"
};

/**
 * Gate M on the existing database at `connectionString`, with the migrations of `folder`: at 0055
 * every pending migration is applied (0056 first) and the migrated state is compared with the state
 * before; with 0056 applied the state is checked. Throws on a database before 0055 or ahead of
 * `folder`, and on any broken invariant.
 */
export async function verifyExistingDatabase(connectionString: string, folder = migrationsFolder) {
  // A pool of its own: 0056's report arrives as a notice on the connections it opens.
  const db = createPgPool({ connectionString, max: 3 });
  try {
    return await verifyExisting(db, folder);
  } finally {
    await closePgPool(db).catch(() => undefined);
  }
}

async function verifyExisting(db: PgPool, folder: string) {
  const notices = captureNotices(db);
  const total = await journalLength(folder);
  const atRelationsV2 = await migrationsBeforeCount(relationsV2Tag, folder);
  const applied = await historyCount(db);
  if (applied < atRelationsV2 || applied > total)
    throw new Error(
      `The database has ${applied} migrations; this code knows ${total} and needs at least the ${atRelationsV2} before ${relationsV2Tag}.`
    );
  const migration = applied === atRelationsV2 ? await migrateCapturing(db, notices, folder) : null;
  if (migration) assert.equal(await historyCount(db), total, "every pending migration applied");
  // A database that already holds 0056 and not yet 0059 gets the direction source here.
  const directionSource = migration ? null : await migrateDirectionSource(db, folder);
  if (directionSource)
    assert.equal(await historyCount(db), total, "every pending migration applied");
  const invariants = (
    await db.query<Record<string, number>>(
      `select count(*)::int as relations,
              count(*) filter (where source_atomic_note_id >= target_atomic_note_id)::int as "unsortedPairs",
              count(*) filter (where direction = 'unknown' and band is not null)::int as "bandedUnknown",
              count(*) filter (where band is not null and relation_type in
                ('supports','extends','depends_on','example_of','clarifies')
                and direction not in ('lo_to_hi','hi_to_lo'))::int as "undirectedDirected",
              count(*) filter (where band is not null and (relation_type is null
                or relation_type in ('contradicts','same_as')) and direction <> 'symmetric')::int as "directedSymmetric",
              count(*) filter (where direction in ('lo_to_hi','hi_to_lo','unknown')
                and relation_type not in ('contrasts','similar_to','contradicts','same_as')
                and ${metadataDirectionSql} is not null
                and direction is distinct from ${metadataDirectionSql})::int as "metadataDisagreements",
              count(*) filter (where direction = 'unknown')::int as "unknown",
              count(*) filter (where band is not null and direction in ('lo_to_hi','hi_to_lo')
                and direction_source is null)::int as "directedWithoutSource",
              count(*) filter (where band is null and direction_source is not null)::int as "sourceOnLegacy",
              count(*) filter (where direction_source is not null and direction = 'symmetric'
                and direction_source <> 'owner')::int as "symmetricWithSource"
         from atomic_note_relations`
    )
  ).rows[0]!;
  for (const key of [
    "unsortedPairs",
    "bandedUnknown",
    "undirectedDirected",
    "directedSymmetric",
    "directedWithoutSource",
    "sourceOnLegacy",
    "symmetricWithSource",
    "metadataDisagreements"
  ])
    assert.equal(invariants[key], 0, `I-R1: ${key}`);
  const automation = (await db.query<Record<string, number>>(automationStateSql)).rows[0]!;
  assert.equal(automation.automaticEventsOnReviewed, 0, "I-R2, I-R3: automaticEventsOnReviewed");
  assert.equal(automation.bandedWithoutEvent, 0, "I-R8: bandedWithoutEvent");
  assert.equal(automation.vetoedWithoutEvent, 0, "I-R8: vetoedWithoutEvent");
  const counts = migration ? await checkMigrated(db, migration) : null;
  const tables = (
    await db.query<Record<string, number>>(
      `select (select count(*)::int from source_relations) as "sourceRelations",
              (select count(*)::int from source_relation_evidence) as "sourceEvidence",
              (select count(*)::int from (${currentEvidenceSql}) current) as "currentEvidence",
              (select count(*)::int from relation_decisions) as "relationDecisions",
              (select count(*)::int from relation_events) as "relationEvents"`
    )
  ).rows[0]!;
  return {
    migrated: migration !== null,
    migrationMs: migration?.ms ?? null,
    history: { before: applied, after: await historyCount(db), total },
    report: migration?.report ?? null,
    directionSource,
    invariants: { ...invariants, ...automation },
    counts,
    tables,
    elsewhere: provenElsewhere
  };
}

async function existingDatabase(value: string) {
  const connectionString = await connectionStringOf(value);
  const host = new URL(connectionString).hostname;
  if (!["127.0.0.1", "localhost", "::1", "[::1]"].includes(host))
    throw new Error("Only a loopback scratch database is verified.");
  const summary = await verifyExistingDatabase(connectionString);
  console.info(
    JSON.stringify({ database: new URL(connectionString).pathname.slice(1), ...summary }, null, 2)
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const { values } = parseArgs({ options: { db: { type: "string" } }, strict: true });
  await (values.db ? existingDatabase(values.db) : selfContained());
}
