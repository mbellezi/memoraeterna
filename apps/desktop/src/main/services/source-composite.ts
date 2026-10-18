import { createHash } from "node:crypto";

import { chunkMarkdown } from "@app/conversion";
import {
  createEmbeddingRepository,
  createHierarchicalIngestionRepository,
  createSourceItemRepository,
  type PgPool,
  type Queryable,
  type SourceItemRecord
} from "@app/db";
import type { QueryResultRow } from "pg";

import { buildCatalogMetadataMarkdown } from "./hierarchical-ingestion-service.js";

/** Storage identity of a composite vector in an embedding space (`source_item` targets). */
const compositePrefix = "source-composite-centroid-v2:";

/** The strategy a composite carries in the embedding space `spaceKey` names. */
export const compositeStrategy = (spaceKey: string): string => `${compositePrefix}${spaceKey}`;

export interface CompositeEmbedding {
  embedding: number[];
  provider: string;
  model: string;
  runtime: string;
  spaceKey?: string;
}

/**
 * Embeds one header segment in the space of the source's vectors; null when nothing embeds. The
 * context names the source the header belongs to, for the audit of the call.
 */
export type CompositeHeaderEmbedder = (
  text: string,
  context: { sourceItemId: string }
) => Promise<CompositeEmbedding | null>;

/** The embedding stage's aggregation (header 0.35, content 0.65, normalized). */
export type CompositeAggregate = (
  headerVectors: number[][],
  contentVectors: number[][]
) => number[] | null;

/**
 * Recomputes the composite vectors of a source's ancestors once the source's own composite is
 * written (F3 D27, design E discovery): a book whose root ran before its chapters had vectors kept a
 * null composite and was never discovered. An ancestor's composite is built, as its own embedding
 * stage builds it, from its catalog header and its descendants' composites in the same space, once
 * every descendant has one (the stage's own rule): its header is embedded once per composite, not
 * once per chapter, so a recorded library replays (the root's stage embeds no header it would not
 * use, `hierarchyRootComposite`). An ancestor whose stored composite already holds exactly these
 * inputs is left alone (no call). Resolves to the ancestors written, nearest first.
 *
 * It builds as soon as the last descendant has its composite, even when the batch's aggregate
 * summaries are still to be written: the root's discovery runs when its last record has linked and
 * needs the root's vector then, and a catalog run never queues a link job to plan it again; waiting
 * for the summaries would add a batch barrier to matching (rules/knowledge.md has none). A summary
 * written into the root afterwards deletes this composite (`sourceItemRepository.update`) and the
 * root's own stage builds it again with the summary: the pre-summary composite is the price of
 * discovery needing a vector before the barrier. A header chunk that was built before the summary
 * is followed by the catalog-header job (plan decision 27, `catalog-header-refresh.ts`), which
 * rebuilds the chunk and this composite from one embedding of the header.
 *
 * With `warn`, a failure (an embedding error, a replay miss) is reported and resolves to what was
 * written: the source's own vectors are in place, so its stage does not fail for an ancestor, whose
 * composite is left to a later descendant or its own stage. A cancellation is always thrown.
 */
export async function refreshAncestorComposites(input: {
  pool: PgPool;
  sourceItemId: string;
  embed: CompositeHeaderEmbedder | null;
  aggregate: CompositeAggregate;
  signal?: AbortSignal;
  warn?: (error: unknown) => void;
}): Promise<string[]> {
  const written: string[] = [];
  try {
    await refreshAncestors(input, written);
  } catch (error) {
    if (input.signal?.aborted || !input.warn) throw error;
    input.warn(error);
  }
  return written;
}

async function refreshAncestors(
  input: Parameters<typeof refreshAncestorComposites>[0],
  written: string[]
): Promise<void> {
  const { pool } = input;
  if (!input.embed) return;
  const own = await newestComposite(pool, input.sourceItemId);
  if (!own) return;
  const ancestors = (
    await pool.query<{ id: string } & QueryResultRow>(
      `with recursive up as (
         select parent_source_item_id as id, 1 as depth from source_items where id = $1
         union all select s.parent_source_item_id, up.depth + 1 from source_items s join up on s.id = up.id
       ) select id from up where id is not null order by depth`,
      [input.sourceItemId]
    )
  ).rows.map((row) => row.id);
  for (const ancestorId of ancestors) {
    const ancestor = await createSourceItemRepository(pool).findById(ancestorId);
    if (!ancestor) break;
    const rebuilt = await rebuildComposite({
      pool,
      node: ancestor,
      space: own,
      embed: input.embed,
      aggregate: input.aggregate
    });
    // A descendant without a composite: the last one to embed builds it (and every farther
    // ancestor counts that descendant too). A header that cannot be embedded in the space ends it.
    if (rebuilt.outcome === "written") written.push(ancestorId);
    else if (rebuilt.outcome !== "current") break;
  }
}

