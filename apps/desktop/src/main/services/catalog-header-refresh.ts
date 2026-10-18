// A hierarchy root's header follows its summary (plan decision 27, F3 T53h).
//
// A book's catalog header (chunk 0 of its catalog document, `buildCatalogMetadataMarkdown`) carries
// the book's AI summary. The summary is written by the job that passes the batch's summarization
// barrier, and the header by the book's own catalog run: in a one-batch import the run comes last
// and the header has the summary, but a library built with each source paced on its own (or a run
// that went first) holds headers built without a summary that exists. This job rebuilds such a
// header chunk, embeds it again, extracts its knowledge graph again (the old chunk's mentions go
// with the chunk, and the extraction replaces the source's rows) and builds the root's composite
// from the same header, all through the code the ingestion stages use:
// `embedChunkVectors`, `generateCatalogKnowledgeGraph` and `refreshNodeComposite`.
//
// It is background work of the `relations` worker, behind the link jobs, with its embeddings and its
// graph call at P3, and it never touches a root whose import is still running (that run builds the
// header with the summary it finds). The work to do is read from the data, so it is idempotent: a
// header that carries its summary is left alone and a second pass makes no call; the same scan
// serves a summary written late and the first start of a library built before this existed. A pass
// is paged, one root at a time (an embedding and a graph call each), and a chunk it replaced owes
// its embedding and its graph in its own metadata until they are done, so a failure or a restart
// resumes the root instead of leaving a header without them.
import {
  createChunkRepository,
  createEmbeddingRepository,
  createJobRepository,
  createSourceItemRepository,
  immediateJobDebounce,
  type ChunkRecord,
  type JobRecord,
  type JsonObject,
  type PgPool,
  type Queryable
} from "@app/db";
import { z } from "zod";

import {
  embedChunkVectors,
  type EmbeddingBatchGenerator,
  type EmbeddingIdentity
} from "./embedding-stage.js";
import { buildCatalogMetadataMarkdown } from "./hierarchical-ingestion-service.js";
import { isTransientJobFailure } from "./job-failure.js";
import type { KnowledgeService } from "./knowledge-service.js";
import { renderPrompt } from "./prompt-runtime.js";
import { compositeHeaderEmbedder } from "./relations/composite-backfill.js";
import {
  refreshNodeComposite,
  type CompositeAggregate,
  type CompositeEmbedding,
  type CompositeHeaderEmbedder
} from "./source-composite.js";
import type { TopicChangeHooks } from "./topic-tree/topic-hooks.js";

export const catalogHeaderJobType = "catalog-header";
export const catalogHeaderDedupeKey = "catalog-header";

/** Behind the link jobs (0) and the interactive ones (1) on the `relations` worker, as the composite backfill. */
const catalogHeaderPriority = -1;

/** Roots whose ids the job keeps in its result. */
const resultIdLimit = 1_000;

type Owed = "embedding" | "graph";

/** A hierarchy root whose catalog header chunk is out of date with its summary, or unfinished. */
export interface StaleCatalogHeader {
  rootId: string;
  title: string;
  documentId: string;
  chunkId: string;
  /** The header the root has now: the chunk is rebuilt to it. */
  header: string;
  /** The chunk lacks the summary the root has (or carries another one). */
  outdated: boolean;
  /** What the chunk still owes from an earlier refresh that replaced it and did not finish. */
  owes: Owed[];
  /** An ingestion run of the root is still working: that import builds the header itself. */
  busy: boolean;
}

/**
 * Whether a header text carries a summary: as the text, or escaped as the JSON string the header
 * renders it in. Freshness rests on this and on nothing else about the header, so a new revision of
 * the header prompt or a change to the header rule never rebuilds a library (rules/ai.md).
 */
export function carriesSummary(text: string, summary: string): boolean {
  const wanted = summary.trim();
  return wanted.length === 0 || text.includes(wanted) || text.includes(escapedJson(wanted));
}

function escapedJson(text: string): string {
  return JSON.stringify(text).slice(1, -1);
}

interface CandidateRow {
  rootId: string;
  type: string;
  title: string;
  subtitle: string | null;
  sourceUri: string | null;
  language: string;
  summary: string | null;
  metadata: Record<string, unknown> | null;
  documentId: string;
  chunkId: string;
  chunkContent: string;
  chunkMetadata: Record<string, unknown> | null;
  busy: boolean;
}

