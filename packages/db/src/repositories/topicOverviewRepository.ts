import type { QueryResultRow } from "pg";

import type {
  ChangeSetBlockerCode,
  ChangeSetRisk,
  OverviewChangeOrigin,
  OverviewDivergence
} from "@app/domain";

import { withTransaction, type PgPool } from "../client.js";
import { mapTimestamp } from "./sql.js";
import type { Queryable } from "./types.js";

// The lazy overviews of topics (F2 T31, D16). This repository alone writes `topic_overviews`,
// `topic_overview_citations` and `topic_overview_versions` (D9); the topic tables themselves are
// read only. An overview is cached for the members it was written from (the primary placements of
// the topic's subtree), and every citation points at an exact chunk and span. A citation whose
// passage was replaced or whose note was deleted keeps its excerpt and reads as unavailable; it
// never becomes current evidence again.
//
// Every write that replaces an overview is a change-set (F4 D10, D17): it raises the overview's
// `version` and keeps the replaced text, citations and provenance in `topic_overview_versions`,
// so it can be undone exactly while no later write moved the overview on. A proposal (Suggest
// autonomy) is stored there with the version it was made on and applied only on the owner's verdict.

/** The topic an overview is for: a live topic of the active tree, redirects of retired ones followed. */
export interface TopicOverviewTopic {
  id: string;
  treeId: string;
  role: "root" | "topic";
  title: string | null;
  description: string | null;
  /** The ID that was asked for, when it was a retired topic merged into this one. */
  redirectedFrom: string | null;
}

/** The members of a topic: the primary placements of its subtree. */
export interface TopicOverviewMembers {
  notes: number;
  items: number;
  /** A fingerprint of the members and the vectors they were placed with. */
  fingerprint: string;
}

/** One evidence item as stored with the overview (provenance, not shown). */
export interface StoredOverviewEvidence {
  noteId: string;
  chunkId: string;
  sourceSpanId: string | null;
  sourceId: string | null;
  contentHash: string;
}

export interface StoredOverviewCitation {
  n: number;
  chunkId: string | null;
  sourceSpanId: string | null;
  noteId: string | null;
  sourceId: string | null;
  sourceTitle: string;
  excerpt: string;
  excerptHash: string;
  /** The passage still exists and belongs to the current version of its source. */
  available: boolean;
}

export interface StoredTopicOverview {
  paragraphs: Array<{ text: string; citations: number[] }>;
  evidence: StoredOverviewEvidence[];
  memberFingerprint: string;
  memberCount: number;
  inputHash: string;
  promptRevisionId: string;
  provider: string;
  model: string;
  runtime: string;
  aiTaskRunId: string | null;
  language: string;
  support: Record<string, unknown>;
  writtenAt: Date;
  /** `written_at` at full precision: the token a support update names its writing by. */
  writtenAtExact: string;
  citations: StoredOverviewCitation[];
  /** Divergences kept beside the prose (F4 D17). */
  divergences: OverviewDivergence[];
  /** Raised by every write; a proposal names the version it was made on. */
  version: number;
}

export interface TopicOverviewContext {
  topic: TopicOverviewTopic;
  members: TopicOverviewMembers;
  stored: StoredTopicOverview | null;
}

/** A central note of the subtree with its primary passage, a candidate for the evidence. */
export interface TopicOverviewEvidenceRow {
  noteId: string;
  /** Rank of the note inside its own topic (0 = the most central one). */
  round: number;
  centrality: number | null;
  title: string;
  idea: string;
  chunkId: string;
  sourceSpanId: string | null;
  passage: string;
  sourceId: string;
  sourceTitle: string;
}

export interface SaveTopicOverviewInput {
  topicId: string;
  paragraphs: Array<{ text: string; citations: number[] }>;
  evidence: StoredOverviewEvidence[];
  memberFingerprint: string;
  memberCount: number;
  inputHash: string;
  promptRevisionId: string;
  provider: string;
  model: string;
  runtime: string;
  aiTaskRunId: string | null;
  language: string;
  support: Record<string, unknown>;
  citations: Array<{
    n: number;
    chunkId: string;
    sourceSpanId: string | null;
    noteId: string | null;
    excerpt: string;
    excerptHash: string;
  }>;
  /** Divergences to keep beside the prose (F4 D17); none when absent. */
  divergences?: OverviewDivergence[];
}

