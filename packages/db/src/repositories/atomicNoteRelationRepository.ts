import type { QueryResultRow } from "pg";

import { asJsonObject, mapTimestamp } from "./sql.js";
import type {
  AtomicNoteRelationRecord,
  AtomicNoteRelationStatus,
  JsonObject,
  Queryable
} from "./types.js";

interface AtomicNoteRelationRow extends QueryResultRow {
  id: string;
  sourceAtomicNoteId: string;
  targetAtomicNoteId: string;
  relationType: string;
  vectorScore: number | null;
  graphScore: number | null;
  rerankScore: number | null;
  finalScore: number;
  explanation: string;
  status: AtomicNoteRelationStatus;
  matchingProfileId: string | null;
  matchingModel: string | null;
  metadata: unknown;
  createdAt: unknown;
  updatedAt: unknown;
}

const returning = `id, source_atomic_note_id as "sourceAtomicNoteId",
  target_atomic_note_id as "targetAtomicNoteId", relation_type as "relationType",
  vector_score as "vectorScore", graph_score as "graphScore",
  rerank_score as "rerankScore", final_score as "finalScore", explanation,
  status, matching_profile_id as "matchingProfileId", matching_model as "matchingModel",
  metadata, created_at as "createdAt", updated_at as "updatedAt"`;

const joinedReturning = `relation.id,
  relation.source_atomic_note_id as "sourceAtomicNoteId",
  relation.target_atomic_note_id as "targetAtomicNoteId",
  relation.relation_type as "relationType", relation.vector_score as "vectorScore",
  relation.graph_score as "graphScore", relation.rerank_score as "rerankScore",
  relation.final_score as "finalScore", relation.explanation, relation.status,
  relation.matching_profile_id as "matchingProfileId",
  relation.matching_model as "matchingModel", relation.metadata,
  relation.created_at as "createdAt", relation.updated_at as "updatedAt"`;

function mapRelation(row: AtomicNoteRelationRow): AtomicNoteRelationRecord {
  return {
    ...row,
    vectorScore: row.vectorScore === null ? null : Number(row.vectorScore),
    graphScore: row.graphScore === null ? null : Number(row.graphScore),
    rerankScore: row.rerankScore === null ? null : Number(row.rerankScore),
    finalScore: Number(row.finalScore),
    metadata: asJsonObject(row.metadata),
    createdAt: mapTimestamp(row.createdAt),
    updatedAt: mapTimestamp(row.updatedAt)
  };
}

export function createAtomicNoteRelationRepository(db: Queryable) {
  return {
    async upsert(input: {
      sourceAtomicNoteId: string;
      targetAtomicNoteId: string;
      relationType?: string;
      vectorScore?: number | null;
      graphScore?: number | null;
      rerankScore?: number | null;
      finalScore: number;
      explanation: string;
      status?: AtomicNoteRelationStatus;
      matchingProfileId?: string | null;
      matchingModel?: string | null;
      metadata?: JsonObject;
    }): Promise<AtomicNoteRelationRecord> {
      if (input.sourceAtomicNoteId === input.targetAtomicNoteId) {
        throw new Error("Atomic note relation cannot point to itself.");
      }
      const [sourceId, targetId] = [input.sourceAtomicNoteId, input.targetAtomicNoteId].sort();
      const result = await db.query<AtomicNoteRelationRow>(
        `insert into atomic_note_relations (
           source_atomic_note_id, target_atomic_note_id, relation_type,
           vector_score, graph_score, rerank_score, final_score, explanation,
           status, matching_profile_id, matching_model, metadata
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         on conflict (source_atomic_note_id, target_atomic_note_id) do update set
           relation_type = excluded.relation_type,
           vector_score = excluded.vector_score,
           graph_score = excluded.graph_score,
           rerank_score = excluded.rerank_score,
           final_score = excluded.final_score,
           explanation = excluded.explanation,
           matching_profile_id = excluded.matching_profile_id,
           matching_model = excluded.matching_model,
           metadata = excluded.metadata,
           updated_at = now()
         returning ${returning}`,
        [
          sourceId,
          targetId,
          input.relationType ?? "related",
          input.vectorScore ?? null,
          input.graphScore ?? null,
          input.rerankScore ?? null,
          input.finalScore,
          input.explanation,
          input.status ?? "pending_review",
          input.matchingProfileId ?? null,
          input.matchingModel ?? null,
          input.metadata ?? {}
        ]
      );
      const row = result.rows[0];
      if (!row) throw new Error("Atomic note relation upsert returned no row.");
      return mapRelation(row);
    },

    async listBySourceItem(sourceItemId: string): Promise<Array<AtomicNoteRelationRecord & {
      sourceStatus: string;
      targetStatus: string;
      sourceTitle: string;
      targetTitle: string;
    }>> {
      const result = await db.query<AtomicNoteRelationRow & {
        sourceStatus: string;
        targetStatus: string;
        sourceTitle: string;
        targetTitle: string;
      }>(
        `select ${joinedReturning},
                source.status as "sourceStatus", target.status as "targetStatus",
                source.title as "sourceTitle", target.title as "targetTitle"
         from atomic_note_relations relation
         join atomic_notes source on source.id = relation.source_atomic_note_id
         join atomic_notes target on target.id = relation.target_atomic_note_id
         where source.created_from_source_item_id = $1 or target.created_from_source_item_id = $1
         order by relation.final_score desc`,
        [sourceItemId]
      );
      return result.rows.map((row) => ({
        ...mapRelation(row),
        sourceStatus: row.sourceStatus,
        targetStatus: row.targetStatus,
        sourceTitle: row.sourceTitle,
        targetTitle: row.targetTitle
      }));
    }
  };
}
