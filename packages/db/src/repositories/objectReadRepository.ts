import type { QueryResultRow } from "pg";

import {
  backlinkVias,
  formatObjectAddress,
  objectBacklinkSnippetMaxLength,
  objectLocatePathLimit,
  objectLocateTopicPathLimit,
  objectPreviewMaxLength,
  plainText,
  type BacklinkCursor,
  type BacklinkVia,
  type ObjectAddress,
  type ObjectBacklink,
  type ObjectKind,
  type ObjectResolved,
  type ObjectStatus,
  type PathSegment
} from "@app/domain";

import { currentNoteSql, shownNoteRelationSql } from "./note-relation-sql.js";
import { currentSourceRelationSql } from "./sourceRelationRepository.js";
import type { Queryable } from "./types.js";

/**
 * The objects read layer (F5 D11, docs/plan.md 4.5): what `objects.get`, `objects.resolveMany` and
 * `objects.backlinks` read, as a read repository over the canonical tables. It writes nothing and
 * defines no SQL view. It composes the predicate modules and repeats none of them: a relation is
 * shown only through `note-relation-sql.ts`, a note is current only through its `currentNoteSql`,
 * a source relation is visible only through `currentSourceRelationSql`.
 *
 * Every lookup is by primary key or by an existing index, so a call costs what it returns, not
 * the size of the library; `scripts/objects/locate-benchmark.ts` measures `resolveMany(200)` and
 * `backlinks` on a library of 30,000 notes.
 */

/** Raw text read for a preview or a snippet: enough to plain-text and cut, never a whole body. */
const rawTextLength = 1500;
const rawSnippetLength = 400;
/** Longest chain of redirects followed from a retired topic. */
const redirectDepthLimit = 8;

interface Facts {
  title: string;
  status: ObjectStatus;
  redirectTo?: string;
  /** Raw text of the preview; plain-texted when the summary is built. */
  raw: string;
  language: string | null;
  updatedAt: Date;
  counts: Record<string, number>;
}

interface FactRow extends QueryResultRow {
  id: string;
  title: string | null;
  raw: string | null;
  language: string | null;
  updatedAt: Date;
  status?: ObjectStatus;
  redirectTo?: string | null;
}

const key = (kind: ObjectKind, id: string) => `${kind}/${id}`;
const toAddress = (kind: ObjectKind, id: string) => `memora://${kind}/${id}`;

/** Source: its summary; the subtitle when it has none yet. Counts: current notes and passages. */
const sourceFactsSql = `
select s.id, s.title, coalesce(nullif(left(s.summary, ${rawTextLength}), ''), left(s.subtitle, ${rawTextLength})) as raw,
       s.language, s.updated_at as "updatedAt",
       (select count(*)::int from atomic_notes n
         where n.created_from_source_item_id = s.id and ${currentNoteSql("n")}) as notes,
       (select count(*)::int from chunks c where c.source_item_id = s.id) as passages
  from source_items s where s.id = any($1::uuid[])`;

/** Note: its body (the idea statement when the body is empty). `current` is the endpoint predicate. */
const noteFactsSql = `
select n.id, n.title, coalesce(nullif(left(n.body_markdown, ${rawTextLength}), ''), n.idea_statement) as raw,
       n.language, n.updated_at as "updatedAt", ${currentNoteSql("n")} as current,
       (select count(*)::int from atomic_note_source_links l where l.atomic_note_id = n.id) as sources
  from atomic_notes n where n.id = any($1::uuid[])`;

/**
 * Topic: its description, else the lead of its overview. A retired topic follows `redirect_to`
 * (a chain, bounded) to the live topic that replaced it; a chain that ends retired is only retired.
 * Counts come from the tree's own statistics, which an engine pass may not have refreshed yet.
 */
