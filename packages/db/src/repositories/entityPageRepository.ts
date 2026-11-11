import type { QueryResultRow } from "pg";

import type { ObjectRef, ObjectTopicRef } from "@app/domain";

import { currentNoteSql } from "./note-relation-sql.js";
import { createObjectLocateRepository } from "./objectLocateRepository.js";
import type { Queryable } from "./types.js";

/**
 * The page of an entity (`entities.page`, F5 T132): what the entity panel shows. Its names and
 * description, the current notes that mention it (paged), the entities that appear in the most of
 * the same notes, and the topics where its notes are placed, which come from `objects.locate` so
 * the ribbon and this page cannot disagree. Read-only; nothing here writes or calls AI.
 *
 * A mention is a current note (`currentNoteSql`: neither rejected nor archived, the current
 * version, evidence in a document that has not been superseded). Mentions come grouped by the
 * topic of the active tree where the note is primarily placed, the densest topic first, then the
 * notes that are not placed. Inside a group they run by title. The keyset cursor carries the
 * whole sort key, so a page boundary can fall inside a group.
 *
 * Every read is by the entity's index on `atomic_note_entity_links`, so the cost follows the
 * entity's own mentions, never the size of the library.
 */

/** Mentions one page holds. */
export const entityMentionsPageLimit = 50;
/** Co-mentioned entities returned. */
export const entityCoMentionLimit = 10;

export interface EntityHeader {
  id: string;
  /** The kind of entity as stored (person, organism, place…); free text, localized by the reader. */
  type: string;
  canonicalName: string;
  aliases: string[];
  description: string | null;
  language: string;
}

export interface EntityMention {
  noteId: string;
  title: string;
  /** The source that owns the note, when it still exists. */
  sourceId: string | null;
  sourceTitle: string | null;
  /** The live topic the note is primarily placed in; null when it is not placed. */
  topicId: string | null;
  /** Empty when the topic is not named yet or the note is not placed; clients localize it. */
  topicTitle: string;
  /** How many of this entity's current notes the same topic holds (0 when not placed). */
  topicNotes: number;
}

export interface CoMentionedEntity {
  id: string;
  type: string;
  canonicalName: string;
  /** Current notes that mention both entities. */
  sharedNotes: number;
}

export interface EntityTopics {
  /** The topics from the root down to the one holding most of its notes; empty when none is placed. */
  primary: ObjectRef[];
  /** The other places, most notes first (at most four). */
  alsoIn: ObjectTopicRef[];
  alsoInCount: number;
}

export interface EntityPage {
  entity: EntityHeader;
  /** Current notes that mention the entity, and the distinct sources that own them. */
  counts: { notes: number; sources: number };
  mentions: { items: EntityMention[]; next?: string };
  /** Only on the first page (no cursor): a later page carries mentions alone. */
  topics?: EntityTopics;
  coMentioned?: CoMentionedEntity[];
}

interface HeaderRow extends QueryResultRow {
  id: string;
  type: string;
  canonicalName: string;
  aliases: unknown;
  description: string | null;
  language: string;
}

interface CountsRow extends QueryResultRow {
  notes: number;
  sources: number;
}

interface MentionRow extends QueryResultRow {
  noteId: string;
  title: string;
  sourceId: string | null;
  sourceTitle: string | null;
  topicId: string | null;
  topicTitle: string;
  topicNotes: number;
}

interface CoMentionRow extends QueryResultRow {
  id: string;
  type: string;
  canonicalName: string;
  sharedNotes: number;
}

const nilUuid = "00000000-0000-0000-0000-000000000000";

/** The sort key of a mention, in the order mentions are listed. */
interface MentionKey {
  unplaced: boolean;
  /** Minus the topic's notes: the densest topic sorts first in an ascending key. */
  negativeTopicNotes: number;
  topicTitle: string;
  topicId: string;
  noteTitle: string;
  noteId: string;
}

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

export function encodeMentionCursor(key: MentionKey): string {
  return Buffer.from(
    JSON.stringify([
      key.unplaced,
      key.negativeTopicNotes,
      key.topicTitle,
      key.topicId,
      key.noteTitle,
      key.noteId
    ]),
    "utf8"
  ).toString("base64url");
}

