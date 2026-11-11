import {
  AskScopeSchema,
  formatObjectAddress,
  type AskQuestionStatus,
  type AskScope,
  type ChangeSetRisk,
  type ChangeSetSummary,
  type InboxKind,
  type ObjectKind,
  type ObjectResolved
} from "@app/domain";
import type { QueryResultRow } from "pg";

import type { PgPool } from "../client.js";
import {
  changeSetViewColumns,
  summarizeChangeSetRows,
  type ChangeSetViewRow
} from "./changeSetRepository.js";
import { createInboxRepository } from "./inboxRepository.js";
import { currentNoteSql } from "./note-relation-sql.js";
import { createObjectReadRepository } from "./objectReadRepository.js";
import { questionListOrder } from "./questionRepository.js";
import { mapTimestamp } from "./sql.js";
import { topicReadDefaults, topicReadSql } from "./topicReadRepository.js";
import type { Queryable } from "./types.js";
import { createViewHistoryRepository } from "./viewHistoryRepository.js";

/**
 * The read model behind Home (F5 T130, D9; design record 7.1): one bounded digest of what arrived
 * since the owner last opened Home, what the Gardener did, what waits for them, the last
 * questions and the shape of the tree. It composes the readers that already own each predicate
 * (the view history, the objects layer, the Inbox, the Shape's recent placements and violations,
 * the `change_sets` view and the questions list order) and writes nothing. `since` comes from the
 * renderer; the repository stores no "last visit".
 */

/** What each part of the digest holds at most. */
export const homeDigestLimits = {
  /** The Retomar card's trail. */
  continue: 6,
  /** Sources, and notes, listed under "Chegou". */
  arrivals: 10,
  /** The Inbox's rows on Home. */
  inbox: 3,
  /** Recent questions. */
  questions: 3,
  /** Topics that grew this week. */
  growth: 5,
  /** The Jardineiro's changes listed (the count is exact). */
  gardener: 3,
  /** Top-level topics the Shape strip draws. */
  shapeRoots: 24,
  /** Days a `since` of null looks back. */
  defaultSinceDays: 7
} as const;

export interface HomeDigestInput {
  /** When Home was last opened; null when it never was (the last `defaultSinceDays` days then). */
  since: Date | null;
  /** The clock of the digest (default: now). */
  now?: Date | undefined;
}

export interface HomeContinueEntry {
  address: string;
  kind: ObjectKind;
  /** The object's title now, else the one recorded when it was opened. */
  title: string;
  parentAddress: string | null;
  openedAt: Date;
  /** Null when the object no longer resolves (a question or topic that went away). */
  summary: ObjectResolved | null;
}

export interface HomeArrival {
  createdAt: Date;
  object: ObjectResolved;
}

export interface HomeArrivals {
  /** Root sources created after `since`. */
  sources: { total: number; items: HomeArrival[] };
  /** Current notes created after `since`; `placed` have a primary place in the active tree. */
  notes: { total: number; placed: number; unplaced: number; items: HomeArrival[] };
}

export interface HomeInboxRow {
  kind: InboxKind;
  id: string;
  risk: ChangeSetRisk;
  at: string;
}

export interface HomeQuestion {
  id: string;
  text: string;
  scope: AskScope;
  status: AskQuestionStatus;
  createdAt: Date;
  answerCount: number;
}

export interface HomeGrowthTopic {
  id: string;
  /** Null while the topic is unnamed. */
  title: string | null;
  /** Primary placements of arriving notes this week. */
  arrivals: number;
}

export interface HomeShapeRoot {
  id: string;
  title: string | null;
  /** Current notes primarily placed in the topic and below it. */
  notes: number;
  topics: number;
  health: "good" | "attention" | "violation";
}

export interface HomeShape {
  /** An active tree exists. */
  hasTree: boolean;
  /** Current notes with a primary place. */
  notes: number;
  /** Live topics below the root. */
  topics: number;
  /** Levels below the root. */
  depth: number;
  /** Stored violations that count (proposed repairs that wait for approval are left out). */
  violations: { hard: number; soft: number };
  /** Live topics out of bounds (health `violation`). */
  outOfBounds: number;
  /** Primary placements of arriving notes in the last seven days. */
  arrivalsThisWeek: number;
  roots: HomeShapeRoot[];
}

/** A change-set as `changes.list` reports it (undo refined), for the Gardener column. */
export type HomeGardenerChange = ChangeSetSummary;