/** How a write records itself as a change-set; the defaults title it by its origin. */
export interface TopicOverviewChange {
  origin?: Exclude<OverviewChangeOrigin, "undo">;
  titleKey?: string;
  titleParams?: Record<string, string | number | boolean | null>;
  risk?: ChangeSetRisk;
  jobId?: string | null;
}

export interface WriteTopicOverviewInput extends SaveTopicOverviewInput {
  /** The version the text was computed from; another one stored answers `moved`, writing nothing. */
  expectedVersion?: number;
  change?: TopicOverviewChange;
}

export type TopicOverviewWriteResult =
  | {
      kind: "written";
      writtenAt: Date;
      writtenAtExact: string;
      version: number;
      /** The change-set that keeps the replaced text; null when the write replaced none. */
      changeSetId: string | null;
    }
  | { kind: "retired" }
  | { kind: "moved"; version: number };

/** A stored overview as a version keeps it: the citations as written, not resolved. */
interface OverviewSnapshot {
  paragraphs: Array<{ text: string; citations: number[] }>;
  evidence: StoredOverviewEvidence[];
  memberFingerprint: string;
  memberCount: number;
  inputHash: string;
  promptRevisionId: string;
  provider: string;
  model: string;
  runtime: string;
  aiTaskRunId: string | null;
  language: string;
  support: Record<string, unknown>;
  divergences: OverviewDivergence[];
  version: number;
  writtenAt: string;
  citations: Array<{
    n: number;
    chunkId: string | null;
    sourceSpanId: string | null;
    noteId: string | null;
    excerpt: string;
    excerptHash: string;
  }>;
}

export type TopicOverviewProposalResult =
  { kind: "proposed"; id: string; baseVersion: number } | { kind: "retired" };

export type TopicOverviewReviewResult =
  | { kind: "applied"; version: number; writtenAtExact: string }
  | { kind: "dismissed" }
  /** The overview was written again since the proposal: it stays pending, to be proposed again. */
  | { kind: "moved"; version: number }
  | { kind: "not_pending"; status: string }
  | { kind: "retired" }
  | { kind: "not_found" };

export type TopicOverviewUndoResult =
  | { kind: "undone"; undoId: string; version: number }
  | { kind: "blocked"; code: ChangeSetBlockerCode }
  | { kind: "not_found" };

/** The default title key of an overview change-set of an origin. */
export const overviewChangeTitleKey = (origin: OverviewChangeOrigin): string =>
  `changes.titles.overview.${origin}`;

/** Bounds of the repository's own work. */
export const topicOverviewReadDefaults = {
  /** Redirects followed from a retired topic. */
  redirectHops: 8,
  /** A source title as shown in a citation. */
  sourceTitleMax: 300
} as const;

/**
 * One step down the tree: the live children of `sub.id` in tree `$2`, each parent probed through
 * the index on (tree, parent, position) by itself, so the cost follows the size of the subtree.
 */
const subtree = `with recursive sub as (
    select t.id from topics t where t.id = $1::uuid and t.tree_id = $2::uuid and t.retired_at is null
    union all
    select c.id from sub
      cross join lateral (
        select k.id from topics k
         where k.tree_id = $2::uuid and k.parent_id = sub.id and k.retired_at is null offset 0) c
  )`;

