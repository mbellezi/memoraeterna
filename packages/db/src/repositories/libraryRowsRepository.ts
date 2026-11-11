import type { QueryResultRow } from "pg";

import {
  gardenerStatusNeedsPerson,
  linkingParkReason,
  waitingForDeciderSkipReason
} from "@app/domain";

import { appliedNoteRelationSql, currentNoteSql } from "./note-relation-sql.js";
import { topicPrimarySourcesCte, topicScopeCtes } from "./topicScopeSql.js";
import type { Queryable } from "./types.js";

/**
 * The Library's read model (F5 T131, spec 3.3 and design record 7.3 and 6.2): `library.rows`, one
 * keyset-paged page of the root sources with their status, note count and place in the topic
 * tree, and `library.sourceProgress`, the live generation strip's values and its section ruler.
 * It writes nothing and defines no SQL view. It composes the predicate modules and repeats none of
 * them: a note is current through `currentNoteSql`, a relation is counted through
 * `appliedNoteRelationSql`, a topic's members through `topicScopeCtes`.
 *
 * Every row is a root source (children of a book are parts of it). The status is derived once, in
 * SQL, from the latest ingestion run of the source and of its parts, and the cheap sorts (title,
 * added, updated) derive it only for the rows of the page.
 */

/** The columns `library.rows` sorts by (the Library table's headers). */
export const libraryRowSorts = ["title", "added", "updated", "notes", "status"] as const;
export type LibraryRowSort = (typeof libraryRowSorts)[number];

/**
 * What a source is doing for the person, in this order of precedence (the first that holds):
 *
 * - `needsYou`: work waits for a person (a model to choose or sign in to, a budget to raise);
 *   `reason` is the Gardener's blocker key;
 * - `processing`: an ingestion run of the source or of one of its parts is pending or running;
 * - `failed`: the latest run of the source, or of one of its parts, failed or was canceled;
 * - `storedOnly`: stored and searchable, with no current note ("Guardada, sem notas");
 * - `ready`.
 */
export const libraryRowStatuses = [
  "processing",
  "ready",
  "failed",
  "needsYou",
  "storedOnly"
] as const;
export type LibraryRowStatus = (typeof libraryRowStatuses)[number];

export const libraryRowsLimit = { default: 50, max: 100 } as const;

/** The most sections the ruler shows; a longer source merges neighbouring sections. */
export const sourceProgressSectionLimit = 40;
/** Completed sources whose notes per passage make the estimate, and the least that make one. */
export const sourceProgressEstimate = { referenceSources: 30, minReferenceSources: 3 };

const malformedCursor = "errors.common.validationFailed";

export interface LibraryRowsFilter {
  /** Source types (`source_item_type`). */
  kinds?: readonly string[] | undefined;
  status?: LibraryRowStatus | undefined;
  /** A root topic of the active tree: the sources placed (primarily) in it or below it. */
  topicId?: string | undefined;
  /** Matches the title, ignoring case and accents, through the 0067 trigram index. */
  query?: string | undefined;
}

export interface LibraryRowsInput {
  sort?: LibraryRowSort | undefined;
  dir?: "asc" | "desc" | undefined;
  filter?: LibraryRowsFilter | undefined;
  cursor?: string | undefined;
  limit?: number | undefined;
  /** Also count the territories and the statuses (the territory bar and the state chips). */
  facets?: boolean | undefined;
}

export interface LibraryPathSegment {
  id: string;
  /** Empty for a topic that is not named yet; the interface localizes the label. */
  title: string;
}

export interface LibraryRow {
  id: string;
  title: string;
  /** The source type. */
  type: string;
  /** Authors (up to five names); every creator when the source names no author. */
  authors: string[];
  addedAt: string;
  updatedAt: string;
  status: LibraryRowStatus;
  /** For `needsYou` only: the Gardener blocker key that holds the work. */
  reason: string | null;
  /** Current notes of the source and of its parts. */
  noteCount: number;
  /**
   * The topics from the first below the tree root down to the one the source is placed in. A
   * tentative path is the topic where most of a still unplaced source's notes are placed.
   */
  place: { path: LibraryPathSegment[]; tentative: boolean } | null;
  hasCover: boolean;
}

export interface LibraryTerritory {
  /** The root topic, or null for "Sem lugar" (sources with no place in the tree). */
  topic: LibraryPathSegment | null;
  count: number;
}

export interface LibraryRowsFacets {
  /** Per root topic with its sources (title order), then "Sem lugar" last; ignores `topicId`. */
  territories: LibraryTerritory[];
  /** Per status; ignores `status`. Every status is present. */
  statuses: Record<LibraryRowStatus, number>;
}

export interface LibraryRowsResult {
  rows: LibraryRow[];
  next?: string;
  /** Sources matching the filter, whatever the page. */
  total: number;
  facets?: LibraryRowsFacets;
}

type StepState = "pending" | "running" | "done" | "failed" | "notApplicable";

export interface SourceProgressSection {
  title: string;
  /** Its share of the source's text, 0 to 1; the shares add up to 1. */
  share: number;
  /** Current notes resting on this section so far. */
  notes: number;
  state: "done" | "reading" | "pending";
}

export interface SourceProgress {
  /** The latest ingestion run, or null when the source never had one. */
  run: {
    status: "pending" | "running" | "succeeded" | "failed" | "canceled";
    stage: string;
    startedAt: string | null;
    completedAt: string | null;
    /** The stage that failed, when one did. */
    failedStage: string | null;
  } | null;
  /** The Gardener blocker key when the work waits for a person (as `LibraryRow.reason`). */
  needsYou: string | null;
  /** The person paused the work: a run of the source or of a part waits in a paused job. */
  paused: boolean;
  steps: {
    read: { state: StepState; pages: number | null };
    chunks: { state: StepState; indexed: number };
    notes: { state: StepState; soFar: number; estimate: number | null };
    placed: { state: StepState; count: number };
    summary: { state: StepState };
    relations: { state: StepState; count: number };
  };
  sections: SourceProgressSection[];
}

// ---------------------------------------------------------------------------
// Cursor

interface RowsCursor {
  /** Null only for a title cursor whose key is too long to carry: the id gives it back. */
  key: string | number | null;
  id: string;
}

