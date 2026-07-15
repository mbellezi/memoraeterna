import { createHash } from "node:crypto";
import type { PoolClient, QueryResultRow } from "pg";

import type { PgPool } from "../client.js";
import { asJsonObject, mapTimestamp } from "./sql.js";
import type { GraphEntityRecord, JsonObject, SearchEvidenceRecord, SourceItemType } from "./types.js";

const graphName = "memora_knowledge";

export interface ExtractedEntityInput {
  key: string;
  type: string;
  canonicalName: string;
  aliases: string[];
  description?: string | undefined;
  confidence: number;
  evidenceChunkIds: string[];
}

export interface ExtractedClaimInput {
  text: string;
  confidence: number;
  evidenceChunkIds: string[];
  relatedEntityKeys: string[];
}

export interface ExtractedRelationInput {
  subjectEntityKey: string;
  predicate: string;
  objectEntityKey: string;
  confidence: number;
  evidenceChunkIds: string[];
}

export interface KnowledgeGraphBatchInput {
  entities: ExtractedEntityInput[];
  claims: ExtractedClaimInput[];
  relations: ExtractedRelationInput[];
}

export interface ReplaceKnowledgeGraphInput {
  sourceItemId: string;
  language: string;
  batches: KnowledgeGraphBatchInput[];
  generation: JsonObject;
}

export interface AtomicNoteGraphElements {
  entities: Array<{ id: string; type: string; name: string; confidence: number }>;
  claims: Array<{ id: string; text: string; confidence: number }>;
  relations: Array<{ id: string; subject: string; predicate: string; object: string; confidence: number }>;
}

export interface AtomicNoteGraphCandidate {
  noteId: string;
  graphScore: number;
  pathType: "shared_entity" | "related_entity";
}

