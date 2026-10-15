import type { QueryResultRow } from "pg";

import {
  clipCharacters,
  knownModel,
  noteAuthorship,
  notePageLimits,
  objectLocatePathLimit,
  relationExplanation,
  type AtomicNoteStatus,
  type NotePageEvidence,
  type NotePageNote,
  type NotePageRelation,
  type NotePageRelations,
  type ObjectLocateResult
} from "@app/domain";

import type { PgPool } from "../client.js";
import { createObjectLocateRepository } from "./objectLocateRepository.js";
import { relationExplanationPlan } from "./relationExplanationRepository.js";
import { mapNullableTimestamp, mapTimestamp } from "./sql.js";

/**
 * Read model of a Note page (`notes.page`): the note, its evidence with exact anchors, its
 * placement and the first page of its relations, read in one consistent read-only snapshot. Every
 * statement looks rows up by primary key or by an existing index, so the cost does not grow with the
 * library; `npm run db:note-page:verify` checks the answers and `scripts/objects/note-page-benchmark.ts`
 * the latency on a real database. Nothing here writes, and no score leaves this module.
 */
export interface NotePageRows {
  note: NotePageNote;
  successors: Array<{ id: string; title: string }>;
  evidence: { items: NotePageEvidence[]; total: number };
  placement: ObjectLocateResult;
  relations: NotePageRelations;
}

interface NoteRow extends QueryResultRow {
  id: string;
  title: string;
  ideaStatement: string;
  bodyMarkdown: string;
  language: string | null;
  status: AtomicNoteStatus;
  superseded: boolean;
  ownership: string;
  humanProtected: boolean;
  evolution: boolean;
  generationModel: string;
  homeSourceId: string;
  createdAt: Date | string;
  updatedAt: Date | string;
  reviewedAt: Date | string | null;
  lastEditedAt: Date | string | null;
  successors: Array<{ id: string; title: string }>;
}

interface EvidenceRow extends QueryResultRow {
  total: number | string;
  items: NotePageEvidence[];
}

interface RelationItem {
  id: string;
  type: string;
  direction: NotePageRelation["direction"];
  semanticSourceId: string | null;
  matchingModel: string | null;
  decisionSource: string | null;
  explanation: string | null;
  /** An explanation written on demand, with the hash of the inputs it was written from. */
  written: { text: string; inputHash: string; model: string } | null;
  other: Omit<NotePageRelation["other"], "authorship"> & {
    edited: boolean;
    evolution: boolean;
    passageHash: string | null;
  };
}

/** The page's own note, as an explanation sees it. */
interface SelfFacts {
  id: string;
  title: string;
  ideaStatement: string;
  passageHash: string | null;
}

interface RelationsRow extends QueryResultRow {
  total: number | string;
  self: SelfFacts | null;
  items: RelationItem[];
}

/** $1 note ID, $2 successor limit. */
const noteSql = `
select n.id, n.title, n.idea_statement as "ideaStatement", n.body_markdown as "bodyMarkdown",
       nullif(n.language, 'und') as language, n.status, n.supersession_status <> 'current' as superseded,
       n.ownership, coalesce(n.metadata->>'humanProtected', '') = 'true' as "humanProtected",
       n.metadata ? 'evolutionRunId' as evolution,
       n.generation_model as "generationModel", n.created_from_source_item_id as "homeSourceId",
       n.created_at as "createdAt", n.updated_at as "updatedAt", n.reviewed_at as "reviewedAt",
       (select max(ev.created_at) from atomic_note_review_events ev
         where ev.atomic_note_id = n.id and ev.action = 'edit') as "lastEditedAt",
       coalesce((select jsonb_agg(jsonb_build_object('id', s.id, 'title', s.title) order by e.created_at, s.id)
                   from (select x.next_id, x.created_at from atomic_note_evolution x where x.previous_id = n.id
                          order by x.created_at, x.next_id limit $2::int) e
                   join atomic_notes s on s.id = e.next_id), '[]'::jsonb) as successors
  from atomic_notes n where n.id = $1::uuid`;

/**
 * $1 note ID, $2 passage limit, $3 path depth limit. The same union and currency rules as
 * `readNoteEvidence` (live chunks of the note's links and its primary chunk, unless a retained
 * snapshot replaces them), plus anchors and the title of the work each passage belongs to.
 */