const topicFactsSql = `
with recursive follow(origin, id, redirect_to, retired, depth) as (
  select t.id, t.id, t.redirect_to, t.retired_at is not null, 0
    from topics t where t.id = any($1::uuid[]) and t.retired_at is not null and t.redirect_to is not null
  union all
  select f.origin, t.id, t.redirect_to, t.retired_at is not null, f.depth + 1
    from follow f join topics t on t.id = f.redirect_to
   where f.retired and f.redirect_to is not null and f.depth < ${redirectDepthLimit}
),
ended as (select distinct on (origin) origin, id, retired from follow order by origin, depth desc)
select t.id, t.title,
       coalesce(nullif(left(t.description, ${rawTextLength}), ''),
                (select left(o.paragraphs->0->>'text', ${rawTextLength}) from topic_overviews o where o.topic_id = t.id)) as raw,
       t.name_language as language, t.updated_at as "updatedAt",
       case when t.retired_at is null then 'current'
            when ended.id is not null and not ended.retired then 'redirected'
            else 'retired' end as status,
       case when ended.id is not null and not ended.retired then ended.id end as "redirectTo",
       coalesce(st.n, 0) as notes, coalesce(st.children, 0) as children
  from topics t
  left join ended on ended.origin = t.id
  left join topic_stats st on st.topic_id = t.id
 where t.id = any($1::uuid[])`;

/** Entity: its description. Counts: the current notes that mention it. */
const entityFactsSql = `
select e.id, e.canonical_name as title, left(e.description, ${rawTextLength}) as raw, e.language,
       e.updated_at as "updatedAt",
       (select count(*)::int from atomic_note_entity_links l join atomic_notes n on n.id = l.atomic_note_id
         where l.entity_id = e.id and ${currentNoteSql("n")}) as notes
  from entities e where e.id = any($1::uuid[])`;

/** Question: its own words. Counts: the answer versions stored. */
const questionFactsSql = `
select q.id, left(q.text, 200) as title, q.text as raw, q.language, q.updated_at as "updatedAt",
       (select count(*)::int from question_answers a where a.question_id = q.id) as answers
  from questions q where q.id = any($1::uuid[])`;

/**
 * The passages an anchored address previews: an entry names its object, an anchor key and the
 * anchor's ID. A passage or span counts only when it belongs to the object (a source's own chunk,
 * a note's evidence or source links, a topic overview's citations); anything else previews the
 * object as if there were no anchor. `section` anchors have no text to show.
 */
const passageSql = `
select e.key, left(c.content, ${rawTextLength}) as raw
  from jsonb_to_recordset($1::jsonb) as e(key text, kind text, obj uuid, anchor uuid)
  join chunks c on c.id = e.anchor
 where case e.kind
   when 'source' then c.source_item_id = e.obj
   when 'note' then exists (select 1 from atomic_notes n where n.id = e.obj and n.evidence_chunk_id = c.id)
     or exists (select 1 from atomic_note_source_links l where l.atomic_note_id = e.obj and l.chunk_id = c.id)
     or exists (select 1 from atomic_note_evidence v where v.note_id = e.obj and v.chunk_id = c.id)
   when 'topic' then exists (select 1 from topic_overview_citations oc where oc.topic_id = e.obj and oc.chunk_id = c.id)
   else false end`;

const spanSql = `
select e.key, left(c.content, ${rawTextLength}) as raw
  from jsonb_to_recordset($1::jsonb) as e(key text, kind text, obj uuid, anchor uuid)
  join source_spans sp on sp.id = e.anchor
  join lateral (select k.content from chunks k
                 where k.document_id = sp.document_id and k.source_span_id = sp.id
                 order by k.chunk_index limit 1) c on true
 where case e.kind
   when 'source' then sp.source_item_id = e.obj
   when 'note' then exists (select 1 from atomic_notes n where n.id = e.obj and n.source_span_id = sp.id)
     or exists (select 1 from atomic_note_source_links l where l.atomic_note_id = e.obj and l.source_span_id = sp.id)
   when 'topic' then exists (select 1 from topic_overview_citations oc where oc.topic_id = e.obj and oc.source_span_id = sp.id)
   else false end`;

/**
 * The topics above an object, root first and without the (untitled) root: a note by its own
 * primary placement in the active tree, a source by its root source's, a topic by its ancestors.
 * Entities and questions have no place. $1 notes, $2 sources, $3 topics.
 */