export interface HomeDigestRecord {
  /** The `since` the digest used. */
  since: Date;
  /** The library holds no source at all. */
  firstRun: boolean;
  continue: HomeContinueEntry[];
  new: HomeArrivals;
  inbox: { total: number; top: HomeInboxRow[] };
  questions: HomeQuestion[];
  growth: HomeGrowthTopic[];
  shape: HomeShape;
  /** Change-sets applied or proposed since `since`: the count, and the top by risk then recency. */
  gardener: { count: number; top: HomeGardenerChange[] };
}

const dayMs = 24 * 60 * 60 * 1000;

/** The active tree's placements: the one a library has (a partial unique index holds it). */
const activeTreeId = "(select t.id from topic_trees t where t.status = 'active')";

/** Root sources and current notes that arrived after `$1`. */
const arrivalsSql = {
  sources: `select s.id, s.created_at as "createdAt"
      from source_items s
     where s.parent_source_item_id is null and s.created_at > $1::timestamptz
     order by s.created_at desc, s.id limit $2::int`,
  sourceCount: `select count(*)::int as total from source_items s
     where s.parent_source_item_id is null and s.created_at > $1::timestamptz`,
  notes: `select n.id, n.created_at as "createdAt"
      from atomic_notes n
     where n.created_at > $1::timestamptz and ${currentNoteSql("n")}
     order by n.created_at desc, n.id limit $2::int`,
  noteCounts: `select count(*)::int as total,
         (count(*) filter (where exists (
            select 1 from topic_placements p
             where p.note_id = n.id and p.rank = 0 and p.tree_id = ${activeTreeId})))::int as placed
      from atomic_notes n
     where n.created_at > $1::timestamptz and ${currentNoteSql("n")}`
} as const;

const questionsSql = `select q.id, q.text, q.scope, q.status, q.created_at as "createdAt",
       (select count(*)::int from question_answers a where a.question_id = q.id) as "answerCount"
    from questions q order by ${questionListOrder} limit $1::int`;

/** $1 topic IDs: the live ones with their title (a retired topic is not a place to show). */
const liveTopicTitlesSql = `select t.id, t.title from topics t
   where t.id = any($1::uuid[]) and t.retired_at is null`;

/**
 * $1 tree, $2 root: each top-level topic with the live topics below it (itself included), their
 * deepest level (the top-level topic is level 1) and the current notes primarily placed in them.
 */
const shapeRootsSql = `with recursive sub as (
    select c.id as top, c.id, 1 as depth from topics c
     where c.tree_id = $1::uuid and c.parent_id = $2::uuid and c.retired_at is null
    union all
    select sub.top, k.id, sub.depth + 1 from sub
      join topics k on k.parent_id = sub.id and k.retired_at is null
  ), per_topic as (
    select sub.top, sub.depth,
           (select count(*) from topic_placements p
              join atomic_notes n on n.id = p.note_id and ${currentNoteSql("n")}
             where p.topic_id = sub.id and p.role = 'primary' and p.item_kind = 'note')::int as notes
      from sub
  )
  select t.id, t.title, coalesce(s.health, 'good') as health, agg.notes, agg.topics, agg.depth
    from (select top, sum(notes)::int as notes, count(*)::int as topics, max(depth)::int as depth
            from per_topic group by top) agg
    join topics t on t.id = agg.top
    left join topic_stats s on s.topic_id = t.id
   order by agg.notes desc, t.title nulls last, t.id`;

/** $1 root: current notes primarily placed in the root itself (nothing below it yet). */
const rootNotesSql = `select count(*)::int as notes from topic_placements p
   join atomic_notes n on n.id = p.note_id and ${currentNoteSql("n")}
  where p.topic_id = $1::uuid and p.role = 'primary' and p.item_kind = 'note'`;

/** $1 tree: live topics out of bounds. */
const outOfBoundsSql = `select count(*)::int as n from topic_stats s
   join topics t on t.id = s.topic_id and t.tree_id = $1::uuid and t.retired_at is null
  where s.health = 'violation'`;

/**
 * The Jardineiro's work: change-sets of any store that were applied or are proposed after `$1`,
 * left out when the owner made them (`human`) or took one back (`undo`). The count is exact and
 * the rows are the top by risk, then recency.
 */
const gardenerSql = `select ${changeSetViewColumns}, (count(*) over ())::int as total
    from change_sets
   where status in ('applied', 'pending_review') and change_sets.at > $1::timestamptz
     and origin not in ('human', 'undo')
   order by case risk when 'high' then 0 when 'medium' then 1 else 2 end,
            change_sets.at desc, kind, id
   limit $2::int`;

interface Row extends QueryResultRow {
  [column: string]: unknown;
}

const asDate = (value: unknown): Date => mapTimestamp(value);
const asCount = (value: unknown): number => Number(value ?? 0);

