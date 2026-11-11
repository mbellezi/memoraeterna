/**
 * The material of a topic, for Ask about a topic (F2 T28): read-only SQL fragments that resolve a
 * topic to the notes and original passages its subtree holds. They read the topic tree and never
 * write it (the engine is its only writer), and they read no wiki or organization table.
 *
 * Membership is the engine's: an item belongs to a topic when it has a placement there, primary
 * or secondary ("also in"), and the subtree is the topic and every live descendant. A retired
 * topic has no subtree.
 */

/**
 * `topic_sub`, alone: the topic and its live descendants, walked through the index on (tree,
 * parent). `topic` is the placeholder holding the topic ID (for example `$5`).
 */
export const topicSubtreeCte = (topic: string): string => `topic_sub as (
      select t.id, t.tree_id from topics t where t.id = ${topic}::uuid and t.retired_at is null
      union all
      select k.id, k.tree_id from topic_sub s
        join topics k on k.tree_id = s.tree_id and k.parent_id = s.id and k.retired_at is null
    )`;

/**
 * Common table expressions for a `with recursive` statement; `topic` is the placeholder holding
 * the topic ID (for example `$5`), and every expression is empty when it is null.
 *
 * - `topic_sub` (`topicSubtreeCte`): the topic and its live descendants.
 * - `topic_note_ids`: the current notes placed in the subtree, with their primary evidence chunk.
 * - `topic_chunks`: the original passages Ask may read for the topic: every chunk a placed note
 *   rests on (its evidence chunk, source links and retained evidence), and every chunk of a source
 *   placed in the subtree together with the sources below it. A chunk of the same source that no
 *   placed note rests on is not part of the topic.
 */
export const topicScopeCtes = (
  topic: string
): string => `${topicSubtreeCte(topic)}, topic_placed as (
      select p.item_kind, p.note_id, p.source_item_id from topic_placements p
       where p.topic_id in (select id from topic_sub)
    ), topic_note_ids as (
      select n.id as note_id, n.evidence_chunk_id as chunk_id from atomic_notes n
       where n.id in (select note_id from topic_placed where item_kind = 'note')
         and n.status not in ('rejected', 'archived') and n.supersession_status = 'current'
    ), topic_sources as (
      select s.id from source_items s
       where s.id in (select source_item_id from topic_placed where item_kind = 'source')
      union all
      select k.id from topic_sources t join source_items k on k.parent_source_item_id = t.id
    ), topic_chunks as (
      select chunk_id from topic_note_ids
      union select l.chunk_id from atomic_note_source_links l
             where l.atomic_note_id in (select note_id from topic_note_ids)
      union select e.chunk_id from atomic_note_evidence e
             where e.note_id in (select note_id from topic_note_ids)
      union select c.id from chunks c where c.source_item_id in (select id from topic_sources)
    )`;

/** True when the chunk belongs to the topic (or no topic is set); `chunk` is the chunk ID expression. */
export const inTopicChunks = (topic: string, chunk: string): string =>
  `(${topic}::uuid is null or ${chunk} in (select chunk_id from topic_chunks))`;

/** True when the note belongs to the topic (or no topic is set); `note` is the note ID expression. */
export const inTopicNotes = (topic: string, note: string): string =>
  `(${topic}::uuid is null or ${note} in (select note_id from topic_note_ids))`;

/**
 * The territory partition (the Library's topic filter and territory bar, F5 T131): the sources
 * whose primary place (rank 0) is in the subtree of the topic. A secondary ("also in") placement
 * and the parts of a placed book are left out on purpose: a source belongs to exactly one
 * territory, so the territory counts add up to the library's total and a territory's list is as long
 * as its count. It is one more expression for the same `with recursive` statement as
 * `topicScopeCtes` and reads its `topic_sub`, which a statement that needs no more than this takes
 * alone from `topicSubtreeCte`.
 */
export const topicPrimarySourcesCte = (): string => `topic_primary_sources as (
      select p.source_item_id as id from topic_placements p
       where p.item_kind = 'source' and p.rank = 0 and p.topic_id in (select id from topic_sub)
    )`;
