import type { QueryResultRow } from "pg";

import {
  clipCharacters,
  knownModel,
  noteAuthorship,
  noteRelationCalibration,
  noteRelationGroups,
  notePageLimits,
  objectLocatePathLimit,
  relationExplanation,
  relationExplanationSentinel,
  type AtomicNoteStatus,
  type NotePageActor,
  type NotePageEvidence,
  type NotePageNote,
  type NotePageRelation,
  type NotePageRelations,
  type NoteRelationBand,
  type NoteRelationGroup,
  type NoteRelationVetoSource,
  type ObjectLocateResult
} from "@app/domain";

import type { PgPool } from "../client.js";
import {
  currentNoteSql,
  earlierVersionNoteRelationSql,
  noteRelationDirectionSourceSql,
  noteRelationStateLabelSql,
  noteRelationSubjectSql,
  shownNoteRelationSql,
  withdrawnNoteRelationSql
} from "./note-relation-sql.js";
import { createObjectLocateRepository } from "./objectLocateRepository.js";
import {
  relationExplanationIsCurrent,
  relationExplanationPlan,
  type RelationExplanationWriter
} from "./relationExplanationRepository.js";
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
  /** The shown relations (D9). */
  relations: NotePageRelations;
  /** The relations an automatic veto withdrew, not yet reviewed. */
  withdrawn: NotePageRelations;
  /** Applied relations to an earlier version of a note (R29). */
  earlierVersions: NotePageRelations;
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
  group: NoteRelationGroup;
  type: string;
  direction: NotePageRelation["direction"];
  directionSource: NotePageRelation["directionSource"];
  state: NotePageRelation["state"];
  band: NoteRelationBand | null;
  calibration: string | null;
  probability: number | null;
  vetoSource: NoteRelationVetoSource | null;
  semanticSourceId: string | null;
  matchingModel: string | null;
  /** The AI run behind the decider's verdict and the typer's, when they are still known. */
  deciderRun: { model: string; runtime: string } | null;
  typerRun: { model: string; runtime: string } | null;
  decisionSource: string | null;
  explanation: string | null;
  /** An explanation written on demand, with the hash of the inputs it was written from. */
  written: { text: string; inputHash: string; model: string; runtime: string } | null;
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
  totals: Record<NoteRelationGroup, number | string>;
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
 * $1 note ID, $2 limit of the shown group, $3 offset, $4 excerpt characters, $5 the groups to list
 * (`shown`, `withdrawn`, `earlier`), $6 limit of the other groups. One row with the exact total of
 * each group and a page of each group listed (F3 D9, D15, R29):
 *
 *   shown       applied, suggested or kept relations between current notes
 *   withdrawn   relations an automatic veto withdrew, the owner has not reviewed yet
 *   earlier     applied relations to an earlier (superseded) version of a note, as F1b listed
 *               them (the other note carries its `superseded` flag), never counted as shown
 *
 * The groups come from the predicates of `note-relation-sql.ts` alone. Each is ordered by the
 * calibrated probability (nulls last), then the stored legacy score, which never leaves this
 * statement, then the other note's title and the ID. The direction comes from the stored
 * `direction` (F3 D8) through the visibility module (decision 31b): the endpoint columns are the
 * canonical pair, sorted by ID, and a typer's guess reads as unknown. Every counted
 * relation is listed: a knowledge-owned note outlives its home source (it has no foreign key to
 * it), so that source is a left join. `left()` counts characters (code points) and the contract
 * bounds the excerpt in the same unit. The runs behind the decider's verdict and the typer's are
 * read by key for the listed rows only.
 */