/** The composite space of a source: its model, vector dimensions and storage strategy. */
export interface CompositeSpace {
  model: string;
  dimensions: 256 | 768 | 1024;
  strategy: string;
}

/** A composite space with the provider and runtime a new composite of it is stored with. */
interface StoredCompositeSpace extends CompositeSpace {
  provider: string;
  runtime: string;
}

/** What `rebuildComposite` did with one node. */
export type CompositeRebuild =
  | { outcome: "written"; /** A composite was there (stale) and was replaced. */ replaced: boolean }
  | {
      outcome: "current" | "incomplete" | "no_embedding" | "space_changed" | "no_vector";
    };

/**
 * Builds or rebuilds one hierarchy node's composite in `space`, as its embedding stage builds it:
 * from its catalog header and its descendants' composites, once every descendant has one, and only
 * when the stored composite does not already hold exactly these inputs.
 */
async function rebuildComposite(input: {
  pool: PgPool;
  node: SourceItemRecord;
  space: StoredCompositeSpace;
  descendantIds?: string[];
  embed: CompositeHeaderEmbedder;
  aggregate: CompositeAggregate;
}): Promise<CompositeRebuild> {
  const { pool, node, space } = input;
  const inputs = await compositeInputs(
    pool,
    node.id,
    buildCatalogMetadataMarkdown(node),
    space,
    input.descendantIds
  );
  if (inputs.state === "incomplete") return { outcome: "incomplete" };
  if (inputs.state !== "stale") return { outcome: "current" };
  const { header, children, contentHash } = inputs;
  const headerVectors: number[][] = [];
  for (const segment of chunkMarkdown(header).map((chunk) => chunk.content)) {
    const generated = await input.embed(segment, { sourceItemId: node.id });
    if (!generated) return { outcome: "no_embedding" };
    // A header embedded in another space would mix spaces: the composite waits for a match.
    if (compositeStrategy(generated.spaceKey ?? "") !== space.strategy)
      return { outcome: "space_changed" };
    headerVectors.push(generated.embedding);
  }
  const composite = input.aggregate(
    headerVectors,
    children.map((child) => child.embedding)
  );
  if (!composite) return { outcome: "no_vector" };
  const embeddings = createEmbeddingRepository(pool);
  const replaced = await storesComposite(pool, node.id, space.strategy);
  await embeddings.upsert({
    targetType: "source_item",
    targetId: node.id,
    provider: space.provider,
    model: space.model,
    runtime: space.runtime,
    strategy: space.strategy,
    contentHash,
    embedding: composite
  });
  return { outcome: "written", replaced };
}

/**
 * What the embedding stage of a hierarchy root does with its composite (F3 D27): `none`, the source
 * has no descendants (its composite is its own); `incomplete`, a descendant has no composite in
 * the space yet, so the last descendant to embed builds it (`refreshAncestorComposites`) and the
 * stage embeds no header; `current`, the stored composite already holds this header and every
 * descendant's composite (a descendant built it), so no header is embedded again; `stale`, the
 * stage builds it.
 */
export async function hierarchyRootComposite(input: {
  pool: PgPool;
  sourceItemId: string;
  header: string;
  space: CompositeSpace;
}): Promise<"none" | "incomplete" | "current" | "stale"> {
  return (await compositeInputs(input.pool, input.sourceItemId, input.header, input.space)).state;
}

/** An ancestor's composite inputs, read and hashed as its embedding stage reads and hashes them. */
async function compositeInputs(
  pool: PgPool,
  sourceItemId: string,
  header: string,
  space: CompositeSpace,
  descendantIds?: string[]
) {
  const embeddings = createEmbeddingRepository(pool);
  const descendants =
    descendantIds ??
    (await createHierarchicalIngestionRepository(pool).listDescendants(sourceItemId)).map(
      (descendant) => descendant.id
    );
  const children = await embeddings.listSourceEmbeddings(
    descendants,
    space.model,
    space.dimensions,
    space.strategy
  );
  const fingerprint = createHash("sha256").update(header);
  for (const child of children) fingerprint.update(child.embedding.join(","));
  const contentHash = fingerprint.digest("hex");
  const state: "none" | "incomplete" | "current" | "stale" = !descendants.length
    ? "none"
    : new Set(children.map((child) => child.targetId)).size < descendants.length
      ? "incomplete"
      : (await embeddings.hasContentHash("source_item", sourceItemId, contentHash, space.strategy))
        ? "current"
        : "stale";
  return { state, header, children, contentHash };
}