const owedSchema = z.object({ owes: z.array(z.enum(["embedding", "graph"])) }).passthrough();

function readOwed(metadata: Record<string, unknown> | null): Owed[] {
  const parsed = owedSchema.safeParse(metadata?.headerRefresh);
  return parsed.success ? parsed.data.owes : [];
}

/**
 * The hierarchy roots whose catalog header chunk has to be rebuilt or finished: those with a
 * summary the chunk does not carry (when the header the root has now does), and those whose chunk an
 * earlier refresh replaced and left owing its embedding or graph. With `rootIds`, only those roots
 * are looked at. Cheap: no model is called, and the header is rendered only for a root whose chunk
 * lacks its summary.
 */
export async function listStaleCatalogHeaders(
  db: Queryable,
  options: { rootIds?: readonly string[] } = {}
): Promise<StaleCatalogHeader[]> {
  const rows = await db.query<CandidateRow>(
    `select s.id as "rootId", s.type::text as type, s.title, s.subtitle, s.source_uri as "sourceUri",
            s.language, s.summary, s.metadata,
            c.document_id as "documentId", c.id as "chunkId", c.content as "chunkContent",
            c.metadata as "chunkMetadata",
            exists (select 1 from ingestion_runs r
                     where r.source_item_id = s.id and r.status in ('pending', 'running')) as busy
       from source_items s
       join lateral (
         select k.* from chunks k join documents d on d.id = k.document_id
          where k.source_item_id = s.id and k.metadata->>'processingMode' = 'catalog_metadata'
            and d.metadata->>'supersededByDocumentId' is null
          order by k.created_at desc limit 1
       ) c on true
      where exists (select 1 from source_items child where child.parent_source_item_id = s.id)
        and ($1::uuid[] is null or s.id = any($1::uuid[]))
        and ((s.summary is not null and s.summary <> '') or c.metadata ? 'headerRefresh')
      order by s.title, s.id`,
    [options.rootIds ? [...options.rootIds] : null]
  );
  const stale: StaleCatalogHeader[] = [];
  for (const row of rows.rows) {
    const owes = readOwed(row.chunkMetadata);
    const summary = row.summary?.trim() ?? "";
    // A summary the chunk lacks is not enough: the header rule must put the summary in the header.
    const lacksSummary = summary.length > 0 && !carriesSummary(row.chunkContent, summary);
    if (!lacksSummary && owes.length === 0) continue;
    const header = buildCatalogMetadataMarkdown({
      type: row.type,
      title: row.title,
      subtitle: row.subtitle,
      sourceUri: row.sourceUri,
      language: row.language,
      summary: row.summary,
      metadata: row.metadata ?? {}
    });
    const outdated = lacksSummary && carriesSummary(header, summary);
    if (!outdated && owes.length === 0) continue;
    stale.push({
      rootId: row.rootId,
      title: row.title,
      documentId: row.documentId,
      chunkId: row.chunkId,
      header,
      outdated,
      owes,
      busy: row.busy
    });
  }
  return stale;
}

/**
 * DEV: `MEMORA_CATALOG_HEADERS=off` queues no header refresh, so a measurement profile or a replayed
 * cassette run keeps the library as it was built (the refresh calls the embedding and graph models
 * for headers the recording does not hold). The product never sets it.
 */
export function catalogHeaderRefreshEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.MEMORA_CATALOG_HEADERS?.trim().toLowerCase() !== "off";
}

/**
 * Queues the refresh when a root's header is out of date with its summary and no import is working
 * on it (`rootIds` limits the look to those roots): the job reads the work from the data, so it is
 * queued only when there is some. A running pass never absorbs the request (it may have read its
 * roots already), so one is queued beside it and waits its turn (`CatalogHeaderGate`). Resolves true
 * when a job is queued or merged.
 */
export async function enqueueCatalogHeaderRefresh(
  db: Queryable,
  options: { rootIds?: readonly string[] } = {},
  env: NodeJS.ProcessEnv = process.env
): Promise<boolean> {
  if (!catalogHeaderRefreshEnabled(env)) return false;
  const stale = await listStaleCatalogHeaders(db, options);
  if (!stale.some((header) => !header.busy)) return false;
  await createJobRepository(db).enqueueDeduped({
    type: catalogHeaderJobType,
    lane: "light",
    dedupeKey: catalogHeaderDedupeKey,
    payload: {},
    priority: catalogHeaderPriority,
    debounce: immediateJobDebounce,
    maxAttempts: 3
  });
  return true;
}