const pathSql = `
with recursive active as (select id from topic_trees where status = 'active'),
src_chain(key, id, parent_id, depth) as (
  select s.id, s.id, s.parent_source_item_id, 0 from source_items s where s.id = any($2::uuid[])
  union all
  select c.key, p.id, p.parent_source_item_id, c.depth + 1
    from src_chain c join source_items p on p.id = c.parent_id where c.depth < ${objectLocatePathLimit}
),
src_root as (select distinct on (key) key, id from src_chain order by key, depth desc),
seeds as (
  select p.note_id as key, p.topic_id from topic_placements p
   where p.note_id = any($1::uuid[]) and p.rank = 0 and p.tree_id = (select id from active)
  union all
  select r.key, p.topic_id from src_root r
    join topic_placements p on p.source_item_id = r.id and p.rank = 0 and p.tree_id = (select id from active)
  union all
  select t.id, t.parent_id from topics t where t.id = any($3::uuid[]) and t.parent_id is not null
),
chain(key, id, parent_id, title, role, depth) as (
  select s.key, t.id, t.parent_id, t.title, t.role, 0
    from seeds s join topics t on t.id = s.topic_id where t.retired_at is null
  union all
  select c.key, t.id, t.parent_id, t.title, t.role, c.depth + 1
    from chain c join topics t on t.id = c.parent_id
   where c.depth < ${objectLocateTopicPathLimit} and t.retired_at is null
)
select key, id, coalesce(title, '') as title from chain where role <> 'root' order by key, depth desc`;

/** One arm of the backlinks union: its position in `backlinkVias`, and the columns it orders by. */
interface Arm {
  via: BacklinkVia;
  /** The arm's rows, in a subquery with the cursor and `limit $5` applied. */
  sql: string;
}

const armOrder = (via: BacklinkVia) => backlinkVias.indexOf(via);

/**
 * Rows after the cursor: every row of an arm after the cursor's arm, and, in the cursor's own arm,
 * the rows older than it (newest first, the ID breaks ties). $2 arm, $3 time, $4 ID.
 */
const afterCursor = (via: BacklinkVia, createdAt: string, id: string) =>
  `(${armOrder(via)} > $2::int or (${armOrder(via)} = $2::int and (${createdAt}, ${id}) < ($3::timestamptz, $4::uuid)))`;

const arm = (via: BacklinkVia, select: string, from: string, order: [string, string]): Arm => ({
  via,
  sql: `(select ${armOrder(via)} as arm, ${order[0]} as ts, ${order[1]} as id, ${select}
     from ${from} and ${afterCursor(via, order[0], order[1])}
    order by ${order[0]} desc, ${order[1]} desc limit $5::int)`
});

/** Evidence: the notes resting on a passage of the source (one row per passage). */
const evidenceArm = arm(
  "evidence",
  `'memora://note/' || n.id::text as "from", 'passage=' || l.chunk_id::text as anchor,
     left(c.content, ${rawSnippetLength}) as snippet`,
  `atomic_note_source_links l
     join atomic_notes n on n.id = l.atomic_note_id
     join chunks c on c.id = l.chunk_id
    where l.source_item_id = $1::uuid and ${currentNoteSql("n")}`,
  ["l.created_at", "l.id"]
);

/** Relation: the notes a shown relation links this note to (the module's predicate). */
const relationArm = arm(
  "relation",
  `'memora://note/' || (case when r.source_atomic_note_id = $1::uuid
                             then r.target_atomic_note_id else r.source_atomic_note_id end)::text as "from",
     null::text as anchor, left(r.explanation, ${rawSnippetLength}) as snippet`,
  `atomic_note_relations r
    where (r.source_atomic_note_id = $1::uuid or r.target_atomic_note_id = $1::uuid)
      and ${shownNoteRelationSql("r")}`,
  ["r.created_at", "r.id"]
);

