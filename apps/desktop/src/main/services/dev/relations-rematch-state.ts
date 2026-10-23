// What a relation re-match run reads and changes in the database (F3 T52b, spec 3.17): the roots of
// the library, the notes digest, the relation state it clears, the background it marks as matched,
// the link jobs it waits for and the facts of its summary. Only the clear and the background seed
// write, and only on a profile clone the caller has already checked.
import { createHash } from "node:crypto";

import {
  createAtomicNoteRepository,
  createNoteMatchStateRepository,
  createSourceMatchStateRepository,
  withTransaction,
  type PgPool
} from "@app/db";
import type { Queryable } from "@app/db";

import { kthVectorCosine } from "../relations/relation-matcher.js";
import type { RematchRecord, RematchRoot } from "./relations-rematch-plan.js";

const toDate = (value: unknown): Date | null => {
  if (value === null || value === undefined) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
};

// --- roots ------------------------------------------------------------------------------------------

/** The library's roots in ingestion order, each with the sources below it that hold notes. */
export async function listLibraryRoots(
  db: Queryable
): Promise<Array<Omit<RematchRoot, "partition">>> {
  const result = await db.query<{
    rootId: string;
    rootTitle: string;
    recordId: string;
    recordTitle: string;
    notes: number;
  }>(
    `with recursive tree(root_id, id, depth) as (
       select id, id, 0 from source_items where parent_source_item_id is null
       union all
       select t.root_id, c.id, t.depth + 1
         from source_items c join tree t on c.parent_source_item_id = t.id)
     select r.id as "rootId", r.title as "rootTitle", t.id as "recordId", s.title as "recordTitle",
            count(n.id)::int as notes
       from tree t
       join source_items r on r.id = t.root_id
       join source_items s on s.id = t.id
       left join atomic_notes n on n.created_from_source_item_id = t.id
            and n.status not in ('rejected', 'archived') and n.supersession_status = 'current'
      group by r.id, r.title, r.created_at, t.id, t.depth, s.title, s.created_at
      order by r.created_at, r.id, t.depth, s.created_at, s.title, t.id`
  );
  const roots = new Map<string, Omit<RematchRoot, "partition">>();
  for (const row of result.rows) {
    const root = roots.get(row.rootId) ?? {
      id: row.rootId,
      title: row.rootTitle,
      records: [] as RematchRecord[],
      notes: 0
    };
    roots.set(row.rootId, root);
    const notes = Number(row.notes);
    if (notes > 0) {
      root.records.push({ id: row.recordId, title: row.recordTitle, notes });
      root.notes += notes;
    }
  }
  return [...roots.values()];
}

// --- the pinned digest ------------------------------------------------------------------------------

export interface NotesDigest {
  notes: number;
  sha256: string;
}

/** The golden runner's order-independent digest: sorted lines, joined by newlines, SHA-256. */
export function contentDigest(lines: readonly string[]): NotesDigest {
  const sorted = [...lines].sort();
  return {
    notes: sorted.length,
    sha256: createHash("sha256").update(sorted.join("\n")).digest("hex")
  };
}

/**
 * The digest of every note of the library, as `contentDigests().notes` of the golden runner defines
 * it (an ID-free line per note: its source path, title, hash of idea and body, status), so the
 * 138 pinned notes of ENV-F and the 160 of ENV-G are recognized after a clone.
 */
export async function readNotesDigest(db: Queryable): Promise<NotesDigest> {
  const result = await db.query<{ line: string }>(
    `select coalesce(p.title || ' / ', '') || s.title || '|' || n.title || '|' ||
            md5(coalesce(n.idea_statement, '') || '|' || coalesce(n.body_markdown, '')) || '|' ||
            n.status::text as line
       from atomic_notes n
       join source_items s on s.id = n.created_from_source_item_id
       left join source_items p on p.id = s.parent_source_item_id`
  );
  return contentDigest(result.rows.map((row) => row.line));
}

// --- clearing ---------------------------------------------------------------------------------------

export interface ClearedCounts {
  noteRelations: number;
  decisions: number;
  typings: number;
  noteMatchState: number;
  sourceRelations: number;
  /** The judged-pair cache and the checkpoints of the earlier source matching stage. */
  sourceDecisions: number;
  sourceMatchState: number;
  runs: number;
  events: number;
}

/**
 * Clears the relation state a run measures, in one transaction: note relations, the decisions of the
 * current decider key (other deciders' history stays), typings, match state, source relations with
 * their judged-pair cache, and the runs with their events. `all` empties it; a root list clears only
 * what touches those roots' notes and sources, leaving a matched background as it was.
 */
