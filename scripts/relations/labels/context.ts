/**
 * Reads what the panel pages need from a scratch PostgreSQL started on an APFS clone of a
 * measurement library (never the profile itself), in one read-only snapshot:
 *
 *   npx tsx scripts/relations/labels/context.ts library --conn <connection.json> --profile env-f \
 *     --out .cache/f3/labels/inputs/env-f-context.json [--expect-digest <sha256>]
 *   npx tsx scripts/relations/labels/context.ts evidence --conn <connection.json> --profile env-f \
 *     --library fixture --label-set .cache/f3/labels/label-set.json --out .cache/f3/labels/inputs/env-f-evidence.json
 *
 * `library` writes the notes' languages, roots and topic leaves, each root's overview (its current
 * summary, else the opening of its first chunk) and its nearest roots by the cosine of the root
 * vectors. A root's vector is the topic tree's (`weightedRootVector`: the centrality-weighted mean of
 * its current note vectors), the one source vector every library has: the corpus stores no composite
 * source vectors and golden-small lacks them on two roots.
 *
 * `evidence` writes, for every source pair of the label set, up to two excerpts per side: the chunks
 * of the closest cross-root note pairs by note-vector cosine (an exact |A| x |B| comparison, like the
 * source judge's vector evidence).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import type pg from "pg";

import { defaultTopicTreeConfig, weightedRootVector } from "@app/domain/topic-tree";

import {
  createReadOnlyClient,
  resolveEvaluationConnection
} from "../../golden/matching-evaluation-db.ts";
import { libraryNotesDigest } from "../export-note-texts.ts";
import {
  contextFormat,
  evidenceFormat,
  labelSetSchema,
  libraryNames,
  readJson,
  type Excerpt,
  type LibraryContext,
  type LibraryEvidence,
  type LibraryName
} from "./common.ts";

export const rootVectorBasis = "topic-tree-weighted-root-vector (note vectors in id order)";
/** Nearest roots kept per root. */
export const neighboursKept = 5;
/** Characters of an overview and of a chunk kept in the files (the pages show less). */
export const storedOverviewCharacters = 1_500;
export const storedChunkCharacters = 2_500;
export const excerptsPerSide = 2;

const collapse = (text: string): string => text.replace(/\s+/gu, " ").trim();
const keep = (text: string, limit: number): string => [...collapse(text)].slice(0, limit).join("");

// --- Pure parts (tested) --------------------------------------------------------------------------

export function rootsOf(
  sources: ReadonlyArray<{ id: string; parentId: string | null }>
): Map<string, string> {
  const parent = new Map(sources.map((source) => [source.id, source.parentId]));
  const roots = new Map<string, string>();
  for (const { id } of sources) {
    let current = id;
    const seen = new Set<string>();
    for (;;) {
      const up = parent.get(current);
      if (!up || !parent.has(up) || seen.has(up)) break;
      seen.add(current);
      current = up;
    }
    roots.set(id, current);
  }
  return roots;
}

export function dot(a: Float32Array, b: Float32Array): number {
  let sum = 0;
  for (let index = 0; index < a.length; index += 1) sum += a[index]! * b[index]!;
  return sum;
}

/** The `keep` most similar other roots of every root (ties by id). */
export function nearestRoots(
  vectors: ReadonlyMap<string, Float32Array>,
  keep: number
): Map<string, Array<{ id: string; cosine: number }>> {
  const ids = [...vectors.keys()].sort();
  const result = new Map<string, Array<{ id: string; cosine: number }>>();
  for (const id of ids) {
    const own = vectors.get(id)!;
    const others = ids
      .filter((other) => other !== id)
      .map((other) => ({ id: other, cosine: dot(own, vectors.get(other)!) }))
      .sort((a, b) => b.cosine - a.cosine || (a.id < b.id ? -1 : 1));
    result.set(id, others.slice(0, keep));
  }
  return result;
}

export interface EvidenceNote {
  id: string;
  chunkId: string;
  vector: Float32Array;
}

/**
 * The excerpts of a root pair: walk the cross-root note pairs from the closest and take each side's
 * chunks until both sides hold `perSide` distinct chunks.
 */
