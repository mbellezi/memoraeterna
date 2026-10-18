// The backfill of hierarchy-root composite vectors (F3 T53f; spec 3.x "Hierarchy roots", 3.20).
// Source discovery selects pairs over composite vectors, and only a chapter's embedding (or the
// root's own stage, when it ran last) writes a root's composite. A library ingested before that
// refresh, or one whose composite a later summary write deleted, holds books and papers with chapters
// and no composite of their own: discovery skips them for good. The job `relation-composite` builds
// them through the code the refresh uses (`source-composite.ts`), as low-priority background work:
// on the `relations` worker (never the heavy ingestion lane, never a topic worker), its header
// embeddings at P3 so ingestion's own (P2) go first, one job at a time, deduplicated by its key, and
// safe to run again (a node that holds its inputs is left alone; a second pass writes nothing).
//
// Topic tree (3.20, F2 D8): a composite is the fallback vector of a root that has no current note
// vectors. A backfilled composite hands its roots to PLACE (`sourcesChanged`), which re-places a
// root only when its vector moved: a root with current notes keeps its notes' vector, so it stays
// where it is. The job's result counts the roots with and without current notes, so what can move
// is known before PLACE runs.
import {
  createJobRepository,
  immediateJobDebounce,
  type JobRecord,
  type JsonObject,
  type PgPool,
  type Queryable
} from "@app/db";

import type { EmbeddingBatchGenerator } from "../embedding-stage.js";
import {
  backfillSourceComposites,
  hasCompositeBackfillWork,
  type CompositeAggregate,
  type CompositeBackfillResult,
  type CompositeHeaderEmbedder
} from "../source-composite.js";
import type { TopicChangeHooks } from "../topic-tree/topic-hooks.js";

export const compositeBackfillJobType = "relation-composite";
export const compositeBackfillDedupeKey = "relation-composite";

/** Behind the link jobs (0) and the interactive ones (1) on the `relations` worker. */
const compositeBackfillPriority = -1;

/** Written nodes whose ids the job result keeps, for the run that reads it. */
const resultIdLimit = 200;

/**
 * Queues the backfill once when a hierarchy node has no composite in the embedding space `spaceKey`
 * although all its descendants have one (`hasCompositeBackfillWork`), or makes the queued job due
 * now. While a backfill job runs no second one is queued beside it (the `relations` worker has two
 * slots, and two passes would embed the same headers twice): the running pass takes the nodes it
 * found, and the next request after it ends finds what it left. Resolves true when there is a gap
 * and a job queued, merged or running for it, false when there is nothing to build.
 *
 * The test for a gap finds the composites that are missing; one that went stale is found by the
 * pass itself. `always` queues the pass without a gap, for the caller that needs both done (the
 * re-match harness): a pass over nodes that are all current writes and embeds nothing.
 */
export async function enqueueCompositeBackfill(
  db: Queryable,
  spaceKey: string,
  options: { always?: boolean } = {}
): Promise<boolean> {
  if (!options.always && !(await hasCompositeBackfillWork(db, spaceKey))) return false;
  const running = await db.query(
    "select 1 from jobs where type = $1 and status = 'running' limit 1",
    [compositeBackfillJobType]
  );
  if (running.rows.length > 0) return true;
  await createJobRepository(db).enqueueDeduped({
    type: compositeBackfillJobType,
    lane: "light",
    dedupeKey: compositeBackfillDedupeKey,
    payload: {},
    priority: compositeBackfillPriority,
    debounce: immediateJobDebounce,
    maxAttempts: 3
  });
  return true;
}

export interface CompositeBackfillDeps {
  getPool: () => PgPool;
  /** The embedding space the route writes to now; null when no model is routed. */
  embeddingSpaceKey: () => Promise<string | null>;
  generate: EmbeddingBatchGenerator;
  aggregate: CompositeAggregate;
  topicHooks?: TopicChangeHooks | undefined;
  reportProgress?: (job: JobRecord, progress: number) => void;
  logger?: Pick<Console, "warn">;
}

/** How many of the roots a backfill wrote can move in the topic tree, and how many cannot. */
export interface CompositeBackfillPlacement {
  /** Root sources of the written nodes. */
  roots: number;
  /** Of those, roots with current notes: PLACE keeps their vector, so they stay where they are. */
  withCurrentNotes: number;
}