/**
 * One pass at a time in this process: a second job (queued beside a running one) is not claimed
 * while a pass runs, and one claimed in the same instant waits for it, so two passes never rebuild
 * the same root.
 */
export class CatalogHeaderGate {
  private tail: Promise<unknown> = Promise.resolve();
  private active = 0;

  /** True while a pass runs or waits for its turn. */
  public get busy(): boolean {
    return this.active > 0;
  }

  public run<T>(work: () => Promise<T>): Promise<T> {
    this.active += 1;
    const result = this.tail.then(work, work);
    this.tail = result.catch(() => undefined);
    return result.finally(() => {
      this.active -= 1;
    });
  }
}

export interface CatalogHeaderDeps {
  getPool: () => PgPool;
  /** The embedding space the route writes to now; null when no model is routed. */
  embeddingSpaceKey?: (() => Promise<string | null>) | undefined;
  generate?: EmbeddingBatchGenerator | null | undefined;
  /** Validates a vector the way the embedding worker does. */
  validate: (embedding: number[]) => Promise<number[]>;
  aggregate: CompositeAggregate;
  knowledge?:
    Pick<KnowledgeService, "generateCatalogKnowledgeGraph" | "catalogGraphAvailable"> | undefined;
  /** Replaces the header chunk of a document (`persistCatalogMetadataChunk`). */
  persistHeaderChunk: (
    repository: ReturnType<typeof createChunkRepository>,
    documentId: string,
    sourceItemId: string,
    content: string,
    replacement: { afterReplace: (transaction: Queryable) => Promise<void> }
  ) => Promise<ChunkRecord[]>;
  topicHooks?: TopicChangeHooks | undefined;
  reportProgress?: ((job: JobRecord, progress: number) => void) | undefined;
  /**
   * Called when a pass has no root left: the composites it did not build (parts, roots it left)
   * are the backfill's, which waits for this pass so no header is embedded by both.
   */
  afterPass?: (() => Promise<unknown>) | undefined;
  logger?: Pick<Console, "warn"> | undefined;
}

/** What the pass did with one root. */
export type RootRefresh =
  | {
      outcome: "refreshed";
      /** The header chunk was replaced (false: an earlier refresh's debts were paid). */
      replaced: boolean;
      /** Embedding calls made: the chunk's, and the composite's header segments not shared with it. */
      embeddings: number;
      /** The knowledge graph of the new chunk was extracted. */
      graph: boolean;
      /** What is still owed (no model was routed in time); the root stays on the list. */
      owes: Owed[];
      composite: "written" | "current" | "incomplete" | "skipped" | "failed";
    }
  | { outcome: "skipped"; reason: SkipReason };

type SkipReason = "no_embedding" | "no_graph_route" | "document_changed" | "source_not_found";

/**
 * Brings one root's header up to date: replaces the chunk when it lacks the summary, then pays what
 * the chunk owes (its embedding, its knowledge graph), then builds the root's composite from the
 * same header. A chunk that owes nothing and carries its summary is left alone.
 */