const base64url = (text: string) => Buffer.from(text, "utf8").toString("base64url");

/** The longest cursor the statement hands out; the IPC schemas accept up to 600 characters. */
export const libraryRowsCursorMax = 500;

/**
 * The cursor is the sort key and id of the last row of a page: opaque to the renderer. A title
 * key can be as long as the title (1000 characters, three bytes each in CJK), so a title cursor
 * that would pass `libraryRowsCursorMax` carries no key: the statement reads the key back from the
 * row's id. Every other key is a number or an instant.
 */
export function encodeLibraryRowsCursor(
  sort: LibraryRowSort,
  dir: "asc" | "desc",
  cursor: RowsCursor
): string {
  const full = base64url(JSON.stringify([sort, dir, cursor.key, cursor.id]));
  if (sort !== "title" || cursor.key === null || full.length <= libraryRowsCursorMax) return full;
  return base64url(JSON.stringify([sort, dir, null, cursor.id]));
}

/** Decodes a cursor made for this sort and direction; anything else is refused. */
export function decodeLibraryRowsCursor(
  value: string,
  sort: LibraryRowSort,
  dir: "asc" | "desc"
): RowsCursor {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
  } catch {
    throw new Error(malformedCursor);
  }
  if (!Array.isArray(parsed) || parsed.length !== 4) throw new Error(malformedCursor);
  const [cursorSort, cursorDir, key, id] = parsed as unknown[];
  const numeric = sort === "notes" || sort === "status";
  if (
    cursorSort !== sort ||
    cursorDir !== dir ||
    typeof id !== "string" ||
    !uuidPattern.test(id) ||
    (sort === "title" ? key !== null && typeof key !== "string" : false) ||
    (sort !== "title" && (numeric ? !Number.isInteger(key) : typeof key !== "string")) ||
    ((sort === "added" || sort === "updated") && !instantPattern.test(key as string))
  )
    throw new Error(malformedCursor);
  return { key: key as string | number | null, id };
}

/** A cursor instant: UTC with microseconds, as the statement writes it. */
const instantPattern = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/u;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

// ---------------------------------------------------------------------------
// SQL pieces

const defaultDirection: Record<LibraryRowSort, "asc" | "desc"> = {
  title: "asc",
  added: "desc",
  updated: "desc",
  notes: "desc",
  status: "asc"
};

/** The status order of the `status` sort: what needs attention first. */
const statusRankSql = (
  status: string
) => `(case ${status} when 'needsYou' then 0 when 'failed' then 1
  when 'processing' then 2 when 'storedOnly' then 3 else 4 end)`;

/**
 * A timestamp as text in a fixed, sortable form with microseconds and an explicit zone, so it makes
 * a keyset cursor that casts back to exactly the same instant.
 */
