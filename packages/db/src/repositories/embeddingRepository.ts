import type { QueryResultRow } from "pg";

import type { Queryable } from "./types.js";

export type SupportedEmbeddingDimension = 256 | 768;

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

function embeddingTable(dimensions: number): string {
  if (dimensions === 256 || dimensions === 768) {
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
      const result = await db.query<QueryResultRow & { targetId: string; chunkId: string | null; score: number }>(
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
    }
  };
}