export async function refreshCatalogHeader(
  deps: CatalogHeaderDeps,
  stale: StaleCatalogHeader,
  job: JobRecord,
  signal: AbortSignal
): Promise<RootRefresh> {
  const pool = deps.getPool();
  const chunks = createChunkRepository(pool);
  const source = await createSourceItemRepository(pool).findById(stale.rootId);
  if (!source) return { outcome: "skipped", reason: "source_not_found" };
  const spaceKey = (await deps.embeddingSpaceKey?.()) ?? null;
  const canEmbed = Boolean(spaceKey && deps.generate);
  let owes = new Set<Owed>(stale.owes);
  let replaced = false;

  if (stale.outdated) {
    // What the old chunk had is what the new one is given: a library processed without a graph, or
    // without vectors, is not given them by a rebuilt header.
    const hadVector = owes.has("embedding") || (await chunkHasVector(pool, stale.chunkId));
    const hadGraph = owes.has("graph") || (await sourceHadGraph(pool, stale.rootId));
    if (hadVector && !canEmbed) return { outcome: "skipped", reason: "no_embedding" };
    if (hadGraph && !(await deps.knowledge?.catalogGraphAvailable()))
      return { outcome: "skipped", reason: "no_graph_route" };
    // The chunk is replaced only where it is the document's whole content.
    const existing = await chunks.listByDocument(stale.documentId);
    if (existing.length !== 1 || existing[0]!.id !== stale.chunkId)
      return { outcome: "skipped", reason: "document_changed" };
    owes = new Set<Owed>([
      ...(hadVector ? (["embedding"] as const) : []),
      ...(hadGraph ? (["graph"] as const) : [])
    ]);
    await deps.persistHeaderChunk(chunks, stale.documentId, stale.rootId, stale.header, {
      // In the replacing transaction, so a chunk that is replaced always says what it owes.
      afterReplace: async (transaction) => {
        await writeOwed(transaction, stale.documentId, owes);
        await deps.topicHooks?.itemsRemoved({ client: transaction });
      }
    });
    replaced = true;
  }

  const [header] = await chunks.listByDocument(stale.documentId);
  if (!header) return { outcome: "skipped", reason: "document_changed" };
  let embeddings = 0;
  let graph = false;
  /** The header's vector, shared by the chunk and the composite when their texts are the same. */
  const known = new Map<string, CompositeEmbedding>();

  if (owes.has("embedding") && canEmbed) {
    const embedded = await inModelStep("embedding", signal, () =>
      embedChunkVectors({
        pool,
        signal,
        generate: deps.generate!,
        ...(deps.embeddingSpaceKey ? { routeSpaceKey: deps.embeddingSpaceKey } : {}),
        validate: deps.validate,
        context: {
          jobId: job.id,
          sourceItemId: stale.rootId,
          documentId: stale.documentId,
          priority: "P3"
        },
        chunks: [header],
        render: (content) => renderPrompt("embedding.content.chunk", { source_text: content })
      })
    );
    embeddings += embedded.embedded;
    if (embedded.vectors[0]) {
      owes.delete("embedding");
      await writeOwed(pool, stale.documentId, owes);
    }
  }

  if (owes.has("graph")) {
    if (await graphIsCurrent(pool, stale.rootId, header.id)) {
      owes.delete("graph");
    } else if (deps.knowledge) {
      const knowledge = deps.knowledge;
      const extracted = await inModelStep("graph", signal, () =>
        knowledge.generateCatalogKnowledgeGraph(
          stale.rootId,
          stale.documentId,
          { jobId: job.id, priority: "P3" },
          signal
        )
      );
      if (extracted.generated) {
        graph = true;
        owes.delete("graph");
      }
    }
    await writeOwed(pool, stale.documentId, owes);
  }

  let composite: Extract<RootRefresh, { outcome: "refreshed" }>["composite"] = "skipped";
  if (spaceKey && deps.generate) {
    // The chunk's vector (made now, or by an earlier attempt) serves the composite's header
    // segment when both are the same text: the header is embedded once, not once for each.
    if (
      renderPrompt("embedding.content.chunk", { source_text: header.content }) === header.content
    ) {
      const stored = (
        await createEmbeddingRepository(pool).findCurrentChunkVectors(
          [{ id: header.id, contentHash: header.contentHash }],
          `native-v2:${spaceKey}`
        )
      ).get(header.id);
      if (stored)
        known.set(
          header.content,
          compositeEmbedding(stored.embedding, {
            provider: stored.provider,
            model: stored.model,
            runtime: stored.runtime,
            spaceKey
          })
        );
    }
    const embedder = sharedHeaderEmbedder(
      compositeHeaderEmbedder(deps.generate, job, signal),
      known,
      () => {
        embeddings += 1;
      }
    );
    const current = await createSourceItemRepository(pool).findById(stale.rootId);
    if (current) {
      const rebuilt = await refreshNodeComposite({
        pool,
        node: current,
        spaceKey,
        embed: embedder,
        aggregate: deps.aggregate
      });
      composite =
        rebuilt.outcome === "written" || rebuilt.outcome === "current"
          ? rebuilt.outcome
          : rebuilt.outcome === "incomplete"
            ? "incomplete"
            : "failed";
      if (rebuilt.outcome === "written") await deps.topicHooks?.sourcesChanged([stale.rootId]);
    }
  }
  return { outcome: "refreshed", replaced, embeddings, graph, owes: [...owes], composite };
}

