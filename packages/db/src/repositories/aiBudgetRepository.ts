import type { QueryResultRow } from "pg";

import type { Queryable } from "./types.js";

/**
 * One provider and model of a month's background remote spend (F4 D14). The RemoteBudget prices it
 * with the versioned price table: the token counts of the calls that reported both, the admission
 * estimates of the calls that did not, and for those with no estimate either (rows written before
 * 0061) the output budget they asked for.
 */
export interface BudgetLedgerEntry {
  provider: string;
  modelId: string;
  /** Calls counted. */
  calls: number;
  /** Input and output tokens of the calls that reported both counts. */
  inputTokens: number;
  outputTokens: number;
  /** Calls missing a count that carry the US$ estimate they were admitted with, and its sum. */
  estimatedCalls: number;
  estimateUsd: number;
  /** Calls missing a count and an estimate, the tokens they did report, and their output budgets. */
  unestimatedCalls: number;
  unestimatedInputTokens: number;
  unestimatedOutputTokens: number;
}

interface LedgerRow extends QueryResultRow {
  provider: string;
  modelId: string;
  calls: string;
  inputTokens: string;
  outputTokens: string;
  estimatedCalls: string;
  estimateUsd: number | null;
  unestimatedCalls: string;
  unestimatedInputTokens: string;
  unestimatedOutputTokens: string;
}

/** The output budget a row is priced at when it has neither usage nor an estimate. */
export const ledgerFallbackOutputTokens = 16_384;

/**
 * The monthly ledger's statement. Its row filter repeats the predicate of the partial index
 * `ai_task_runs_budget_ledger_idx` (0061) word for word, so the planner can use it: background calls
 * on remote lanes, and the unclassified P2/P3 calls written before 0061, each counted once. The
 * Decisions decider's calls count here too (they run on its own remote lane).
 */
export const budgetLedgerStatement = `
  select provider, model_id as "modelId",
    count(*)::text as calls,
    coalesce(sum(input_tokens) filter (where input_tokens is not null and output_tokens is not null), 0)::text
      as "inputTokens",
    coalesce(sum(output_tokens) filter (where input_tokens is not null and output_tokens is not null), 0)::text
      as "outputTokens",
    count(*) filter (where (input_tokens is null or output_tokens is null) and budget_estimate_usd is not null)::text
      as "estimatedCalls",
    sum(budget_estimate_usd) filter (where input_tokens is null or output_tokens is null) as "estimateUsd",
    count(*) filter (where (input_tokens is null or output_tokens is null) and budget_estimate_usd is null)::text
      as "unestimatedCalls",
    coalesce(sum(input_tokens) filter (where output_tokens is null and budget_estimate_usd is null), 0)::text
      as "unestimatedInputTokens",
    coalesce(sum(greatest(coalesce(output_tokens, 0), case
      when parameters->>'maxTokens' ~ '^[0-9]{1,9}$' then (parameters->>'maxTokens')::integer
      else ${ledgerFallbackOutputTokens} end))
      filter (where (input_tokens is null or output_tokens is null) and budget_estimate_usd is null), 0)::text
      as "unestimatedOutputTokens"
  from ai_task_runs
  where lane like 'remote:%' and (budget_class = 'background' or (budget_class is null and priority between 2 and 3))
    and started_at >= $1 and started_at < $2
    -- A DEV cassette replay sent nothing.
    and adapter is distinct from 'cassette-replay'
  group by provider, model_id
  order by provider, model_id`;

export function createAiBudgetRepository(db: Queryable) {
  return {
    /** The background remote spend of the window `[start, end)` (a local month), per provider and model. */
    async monthLedger(window: { start: Date; end: Date }): Promise<BudgetLedgerEntry[]> {
      const result = await db.query<LedgerRow>(budgetLedgerStatement, [window.start, window.end]);
      return result.rows.map((row) => ({
        provider: row.provider,
        modelId: row.modelId,
        calls: Number(row.calls),
        inputTokens: Number(row.inputTokens),
        outputTokens: Number(row.outputTokens),
        estimatedCalls: Number(row.estimatedCalls),
        estimateUsd: Number(row.estimateUsd ?? 0),
        unestimatedCalls: Number(row.unestimatedCalls),
        unestimatedInputTokens: Number(row.unestimatedInputTokens),
        unestimatedOutputTokens: Number(row.unestimatedOutputTokens)
      }));
    }
  };
}
