import type { QueryResultRow } from "pg";

import type { Queryable } from "./types.js";

export type SupportedEmbeddingDimension = 256 | 768 | 1024;

export interface UpsertEmbeddingInput {
  targetType: "chunk" | "atomic_note" | "document" | "source_item";
  targetId: string;
  chunkId?: string | null;
  provider: string;
  model: string;
  runtime: string;
  usage?: string;
  strategy?: string;
  contentHash: string;
  embedding: number[];
}

export interface VectorMatch {
  targetId: string;
  chunkId: string | null;
  score: number;
}

export interface StoredEmbedding {
  targetId: string;
  embedding: number[];
}

/** A stored note vector with the embedding space (model, provider, runtime, strategy) it lives in. */
export interface StoredNoteVector extends StoredEmbedding {
  model: string;
  provider: string;
  runtime: string;
  strategy: string;
}

/** The space a stored note vector lives in, read from its `native-v2:<space key>` strategy. */
export interface NoteVectorSpace {
  spaceKey: string;
  provider: string;
  model: string;
  runtime: string;
  dimensions: SupportedEmbeddingDimension;
  createdAt: Date;
}

/** Strategy prefix of note and chunk vectors that carry their embedding space key. */
const noteSpaceStrategyPrefix = "native-v2:";

function embeddingTable(dimensions: number): string {
  if (dimensions === 256 || dimensions === 768 || dimensions === 1_024) {
    return `embeddings_${dimensions}`;
  }
  throw new Error(`Unsupported embedding dimension: ${dimensions}`);
}

function vectorLiteral(values: number[]): string {
  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error("Embedding contains a non-finite value.");
  }
  return `[${values.join(",")}]`;
}