/** Source relation: the other source of a relation that is not removed and rests on current evidence. */
const sourceRelationArm = arm(
  "source_relation",
  `'memora://source/' || (case when r.source_item_id = $1::uuid
                              then r.target_source_item_id else r.source_item_id end)::text as "from",
     'relation=' || r.id::text as anchor,
     left(coalesce(r.explanation, r.source_idea, r.target_idea), ${rawSnippetLength}) as snippet`,
  `source_relations r
    where (r.source_item_id = $1::uuid or r.target_source_item_id = $1::uuid)
      and r.status <> 'rejected' and ${currentSourceRelationSql}`,
  ["r.created_at", "r.id"]
);

/** Overview citation: the live topics whose overview cites the note (one row per topic). */
const overviewCitationArm = arm(
  "overview_citation",
  `'memora://topic/' || c.topic_id::text as "from", null::text as anchor,
     left(c.excerpt, ${rawSnippetLength}) as snippet`,
  `(select distinct on (topic_id) topic_id, excerpt from topic_overview_citations
       where note_id = $1::uuid order by topic_id, n) c
     join topic_overviews o on o.topic_id = c.topic_id
     join topics t on t.id = c.topic_id
    where t.retired_at is null`,
  ["o.written_at", "c.topic_id"]
);

/** The stored citation anchor as an address fragment; a passage is cited as a chunk. */
const citationAnchorSql = `(case when c.target_kind = 'chunk'
       then 'passage=' || coalesce(c.anchor->>'passage', c.target_id::text)
       else nullif(concat_ws('&', 'passage=' || (c.anchor->>'passage'), 'span=' || (c.anchor->>'span'),
                             'section=' || (c.anchor->>'section')), '') end)`;

/**
 * Question citation: the questions whose answers cite the object, once each, from the newest
 * version that does and, within it, the citation that names a passage before one that does not.
 */
const questionCitationArm = (kind: "note" | "source" | "topic"): Arm => {
  const hits =
    kind === "source"
      ? `select c.answer_id, c.ordinal, c.target_kind, c.target_id, c.anchor from question_citations c
          where c.target_kind = 'source' and c.target_id = $1::uuid
         union all
         select c.answer_id, c.ordinal, c.target_kind, c.target_id, c.anchor from question_citations c
          where c.target_kind = 'chunk'
            and c.target_id in (select k.id from chunks k where k.source_item_id = $1::uuid)`
      : `select c.answer_id, c.ordinal, c.target_kind, c.target_id, c.anchor from question_citations c
          where c.target_kind = '${kind}' and c.target_id = $1::uuid`;
  return arm(
    "question_citation",
    `'memora://question/' || q.id::text as "from", m.anchor, left(q.text, ${rawSnippetLength}) as snippet`,
    `(select distinct on (a.question_id) a.question_id, ${citationAnchorSql} as anchor
         from (${hits}) c join question_answers a on a.id = c.answer_id
        order by a.question_id, a.version desc, (${citationAnchorSql} is null), c.ordinal) m
     join questions q on q.id = m.question_id
    where true`,
    ["q.created_at", "q.id"]
  );
};

/** Mention: the current notes that mention the entity. */
const mentionArm = arm(
  "mention",
  `'memora://note/' || n.id::text as "from", null::text as anchor,
     left(n.idea_statement, ${rawSnippetLength}) as snippet`,
  `atomic_note_entity_links l join atomic_notes n on n.id = l.atomic_note_id
    where l.entity_id = $1::uuid and ${currentNoteSql("n")}`,
  ["l.created_at", "l.id"]
);

/** The arms each kind of target has (section 3.3 of the F5 spec). A question is never cited. */
function armsFor(kind: ObjectKind): Arm[] {
  switch (kind) {
    case "source":
      return [evidenceArm, sourceRelationArm, questionCitationArm("source")];
    case "note":
      return [relationArm, overviewCitationArm, questionCitationArm("note")];
    case "topic":
      return [questionCitationArm("topic")];
    case "entity":
      return [mentionArm];
    case "question":
      return [];
  }
}

/**
 * One statement for the whole union: each arm reads at most `limit + 1` rows after the cursor, and
 * the union keeps the first `limit + 1` of them. $1 target, $2 to $4 the cursor, $5 `limit + 1`.
 */