export const topicOverviewSql = {
  activeTree: `select t.id from topic_trees t where t.status = 'active'`,
  /** $1 topic. */
  topic: `select t.id, t.tree_id as "treeId", t.role, t.title, t.description,
         t.retired_at is not null as retired, t.redirect_to as "redirectTo"
      from topics t where t.id = $1::uuid`,
  /**
   * $1 topic, $2 tree: the members (primary placements of the subtree) and their fingerprint: each
   * item with the fingerprint of the vector it was placed with, in item order.
   */
  members: `${subtree}
    select (count(*) filter (where p.item_kind = 'note'))::int as notes, count(*)::int as items,
           md5(coalesce(string_agg(
             p.item_kind || ':' || coalesce(p.note_id, p.source_item_id)::text || ':' ||
             coalesce(p.item_fingerprint, ''), ','
             order by p.item_kind, coalesce(p.note_id, p.source_item_id)), '')) as fingerprint
      from sub
      cross join lateral (
        select q.item_kind, q.note_id, q.source_item_id, q.item_fingerprint from topic_placements q
         where q.topic_id = sub.id and q.role = 'primary' offset 0) p`,
  /**
   * $1 topic, $2 source title length: the stored overview with its citations. A citation resolves
   * its source through its chunk, then its span, then its note; it is available while its chunk
   * exists in a current document.
   */
  stored: `select o.paragraphs, o.evidence, o.member_fingerprint as "memberFingerprint",
         o.member_count as "memberCount", o.input_hash as "inputHash",
         o.prompt_revision_id as "promptRevisionId", o.provider, o.model, o.runtime,
         o.ai_task_run_id as "aiTaskRunId", o.language, o.support, o.written_at as "writtenAt",
         o.written_at::text as "writtenAtExact", o.divergences, o.version,
         coalesce((
           select jsonb_agg(jsonb_build_object(
                    'n', c.n, 'chunkId', c.chunk_id, 'sourceSpanId', c.source_span_id,
                    'noteId', c.note_id, 'sourceId', src.id,
                    'sourceTitle', coalesce(left(src.title, $2::int), ''),
                    'excerpt', c.excerpt, 'excerptHash', c.excerpt_hash,
                    'available', ch.id is not null and not coalesce(d.metadata ? 'supersededByDocumentId', false))
                  order by c.n)
             from topic_overview_citations c
             left join chunks ch on ch.id = c.chunk_id
             left join documents d on d.id = ch.document_id
             left join source_spans sp on sp.id = c.source_span_id
             left join atomic_notes n on n.id = c.note_id
             left join source_items src
               on src.id = coalesce(ch.source_item_id, sp.source_item_id, n.created_from_source_item_id)
            where c.topic_id = o.topic_id), '[]'::jsonb) as citations
      from topic_overviews o where o.topic_id = $1::uuid`,
  /**
   * $1 topic, $2 tree, $3 notes per topic, $4 candidates, $5 source title length: the most central
   * current notes of every topic of the subtree, round by round, with their primary passage in a
   * current document. The span is the note's own when it has one, else its chunk's.
   */
  evidence: `${subtree}
    select p.note_id as "noteId", p.round::int as round, p.centrality, n.title,
           n.idea_statement as idea, ch.id as "chunkId",
           coalesce(n.source_span_id, ch.source_span_id) as "sourceSpanId", ch.content as passage,
           ch.source_item_id as "sourceId", coalesce(left(src.title, $5::int), '') as "sourceTitle"
      from sub
      cross join lateral (
        select top.note_id, top.centrality,
               row_number() over (order by top.centrality desc nulls last, top.id) - 1 as round
          from (
            select q.note_id, q.centrality, q.id from topic_placements q
             where q.topic_id = sub.id and q.role = 'primary' and q.item_kind = 'note'
             order by q.centrality desc nulls last, q.id limit $3::int) top) p
      join atomic_notes n on n.id = p.note_id
      join chunks ch on ch.id = n.evidence_chunk_id
      join documents d on d.id = ch.document_id
      left join source_items src on src.id = ch.source_item_id
     where n.status not in ('rejected', 'archived') and n.supersession_status = 'current'
       and not coalesce(d.metadata ? 'supersededByDocumentId', false)
     order by p.round, p.centrality desc nulls last, p.note_id
     limit $4::int`,
  /**
   * $1 topic and the overview's fields, $14 divergences, $15 the time it was written (a restore
   * keeps the original; null: now): written only while the topic is live, a version up.
   */
  save: `insert into topic_overviews
      (topic_id, paragraphs, evidence, member_fingerprint, member_count, input_hash,
       prompt_revision_id, provider, model, runtime, ai_task_run_id, language, support, written_at,
       divergences, version)
    select $1::uuid, $2::jsonb, $3::jsonb, $4, $5::int, $6, $7, $8, $9, $10, $11::uuid, $12,
           $13::jsonb, coalesce($15::timestamptz, clock_timestamp()), $14::jsonb, 1
     where exists (select 1 from topics t where t.id = $1::uuid and t.retired_at is null)
    on conflict (topic_id) do update set
      paragraphs = excluded.paragraphs, evidence = excluded.evidence,
      member_fingerprint = excluded.member_fingerprint, member_count = excluded.member_count,
      input_hash = excluded.input_hash, prompt_revision_id = excluded.prompt_revision_id,
      provider = excluded.provider, model = excluded.model, runtime = excluded.runtime,
      ai_task_run_id = excluded.ai_task_run_id, language = excluded.language,
      support = excluded.support, written_at = excluded.written_at,
      divergences = excluded.divergences, version = topic_overviews.version + 1
    returning written_at as "writtenAt", written_at::text as "writtenAtExact", version`,
  /** $1 topic: locks the stored overview (a write and an undo serialize on it). */
  lock: `select version from topic_overviews where topic_id = $1::uuid for update`,
  /** $1 topic: the stored overview as a version keeps it (citations as written). */
  snapshot: `select jsonb_build_object(
           'paragraphs', o.paragraphs, 'evidence', o.evidence,
           'memberFingerprint', o.member_fingerprint, 'memberCount', o.member_count,
           'inputHash', o.input_hash, 'promptRevisionId', o.prompt_revision_id,
           'provider', o.provider, 'model', o.model, 'runtime', o.runtime,
           'aiTaskRunId', o.ai_task_run_id, 'language', o.language, 'support', o.support,
           'divergences', o.divergences, 'version', o.version, 'writtenAt', o.written_at,
           'citations', coalesce((
             select jsonb_agg(jsonb_build_object(
                      'n', c.n, 'chunkId', c.chunk_id, 'sourceSpanId', c.source_span_id,
                      'noteId', c.note_id, 'excerpt', c.excerpt, 'excerptHash', c.excerpt_hash)
                    order by c.n)
               from topic_overview_citations c where c.topic_id = o.topic_id), '[]'::jsonb)
         ) as snapshot
      from topic_overviews o where o.topic_id = $1::uuid`,
  /**
   * $1 topic, $2 origin, $3 title key, $4 title parameters, $5 risk, $6 base version, $7 version,
   * $8 undone change-set, $9 job, $10 the replaced overview: an applied write's change-set.
   */
  insertVersion: `insert into topic_overview_versions
      (topic_id, origin, status, title_key, title_params, risk, base_version, version, undo_of,
       job_id, previous, applied_at)
    values ($1::uuid, $2, 'applied', $3, $4::jsonb, $5, $6::int, $7::int, $8::uuid, $9::uuid,
            $10::jsonb, clock_timestamp())
    returning id`,
  /** $1 change-set: locks a version row. */
  lockVersion: `select id, topic_id as "topicId", origin, status, base_version as "baseVersion",
         version, previous is not null as "hasPrevious", proposed, title_key as "titleKey",
         title_params as "titleParams", risk, job_id as "jobId"
      from topic_overview_versions where id = $1::uuid for update`,
  /**
   * $1 topic, $2 origin, $3 title key, $4 title parameters, $5 risk, $6 job, $7 proposed text:
   * a proposal on the version stored now, only while the topic is live.
   */
  propose: `insert into topic_overview_versions
      (topic_id, origin, status, title_key, title_params, risk, base_version, job_id, proposed)
    select $1::uuid, $2, 'pending_review', $3, $4::jsonb, $5, coalesce(
             (select o.version from topic_overviews o where o.topic_id = $1::uuid), 0),
           $6::uuid, $7::jsonb
     where exists (select 1 from topics t where t.id = $1::uuid and t.retired_at is null)
    returning id, base_version as "baseVersion"`,
  /**
   * $1 cutoff, $2 limit: applied or undone writes (never a proposal, applied or not: the owner's
   * verdicts are labels) made before the cutoff, the oldest first, an undo with what it undid.
   */
  prunable: `with eligible as (
      select v.id, v.undo_of, v.created_at from topic_overview_versions v
       where v.status in ('applied', 'undone') and v.proposed is null
         and v.created_at < $1::timestamptz
    ), chosen as (
      select e.id, e.undo_of from eligible e
       where (e.undo_of is null or e.undo_of in (select id from eligible))
         and not exists (select 1 from topic_overview_versions u
                          where u.undo_of = e.id and u.id not in (select id from eligible))
       order by e.created_at, e.id
       limit $2::int
    )
    select id from chosen
    union select undo_of from chosen where undo_of is not null
    union select u.id from topic_overview_versions u where u.undo_of in (select id from chosen)`,
  /** $1 topic. */
  clearCitations: `delete from topic_overview_citations where topic_id = $1::uuid`,
  /**
   * $1 topic, then one array per column. A chunk, span or note deleted since the evidence was read
   * is stored as null (the citation is unavailable at once) instead of failing the write.
   */
  saveCitations: `insert into topic_overview_citations
      (topic_id, n, chunk_id, source_span_id, note_id, excerpt, excerpt_hash)
    select $1::uuid, c.n, ch.id, sp.id, nt.id, c.excerpt, c.excerpt_hash
      from unnest($2::smallint[], $3::uuid[], $4::uuid[], $5::uuid[], $6::text[], $7::text[])
           as c(n, chunk_id, source_span_id, note_id, excerpt, excerpt_hash)
      left join chunks ch on ch.id = c.chunk_id
      left join source_spans sp on sp.id = c.source_span_id
      left join atomic_notes nt on nt.id = c.note_id`,
  /** $1 topic, $2 the writing's `written_at` (full precision), $3 support. */
  saveSupport: `update topic_overviews set support = $3::jsonb
     where topic_id = $1::uuid and written_at = $2::timestamptz
    returning topic_id`
} as const;