const evidenceSql = `
with recursive primary_chunk as (
  select n.evidence_chunk_id as id from atomic_notes n where n.id = $1::uuid
),
live as (
  select c.id as chunk_id, c.source_item_id, c.document_id, c.source_span_id, s.title as source_title,
         c.chunk_index, sp.start_offset, sp.end_offset, sp.page, c.content as excerpt,
         nullif(c.language, 'und') as language,
         d.metadata->>'supersededByDocumentId' is null as current, true as source_available
    from chunks c
    join documents d on d.id = c.document_id
    join source_items s on s.id = c.source_item_id
    left join source_spans sp on sp.id = c.source_span_id
   where c.id in (select l.chunk_id from atomic_note_source_links l where l.atomic_note_id = $1::uuid
                  union select id from primary_chunk)
     and not exists (select 1 from atomic_note_evidence e where e.note_id = $1::uuid and e.chunk_id = c.id)
),
retained as (
  select e.chunk_id, e.source_id as source_item_id, (e.snapshot->>'documentId')::uuid as document_id,
         (e.snapshot->>'sourceSpanId')::uuid as source_span_id,
         coalesce(e.snapshot->>'sourceTitle', s.title, '') as source_title,
         c.chunk_index, sp.start_offset, sp.end_offset, sp.page, coalesce(e.snapshot->>'excerpt', '') as excerpt,
         nullif(c.language, 'und') as language,
         coalesce(c.source_item_id = e.source_id and c.content_hash = e.snapshot->>'contentHash'
                  and d.metadata->>'supersededByDocumentId' is null, false) as current,
         s.id is not null as source_available
    from atomic_note_evidence e
    left join chunks c on c.id = e.chunk_id
    left join documents d on d.id = c.document_id
    left join source_spans sp on sp.id = c.source_span_id
    left join source_items s on s.id = e.source_id
   where e.note_id = $1::uuid
),
items as (select * from live union all select * from retained),
walk as (
  select start.source_item_id as start_id, s.title, s.parent_source_item_id as parent_id, 0 as depth
    from (select distinct source_item_id from items) start
    join source_items s on s.id = start.source_item_id
  union all
  select walk.start_id, parent.title, parent.parent_source_item_id, walk.depth + 1
    from walk join source_items parent on parent.id = walk.parent_id
   where walk.depth < $3::int
),
works as (select distinct on (start_id) start_id, title from walk order by start_id, depth desc),
listed as (
  select items.*, case when works.title = items.source_title then null else works.title end as work_title,
         items.chunk_id = (select id from primary_chunk) as is_primary
    from items left join works on works.start_id = items.source_item_id
)
select (select count(*)::int from items) as total,
  coalesce((select jsonb_agg(jsonb_build_object(
      'chunkId', page.chunk_id, 'sourceItemId', page.source_item_id, 'documentId', page.document_id,
      'sourceSpanId', page.source_span_id, 'sourceTitle', page.source_title, 'workTitle', page.work_title,
      'chunkIndex', page.chunk_index,
      'range', case when page.start_offset is not null and page.end_offset > page.start_offset
                    then jsonb_build_object('start', page.start_offset, 'end', page.end_offset) end,
      'page', case when page.page > 0 then page.page end,
      'excerpt', left(page.excerpt, ${notePageLimits.evidenceExcerptCharacters}), 'language', page.language,
      'primary', page.is_primary,
      'current', page.current, 'sourceAvailable', page.source_available)
      order by page.is_primary desc, coalesce(page.work_title, page.source_title), page.source_title,
               page.chunk_index nulls last, page.chunk_id)
    from (select * from listed
           order by is_primary desc, coalesce(work_title, source_title), source_title,
                    chunk_index nulls last, chunk_id
           limit $2::int) page), '[]'::jsonb) as items`;

/**
 * $1 note ID, $2 limit, $3 offset, $4 excerpt characters. One row with the exact total and one page
 * of relations to notes that are neither discarded nor archived, ordered by the stored score (which
 * never leaves this statement's ordering). The direction comes from the decided metadata: the stored
 * endpoints are sorted by ID. Every counted relation is listed: a knowledge-owned note outlives its
 * home source (it has no foreign key to it), so that source is a left join. `left()` counts
 * characters (code points) and the contract bounds the excerpt in the same unit.
 */
