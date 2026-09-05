import type { QueryResultRow } from "pg";

import { asJsonObject, mapTimestamp } from "./sql.js";
import type { JsonObject, Queryable, SourceSummaryRecord } from "./types.js";

interface SourceSummaryRow extends QueryResultRow {
  id: string;
  generationId: string | null;
  isCurrent: boolean;
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

const returning = `id, generation_id as "generationId", is_current as "isCurrent",
  source_item_id as "sourceItemId", summary, language,
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

export function createSourceSummaryRepository(db: TransactionPool) {
  return {
    async create(input: {
      sourceItemId: string;
      generationId?: string;
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
      const values = [
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
        input.metadata ?? {},
        input.generationId ?? null
      ];
      const insertCurrent = async (connection: Queryable): Promise<SourceSummaryRecord> => {
        const result = await connection.query<SourceSummaryRow>(
          `insert into source_summaries (
             source_item_id, summary, language, profile_id, ai_task_run_id,
             provider, model, runtime, prompt_version, input_hash, output_hash, metadata, generation_id, is_current
           ) values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, true)
           returning ${returning}`,
          values
        );
        const row = result.rows[0];
        if (!row) throw new Error("Source summary insert returned no row.");
        return mapSummary(row);
      };
      for (let attempt = 0; attempt < 3; attempt += 1) {
        const client = await db.connect();
        try {
          await client.query("begin");
          await client.query("select pg_advisory_xact_lock(hashtextextended($1::text, 0))", [input.sourceItemId]);
          await client.query(
            "update source_summaries set is_current = false where source_item_id = $1 and is_current = true",
            [input.sourceItemId]
          );
          const summary = await insertCurrent(client);
          await client.query("update source_items set metadata = metadata - 'summaryStale' where id = $1", [input.sourceItemId]);
          await client.query("commit");
          return summary;
        } catch (error) {
          await client.query("rollback").catch(() => undefined);
          if (!isCurrentSummaryConflict(error) || attempt === 2) throw error;
        } finally {
          client.release();
        }
      }
      throw new Error("Source summary insert retry exhausted.");
    },

    async listBySourceItem(sourceItemId: string): Promise<SourceSummaryRecord[]> {
      const result = await db.query<SourceSummaryRow>(
        `select ${returning} from source_summaries
         where source_item_id = $1 order by generated_at desc`,
        [sourceItemId]
      );
      return result.rows.map(mapSummary);
    },

    async clearCurrent(sourceItemId: string): Promise<void> {
      await db.query(
        "update source_summaries set is_current = false where source_item_id = $1 and is_current = true",
        [sourceItemId]
      );
    }
  };
}

interface TransactionClient extends Queryable {
  release(): void;
}

interface TransactionPool extends Queryable {
  connect(): Promise<TransactionClient>;
}

function isCurrentSummaryConflict(error: unknown): boolean {
  return typeof error === "object" && error !== null
    && "code" in error && error.code === "23505"
    && "constraint" in error && error.constraint === "source_summaries_current_source_uidx";
}