/**
 * A model call of a root's refresh failed for good (not a cancellation, not a failure a retry can
 * mend): the same cause is likely to fail the next root's call too, and each root replaced before
 * its call loses the vector or the graph of the chunk it had, so the pass stops at the first.
 */
export class HeaderModelError extends Error {
  public constructor(
    public readonly step: Owed,
    cause: unknown
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "HeaderModelError";
  }
}

async function inModelStep<T>(step: Owed, signal: AbortSignal, call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    if (signal.aborted || isTransientJobFailure(error)) throw error;
    throw new HeaderModelError(step, error);
  }
}

function compositeEmbedding(embedding: number[], identity: EmbeddingIdentity): CompositeEmbedding {
  return {
    embedding,
    provider: identity.provider,
    model: identity.model,
    runtime: identity.runtime,
    ...(identity.spaceKey ? { spaceKey: identity.spaceKey } : {})
  };
}

/**
 * The composite's header embedder, served from the vectors already made for the same text (the
 * chunk's, when the header is one segment): the header is embedded once, not once for the chunk and
 * again for the composite. `onCall` counts the calls that reach the model.
 */
function sharedHeaderEmbedder(
  embed: CompositeHeaderEmbedder,
  known: ReadonlyMap<string, CompositeEmbedding>,
  onCall: () => void
): CompositeHeaderEmbedder {
  return async (text, context) => {
    const shared = known.get(text);
    if (shared) return shared;
    const generated = await embed(text, context);
    if (generated) onCall();
    return generated;
  };
}

async function chunkHasVector(db: Queryable, chunkId: string): Promise<boolean> {
  for (const dimensions of [256, 768, 1024] as const) {
    const found = await db.query(
      `select 1 from embeddings_${dimensions} where target_type = 'chunk' and target_id = $1 limit 1`,
      [chunkId]
    );
    if (found.rows.length > 0) return true;
  }
  return false;
}

/** Whether the source has ever had a knowledge-graph extraction (its header's graph is then replaced). */
async function sourceHadGraph(db: Queryable, sourceItemId: string): Promise<boolean> {
  const found = await db.query(
    `select 1 from knowledge_generations where source_item_id = $1 and stage = 'knowledgeGraph' limit 1`,
    [sourceItemId]
  );
  return found.rows.length > 0;
}

/** Whether an extraction at or after the chunk was made: it belongs to this chunk, owing nothing. */
async function graphIsCurrent(
  db: Queryable,
  sourceItemId: string,
  chunkId: string
): Promise<boolean> {
  const found = await db.query(
    `select 1 from knowledge_generations g
      where g.source_item_id = $1 and g.stage = 'knowledgeGraph'
        and g.updated_at >= (select created_at from chunks where id = $2) limit 1`,
    [sourceItemId, chunkId]
  );
  return found.rows.length > 0;
}

/** Records what the document's header chunk still owes; nothing owed removes the note. */
async function writeOwed(
  db: Queryable,
  documentId: string,
  owes: ReadonlySet<Owed>
): Promise<void> {
  if (owes.size === 0)
    await db.query(
      `update chunks set metadata = metadata - 'headerRefresh' where document_id = $1`,
      [documentId]
    );
  else
    await db.query(
      `update chunks set metadata = jsonb_set(metadata, '{headerRefresh}', $2::jsonb, true)
        where document_id = $1`,
      [documentId, JSON.stringify({ owes: [...owes] })]
    );
}

// --- the job ----------------------------------------------------------------------------------------

/** What the pages of a pass have done so far, carried in the payload of the job that continues it. */
const progressSchema = z
  .object({
    examined: z.number().int().min(0),
    refreshed: z.number().int().min(0),
    replaced: z.number().int().min(0),
    embeddings: z.number().int().min(0),
    graphs: z.number().int().min(0),
    composites: z.number().int().min(0),
    waiting: z.number().int().min(0),
    skipped: z.array(z.object({ rootId: z.string(), reason: z.string() }).strict()),
    failures: z.array(z.object({ rootId: z.string(), message: z.string() }).strict()),
    refreshedIds: z.array(z.string())
  })
  .strict();
type Progress = z.infer<typeof progressSchema>;

