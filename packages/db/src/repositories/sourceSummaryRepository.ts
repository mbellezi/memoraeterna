import type { QueryResultRow } from "pg";

import { asJsonObject, mapTimestamp } from "./sql.js";
import type { JsonObject, Queryable, SourceSummaryRecord } from "./types.js";

interface SourceSummaryRow extends QueryResultRow {
  id: string;
  sourceItemId: string;
  summary: string;
  language: string;
  profileId: string | null;
  aiTaskRunId: string | null;
  provider: string;
  model: string;
  runtime: string;
  promptVersion: string;
  inputHash: string;
  outputHash: string;
  generatedAt: unknown;
  metadata: unknown;
  createdAt: unknown;
}

const returning = `id, source_item_id as "sourceItemId", summary, language,
  profile_id as "profileId", ai_task_run_id as "aiTaskRunId", provider, model,
  runtime, prompt_version as "promptVersion", input_hash as "inputHash",
  output_hash as "outputHash", generated_at as "generatedAt", metadata,
  created_at as "createdAt"`;

function mapSummary(row: SourceSummaryRow): SourceSummaryRecord {
  return {
    ...row,
    metadata: asJsonObject(row.metadata),
    generatedAt: mapTimestamp(row.generatedAt),
    createdAt: mapTimestamp(row.createdAt)
  };
}

export function createSourceSummaryRepository(db: Queryable) {
  return {
    async create(input: {
      sourceItemId: string;
      summary: string;
      language?: string;
      profileId?: string | null;
      aiTaskRunId?: string | null;
      provider: string;
      model: string;
      runtime: string;
      promptVersion: string;
      inputHash: string;
      outputHash: string;
      metadata?: JsonObject;
    }): Promise<SourceSummaryRecord> {
      const result = await db.query<SourceSummaryRow>(
        `insert into source_summaries (
           source_item_id, summary, language, profile_id, ai_task_run_id,
           provider, model, runtime, prompt_version, input_hash, output_hash, metadata
         ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         returning ${returning}`,
        [
          input.sourceItemId,
          input.summary,
          input.language ?? "und",
          input.profileId ?? null,
          input.aiTaskRunId ?? null,
          input.provider,
          input.model,
          input.runtime,
          input.promptVersion,
          input.inputHash,
          input.outputHash,
          input.metadata ?? {}
        ]
      );
      const row = result.rows[0];
      if (!row) throw new Error("Source summary insert returned no row.");
      return mapSummary(row);
    },

    async listBySourceItem(sourceItemId: string): Promise<SourceSummaryRecord[]> {
      const result = await db.query<SourceSummaryRow>(
        `select ${returning} from source_summaries
         where source_item_id = $1 order by generated_at desc`,
        [sourceItemId]
      );
      return result.rows.map(mapSummary);
    }
  };
}