export async function clearRelationState(
  pool: PgPool,
  input: { deciderKey: string; scope: "all" | { rootIds: readonly string[] } }
): Promise<ClearedCounts> {
  return withTransaction(pool, async (client) => {
    const rows = async (text: string, values: readonly unknown[] = []) =>
      (await client.query(text, [...values])).rowCount ?? 0;
    const counts: ClearedCounts = {
      noteRelations: 0,
      decisions: 0,
      typings: 0,
      noteMatchState: 0,
      sourceRelations: 0,
      sourceDecisions: 0,
      sourceMatchState: 0,
      runs: 0,
      events: 0
    };
    if (input.scope === "all") {
      counts.events = Number(
        (await client.query<{ n: string }>("select count(*)::text as n from relation_events"))
          .rows[0]?.n ?? 0
      );
      counts.sourceRelations = await rows("delete from source_relations");
      counts.sourceDecisions =
        (await rows("delete from source_matching_decisions")) +
        (await rows("delete from source_matching_runs"));
      counts.sourceMatchState = await rows("delete from source_match_state");
      counts.runs = await rows("delete from relation_match_runs");
      counts.noteRelations = await rows("delete from atomic_note_relations");
      counts.decisions = await rows("delete from relation_decisions where decider_key = $1", [
        input.deciderKey
      ]);
      counts.typings = await rows("delete from relation_typings");
      counts.noteMatchState = await rows("delete from note_match_state");
      return counts;
    }
    const roots = [...input.scope.rootIds];
    await client.query(
      `create temporary table rematch_sources on commit drop as
         with recursive tree(id) as (
           select id from source_items where id = any($1::uuid[])
           union all
           select c.id from source_items c join tree p on c.parent_source_item_id = p.id)
         select id from tree`,
      [roots]
    );
    await client.query(
      `create temporary table rematch_notes on commit drop as
         select id from atomic_notes where created_from_source_item_id in (select id from rematch_sources)`
    );
    const inScope = "(select id from rematch_notes)";
    counts.sourceRelations = await rows(
      `delete from source_relations where source_item_id in (select id from rematch_sources)
          or target_source_item_id in (select id from rematch_sources)`
    );
    counts.sourceDecisions =
      (await rows(
        `delete from source_matching_decisions where source_root_id = any($1::uuid[])
            or target_root_id = any($1::uuid[])`,
        [roots]
      )) +
      (await rows("delete from source_matching_runs where source_root_id = any($1::uuid[])", [
        roots
      ]));
    counts.sourceMatchState = await rows(
      "delete from source_match_state where root_id = any($1::uuid[])",
      [roots]
    );
    counts.events = await rows(
      `delete from relation_events where run_id in
         (select id from relation_match_runs where root_id in (select id from rematch_sources))`
    );
    counts.runs = await rows(
      "delete from relation_match_runs where root_id in (select id from rematch_sources)"
    );
    counts.noteRelations = await rows(
      `delete from atomic_note_relations
        where source_atomic_note_id in ${inScope} or target_atomic_note_id in ${inScope}`
    );
    counts.decisions = await rows(
      `delete from relation_decisions
        where decider_key = $1 and (lo_atomic_note_id in ${inScope} or hi_atomic_note_id in ${inScope})`,
      [input.deciderKey]
    );
    counts.typings = await rows(
      `delete from relation_typings
        where split_part(pair_key, ':', 1) in (select id::text from rematch_notes)
           or split_part(pair_key, ':', 2) in (select id::text from rematch_notes)`
    );
    counts.noteMatchState = await rows(`delete from note_match_state where note_id in ${inScope}`);
    return counts;
  });
}

// --- the background ---------------------------------------------------------------------------------

/** The prefix of a root's composite vector in `embeddings_<dimensions>` (`strategy`). */
const compositeStrategyPrefix = "source-composite-centroid-v2:";
const embeddingDimensions = [256, 768, 1024] as const;
/** What a background root's state records as its fingerprint: nothing was judged for it. */
export const backgroundFingerprint = "rematch-background";

/**
 * Records the roots outside the run as already matched, so discovery sees the whole library: each
 * one in ingestion order, with its nearest earlier root by composite cosine (nothing is judged). The
 * space is the one most of these roots have a composite vector in; roots without one are not
 * matched. Resolves to the number of roots recorded.
 */