export function pickExcerptChunks(
  lo: readonly EvidenceNote[],
  hi: readonly EvidenceNote[],
  perSide = excerptsPerSide,
  /** Chunks a page already shows as a side's overview. */
  exclude: ReadonlySet<string> = new Set()
): {
  lo: Array<{ chunkId: string; noteId: string; cosine: number }>;
  hi: Array<{ chunkId: string; noteId: string; cosine: number }>;
} {
  const pairs = lo
    .flatMap((a) => hi.map((b) => ({ a, b, cosine: dot(a.vector, b.vector) })))
    .sort(
      (x, y) =>
        y.cosine - x.cosine ||
        (x.a.id < y.a.id ? -1 : x.a.id > y.a.id ? 1 : x.b.id < y.b.id ? -1 : 1)
    );
  const chosen = {
    lo: [] as Array<{ chunkId: string; noteId: string; cosine: number }>,
    hi: [] as Array<{ chunkId: string; noteId: string; cosine: number }>
  };
  const fresh = (side: Array<{ chunkId: string }>, chunkId: string) =>
    side.length < perSide &&
    !exclude.has(chunkId) &&
    !side.some((item) => item.chunkId === chunkId);
  for (const { a, b, cosine } of pairs) {
    if (fresh(chosen.lo, a.chunkId)) chosen.lo.push({ chunkId: a.chunkId, noteId: a.id, cosine });
    if (fresh(chosen.hi, b.chunkId)) chosen.hi.push({ chunkId: b.chunkId, noteId: b.id, cosine });
    if (chosen.lo.length >= perSide && chosen.hi.length >= perSide) break;
  }
  return chosen;
}

/** Where a raw offset falls in the whitespace-collapsed text (code points). */
export function collapsedOffset(raw: string, offset: number): number {
  return [...raw.slice(0, offset).replace(/\s+/gu, " ").trimStart()].length;
}

// --- Database reads -------------------------------------------------------------------------------

const currentNote = "n.status not in ('rejected','archived') and n.supersession_status = 'current'";

const parseVector = (text: string): Float32Array => Float32Array.from(JSON.parse(text) as number[]);

/** The embedding table holding the most note vectors (one space per library). */
async function noteVectorTable(client: pg.Client): Promise<string> {
  let best = { table: "embeddings_1024", rows: -1 };
  for (const dimensions of [256, 768, 1024]) {
    const table = `embeddings_${dimensions}`;
    const rows = Number(
      (
        await client.query<{ n: string }>(
          `select count(*) as n from ${table} where target_type = 'atomic_note' and strategy like 'native-v2:%'`
        )
      ).rows[0]!.n
    );
    if (rows > best.rows) best = { table, rows };
  }
  return best.table;
}

async function noteVectors(
  client: pg.Client,
  table: string,
  noteIds: readonly string[]
): Promise<Map<string, Float32Array>> {
  const rows = await client.query<{ id: string; v: string }>(
    `select target_id::text as id, embedding::text as v from ${table}
      where target_type = 'atomic_note' and strategy like 'native-v2:%' and target_id = any($1::uuid[])`,
    [noteIds]
  );
  const vectors = new Map<string, Float32Array>();
  for (const row of rows.rows) {
    if (vectors.has(row.id)) throw new Error(`Note ${row.id} has two vectors in ${table}.`);
    vectors.set(row.id, parseVector(row.v));
  }
  return vectors;
}

/** Every source's current summary, and the first chunk of every source's current document. */
async function overviewTexts(client: pg.Client): Promise<{
  summaries: Map<string, string>;
  openings: Map<string, { chunkId: string; content: string }>;
}> {
  const summaries = new Map(
    (
      await client.query<{ id: string; summary: string }>(
        `select source_item_id::text as id, summary from source_summaries where is_current
         union all
         select id::text, summary from source_items s
          where s.summary is not null
            and not exists (select 1 from source_summaries x where x.source_item_id = s.id and x.is_current)`
      )
    ).rows.map((row) => [row.id, row.summary])
  );
  const openings = new Map(
    (
      await client.query<{ id: string; chunkId: string; content: string }>(
        `select distinct on (c.source_item_id) c.source_item_id::text as id, c.id::text as "chunkId", c.content
           from chunks c join documents d on d.id = c.document_id
          where d.metadata->>'supersededByDocumentId' is null
          order by c.source_item_id, c.chunk_index, c.id`
      )
    ).rows.map((row) => [row.id, { chunkId: row.chunkId, content: row.content }])
  );
  return { summaries, openings };
}

