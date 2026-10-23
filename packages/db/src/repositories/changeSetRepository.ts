import type { QueryResultRow } from "pg";

import {
  changeSetReadLimits,
  type ChangeSetKind,
  type ChangeSetRisk,
  type ChangeSetStatus,
  type ChangeSetSummary,
  type ChangesPendingCounts,
  type OverviewDiffSide,
  type OverviewDivergence,
  type RelationDiffItem,
  type TopicDiffChange,
  type TopicDiffNode,
  type TopicMessageParams,
  type TopicUndoAvailability
} from "@app/domain";

import type { PgPool } from "../client.js";
import { topicReadSql } from "./topicReadRepository.js";
import type { Queryable } from "./types.js";

// The change-set read model (F4 D10, spec 3.4): reads of the `change_sets` view over the topic
// engine's change-sets, the relation passes and the overview writes, and a bounded diff of one
// change-set for the icicle and its table alternative. Read only: every store keeps its own writer
// and its own undo (`topicTreeRepository`, `relationEventRepository`, `topicOverviewRepository`).

/** Bounds of the repository's own reads. */
export const changeSetRepositoryLimits = {
  /** Structure events a topic diff reads of one change-set (topic events; items are counted). */
  topicEvents: 2_000,
  /** Relation events a pass diff reads (its relations are grouped from them). */
  relationEvents: 2_000,
  /** Ancestors walked above a touched topic (the depth cap of the tree, with the root). */
  ancestorDepth: 8
} as const;

export interface ChangeSetListInput {
  kind?: ChangeSetKind;
  status?: ChangeSetStatus;
  risk?: ChangeSetRisk;
  cursor?: string | null;
  limit: number;
}

export interface ChangeSetPage {
  items: ChangeSetSummary[];
  nextCursor: string | null;
}

export type ChangeSetDiff =
  | { kind: "topic"; summary: ChangeSetSummary; nodes: TopicDiffNode[]; hidden: number }
  | { kind: "relation"; summary: ChangeSetSummary; relations: RelationDiffItem[]; hidden: number }
  | {
      kind: "overview";
      summary: ChangeSetSummary;
      topic: { id: string; title: string | null };
      before: OverviewDiffSide | null;
      after: OverviewDiffSide | null;
    };

/** A cursor that does not decode is refused, never read as the first page. */
export class ChangeSetCursorError extends Error {
  override readonly name = "ChangeSetCursorError";
}

interface ViewRow extends QueryResultRow {
  kind: ChangeSetKind;
  id: string;
  titleKey: string;
  titleParams: unknown;
  risk: ChangeSetRisk;
  status: ChangeSetStatus;
  origin: string;
  subjectId: string | null;
  jobId: string | null;
  at: string;
  undoneAt: string | null;
  undo: TopicUndoAvailability;
}