const self = { alias: "s", current: "s.current" };
const other = { alias: "o", current: "o.current" };
const relationsSql = `
with self as materialized (
  select n.id, n.status, ${currentNoteSql("n")} as current from atomic_notes n where n.id = $1::uuid
),
rel as (
  select r.id, coalesce(r.relation_type, 'related') as type, r.final_score, r.probability, r.band,
         r.metadata->>'calibration' as calibration, r.veto_source, r.explanation, r.matching_model,
         r.decider_key, r.typer_key,
         r.source_atomic_note_id::text || ':' || r.target_atomic_note_id::text as pair_key,
         r.metadata->>'decisionSource' as decision_source,
         ${noteRelationStateLabelSql("r")} as state,
         case when ${shownNoteRelationSql("r", [self, other])} then 'shown'
              when ${withdrawnNoteRelationSql("r", [self, other])} then 'withdrawn'
              else 'earlier' end as grp,
         ${noteRelationSubjectSql("r")}::text as semantic_source_id,
         ${noteRelationDirectionSourceSql("r")} as direction_source,
         case when ${noteRelationSubjectSql("r")} is null then 'unknown'
              when ${noteRelationSubjectSql("r")} = $1::uuid then 'outgoing'
              else 'incoming' end as direction,
         o.id as other_id, o.title as other_title
    from atomic_note_relations r
    cross join self s
    -- Primary-key lookups per relation (the limit keeps them lookups), even for a hub note; each
    -- endpoint's currency is read once.
    cross join lateral (
      select o.id, o.title, o.status, ${currentNoteSql("o")} as current from atomic_notes o
       where o.id = case when r.source_atomic_note_id = $1::uuid
                         then r.target_atomic_note_id else r.source_atomic_note_id end
       limit 1) o
   where (r.source_atomic_note_id = $1::uuid or r.target_atomic_note_id = $1::uuid)
     and (${shownNoteRelationSql("r", [self, other])}
          or ${withdrawnNoteRelationSql("r", [self, other])}
          or ${earlierVersionNoteRelationSql("r", self, other)})
),
ranked as (
  select rel.*, row_number() over (
           partition by rel.grp
           order by rel.probability desc nulls last, rel.final_score desc, rel.other_title, rel.id) as ord
    from rel
   where rel.grp = any($5::text[])
),
page as (
  select ranked.* from ranked
   where ranked.ord > $3::int
     and ranked.ord <= $3::int + case when ranked.grp = 'shown' then $2::int else $6::int end
)
select (select jsonb_build_object('shown', count(*) filter (where rel.grp = 'shown'),
                                  'withdrawn', count(*) filter (where rel.grp = 'withdrawn'),
                                  'earlier', count(*) filter (where rel.grp = 'earlier'))
          from rel) as totals,
       (select jsonb_build_object('id', n.id, 'title', n.title, 'ideaStatement', n.idea_statement,
                                  'passageHash', c.content_hash)
          from atomic_notes n left join chunks c on c.id = n.evidence_chunk_id
         where n.id = $1::uuid) as self,
       coalesce((select jsonb_agg(item.value order by item.grp, item.ord) from (
         select page.grp, page.ord, jsonb_build_object(
                  'id', page.id, 'group', page.grp, 'type', page.type, 'direction', page.direction,
                  'directionSource', page.direction_source,
                  'state', page.state, 'band', page.band, 'calibration', page.calibration,
                  'probability', page.probability, 'vetoSource', page.veto_source,
                  'semanticSourceId', page.semantic_source_id,
                  'matchingModel', page.matching_model, 'decisionSource', page.decision_source,
                  'deciderRun', case when dr.id is null then null else jsonb_build_object(
                    'model', dr.model_id, 'runtime', dr.runtime) end,
                  'typerRun', case when tr.id is null then null else jsonb_build_object(
                    'model', tr.model_id, 'runtime', tr.runtime) end,
                  'explanation', page.explanation,
                  'written', case when x.relation_id is null then null else jsonb_build_object(
                    'text', x.text, 'inputHash', x.input_hash, 'model', x.model,
                    'runtime', x.runtime) end,
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
           left join atomic_note_relation_explanations x on x.relation_id = page.id
           left join relation_decisions d on d.pair_key = page.pair_key and d.decider_key = page.decider_key
           left join ai_task_runs dr on dr.id = coalesce(d.lo_to_hi_ai_task_run_id, d.hi_to_lo_ai_task_run_id)
           left join relation_typings t on t.pair_key = page.pair_key and t.typer_key = page.typer_key
           left join ai_task_runs tr on tr.id = t.ai_task_run_id) item), '[]'::jsonb) as items`;

/**
 * The statements of a page are fixed text over primary keys and indexes, and planning them costs
 * more than running them (about 3 ms of a 4 ms read on a library of 30,000 notes). A named
 * statement is planned once per connection, so the Note page's budget holds (F3 T60). The name
 * belongs to the text: one name, one statement.
 */
const preparedNames = {
  note: "note-page-note",
  evidence: "note-page-evidence",
  relations: "note-page-relations"
} as const;
function prepared(
  statement: keyof typeof preparedNames,
  text: string,
  values: unknown[]
): { name: string; text: string; values: unknown[] } {
  return { name: preparedNames[statement], text, values };
}

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
 * it was written in included, and, when the writer is known, while the same prompt and model would
 * write it (F3 D22): a stale one reads as none, so it is written again when the relation is opened.
 * The row that caches the writer's verdict that the notes are unrelated reads as none too, whatever
 * its key: it is never shown as text, and opening the relation answers it without a call. Without a
 * written row, the explanation the decider stored (when it is real text) still counts.
 */
function explanationOf(
  item: RelationItem,
  self: SelfFacts | null,
  language: string,
  writer: RelationExplanationWriter | null | undefined
): NotePageRelation["explanation"] {
  if (item.written) {
    // A row that caches the writer's verdict that the notes are unrelated is not an explanation.
    if (!self || item.written.text === relationExplanationSentinel) return null;
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
      writer,
      a: fact(self, self.passageHash),
      b: fact(item.other, item.other.passageHash)
    });
    return relationExplanationIsCurrent(item.written.inputHash, plan)
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