export function createEmbeddingRepository(db: Queryable) {
  return {
    async hasSourceMatchingCoverage(sourceItemId: string, documentId: string): Promise<boolean> {
      for (const dimensions of [256, 768, 1024]) {
        const result = await db.query(
          `select 1 from embeddings_${dimensions} source
          where source.target_type = 'source_item' and source.target_id = $1
            and source.strategy like 'source-composite-centroid-v2:%'
            and not exists (select 1 from chunks c where c.document_id = $2 and not exists (
              select 1 from embeddings_${dimensions} e where e.target_type = 'chunk' and e.target_id = c.id
                and e.content_hash = c.content_hash and e.model = source.model and e.provider = source.provider and e.runtime = source.runtime
                and e.strategy = replace(source.strategy,'source-composite-centroid-v2:','native-v2:')
            )) limit 1`,
          [sourceItemId, documentId]
        );
        if (result.rows.length) return true;
      }
      return false;
    },
    /**
     * Whether the target already has a vector built from exactly this content (any dimension),
     * only of the embedding strategy `strategy` when it is given (one space, D26).
     */
    async hasContentHash(
      targetType: UpsertEmbeddingInput["targetType"],
      targetId: string,
      contentHash: string,
      strategy?: string
    ): Promise<boolean> {
      for (const dimensions of [256, 768, 1024]) {
        const result = await db.query(
          `select 1 from embeddings_${dimensions}
            where target_type = $1 and target_id = $2 and content_hash = $3
              and ($4::text is null or strategy = $4) limit 1`,
          [targetType, targetId, contentHash, strategy ?? null]
        );
        if (result.rows.length) return true;
      }
      return false;
    },
    /**
     * The newest vector of each note that was built from exactly the given content, in any
     * dimension and embedding space. A note without one is missing from the result: it was never
     * embedded, or its text changed after it was.
     */
    async findCurrentNoteVectors(
      notes: ReadonlyArray<{ id: string; contentHash: string }>
    ): Promise<Map<string, StoredNoteVector>> {
      const found = new Map<string, StoredNoteVector>();
      const newest = new Map<string, number>();
      if (notes.length === 0) return found;
      for (const dimensions of [256, 768, 1024]) {
        const result = await db.query<
          QueryResultRow & {
            targetId: string;
            embedding: string;
            model: string;
            provider: string;
            runtime: string;
            strategy: string;
            createdAt: Date | string;
          }
        >(
          `select distinct on (e.target_id) e.target_id as "targetId", e.embedding::text as embedding,
                  e.model, e.provider, e.runtime, e.strategy, e.created_at as "createdAt"
             from embeddings_${dimensions} e
             join unnest($1::uuid[], $2::text[]) as wanted(id, content_hash)
               on wanted.id = e.target_id and wanted.content_hash = e.content_hash
            where e.target_type = 'atomic_note'
            order by e.target_id, e.created_at desc`,
          [notes.map((note) => note.id), notes.map((note) => note.contentHash)]
        );
        for (const row of result.rows) {
          const createdAt = new Date(row.createdAt).getTime();
          if ((newest.get(row.targetId) ?? -Infinity) >= createdAt) continue;
          newest.set(row.targetId, createdAt);
          found.set(row.targetId, {
            targetId: row.targetId,
            embedding: parseVector(row.embedding),
            model: row.model,
            provider: row.provider,
            runtime: row.runtime,
            strategy: row.strategy
          });
        }
      }
      return found;
    },

    /**
     * The embedding space of the newest stored note vector: the key of its `native-v2:` strategy
     * and the provider, model and runtime that made it. Null when no note has such a vector.
     */
    async newestNoteVectorSpace(): Promise<NoteVectorSpace | null> {
      let newest: NoteVectorSpace | null = null;
      for (const dimensions of [256, 768, 1024] as const) {
        const result = await db.query<
          QueryResultRow & {
            strategy: string;
            provider: string;
            model: string;
            runtime: string;
            createdAt: Date | string;
          }
        >(
          `select strategy, provider, model, runtime, created_at as "createdAt"
             from embeddings_${dimensions}
            where target_type = 'atomic_note' and strategy like $1
            order by created_at desc, id desc
            limit 1`,
          [`${noteSpaceStrategyPrefix}%`]
        );
        const row = result.rows[0];
        if (!row) continue;
        const createdAt = new Date(row.createdAt);
        if (newest && newest.createdAt.getTime() >= createdAt.getTime()) continue;
        newest = {
          spaceKey: row.strategy.slice(noteSpaceStrategyPrefix.length),
          provider: row.provider,
          model: row.model,
          runtime: row.runtime,
          dimensions,
          createdAt
        };
      }
      return newest;
    },

    async upsert(input: UpsertEmbeddingInput): Promise<string> {
      const table = embeddingTable(input.embedding.length);
      const result = await db.query<QueryResultRow & { id: string }>(
        `insert into ${table} (
           target_type, target_id, chunk_id, provider, model, runtime,
           usage, strategy, content_hash, embedding
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::vector)
         on conflict (target_type, target_id, model) do update set
           chunk_id = excluded.chunk_id, provider = excluded.provider,
           runtime = excluded.runtime, usage = excluded.usage,
           strategy = excluded.strategy, content_hash = excluded.content_hash,
           embedding = excluded.embedding, created_at = now()
         returning id`,
        [
          input.targetType,
          input.targetId,
          input.chunkId ?? null,
          input.provider,
          input.model,
          input.runtime,
          input.usage ?? "retrieval",
          input.strategy ?? "native",
          input.contentHash,
          vectorLiteral(input.embedding)
        ]
      );
      const row = result.rows[0];
      if (!row) throw new Error("Embedding upsert returned no row.");
      return row.id;
    },

    async search(embedding: number[], limit = 20, model?: string): Promise<VectorMatch[]> {
      const table = embeddingTable(embedding.length);
      const result = await db.query<
        QueryResultRow & { targetId: string; chunkId: string | null; score: number }
      >(
        `select target_id as "targetId", chunk_id as "chunkId",
                greatest(0, 1 - (embedding <=> $1::vector)) as score
         from ${table}
         where ($2::text is null or model = $2)
         order by embedding <=> $1::vector
         limit $3`,
        [vectorLiteral(embedding), model ?? null, limit]
      );
      return result.rows.map((row) => ({
        targetId: row.targetId,
        chunkId: row.chunkId,
        score: Number(row.score)
      }));
    },

    async listSourceEmbeddings(
      sourceItemIds: string[],
      model: string,
      dimensions: SupportedEmbeddingDimension,
      strategy?: string
    ): Promise<StoredEmbedding[]> {
      if (sourceItemIds.length === 0) return [];
      const table = embeddingTable(dimensions);
      const result = await db.query<QueryResultRow & { targetId: string; embedding: string }>(
        `select target_id as "targetId", embedding::text as embedding
         from ${table}
         where target_type = 'source_item' and target_id = any($1::uuid[]) and model = $2 and ($3::text is null or strategy = $3)`,
        [sourceItemIds, model, strategy ?? null]
      );
      return result.rows.map((row) => ({
        targetId: row.targetId,
        embedding: parseVector(row.embedding)
      }));
    }
  };
}

function parseVector(value: string): number[] {
  const parsed = value.trim().replace(/^\[/, "").replace(/\]$/, "");
  if (!parsed) return [];
  return parsed.split(",").map(Number).filter(Number.isFinite);
}