const emptyShape = (): HomeShape => ({
  hasTree: false,
  notes: 0,
  topics: 0,
  depth: 0,
  violations: { hard: 0, soft: 0 },
  outOfBounds: 0,
  arrivalsThisWeek: 0,
  roots: []
});

/** The reads of one digest over one connection (a snapshot), none of which writes. */
function digestReads(db: Queryable) {
  const objects = createObjectReadRepository(db);

  /** The resolved summaries of `ids` of one kind, in the order of `ids`, without the missing ones. */
  async function resolved(
    kind: ObjectKind,
    ids: readonly string[],
    path: boolean
  ): Promise<Map<string, ObjectResolved>> {
    const found = await objects.resolve(
      ids.map((id) => ({ kind, id })),
      { path }
    );
    return new Map(
      ids.flatMap((id) => {
        const summary = found.get(formatObjectAddress({ kind, id }));
        return summary ? [[id, summary] as const] : [];
      })
    );
  }

  async function continueEntries(): Promise<HomeContinueEntry[]> {
    // Pins have a slot of their own in `list`; the six latest opens overall are among the pins and
    // the six latest recents, so cutting the merge by time gives the trail.
    const entries = (
      await createViewHistoryRepository(db).list({ limit: homeDigestLimits.continue })
    )
      .sort(
        (a, b) => b.openedAt.getTime() - a.openedAt.getTime() || (a.address < b.address ? -1 : 1)
      )
      .slice(0, homeDigestLimits.continue);
    const found = await objects.resolve(
      entries.map((entry) => ({ kind: entry.kind, id: entry.objectId }))
    );
    return entries.map((entry) => {
      const summary = found.get(entry.address) ?? null;
      return {
        address: entry.address,
        kind: entry.kind,
        title: summary?.title ? summary.title : entry.title,
        parentAddress: entry.parentAddress,
        openedAt: entry.openedAt,
        summary
      };
    });
  }

  async function arrivals(since: Date): Promise<HomeArrivals> {
    const [sourceRows, sourceCount, noteRows, noteCounts] = await Promise.all([
      db.query<Row>(arrivalsSql.sources, [since, homeDigestLimits.arrivals]),
      db.query<Row>(arrivalsSql.sourceCount, [since]),
      db.query<Row>(arrivalsSql.notes, [since, homeDigestLimits.arrivals]),
      db.query<Row>(arrivalsSql.noteCounts, [since])
    ]);
    const [sources, notes] = await Promise.all([
      resolved(
        "source",
        sourceRows.rows.map((row) => String(row.id)),
        true
      ),
      resolved(
        "note",
        noteRows.rows.map((row) => String(row.id)),
        true
      )
    ]);
    const items = (rows: Row[], found: Map<string, ObjectResolved>): HomeArrival[] =>
      rows.flatMap((row) => {
        const object = found.get(String(row.id));
        return object ? [{ createdAt: asDate(row.createdAt), object }] : [];
      });
    const total = asCount(noteCounts.rows[0]?.total);
    const placed = asCount(noteCounts.rows[0]?.placed);
    return {
      sources: {
        total: asCount(sourceCount.rows[0]?.total),
        items: items(sourceRows.rows, sources)
      },
      notes: {
        total,
        placed,
        unplaced: Math.max(0, total - placed),
        items: items(noteRows.rows, notes)
      }
    };
  }

  async function inbox(): Promise<{ total: number; top: HomeInboxRow[] }> {
    const repository = createInboxRepository(db);
    const [counts, page] = await Promise.all([
      repository.counts(),
      repository.page({ limit: homeDigestLimits.inbox })
    ]);
    const total = Object.values(counts.byKind).reduce((sum, n) => sum + (n ?? 0), 0);
    return {
      total,
      top: page.rows.map((row) => ({ kind: row.kind, id: row.id, risk: row.risk, at: row.at }))
    };
  }

  async function questions(): Promise<HomeQuestion[]> {
    const result = await db.query<Row>(questionsSql, [homeDigestLimits.questions]);
    return result.rows.map((row) => {
      const scope = AskScopeSchema.safeParse(row.scope);
      return {
        id: String(row.id),
        text: String(row.text),
        scope: scope.success ? scope.data : { kind: "library" },
        status: row.status as AskQuestionStatus,
        createdAt: asDate(row.createdAt),
        answerCount: asCount(row.answerCount)
      };
    });
  }

  /** The topics that received arriving notes in the last week, and the tree they belong to. */
  async function growth(
    tree: { id: string },
    now: Date
  ): Promise<{ topics: HomeGrowthTopic[]; total: number }> {
    const weekStart = new Date(now.getTime() - topicReadDefaults.recentDays * dayMs);
    const recent = await db.query<{ topic_id: string; n: number }>(topicReadSql.recent, [
      tree.id,
      weekStart
    ]);
    if (recent.rows.length === 0) return { topics: [], total: 0 };
    const live = new Map(
      (await db.query<Row>(liveTopicTitlesSql, [recent.rows.map((row) => row.topic_id)])).rows.map(
        (row) => [String(row.id), (row.title as string | null) ?? null]
      )
    );
    const topics = recent.rows
      .filter((row) => live.has(row.topic_id))
      .map((row) => ({
        id: row.topic_id,
        title: live.get(row.topic_id) ?? null,
        arrivals: Number(row.n)
      }))
      .sort(
        (a, b) =>
          b.arrivals - a.arrivals ||
          (a.title ?? "￿").localeCompare(b.title ?? "￿") ||
          (a.id < b.id ? -1 : 1)
      );
    return {
      topics: topics.slice(0, homeDigestLimits.growth),
      total: topics.reduce((sum, topic) => sum + topic.arrivals, 0)
    };
  }

  async function shape(
    tree: { id: string; rootId: string },
    arrivalsThisWeek: number
  ): Promise<HomeShape> {
    const [roots, rootNotes, stored, outOfBounds] = await Promise.all([
      db.query<Row>(shapeRootsSql, [tree.id, tree.rootId]),
      db.query<Row>(rootNotesSql, [tree.rootId]),
      db.query<Row>(topicReadSql.violations, [tree.id, topicReadDefaults.violations]),
      db.query<Row>(outOfBoundsSql, [tree.id])
    ]);
    // The same count the Shape screen makes: a proposed repair that waits for approval is not a
    // violation yet.
    const counted = stored.rows.filter((row) => row.reason && !row.awaiting);
    const hard = counted.filter((row) => row.severity === "hard").length;
    const rows = roots.rows.map((row): HomeShapeRoot => ({
      id: String(row.id),
      title: (row.title as string | null) ?? null,
      notes: asCount(row.notes),
      topics: asCount(row.topics),
      health: row.health === "violation" || row.health === "attention" ? row.health : "good"
    }));
    return {
      hasTree: true,
      notes: rows.reduce((sum, row) => sum + row.notes, asCount(rootNotes.rows[0]?.notes)),
      topics: rows.reduce((sum, row) => sum + row.topics, 0),
      depth: roots.rows.reduce((deepest, row) => Math.max(deepest, asCount(row.depth)), 0),
      violations: { hard, soft: counted.length - hard },
      outOfBounds: asCount(outOfBounds.rows[0]?.n),
      arrivalsThisWeek,
      roots: rows.slice(0, homeDigestLimits.shapeRoots)
    };
  }

  async function gardener(since: Date): Promise<{ count: number; top: HomeGardenerChange[] }> {
    const result = await db.query<ChangeSetViewRow & { total: number }>(gardenerSql, [
      since,
      homeDigestLimits.gardener
    ]);
    return {
      count: asCount(result.rows[0]?.total),
      top: await summarizeChangeSetRows(db, result.rows)
    };
  }

  return { arrivals, continueEntries, gardener, growth, inbox, questions, shape };
}

