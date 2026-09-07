import type { PgPool } from "../client.js";
import type { JsonObject, Queryable } from "./types.js";
import type { RelationTypeVector } from "./relationTypeRepository.js";

export interface EntityIdentity { id: string; type: string; canonicalName: string; identityDescription: string; aliases: string[]; sourceItemIds?: string[] }
export interface EntityIdentityDecision {
  fingerprint: string; sourceItemId: string | null;
  key: string; type: string; canonicalName: string; identityDescription: string; aliases: string[];
  description?: string | undefined; confidence: number; language: string;
  target: { id: string } | { key: string } | null; vector: RelationTypeVector; metadata: JsonObject;
}
const identityFields = `array(select distinct source_item_id from entity_mentions where entity_id = e.id union select source_item_id from entity_identity_keys where entity_id = e.id and source_item_id is not null) as "sourceItemIds", e.id, e.type, e.canonical_name as "canonicalName", e.aliases,
  coalesce(e.metadata->>'identityDescription', e.description, 'Insufficient identifying context.') as "identityDescription"`;
const revisionSql = `select md5(coalesce(string_agg(id::text || aliases::text, '|' order by id), '')) || ':' ||
  (select md5(coalesce(string_agg(fingerprint || entity_id::text, '|' order by fingerprint), '')) from entity_identity_keys) as revision from entities`;
export function normalizeIdentityName(value: string): string { return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim(); }
function tableFor(vector: number[]): string {
  if (![256, 768, 1024].includes(vector.length) || vector.some((value) => !Number.isFinite(value)) || !vector.some((value) => value !== 0)) throw new Error("errors.relationTypes.invalidEmbedding");
  return `entity_identity_embeddings_${vector.length}`;
}
async function saveVector(db: Queryable, id: string, vector: RelationTypeVector) {
  await db.query(`insert into ${tableFor(vector.embedding)} (entity_id, space_key, content_hash, provider, model, runtime, embedding, metadata)
    values ($1, $2, $3, $4, $5, $6, $7::vector, $8)
    on conflict (entity_id, space_key) do update set content_hash = excluded.content_hash, embedding = excluded.embedding, metadata = excluded.metadata, updated_at = now()`,
  [id, vector.spaceKey, vector.contentHash, vector.provider, vector.model, vector.runtime, `[${vector.embedding.join(",")}]`, vector.metadata]);
}
export function createEntityIdentityRepository(pool: PgPool) {
  return {
    async findResolved(fingerprints: string[]): Promise<Map<string, string>> {
      const result = await pool.query<{ fingerprint: string; entityId: string }>(
        'select fingerprint, entity_id as "entityId" from entity_identity_keys where fingerprint = any($1::text[])', [fingerprints]);
      return new Map(result.rows.map((row) => [row.fingerprint, row.entityId]));
    },
    async revision(): Promise<string> { return (await pool.query<{ revision: string }>(revisionSql)).rows[0]!.revision; },
    async missingVectors(vector: RelationTypeVector, types: string[]): Promise<EntityIdentity[]> {
      return (await pool.query<EntityIdentity>(`select ${identityFields} from entities e
        where e.type = any($2::text[]) and not exists (select 1 from ${tableFor(vector.embedding)} v where v.entity_id = e.id and v.space_key = $1)
        order by e.id limit 16`, [vector.spaceKey, types])).rows;
    },
    async saveVector(id: string, vector: RelationTypeVector) { await saveVector(pool, id, vector); },
    async candidates(input: { type: string; names: string[]; vector: RelationTypeVector; threshold: number }): Promise<Array<EntityIdentity & { score: number }>> {
      const result = await pool.query<EntityIdentity & { score: number }>(`select ${identityFields}, 1 - (v.embedding <=> $1::vector) as score
        from entities e join ${tableFor(input.vector.embedding)} v on v.entity_id = e.id and v.space_key = $2
        where e.type = $3 and (1 - (v.embedding <=> $1::vector) >= $4
          or e.normalized_name = any($5::text[])
          or exists (select 1 from jsonb_array_elements_text(e.aliases) a where lower(unaccent(a)) = any($5::text[])))
        order by (e.normalized_name = any($5::text[])) desc, v.embedding <=> $1::vector, e.id limit 3`,
      [`[${input.vector.embedding.join(",")}]`, input.vector.spaceKey, input.type, input.threshold, input.names.map(normalizeIdentityName)]);
      return result.rows.map((row) => ({ ...row, score: Number(row.score) }));
    },
    async commit(decisions: EntityIdentityDecision[], expectedRevision: string): Promise<Map<string, string> | null> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query("select pg_advisory_xact_lock(hashtext('entity-identity-catalog'))");
        if ((await client.query<{ revision: string }>(revisionSql)).rows[0]!.revision !== expectedRevision) { await client.query("rollback"); return null; }
        const resolved = new Map<string, string>();
        for (const decision of decisions) {
          let id = decision.target ? "id" in decision.target ? decision.target.id : resolved.get(decision.target.key) : undefined;
          const aliases = [...new Set([decision.canonicalName, ...decision.aliases])];
          if (decision.target) {
            if (!id) throw new Error("errors.relationTypes.invalidOutput");
            const result = await client.query(`update entities set aliases =
              (select jsonb_agg(distinct a) from jsonb_array_elements(aliases || $2::jsonb) a),
              metadata = metadata || jsonb_build_object('identityResolution', $3::jsonb), updated_at = now()
              where id = $1 and type = $4 returning id`, [id, JSON.stringify(aliases), decision.metadata, decision.type]);
            if (!result.rowCount) throw new Error("errors.relationTypes.invalidOutput");
          } else {
            const result = await client.query<{ id: string }>(`insert into entities
              (type, canonical_name, normalized_name, aliases, description, language, confidence, metadata)
              values ($1, $2, $3, $4, $5, $6, $7, $8) returning id`,
            [decision.type, decision.canonicalName, normalizeIdentityName(decision.canonicalName), JSON.stringify(aliases), decision.description ?? null,
              decision.language, decision.confidence, { identityDescription: decision.identityDescription, identityResolution: decision.metadata }]);
            id = result.rows[0]!.id;
            await saveVector(client, id, decision.vector);
          }
          await client.query("insert into entity_identity_keys (fingerprint, entity_id, source_item_id) values ($1, $2, $3)", [decision.fingerprint, id, decision.sourceItemId]);
          resolved.set(decision.key, id);
        }
        await client.query("commit");
        return resolved;
      } catch (error) { await client.query("rollback"); throw error; }
      finally { client.release(); }
    }
  };
}
