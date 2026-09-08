import type { PgPool } from "../client.js";
import type { JsonObject, Queryable } from "./types.js";

export interface CanonicalRelationType { id: string; predicate: string; definition: string; sourceItemIds?: string[] }
export interface RelationTypeVector {
  embedding: number[]; spaceKey: string; contentHash: string; provider: string; model: string; runtime: string; metadata: JsonObject;
}
export interface RelationTypeDecision {
  predicate: string; definition: string;
  // Only earlier decisions may be referenced, preventing cycles within a batch.
  target: { id: string } | { predicate: string } | null;
  vector: RelationTypeVector;
  metadata: JsonObject;
}

function tableFor(vector: number[]): string {
  if (![256, 768, 1024].includes(vector.length) || vector.some((value) => !Number.isFinite(value))
      || !vector.some((value) => value !== 0)) throw new Error("errors.relationTypes.invalidEmbedding");
  return `relation_type_embeddings_${vector.length}`;
}
function literal(vector: number[]): string { return `[${vector.join(",")}]`; }

async function saveVector(db: Queryable, id: string, vector: RelationTypeVector) {
  await db.query(`insert into ${tableFor(vector.embedding)}
    (relation_type_id, space_key, content_hash, provider, model, runtime, embedding, metadata)
    values ($1, $2, $3, $4, $5, $6, $7::vector, $8)
    on conflict (relation_type_id, space_key) do update set
      content_hash = excluded.content_hash, embedding = excluded.embedding, metadata = excluded.metadata, updated_at = now()`,
  [id, vector.spaceKey, vector.contentHash, vector.provider, vector.model, vector.runtime, literal(vector.embedding), vector.metadata]);
}

export function createRelationTypeRepository(pool: PgPool) {
  return {
    async findExact(predicates: string[]): Promise<Map<string, CanonicalRelationType>> {
      const result = await pool.query<CanonicalRelationType & { alias: string }>(
        `select a.alias, t.id, t.predicate, t.definition, coalesce(t.metadata->'sourceItemIds', '[]'::jsonb) as "sourceItemIds" from relation_type_aliases a
         join relation_types t on t.id = a.relation_type_id where a.alias = any($1::text[])`, [predicates]);
      return new Map(result.rows.map(({ alias, ...type }) => [alias, type]));
    },
    async revision(): Promise<number> {
      const result = await pool.query<{ count: string }>("select count(*)::text as count from relation_type_aliases");
      return Number(result.rows[0]?.count ?? 0);
    },
    async missingVectors(vector: RelationTypeVector): Promise<CanonicalRelationType[]> {
      const result = await pool.query<CanonicalRelationType>(
        `select t.id, t.predicate, t.definition, coalesce(t.metadata->'sourceItemIds', '[]'::jsonb) as "sourceItemIds" from relation_types t
         where not exists (select 1 from ${tableFor(vector.embedding)} e where e.relation_type_id = t.id and e.space_key = $1)
         order by t.id limit 16`, [vector.spaceKey]);
      return result.rows;
    },
    async saveVector(id: string, vector: RelationTypeVector) { await saveVector(pool, id, vector); },
    async candidates(vector: RelationTypeVector, threshold: number, limit = 3): Promise<Array<CanonicalRelationType & { score: number }>> {
      if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw new Error("errors.common.validationFailed");
      const result = await pool.query<CanonicalRelationType & { score: number }>(
        `select t.id, t.predicate, t.definition, coalesce(t.metadata->'sourceItemIds', '[]'::jsonb) as "sourceItemIds", 1 - (e.embedding <=> $1::vector) as score
         from ${tableFor(vector.embedding)} e join relation_types t on t.id = e.relation_type_id
         where e.space_key = $2 and 1 - (e.embedding <=> $1::vector) >= $3
         order by e.embedding <=> $1::vector, t.id limit $4`, [literal(vector.embedding), vector.spaceKey, threshold, Math.max(1, Math.min(20, Math.floor(limit)))]);
      return result.rows.map((row) => ({ ...row, score: Number(row.score) }));
    },
    async commit(decisions: RelationTypeDecision[], expectedRevision: number): Promise<Map<string, CanonicalRelationType> | null> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("select pg_advisory_xact_lock(hashtext('relation-type-catalog'))");
        const revision = await client.query<{ count: string }>("select count(*)::text as count from relation_type_aliases");
        if (Number(revision.rows[0]?.count ?? 0) !== expectedRevision) {
          await client.query("rollback");
          return null;
        }
        const resolved = new Map<string, CanonicalRelationType>();
        for (const decision of decisions) {
          let type: CanonicalRelationType | undefined;
          if (decision.target && "predicate" in decision.target) type = resolved.get(decision.target.predicate);
          else if (decision.target) {
            const existing = await client.query<CanonicalRelationType>("select id, predicate, definition from relation_types where id = $1", [decision.target.id]);
            type = existing.rows[0];
          } else {
            const inserted = await client.query<CanonicalRelationType>(
              `insert into relation_types (predicate, definition, metadata) values ($1, $2, $3) returning id, predicate, definition`,
              [decision.predicate, decision.definition, decision.metadata]);
            type = inserted.rows[0];
            if (type) await saveVector(client, type.id, decision.vector);
          }
          if (!type) throw new Error("errors.relationTypes.invalidOutput");
          await client.query(`insert into relation_type_aliases (alias, relation_type_id, metadata) values ($1, $2, $3)`,
            [decision.predicate, type.id, decision.metadata]);
          resolved.set(decision.predicate, type);
        }
        await client.query("commit");
        return resolved;
      } catch (error) { await client.query("rollback"); throw error; }
      finally { client.release(); }
    }
  };
}