// Not strict: the supervisor adds its own keys to a payload (the prompt pin, the error history).
const continuationSchema = z.object({ progress: progressSchema });

const noProgress: Progress = {
  examined: 0,
  refreshed: 0,
  replaced: 0,
  embeddings: 0,
  graphs: 0,
  composites: 0,
  waiting: 0,
  skipped: [],
  failures: [],
  refreshedIds: []
};

function readProgress(job: JobRecord): Progress {
  const parsed = continuationSchema.safeParse(job.payload);
  return parsed.success ? parsed.data.progress : noProgress;
}

/**
 * Runs one page of a pass: the first root of the library whose header is out of date with its
 * summary (a root skipped earlier in the pass, or whose import is running, is left out), brought up
 * to date. The job is queued again for the next page while roots are left, so it gives its slot back
 * between roots; its result carries the totals of the pass.
 */
export async function runCatalogHeaderRefresh(
  deps: CatalogHeaderDeps,
  job: JobRecord,
  signal: AbortSignal
): Promise<JsonObject> {
  const before = readProgress(job);
  // A root the pass has dealt with once is not dealt with again by it, whatever the scan says.
  const left = new Set([...before.skipped.map((entry) => entry.rootId), ...before.refreshedIds]);
  const stale = await listStaleCatalogHeaders(deps.getPool());
  const ready = stale.filter((header) => !header.busy && !left.has(header.rootId));
  const examined = before.examined > 0 ? before.examined : ready.length;
  const waiting = stale.filter((header) => header.busy).length;
  const next = ready[0];
  let progress: Progress = { ...before, examined, waiting };
  let stopped: HeaderModelError["step"] | null = null;
  if (next) {
    signal.throwIfAborted();
    try {
      const done = await refreshCatalogHeader(deps, next, job, signal);
      progress = recordRoot(progress, next.rootId, done);
    } catch (error) {
      // A cancellation and a failure the retry can mend are the job's. A model that fails for good
      // ends the pass (the roots left keep the vector and the graph they have, and the root that
      // failed owes what it lost); a root whose own work fails otherwise is reported and left.
      if (signal.aborted || isTransientJobFailure(error)) throw error;
      deps.logger?.warn(error instanceof Error ? error.message : String(error));
      if (error instanceof HeaderModelError) stopped = error.step;
      progress = {
        ...progress,
        skipped: [...progress.skipped, { rootId: next.rootId, reason: "failed" }],
        failures: [
          ...progress.failures,
          {
            rootId: next.rootId,
            message: (error instanceof Error ? error.message : String(error)).slice(0, 300)
          }
        ].slice(0, 10)
      };
    }
    deps.reportProgress?.(
      job,
      Math.min(1, (progress.refreshed + progress.skipped.length) / examined)
    );
  }
  const more = Boolean(next) && ready.length > 1 && stopped === null;
  if (!more)
    try {
      await deps.afterPass?.();
    } catch (error) {
      deps.logger?.warn(error instanceof Error ? error.message : String(error));
    }
  const { failures, skipped, refreshedIds, ...counts } = progress;
  return {
    ...counts,
    ...(failures.length > 0 ? { failures } : {}),
    ...(skipped.length > 0 ? { skipped } : {}),
    ...(stopped ? { stopped: `${stopped}_failed` } : {}),
    refreshedIds,
    // The next page: the same job is queued again behind the work already waiting.
    ...(more ? { continueWith: { progress } } : {})
  };
}

function recordRoot(progress: Progress, rootId: string, done: RootRefresh): Progress {
  if (done.outcome === "skipped")
    return { ...progress, skipped: [...progress.skipped, { rootId, reason: done.reason }] };
  // A root still owing something (no model was routed in time) is left for a later pass.
  const owing = done.owes.length > 0;
  return {
    ...progress,
    refreshed: progress.refreshed + 1,
    replaced: progress.replaced + (done.replaced ? 1 : 0),
    embeddings: progress.embeddings + done.embeddings,
    graphs: progress.graphs + (done.graph ? 1 : 0),
    composites: progress.composites + (done.composite === "written" ? 1 : 0),
    refreshedIds: [...progress.refreshedIds, rootId].slice(0, resultIdLimit),
    skipped: owing
      ? [...progress.skipped, { rootId, reason: `owes_${done.owes.join("_")}` }]
      : progress.skipped
  };
}