const relationsSql = `
with rel as (
  select r.id, r.relation_type as type, r.final_score, r.explanation, r.matching_model,
         r.metadata->>'decisionSource' as decision_source,
         r.metadata->>'semanticSourceAtomicNoteId' as semantic_source_id,
         case r.metadata->>'semanticSourceAtomicNoteId'
              when $1::uuid::text then 'outgoing'
              when o.id::text then 'incoming'
              else 'unknown' end as direction,
         o.id as other_id, o.title as other_title
    from atomic_note_relations r
    -- One primary-key lookup per relation (the limit keeps it a lookup), even for a hub note.
    cross join lateral (
      select o.id, o.title, o.status from atomic_notes o
       where o.id = case when r.source_atomic_note_id = $1::uuid
                         then r.target_atomic_note_id else r.source_atomic_note_id end
       limit 1) o
   where (r.source_atomic_note_id = $1::uuid or r.target_atomic_note_id = $1::uuid)
     and r.status <> 'rejected' and o.status not in ('rejected', 'archived')
),
page as (
  select rel.*, row_number() over (order by rel.final_score desc, rel.other_title, rel.id) as ord
    from rel
   order by rel.final_score desc, rel.other_title, rel.id
   limit $2::int offset $3::int
)
select (select count(*)::int from rel) as total,
       (select jsonb_build_object('id', n.id, 'title', n.title, 'ideaStatement', n.idea_statement,
                                  'passageHash', c.content_hash)
          from atomic_notes n left join chunks c on c.id = n.evidence_chunk_id
         where n.id = $1::uuid) as self,
       coalesce((select jsonb_agg(item.value order by item.ord) from (
         select page.ord, jsonb_build_object(
                  'id', page.id, 'type', page.type, 'direction', page.direction,
                  'semanticSourceId', page.semantic_source_id,
                  'matchingModel', page.matching_model, 'decisionSource', page.decision_source,
                  'explanation', page.explanation,
                  'written', case when x.relation_id is null then null else jsonb_build_object(
                    'text', x.text, 'inputHash', x.input_hash, 'model', x.model) end,
                  'other', jsonb_build_object(
                    'id', o.id, 'title', o.title, 'ideaStatement', o.idea_statement,
                    'language', nullif(o.language, 'und'), 'status', o.status,
                    'superseded', o.supersession_status <> 'current',
                    'edited', exists (select 1 from atomic_note_review_events ev
                                       where ev.atomic_note_id = o.id and ev.action = 'edit'),
                    'evolution', o.metadata ? 'evolutionRunId',
                    'sourceItemId', os.id, 'sourceTitle', coalesce(os.title, ''), 'passageHash', oc.content_hash,
                    'passage', case when oc.id is null then null else jsonb_build_object(
                      'chunkId', oc.id, 'sourceSpanId', oc.source_span_id, 'chunkIndex', oc.chunk_index,
                      'excerpt', left(oc.content, $4::int), 'language', nullif(oc.language, 'und')) end)) as value
           from page
           join atomic_notes o on o.id = page.other_id
           left join source_items os on os.id = o.created_from_source_item_id
           left join chunks oc on oc.id = o.evidence_chunk_id
           left join atomic_note_relation_explanations x on x.relation_id = page.id) item), '[]'::jsonb) as items`;

const iso = (value: Date | string) => mapTimestamp(value).toISOString();
const isoOrNull = (value: Date | string | null) =>
  mapNullableTimestamp(value)?.toISOString() ?? null;

function mapNote(row: NoteRow): NotePageNote {
  const lastEditedAt = isoOrNull(row.lastEditedAt);
  return {
    id: row.id,
    title: row.title,
    ideaStatement: row.ideaStatement,
    bodyMarkdown: row.bodyMarkdown,
    language: row.language,
    status: row.status,
    superseded: row.superseded,
    ownership: row.ownership === "knowledge" ? "knowledge" : "source",
    humanProtected: row.humanProtected,
    authorship: noteAuthorship({ edited: lastEditedAt !== null, evolution: row.evolution }),
    generationModel: row.generationModel,
    homeSourceId: row.homeSourceId,
    createdAt: iso(row.createdAt),
    // The same string `reviewNote` compares: the page edits with it.
    updatedAt: iso(row.updatedAt),
    reviewedAt: isoOrNull(row.reviewedAt),
    lastEditedAt
  };
}

