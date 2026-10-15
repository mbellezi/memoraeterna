/**
 * Synthetic libraries at scale for the latency benchmarks of the objects layer
 * (`locate-benchmark.ts`, `note-page-benchmark.ts`). Each step is one SQL statement for a single
 * session on a throwaway database migrated from scratch; temporary tables carry IDs between steps.
 */

/**
 * Books > chapters > sections with eight chunks each, notes (10% knowledge-owned and linked to a
 * second source) and legacy wiki pages with memberships, dependencies and evidence.
 */
export const librarySeedSteps = (
  booksCount: number,
  notesCount: number,
  pagesCount: number
): string[] => [
  // Library: books > chapters > sections.
  `create temp table t_book as select i, gen_random_uuid() as id from generate_series(1, ${booksCount}) i`,
  `create temp table t_chapter as select b.i, c, gen_random_uuid() as id, b.id as parent from t_book b, generate_series(1, 3) c`,
  `create temp table t_section as select c.i, c.c, s, gen_random_uuid() as id, c.id as parent,
          row_number() over (order by c.i, c.c, s) as rn from t_chapter c, generate_series(1, 2) s`,
  `insert into source_items (id, type, title, parent_source_item_id)
   select id, 'Book'::source_item_type, 'Book ' || i, null::uuid from t_book
   union all select id, 'BookChapter', 'Book ' || i || ' chapter ' || c, parent from t_chapter
   union all select id, 'DocumentSection', 'Book ' || i || ' chapter ' || c || ' section ' || s, parent from t_section`,
  `insert into documents (id, source_item_id, title, canonical_markdown, content_hash)
   select gen_random_uuid(), id, 'Document', 'seed', md5(id::text) from t_section`,
  `insert into chunks (id, document_id, source_item_id, chunk_index, content, content_hash)
   select gen_random_uuid(), d.id, d.source_item_id, g, 'Passage ' || g, md5(d.id::text || g)
     from documents d, generate_series(0, 7) g`,
  `create temp table t_chunk as select row_number() over (order by source_item_id, chunk_index) as rn,
          id, source_item_id, chunk_index from chunks`,
  // Notes: 10% knowledge-owned and linked to a second source.
  `create temp table t_note as
     select gen_random_uuid() as id, g, s.id as source_id, k.id as chunk_id
       from generate_series(1, ${notesCount}) g
       join t_section s on s.rn = 1 + (g % (select count(*) from t_section))
       join t_chunk k on k.source_item_id = s.id and k.chunk_index = g % 8`,
  `insert into atomic_notes (id, title, body_markdown, idea_statement, status, supersession_status,
      ownership, created_from_source_item_id, evidence_chunk_id, generation_provider, generation_model,
      generation_runtime, generation_prompt_version, generation_key)
   select id, 'Note ' || g, 'Body ' || g, 'Idea ' || g, 'active', 'current',
          case when g % 10 = 0 then 'knowledge' else 'source' end,
          source_id, chunk_id, 'seed', 'seed', 'local', 'seed', id::text from t_note`,
  `insert into atomic_note_source_links (atomic_note_id, source_item_id, chunk_id)
   select id, source_id, chunk_id from t_note`,
  `insert into atomic_note_source_links (atomic_note_id, source_item_id, chunk_id)
   select n.id, k.source_item_id, k.id from t_note n
     join t_chunk k on k.rn = 1 + ((n.g * 31) % (select count(*) from t_chunk))
    where n.g % 10 = 0 on conflict do nothing`,
  `create temp table t_note_rank as select row_number() over (order by g) as rn, id from t_note`,
  `create temp table t_source_rank as
     select row_number() over (order by id) as rn, id from source_items`,
  // Legacy wiki: pages with a revision, a TOC group, memberships, dependencies and evidence.
  // Migration 0052 fences new legacy content (D40); this throwaway session seeds it on purpose.
  `set memora.legacy_fixture = 'on'`,
  `create temp table t_page as
     select g, gen_random_uuid() as id, gen_random_uuid() as revision, gen_random_uuid() as grp
       from generate_series(1, ${pagesCount}) g`,
  `insert into wiki_pages (id, title, kind, archived, current_revision_id)
   select id, 'Page ' || g, case when g % 10 = 1 then 'entity' when g % 10 = 2 then 'synthesis' else 'topic' end,
          g % 50 = 0, revision from t_page`,
  `insert into wiki_page_revisions (id, page_id, number, origin, content, content_hash)
   select revision, id, 1, 'seed', '{}'::jsonb, revision::text from t_page`,
  `insert into wiki_toc_groups (id, page_id, revision_id, snapshot)
   select grp, id, revision, '{}'::jsonb from t_page`,
  // Every third target is one of five hot sources, so some sources are heavily referenced.
  `create temp table t_target as
     select p.g, j, p.id as page, p.revision, p.grp,
            case when j % 2 = 0 then 'source' else 'atomic_note' end as kind,
            case when j % 2 = 0
              then (select id from t_source_rank where rn =
                      case when j % 3 = 0 then 1 + (p.g % 5)
                           else 1 + ((p.g * 131 + j * 7919) % (select count(*) from t_source_rank)) end)
              else (select id from t_note_rank where rn = 1 + ((p.g * 151 + j * 104729) % (select count(*) from t_note_rank)))
            end as target
       from t_page p, generate_series(1, 15) j`,
  `insert into wiki_memberships (id, page_id, group_id, target_kind, target_id, position, snapshot)
   select gen_random_uuid(), page, grp, kind, target, j, '{}'::jsonb from t_target`,
  `insert into wiki_dependencies (revision_id, section_id, kind, input_id, fingerprint, snapshot)
   select revision, gen_random_uuid(), kind, target, 'seed', '{}'::jsonb from t_target
    where (g + j) % 3 <> 0 on conflict do nothing`,
  `insert into wiki_evidence (page_id, source_item_id, document_id, chunk_id, snapshot)
   select p.id, k.source_item_id, d.id, k.id, '{}'::jsonb
     from t_page p cross join generate_series(1, 10) j
     join t_chunk k on k.rn = 1 + ((p.g * 977 + j * 13) % (select count(*) from t_chunk))
     join documents d on d.source_item_id = k.source_item_id
    on conflict do nothing`,
  `analyze`
];