export async function seedBackgroundMatchState(
  db: Queryable,
  rootIds: readonly string[]
): Promise<number> {
  if (rootIds.length === 0) return 0;
  let best: { dimensions: number; strategy: string; count: number } | null = null;
  for (const dimensions of embeddingDimensions) {
    const found = await db.query<{ strategy: string; count: number }>(
      `select strategy, count(*)::int as count from embeddings_${dimensions}
        where target_type = 'source_item' and strategy like $2 and target_id = any($1::uuid[])
        group by strategy order by count(*) desc limit 1`,
      [rootIds, `${compositeStrategyPrefix}%`]
    );
    const row = found.rows[0];
    if (row && (!best || Number(row.count) > best.count))
      best = { dimensions, strategy: row.strategy, count: Number(row.count) };
  }
  if (!best) return 0;
  const nearest = await db.query<{
    rootId: string;
    nearestRootId: string | null;
    cosine: number | null;
  }>(
    `with roots as (
       select e.target_id as root_id, e.embedding,
              row_number() over (order by s.created_at, s.id) as rn
         from embeddings_${best.dimensions} e join source_items s on s.id = e.target_id
        where e.target_type = 'source_item' and e.strategy = $2 and e.target_id = any($1::uuid[]))
     select a.root_id as "rootId", b.root_id as "nearestRootId",
            1 - (a.embedding <=> b.embedding) as cosine
       from roots a
       left join lateral (
         select r.root_id, r.embedding from roots r where r.rn < a.rn
          order by a.embedding <=> r.embedding limit 1) b on true
      order by a.rn`,
    [rootIds, best.strategy]
  );
  const state = createSourceMatchStateRepository(db);
  const spaceKey = best.strategy.slice(compositeStrategyPrefix.length);
  for (const row of nearest.rows)
    await state.record({
      rootId: row.rootId,
      nearestRootId: row.nearestRootId,
      nearestCosine: row.cosine === null ? null : Math.max(-1, Math.min(1, Number(row.cosine))),
      spaceKey,
      fingerprint: backgroundFingerprint
    });
  return nearest.rows.length;
}

/** The newest stored vector of an atomic note, with the embedding space it was made in. */
interface BackgroundNoteVector {
  embedding: number[];
  model: string;
  provider: string;
  runtime: string;
  spaceKey: string;
}

const nativeEmbeddingStrategyPrefix = "native-v2:";

async function newestNoteVectors(
  db: Queryable,
  noteIds: readonly string[]
): Promise<Map<string, BackgroundNoteVector>> {
  const found = new Map<string, BackgroundNoteVector & { createdAt: number }>();
  if (noteIds.length === 0) return found;
  for (const dimensions of embeddingDimensions) {
    const result = await db.query<{
      targetId: string;
      embedding: string;
      model: string;
      provider: string;
      runtime: string;
      strategy: string;
      createdAt: Date | string;
    }>(
      `select distinct on (target_id) target_id::text as "targetId", embedding::text as embedding, model,
              provider, runtime, strategy, created_at as "createdAt"
         from embeddings_${dimensions}
        where target_type = 'atomic_note' and target_id = any($1::uuid[])
        order by target_id, created_at desc`,
      [[...noteIds]]
    );
    for (const row of result.rows) {
      const createdAt = new Date(row.createdAt).getTime();
      if ((found.get(row.targetId)?.createdAt ?? -Infinity) >= createdAt) continue;
      found.set(row.targetId, {
        embedding: JSON.parse(row.embedding) as number[],
        model: row.model,
        provider: row.provider,
        runtime: row.runtime,
        spaceKey: row.strategy.startsWith(nativeEmbeddingStrategyPrefix)
          ? row.strategy.slice(nativeEmbeddingStrategyPrefix.length)
          : "",
        createdAt
      });
    }
  }
  return found;
}

/**
 * Gives every current note of the background roots the match state a library matched at arrival would
 * hold (D19): the cosine of its k-th vector candidate, taken over the background alone, since the roots
 * a run releases arrive after it. Without it the reverse guard finds no decided library note and a
 * TP-C200 run does less local work than the product (T57: K_eff 10.45 against 12.23). The candidates
 * come from the matcher's own vector query, fenced to the background roots, and the k-th cosine from its
 * own `kthVectorCosine`, so the state is what the matcher would have written. Resolves to the number of
 * notes recorded; a note with no stored vector is left without state, as it would be in the product.
 */