interface TopicRow extends QueryResultRow {
  id: string;
  treeId: string;
  role: "root" | "topic";
  title: string | null;
  description: string | null;
  retired: boolean;
  redirectTo: string | null;
}

interface StoredRow extends QueryResultRow {
  paragraphs: StoredTopicOverview["paragraphs"];
  evidence: StoredOverviewEvidence[];
  memberFingerprint: string;
  memberCount: number;
  inputHash: string;
  promptRevisionId: string;
  provider: string;
  model: string;
  runtime: string;
  aiTaskRunId: string | null;
  language: string;
  support: Record<string, unknown>;
  writtenAt: Date | string;
  writtenAtExact: string;
  citations: StoredOverviewCitation[];
  divergences: OverviewDivergence[] | null;
  version: number | string;
}

/** The live topic `id` names in the active tree, following redirects; null when there is none. */
async function resolveTopic(db: Queryable, id: string): Promise<TopicOverviewTopic | null> {
  const tree = (await db.query<{ id: string }>(topicOverviewSql.activeTree)).rows[0];
  if (!tree) return null;
  let current = id;
  for (let hop = 0; hop <= topicOverviewReadDefaults.redirectHops; hop += 1) {
    const row = (await db.query<TopicRow>(topicOverviewSql.topic, [current])).rows[0];
    if (!row || row.treeId !== tree.id) return null;
    if (!row.retired) {
      return {
        id: row.id,
        treeId: row.treeId,
        role: row.role,
        title: row.title,
        description: row.description,
        redirectedFrom: row.id === id ? null : id
      };
    }
    if (!row.redirectTo) return null;
    current = row.redirectTo;
  }
  return null;
}

