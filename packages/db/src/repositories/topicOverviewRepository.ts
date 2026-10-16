import type { QueryResultRow } from "pg";

import type { PgPool } from "../client.js";
import { mapTimestamp } from "./sql.js";
import type { Queryable } from "./types.js";

// The lazy overviews of topics (F2 T31, D16). This repository alone writes `topic_overviews` and
// `topic_overview_citations` (D9); the topic tables themselves are read only. An overview is cached
// for the members it was written from (the primary placements of the topic's subtree), and every
// citation points at an exact chunk and span. A citation whose passage was replaced or whose note
// was deleted keeps its excerpt and reads as unavailable; it never becomes current evidence again.

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
}

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
         o.written_at::text as "writtenAtExact",
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
  /** $1 topic and the overview's fields: written only while the topic is live. */
  save: `insert into topic_overviews
      (topic_id, paragraphs, evidence, member_fingerprint, member_count, input_hash,
       prompt_revision_id, provider, model, runtime, ai_task_run_id, language, support, written_at)
    select $1::uuid, $2::jsonb, $3::jsonb, $4, $5::int, $6, $7, $8, $9, $10, $11::uuid, $12,
           $13::jsonb, clock_timestamp()
     where exists (select 1 from topics t where t.id = $1::uuid and t.retired_at is null)
    on conflict (topic_id) do update set
      paragraphs = excluded.paragraphs, evidence = excluded.evidence,
      member_fingerprint = excluded.member_fingerprint, member_count = excluded.member_count,
      input_hash = excluded.input_hash, prompt_revision_id = excluded.prompt_revision_id,
      provider = excluded.provider, model = excluded.model, runtime = excluded.runtime,
      ai_task_run_id = excluded.ai_task_run_id, language = excluded.language,
      support = excluded.support, written_at = excluded.written_at
    returning written_at as "writtenAt", written_at::text as "writtenAtExact"`,
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
    }))
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
     * Stores an overview and its citations in one transaction, replacing an earlier one. Resolves
     * to null when the topic was retired meanwhile (nothing is stored).
     */
    async save(
      input: SaveTopicOverviewInput
    ): Promise<{ writtenAt: Date; writtenAtExact: string } | null> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        const row = (
          await client.query<{ writtenAt: Date | string; writtenAtExact: string }>(
            topicOverviewSql.save,
            [
              input.topicId,
              JSON.stringify(input.paragraphs),
              JSON.stringify(input.evidence),
              input.memberFingerprint,
              input.memberCount,
              input.inputHash,
              input.promptRevisionId,
              input.provider,
              input.model,
              input.runtime,
              input.aiTaskRunId,
              input.language,
              JSON.stringify(input.support)
            ]
          )
        ).rows[0];
        if (!row) {
          await client.query("rollback");
          return null;
        }
        await client.query(topicOverviewSql.clearCitations, [input.topicId]);
        if (input.citations.length > 0) {
          await client.query(topicOverviewSql.saveCitations, [
            input.topicId,
            input.citations.map((citation) => citation.n),
            input.citations.map((citation) => citation.chunkId),
            input.citations.map((citation) => citation.sourceSpanId),
            input.citations.map((citation) => citation.noteId),
            input.citations.map((citation) => citation.excerpt),
            input.citations.map((citation) => citation.excerptHash)
          ]);
        }
        await client.query("commit");
        return { writtenAt: mapTimestamp(row.writtenAt), writtenAtExact: row.writtenAtExact };
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
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