/**
 * An explanation written on demand counts only while its inputs are unchanged, the content language
 * it was written in included: a stale one reads as none, so it is written again when the relation is
 * opened. Without one, the explanation the decider stored (when it is real text) still counts.
 */
function explanationOf(
  item: RelationItem,
  self: SelfFacts | null,
  language: string
): NotePageRelation["explanation"] {
  if (item.written) {
    if (!self) return null;
    const fact = (
      note: { id: string; title: string; ideaStatement: string },
      hash: string | null
    ) => ({
      ...note,
      passage: hash === null ? null : { contentHash: hash }
    });
    const plan = relationExplanationPlan({
      type: item.type,
      semanticSourceId: item.semanticSourceId,
      language,
      a: fact(self, self.passageHash),
      b: fact(item.other, item.other.passageHash)
    });
    return plan.inputHash === item.written.inputHash
      ? {
          text: clipCharacters(item.written.text, notePageLimits.explanationCharacters),
          writtenBy: knownModel(item.written.model)
        }
      : null;
  }
  return relationExplanation({
    text: item.explanation,
    decisionSource: item.decisionSource,
    matchingModel: item.matchingModel
  });
}

function mapRelation(
  item: RelationItem,
  self: SelfFacts | null,
  language: string
): NotePageRelation {
  const { other } = item;
  return {
    id: item.id,
    type: item.type,
    direction: item.direction,
    decidedBy: knownModel(item.matchingModel),
    explanation: explanationOf(item, self, language),
    other: {
      id: other.id,
      title: other.title,
      ideaStatement: other.ideaStatement,
      language: other.language,
      status: other.status,
      superseded: other.superseded,
      authorship: noteAuthorship({ edited: other.edited, evolution: other.evolution }),
      sourceItemId: other.sourceItemId,
      sourceTitle: other.sourceTitle,
      passage: other.passage
    }
  };
}

function mapRelations(row: RelationsRow | undefined, language: string): NotePageRelations {
  const self = row?.self ?? null;
  return {
    total: Number(row?.total ?? 0),
    items: (row?.items ?? []).map((item) => mapRelation(item, self, language))
  };
}

export function createNotePageRepository(pool: PgPool) {
  return {
    /**
     * Null when the note does not exist. One consistent snapshot: repeatable read, read only. The
     * content language decides which written explanations are current.
     */
    async readPage(
      noteId: string,
      options: { relationLimit: number; contentLanguage: string }
    ): Promise<NotePageRows | null> {
      const client = await pool.connect();
      try {
        await client.query("begin transaction isolation level repeatable read, read only");
        const note = (await client.query<NoteRow>(noteSql, [noteId, notePageLimits.successors]))
          .rows[0];
        if (!note) {
          await client.query("commit");
          return null;
        }
        const evidence = (
          await client.query<EvidenceRow>(evidenceSql, [
            noteId,
            notePageLimits.evidence,
            objectLocatePathLimit - 1
          ])
        ).rows[0];
        const relations = (
          await client.query<RelationsRow>(relationsSql, [
            noteId,
            options.relationLimit,
            0,
            notePageLimits.excerptCharacters
          ])
        ).rows[0];
        const placement = await createObjectLocateRepository(client).locateNote(noteId);
        await client.query("commit");
        // The note exists in this snapshot, so it is always located; a null answer means it is gone.
        if (!placement) return null;
        return {
          note: mapNote(note),
          successors: note.successors,
          evidence: { total: Number(evidence?.total ?? 0), items: evidence?.items ?? [] },
          placement,
          relations: mapRelations(relations, options.contentLanguage)
        };
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    /** A further page of the note's relations; the total is exact on every page. */
    async listRelations(
      noteId: string,
      options: { offset: number; limit: number; contentLanguage: string }
    ): Promise<NotePageRelations> {
      const result = await pool.query<RelationsRow>(relationsSql, [
        noteId,
        options.limit,
        options.offset,
        notePageLimits.excerptCharacters
      ]);
      return mapRelations(result.rows[0], options.contentLanguage);
    },

    /** The statements behind `readPage`, for EXPLAIN in verification and the benchmark. */
    statements: { note: noteSql, evidence: evidenceSql, relations: relationsSql }
  };
}