/** A root's opening chunk: its own first chunk, else the first chunk of its first child by title. */
function openingOf(
  rootId: string,
  sources: ReadonlyArray<{ id: string; title: string }>,
  rootOf: ReadonlyMap<string, string>,
  openings: ReadonlyMap<string, { chunkId: string; content: string }>
): { chunkId: string; content: string } | undefined {
  return (
    openings.get(rootId) ??
    sources
      .filter((other) => other.id !== rootId && rootOf.get(other.id) === rootId)
      .sort((a, b) => (a.title < b.title ? -1 : a.title > b.title ? 1 : a.id < b.id ? -1 : 1))
      .map((other) => openings.get(other.id))
      .find((opening) => opening !== undefined)
  );
}

interface NoteRow {
  id: string;
  sourceItemId: string;
  language: string;
  current: boolean;
  topicId: string | null;
  topicHasChildren: boolean | null;
}

export async function readLibraryContext(
  client: pg.Client,
  profile: string
): Promise<LibraryContext> {
  const digest = await libraryNotesDigest(client);
  const sources = (
    await client.query<{ id: string; parentId: string | null; title: string; language: string }>(
      `select id::text as id, parent_source_item_id::text as "parentId", title, language
         from source_items order by id`
    )
  ).rows;
  const rootOf = rootsOf(sources);
  const tree = (
    await client.query<{ id: string }>(
      `select id::text as id from topic_trees where status = 'active'`
    )
  ).rows[0]?.id;
  const notes = (
    await client.query<NoteRow>(
      `select n.id::text as id, n.created_from_source_item_id::text as "sourceItemId", n.language,
              (${currentNote}) as current, p.topic_id::text as "topicId",
              exists (select 1 from topics c where c.parent_id = p.topic_id and c.retired_at is null)
                as "topicHasChildren"
         from atomic_notes n
         left join topic_placements p
           on p.note_id = n.id and p.item_kind = 'note' and p.role = 'primary' and p.tree_id = $1::uuid
        order by n.id`,
      [tree ?? null]
    )
  ).rows;
  const { summaries, openings } = await overviewTexts(client);

  const table = await noteVectorTable(client);
  const currentByRoot = new Map<string, string[]>();
  for (const note of notes) {
    if (!note.current) continue;
    const root = rootOf.get(note.sourceItemId);
    if (!root) throw new Error(`Note ${note.id} has no source in the library.`);
    currentByRoot.set(root, [...(currentByRoot.get(root) ?? []), note.id]);
  }
  const rootVectors = new Map<string, Float32Array>();
  const noteCounts = new Map<string, number>();
  const rootIds = [...currentByRoot.keys()].sort();
  for (let start = 0; start < rootIds.length; start += 50) {
    const batch = rootIds.slice(start, start + 50);
    const vectors = await noteVectors(
      client,
      table,
      batch.flatMap((root) => currentByRoot.get(root)!)
    );
    for (const root of batch) {
      const own = currentByRoot
        .get(root)!
        .sort()
        .flatMap((noteId) => (vectors.has(noteId) ? [vectors.get(noteId)!] : []));
      noteCounts.set(root, own.length);
      const vector = weightedRootVector(
        own,
        defaultTopicTreeConfig.items.rootVectorRefinementPasses
      );
      if (vector) rootVectors.set(root, vector);
    }
  }
  const neighbours = nearestRoots(rootVectors, neighboursKept);

  const titleOf = new Map(sources.map((source) => [source.id, source]));
  const roots = sources
    .filter((source) => rootOf.get(source.id) === source.id)
    .map((source) => {
      const summary = summaries.get(source.id);
      const opening = openingOf(source.id, sources, rootOf, openings)?.content;
      return {
        id: source.id,
        title: titleOf.get(source.id)!.title,
        language: source.language,
        notes: noteCounts.get(source.id) ?? 0,
        overview: keep(summary ?? opening ?? "", storedOverviewCharacters),
        overviewBasis: summary
          ? ("summary" as const)
          : opening
            ? ("opening" as const)
            : ("none" as const),
        neighbours: (neighbours.get(source.id) ?? []).map((item) => ({
          id: item.id,
          cosine: Number(item.cosine.toFixed(6))
        }))
      };
    });

  return {
    format: contextFormat,
    version: 1,
    profile,
    libraryDigest: digest.sha256,
    rootVectorBasis,
    sources: sources.map((source) => ({ ...source, rootId: rootOf.get(source.id)! })),
    notes: notes.map((note) => ({
      id: note.id,
      sourceItemId: note.sourceItemId,
      rootId: rootOf.get(note.sourceItemId)!,
      language: note.language,
      leafTopicId: note.topicId && note.topicHasChildren === false ? note.topicId : null
    })),
    roots
  };
}