interface EntityRow extends QueryResultRow {
  id: string;
  type: string;
  canonicalName: string;
  normalizedName: string;
  aliases: unknown;
  description: string | null;
  language: string;
  confidence: number;
  metadata: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

interface ProjectionRow extends QueryResultRow {
  entityId: string;
  chunkId: string;
  confidence: number;
}

interface RelationProjectionRow extends QueryResultRow {
  id: string;
  subjectEntityId: string;
  objectEntityId: string;
  confidence: number;
}

interface ClaimProjectionRow extends QueryResultRow {
  id: string;
  evidenceChunkId: string;
  entityId: string | null;
}

interface AtomicProjectionRow extends QueryResultRow {
  atomicNoteId: string;
  entityId: string;
  confidence: number;
}

interface AgDirectRow extends QueryResultRow {
  seedId: unknown;
  chunkId: unknown;
  mentionConfidence: unknown;
}

interface AgRelatedRow extends AgDirectRow {
  relationConfidence: unknown;
}

interface AgAtomicDirectRow extends QueryResultRow {
  targetId: unknown;
  entityId: unknown;
  relationConfidence: unknown;
}

interface AgAtomicRelatedRow extends QueryResultRow {
  targetId: unknown;
  sourceEntityId: unknown;
  targetEntityId: unknown;
  relationConfidence: unknown;
}

const entityReturning = `id, type, canonical_name as "canonicalName", normalized_name as "normalizedName",
  aliases, description, language, confidence, metadata, created_at as "createdAt", updated_at as "updatedAt"`;

export function createKnowledgeGraphRepository(pool: PgPool) {
  return {
    async clearProjection(): Promise<void> {
      const client = await pool.connect();
      try {
        await prepareAge(client);
        const existing = await client.query("select 1 from ag_catalog.ag_graph where name = $1", [graphName]);
        if (existing.rowCount !== 0) {
          await client.query("select ag_catalog.drop_graph($1, $2)", [graphName, true]);
        }
      } finally {
        client.release();
      }
    },

    async replaceSourceExtraction(input: ReplaceKnowledgeGraphInput): Promise<{
      entityCount: number;
      mentionCount: number;
      claimCount: number;
      relationCount: number;
      atomicNoteEntityLinkCount: number;
    }> {
      const client = await pool.connect();
      try {
        await client.query("begin");
        await client.query(
          `delete from atomic_note_entity_links where atomic_note_id in (
             select id from atomic_notes where created_from_source_item_id = $1
           )`,
          [input.sourceItemId]
        );
        await client.query("delete from entity_relations where source_item_id = $1", [input.sourceItemId]);
        await client.query("delete from claims where source_item_id = $1", [input.sourceItemId]);
        await client.query("delete from entity_mentions where source_item_id = $1", [input.sourceItemId]);

        const entityIds = new Set<string>();
        let mentionCount = 0;
        let claimCount = 0;
        let relationCount = 0;
        for (const batch of input.batches) {
          const entitiesByKey = new Map<string, GraphEntityRecord>();
          for (const entity of batch.entities) {
            const normalizedName = normalizeEntityName(entity.canonicalName);
            const result = await client.query<EntityRow>(
              `insert into entities (
                 type, canonical_name, normalized_name, aliases, description, language, confidence, metadata
               ) values ($1, $2, $3, $4, $5, $6, $7, $8)
               on conflict (type, normalized_name) do update set
                 canonical_name = excluded.canonical_name,
                 aliases = excluded.aliases,
                 description = coalesce(excluded.description, entities.description),
                 language = excluded.language,
                 confidence = greatest(entities.confidence, excluded.confidence),
                 metadata = entities.metadata || excluded.metadata,
                 updated_at = now()
               returning ${entityReturning}`,
              [
                entity.type, entity.canonicalName, normalizedName, JSON.stringify(entity.aliases),
                entity.description ?? null, input.language, entity.confidence, input.generation
              ]
            );
            const row = result.rows[0];
            if (!row) throw new Error("Graph entity upsert returned no row.");
            const mapped = mapEntity(row);
            entitiesByKey.set(entity.key, mapped);
            entityIds.add(mapped.id);
            for (const chunkId of entity.evidenceChunkIds) {
              const mention = await client.query(
                `insert into entity_mentions (
                   entity_id, source_item_id, chunk_id, source_span_id, surface_text, confidence, metadata
                 ) select $1, $2, c.id, c.source_span_id, $3, $4, $5
                   from chunks c where c.id = $6 and c.source_item_id = $2
                 on conflict (entity_id, chunk_id) do update set
                   surface_text = excluded.surface_text,
                   confidence = greatest(entity_mentions.confidence, excluded.confidence),
                   metadata = excluded.metadata
                 returning id`,
                [mapped.id, input.sourceItemId, entity.canonicalName, entity.confidence, input.generation, chunkId]
              );
              mentionCount += mention.rowCount ?? 0;
            }
          }

          for (const claim of batch.claims) {
            const evidenceChunkId = claim.evidenceChunkIds[0];
            if (!evidenceChunkId) continue;
            const hash = createHash("sha256").update(claim.text.trim()).digest("hex");
            const result = await client.query<{ id: string }>(
              `insert into claims (
                 source_item_id, evidence_chunk_id, source_span_id, text, content_hash, confidence, metadata
               ) select $1, c.id, c.source_span_id, $2, $3, $4, $5
                 from chunks c where c.id = $6 and c.source_item_id = $1
               on conflict (source_item_id, content_hash) do update set
                 text = excluded.text,
                 evidence_chunk_id = excluded.evidence_chunk_id,
                 source_span_id = excluded.source_span_id,
                 confidence = excluded.confidence,
                 metadata = excluded.metadata,
                 updated_at = now()
               returning id`,
              [
                input.sourceItemId, claim.text, hash, claim.confidence,
                { ...input.generation, evidenceChunkIds: claim.evidenceChunkIds }, evidenceChunkId
              ]
            );
            const claimId = result.rows[0]?.id;
            if (!claimId) continue;
            claimCount += 1;
            for (const key of claim.relatedEntityKeys) {
              const entityId = entitiesByKey.get(key)?.id;
              if (!entityId) continue;
              await client.query(
                `insert into claim_entity_links (claim_id, entity_id) values ($1, $2)
                 on conflict (claim_id, entity_id) do nothing`,
                [claimId, entityId]
              );
            }
          }

          for (const relation of batch.relations) {
            const subjectId = entitiesByKey.get(relation.subjectEntityKey)?.id;
            const objectId = entitiesByKey.get(relation.objectEntityKey)?.id;
            if (!subjectId || !objectId) continue;
            for (const chunkId of relation.evidenceChunkIds) {
              const result = await client.query(
                `insert into entity_relations (
                   subject_entity_id, predicate, object_entity_id, source_item_id,
                   evidence_chunk_id, source_span_id, confidence, metadata
                 ) select $1, $2, $3, $4, c.id, c.source_span_id, $5, $6
                   from chunks c where c.id = $7 and c.source_item_id = $4
                 on conflict (source_item_id, subject_entity_id, predicate, object_entity_id, evidence_chunk_id)
                 do update set confidence = excluded.confidence, metadata = excluded.metadata, updated_at = now()
                 returning id`,
                [subjectId, relation.predicate, objectId, input.sourceItemId, relation.confidence, input.generation, chunkId]
              );
              relationCount += result.rowCount ?? 0;
            }
          }
        }

        const linked = await client.query(
          `insert into atomic_note_entity_links (atomic_note_id, entity_id, relation_type, confidence)
           select distinct n.id, m.entity_id, 'about', max(m.confidence)
           from atomic_notes n
           join atomic_note_source_links l on l.atomic_note_id = n.id
           join entity_mentions m on m.chunk_id = l.chunk_id
           where n.created_from_source_item_id = $1
           group by n.id, m.entity_id
           on conflict (atomic_note_id, entity_id) do update set confidence = excluded.confidence
           returning id`,
          [input.sourceItemId]
        );
        await client.query("commit");
        return {
          entityCount: entityIds.size,
          mentionCount,
          claimCount,
          relationCount,
          atomicNoteEntityLinkCount: linked.rowCount ?? 0
        };
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async projectSource(sourceItemId: string): Promise<void> {
      const client = await pool.connect();
      try {
        await initializeAge(client);
        const mentions = await client.query<ProjectionRow>(
          `select entity_id as "entityId", chunk_id as "chunkId", confidence
           from entity_mentions where source_item_id = $1`,
          [sourceItemId]
        );
        const relations = await client.query<RelationProjectionRow>(
          `select id, subject_entity_id as "subjectEntityId", object_entity_id as "objectEntityId", confidence
           from entity_relations where source_item_id = $1`,
          [sourceItemId]
        );
        const claims = await client.query<ClaimProjectionRow>(
          `select c.id, c.evidence_chunk_id as "evidenceChunkId", l.entity_id as "entityId"
           from claims c left join claim_entity_links l on l.claim_id = c.id
           where c.source_item_id = $1`,
          [sourceItemId]
        );
        const atomicLinks = await client.query<AtomicProjectionRow>(
          `select l.atomic_note_id as "atomicNoteId", l.entity_id as "entityId", l.confidence
           from atomic_note_entity_links l
           join atomic_notes n on n.id = l.atomic_note_id
           where n.created_from_source_item_id = $1`,
          [sourceItemId]
        );
        await client.query("begin");
        await writeCypher(client, `MATCH (c:Chunk {sourceItemId: '${uuid(sourceItemId)}'}) DETACH DELETE c RETURN count(c)`);
        await writeCypher(client, `MATCH (c:Claim {sourceItemId: '${uuid(sourceItemId)}'}) DETACH DELETE c RETURN count(c)`);
        await writeCypher(client, `MATCH (n:AtomicNote {sourceItemId: '${uuid(sourceItemId)}'}) DETACH DELETE n RETURN count(n)`);
        await writeCypher(client, `MATCH ()-[r:RELATED]->() WHERE r.sourceItemId = '${uuid(sourceItemId)}' DELETE r RETURN count(r)`);

        for (const mention of mentions.rows) {
          await writeCypher(client, `MERGE (e:Entity {id: '${uuid(mention.entityId)}'}) RETURN e.id`);
          await writeCypher(client, `MERGE (c:Chunk {id: '${uuid(mention.chunkId)}'}) SET c.sourceItemId = '${uuid(sourceItemId)}' RETURN c.id`);
          await writeCypher(client, `MATCH (e:Entity {id: '${uuid(mention.entityId)}'}), (c:Chunk {id: '${uuid(mention.chunkId)}'}) MERGE (e)-[m:MENTIONED_IN {sourceItemId: '${uuid(sourceItemId)}', chunkId: '${uuid(mention.chunkId)}'}]->(c) SET m.confidence = ${score(mention.confidence)} RETURN m.confidence`);
        }
        for (const relation of relations.rows) {
          await writeCypher(client, `MATCH (s:Entity {id: '${uuid(relation.subjectEntityId)}'}), (o:Entity {id: '${uuid(relation.objectEntityId)}'}) MERGE (s)-[r:RELATED {id: '${uuid(relation.id)}'}]->(o) SET r.sourceItemId = '${uuid(sourceItemId)}', r.confidence = ${score(relation.confidence)} RETURN r.id`);
        }
        for (const claim of claims.rows) {
          await writeCypher(client, `MERGE (c:Claim {id: '${uuid(claim.id)}'}) SET c.sourceItemId = '${uuid(sourceItemId)}' RETURN c.id`);
          await writeCypher(client, `MATCH (c:Claim {id: '${uuid(claim.id)}'}), (chunk:Chunk {id: '${uuid(claim.evidenceChunkId)}'}) MERGE (c)-[:SUPPORTED_BY]->(chunk) RETURN c.id`);
          if (claim.entityId) {
            await writeCypher(client, `MATCH (c:Claim {id: '${uuid(claim.id)}'}), (e:Entity {id: '${uuid(claim.entityId)}'}) MERGE (c)-[:ABOUT]->(e) RETURN c.id`);
          }
        }
        for (const link of atomicLinks.rows) {
          await writeCypher(client, `MERGE (n:AtomicNote {id: '${uuid(link.atomicNoteId)}'}) SET n.sourceItemId = '${uuid(sourceItemId)}' RETURN n.id`);
          await writeCypher(client, `MATCH (n:AtomicNote {id: '${uuid(link.atomicNoteId)}'}), (e:Entity {id: '${uuid(link.entityId)}'}) MERGE (n)-[a:ABOUT]->(e) SET a.confidence = ${score(link.confidence)} RETURN a.confidence`);
        }
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async removeSourceProjections(sourceItemIds: string[], entityIds: string[] = []): Promise<void> {
      if (sourceItemIds.length === 0 && entityIds.length === 0) return;
      const client = await pool.connect();
      try {
        await initializeAge(client);
        await client.query("begin");
        for (const sourceItemId of sourceItemIds) {
          await writeCypher(client, `MATCH (c:Chunk {sourceItemId: '${uuid(sourceItemId)}'}) DETACH DELETE c RETURN count(c)`);
          await writeCypher(client, `MATCH (c:Claim {sourceItemId: '${uuid(sourceItemId)}'}) DETACH DELETE c RETURN count(c)`);
          await writeCypher(client, `MATCH (n:AtomicNote {sourceItemId: '${uuid(sourceItemId)}'}) DETACH DELETE n RETURN count(n)`);
          await writeCypher(client, `MATCH ()-[r:RELATED]->() WHERE r.sourceItemId = '${uuid(sourceItemId)}' DELETE r RETURN count(r)`);
        }
        for (const entityId of entityIds) {
          await writeCypher(client, `MATCH (e:Entity {id: '${uuid(entityId)}'}) DETACH DELETE e RETURN count(e)`);
        }
        await client.query("commit");
      } catch (error) {
        await client.query("rollback").catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },

    async searchChunks(input: {
      text: string;
      sourceTypes?: SourceItemType[];
      sourceItemIds?: string[];
      limit?: number;
    }): Promise<SearchEvidenceRecord[]> {
      const seeds = await pool.query<{ id: string; seedScore: number }>(
        `select e.id,
                greatest(
                  similarity(unaccent(e.canonical_name), unaccent($1)),
                  coalesce((select max(similarity(unaccent(alias), unaccent($1)))
                            from jsonb_array_elements_text(e.aliases) alias), 0)
                ) as "seedScore"
         from entities e
         where greatest(
           similarity(unaccent(e.canonical_name), unaccent($1)),
           coalesce((select max(similarity(unaccent(alias), unaccent($1)))
                     from jsonb_array_elements_text(e.aliases) alias), 0)
         ) >= 0.15
         order by "seedScore" desc limit 12`,
        [input.text]
      );
      if (seeds.rows.length === 0) return [];
      const client = await pool.connect();
      try {
        await initializeAge(client);
        const seedIds = seeds.rows.map((seed) => `'${uuid(seed.id)}'`).join(", ");
        const direct = await readCypher<AgDirectRow>(client,
          `MATCH (seed:Entity)-[m:MENTIONED_IN]->(chunk:Chunk) WHERE seed.id IN [${seedIds}] RETURN seed.id, chunk.id, m.confidence`,
          `"seedId" agtype, "chunkId" agtype, "mentionConfidence" agtype`
        );
        const related = await readCypher<AgRelatedRow>(client,
          `MATCH (seed:Entity)-[r:RELATED]-(related:Entity)-[m:MENTIONED_IN]->(chunk:Chunk) WHERE seed.id IN [${seedIds}] RETURN seed.id, chunk.id, r.confidence, m.confidence`,
          `"seedId" agtype, "chunkId" agtype, "relationConfidence" agtype, "mentionConfidence" agtype`
        );
        const seedScores = new Map(seeds.rows.map((seed) => [seed.id, Number(seed.seedScore)]));
        const scores = new Map<string, number>();
        for (const row of direct.rows) {
          const chunkId = agString(row.chunkId);
          const value = (seedScores.get(agString(row.seedId)) ?? 0) * agNumber(row.mentionConfidence);
          scores.set(chunkId, Math.max(scores.get(chunkId) ?? 0, value));
        }
        for (const row of related.rows) {
          const chunkId = agString(row.chunkId);
          const value = (seedScores.get(agString(row.seedId)) ?? 0)
            * agNumber(row.relationConfidence) * agNumber(row.mentionConfidence) * 0.75;
          scores.set(chunkId, Math.max(scores.get(chunkId) ?? 0, value));
        }
        const ranked = [...scores.entries()].sort((left, right) => right[1] - left[1]).slice(0, input.limit ?? 60);
        if (ranked.length === 0) return [];
        const evidence = await pool.query<SearchEvidenceRecord & QueryResultRow>(
          `select s.id as "sourceItemId", s.title as "sourceTitle", s.type as "sourceType",
                  d.id as "documentId", c.id as "chunkId", c.source_span_id as "sourceSpanId",
                  c.content as excerpt, sp.page, sp.source_block_id as "sourceBlockId",
                  sp.bounding_box as "boundingBox", sp.selector,
                  0::double precision as "textScore", 0::double precision as "vectorScore",
                  0::double precision as "graphScore", 0::double precision as "finalScore"
           from chunks c join documents d on d.id = c.document_id
           join source_items s on s.id = c.source_item_id
           left join source_spans sp on sp.id = c.source_span_id
           where c.id = any($1::uuid[])
             and (coalesce(array_length($2::source_item_type[], 1), 0) = 0 or s.type = any($2))
             and (coalesce(array_length($3::uuid[], 1), 0) = 0 or s.id = any($3))`,
          [ranked.map(([chunkId]) => chunkId), input.sourceTypes ?? [], input.sourceItemIds ?? []]
        );
        const byId = new Map(evidence.rows.map((row) => [row.chunkId, row]));
        return ranked.flatMap(([chunkId, graphScore]) => {
          const row = byId.get(chunkId);
          return row ? [{
            ...row,
            page: row.page === null ? null : Number(row.page),
            boundingBox: row.boundingBox === null ? null : asJsonObject(row.boundingBox),
            textScore: 0,
            vectorScore: 0,
            graphScore: Math.max(0, Math.min(1, graphScore)),
            finalScore: Math.max(0, Math.min(1, graphScore))
          }] : [];
        });
      } finally {
        client.release();
      }
    },

    async findAtomicNoteCandidates(noteId: string, limit = 20): Promise<AtomicNoteGraphCandidate[]> {
      const candidates = await scoreAtomicNoteGraphPaths(pool, noteId, null, Math.max(200, limit * 25));
      return [...candidates.entries()]
        .map(([candidateId, candidate]) => ({ noteId: candidateId, ...candidate }))
        .sort((left, right) => right.graphScore - left.graphScore || left.noteId.localeCompare(right.noteId))
        .slice(0, limit);
    },

    async scoreAtomicNoteCandidates(noteId: string, candidateIds: string[]): Promise<Map<string, number>> {
      if (candidateIds.length === 0) return new Map();
      const candidates = await scoreAtomicNoteGraphPaths(pool, noteId, candidateIds);
      return new Map([...candidates].map(([id, candidate]) => [id, candidate.graphScore]));
    },

    async listAtomicNoteElements(noteIds: string[]): Promise<Map<string, AtomicNoteGraphElements>> {
      const result = new Map<string, AtomicNoteGraphElements>();
      for (const noteId of noteIds) result.set(noteId, emptyAtomicNoteElements());
      if (noteIds.length === 0) return result;
      const entityRows = await pool.query<{
        noteId: string; id: string; type: string; name: string; confidence: number;
      }>(
        `select l.atomic_note_id as "noteId", e.id, e.type, e.canonical_name as name, l.confidence
         from atomic_note_entity_links l join entities e on e.id = l.entity_id
         where l.atomic_note_id = any($1::uuid[]) order by e.canonical_name`,
        [noteIds]
      );
      for (const row of entityRows.rows) {
        result.get(row.noteId)?.entities.push({ ...row, confidence: Number(row.confidence) });
      }
      const claimRows = await pool.query<{
        noteId: string; id: string; text: string; confidence: number;
      }>(
        `select distinct l.atomic_note_id as "noteId", c.id, c.text, c.confidence
         from atomic_note_source_links l join claims c on c.evidence_chunk_id = l.chunk_id
         where l.atomic_note_id = any($1::uuid[]) order by c.text`,
        [noteIds]
      );
      for (const row of claimRows.rows) {
        result.get(row.noteId)?.claims.push({ ...row, confidence: Number(row.confidence) });
      }
      const relationRows = await pool.query<{
        noteId: string; id: string; subject: string; predicate: string; object: string; confidence: number;
      }>(
        `select distinct l.atomic_note_id as "noteId", r.id,
                subject.canonical_name as subject, r.predicate,
                object.canonical_name as object, r.confidence
         from atomic_note_source_links l
         join entity_relations r on r.evidence_chunk_id = l.chunk_id
         join entities subject on subject.id = r.subject_entity_id
         join entities object on object.id = r.object_entity_id
         where l.atomic_note_id = any($1::uuid[])
         order by subject.canonical_name, r.predicate, object.canonical_name`,
        [noteIds]
      );
      const relationIndexes = new Map<string, Map<string, number>>();
      for (const row of relationRows.rows) {
        const elements = result.get(row.noteId);
        if (!elements) continue;
        const relation = { ...row, confidence: Number(row.confidence) };
        const relationKey = `${row.subject}\0${row.predicate}\0${row.object}`;
        const indexes = relationIndexes.get(row.noteId) ?? new Map<string, number>();
        relationIndexes.set(row.noteId, indexes);
        const existingIndex = indexes.get(relationKey);
        if (existingIndex === undefined) {
          indexes.set(relationKey, elements.relations.length);
          elements.relations.push(relation);
        } else if (relation.confidence > (elements.relations[existingIndex]?.confidence ?? 0)) {
          elements.relations[existingIndex] = relation;
        }
      }
      return result;
    }
  };
}

async function scoreAtomicNoteGraphPaths(
  pool: PgPool,
  noteId: string,
  candidateIds: string[] | null,
  maxPaths?: number
): Promise<Map<string, Omit<AtomicNoteGraphCandidate, "noteId">>> {
  const client = await pool.connect();
  try {
    await initializeAge(client);
    const targetFilter = candidateIds
      ? ` AND target.id IN [${candidateIds.map((id) => `'${uuid(id)}'`).join(", ")}]`
      : "";
    const pathLimit = maxPaths ? ` LIMIT ${Math.max(1, Math.floor(maxPaths))}` : "";
    const sourceId = uuid(noteId);
    const direct = await readCypher<AgAtomicDirectRow>(client,
      `MATCH (source:AtomicNote {id: '${sourceId}'})-[a:ABOUT]->(entity:Entity)<-[b:ABOUT]-(target:AtomicNote) WHERE target.id <> '${sourceId}'${targetFilter} WITH target, entity, a.confidence * b.confidence AS pathScore ORDER BY pathScore DESC${pathLimit} RETURN target.id, entity.id, pathScore`,
      `"targetId" agtype, "entityId" agtype, "relationConfidence" agtype`
    );
    const related = await readCypher<AgAtomicRelatedRow>(client,
      `MATCH (source:AtomicNote {id: '${sourceId}'})-[a:ABOUT]->(sourceEntity:Entity)-[r:RELATED]-(targetEntity:Entity)<-[b:ABOUT]-(target:AtomicNote) WHERE target.id <> '${sourceId}'${targetFilter} WITH target, sourceEntity, targetEntity, a.confidence * r.confidence * b.confidence * 0.75 AS pathScore ORDER BY pathScore DESC${pathLimit} RETURN target.id, sourceEntity.id, targetEntity.id, pathScore`,
      `"targetId" agtype, "sourceEntityId" agtype, "targetEntityId" agtype, "relationConfidence" agtype`
    );
    const targetIds = [...new Set([
      ...direct.rows.map((row) => agString(row.targetId)),
      ...related.rows.map((row) => agString(row.targetId))
    ])];
    if (targetIds.length === 0) return new Map();
    const activeTargets = await client.query<{ id: string } & QueryResultRow>(
      `select id from atomic_notes where id = any($1::uuid[]) and status <> 'rejected'`,
      [targetIds]
    );
    const allowedTargets = new Set(activeTargets.rows.map((row) => row.id));
    const entityIds = [...new Set([
      ...direct.rows.map((row) => agString(row.entityId)),
      ...related.rows.flatMap((row) => [agString(row.sourceEntityId), agString(row.targetEntityId)])
    ])];
    const frequencyRows = await client.query<{
      entityId: string;
      noteCount: string;
      totalNotes: string;
    } & QueryResultRow>(
      `select links.entity_id as "entityId", count(distinct links.atomic_note_id)::text as "noteCount",
              (select count(*)::text from atomic_notes where status <> 'rejected') as "totalNotes"
       from atomic_note_entity_links links
       join atomic_notes note on note.id = links.atomic_note_id and note.status <> 'rejected'
       where links.entity_id = any($1::uuid[])
       group by links.entity_id`,
      [entityIds]
    );
    const totalNotes = Number(frequencyRows.rows[0]?.totalNotes ?? 0);
    const entityWeights = new Map(frequencyRows.rows.map((row) => [
      row.entityId,
      inverseEntityFrequency(totalNotes, Number(row.noteCount))
    ]));
    const candidates = new Map<string, Omit<AtomicNoteGraphCandidate, "noteId">>();
    const record = (targetId: string, graphScore: number, pathType: AtomicNoteGraphCandidate["pathType"]) => {
      if (!allowedTargets.has(targetId)) return;
      const previous = candidates.get(targetId);
      if (!previous || graphScore > previous.graphScore) {
        candidates.set(targetId, { graphScore: score(graphScore), pathType });
      }
    };
    for (const row of direct.rows) {
      const entityWeight = entityWeights.get(agString(row.entityId)) ?? 0.2;
      record(
        agString(row.targetId),
        agNumber(row.relationConfidence) * entityWeight,
        "shared_entity"
      );
    }
    for (const row of related.rows) {
      const sourceWeight = entityWeights.get(agString(row.sourceEntityId)) ?? 0.2;
      const targetWeight = entityWeights.get(agString(row.targetEntityId)) ?? 0.2;
      record(
        agString(row.targetId),
        agNumber(row.relationConfidence) * Math.sqrt(sourceWeight * targetWeight),
        "related_entity"
      );
    }
    return candidates;
  } finally {
    client.release();
  }
}

export function inverseEntityFrequency(totalNotes: number, linkedNotes: number): number {
  if (totalNotes <= 1 || linkedNotes <= 1) return 1;
  const normalized = Math.log((totalNotes + 1) / (linkedNotes + 1)) / Math.log(totalNotes + 1);
  return Math.max(0.2, Math.min(1, normalized));
}

function emptyAtomicNoteElements(): AtomicNoteGraphElements {
  return { entities: [], claims: [], relations: [] };
}

function mapEntity(row: EntityRow): GraphEntityRecord {
  return {
    ...row,
    aliases: Array.isArray(row.aliases) ? row.aliases.filter((value): value is string => typeof value === "string") : [],
    confidence: Number(row.confidence),
    metadata: asJsonObject(row.metadata),
    createdAt: mapTimestamp(row.createdAt),
    updatedAt: mapTimestamp(row.updatedAt)
  };
}

function normalizeEntityName(value: string): string {
  return value.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").trim().toLocaleLowerCase();
}

async function initializeAge(client: PoolClient): Promise<void> {
  await prepareAge(client);
  const existing = await client.query("select 1 from ag_catalog.ag_graph where name = $1", [graphName]);
  if (existing.rowCount === 0) await client.query("select ag_catalog.create_graph($1)", [graphName]);
}

async function prepareAge(client: PoolClient): Promise<void> {
  await client.query("create extension if not exists age");
  await client.query("load 'age'");
  await client.query(`set search_path = ag_catalog, "$user", public`);
}

async function writeCypher(client: PoolClient, statement: string): Promise<void> {
  await client.query(`select * from cypher('${graphName}', $$ ${statement} $$) as (result agtype)`);
}

function readCypher<T extends QueryResultRow>(client: PoolClient, statement: string, columns: string) {
  return client.query<T>(`select * from cypher('${graphName}', $$ ${statement} $$) as (${columns})`);
}

function uuid(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) {
    throw new Error("Invalid graph UUID.");
  }
  return value;
}

function score(value: number): number {
  return Math.max(0, Math.min(1, Number(value) || 0));
}

function agString(value: unknown): string {
  if (typeof value !== "string") return String(value);
  try {
    const parsed = JSON.parse(value) as unknown;
    return typeof parsed === "string" ? parsed : String(parsed);
  } catch {
    return value.replace(/^"|"$/g, "");
  }
}

function agNumber(value: unknown): number {
  const parsed = Number(typeof value === "string" ? value.replace(/::[a-z]+$/i, "") : value);
  return Number.isFinite(parsed) ? score(parsed) : 0;
}