async function newestComposite(pool: PgPool, sourceItemId: string) {
  let newest: (StoredCompositeSpace & { createdAt: number }) | null = null;
  for (const dimensions of [256, 768, 1024] as const) {
    const row = (
      await pool.query<
        {
          strategy: string;
          model: string;
          provider: string;
          runtime: string;
          createdAt: Date;
        } & QueryResultRow
      >(
        `select strategy, model, provider, runtime, created_at as "createdAt" from embeddings_${dimensions}
          where target_type = 'source_item' and target_id = $1 and strategy like '${compositePrefix}%'
          order by created_at desc limit 1`,
        [sourceItemId]
      )
    ).rows[0];
    if (!row) continue;
    const createdAt = new Date(row.createdAt).getTime();
    if (!newest || createdAt > newest.createdAt) newest = { dimensions, ...row, createdAt };
  }
  return newest;
}

/** Whether the source stores a composite of the strategy, whatever it was built from. */
async function storesComposite(
  pool: PgPool,
  sourceItemId: string,
  strategy: string
): Promise<boolean> {
  for (const dimensions of [256, 768, 1024] as const) {
    const found = await pool.query(
      `select 1 from embeddings_${dimensions}
        where target_type = 'source_item' and target_id = $1 and strategy = $2 limit 1`,
      [sourceItemId, strategy]
    );
    if (found.rows.length) return true;
  }
  return false;
}

// --- the backfill of composites that were never built -----------------------------------------------

/**
 * SQL for the sources with descendants, with the composites of the strategy `$1` (any dimension):
 * `closure` pairs every source with each of its descendants and their distance, `composites` lists
 * the sources that have a composite, and `busy` the sources an ingestion run is still working on
 * (pending or running, a parked run included): a node with one in its tree is an import in
 * progress, whose own stages build the composite. A guard of 64 levels stops a malformed cycle.
 */
const compositeClosureSql = `
  with recursive closure(ancestor_id, descendant_id, distance) as (
    select parent_source_item_id, id, 1 from source_items where parent_source_item_id is not null
    union all
    select c.ancestor_id, s.id, c.distance + 1
      from closure c join source_items s on s.parent_source_item_id = c.descendant_id
     where c.distance < 64
  ), composites as (
    select target_id from embeddings_256 where target_type = 'source_item' and strategy = $1
    union all
    select target_id from embeddings_768 where target_type = 'source_item' and strategy = $1
    union all
    select target_id from embeddings_1024 where target_type = 'source_item' and strategy = $1
  ), busy as (
    select distinct source_item_id as id from ingestion_runs
     where status in ('pending', 'running') and source_item_id is not null
  )`;

/**
 * Whether a hierarchy node has no composite in the embedding space `spaceKey` although every one of
 * its descendants has one: a composite the node's own stage or a chapter's refresh should have
 * built and did not (a library embedded before design E, a summary written after the build). It is
 * the cheap test that decides whether `backfillSourceComposites` has anything to do for certain; a
 * node whose composite is stale instead is found by the pass itself. A node with a descendant that
 * has no composite waits for that descendant, and a node with an ingestion run still working in its
 * tree waits for that import (its stages build the composite, with the summary the import writes):
 * neither is counted.
 */
export async function hasCompositeBackfillWork(
  pool: Queryable,
  spaceKey: string
): Promise<boolean> {
  return (await countCompositeBackfillWork(pool, spaceKey, 1)) > 0;
}

/** How many nodes `hasCompositeBackfillWork` counts, at most `limit` of them when it is given. */
export async function countCompositeBackfillWork(
  pool: Queryable,
  spaceKey: string,
  limit?: number
): Promise<number> {
  const found = await pool.query<{ count: number } & QueryResultRow>(
    `${compositeClosureSql}
     select count(*)::int as count from (
       select 1
         from (select distinct ancestor_id from closure) node
        where not exists (select 1 from composites k where k.target_id = node.ancestor_id)
          and not exists (
            select 1 from closure c
             where c.ancestor_id = node.ancestor_id
               and not exists (select 1 from composites k where k.target_id = c.descendant_id))
          and not exists (select 1 from busy b where b.id = node.ancestor_id)
          and not exists (
            select 1 from closure c join busy b on b.id = c.descendant_id
             where c.ancestor_id = node.ancestor_id)
        limit $2::int
     ) gaps`,
    [compositeStrategy(spaceKey), limit ?? null]
  );
  return found.rows[0]?.count ?? 0;
}