const utc = (column: string) =>
  `to_char(${column} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

const viewColumns = `kind, id, title_key as "titleKey", title_params as "titleParams", risk, status,
  origin, subject_id as "subjectId", job_id as "jobId", ${utc("at")} as at,
  ${utc("undone_at")} as "undoneAt", undo`;

export const changeSetSql = {
  /**
   * $1 kind, $2 status, $3 risk (each null for any), $4 cursor time, $5 cursor kind, $6 cursor id
   * (null: the first page), $7 rows: newest first, then by kind and id.
   */
  list: `select ${viewColumns} from change_sets
     where ($1::text is null or kind = $1) and ($2::text is null or status = $2)
       and ($3::text is null or risk = $3)
       and ($4::timestamptz is null or at < $4::timestamptz
            or (at = $4::timestamptz and (kind > $5 or (kind = $5 and id > $6::uuid))))
     order by at desc, kind, id
     limit $7::int`,
  /** $1 kind, $2 id. */
  get: `select ${viewColumns} from change_sets where kind = $1 and id = $2::uuid`,
  /** Change-sets that wait for the owner, per kind and risk. */
  pending: `select kind, risk, count(*)::int as n from change_sets
     where status = 'pending_review' group by kind, risk`,
  /**
   * $1 run IDs: those a later run, not reverted, changed one of the relations of (by ID: the
   * revert's own check also follows a re-created pair; it names every blocker when it runs).
   */
  laterRuns: `select distinct m.run_id as id
      from relation_events m
      join relation_events e
        on e.relation_kind = m.relation_kind and e.relation_id = m.relation_id
       and e.seq > m.seq and e.run_id <> m.run_id
      join relation_match_runs lr on lr.id = e.run_id and lr.outcome is distinct from 'reverted'
     where m.run_id = any($1::uuid[]) and m.relation_id is not null`,
  /** $1 change-set, $2 rows: its topic events in order. */
  topicEvents: `select op, topic_id as "topicId", before, after from topic_structure_events
     where change_set_id = $1::uuid and item_id is null
     order by seq limit $2::int`,
  /** $1 change-set: primary placements moved into and out of each topic. */
  topicItems: `select t.topic_id as "topicId", sum(t.inn)::int as "in", sum(t.out)::int as "out"
      from (
        select (after ->> 'topicId')::uuid as topic_id, 1 as inn, 0 as out
          from topic_structure_events
         where change_set_id = $1::uuid and op in ('item.place', 'item.move')
           and (after ->> 'rank') = '0'
           and (op = 'item.place' or (before ->> 'topicId') is distinct from (after ->> 'topicId'))
        union all
        select (before ->> 'topicId')::uuid, 0, 1
          from topic_structure_events
         where change_set_id = $1::uuid and op in ('item.unplace', 'item.move')
           and (before ->> 'rank') = '0'
           and (op = 'item.unplace' or (before ->> 'topicId') is distinct from (after ->> 'topicId'))
      ) t
     group by t.topic_id`,
  /**
   * $1 topics, $2 depth: the topics with their current parent, title and depth below the root,
   * and their ancestors (`context`), walking up at most $2 steps.
   */
  topicContext: `with recursive up as (
      select t.id, t.parent_id, 0 as step, true as touched from topics t where t.id = any($1::uuid[])
      union
      select p.id, p.parent_id, up.step + 1, false from up
        join topics p on p.id = up.parent_id
       where up.step < $2::int
    ), nodes as (
      select id, bool_or(touched) as touched from up group by id
    ), chain as (
      select n.id as origin, t.parent_id as id, 0 as n
        from nodes n join topics t on t.id = n.id
      union all
      select c.origin, t.parent_id, c.n + 1 from chain c join topics t on t.id = c.id
       where c.n < 16
    )
    select t.id, t.parent_id as "parentId", t.title, t.retired_at is not null as retired,
           n.touched,
           (select count(*)::int from chain c where c.origin = n.id and c.id is not null) as depth
      from nodes n join topics t on t.id = n.id`,
  /** $1 run, $2 rows: its events in order, with the images' endpoints and visible fields. */
  relationEvents: `select relation_kind as "relationKind", relation_id as "relationId",
         pair_key as "pairKey", kind,
         case when before is null then null else jsonb_build_object(
           'from', coalesce(before ->> 'source_atomic_note_id', before ->> 'source_item_id'),
           'to', coalesce(before ->> 'target_atomic_note_id', before ->> 'target_source_item_id'),
           'status', before ->> 'status', 'band', before ->> 'band', 'type', before ->> 'relation_type')
         end as before,
         case when after is null then null else jsonb_build_object(
           'from', coalesce(after ->> 'source_atomic_note_id', after ->> 'source_item_id'),
           'to', coalesce(after ->> 'target_atomic_note_id', after ->> 'target_source_item_id'),
           'status', after ->> 'status', 'band', after ->> 'band', 'type', after ->> 'relation_type')
         end as after
      from relation_events where run_id = $1::uuid
     order by seq limit $2::int`,
  /** $1 note IDs, $2 source IDs, $3 title length: the titles relation ends show. */
  endTitles: `select 'note' as kind, n.id, left(n.title, $3::int) as title
      from atomic_notes n where n.id = any($1::uuid[])
    union all
    select 'source', s.id, left(s.title, $3::int) from source_items s where s.id = any($2::uuid[])`,
  /** $1 overview change-set: the write, its topic and the overview stored now. */
  overviewVersion: `select v.topic_id as "topicId", v.status, v.base_version as "baseVersion",
         v.version, v.previous, v.proposed, t.title, o.version as "currentVersion",
         case when o.topic_id is null then null else jsonb_build_object(
           'paragraphs', o.paragraphs, 'divergences', o.divergences, 'version', o.version) end as current
      from topic_overview_versions v
      join topics t on t.id = v.topic_id
      left join topic_overviews o on o.topic_id = v.topic_id
     where v.id = $1::uuid`,
  /** $1 topic, $2 version: the text of that version, kept by the write that replaced it. */
  overviewReplaced: `select previous from topic_overview_versions
     where topic_id = $1::uuid and base_version = $2::int and previous is not null
       and status in ('applied', 'undone')
     order by created_at limit 1`
} as const;

/**
 * A string clipped to `max` UTF-16 units, the unit the contract's `max` counts, without splitting a
 * character: a title parameter of emoji never makes a whole `changes.list` page fail its schema.
 */
function clipUnits(text: string, max: number): string {
  if (text.length <= max) return text;
  let clipped = "";
  for (const character of text) {
    if (clipped.length + character.length > max) break;
    clipped += character;
  }
  return clipped;
}

/** Message parameters: scalars only, bounded (the stores may keep more in their params). */
export function changeSetMessageParams(value: unknown): TopicMessageParams {
  const output: TopicMessageParams = {};
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (key.length === 0 || key.length > 60) continue;
      if (entry === null || typeof entry === "boolean") output[key] = entry;
      else if (typeof entry === "number" && Number.isFinite(entry)) output[key] = entry;
      else if (typeof entry === "string") output[key] = clipUnits(entry, 300);
    }
  }
  return output;
}

function summaryOf(row: ViewRow, undo: TopicUndoAvailability = row.undo): ChangeSetSummary {
  return {
    kind: row.kind,
    id: row.id,
    titleKey: row.titleKey,
    titleParams: changeSetMessageParams(row.titleParams),
    risk: row.risk,
    status: row.status,
    origin: row.origin.slice(0, changeSetReadLimits.originMax),
    subjectId: row.subjectId,
    jobId: row.jobId,
    at: row.at,
    undoneAt: row.undoneAt,
    undo
  };
}

/** An opaque keyset cursor: the last row's time, kind and id. */
export function encodeChangeSetCursor(row: Pick<ChangeSetSummary, "at" | "kind" | "id">): string {
  return Buffer.from(JSON.stringify([row.at, row.kind, row.id]), "utf8").toString("base64url");
}

export function decodeChangeSetCursor(cursor: string): { at: string; kind: string; id: string } {
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (
      Array.isArray(value) &&
      value.length === 3 &&
      value.every((part) => typeof part === "string") &&
      !Number.isNaN(Date.parse(value[0] as string)) &&
      /^[0-9a-f-]{36}$/iu.test(value[2] as string)
    )
      return { at: value[0] as string, kind: value[1] as string, id: value[2] as string };
  } catch {
    // Falls through to the refusal.
  }
  throw new ChangeSetCursorError("Invalid change-set cursor");
}

/**
 * Refines the view's `available` to `blocked` where a later change-set touched the same objects:
 * the topic engine's dependency rule (per tree) and, for relation passes, a later run on one of
 * their relations. The undo itself checks again and names every blocker.
 */
async function refineUndo(
  db: Queryable,
  rows: readonly ViewRow[]
): Promise<Map<string, TopicUndoAvailability>> {
  const output = new Map<string, TopicUndoAvailability>();
  const topicByTree = new Map<string, string[]>();
  const runs: string[] = [];
  for (const row of rows) {
    if (row.undo !== "available") continue;
    if (row.kind === "topic" && row.subjectId) {
      const ids = topicByTree.get(row.subjectId) ?? [];
      ids.push(row.id);
      topicByTree.set(row.subjectId, ids);
    } else if (row.kind === "relation") runs.push(row.id);
  }
  for (const [treeId, ids] of topicByTree) {
    const blocked = await db.query<{ id: string }>(topicReadSql.blocked, [treeId, ids]);
    for (const { id } of blocked.rows) output.set(`topic:${id}`, "blocked");
  }
  if (runs.length > 0) {
    const blocked = await db.query<{ id: string }>(changeSetSql.laterRuns, [runs]);
    for (const { id } of blocked.rows) output.set(`relation:${id}`, "blocked");
  }
  return output;
}

// ---------------------------------------------------------------------------
// Topic diff (pure: the events and the current rows in, the bounded node list out)

/** A topic event of a change-set, as the diff reads it. */
export interface TopicDiffEvent {
  op: string;
  topicId: string | null;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
}

/** A topic as it stands now, with its depth below the root. */
export interface TopicDiffCurrent {
  id: string;
  parentId: string | null;
  title: string | null;
  retired: boolean;
  touched: boolean;
  depth: number;
}

const changeRank: Record<TopicDiffChange, number> = {
  added: 0,
  removed: 1,
  moved: 2,
  renamed: 3,
  changed: 4,
  items: 5,
  context: 6
};

const stringOrNull = (value: unknown): string | null =>
  typeof value === "string" && value.length > 0 ? value : null;

/**
 * The nodes of a structural diff: each touched topic with its parent and title before and after
 * the change-set (from its events; the current row where it did not change them), the placements
 * it moved in and out, and the ancestors that hang it from the root. Bounded to `limit` nodes, the
 * shallowest first (ancestors precede their descendants); the rest is counted in `hidden`.
 */
export function topicDiffNodes(
  events: readonly TopicDiffEvent[],
  current: readonly TopicDiffCurrent[],
  items: ReadonlyMap<string, { in: number; out: number }>,
  limit: number = changeSetReadLimits.diffNodesMax
): { nodes: TopicDiffNode[]; hidden: number } {
  const now = new Map(current.map((row) => [row.id, row]));
  const nodes = new Map<string, TopicDiffNode>();
  const depthOf = (id: string): number => now.get(id)?.depth ?? 0;
  const node = (id: string): TopicDiffNode => {
    let entry = nodes.get(id);
    if (!entry) {
      const row = now.get(id);
      entry = {
        id,
        change: row?.touched === false ? "context" : "items",
        existedBefore: true,
        existsAfter: true,
        parentBefore: row?.parentId ?? null,
        parentAfter: row?.parentId ?? null,
        titleBefore: row?.title ?? null,
        titleAfter: row?.title ?? null,
        itemsIn: items.get(id)?.in ?? 0,
        itemsOut: items.get(id)?.out ?? 0
      };
      nodes.set(id, entry);
    }
    return entry;
  };
  const mark = (entry: TopicDiffNode, change: TopicDiffChange) => {
    if (changeRank[change] < changeRank[entry.change]) entry.change = change;
  };
  // Every touched or context topic, then each event in order: the first `before` and the last
  // `after` of a field are the two sides.
  for (const row of current) node(row.id);
  for (const topicId of items.keys()) node(topicId);
  const seenBefore = new Set<string>();
  for (const event of events) {
    if (!event.topicId) continue;
    const entry = node(event.topicId);
    const first = (field: string) => !seenBefore.has(`${event.topicId}:${field}`);
    const sawBefore = (field: string) => seenBefore.add(`${event.topicId}:${field}`);
    switch (event.op) {
      case "topic.create":
        if (event.before === null) {
          if (first("exists")) entry.existedBefore = false;
          entry.existsAfter = true;
          entry.parentAfter = stringOrNull(event.after?.parentId);
          entry.titleAfter = stringOrNull(event.after?.title);
          if (first("parent")) entry.parentBefore = null;
          if (first("title")) entry.titleBefore = null;
          mark(entry, "added");
        } else {
          if (first("exists")) {
            entry.existedBefore = true;
            entry.parentBefore = stringOrNull(event.before.parentId);
            entry.titleBefore = stringOrNull(event.before.title);
          }
          entry.existsAfter = false;
          mark(entry, "removed");
        }
        sawBefore("exists");
        sawBefore("parent");
        sawBefore("title");
        break;
      case "topic.retire":
        if (first("exists")) entry.existedBefore = true;
        entry.existsAfter = false;
        sawBefore("exists");
        mark(entry, "removed");
        break;
      case "topic.restore":
        if (first("exists")) entry.existedBefore = false;
        entry.existsAfter = true;
        sawBefore("exists");
        mark(entry, "added");
        break;
      case "topic.move":
        if (first("parent")) entry.parentBefore = stringOrNull(event.before?.parentId);
        entry.parentAfter = stringOrNull(event.after?.parentId);
        sawBefore("parent");
        mark(entry, "moved");
        break;
      case "topic.rename":
        if (first("title")) entry.titleBefore = stringOrNull(event.before?.title);
        entry.titleAfter = stringOrNull(event.after?.title);
        sawBefore("title");
        mark(entry, "renamed");
        break;
      case "topic.describe":
      case "topic.manage":
        mark(entry, "changed");
        break;
      default:
        break;
    }
  }
  const ordered = [...nodes.values()].sort(
    (a, b) =>
      depthOf(a.id) - depthOf(b.id) ||
      changeRank[a.change] - changeRank[b.change] ||
      b.itemsIn + b.itemsOut - (a.itemsIn + a.itemsOut) ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  );
  const kept = ordered.slice(0, Math.max(0, limit));
  return {
    nodes: kept,
    hidden: ordered.length - kept.length
  };
}

// ---------------------------------------------------------------------------
// Relation diff (pure)

/** A relation event as the diff reads it: the visible fields of each image. */
export interface RelationDiffEvent {
  relationKind: "note" | "source";
  relationId: string | null;
  pairKey: string;
  kind: string;
  before: {
    from: string | null;
    to: string | null;
    status: string | null;
    band: string | null;
    type: string | null;
  } | null;
  after: {
    from: string | null;
    to: string | null;
    status: string | null;
    band: string | null;
    type: string | null;
  } | null;
}

/**
 * The relations a pass changed, grouped from its events in order: the first `before` and the last
 * `after` are the two sides. A relation the pass created and deleted again shows nothing and is
 * counted in `hidden`, as are relations past `limit`.
 */
export function relationDiffItems(
  events: readonly RelationDiffEvent[],
  titles: ReadonlyMap<string, string>,
  limit: number = changeSetReadLimits.diffRelationsMax
): { relations: RelationDiffItem[]; hidden: number } {
  const groups = new Map<
    string,
    { first: RelationDiffEvent; last: RelationDiffEvent; kinds: string[] }
  >();
  for (const event of events) {
    const key = `${event.relationKind}:${event.relationId ?? event.pairKey}`;
    const group = groups.get(key);
    if (group) {
      group.last = event;
      group.kinds.push(event.kind);
    } else groups.set(key, { first: event, last: event, kinds: [event.kind] });
  }
  const side = (image: RelationDiffEvent["before"]) =>
    image ? { status: image.status, band: image.band, type: image.type } : null;
  const end = (kind: "note" | "source", id: string | null) => ({
    id,
    title: id === null ? null : (titles.get(`${kind}:${id}`) ?? null)
  });
  const relations: RelationDiffItem[] = [];
  let hidden = 0;
  for (const { first, last, kinds } of groups.values()) {
    const before = first.before;
    const after = last.after;
    if (before === null && after === null) {
      hidden += 1;
      continue;
    }
    if (relations.length >= limit) {
      hidden += 1;
      continue;
    }
    const ends = after ?? before;
    relations.push({
      relationKind: first.relationKind,
      relationId: first.relationId,
      change: before === null ? "created" : after === null ? "removed" : "changed",
      events: kinds.slice(0, changeSetReadLimits.diffEventsPerRelationMax),
      from: end(first.relationKind, ends?.from ?? null),
      to: end(first.relationKind, ends?.to ?? null),
      before: side(before),
      after: side(after)
    });
  }
  return { relations, hidden };
}

// ---------------------------------------------------------------------------
// Overview diff (pure)

interface StoredOverviewSide {
  paragraphs?: unknown;
  divergences?: unknown;
  version?: unknown;
}

/** A stored overview text as a diff side (bounded); null when there is none. */
export function overviewDiffSide(
  value: StoredOverviewSide | null,
  version: number
): OverviewDiffSide | null {
  if (!value) return null;
  const paragraphs = Array.isArray(value.paragraphs)
    ? value.paragraphs
        .filter(
          (paragraph): paragraph is { text: string; citations: unknown } =>
            typeof paragraph === "object" &&
            paragraph !== null &&
            typeof (paragraph as { text?: unknown }).text === "string" &&
            (paragraph as { text: string }).text.length > 0
        )
        .slice(0, changeSetReadLimits.overviewParagraphsMax)
        .map((paragraph) => ({
          text: paragraph.text.slice(0, 4_000),
          citations: Array.isArray(paragraph.citations)
            ? paragraph.citations
                .filter((n): n is number => Number.isInteger(n) && (n as number) >= 1)
                .slice(0, 40)
            : []
        }))
    : [];
  const divergences = Array.isArray(value.divergences)
    ? (value.divergences as unknown[])
        .filter(
          (item): item is OverviewDivergence =>
            typeof item === "object" &&
            item !== null &&
            typeof (item as OverviewDivergence).existing === "string" &&
            typeof (item as OverviewDivergence).new === "string" &&
            typeof (item as OverviewDivergence).summary === "string" &&
            (item as OverviewDivergence).summary.length > 0
        )
        .slice(0, changeSetReadLimits.divergencesMax)
        .map((item) => ({
          existing: item.existing.slice(0, 8),
          new: item.new.slice(0, 8),
          summary: [...item.summary].slice(0, changeSetReadLimits.divergenceSummaryMax).join("")
        }))
    : [];
  return { version: Math.max(0, version), paragraphs, divergences };
}

// ---------------------------------------------------------------------------

export function createChangeSetRepository(pool: PgPool) {
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

  async function summaries(db: Queryable, rows: readonly ViewRow[]): Promise<ChangeSetSummary[]> {
    const refined = await refineUndo(db, rows);
    return rows.map((row) => summaryOf(row, refined.get(`${row.kind}:${row.id}`) ?? row.undo));
  }

  async function getRow(db: Queryable, kind: ChangeSetKind, id: string): Promise<ViewRow | null> {
    if (!/^[0-9a-f-]{36}$/iu.test(id)) return null;
    return (await db.query<ViewRow>(changeSetSql.get, [kind, id])).rows[0] ?? null;
  }

  return {
    /** A page of change-sets, newest first (`changes.list`). */
    async list(input: ChangeSetListInput): Promise<ChangeSetPage> {
      const cursor = input.cursor ? decodeChangeSetCursor(input.cursor) : null;
      const limit = Math.max(1, Math.min(input.limit, changeSetReadLimits.pageMax));
      return snapshot(async (db) => {
        const rows = (
          await db.query<ViewRow>(changeSetSql.list, [
            input.kind ?? null,
            input.status ?? null,
            input.risk ?? null,
            cursor?.at ?? null,
            cursor?.kind ?? null,
            cursor?.id ?? null,
            limit + 1
          ])
        ).rows;
        const page = rows.slice(0, limit);
        const items = await summaries(db, page);
        const last = items.at(-1);
        return {
          items,
          nextCursor: rows.length > limit && last ? encodeChangeSetCursor(last) : null
        };
      });
    },

    /** One change-set; null when it is not in the view (gone, open, empty or a human pass). */
    async get(kind: ChangeSetKind, id: string): Promise<ChangeSetSummary | null> {
      return snapshot(async (db) => {
        const row = await getRow(db, kind, id);
        return row ? ((await summaries(db, [row]))[0] ?? null) : null;
      });
    },

    /** Change-sets that wait for the owner, per store and risk (the Inbox badge). */
    async pendingCounts(): Promise<ChangesPendingCounts> {
      const counts: ChangesPendingCounts = {
        total: 0,
        byKind: { topic: 0, relation: 0, overview: 0 },
        byRisk: { low: 0, medium: 0, high: 0 }
      };
      const rows = await pool.query<{ kind: ChangeSetKind; risk: ChangeSetRisk; n: number }>(
        changeSetSql.pending
      );
      for (const row of rows.rows) {
        counts.total += row.n;
        counts.byKind[row.kind] += row.n;
        counts.byRisk[row.risk] += row.n;
      }
      return counts;
    },

    /** A bounded diff of one change-set (`changes.diff`); null when it is not in the view. */
    async diff(kind: ChangeSetKind, id: string): Promise<ChangeSetDiff | null> {
      return snapshot(async (db): Promise<ChangeSetDiff | null> => {
        const row = await getRow(db, kind, id);
        if (!row) return null;
        const summary = (await summaries(db, [row]))[0]!;
        if (row.kind === "topic") {
          const events = (
            await db.query<TopicDiffEvent>(changeSetSql.topicEvents, [
              id,
              changeSetRepositoryLimits.topicEvents
            ])
          ).rows;
          const items = new Map(
            (
              await db.query<{ topicId: string | null; in: number; out: number }>(
                changeSetSql.topicItems,
                [id]
              )
            ).rows
              .filter((entry): entry is { topicId: string; in: number; out: number } =>
                Boolean(entry.topicId)
              )
              .map((entry) => [entry.topicId, { in: entry.in, out: entry.out }])
          );
          const touched = [
            ...new Set([
              ...events.flatMap((event) => (event.topicId ? [event.topicId] : [])),
              ...items.keys()
            ])
          ];
          const current = touched.length
            ? (
                await db.query<TopicDiffCurrent>(changeSetSql.topicContext, [
                  touched,
                  changeSetRepositoryLimits.ancestorDepth
                ])
              ).rows
            : [];
          const { nodes, hidden } = topicDiffNodes(events, current, items);
          return { kind: "topic", summary, nodes, hidden };
        }
        if (row.kind === "relation") {
          const events = (
            await db.query<RelationDiffEvent>(changeSetSql.relationEvents, [
              id,
              changeSetRepositoryLimits.relationEvents
            ])
          ).rows;
          const ids = { note: new Set<string>(), source: new Set<string>() };
          for (const event of events)
            for (const image of [event.before, event.after])
              for (const end of [image?.from, image?.to]) if (end) ids[event.relationKind].add(end);
          const titles = new Map(
            (
              await db.query<{ kind: string; id: string; title: string | null }>(
                changeSetSql.endTitles,
                [[...ids.note], [...ids.source], 300]
              )
            ).rows.flatMap((entry) =>
              entry.title ? [[`${entry.kind}:${entry.id}`, entry.title] as const] : []
            )
          );
          const { relations, hidden } = relationDiffItems(events, titles);
          return { kind: "relation", summary, relations, hidden };
        }
        const version = (
          await db.query<{
            topicId: string;
            status: ChangeSetStatus;
            baseVersion: number;
            version: number | null;
            previous: StoredOverviewSide | null;
            proposed: StoredOverviewSide | null;
            title: string | null;
            currentVersion: number | null;
            current: StoredOverviewSide | null;
          }>(changeSetSql.overviewVersion, [id])
        ).rows[0];
        if (!version) return null;
        let before: OverviewDiffSide | null;
        let after: OverviewDiffSide | null;
        if (version.version === null) {
          // A proposal: the overview stored now against the proposed text.
          before = overviewDiffSide(version.current, version.currentVersion ?? 0);
          after = overviewDiffSide(version.proposed, version.baseVersion + 1);
        } else {
          before = overviewDiffSide(version.previous, version.baseVersion);
          const produced =
            version.currentVersion === version.version
              ? version.current
              : ((
                  await db.query<{ previous: StoredOverviewSide }>(changeSetSql.overviewReplaced, [
                    version.topicId,
                    version.version
                  ])
                ).rows[0]?.previous ?? null);
          after = overviewDiffSide(produced, version.version);
        }
        return {
          kind: "overview",
          summary,
          topic: { id: version.topicId, title: version.title },
          before,
          after
        };
      });
    },

    statements: changeSetSql
  };
}

export type ChangeSetRepository = ReturnType<typeof createChangeSetRepository>;
