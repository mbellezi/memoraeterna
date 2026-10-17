import { createHash } from "node:crypto";

import { chunkMarkdown } from "@app/conversion";
import {
  createEmbeddingRepository,
  createHierarchicalIngestionRepository,
  createSourceItemRepository,
  type PgPool
} from "@app/db";
import type { QueryResultRow } from "pg";

import { buildCatalogMetadataMarkdown } from "./hierarchical-ingestion-service.js";

/** Storage identity of a composite vector in an embedding space (`source_item` targets). */
const compositePrefix = "source-composite-centroid-v2:";

export interface CompositeEmbedding {
  embedding: number[];
  provider: string;
  model: string;
  runtime: string;
  spaceKey?: string;
}

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
 * With `warn`, a failure (an embedding error, a replay miss) is reported and resolves to what was
 * written: the source's own vectors are in place, so its stage does not fail for an ancestor, whose
 * composite is left to a later descendant or its own stage. A cancellation is always thrown.
 */
export async function refreshAncestorComposites(input: {
  pool: PgPool;
  sourceItemId: string;
  /** Embeds one header segment in the space of the source's vectors; null when nothing embeds. */
  embed: ((text: string) => Promise<CompositeEmbedding | null>) | null;
  /** The embedding stage's aggregation (header 0.35, content 0.65, normalized). */
  aggregate: (headerVectors: number[][], contentVectors: number[][]) => number[] | null;
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
  const embeddings = createEmbeddingRepository(pool);
  for (const ancestorId of ancestors) {
    const ancestor = await createSourceItemRepository(pool).findById(ancestorId);
    if (!ancestor) break;
    const inputs = await compositeInputs(
      pool,
      ancestorId,
      buildCatalogMetadataMarkdown(ancestor),
      own
    );
    // A descendant without a composite: the last one to embed builds it (and every farther
    // ancestor counts that descendant too).
    if (inputs.state === "incomplete") break;
    if (inputs.state !== "stale") continue;
    const { header, children, contentHash } = inputs;
    const headerVectors: number[][] = [];
    for (const segment of chunkMarkdown(header).map((chunk) => chunk.content)) {
      const generated = await input.embed(segment);
      if (!generated) return;
      // A header embedded in another space would mix spaces: the composite waits for a match.
      if (`${compositePrefix}${generated.spaceKey ?? ""}` !== own.strategy) return;
      headerVectors.push(generated.embedding);
    }
    const composite = input.aggregate(
      headerVectors,
      children.map((child) => child.embedding)
    );
    if (!composite) break;
    await embeddings.upsert({
      targetType: "source_item",
      targetId: ancestorId,
      provider: own.provider,
      model: own.model,
      runtime: own.runtime,
      strategy: own.strategy,
      contentHash,
      embedding: composite
    });
    written.push(ancestorId);
  }
}

/** The composite space of a source: its model, vector dimensions and storage strategy. */
export interface CompositeSpace {
  model: string;
  dimensions: 256 | 768 | 1024;
  strategy: string;
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
  space: CompositeSpace
) {
  const embeddings = createEmbeddingRepository(pool);
  const descendants =
    await createHierarchicalIngestionRepository(pool).listDescendants(sourceItemId);
  const children = await embeddings.listSourceEmbeddings(
    descendants.map((descendant) => descendant.id),
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
  let newest: {
    dimensions: 256 | 768 | 1024;
    strategy: string;
    model: string;
    provider: string;
    runtime: string;
    createdAt: number;
  } | null = null;
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
