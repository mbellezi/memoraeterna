// Reads one measurement profile for the owner blind rating (E4, F2 T30). Every statement is a
// plain SELECT, so the CLI runs it on a read-only session; nothing here can write, and the topic
// tables keep their single writer.
import { z } from "zod";

import type { NoteDetail, RatingProfile, RatingSnapshot, RatingTopicRow } from "./rating-core.js";

/** The part of a driver this needs; a `pg` client or pool satisfies it. */
export interface RatingDb {
  query<T = Record<string, unknown>>(
    text: string,
    values?: readonly unknown[]
  ): Promise<{ rows: T[] }>;
}

export class RatingReadError extends Error {
  override readonly name = "RatingReadError";
}

interface TreeRow {
  id: string;
  generation: string;
  config_hash: string;
}

interface TopicRow {
  id: string;
  parent_id: string | null;
  role: "root" | "topic";
  title: string | null;
  name_state: RatingTopicRow["nameState"];
  name_source: string | null;
  name_language: string | null;
  description: string | null;
  aliases: unknown;
  retired_at: Date | string | null;
}

const treeSql = `select id::text as id, generation::text as generation, config_hash
  from topic_trees where status = 'active'`;
const topicsSql = `select id::text as id, parent_id::text as parent_id, role, title, name_state,
    name_source, name_language, description, aliases, retired_at
  from topics where tree_id = $1::uuid`;
// One row per current note: the note's primary placement. Secondary placements ("also in") are
// not membership for this rating, and a note that is rejected, archived or superseded is not shown.
const placementsSql = `select p.topic_id::text as topic_id, p.note_id::text as note_id
  from topic_placements p
  join atomic_notes n on n.id = p.note_id
  where p.tree_id = $1::uuid and p.item_kind = 'note' and p.rank = 0
    and n.status::text not in ('rejected', 'archived') and n.supersession_status = 'current'`;
const areasSql = `select exists (select 1 from topic_change_sets
    where tree_id = $1::uuid and origin = 'areas' and status = 'applied') as applied`;
const detailsSql = `select n.id::text as id, n.title, n.idea_statement as idea,
    src.title as source_title
  from atomic_notes n
  left join source_items src on src.id = n.created_from_source_item_id
  where n.id = any($1::uuid[])
    and n.status::text not in ('rejected', 'archived') and n.supersession_status = 'current'`;

const AliasesSchema = z.array(z.string());

/** Reads the active tree of a profile: its live and retired topics and the notes' primary placements. */
export async function readRatingSnapshot(
  db: RatingDb,
  profile: RatingProfile
): Promise<RatingSnapshot> {
  const trees = (await db.query<TreeRow>(treeSql)).rows;
  if (trees.length !== 1) {
    throw new RatingReadError(
      trees.length === 0
        ? "The database has no active topic tree."
        : "The database has more than one active topic tree."
    );
  }
  const tree = trees[0] as TreeRow;
  const topics = (await db.query<TopicRow>(topicsSql, [tree.id])).rows.map(
    (row): RatingTopicRow => ({
      id: row.id,
      parentId: row.parent_id,
      role: row.role,
      title: row.title,
      nameState: row.name_state,
      nameSource: row.name_source,
      nameLanguage: row.name_language,
      description: row.description,
      aliases: AliasesSchema.catch([]).parse(row.aliases),
      retiredAt: row.retired_at === null ? null : new Date(row.retired_at).toISOString()
    })
  );
  const placements = (
    await db.query<{ topic_id: string; note_id: string }>(placementsSql, [tree.id])
  ).rows.map((row) => ({ topicId: row.topic_id, noteId: row.note_id }));
  const areas = (await db.query<{ applied: boolean }>(areasSql, [tree.id])).rows[0];
  return {
    profile,
    tree: {
      id: tree.id,
      configHash: tree.config_hash,
      generation: Number(tree.generation),
      areasApplied: areas?.applied === true
    },
    topics,
    placements
  };
}

/** The title, idea statement and source title of the notes that will show on the page. */
export async function readNoteDetails(
  db: RatingDb,
  noteIds: readonly string[]
): Promise<Map<string, NoteDetail>> {
  const details = new Map<string, NoteDetail>();
  if (noteIds.length === 0) return details;
  const rows = (
    await db.query<{
      id: string;
      title: string | null;
      idea: string | null;
      source_title: string | null;
    }>(detailsSql, [[...noteIds]])
  ).rows;
  for (const row of rows) {
    details.set(row.id, {
      title: row.title ?? "",
      idea: row.idea ?? "",
      sourceTitle: row.source_title ?? ""
    });
  }
  return details;
}