export async function seedBackgroundNoteState(
  db: Queryable,
  input: { rootIds: readonly string[]; deciderKey: string; k: number; vectorK: number }
): Promise<number> {
  if (input.rootIds.length === 0) return 0;
  const noteIds = (
    await db.query<{ id: string }>(
      `with recursive tree(id) as (
         select id from source_items where id = any($1::uuid[])
         union all
         select c.id from source_items c join tree t on c.parent_source_item_id = t.id)
       select n.id::text as id
         from atomic_notes n join tree t on t.id = n.created_from_source_item_id
        where n.status not in ('rejected', 'archived') and n.supersession_status = 'current'
        order by n.id`,
      [[...input.rootIds]]
    )
  ).rows.map((row) => row.id);
  const notes = createAtomicNoteRepository(db);
  const states = createNoteMatchStateRepository(db);
  const fence = { rootSourceItemIds: [...input.rootIds] };
  let recorded = 0;
  for (let start = 0; start < noteIds.length; start += 500) {
    const vectors = await newestNoteVectors(db, noteIds.slice(start, start + 500));
    for (const noteId of noteIds.slice(start, start + 500)) {
      const vector = vectors.get(noteId);
      if (!vector) continue;
      const candidates = await notes.findVectorMatchingCandidates({
        noteId,
        embedding: vector.embedding,
        embeddingModel: vector.model,
        embeddingSpaceKey: vector.spaceKey,
        embeddingProvider: vector.provider,
        embeddingRuntime: vector.runtime,
        limit: input.vectorK,
        fence
      });
      await states.record({
        noteId,
        deciderKey: input.deciderKey,
        spaceKey: vector.spaceKey,
        kthCosine: kthVectorCosine(
          candidates.map((candidate) => candidate.vectorScore),
          input.k
        )
      });
      recorded += 1;
    }
  }
  return recorded;
}

// --- candidate recording ----------------------------------------------------------------------------

/**
 * Turns the profile's debug mode on, so the matcher keeps every note's candidate list (ranks, signals,
 * the guard, the decision source and band) in `similarity_debug_*` beside the raw scores of
 * `relation_decisions` (T57's M1 exports them for T58). Debug mode adds debug and monitoring rows and
 * changes no request. Resolves to false when the profile has no saved app preferences to change: the
 * app would write its defaults (debug off) on first read, so a run that needs the candidates stops.
 */
export async function enableCandidateRecording(db: Queryable): Promise<boolean> {
  const result = await db.query<{ debugMode: string | null }>(
    `update settings
        set value = jsonb_set(value, '{debugMode}', 'true'::jsonb), updated_at = now()
      where key = 'app.preferences'
      returning value ->> 'debugMode' as "debugMode"`
  );
  return result.rows.length === 1 && result.rows[0]?.debugMode === "true";
}

// --- link jobs and the facts of a run ---------------------------------------------------------------

/** The job types a run waits for: the link job of a root and the source relation jobs it queues. */
export const drainJobTypeSql = "(type = 'relation-link' or type like 'source-relation-%')";

/**
 * Link and source-relation jobs still queued or running; the re-match job itself is not one, and
 * neither is a queued job a blocker set aside (F4 D5: it is not queued work).
 */
export async function countOpenLinkJobs(db: Queryable): Promise<number> {
  const result = await db.query<{ open: number }>(
    `select count(*)::int as open from jobs
      where (status = 'running' or (status = 'queued' and blocked_class is null))
        and ${drainJobTypeSql}`
  );
  return Number(result.rows[0]?.open ?? 0);
}

export interface AiCallFacts {
  taskType: string;
  workloadClass: string | null;
  lane: string | null;
  calls: number;
  /** Calls a cassette served instead of the provider. */
  replayed: number;
  failed: number;
  repairs: number;
  inputTokens: number;
  outputTokens: number;
  durationMs: { total: number; p50: number; p95: number };
  requeueMs: { p50: number; p95: number };
}

export interface LinkJobFacts {
  rootId: string | null;
  status: string;
  attempts: number;
  createdAt: Date | null;
  startedAt: Date | null;
  finishedAt: Date | null;
  error: string | null;
}

export interface RelationCountFacts {
  status: string;
  band: string | null;
  relationType: string | null;
  vetoSource: string | null;
  count: number;
}

export interface RunFacts {
  aiCalls: AiCallFacts[];
  /** The first decide-class call's admission (its start less its wait for the lane). */
  firstDecideAdmissionAt: Date | null;
  /** The last relation, typing, veto or source relation committed since the run started. */
  lastCommitAt: Date | null;
  noteRelations: RelationCountFacts[];
  typings: Array<{ relationType: string; count: number }>;
  sourceRelations: Array<{ origin: string; status: string; count: number }>;
  linkJobs: LinkJobFacts[];
}