function backlinksSql(kind: ObjectKind): string | null {
  const arms = armsFor(kind);
  if (arms.length === 0) return null;
  return `select u.arm, u."from", u.anchor, u.snippet, u.id::text as id,
       to_char(u.ts at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as "createdAt"
  from (${arms.map((entry) => entry.sql).join("\n  union all\n  ")}) u
 order by u.arm, u.ts desc, u.id desc limit $5::int`;
}

interface BacklinkRow extends QueryResultRow {
  arm: number;
  from: string;
  anchor: string | null;
  snippet: string | null;
  id: string;
  createdAt: string;
}

export interface BacklinksRequest {
  target: ObjectAddress;
  /** 1 to 50 (the caller validates). */
  limit: number;
  cursor?: BacklinkCursor | undefined;
}

export interface BacklinksPage {
  items: ObjectBacklink[];
  next?: BacklinkCursor;
}

export interface ResolveOptions {
  /** Also read the topics above each object. */
  path: boolean;
}

export function createObjectReadRepository(db: Queryable) {
  const facts = async (kind: ObjectKind, ids: string[]): Promise<Map<string, Facts>> => {
    const found = new Map<string, Facts>();
    if (ids.length === 0) return found;
    const sql = {
      source: sourceFactsSql,
      note: noteFactsSql,
      topic: topicFactsSql,
      entity: entityFactsSql,
      question: questionFactsSql
    }[kind];
    const result = await db.query<FactRow & Record<string, unknown>>(sql, [ids]);
    for (const row of result.rows) {
      const count = (name: string): number => Number(row[name] ?? 0);
      const base = {
        title: row.title ?? "",
        raw: row.raw ?? "",
        language: row.language && row.language !== "und" ? row.language : null,
        updatedAt: row.updatedAt
      };
      let entry: Facts;
      if (kind === "source")
        entry = {
          ...base,
          status: "current",
          counts: { notes: count("notes"), passages: count("passages") }
        };
      else if (kind === "note")
        entry = {
          ...base,
          status: row.current ? "current" : "retired",
          counts: { sources: count("sources") }
        };
      else if (kind === "topic")
        entry = {
          ...base,
          status: row.status ?? "current",
          ...(row.redirectTo ? { redirectTo: toAddress("topic", row.redirectTo) } : {}),
          counts: { notes: count("notes"), children: count("children") }
        };
      else if (kind === "entity")
        entry = { ...base, status: "current", counts: { notes: count("notes") } };
      else entry = { ...base, status: "current", counts: { answers: count("answers") } };
      found.set(key(kind, row.id), entry);
    }
    return found;
  };

  /** The raw text of every anchored address whose passage or span belongs to its object. */
  const anchoredText = async (addresses: ObjectAddress[]): Promise<Map<string, string>> => {
    const entries = (anchorKey: "passage" | "span") =>
      addresses.flatMap((address) => {
        const anchor = address.anchor?.[anchorKey];
        return anchor
          ? [
              {
                key: formatObjectAddress(address),
                kind: address.kind,
                obj: address.id,
                anchor
              }
            ]
          : [];
      });
    const text = new Map<string, string>();
    const run = async (sql: string, list: ReturnType<typeof entries>) => {
      if (list.length === 0) return;
      const result = await db.query<{ key: string; raw: string }>(sql, [JSON.stringify(list)]);
      for (const row of result.rows) if (!text.has(row.key)) text.set(row.key, row.raw);
    };
    // A passage wins over a span when an address names both.
    await run(passageSql, entries("passage"));
    await run(
      spanSql,
      entries("span").filter((entry) => !text.has(entry.key))
    );
    return text;
  };

  const paths = async (
    notes: string[],
    sources: string[],
    topics: string[]
  ): Promise<Map<string, PathSegment[]>> => {
    const found = new Map<string, PathSegment[]>();
    if (notes.length + sources.length + topics.length === 0) return found;
    const result = await db.query<{ key: string; id: string; title: string }>(pathSql, [
      notes,
      sources,
      topics
    ]);
    for (const row of result.rows) {
      const list = found.get(row.key) ?? [];
      list.push({ kind: "topic", id: row.id, title: row.title });
      found.set(row.key, list);
    }
    return found;
  };

  return {
    /**
     * The summaries of the objects `addresses` name, keyed by canonical address (anchor included).
     * An address whose object does not exist has no entry. The kinds are read in parallel, each by
     * primary key over the ids it holds.
     */
    async resolve(
      addresses: ObjectAddress[],
      options: ResolveOptions = { path: false }
    ): Promise<Map<string, ObjectResolved>> {
      const idsOf = (kind: ObjectKind) => [
        ...new Set(addresses.filter((address) => address.kind === kind).map((a) => a.id))
      ];
      const [source, note, topic, entity, question, anchored, placed] = await Promise.all([
        facts("source", idsOf("source")),
        facts("note", idsOf("note")),
        facts("topic", idsOf("topic")),
        facts("entity", idsOf("entity")),
        facts("question", idsOf("question")),
        anchoredText(addresses.filter((address) => address.anchor)),
        options.path
          ? paths(idsOf("note"), idsOf("source"), idsOf("topic"))
          : Promise.resolve(new Map<string, PathSegment[]>())
      ]);
      const byKind = { source, note, topic, entity, question };
      const resolved = new Map<string, ObjectResolved>();
      for (const address of addresses) {
        const found = byKind[address.kind].get(key(address.kind, address.id));
        if (!found) continue;
        const canonical = formatObjectAddress(address);
        const text = anchored.get(canonical) ?? found.raw;
        const preview = plainText(text, objectPreviewMaxLength);
        const hasPath =
          address.kind === "note" || address.kind === "source" || address.kind === "topic";
        resolved.set(canonical, {
          address: canonical,
          kind: address.kind,
          title: found.title,
          status: found.status,
          ...(found.redirectTo ? { redirectTo: found.redirectTo } : {}),
          preview,
          ...(found.language ? { language: found.language } : {}),
          updatedAt: found.updatedAt.toISOString(),
          counts: found.counts,
          ...(options.path ? { path: hasPath ? (placed.get(address.id) ?? []) : [] } : {})
        });
      }
      return resolved;
    },

    /**
     * One page of the links into an object: a keyset-paged union of its arms, ordered by arm, then
     * newest first. `next` is set when more rows exist.
     */
    async backlinks(request: BacklinksRequest): Promise<BacklinksPage> {
      const sql = backlinksSql(request.target.kind);
      if (!sql) return { items: [] };
      const cursor = request.cursor;
      const result = await db.query<BacklinkRow>(sql, [
        request.target.id,
        cursor ? cursor.arm : -1,
        cursor ? cursor.createdAt : "1970-01-01T00:00:00.000000Z",
        cursor ? cursor.id : "00000000-0000-0000-0000-000000000000",
        request.limit + 1
      ]);
      const page = result.rows.slice(0, request.limit);
      const items = page.map((row): ObjectBacklink => {
        const snippet = row.snippet ? plainText(row.snippet, objectBacklinkSnippetMaxLength) : "";
        const via = backlinkVias[Number(row.arm)];
        if (!via) throw new Error("Unknown backlink arm.");
        return {
          from: row.from,
          via,
          ...(row.anchor ? { anchor: row.anchor } : {}),
          ...(snippet ? { snippet } : {})
        };
      });
      const last = page.at(-1);
      const more = result.rows.length > request.limit && last !== undefined;
      return {
        items,
        ...(more ? { next: { arm: Number(last.arm), createdAt: last.createdAt, id: last.id } } : {})
      };
    },

    /**
     * The statements, for EXPLAIN in verification: the facts of each kind ($1 the ids), the paths
     * and the backlinks of a kind (null: the kind has none).
     */
    statements: {
      facts: {
        source: sourceFactsSql,
        note: noteFactsSql,
        topic: topicFactsSql,
        entity: entityFactsSql,
        question: questionFactsSql
      },
      backlinks: backlinksSql,
      paths: pathSql
    }
  };
}