/** The key a cursor carries; null for anything that is not a cursor this repository wrote. */
export function decodeMentionCursor(cursor: string): MentionKey | null {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (!Array.isArray(parsed) || parsed.length !== 6) return null;
    const [unplaced, negativeTopicNotes, topicTitle, topicId, noteTitle, noteId] = parsed as [
      unknown,
      unknown,
      unknown,
      unknown,
      unknown,
      unknown
    ];
    if (
      typeof unplaced !== "boolean" ||
      typeof negativeTopicNotes !== "number" ||
      !Number.isInteger(negativeTopicNotes) ||
      typeof topicTitle !== "string" ||
      typeof topicId !== "string" ||
      !uuidPattern.test(topicId) ||
      typeof noteTitle !== "string" ||
      typeof noteId !== "string" ||
      !uuidPattern.test(noteId)
    )
      return null;
    return { unplaced, negativeTopicNotes, topicTitle, topicId, noteTitle, noteId };
  } catch {
    return null;
  }
}

/** A cursor the repository did not write (or one cut short) is refused, not read from the start. */
export class InvalidEntityPageCursorError extends Error {
  constructor() {
    super("errors.common.validationFailed");
    this.name = "InvalidEntityPageCursorError";
  }
}

const headerSql = `
select e.id, e.type, e.canonical_name as "canonicalName", e.aliases, e.description, e.language
  from entities e where e.id = $1::uuid`;

/** The current notes that mention the entity, once; the counts and the page both read it. */
const mentionsCte = `
mentions as (
  select n.id as note_id, n.title as note_title,
         coalesce(n.owning_source_item_id, n.created_from_source_item_id) as source_id,
         t.id as topic_id, coalesce(t.title, '') as topic_title
    from atomic_note_entity_links l
    join atomic_notes n on n.id = l.atomic_note_id
    left join topic_placements p on p.note_id = n.id and p.rank = 0
     and p.tree_id = (select tree.id from topic_trees tree where tree.status = 'active')
    left join topics t on t.id = p.topic_id and t.retired_at is null
   where l.entity_id = $1::uuid and ${currentNoteSql("n")}
)`;

const countsSql = `
with ${mentionsCte}
select count(*)::int as notes, count(distinct source_id)::int as sources from mentions`;

/**
 * One page of mentions after the key `$2..$7` (all null for the first page). The row comparison
 * runs on the same sort key as the ORDER BY, so the page boundary is exact. $8 is the page size
 * plus one, which tells whether another page follows.
 */
const mentionsSql = `
with ${mentionsCte},
keyed as (
  select m.*, count(*) over (partition by m.topic_id)::int as topic_notes from mentions m
),
page as (
  select k.*, (k.topic_id is null) as unplaced, -(case when k.topic_id is null then 0 else k.topic_notes end) as negative_topic_notes
    from keyed k
)
select o.note_id as "noteId", o.note_title as title, o.source_id as "sourceId", s.title as "sourceTitle",
       o.topic_id as "topicId", o.topic_title as "topicTitle",
       case when o.topic_id is null then 0 else o.topic_notes end as "topicNotes"
  from (
    select page.* from page
     where $2::boolean is null
        or (page.unplaced, page.negative_topic_notes, page.topic_title, coalesce(page.topic_id, '${nilUuid}'::uuid),
            page.note_title, page.note_id)
           > ($2::boolean, $3::int, $4::text, $5::uuid, $6::text, $7::uuid)
     order by page.unplaced, page.negative_topic_notes, page.topic_title,
              coalesce(page.topic_id, '${nilUuid}'::uuid), page.note_title, page.note_id
     limit $8::int
  ) o
  left join source_items s on s.id = o.source_id
 order by o.unplaced, o.negative_topic_notes, o.topic_title,
          coalesce(o.topic_id, '${nilUuid}'::uuid), o.note_title, o.note_id`;

/** The entities that share the most current notes with this one. $2 is how many to return. */
const coMentionsSql = `
with ${mentionsCte}
select e.id, e.type, e.canonical_name as "canonicalName", count(*)::int as "sharedNotes"
  from mentions m
  join atomic_note_entity_links other on other.atomic_note_id = m.note_id and other.entity_id <> $1::uuid
  join entities e on e.id = other.entity_id
 group by e.id, e.type, e.canonical_name
 order by count(*) desc, e.canonical_name, e.id
 limit $2::int`;

