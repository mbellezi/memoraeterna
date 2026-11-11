/**
 * What a stored Question citation says about notes, in one place (F5 D14, spec 3.3). An Ask cites
 * passages (`chunk`); a citation may also name a note directly. A citation reaches a note when it
 * names that note, or when it names a passage that is the note's primary evidence
 * (`atomic_notes.evidence_chunk_id`) or one it links to (`atomic_note_source_links.chunk_id`).
 *
 * `objects.locate` places a Question by the notes its newest answer rests on, and
 * `objects.backlinks` lists the Questions that cite a note: both read this fragment, so the two
 * reads never disagree about "a question cites a note". Currentness is the reader's to apply
 * (`currentNoteSql`), as the predicate modules require; nothing here repeats it.
 *
 * Columns: the citation (`answer_id`, `ordinal`, `target_kind`, `target_id`, `anchor`) and the
 * `note_id` it reaches. A citation that reaches several notes has a row for each, and one that
 * reaches the same note twice (evidence and link) has two rows of it.
 */
export const questionCitedNotesSql = `
select c.answer_id, c.ordinal, c.target_kind, c.target_id, c.anchor, c.target_id as note_id
  from question_citations c
 where c.target_kind = 'note'
union all
select c.answer_id, c.ordinal, c.target_kind, c.target_id, c.anchor, n.id as note_id
  from question_citations c
  join atomic_notes n on n.evidence_chunk_id = c.target_id
 where c.target_kind = 'chunk'
union all
select c.answer_id, c.ordinal, c.target_kind, c.target_id, c.anchor, l.atomic_note_id as note_id
  from question_citations c
  join chunks k on k.id = c.target_id
  join atomic_note_source_links l on l.source_item_id = k.source_item_id and l.chunk_id = c.target_id
 where c.target_kind = 'chunk'`;