function storedOf(row: StoredRow | undefined): StoredTopicOverview | null {
  if (!row) return null;
  return {
    paragraphs: row.paragraphs,
    evidence: row.evidence,
    memberFingerprint: row.memberFingerprint,
    memberCount: Number(row.memberCount),
    inputHash: row.inputHash,
    promptRevisionId: row.promptRevisionId,
    provider: row.provider,
    model: row.model,
    runtime: row.runtime,
    aiTaskRunId: row.aiTaskRunId,
    language: row.language,
    support: row.support,
    writtenAt: mapTimestamp(row.writtenAt),
    writtenAtExact: row.writtenAtExact,
    citations: row.citations.map((citation) => ({
      n: Number(citation.n),
      chunkId: citation.chunkId,
      sourceSpanId: citation.sourceSpanId,
      noteId: citation.noteId,
      sourceId: citation.sourceId,
      sourceTitle: citation.sourceTitle,
      excerpt: citation.excerpt,
      excerptHash: citation.excerptHash,
      available: citation.available === true
    })),
    divergences: row.divergences ?? [],
    version: Number(row.version)
  };
}

/** Writes an overview's row and citations inside the caller's transaction (see `write`). */
async function storeOverview(
  db: Queryable,
  topicId: string,
  content: Omit<OverviewSnapshot, "version" | "writtenAt"> & { writtenAt?: string | null }
): Promise<{ writtenAt: Date | string; writtenAtExact: string; version: number } | null> {
  const row = (
    await db.query<{ writtenAt: Date | string; writtenAtExact: string; version: number | string }>(
      topicOverviewSql.save,
      [
        topicId,
        JSON.stringify(content.paragraphs),
        JSON.stringify(content.evidence),
        content.memberFingerprint,
        content.memberCount,
        content.inputHash,
        content.promptRevisionId,
        content.provider,
        content.model,
        content.runtime,
        content.aiTaskRunId,
        content.language,
        JSON.stringify(content.support),
        JSON.stringify(content.divergences),
        content.writtenAt ?? null
      ]
    )
  ).rows[0];
  if (!row) return null;
  await db.query(topicOverviewSql.clearCitations, [topicId]);
  if (content.citations.length > 0) {
    await db.query(topicOverviewSql.saveCitations, [
      topicId,
      content.citations.map((citation) => citation.n),
      content.citations.map((citation) => citation.chunkId),
      content.citations.map((citation) => citation.sourceSpanId),
      content.citations.map((citation) => citation.noteId),
      content.citations.map((citation) => citation.excerpt),
      content.citations.map((citation) => citation.excerptHash)
    ]);
  }
  return {
    writtenAt: row.writtenAt,
    writtenAtExact: row.writtenAtExact,
    version: Number(row.version)
  };
}