/** Where a paged pass stopped: the last node done, in the order the pass walks them. */
export interface BackfillCursor {
  /** The longest distance from the node to a descendant: leaves first. */
  depth: number;
  id: string;
}

interface BackfillNode extends BackfillCursor {
  /** An ingestion run is still working on the node or one of its descendants. */
  busy: boolean;
}

/**
 * The hierarchy nodes with a descendant composite in the strategy, the nearest to the leaves
 * first, after the node `after` names when it is given.
 */
async function listBackfillNodes(
  pool: PgPool,
  strategy: string,
  after: BackfillCursor | null
): Promise<BackfillNode[]> {
  const nodes = await pool.query<BackfillNode & QueryResultRow>(
    `${compositeClosureSql}
     select c.ancestor_id as id, max(c.distance)::int as depth,
            (bool_or(b.id is not null)
              or exists (select 1 from busy x where x.id = c.ancestor_id)) as busy
       from closure c
       left join composites k on k.target_id = c.descendant_id
       left join busy b on b.id = c.descendant_id
      group by c.ancestor_id
     having bool_or(k.target_id is not null)
        and ($2::int is null or (max(c.distance), c.ancestor_id) > ($2::int, $3::uuid))
      order by max(c.distance), c.ancestor_id`,
    [strategy, after?.depth ?? null, after?.id ?? null]
  );
  return nodes.rows.map((row) => ({ id: row.id, depth: row.depth, busy: row.busy }));
}

/** The space of the newest composite among the descendants (the provider, model and runtime). */
async function descendantCompositeSpace(
  pool: PgPool,
  descendantIds: readonly string[],
  strategy: string
): Promise<StoredCompositeSpace | null> {
  let newest: (StoredCompositeSpace & { createdAt: number }) | null = null;
  for (const dimensions of [256, 768, 1024] as const) {
    const row = (
      await pool.query<
        { model: string; provider: string; runtime: string; createdAt: Date } & QueryResultRow
      >(
        `select model, provider, runtime, created_at as "createdAt" from embeddings_${dimensions}
          where target_type = 'source_item' and target_id = any($1::uuid[]) and strategy = $2
          order by created_at desc limit 1`,
        [[...descendantIds], strategy]
      )
    ).rows[0];
    if (!row) continue;
    const createdAt = new Date(row.createdAt).getTime();
    if (!newest || createdAt > newest.createdAt)
      newest = {
        dimensions,
        strategy,
        model: row.model,
        provider: row.provider,
        runtime: row.runtime,
        createdAt
      };
  }
  return newest;
}

/**
 * Builds or rebuilds the composite of one hierarchy node in the embedding space `spaceKey`, in the
 * space its descendants' composites are in (the newest one's provider, model and runtime), through
 * `rebuildComposite`: the backfill's step for a node, and the follow of a node whose header changed.
 * A node none of whose descendants has a composite yet is `incomplete`; one that holds its inputs
 * is `current` (no call).
 */
export async function refreshNodeComposite(input: {
  pool: PgPool;
  node: SourceItemRecord;
  spaceKey: string;
  embed: CompositeHeaderEmbedder;
  aggregate: CompositeAggregate;
}): Promise<CompositeRebuild> {
  const descendantIds = (
    await createHierarchicalIngestionRepository(input.pool).listDescendants(input.node.id)
  ).map((entry) => entry.id);
  const space = await descendantCompositeSpace(
    input.pool,
    descendantIds,
    compositeStrategy(input.spaceKey)
  );
  if (!space) return { outcome: "incomplete" };
  return rebuildComposite({
    pool: input.pool,
    node: input.node,
    space,
    descendantIds,
    embed: input.embed,
    aggregate: input.aggregate
  });
}