function aliasList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  for (const alias of value) if (typeof alias === "string" && alias.trim()) seen.add(alias.trim());
  return [...seen];
}

export function createEntityPageRepository(db: Queryable) {
  const locate = createObjectLocateRepository(db);

  async function readTopics(id: string): Promise<EntityTopics> {
    const located = await locate.locateEntity(id);
    if (!located) return { primary: [], alsoIn: [], alsoInCount: 0 };
    // `locate` ends the entity's own path with the entity: the page lists only its places.
    return {
      primary: located.primaryPath.filter((step) => step.kind === "topic"),
      alsoIn: located.alsoIn,
      alsoInCount: located.counts.alsoIn ?? located.alsoIn.length
    };
  }

  return {
    /**
     * The page of an entity; null when no such entity exists. `cursor` is the `next` of the
     * previous page and asks for the following mentions only; without it the page also carries the
     * topics and the co-mentioned entities. A cursor the repository did not write throws
     * `InvalidEntityPageCursorError`.
     */
    async page(input: { id: string; cursor?: string | undefined }): Promise<EntityPage | null> {
      const key = input.cursor === undefined ? null : decodeMentionCursor(input.cursor);
      if (input.cursor !== undefined && !key) throw new InvalidEntityPageCursorError();

      const header = (await db.query<HeaderRow>(headerSql, [input.id])).rows[0];
      if (!header) return null;

      const mentionValues = [
        input.id,
        key?.unplaced ?? null,
        key?.negativeTopicNotes ?? null,
        key?.topicTitle ?? null,
        key?.topicId ?? null,
        key?.noteTitle ?? null,
        key?.noteId ?? null,
        entityMentionsPageLimit + 1
      ];
      const [counts, mentionRows, topics, coMentionRows] = await Promise.all([
        db.query<CountsRow>(countsSql, [input.id]),
        db.query<MentionRow>(mentionsSql, mentionValues),
        key ? Promise.resolve(undefined) : readTopics(input.id),
        key
          ? Promise.resolve(undefined)
          : db.query<CoMentionRow>(coMentionsSql, [input.id, entityCoMentionLimit])
      ]);

      const rows = mentionRows.rows;
      const shown = rows.slice(0, entityMentionsPageLimit);
      const items: EntityMention[] = shown.map((row) => ({
        noteId: row.noteId,
        title: row.title,
        sourceId: row.sourceId,
        sourceTitle: row.sourceTitle,
        topicId: row.topicId,
        topicTitle: row.topicTitle,
        topicNotes: Number(row.topicNotes)
      }));
      const last = shown.at(-1);
      const mentions: EntityPage["mentions"] = { items };
      if (rows.length > entityMentionsPageLimit && last)
        mentions.next = encodeMentionCursor({
          unplaced: last.topicId === null,
          negativeTopicNotes: last.topicId === null ? 0 : -Number(last.topicNotes),
          topicTitle: last.topicTitle,
          topicId: last.topicId ?? nilUuid,
          noteTitle: last.title,
          noteId: last.noteId
        });

      const page: EntityPage = {
        entity: {
          id: header.id,
          type: header.type,
          canonicalName: header.canonicalName,
          aliases: aliasList(header.aliases),
          description: header.description,
          language: header.language
        },
        counts: {
          notes: Number(counts.rows[0]?.notes ?? 0),
          sources: Number(counts.rows[0]?.sources ?? 0)
        },
        mentions
      };
      if (topics) page.topics = topics;
      if (coMentionRows)
        page.coMentioned = coMentionRows.rows.map((row) => ({
          id: row.id,
          type: row.type,
          canonicalName: row.canonicalName,
          sharedNotes: Number(row.sharedNotes)
        }));
      return page;
    },

    /** The statements behind the page, for EXPLAIN in verification. */
    statements: {
      header: headerSql,
      counts: countsSql,
      mentions: mentionsSql,
      coMentions: coMentionsSql
    }
  };
}

export type EntityPageRepository = ReturnType<typeof createEntityPageRepository>;