/** The content of a write, as a version keeps it and a proposal stores it. */
function contentOf(input: SaveTopicOverviewInput): Omit<OverviewSnapshot, "version" | "writtenAt"> {
  return {
    paragraphs: input.paragraphs,
    evidence: input.evidence,
    memberFingerprint: input.memberFingerprint,
    memberCount: input.memberCount,
    inputHash: input.inputHash,
    promptRevisionId: input.promptRevisionId,
    provider: input.provider,
    model: input.model,
    runtime: input.runtime,
    aiTaskRunId: input.aiTaskRunId,
    language: input.language,
    support: input.support,
    divergences: input.divergences ?? [],
    citations: input.citations
  };
}

interface VersionRow extends QueryResultRow {
  id: string;
  topicId: string;
  origin: OverviewChangeOrigin;
  status: "applied" | "undone" | "pending_review" | "dismissed";
  baseVersion: number | string;
  version: number | string | null;
  hasPrevious: boolean;
  proposed: (Omit<OverviewSnapshot, "version" | "writtenAt"> & { writtenAt?: string }) | null;
}

/**
 * One write in the caller's transaction: locks the stored overview, refuses a moved version,
 * stores the new text a version up and keeps the replaced one as an applied change-set (a
 * proposal's own row when `proposalId` names it, else a new row). The topic must be live.
 */
async function writeIn(
  db: Queryable,
  topicId: string,
  content: Omit<OverviewSnapshot, "version" | "writtenAt"> & { writtenAt?: string | null },
  options: {
    expectedVersion?: number;
    change: Required<Omit<TopicOverviewChange, "origin">> & { origin: OverviewChangeOrigin };
    undoOf?: string | null;
    proposalId?: string;
  }
): Promise<TopicOverviewWriteResult> {
  const locked = (await db.query<{ version: number | string }>(topicOverviewSql.lock, [topicId]))
    .rows[0];
  const current = locked ? Number(locked.version) : 0;
  if (options.expectedVersion !== undefined && options.expectedVersion !== current)
    return { kind: "moved", version: current };
  const previous = locked
    ? ((await db.query<{ snapshot: OverviewSnapshot }>(topicOverviewSql.snapshot, [topicId]))
        .rows[0]?.snapshot ?? null)
    : null;
  const stored = await storeOverview(db, topicId, content);
  if (!stored) return { kind: "retired" };
  let changeSetId: string | null = null;
  if (options.proposalId) {
    await db.query(
      `update topic_overview_versions
          set status = 'applied', version = $2::int, applied_at = clock_timestamp(),
              previous = $3::jsonb
        where id = $1::uuid`,
      [options.proposalId, stored.version, previous === null ? null : JSON.stringify(previous)]
    );
    changeSetId = options.proposalId;
  } else if (previous !== null) {
    changeSetId =
      (
        await db.query<{ id: string }>(topicOverviewSql.insertVersion, [
          topicId,
          options.change.origin,
          options.change.titleKey,
          JSON.stringify(options.change.titleParams),
          options.change.risk,
          current,
          stored.version,
          options.undoOf ?? null,
          options.change.jobId,
          JSON.stringify(previous)
        ])
      ).rows[0]?.id ?? null;
  }
  return {
    kind: "written",
    writtenAt: mapTimestamp(stored.writtenAt),
    writtenAtExact: stored.writtenAtExact,
    version: stored.version,
    changeSetId
  };
}

/** A change's defaults: titled by its origin, low risk, no job. */
function changeOf(
  change: TopicOverviewChange | undefined,
  origin: OverviewChangeOrigin
): Required<Omit<TopicOverviewChange, "origin">> & { origin: OverviewChangeOrigin } {
  const resolved = change?.origin ?? origin;
  return {
    origin: resolved,
    titleKey: change?.titleKey ?? overviewChangeTitleKey(resolved),
    titleParams: change?.titleParams ?? {},
    risk: change?.risk ?? "low",
    jobId: change?.jobId ?? null
  };
}