export function createHomeDigestRepository(pool: PgPool) {
  /** One consistent snapshot: the briefing's counts are sentences about one moment. */
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
     * One read of everything Home shows. Nothing is written. A library with no source is `firstRun`
     * and every part is empty; a library with no tree has an empty Shape.
     */
    async digest(input: HomeDigestInput): Promise<HomeDigestRecord> {
      const now = input.now ?? new Date();
      const since =
        input.since ?? new Date(now.getTime() - homeDigestLimits.defaultSinceDays * dayMs);
      return snapshot(async (db) => {
        const reads = digestReads(db);
        const treeResult = await db.query<{ id: string; rootId: string }>(topicReadSql.activeTree);
        const tree = treeResult.rows[0] ?? null;
        // One connection runs these one after the other, all against the same snapshot.
        const empty = await db.query<{ empty: boolean }>(
          "select not exists (select 1 from source_items) as empty"
        );
        const trail = await reads.continueEntries();
        const arrived = await reads.arrivals(since);
        const inboxPart = await reads.inbox();
        const asked = await reads.questions();
        const grown = tree ? await reads.growth(tree, now) : { topics: [], total: 0 };
        const done = await reads.gardener(since);
        return {
          since,
          firstRun: empty.rows[0]?.empty === true,
          continue: trail,
          new: arrived,
          inbox: inboxPart,
          questions: asked,
          growth: grown.topics,
          shape: tree ? await reads.shape(tree, grown.total) : emptyShape(),
          gardener: done
        };
      });
    }
  };
}

export type HomeDigestRepository = ReturnType<typeof createHomeDigestRepository>;