interface ChunkNoteRow {
  id: string;
  rootSource: string;
  chunkId: string;
  content: string;
  noteStart: number | null;
  chunkStart: number | null;
}

export async function readPairEvidence(
  client: pg.Client,
  profile: string,
  pairs: ReadonlyArray<{ lo: string; hi: string }>
): Promise<LibraryEvidence> {
  const digest = await libraryNotesDigest(client);
  const sources = (
    await client.query<{ id: string; parentId: string | null; title: string }>(
      `select id::text as id, parent_source_item_id::text as "parentId", title from source_items`
    )
  ).rows;
  const rootOf = rootsOf(sources);
  const { summaries, openings } = await overviewTexts(client);
  // A root without a summary shows its opening chunk as the overview: never repeat it as an excerpt.
  const overviewChunks = new Set(
    [...new Set(pairs.flatMap((pair) => [pair.lo, pair.hi]))]
      .filter((root) => !summaries.has(root))
      .flatMap((root) => {
        const opening = openingOf(root, sources, rootOf, openings);
        return opening ? [opening.chunkId] : [];
      })
  );
  const table = await noteVectorTable(client);
  const wanted = new Set(pairs.flatMap((pair) => [pair.lo, pair.hi]));
  const rows = (
    await client.query<ChunkNoteRow>(
      `select n.id::text as id, n.created_from_source_item_id::text as "rootSource",
              n.owning_chunk_id::text as "chunkId", c.content,
              ns.start_offset as "noteStart", cs.start_offset as "chunkStart"
         from atomic_notes n
         join chunks c on c.id = n.owning_chunk_id
         join documents d on d.id = c.document_id and d.metadata->>'supersededByDocumentId' is null
         left join lateral (
           select l.source_span_id from atomic_note_source_links l
            where l.atomic_note_id = n.id and l.chunk_id = n.owning_chunk_id
            order by l.id limit 1) link on true
         left join source_spans ns on ns.id = link.source_span_id
         left join source_spans cs on cs.id = c.source_span_id
        where ${currentNote}
        order by n.id`
    )
  ).rows.filter((row) => wanted.has(rootOf.get(row.rootSource) ?? ""));
  const vectors = await noteVectors(
    client,
    table,
    rows.map((row) => row.id)
  );
  const byRoot = new Map<string, EvidenceNote[]>();
  const chunkOf = new Map<string, ChunkNoteRow>();
  const rowOfNote = new Map(rows.map((row) => [row.id, row]));
  for (const row of rows) {
    const vector = vectors.get(row.id);
    if (!vector) continue;
    const root = rootOf.get(row.rootSource)!;
    byRoot.set(root, [...(byRoot.get(root) ?? []), { id: row.id, chunkId: row.chunkId, vector }]);
    if (!chunkOf.has(row.chunkId)) chunkOf.set(row.chunkId, row);
  }
  const excerpt = (choice: { chunkId: string; noteId: string; cosine: number }): Excerpt => {
    const chunk = chunkOf.get(choice.chunkId)!;
    const note = rowOfNote.get(choice.noteId)!;
    const raw =
      note.noteStart !== null && note.chunkStart !== null ? note.noteStart - note.chunkStart : null;
    const focus =
      raw !== null && raw >= 0 && raw < chunk.content.length
        ? collapsedOffset(chunk.content, raw)
        : null;
    const text = keep(chunk.content, storedChunkCharacters);
    return {
      chunkId: choice.chunkId,
      text,
      focus: focus !== null && focus < [...text].length ? focus : null,
      noteId: choice.noteId,
      cosine: Number(choice.cosine.toFixed(6))
    };
  };
  return {
    format: evidenceFormat,
    version: 1,
    profile,
    libraryDigest: digest.sha256,
    pairs: pairs.map(({ lo, hi }) => {
      const chosen = pickExcerptChunks(
        byRoot.get(lo) ?? [],
        byRoot.get(hi) ?? [],
        excerptsPerSide,
        overviewChunks
      );
      return { lo, hi, loExcerpts: chosen.lo.map(excerpt), hiExcerpts: chosen.hi.map(excerpt) };
    })
  };
}