const timestampTextSql = (column: string) =>
  `to_char(${column} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * The sort key of a row: its SQL over the candidate `c` and the derived row `d`, its parameter
 * type, how it is read back for the cursor, and whether it needs the derived columns.
 */
const sortKeys: Record<
  LibraryRowSort,
  {
    sql: (status: string) => string;
    type: "text" | "int" | "timestamptz";
    out: (key: string) => string;
    /** The cursor's key as a typed value, from its parameter and its row id parameter. */
    anchor?: (key: string, id: string) => string;
    derived: boolean;
  }
> = {
  title: {
    sql: () => "f_unaccent(lower(c.title))",
    type: "text",
    out: (key) => key,
    // A cursor too long to carry the key (null) gets it back from the row it names.
    anchor: (key, id) =>
      `coalesce(${key}::text, (select f_unaccent(lower(a.title)) from source_items a where a.id = ${id}::uuid))`,
    derived: false
  },
  added: { sql: () => "c.created_at", type: "timestamptz", out: timestampTextSql, derived: false },
  updated: {
    sql: () => "c.updated_at",
    type: "timestamptz",
    out: timestampTextSql,
    derived: false
  },
  notes: { sql: () => "d.notes", type: "int", out: (key) => key, derived: true },
  status: { sql: statusRankSql, type: "int", out: (key) => key, derived: true }
};

/**
 * The root sources that match the filter: narrow rows (the page reads the rest). `$1` kinds, `$2`
 * the query text, `$3` the blocker keys that need a person, `$4` status, `$5` topic.
 */
const candidatesCte = (topicFilter: boolean) => `candidates as (
  select s.id, s.title, s.type::text as type, s.created_at, s.updated_at
    from source_items s
   where s.parent_source_item_id is null
     and ($1::text[] is null or s.type::text = any($1::text[]))
     and ($2::text is null or f_unaccent(s.title) ilike
           '%' || replace(replace(replace(f_unaccent($2::text), '\\', '\\\\'), '%', '\\%'), '_', '\\_') || '%')
${
  topicFilter
    ? `
     and ($5::uuid is null or s.id in (select id from topic_primary_sources))`
    : ""
}
)`;

/** The reason that holds a source's work for a person, or null (a Gardener blocker key). */
export function attentionReasonSql(run: string, job: string, needsPerson: string): string {
  return `(case
    when ${run}.status in ('pending', 'running') and ${job}.status = 'queued'
         and ${job}.blocked_class is not null
         and (${job}.blocked_class || '.' || ${job}.blocked_reason) = any(${needsPerson}::text[])
      then ${job}.blocked_class || '.' || ${job}.blocked_reason
    when ${run}.status = 'succeeded'
         and ${run}.stages_checkpoint #>> '{atomicNotes,metadata,configured}' = 'false'
      then 'no_model.no_route'
  end)`;
}

/**
 * Per source of the CTE `subject` (with an `id`), the CTEs `<name>_tree`, `<name>_members` and
 * `<name>_derived`: the notes of the source and of its parts, and whether a run is active or
 * failed anywhere in that tree; `reason` comes from the source's own latest run.
 *
 * `count` counts the current notes. `exists` only says whether there is one (1 or 0) and looks
 * only where the answer can matter: a member whose run is active or failed already decides the
 * status, so it is not probed. A status needs no more than that, and it is what makes deriving
 * every source of a large library affordable. The probe is a scalar subquery with a limit, so the
 * planner reads one source's notes by their index rather than hashing every note of the library
 * (an EXISTS would be turned into that hash).
 */
const derivedCtes = (name: string, subject: string, notes: "count" | "exists") => {
  const current = `n.created_from_source_item_id = t.id and ${currentNoteSql("n")}`;
  return `${name}_tree(root_id, id, depth) as (
    select id, id, 0 from ${subject}
    union all
    select t.root_id, child.id, t.depth + 1
      from ${name}_tree t
      cross join lateral (select c.id from source_items c where c.parent_source_item_id = t.id) child
     where t.depth < 6
  ),
  ${name}_members as (
    select t.root_id,
           ${
             notes === "count"
               ? `(select count(*)::int from atomic_notes n where ${current})`
               : `(case when coalesce(run.status, '') in ('pending', 'running', 'failed', 'canceled') then 0
                   else coalesce((select 1 from atomic_notes n where ${current} limit 1), 0) end)`
           } as notes,
           run.status as run_status,
           case when t.id = t.root_id then ${attentionReasonSql("run", "job", "$3")} end as reason
      from ${name}_tree t
      left join lateral (
        select r.status::text as status, r.job_id, r.stages_checkpoint
          from ingestion_runs r where r.source_item_id = t.id
         order by r.created_at desc, r.id desc limit 1) run on true
      left join jobs job on job.id = run.job_id
  ),
  ${name}_derived as materialized (
    select a.*, ${statusSql("a")} as status
      from (
        select s.id, coalesce(sum(m.notes), 0)::int as notes,
               coalesce(bool_or(m.run_status in ('pending', 'running')), false) as active,
               coalesce(bool_or(m.run_status in ('failed', 'canceled')), false) as failed,
               min(m.reason) as reason
          from ${subject} s join ${name}_members m on m.root_id = s.id
         group by s.id) a
  )`;
};

const statusSql = (d: string) => `(case
    when ${d}.reason is not null then 'needsYou'
    when ${d}.active then 'processing'
    when ${d}.failed then 'failed'
    when ${d}.notes = 0 then 'storedOnly'
    else 'ready' end)`;

const activeTree = `active as (select id from topic_trees where status = 'active')`;

/** The live topic a root source is primarily placed in, in the active tree. */
const placeLateral = (source: string) => `left join lateral (
    select p.topic_id from topic_placements p join topics pt on pt.id = p.topic_id
     where p.item_kind = 'source' and p.source_item_id = ${source} and p.rank = 0
       and pt.retired_at is null and p.tree_id = (select id from active) limit 1) place on true`;

interface RowsRow extends QueryResultRow {
  id: string;
  title: string;
  type: string;
  createdAt: string;
  updatedAt: string;
  creators: unknown;
  hasCover: boolean;
  notes: number;
  status: LibraryRowStatus;
  reason: string | null;
  placeTopicId: string | null;
  key: string | number;
  total: number;
}

/**
 * The statement for one page. A cheap sort (title, added, updated) pages the candidates first and
 * derives the status of the page's rows only. A sort by notes derives the count for every
 * candidate. A status sort or filter derives the status of every candidate (`exists`, no count)
 * and then the count of the page's rows only.
 */
export function libraryRowsStatement(
  sort: LibraryRowSort,
  dir: "asc" | "desc",
  derivedFirst: boolean,
  cursor: { key: string; id: string } | undefined,
  limit: string
): string {
  const key = sortKeys[sort];
  const cursorWhere = cursor
    ? `where (x.key, x.id) ${dir === "asc" ? ">" : "<"} (${
        key.anchor ? key.anchor(cursor.key, cursor.id) : `${cursor.key}::${key.type}`
      }, ${cursor.id}::uuid)`
    : "";
  const order = `x.key ${dir}, x.id ${dir}`;
  const paging = `${cursorWhere} order by ${order} limit ${limit}::int + 1`;
  // `$4` (the status filter) is read only when the status is derived first; naming it here gives
  // the cheap statements a type for it.
  const head = `with recursive ${activeTree}, filter_status as (select $4::text as status),
  ${topicScopeCtes("$5")}, ${topicPrimarySourcesCte()}, ${candidatesCte(true)}`;
  const tail = `select x.id, x.title, x.type, ${timestampTextSql("x.created_at")} as "createdAt",
        ${timestampTextSql("x.updated_at")} as "updatedAt",
        source.metadata #> '{descriptor,creators}' as creators,
        (exists (select 1 from document_assets a where a.source_item_id = x.id and a.role = 'cover')
          or source.metadata #>> '{descriptor,cover,assetId}' is not null) as "hasCover",
        x.notes, x.status, x.reason, place.topic_id as "placeTopicId", ${key.out("x.key")} as key, x.total
   from page x
   join source_items source on source.id = x.id
   ${placeLateral("x.id")}
  order by ${order}`;
  if (!derivedFirst)
    return `${head},
  ordered as (select c.*, ${key.sql("")} as key from candidates c),
  paged as (select x.* from ordered x ${paging}),
  ${derivedCtes("p", "paged", "count")},
  page as (
    select pg.*, d.notes, d.status, d.reason,
           (select count(*)::int from candidates) as total
      from paged pg join p_derived d on d.id = pg.id)
${tail}`;
  const filtered = (d: string) => `filtered as (
    select c.*, ${d}.notes, ${d}.status, ${d}.reason, ${key.sql(`${d}.status`)} as key
      from candidates c join a_derived ${d} on ${d}.id = c.id
     where ($4::text is null or ${d}.status = $4::text)),
  counted as (select f.*, count(*) over ()::int as total from filtered f)`;
  if (sort === "notes")
    return `${head}, ${derivedCtes("a", "candidates", "count")},
  ${filtered("d")},
  page as (select x.* from counted x ${paging})
${tail}`;
  return `${head}, ${derivedCtes("a", "candidates", "exists")},
  ${filtered("d")},
  paged as (select x.* from counted x ${paging}),
  ${derivedCtes("p", "paged", "count")},
  page as (select pg.id, pg.title, pg.type, pg.created_at, pg.updated_at, pg.key, pg.total,
                  pg.status, pg.reason, d.notes
             from paged pg join p_derived d on d.id = pg.id)
${tail}`;
}

/** A topic's chain below the tree root, root-most first, for each of the given topics. */
const pathsSql = `with recursive chain(origin, id, parent_id, role, title, depth) as (
    select t.id, t.id, t.parent_id, t.role, t.title, 0 from topics t where t.id = any($1::uuid[])
    union all
    select c.origin, p.id, p.parent_id, p.role, p.title, c.depth + 1
      from chain c join topics p on p.id = c.parent_id
     where c.depth < 12 and p.retired_at is null
  )
select c.origin as "topicId",
       jsonb_agg(jsonb_build_object('id', c.id, 'title', coalesce(c.title, '')) order by c.depth desc) as path
  from chain c where c.role <> 'root' group by c.origin`;

/** For unplaced sources: the topic holding most of their notes (primary placements), ties by id. */
const tentativeSql = `with recursive wanted(id) as (select unnest($1::uuid[])),
tree(root_id, id, depth) as (
    select id, id, 0 from wanted
    union all
    select t.root_id, child.id, t.depth + 1
      from tree t join source_items child on child.parent_source_item_id = t.id where t.depth < 6
)
select w.id as "sourceId", best.topic_id as "topicId"
  from wanted w
  cross join lateral (
    select p.topic_id
      from tree t
      join atomic_notes n on n.created_from_source_item_id = t.id and ${currentNoteSql("n")}
      join topic_placements p on p.note_id = n.id and p.item_kind = 'note' and p.rank = 0
      join topics pt on pt.id = p.topic_id and pt.retired_at is null
     where t.root_id = w.id and p.tree_id = (select id from topic_trees where status = 'active')
     group by p.topic_id order by count(*) desc, p.topic_id limit 1) best`;

/** Territories and status counts over every candidate, ignoring the facet's own filter. */
export const libraryFacetsSql = `with recursive ${activeTree}, ${topicScopeCtes("$5")},
${topicPrimarySourcesCte()}, ${candidatesCte(false)},
${derivedCtes("a", "candidates", "exists")},
typed as (
  select c.id, d.status, place.topic_id,
         ($5::uuid is null or c.id in (select id from topic_primary_sources)) as in_topic
    from candidates c join a_derived d on d.id = c.id
    ${placeLateral("c.id")}
),
up(origin, id, parent_id, role, depth) as (
    select t.id, t.id, t.parent_id, t.role, 0 from topics t
     where t.id in (select topic_id from typed where topic_id is not null)
    union all
    select u.origin, p.id, p.parent_id, p.role, u.depth + 1
      from up u join topics p on p.id = u.parent_id where u.depth < 12
),
territory as (
  select u.origin as topic_id, u.id as territory_id
    from up u join topics parent on parent.id = u.parent_id and parent.role = 'root'
)
select 'territory' as facet, tr.territory_id::text as key, coalesce(t.title, '') as title, count(*)::int as n
  from typed x left join territory tr on tr.topic_id = x.topic_id
  left join topics t on t.id = tr.territory_id
 where $4::text is null or x.status = $4::text
 group by tr.territory_id, t.title
union all
select 'status', x.status, '', count(*)::int from typed x where x.in_topic group by x.status`;

interface FacetRow extends QueryResultRow {
  facet: "territory" | "status";
  key: string | null;
  title: string;
  n: number;
}

const compareText = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);

/** Authors of a source: the creators with the role author, else every creator; up to five names. */
function authorsOf(creators: unknown): string[] {
  if (!Array.isArray(creators)) return [];
  const named = creators.flatMap((creator): Array<{ name: string; role: string }> => {
    if (typeof creator !== "object" || creator === null) return [];
    const { name, role } = creator as { name?: unknown; role?: unknown };
    return typeof name === "string" && name.trim() !== ""
      ? [{ name: name.trim(), role: typeof role === "string" ? role : "" }]
      : [];
  });
  const authors = named.filter((creator) => creator.role === "author");
  return (authors.length > 0 ? authors : named).slice(0, 5).map((creator) => creator.name);
}

// ---------------------------------------------------------------------------
// Source progress

/** A heading line found in a chunk: the section markers of the ruler. */
export interface SectionHeading {
  chunkIndex: number;
  level: number;
  title: string;
}

export interface SectionChunk {
  chunkIndex: number;
  length: number;
}

/**
 * The section ruler of a source (design record 6.2): one segment per section of the text, wide in
 * proportion to its length, with the notes found in it so far. Sections are the headings of the
 * shallowest level that appears at least twice (one title above many chapters does not make one
 * section); a source with no such heading is one section. A section starts in the chunk its
 * heading is in, so a chunk holding two section headings is attributed to the first.
 *
 * `done` / `reading` / `pending`: the knowledge-processing checkpoints do not map a call to its
 * spans (a source's notes come from one call), so `reading` is the first section after the last one
 * with notes; with no notes yet it is the first. A run that is not active reads nothing: every
 * section is `done` once the notes step is, else those up to the last with notes. At most
 * `limit` segments: neighbouring sections merge, named after the first of them.
 */
export function buildSectionRuler(input: {
  title: string;
  chunks: readonly SectionChunk[];
  headings: readonly SectionHeading[];
  /** Current notes by the index of the chunk each rests on. */
  notesByChunk: ReadonlyMap<number, number>;
  running: boolean;
  notesDone: boolean;
  limit?: number;
}): SourceProgressSection[] {
  const chunks = [...input.chunks].sort((a, b) => a.chunkIndex - b.chunkIndex);
  if (chunks.length === 0) return [];
  const counts = new Map<number, number>();
  for (const heading of input.headings)
    counts.set(heading.level, (counts.get(heading.level) ?? 0) + 1);
  const level = [...counts]
    .filter(([, n]) => n >= 2)
    .map(([value]) => value)
    .sort((a, b) => a - b)[0];
  const starts = new Map<number, string>();
  if (level !== undefined)
    for (const heading of [...input.headings].sort((a, b) => a.chunkIndex - b.chunkIndex))
      if (heading.level === level && !starts.has(heading.chunkIndex))
        starts.set(heading.chunkIndex, heading.title.replace(/[ \t]*#+[ \t]*$/u, "").trim());
  const sections: Array<{ title: string; length: number; notes: number }> = [];
  for (const chunk of chunks) {
    const heading = starts.get(chunk.chunkIndex);
    if (heading !== undefined || sections.length === 0)
      sections.push({ title: heading ?? input.title, length: 0, notes: 0 });
    const section = sections[sections.length - 1]!;
    section.length += chunk.length;
    section.notes += input.notesByChunk.get(chunk.chunkIndex) ?? 0;
  }
  let lastWithNotes = -1;
  sections.forEach((section, index) => {
    if (section.notes > 0) lastWithNotes = index;
  });
  const stateOf = (index: number): SourceProgressSection["state"] => {
    if (input.running)
      return index <= lastWithNotes ? "done" : index === lastWithNotes + 1 ? "reading" : "pending";
    return input.notesDone || index <= lastWithNotes ? "done" : "pending";
  };
  return mergeSections(
    sections.map((section, index) => ({ ...section, state: stateOf(index) })),
    input.limit ?? sourceProgressSectionLimit
  );
}

interface RulerSection {
  title: string;
  length: number;
  notes: number;
  state: SourceProgressSection["state"];
}

/** At most `limit` segments: neighbouring sections merge, named after the first of them. */
function mergeSections(sections: readonly RulerSection[], limit: number): SourceProgressSection[] {
  const group = Math.max(1, Math.ceil(sections.length / limit));
  const measured = sections.reduce((sum, section) => sum + section.length, 0);
  // Nothing is chunked yet: the sections share the ruler equally.
  const weight = (section: RulerSection) => (measured > 0 ? section.length : 1);
  const total = measured > 0 ? measured : sections.length;
  const merged: SourceProgressSection[] = [];
  for (let from = 0; from < sections.length; from += group) {
    const part = sections.slice(from, from + group);
    merged.push({
      title: part[0]!.title,
      share: part.reduce((sum, section) => sum + weight(section), 0) / total,
      notes: part.reduce((sum, section) => sum + section.notes, 0),
      state: part.every((section) => section.state === "done")
        ? "done"
        : part.some((section) => section.state === "reading")
          ? "reading"
          : "pending"
    });
  }
  return merged;
}

/** One part of a book (a direct child of the source, with its own parts) as the ruler sees it. */
export interface RulerPart {
  title: string;
  /** Characters of its passages, its own parts' included. */
  length: number;
  /** Current notes resting on it, its own parts' included. */
  notes: number;
  /** A run of it or of one of its parts is pending or running. */
  active: boolean;
  /** The latest run of it or of one of its parts failed or was canceled. */
  failed: boolean;
  hasRun: boolean;
}

/**
 * The ruler of a book whose text is in its parts (design record 6.2): one segment per part in the
 * order they were added, wide in proportion to its text. Each part has runs of its own, so its state
 * is read from them: `reading` while one is active, `done` once its runs finished without failing,
 * else `pending`.
 */
export function buildPartRuler(
  parts: readonly RulerPart[],
  limit: number = sourceProgressSectionLimit
): SourceProgressSection[] {
  return mergeSections(
    parts.map((part) => ({
      title: part.title,
      length: part.length,
      notes: part.notes,
      state: part.active ? "reading" : part.hasRun && !part.failed ? "done" : "pending"
    })),
    limit
  );
}

interface Checkpoint {
  status?: unknown;
  reason?: unknown;
}

/**
 * A step's state from its stage checkpoints (`stages_checkpoint` of the run). A stage the run was
 * admitted without, or skipped, does not apply in this mode; a stage skipped to wait for a
 * validated ranker is still to come; a missing checkpoint is pending.
 */
export function stepState(
  stages: readonly string[],
  checkpoints: Record<string, Checkpoint | undefined>,
  effectiveStages: readonly string[]
): StepState {
  const states = stages.map((stage): StepState => {
    const checkpoint = checkpoints[stage];
    const status = typeof checkpoint?.status === "string" ? checkpoint.status : undefined;
    if (status === "completed") return "done";
    if (status === "failed") return "failed";
    // A run parked for its link job is still working (F3 D24).
    if (status === "running" || status === linkingParkReason) return "running";
    if (status === "skipped")
      return checkpoint?.reason === waitingForDeciderSkipReason ? "pending" : "notApplicable";
    if (effectiveStages.length > 0 && !effectiveStages.includes(stage)) return "notApplicable";
    return "pending";
  });
  return combineStepStates(states);
}

/**
 * One state from several: any failure fails it, any work in hand is running, the ones that do not
 * apply are left out (all of them: it does not apply), and what is left is done only when each is.
 */
export function combineStepStates(states: readonly StepState[]): StepState {
  if (states.length === 0) return "pending";
  if (states.includes("failed")) return "failed";
  if (states.includes("running")) return "running";
  const applicable = states.filter((state) => state !== "notApplicable");
  if (applicable.length === 0) return "notApplicable";
  return applicable.every((state) => state === "done") ? "done" : "pending";
}

interface ProgressRow extends QueryResultRow {
  hasSource: boolean;
  runs: unknown;
  hasDocument: boolean;
  hasSummary: boolean;
  pages: number;
  chunkCount: number;
  notes: number;
  placed: number;
  connections: number;
  title: string;
  chunkLengths: unknown;
  headings: unknown;
  notesByChunk: unknown;
  parts: unknown;
}

type SourceProgressRunStatus = NonNullable<SourceProgress["run"]>["status"];

/** The latest ingestion run of the source or of one of its parts (the stages as the strip reads them). */
interface MemberRun {
  /** 0 for the source's own run. */
  depth: number;
  status: SourceProgressRunStatus;
  stage: string | null;
  startedAt: string | null;
  completedAt: string | null;
  effective: string[];
  checkpoints: Record<string, Checkpoint | undefined>;
  reason: string | null;
  paused: boolean;
}

const instantSql = (column: string) =>
  `to_char(${column} at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

/**
 * One bounded read of a source and the tree of its parts (a book's content and notes are in its
 * chapters; its own run only catalogues): the latest run of each member, the passages, the
 * current notes and, for a source with parts, one row per direct part for the ruler. `$1` the
 * source, `$2` the blocker keys that need a person.
 */
const progressSql = `with recursive src as (select s.id, s.title, s.summary from source_items s where s.id = $1::uuid),
tree(id, top_id, depth) as (
  select id, null::uuid, 0 from src
  union all
  select c.id, coalesce(t.top_id, c.id), t.depth + 1
    from tree t join source_items c on c.parent_source_item_id = t.id
   where t.depth < 6),
member_runs as (
  select t.id, t.top_id, t.depth, run.status, run.current_stage, run.started_at, run.completed_at,
         run.effective_stages, run.created_at,
         case when jsonb_typeof(run.stages_checkpoint) = 'object' then (
           select jsonb_object_agg(e.key, jsonb_build_object('status', e.value -> 'status', 'reason', e.value -> 'reason'))
             from jsonb_each(run.stages_checkpoint) e) end as checkpoints,
         ${attentionReasonSql("run", "job", "$2")} as reason,
         coalesce(job.status = 'queued' and job.blocked_class = 'paused', false) as paused
    from tree t
    cross join lateral (
      select r.status::text as status, r.current_stage, r.started_at, r.completed_at, r.effective_stages,
             r.stages_checkpoint, r.job_id, r.created_at
        from ingestion_runs r where r.source_item_id = t.id
       order by r.created_at desc, r.id desc limit 1) run
    left join jobs job on job.id = run.job_id),
docs as (
  select d.id from documents d
   where d.source_item_id in (select id from tree) and not (d.metadata ? 'supersededByDocumentId')),
chunk_rows as (
  select c.id, c.source_item_id, c.chunk_index, c.content from chunks c
   where c.source_item_id in (select id from tree) and c.document_id in (select id from docs)),
has_parts as (select exists (select 1 from tree where depth > 0) as yes),
heading_rows as (
  select c.chunk_index, length(m.h[1]) as level, m.h[2] as title
    from chunk_rows c, lateral regexp_matches(c.content, '^(#{1,6})[ \\t]+(.+)$', 'gn') with ordinality as m(h, n)
   where c.source_item_id = $1::uuid and not (select yes from has_parts)
   order by c.chunk_index, m.n limit 5000),
note_rows as (
  select n.id, n.created_from_source_item_id as source_id, n.evidence_chunk_id from atomic_notes n
   where n.created_from_source_item_id in (select id from tree) and ${currentNoteSql("n")}),
note_chunk as (
  select c.chunk_index, count(*)::int as n
    from note_rows nr join chunk_rows c on c.id = nr.evidence_chunk_id
   where c.source_item_id = $1::uuid group by c.chunk_index),
part_rows as (
  select p.id, p.title, p.created_at,
         coalesce((select sum(length(c.content)) from chunk_rows c join tree t2 on t2.id = c.source_item_id
                    where t2.top_id = p.id), 0)::bigint as length,
         (select count(*)::int from note_rows nr join tree t2 on t2.id = nr.source_id
           where t2.top_id = p.id) as notes,
         exists (select 1 from member_runs m where m.top_id = p.id and m.status in ('pending', 'running')) as active,
         exists (select 1 from member_runs m where m.top_id = p.id and m.status in ('failed', 'canceled')) as failed,
         exists (select 1 from member_runs m where m.top_id = p.id) as has_run
    from source_items p where p.id in (select top_id from tree where top_id is not null))
select exists (select 1 from src) as "hasSource", (select title from src) as title,
       (select coalesce(jsonb_agg(jsonb_build_object(
                 'depth', m.depth, 'status', m.status, 'stage', m.current_stage,
                 'startedAt', ${instantSql("m.started_at")}, 'completedAt', ${instantSql("m.completed_at")},
                 'effective', m.effective_stages, 'checkpoints', m.checkpoints,
                 'reason', m.reason, 'paused', m.paused) order by m.depth, m.created_at desc), '[]'::jsonb)
          from member_runs m) as runs,
       exists (select 1 from docs) as "hasDocument",
       coalesce((select summary is not null from src), false) as "hasSummary",
       (select count(distinct (sp.document_id, sp.page))::int from source_spans sp
         where sp.source_item_id in (select id from tree) and sp.document_id in (select id from docs)
           and sp.page is not null) as pages,
       (select count(*)::int from chunk_rows) as "chunkCount",
       (select count(*)::int from note_rows) as notes,
       (select count(*)::int from note_rows nr
         where exists (select 1 from topic_placements p
                        where p.note_id = nr.id and p.item_kind = 'note' and p.rank = 0
                          and p.tree_id = (select id from topic_trees where status = 'active'))) as placed,
       (select count(*)::int from atomic_note_relations r
         where (r.source_atomic_note_id in (select id from note_rows)
                or r.target_atomic_note_id in (select id from note_rows))
           and ${appliedNoteRelationSql("r")}) as connections,
       coalesce((select jsonb_agg(jsonb_build_array(c.chunk_index, length(c.content)) order by c.chunk_index)
                   from chunk_rows c where c.source_item_id = $1::uuid), '[]'::jsonb) as "chunkLengths",
       coalesce((select jsonb_agg(jsonb_build_array(h.chunk_index, h.level, h.title)) from heading_rows h),
                '[]'::jsonb) as headings,
       coalesce((select jsonb_agg(jsonb_build_array(n.chunk_index, n.n)) from note_chunk n),
                '[]'::jsonb) as "notesByChunk",
       coalesce((select jsonb_agg(jsonb_build_array(p.title, p.length, p.notes, p.active, p.failed, p.has_run)
                                  order by p.created_at, p.id) from part_rows p), '[]'::jsonb) as parts`;

/**
 * Notes per passage over the library's latest completed sources: the estimate's one ratio. A
 * reference is a source (a standalone one or a part of a book) whose run completed its notes with a
 * model: a run made while no model was configured finished with no notes and says nothing about a
 * yield. A book's own run only catalogues, so what it holds is not counted twice.
 * `$1` the source (and its parts, left out), `$2` how many references.
 */
const estimateSql = `with recursive self(id, depth) as (
  select $1::uuid, 0
  union all select c.id, s.depth + 1 from self s join source_items c on c.parent_source_item_id = s.id
   where s.depth < 6),
ref as (
  select s.id from source_items s
   where s.id not in (select id from self)
     and exists (select 1 from ingestion_runs r
                  where r.source_item_id = s.id and r.status = 'succeeded'
                    and r.stages_checkpoint #>> '{atomicNotes,status}' = 'completed'
                    and coalesce(r.stages_checkpoint #>> '{atomicNotes,metadata,configured}', 'true') <> 'false')
   order by s.updated_at desc, s.id limit $2::int)
select (select count(*)::int from ref) as sources,
       (select count(*)::int from chunks c join documents d on d.id = c.document_id
         where c.source_item_id in (select id from ref)
           and not (d.metadata ? 'supersededByDocumentId')) as chunks,
       (select count(*)::int from atomic_notes n
         where n.created_from_source_item_id in (select id from ref) and ${currentNoteSql("n")}) as notes`;

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);
const needsPerson = [...gardenerStatusNeedsPerson];

export function createLibraryRowsRepository(
  db: Queryable,
  options: { estimate?: Partial<typeof sourceProgressEstimate> } = {}
) {
  const estimateConfig = { ...sourceProgressEstimate, ...options.estimate };
  /** The path below the tree root of each topic, root-most first; a topic with none is absent. */
  async function paths(topicIds: readonly string[]): Promise<Map<string, LibraryPathSegment[]>> {
    const found = new Map<string, LibraryPathSegment[]>();
    if (topicIds.length === 0) return found;
    const { rows } = await db.query<{ topicId: string; path: LibraryPathSegment[] }>(pathsSql, [
      [...new Set(topicIds)]
    ]);
    for (const row of rows) found.set(row.topicId, row.path);
    return found;
  }

  /** For each unplaced source with placed notes, the topic that holds most of them. */
  async function tentativeTopics(sourceIds: readonly string[]): Promise<Map<string, string>> {
    const { rows } = await db.query<{ sourceId: string; topicId: string }>(tentativeSql, [
      [...sourceIds]
    ]);
    return new Map(rows.map((row) => [row.sourceId, row.topicId]));
  }

  const filterValues = (filter: LibraryRowsFilter): unknown[] => [
    filter.kinds && filter.kinds.length > 0 ? [...filter.kinds] : null,
    filter.query?.trim() ? filter.query.trim() : null,
    needsPerson,
    filter.status ?? null,
    filter.topicId ?? null
  ];

  /** The territory bar and the state chips for a filter (each ignores its own facet's filter). */
  async function facets(filter: LibraryRowsFilter): Promise<LibraryRowsFacets> {
    const { rows } = await db.query<FacetRow>(libraryFacetsSql, filterValues(filter));
    const statuses = Object.fromEntries(libraryRowStatuses.map((status) => [status, 0])) as Record<
      LibraryRowStatus,
      number
    >;
    const territories: LibraryTerritory[] = [];
    for (const row of rows) {
      if (row.facet === "status") statuses[row.key as LibraryRowStatus] = Number(row.n);
      else
        territories.push({
          topic: row.key === null ? null : { id: row.key, title: row.title },
          count: Number(row.n)
        });
    }
    territories.sort((left, right) => {
      if (left.topic === null || right.topic === null)
        return left.topic === right.topic ? 0 : left.topic === null ? 1 : -1;
      return (
        compareText(left.topic.title.toLowerCase(), right.topic.title.toLowerCase()) ||
        compareText(left.topic.id, right.topic.id)
      );
    });
    return { territories, statuses };
  }

  /**
   * About how many notes the source will have: its passages times the notes per passage of the
   * library's latest completed sources. Null while fewer than three such sources exist (an
   * unknown stays unknown).
   */
  async function estimateNotes(sourceId: string, chunks: number): Promise<number | null> {
    const { rows } = await db.query<{ sources: number; chunks: number; notes: number }>(
      estimateSql,
      [sourceId, estimateConfig.referenceSources]
    );
    const reference = rows[0];
    if (
      !reference ||
      Number(reference.sources) < estimateConfig.minReferenceSources ||
      Number(reference.chunks) === 0 ||
      Number(reference.notes) === 0
    )
      return null;
    return Math.max(1, Math.round((chunks * Number(reference.notes)) / Number(reference.chunks)));
  }

  return {
    estimateNotes,

    /**
     * One page of the library's root sources, keyset-paged on the sort key and the ID. `total`
     * counts every match; with `facets` the result also carries the territory bar and the state
     * chips. A cursor made for another sort or direction is refused
     * (`errors.common.validationFailed`).
     */
    async rows(input: LibraryRowsInput = {}): Promise<LibraryRowsResult> {
      const sort = input.sort ?? "added";
      const dir = input.dir ?? defaultDirection[sort];
      const limit = Math.min(
        Math.max(1, input.limit ?? libraryRowsLimit.default),
        libraryRowsLimit.max
      );
      const filter = input.filter ?? {};
      const cursor =
        input.cursor === undefined ? undefined : decodeLibraryRowsCursor(input.cursor, sort, dir);
      const derivedFirst = sortKeys[sort].derived || filter.status !== undefined;
      const values = filterValues(filter);
      if (cursor) values.push(cursor.key, cursor.id, limit);
      else values.push(limit);
      const statement = libraryRowsStatement(
        sort,
        dir,
        derivedFirst,
        cursor ? { key: "$6", id: "$7" } : undefined,
        cursor ? "$8" : "$6"
      );
      const result = await db.query<RowsRow>(statement, values);
      const page = result.rows.slice(0, limit);
      const unplaced = page.filter((row) => row.placeTopicId === null).map((row) => row.id);
      const tentative =
        unplaced.length > 0 ? await tentativeTopics(unplaced) : new Map<string, string>();
      const topicPaths = await paths([
        ...page.flatMap((row) => (row.placeTopicId ? [row.placeTopicId] : [])),
        ...tentative.values()
      ]);
      const rows = page.map((row): LibraryRow => {
        const topicId = row.placeTopicId ?? tentative.get(row.id) ?? null;
        const path = topicId ? topicPaths.get(topicId) : undefined;
        return {
          id: row.id,
          title: row.title,
          type: row.type,
          authors: authorsOf(row.creators),
          addedAt: row.createdAt,
          updatedAt: row.updatedAt,
          status: row.status,
          reason: row.status === "needsYou" ? row.reason : null,
          noteCount: Number(row.notes),
          place: path && path.length > 0 ? { path, tentative: row.placeTopicId === null } : null,
          hasCover: Boolean(row.hasCover)
        };
      });
      const last = page.at(-1);
      const out: LibraryRowsResult = { rows, total: Number(result.rows[0]?.total ?? 0) };
      if (result.rows.length > limit && last)
        out.next = encodeLibraryRowsCursor(sort, dir, {
          key: sortKeys[sort].type === "int" ? Number(last.key) : String(last.key),
          id: last.id
        });
      if (input.facets) out.facets = await facets(filter);
      return out;
    },

    /**
     * The generation strip's data for one source (design record 6.2): the six steps and the section
     * ruler, in one bounded read (plus one more for the estimate while the notes are being made).
     * A book is read as the tree of its parts, as the Library row is: the passages, the notes, the
     * connections and the stages of every run count, because its own run only catalogues. Null when
     * the source does not exist.
     */
    async sourceProgress(sourceId: string): Promise<SourceProgress | null> {
      const { rows } = await db.query<ProgressRow>(progressSql, [sourceId, needsPerson]);
      const row = rows[0];
      if (!row?.hasSource) return null;
      const runs = asArray(row.runs).flatMap((entry): MemberRun[] => {
        if (typeof entry !== "object" || entry === null) return [];
        const value = entry as Record<string, unknown>;
        return [
          {
            depth: Number(value.depth),
            status: value.status as SourceProgressRunStatus,
            stage: typeof value.stage === "string" ? value.stage : null,
            startedAt: typeof value.startedAt === "string" ? value.startedAt : null,
            completedAt: typeof value.completedAt === "string" ? value.completedAt : null,
            effective: asArray(value.effective).filter(
              (stage): stage is string => typeof stage === "string"
            ),
            checkpoints: (typeof value.checkpoints === "object" && value.checkpoints !== null
              ? value.checkpoints
              : {}) as Record<string, Checkpoint | undefined>,
            reason: typeof value.reason === "string" ? value.reason : null,
            paused: value.paused === true
          }
        ];
      });
      const own = runs.find((entry) => entry.depth === 0) ?? runs[0];
      const activeRun = runs.find(
        (entry) => entry.status === "pending" || entry.status === "running"
      );
      const failedRun = runs.find(
        (entry) => entry.status === "failed" || entry.status === "canceled"
      );
      // The source is as busy or as broken as the worst of its parts: the Library row says the same.
      const headline =
        activeRun && own && own.status !== "pending" && own.status !== "running"
          ? activeRun
          : !activeRun && failedRun && own && own.status !== "failed" && own.status !== "canceled"
            ? failedRun
            : own;
      const failing = failedRun ?? own;
      const started = runs
        .map((entry) => entry.startedAt)
        .filter((value): value is string => value !== null)
        .sort()[0];
      const run: SourceProgress["run"] = headline
        ? {
            status: headline.status,
            stage: headline.stage ?? "queued",
            startedAt: started ?? null,
            completedAt: activeRun ? null : headline.completedAt,
            failedStage:
              Object.entries(failing?.checkpoints ?? {}).find(
                ([, value]) => value?.status === "failed"
              )?.[0] ?? (headline.status === "failed" ? (headline.stage ?? null) : null)
          }
        : null;
      const active = activeRun !== undefined;
      const stage = (...names: string[]) => {
        const states = runs.map((entry) => stepState(names, entry.checkpoints, entry.effective));
        const combined = combineStepStates(states);
        // Some parts are done and the rest wait their turn: the work is going on.
        return combined === "pending" && active && states.includes("done") ? "running" : combined;
      };
      const notesState = stage("atomicNotes");
      const notes = Number(row.notes);
      const placed = Number(row.placed);
      const chunkCount = Number(row.chunkCount);
      const chunksState = stage("chunking", "embedding");
      const summaryState = stage("summarization");
      const steps: SourceProgress["steps"] = {
        read: {
          state: row.hasDocument ? "done" : active ? "running" : "pending",
          pages: Number(row.pages) > 0 ? Number(row.pages) : null
        },
        chunks: {
          state: chunkCount > 0 && chunksState === "pending" ? "done" : chunksState,
          indexed: chunkCount
        },
        notes: {
          state: notesState,
          soFar: notes,
          estimate:
            notesState === "done" || notesState === "notApplicable" || chunkCount === 0
              ? null
              : await estimateNotes(sourceId, chunkCount)
        },
        placed: {
          state:
            notes === 0
              ? notesState === "notApplicable"
                ? "notApplicable"
                : "pending"
              : placed >= notes
                ? "done"
                : "running",
          count: placed
        },
        summary: { state: row.hasSummary && summaryState === "pending" ? "done" : summaryState },
        relations: {
          state: stage("atomicNoteMatching", "sourceMatching"),
          count: Number(row.connections)
        }
      };
      const parts = asArray(row.parts).flatMap((entry): RulerPart[] =>
        Array.isArray(entry)
          ? [
              {
                title: String(entry[0] ?? ""),
                length: Number(entry[1]),
                notes: Number(entry[2]),
                active: entry[3] === true,
                failed: entry[4] === true,
                hasRun: entry[5] === true
              }
            ]
          : []
      );
      const notesByChunk = new Map<number, number>();
      for (const entry of asArray(row.notesByChunk))
        if (Array.isArray(entry)) notesByChunk.set(Number(entry[0]), Number(entry[1]));
      return {
        run,
        needsYou: runs.find((entry) => entry.reason !== null)?.reason ?? null,
        paused: runs.some((entry) => entry.paused),
        steps,
        sections:
          parts.length > 0
            ? buildPartRuler(parts)
            : buildSectionRuler({
                title: row.title,
                chunks: asArray(row.chunkLengths).flatMap((entry) =>
                  Array.isArray(entry)
                    ? [{ chunkIndex: Number(entry[0]), length: Number(entry[1]) }]
                    : []
                ),
                headings: asArray(row.headings).flatMap((entry) =>
                  Array.isArray(entry)
                    ? [
                        {
                          chunkIndex: Number(entry[0]),
                          level: Number(entry[1]),
                          title: String(entry[2])
                        }
                      ]
                    : []
                ),
                notesByChunk,
                running: active,
                notesDone: notesState === "done"
              })
      };
    }
  };
}

export type LibraryRowsRepository = ReturnType<typeof createLibraryRowsRepository>;
