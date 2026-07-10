import type { QueryResultRow } from "pg";

import { asJsonObject, mapTimestamp } from "./sql.js";
import type { JsonObject, Queryable } from "./types.js";

export interface SimilarityDebugResultInput {
  targetType: "chunk" | "atomic_note";
  targetId: string;
  targetLabel?: string | null;
  finalRank: number;
  textRank?: number | null;
  vectorRank?: number | null;
  graphRank?: number | null;
  textScore?: number | null;
  vectorScore?: number | null;
  metadataScore?: number | null;
  graphScore?: number | null;
  rerankScore?: number | null;
  fusionScore?: number | null;
  finalScore: number;
  passedThreshold?: boolean | null;
  explanation?: string | null;
  metadata?: JsonObject;
}

export interface SimilarityDebugRunInput {
  kind: "chunk_search" | "atomic_note_matching";
  queryText: string;
  queryTargetId?: string | null;
  mode: string;
  model?: string | null;
  dimensions?: number | null;
  requestedLimit: number;
  strategy: string;
  metadata?: JsonObject;
  results: SimilarityDebugResultInput[];
}

export interface SimilarityDebugResultRecord extends SimilarityDebugResultInput {
  id: string;
  runId: string;
  createdAt: Date;
}

export interface SimilarityDebugRunRecord extends Omit<SimilarityDebugRunInput, "results"> {
  id: string;
  createdAt: Date;
  results: SimilarityDebugResultRecord[];
}

interface RunRow extends QueryResultRow {
  id: string;
  kind: SimilarityDebugRunInput["kind"];
  queryText: string;
  queryTargetId: string | null;
  mode: string;
  model: string | null;
  dimensions: number | null;
  requestedLimit: number;
  strategy: string;
  metadata: unknown;
  createdAt: unknown;
}

interface ResultRow extends QueryResultRow {
  id: string;
  runId: string;
  targetType: SimilarityDebugResultInput["targetType"];
  targetId: string;
  targetLabel: string | null;
  finalRank: number;
  textRank: number | null;
  vectorRank: number | null;
  graphRank: number | null;
  textScore: number | null;
  vectorScore: number | null;
  metadataScore: number | null;
  graphScore: number | null;
  rerankScore: number | null;
  fusionScore: number | null;
  finalScore: number;
  passedThreshold: boolean | null;
  explanation: string | null;
  metadata: unknown;
  createdAt: unknown;
}

const runReturning = `id, kind, query_text as "queryText", query_target_id as "queryTargetId",
  mode, model, dimensions, requested_limit as "requestedLimit", strategy, metadata,
  created_at as "createdAt"`;

const resultReturning = `id, run_id as "runId", target_type as "targetType", target_id as "targetId",
  target_label as "targetLabel", final_rank as "finalRank", text_rank as "textRank",
  vector_rank as "vectorRank", graph_rank as "graphRank", text_score as "textScore", vector_score as "vectorScore",
  metadata_score as "metadataScore", graph_score as "graphScore", rerank_score as "rerankScore", fusion_score as "fusionScore",
  final_score as "finalScore", passed_threshold as "passedThreshold", explanation, metadata,
  created_at as "createdAt"`;

function mapResult(row: ResultRow): SimilarityDebugResultRecord {
  return {
    ...row,
    finalRank: Number(row.finalRank),
    textRank: numberOrNull(row.textRank),
    vectorRank: numberOrNull(row.vectorRank),
    graphRank: numberOrNull(row.graphRank),
    textScore: numberOrNull(row.textScore),
    vectorScore: numberOrNull(row.vectorScore),
    metadataScore: numberOrNull(row.metadataScore),
    graphScore: numberOrNull(row.graphScore),
    rerankScore: numberOrNull(row.rerankScore),
    fusionScore: numberOrNull(row.fusionScore),
    finalScore: Number(row.finalScore),
    metadata: asJsonObject(row.metadata),
    createdAt: mapTimestamp(row.createdAt)
  };
}

function mapRun(row: RunRow, results: SimilarityDebugResultRecord[]): SimilarityDebugRunRecord {
  return {
    ...row,
    dimensions: numberOrNull(row.dimensions),
    requestedLimit: Number(row.requestedLimit),
    metadata: asJsonObject(row.metadata),
    createdAt: mapTimestamp(row.createdAt),
    results
  };
}

export function createSimilarityDebugRepository(db: Queryable) {
  return {
    async record(input: SimilarityDebugRunInput): Promise<string> {
      const run = await db.query<RunRow>(
        `insert into similarity_debug_runs (
           kind, query_text, query_target_id, mode, model, dimensions,
           requested_limit, strategy, metadata
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         returning ${runReturning}`,
        [
          input.kind, input.queryText, input.queryTargetId ?? null, input.mode,
          input.model ?? null, input.dimensions ?? null, input.requestedLimit,
          input.strategy, input.metadata ?? {}
        ]
      );
      const runId = run.rows[0]?.id;
      if (!runId) throw new Error("Similarity debug run insert returned no row.");
      if (input.results.length > 0) {
        const values: unknown[] = [];
        const rows = input.results.map((result, index) => {
          const offset = index * 18;
          values.push(
            runId, result.targetType, result.targetId, result.targetLabel ?? null,
            result.finalRank, result.textRank ?? null, result.vectorRank ?? null, result.graphRank ?? null,
            result.textScore ?? null, result.vectorScore ?? null, result.metadataScore ?? null, result.graphScore ?? null,
            result.rerankScore ?? null, result.fusionScore ?? null, result.finalScore,
            result.passedThreshold ?? null, result.explanation ?? null, result.metadata ?? {}
          );
          return `(${Array.from({ length: 18 }, (_, valueIndex) => `$${offset + valueIndex + 1}`).join(", ")})`;
        });
        await db.query(
          `insert into similarity_debug_results (
             run_id, target_type, target_id, target_label, final_rank, text_rank,
             vector_rank, graph_rank, text_score, vector_score, metadata_score, graph_score, rerank_score,
             fusion_score, final_score, passed_threshold, explanation, metadata
           ) values ${rows.join(", ")}`,
          values
        );
      }
      return runId;
    },

    async list(limit = 30): Promise<SimilarityDebugRunRecord[]> {
      const runs = await db.query<RunRow>(
        `select ${runReturning} from similarity_debug_runs order by created_at desc limit $1`,
        [limit]
      );
      if (runs.rows.length === 0) return [];
      const results = await db.query<ResultRow>(
        `select ${resultReturning} from similarity_debug_results
         where run_id = any($1::uuid[]) order by run_id, final_rank`,
        [runs.rows.map((run) => run.id)]
      );
      const byRun = new Map<string, SimilarityDebugResultRecord[]>();
      for (const row of results.rows) {
        const mapped = mapResult(row);
        const entries = byRun.get(mapped.runId) ?? [];
        entries.push(mapped);
        byRun.set(mapped.runId, entries);
      }
      return runs.rows.map((run) => mapRun(run, byRun.get(run.id) ?? []));
    },

    async clear(): Promise<number> {
      const result = await db.query<{ count: string }>(
        `with deleted as (delete from similarity_debug_runs returning 1)
         select count(*)::text as count from deleted`
      );
      return Number(result.rows[0]?.count ?? 0);
    }
  };
}

function numberOrNull(value: number | null): number | null {
  return value === null ? null : Number(value);
}