export interface NoteRelationSeedOptions {
  /** Relations from every note to pseudo-random other notes. */
  relationsPerNote: number;
  /** Notes with many relations (the heaviest Note pages). */
  hubNotes: number;
  hubRelations: number;
}

/**
 * Note-page data on top of `librarySeedSteps` (same session): one SourceSpan per chunk (every
 * fourth with a page), relations with mixed types, scores and explanations (half are message keys,
 * half text with a note reference; a quarter lack decision metadata; a third have an explanation
 * written on open), hub notes, human edits on 5% of the notes and retained evidence snapshots on 1%.
 */
export const noteRelationSeedSteps = (options: NoteRelationSeedOptions): string[] => {
  const types = "array['supports','contrasts','extends','similar_to','depends_on','clarifies']";
  const relation = (from: string, to: string, salt: string) => `
     select least(${from}.id, ${to}.id), greatest(${from}.id, ${to}.id),
            (${types})[1 + ((${from}.rn + ${salt}) % 6)::int],
            ((${from}.rn * 7 + ${salt} * 13) % 100) / 100.0,
            case when (${from}.rn + ${salt}) % 2 = 0 then 'knowledge.relations.explanations.reranked'
                 else 'Both describe it in <note-ref id="' || ${from}.id || '" />.' end,
            'seed-decider',
            case when (${from}.rn + ${salt}) % 4 = 0 then '{}'::jsonb
                 else jsonb_build_object('decisionSource', 'model', 'semanticSourceAtomicNoteId', ${from}.id,
                                         'semanticTargetAtomicNoteId', ${to}.id) end`;
  return [
    // Write triggers (the projection clock) are irrelevant to a throwaway benchmark.
    `alter table chunks disable trigger user`,
    `alter table atomic_note_relations disable trigger user`,
    `create temp table t_span as
       select c.id as chunk_id, gen_random_uuid() as id, c.document_id, c.source_item_id, c.chunk_index
         from chunks c`,
    `insert into source_spans (id, document_id, source_item_id, start_offset, end_offset, page)
     select id, document_id, source_item_id, chunk_index * 100, chunk_index * 100 + 90,
            case when chunk_index % 4 = 0 then 1 + chunk_index / 4 end from t_span`,
    `update chunks c set source_span_id = s.id from t_span s where s.chunk_id = c.id`,
    `insert into atomic_note_relations (source_atomic_note_id, target_atomic_note_id, relation_type,
        final_score, explanation, matching_model, metadata)
     ${relation("a", "b", "j")}
       from t_note_rank a cross join generate_series(1, ${options.relationsPerNote}) j
       join t_note_rank b on b.rn = 1 + ((a.rn * 7919 + j * 104729) % (select count(*) from t_note_rank))
      where a.id <> b.id
     on conflict do nothing`,
    `insert into atomic_note_relations (source_atomic_note_id, target_atomic_note_id, relation_type,
        final_score, explanation, matching_model, metadata)
     ${relation("a", "b", "j")}
       from t_note_rank a cross join generate_series(1, ${options.hubRelations}) j
       join t_note_rank b on b.rn = 1 + ((a.rn * 31 + j * 997) % (select count(*) from t_note_rank))
      where a.rn <= ${options.hubNotes} and a.id <> b.id
     on conflict do nothing`,
    `alter table chunks enable trigger user`,
    `alter table atomic_note_relations enable trigger user`,
    // A third of the relations were opened and explained (stale or current, it is the same read).
    `insert into atomic_note_relation_explanations
       (relation_id, text, input_hash, prompt_version, provider, model, runtime, language)
     select id, 'An explanation written on open.', md5(id::text), 'seed', 'seed', 'seed-writer',
            'remote', 'en'
       from atomic_note_relations where abs(hashtext(id::text)) % 3 = 0`,
    `insert into atomic_note_review_events (atomic_note_id, action, previous_status, next_status)
     select id, 'edit', 'active', 'active' from t_note_rank where rn % 20 = 0`,
    `insert into atomic_note_evidence (note_id, chunk_id, source_id, snapshot)
     select n.id, n.chunk_id, n.source_id,
            jsonb_build_object('excerpt', 'Retained passage ' || n.g, 'sourceTitle', 'Seed source',
                               'contentHash', 'retained-' || n.g)
       from t_note n where n.g % 100 = 0`,
    `analyze`
  ];
};
