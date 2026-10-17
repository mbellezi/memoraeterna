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
 * null composite and was never discovered. Each ancestor's composite is rebuilt, as its own
 * embedding stage builds it, from its catalog header and the composites of the descendants that
 * have one in the same space; an ancestor whose stored composite already holds exactly these inputs
 * is left alone (no call). Resolves to the ancestors written, nearest first.
 */
export async function refreshAncestorComposites(input: {
  pool: PgPool;
  sourceItemId: string;
  /** Embeds one header segment in the space of the source's vectors; null when nothing embeds. */
  embed: ((text: string) => Promise<CompositeEmbedding | null>) | null;
  /** The embedding stage's aggregation (header 0.35, content 0.65, normalized). */
  aggregate: (headerVectors: number[][], contentVectors: number[][]) => number[] | null;
}): Promise<string[]> {
  const { pool } = input;
  if (!input.embed) return [];
  const own = await newestComposite(pool, input.sourceItemId);
  if (!own) return [];
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
  const written: string[] = [];
  for (const ancestorId of ancestors) {
    const ancestor = await createSourceItemRepository(pool).findById(ancestorId);
    if (!ancestor) break;
    const descendants =
      await createHierarchicalIngestionRepository(pool).listDescendants(ancestorId);
    // Read as the embedding stage reads them, so an unchanged composite hashes the same.
    const children = await embeddings.listSourceEmbeddings(
      descendants.map((descendant) => descendant.id),
      own.model,
      own.dimensions,
      own.strategy
    );
    if (!children.length) break;
    const header = buildCatalogMetadataMarkdown(ancestor);
    const fingerprint = createHash("sha256").update(header);
    for (const child of children) fingerprint.update(child.embedding.join(","));
    const contentHash = fingerprint.digest("hex");
    const stored = await embeddings.hasContentHash(
      "source_item",
      ancestorId,
      contentHash,
      own.strategy
    );
    if (stored) continue;
    const headerVectors: number[][] = [];
    for (const segment of chunkMarkdown(header).map((chunk) => chunk.content)) {
      const generated = await input.embed(segment);
      if (!generated) return written;
      // A header embedded in another space would mix spaces: the composite waits for a match.
      if (`${compositePrefix}${generated.spaceKey ?? ""}` !== own.strategy) return written;
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
  return written;
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