/** Reads what the run did, from the audit and the relation tables, for rows made since `since`. */
export async function readRunFacts(db: Queryable, since: Date): Promise<RunFacts> {
  const num = (value: unknown) => (value === null || value === undefined ? 0 : Number(value));
  const calls = await db.query(
    `select r.task_type as "taskType", r.workload_class as "workloadClass", r.lane,
            count(*)::int as calls,
            (count(*) filter (where m.token_usage ? 'cassette.replayed'))::int as replayed,
            (count(*) filter (where r.status <> 'succeeded'))::int as failed,
            (count(*) filter (where r.is_repair))::int as repairs,
            coalesce(sum(r.input_tokens), 0)::bigint as "inputTokens",
            coalesce(sum(r.output_tokens), 0)::bigint as "outputTokens",
            coalesce(sum(r.duration_ms), 0)::bigint as "durationTotal",
            coalesce(percentile_cont(0.5) within group (order by r.duration_ms), 0) as "durationP50",
            coalesce(percentile_cont(0.95) within group (order by r.duration_ms), 0) as "durationP95",
            coalesce(percentile_cont(0.5) within group (order by coalesce(r.queue_ms, 0)), 0) as "queueP50",
            coalesce(percentile_cont(0.95) within group (order by coalesce(r.queue_ms, 0)), 0) as "queueP95"
       from ai_task_runs r
       left join lateral (select token_usage from monitoring_operations
                           where ai_task_run_id = r.id limit 1) m on true
      where r.started_at >= $1
      group by r.task_type, r.workload_class, r.lane
      order by r.task_type, r.workload_class, r.lane`,
    [since]
  );
  const first = await db.query(
    `select min(started_at - make_interval(secs => coalesce(queue_ms, 0) / 1000.0)) as at
       from ai_task_runs where started_at >= $1 and workload_class = 'decide'`,
    [since]
  );
  const last = await db.query(
    `select greatest(
        (select max("at") from relation_events where "at" >= $1),
        (select max(decided_at) from relation_typings where decided_at >= $1),
        (select max(updated_at) from source_relations where updated_at >= $1),
        (select max(finished_at) from relation_match_runs where finished_at >= $1)) as at`,
    [since]
  );
  const relations = await db.query(
    `select status::text as status, band, relation_type as "relationType", veto_source as "vetoSource",
            count(*)::int as count
       from atomic_note_relations group by 1, 2, 3, 4 order by 1, 2, 3, 4`
  );
  const typings = await db.query(
    `select relation_type as "relationType", count(*)::int as count from relation_typings
      group by 1 order by 1`
  );
  const sources = await db.query(
    `select origin, status::text as status, count(*)::int as count from source_relations
      group by 1, 2 order by 1, 2`
  );
  const jobs = await db.query(
    `select coalesce(payload->>'rootId', payload->>'sourceItemId') as "rootId", status::text as status,
            attempts, created_at as "createdAt", locked_at as "startedAt", finished_at as "finishedAt",
            error
       from jobs where ${drainJobTypeSql} and created_at >= $1 order by created_at, id`,
    [since]
  );
  return {
    aiCalls: calls.rows.map((row) => ({
      taskType: String(row.taskType),
      workloadClass: row.workloadClass ?? null,
      lane: row.lane ?? null,
      calls: num(row.calls),
      replayed: num(row.replayed),
      failed: num(row.failed),
      repairs: num(row.repairs),
      inputTokens: num(row.inputTokens),
      outputTokens: num(row.outputTokens),
      durationMs: {
        total: num(row.durationTotal),
        p50: Math.round(num(row.durationP50)),
        p95: Math.round(num(row.durationP95))
      },
      requeueMs: { p50: Math.round(num(row.queueP50)), p95: Math.round(num(row.queueP95)) }
    })),
    firstDecideAdmissionAt: toDate(first.rows[0]?.at),
    lastCommitAt: toDate(last.rows[0]?.at),
    noteRelations: relations.rows.map((row) => ({
      status: String(row.status),
      band: row.band ?? null,
      relationType: row.relationType ?? null,
      vetoSource: row.vetoSource ?? null,
      count: num(row.count)
    })),
    typings: typings.rows.map((row) => ({
      relationType: String(row.relationType),
      count: num(row.count)
    })),
    sourceRelations: sources.rows.map((row) => ({
      origin: String(row.origin),
      status: String(row.status),
      count: num(row.count)
    })),
    linkJobs: jobs.rows.map((row) => ({
      rootId: row.rootId ?? null,
      status: String(row.status),
      attempts: num(row.attempts),
      createdAt: toDate(row.createdAt),
      startedAt: toDate(row.startedAt),
      finishedAt: toDate(row.finishedAt),
      error: row.error ? String(row.error).slice(0, 300) : null
    }))
  };
}