/** The model of one step and where it ran: `kind` is null when the run behind it is gone. */
function actor(model: string | null | undefined, runtime: string | null): NotePageActor | null {
  const known = knownModel(model);
  if (known === null) return null;
  return {
    model: known,
    kind: runtime === null ? null : runtime === "remote" ? "remote" : "local"
  };
}

function mapRelation(
  item: RelationItem,
  self: SelfFacts | null,
  language: string,
  writer: RelationExplanationWriter | null | undefined
): NotePageRelation {
  const { other } = item;
  const explanation = explanationOf(item, self, language, writer);
  return {
    id: item.id,
    type: item.type,
    direction: item.direction,
    directionSource: item.directionSource,
    state: item.state,
    band: item.band,
    calibration: noteRelationCalibration({ calibration: item.calibration }),
    probability: item.probability === null ? null : Number(item.probability),
    vetoSource: item.state === "withdrawn" ? item.vetoSource : null,
    decidedBy: actor(
      knownModel(item.matchingModel) ?? item.deciderRun?.model,
      item.deciderRun?.runtime ?? null
    ),
    typedBy: actor(item.typerRun?.model, item.typerRun?.runtime ?? null),
    // A written explanation names where it ran; one the decider stored does not.
    explainedBy: actor(explanation?.writtenBy, item.written?.runtime ?? null),
    explanation,
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

/** One group of the listed rows, in the order the statement ranked them, with its exact total. */
function mapGroup(
  row: RelationsRow | undefined,
  group: NoteRelationGroup,
  language: string,
  writer: RelationExplanationWriter | null | undefined
): NotePageRelations {
  const self = row?.self ?? null;
  return {
    total: Number(row?.totals?.[group] ?? 0),
    items: (row?.items ?? [])
      .filter((item) => item.group === group)
      .map((item) => mapRelation(item, self, language, writer))
  };
}

/**
 * How written explanations are judged current: the content language, and the writer when known (a
 * reader that does not know it accepts an explanation of the same facts from any writer).
 */
export interface NotePageExplanationOptions {
  contentLanguage: string;
  explanationWriter?: RelationExplanationWriter | null;
}

export function createNotePageRepository(pool: PgPool) {
  return {
    /**
     * Null when the note does not exist. One consistent snapshot: repeatable read, read only. The
     * content language and the writer decide which written explanations are current.
     */
    async readPage(
      noteId: string,
      options: { relationLimit: number } & NotePageExplanationOptions
    ): Promise<NotePageRows | null> {
      const client = await pool.connect();
      try {
        await client.query("begin transaction isolation level repeatable read, read only");
        const note = (
          await client.query<NoteRow>(
            prepared("note", noteSql, [noteId, notePageLimits.successors])
          )
        ).rows[0];
        if (!note) {
          await client.query("commit");
          return null;
        }
        const evidence = (
          await client.query<EvidenceRow>(
            prepared("evidence", evidenceSql, [
              noteId,
              notePageLimits.evidence,
              objectLocatePathLimit - 1
            ])
          )
        ).rows[0];
        const relations = (
          await client.query<RelationsRow>(
            prepared("relations", relationsSql, [
              noteId,
              options.relationLimit,
              0,
              notePageLimits.excerptCharacters,
              [...noteRelationGroups],
              notePageLimits.groupPage
            ])
          )
        ).rows[0];
        const placement = await createObjectLocateRepository(client).locateNote(noteId);
        await client.query("commit");
        // The note exists in this snapshot, so it is always located; a null answer means it is gone.
        if (!placement) return null;
        const group = (name: NoteRelationGroup) =>
          mapGroup(relations, name, options.contentLanguage, options.explanationWriter);
        return {
          note: mapNote(note),
          successors: note.successors,
          evidence: { total: Number(evidence?.total ?? 0), items: evidence?.items ?? [] },
          placement,
          relations: group("shown"),
          withdrawn: group("withdrawn"),
          earlierVersions: group("earlier")
        };
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    /** A further page of one group of the note's relations; the total is exact on every page. */
    async listRelations(
      noteId: string,
      options: {
        group: NoteRelationGroup;
        offset: number;
        limit: number;
      } & NotePageExplanationOptions
    ): Promise<NotePageRelations> {
      const result = await pool.query<RelationsRow>(
        prepared("relations", relationsSql, [
          noteId,
          options.limit,
          options.offset,
          notePageLimits.excerptCharacters,
          [options.group],
          options.limit
        ])
      );
      return mapGroup(
        result.rows[0],
        options.group,
        options.contentLanguage,
        options.explanationWriter
      );
    },

    /** The statements behind `readPage`, for EXPLAIN in verification and the benchmark. */
    statements: { note: noteSql, evidence: evidenceSql, relations: relationsSql }
  };
}