/** Runs one backfill pass for the space the route writes to now. */
export async function runCompositeBackfill(
  deps: CompositeBackfillDeps,
  job: JobRecord,
  signal: AbortSignal
): Promise<JsonObject> {
  const spaceKey = await deps.embeddingSpaceKey();
  if (!spaceKey) return { skipped: "no_embedding_space" };
  const pool = deps.getPool();
  const embed: CompositeHeaderEmbedder = async (text, context) => {
    const generated = await deps.generate([text], signal, {
      jobId: job.id,
      sourceItemId: context.sourceItemId,
      stage: "source_embedding",
      embeddingInputType: "document",
      priority: "P3"
    });
    const embedding = generated?.embeddings[0];
    if (!generated || !embedding) return null;
    return {
      embedding,
      provider: generated.provider,
      model: generated.model,
      runtime: generated.runtime,
      ...(generated.spaceKey ? { spaceKey: generated.spaceKey } : {})
    };
  };
  const result = await backfillSourceComposites({
    pool,
    spaceKey,
    embed,
    aggregate: deps.aggregate,
    signal,
    onProgress: (done, total) => deps.reportProgress?.(job, total === 0 ? 1 : done / total),
    warn: (error) => deps.logger?.warn(error instanceof Error ? error.message : String(error))
  });
  // A pass that built nothing because every attempt failed fails the job, so a transient error
  // (a provider that timed out) is retried with backoff and a deterministic one shows in the jobs
  // view with its real error. A pass that built some keeps them and reports the rest.
  if (result.written.length === 0 && result.firstError !== undefined) throw result.firstError;
  if (result.written.length > 0) {
    // The composite is the fallback vector of a root without notes: PLACE re-places only those.
    try {
      await deps.topicHooks?.sourcesChanged(result.written);
    } catch (error) {
      deps.logger?.warn(error instanceof Error ? error.message : String(error));
    }
  }
  return backfillJobResult(spaceKey, result, await placementOf(pool, result.written));
}

function backfillJobResult(
  spaceKey: string,
  result: CompositeBackfillResult,
  placement: CompositeBackfillPlacement
): JsonObject {
  return {
    spaceKey,
    examined: result.examined,
    written: result.written.length,
    rebuilt: result.rebuilt,
    current: result.current,
    incomplete: result.incomplete,
    failed: result.failed.length,
    ...(result.failed.length > 0 ? { failures: result.failed.slice(0, 10) } : {}),
    ...(result.stopped ? { stopped: result.stopped } : {}),
    roots: placement.roots,
    rootsWithCurrentNotes: placement.withCurrentNotes,
    writtenIds: result.written.slice(0, resultIdLimit)
  };
}

/** A root source with its primary placement in the active topic tree (null: it has none). */
export interface BackfillRoot {
  rootId: string;
  title: string;
  /** Current notes (not rejected, not archived, not superseded): the topic tree takes the root's vector from them. */
  hasCurrentNotes: boolean;
  placement: { topicId: string; needsVector: boolean } | null;
}

/**
 * The root sources of the library, or only the roots of the sources in `rootsOf`, with whether they
 * have current notes and where the active topic tree placed them. A root with current notes keeps
 * its notes' vector whatever its composite becomes (F2 D8), so PLACE does not move it.
 */
export async function readBackfillRoots(
  db: Queryable,
  rootsOf?: readonly string[]
): Promise<BackfillRoot[]> {
  const rows = await db.query<{
    rootId: string;
    title: string;
    hasNotes: boolean;
    topicId: string | null;
    needsVector: boolean | null;
  }>(
    `with recursive up(id, parent_id) as (
       select s.id, s.parent_source_item_id from source_items s
        where $1::uuid[] is not null and s.id = any($1::uuid[])
       union all
       select p.id, p.parent_source_item_id from up join source_items p on p.id = up.parent_id
     ), roots as (
       select id from source_items where parent_source_item_id is null and $1::uuid[] is null
       union
       select id from up where parent_id is null
     ), tree(root_id, id) as (
       select id, id from roots
       union all
       select tree.root_id, c.id from tree join source_items c on c.parent_source_item_id = tree.id
     )
     select r.id as "rootId", s.title,
            exists (select 1 from tree t join atomic_notes n on n.created_from_source_item_id = t.id
                     where t.root_id = r.id and n.status not in ('rejected', 'archived')
                       and n.supersession_status = 'current') as "hasNotes",
            p.topic_id as "topicId", p.needs_vector as "needsVector"
       from roots r
       join source_items s on s.id = r.id
       left join topic_trees tt on tt.status = 'active'
       left join topic_placements p on p.tree_id = tt.id and p.item_kind = 'source'
            and p.source_item_id = r.id and p.rank = 0
      order by s.title, r.id`,
    [rootsOf ? [...rootsOf] : null]
  );
  return rows.rows.map((row) => ({
    rootId: row.rootId,
    title: row.title,
    hasCurrentNotes: row.hasNotes,
    placement: row.topicId ? { topicId: row.topicId, needsVector: row.needsVector === true } : null
  }));
}

/** The root sources of the written nodes, and how many of them have current notes. */
export async function placementOf(
  db: Queryable,
  writtenIds: readonly string[]
): Promise<CompositeBackfillPlacement> {
  if (writtenIds.length === 0) return { roots: 0, withCurrentNotes: 0 };
  const roots = await readBackfillRoots(db, writtenIds);
  return {
    roots: roots.length,
    withCurrentNotes: roots.filter((root) => root.hasCurrentNotes).length
  };
}