async function withSnapshot<T>(conn: string, read: (client: pg.Client) => Promise<T>): Promise<T> {
  const connection = await resolveEvaluationConnection(conn);
  const client = createReadOnlyClient(connection.connectionString);
  await client.connect();
  try {
    await client.query("begin transaction isolation level repeatable read read only");
    const result = await read(client);
    await client.query("commit");
    console.info(`read ${connection.description}`);
    return result;
  } finally {
    await client.end();
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value)}\n`);
  console.info(`wrote ${target}`);
}

async function main(): Promise<void> {
  const { values, positionals } = parseArgs({
    options: {
      conn: { type: "string" },
      profile: { type: "string" },
      library: { type: "string" },
      "label-set": { type: "string" },
      out: { type: "string" },
      "expect-digest": { type: "string" }
    },
    strict: true,
    allowPositionals: true
  });
  const command = positionals[0];
  if (!values.conn || !values.profile || !values.out)
    throw new Error("--conn, --profile and --out are required.");
  if (command === "library") {
    const context = await withSnapshot(values.conn, (client) =>
      readLibraryContext(client, values.profile!)
    );
    if (values["expect-digest"] && context.libraryDigest !== values["expect-digest"])
      throw new Error(`The library digest ${context.libraryDigest} is not the expected one.`);
    const overviewBases = context.roots.reduce<Record<string, number>>((counts, root) => {
      counts[root.overviewBasis] = (counts[root.overviewBasis] ?? 0) + 1;
      return counts;
    }, {});
    console.info(
      `${context.profile}: ${context.notes.length} notes, ${context.roots.length} roots ` +
        `(${context.roots.filter((root) => root.notes > 0).length} with note vectors), overviews ` +
        `${JSON.stringify(overviewBases)}, notes on a leaf ${context.notes.filter((note) => note.leafTopicId).length}`
    );
    await writeJson(values.out, context);
  } else if (command === "evidence") {
    if (!values.library || !values["label-set"])
      throw new Error("evidence needs --library and --label-set.");
    if (!(libraryNames as readonly string[]).includes(values.library))
      throw new Error(`--library must be one of ${libraryNames.join(", ")}.`);
    const labelSet = await readJson(values["label-set"], labelSetSchema, "label set");
    const pairs = labelSet.items
      .filter((item) => item.kind === "source" && item.library === (values.library as LibraryName))
      .map((item) => ({ lo: item.lo, hi: item.hi }));
    const evidence = await withSnapshot(values.conn, (client) =>
      readPairEvidence(client, values.profile!, pairs)
    );
    const thin = evidence.pairs.filter(
      (pair) => pair.loExcerpts.length < excerptsPerSide || pair.hiExcerpts.length < excerptsPerSide
    ).length;
    console.info(
      `${evidence.profile}: evidence for ${pairs.length} source pairs (${thin} with fewer than two excerpts on a side)`
    );
    await writeJson(values.out, evidence);
  } else {
    throw new Error("The command must be `library` or `evidence`.");
  }
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    // Driver errors can echo the connection string; report only a content-free summary.
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[labels/context] ${message.replace(/postgres(ql)?:\/\/\S+/giu, "postgres://***")}`
    );
    process.exitCode = 1;
  }
}