/** What a backfill pass found and did. */
export interface CompositeBackfillResult {
  /** The hierarchy nodes with a descendant composite in the space, after the page's start. */
  examined: number;
  /** Nodes whose composite was built (it had none) or rebuilt (it was stale), leaves first. */
  written: string[];
  /** Of `written`, the nodes that had a stale composite. */
  rebuilt: number;
  /** Nodes whose stored composite already holds their header and every descendant's composite. */
  current: number;
  /**
   * Nodes that wait for the import that builds them: a descendant has no composite yet (the last
   * descendant to embed builds it), or an ingestion run is still working in their tree.
   */
  incomplete: number;
  /** Nodes whose composite could not be built, with the reason; the pass went on with the rest. */
  failed: Array<{ sourceItemId: string; message: string }>;
  /** Why the pass ended before the last node: no embedding model is routed, or the space moved. */
  stopped: "no_embedding" | "space_changed" | null;
  /** The first error that failed a node, as thrown: a pass that wrote nothing can throw it again. */
  firstError?: unknown;
  /** Where the next page starts when this one ended at its limit with nodes left; null when done. */
  next: BackfillCursor | null;
}

/**
 * Builds the composite of every hierarchy node whose composite is missing or stale while its
 * descendants have theirs (F3 D27, 3.x "Hierarchy roots"), in the embedding space `spaceKey`: the
 * libraries ingested before a chapter's embedding refreshed its ancestors hold books and papers
 * whose root has no composite, which discovery never selects. Each node is rebuilt through the
 * code the chapters' refresh and the root's own stage use (`rebuildComposite`), nearest to the
 * leaves first, so a part's composite exists before its book's. A node whose composite already
 * holds its header and descendants is not touched (no call), so a second pass writes nothing; a
 * node with a descendant that has no composite, or with an ingestion run still working in its tree,
 * waits for that import. A node that fails is reported and the pass goes on; a cancellation is
 * always thrown.
 *
 * With `limits` the pass is paged: it ends after that many nodes looked at or composites written
 * and says where the next page starts (`next`), so the job that runs it gives its worker slot back
 * between pages and the link jobs waiting behind it go first.
 */
export async function backfillSourceComposites(input: {
  pool: PgPool;
  spaceKey: string;
  embed: CompositeHeaderEmbedder;
  aggregate: CompositeAggregate;
  signal?: AbortSignal;
  /** Start after this node: the `next` of the previous page. */
  after?: BackfillCursor | null;
  limits?: { nodes: number; writes: number };
  /** After each node: how many are done of how many. */
  onProgress?: (done: number, total: number) => void;
  warn?: (error: unknown, sourceItemId: string) => void;
}): Promise<CompositeBackfillResult> {
  const { pool } = input;
  const strategy = compositeStrategy(input.spaceKey);
  const nodes = await listBackfillNodes(pool, strategy, input.after ?? null);
  const result: CompositeBackfillResult = {
    examined: nodes.length,
    written: [],
    rebuilt: 0,
    current: 0,
    incomplete: 0,
    failed: [],
    stopped: null,
    next: null
  };
  const sources = createSourceItemRepository(pool);
  for (const [index, listed] of nodes.entries()) {
    input.signal?.throwIfAborted();
    const nodeId = listed.id;
    try {
      // The import's own stages build a node it is still working on (with the summary it writes).
      const node = listed.busy ? null : await sources.findById(nodeId);
      if (listed.busy) result.incomplete += 1;
      else if (node) {
        const rebuilt = await refreshNodeComposite({
          pool,
          node,
          spaceKey: input.spaceKey,
          embed: input.embed,
          aggregate: input.aggregate
        });
        if (rebuilt.outcome === "written") {
          result.written.push(nodeId);
          if (rebuilt.replaced) result.rebuilt += 1;
        } else if (rebuilt.outcome === "current") result.current += 1;
        else if (rebuilt.outcome === "incomplete") result.incomplete += 1;
        else if (rebuilt.outcome === "no_vector")
          result.failed.push({ sourceItemId: nodeId, message: "no_vector" });
        else {
          result.stopped = rebuilt.outcome;
          break;
        }
      }
    } catch (error) {
      if (input.signal?.aborted) throw error;
      result.failed.push({
        sourceItemId: nodeId,
        message: (error instanceof Error ? error.message : String(error)).slice(0, 300)
      });
      if (result.firstError === undefined) result.firstError = error;
      input.warn?.(error, nodeId);
    }
    input.onProgress?.(index + 1, nodes.length);
    const pageFull =
      input.limits !== undefined &&
      (index + 1 >= input.limits.nodes || result.written.length >= input.limits.writes);
    if (pageFull && index + 1 < nodes.length) {
      result.next = { depth: listed.depth, id: nodeId };
      break;
    }
  }
  return result;
}