export function createTopicOverviewRepository(pool: PgPool) {
  /** One consistent snapshot for a read of several statements. */
  async function snapshot<T>(read: (db: Queryable) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("begin transaction isolation level repeatable read, read only");
      const result = await read(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  /**
   * Stores an overview and its citations in one transaction, a version up. Replacing an earlier
   * one keeps it as a change-set (`topic_overview_versions`, undoable); a first write keeps
   * nothing. With `expectedVersion`, a text computed from another version than the stored one is
   * refused (`moved`) and nothing is written; a retired topic writes nothing (`retired`).
   */
  async function write(input: WriteTopicOverviewInput): Promise<TopicOverviewWriteResult> {
    return withTransaction(pool, (client) =>
      writeIn(client, input.topicId, contentOf(input), {
        ...(input.expectedVersion === undefined ? {} : { expectedVersion: input.expectedVersion }),
        change: changeOf(input.change, "write")
      })
    );
  }

  return {
    /**
     * The topic (redirects followed), its members and the stored overview, in one snapshot; null
     * when there is no active tree or the topic is not a live topic of it.
     */
    async readContext(topicId: string): Promise<TopicOverviewContext | null> {
      return snapshot(async (db) => {
        const topic = await resolveTopic(db, topicId);
        if (!topic) return null;
        const members = (
          await db.query<{ notes: number; items: number; fingerprint: string }>(
            topicOverviewSql.members,
            [topic.id, topic.treeId]
          )
        ).rows[0] ?? { notes: 0, items: 0, fingerprint: "" };
        const stored = storedOf(
          (
            await db.query<StoredRow>(topicOverviewSql.stored, [
              topic.id,
              topicOverviewReadDefaults.sourceTitleMax
            ])
          ).rows[0]
        );
        return {
          topic,
          members: {
            notes: Number(members.notes),
            items: Number(members.items),
            fingerprint: members.fingerprint
          },
          stored
        };
      });
    },

    /** The evidence candidates of a topic (see `topicOverviewSql.evidence`). */
    async readEvidence(
      topic: Pick<TopicOverviewTopic, "id" | "treeId">,
      limits: { perTopic: number; candidates: number }
    ): Promise<TopicOverviewEvidenceRow[]> {
      const rows = (
        await pool.query<TopicOverviewEvidenceRow>(topicOverviewSql.evidence, [
          topic.id,
          topic.treeId,
          limits.perTopic,
          limits.candidates,
          topicOverviewReadDefaults.sourceTitleMax
        ])
      ).rows;
      return rows.map((row) => ({
        ...row,
        round: Number(row.round),
        centrality: row.centrality === null ? null : Number(row.centrality)
      }));
    },

    /**
     * Stores an overview and its citations in one transaction, a version up. Replacing an earlier
     * one keeps it as a change-set (`topic_overview_versions`, undoable); a first write keeps
     * nothing. With `expectedVersion`, a text computed from another version than the stored one is
     * refused (`moved`) and nothing is written; a retired topic writes nothing (`retired`).
     */
    write,

    /**
     * `write` for the overview written on open: resolves to null when the topic was retired
     * meanwhile (nothing is stored).
     */
    async save(input: SaveTopicOverviewInput): Promise<{
      writtenAt: Date;
      writtenAtExact: string;
      version: number;
      changeSetId: string | null;
    } | null> {
      const result = await write(input);
      return result.kind === "written" ? result : null;
    },

    /**
     * Records a proposal (Suggest autonomy, F4 D12, D17) on the version stored now: nothing is
     * written to the overview until the owner applies it. A retired topic records nothing.
     */
    async propose(
      input: SaveTopicOverviewInput & { change?: TopicOverviewChange }
    ): Promise<TopicOverviewProposalResult> {
      const change = changeOf(input.change, "patch");
      const row = (
        await pool.query<{ id: string; baseVersion: number | string }>(topicOverviewSql.propose, [
          input.topicId,
          change.origin,
          change.titleKey,
          JSON.stringify(change.titleParams),
          change.risk,
          change.jobId,
          JSON.stringify(contentOf(input))
        ])
      ).rows[0];
      return row
        ? { kind: "proposed", id: row.id, baseVersion: Number(row.baseVersion) }
        : { kind: "retired" };
    },

    /**
     * The owner's verdict on a proposal (D29). `apply` writes its text only on the version it was
     * made on (else `moved`: it stays pending until it is proposed again); the proposal's row
     * becomes the applied change-set, keeping the replaced text.
     */
    async resolveProposal(
      id: string,
      verdict: "apply" | "dismiss"
    ): Promise<TopicOverviewReviewResult> {
      return withTransaction(pool, async (client): Promise<TopicOverviewReviewResult> => {
        const row = (await client.query<VersionRow>(topicOverviewSql.lockVersion, [id])).rows[0];
        if (!row) return { kind: "not_found" };
        if (row.status !== "pending_review" || row.proposed === null)
          return { kind: "not_pending", status: row.status };
        if (verdict === "dismiss") {
          await client.query(
            "update topic_overview_versions set status = 'dismissed' where id = $1::uuid",
            [id]
          );
          return { kind: "dismissed" };
        }
        const written = await writeIn(client, row.topicId, row.proposed, {
          expectedVersion: Number(row.baseVersion),
          change: changeOf(undefined, row.origin),
          proposalId: id
        });
        if (written.kind === "written")
          return {
            kind: "applied",
            version: written.version,
            writtenAtExact: written.writtenAtExact
          };
        return written;
      });
    },

    /**
     * Undoes an applied write exactly (F4 D10): the text, citations, support and Divergences it
     * replaced come back, a version up, recorded as an `undo` change-set; the write reads undone.
     * It is blocked once the overview was written again, for an undo, a first write (nothing to
     * restore), anything not applied, or a topic that is gone.
     */
    async undoVersion(id: string): Promise<TopicOverviewUndoResult> {
      return withTransaction(pool, async (client): Promise<TopicOverviewUndoResult> => {
        const row = (await client.query<VersionRow>(topicOverviewSql.lockVersion, [id])).rows[0];
        if (!row) return { kind: "not_found" };
        if (row.origin === "undo" || (row.status === "applied" && !row.hasPrevious))
          return { kind: "blocked", code: "not_undoable" };
        if (row.status !== "applied") return { kind: "blocked", code: "not_applied" };
        const previous = (
          await client.query<{ previous: OverviewSnapshot }>(
            "select previous from topic_overview_versions where id = $1::uuid",
            [id]
          )
        ).rows[0]?.previous;
        if (!previous) return { kind: "blocked", code: "not_undoable" };
        // The restored text keeps the time it was first written at.
        const restored = await writeIn(client, row.topicId, previous, {
          expectedVersion: Number(row.version),
          change: changeOf(undefined, "undo"),
          undoOf: id
        });
        if (restored.kind === "moved") return { kind: "blocked", code: "newer_version" };
        if (restored.kind === "retired" || restored.changeSetId === null)
          return { kind: "blocked", code: "item_deleted" };
        await client.query(
          `update topic_overview_versions set status = 'undone', undone_at = clock_timestamp()
            where id = $1::uuid`,
          [id]
        );
        return { kind: "undone", undoId: restored.changeSetId, version: restored.version };
      });
    },

    /**
     * Retention (F4 D10): deletes up to `limit` applied or undone writes made before `before`
     * (an undo with the write it undid, only once both are past the window; the undo first) and
     * answers how many went. Proposals, pending or decided, stay: the owner's verdicts are labels.
     */
    async pruneVersions(input: { before: Date; limit: number }): Promise<number> {
      return withTransaction(pool, async (client) => {
        const ids = (
          await client.query<{ id: string }>(topicOverviewSql.prunable, [
            input.before,
            Math.max(1, Math.trunc(input.limit))
          ])
        ).rows.map((row) => row.id);
        if (ids.length === 0) return 0;
        await client.query(
          "delete from topic_overview_versions where id = any($1::uuid[]) and undo_of is not null",
          [ids]
        );
        await client.query("delete from topic_overview_versions where id = any($1::uuid[])", [ids]);
        return ids.length;
      });
    },

    /**
     * Records the support check of one writing; false when the overview was rewritten (or the topic
     * removed) meanwhile, so a late check never lands on another text.
     */
    async saveSupport(input: {
      topicId: string;
      writtenAtExact: string;
      support: Record<string, unknown>;
    }): Promise<boolean> {
      const result = await pool.query(topicOverviewSql.saveSupport, [
        input.topicId,
        input.writtenAtExact,
        JSON.stringify(input.support)
      ]);
      return (result.rowCount ?? 0) > 0;
    },

    statements: topicOverviewSql
  };
}

export type TopicOverviewRepository = ReturnType<typeof createTopicOverviewRepository>;
