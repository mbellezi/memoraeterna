import { summarize, type Distribution } from "../ask/bench-lib.js";
import type { OmniQuery, OmniQueryKind } from "./omni-queries.js";

/**
 * The pure half of `omni-bench.ts` (F5 T128): the latency report of the timed runs and the EXPLAIN
 * gate over a plan. The script times `search.omni` in quick mode and explains its statement for
 * every query of the set.
 */

/** A table at or above this many rows must not be read by a sequential scan (spec 3.4). */
export const seqScanRowLimit = 10_000;
/** X3(a): the service p95 expected for quick mode, reported against, never a failure (calibrated). */
export const expectedQuickP95Ms = 60;

export type { Distribution };

export interface TimedQuery {
  query: OmniQuery;
  /** Wall-clock milliseconds of each timed run, warm-up excluded. */
  runsMs: number[];
}

export interface LatencyReport {
  /** Every timed run of every query. */
  all: Distribution;
  /** The median of each query's runs: one value per query. */
  medianPerQuery: Distribution;
  byKind: Partial<Record<OmniQueryKind, Distribution>>;
  /** By the query's length in characters. */
  byLength: Record<string, Distribution>;
  /** The slowest queries by median, for the EXPLAIN ANALYZE pass. */
  slowest: { kind: OmniQueryKind; query: string; medianMs: number }[];
}

/**
 * p50 and p95 are nearest-rank percentiles (the 95th of 100 runs is the 95th smallest), as every F4
 * and F5 benchmark reports them.
 */
export function latencyReport(timed: readonly TimedQuery[], slowestCount = 3): LatencyReport {
  const medianOf = (runs: readonly number[]) => summarize(runs).p50;
  const groups = <K extends string>(key: (item: TimedQuery) => K) => {
    const grouped = new Map<K, number[]>();
    for (const item of timed)
      grouped.set(key(item), [...(grouped.get(key(item)) ?? []), ...item.runsMs]);
    return grouped;
  };
  const byKind: LatencyReport["byKind"] = {};
  for (const [kind, runs] of groups((item) => item.query.kind)) byKind[kind] = summarize(runs);
  const byLength: LatencyReport["byLength"] = {};
  for (const [length, runs] of [...groups((item) => String([...item.query.query].length))].toSorted(
    ([a], [b]) => Number(a) - Number(b)
  ))
    byLength[length] = summarize(runs);
  return {
    all: summarize(timed.flatMap((item) => item.runsMs)),
    medianPerQuery: summarize(timed.map((item) => medianOf(item.runsMs))),
    byKind,
    byLength,
    slowest: timed
      .map((item) => ({
        kind: item.query.kind,
        query: item.query.query,
        medianMs: medianOf(item.runsMs)
      }))
      .toSorted((a, b) => b.medianMs - a.medianMs || a.query.localeCompare(b.query))
      .slice(0, slowestCount)
  };
}

/** One node of `EXPLAIN (FORMAT JSON)`; only the fields the gate reads. */
export interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
  [key: string]: unknown;
}

export interface ExplainedArm {
  arm: string;
  table: string;
  index: string;
}

export type ArmStatus = "index" | "small-table" | "seq-scan" | "index-unused";

export interface ArmPlanResult extends ExplainedArm {
  status: ArmStatus;
  rows: number;
}

export interface PlanAnalysis {
  /** Sequential scans of the plan, with the table's row count. */
  seqScans: { table: string; rows: number }[];
  indexes: string[];
  arms: ArmPlanResult[];
  /** Why the plan fails the gate; empty when it passes. */
  failures: string[];
}

function walk(node: PlanNode, visit: (node: PlanNode) => void): void {
  visit(node);
  for (const child of node.Plans ?? []) walk(child, visit);
}

/**
 * The gate over one plan. A sequential scan of a table of `limit` rows or more fails, and so does
 * an arm whose table is that large and whose index the plan does not use. A table below the limit
 * may be scanned (`small-table`); that is the planner's right on 600 rows.
 */
export function analyzePlan(
  plan: PlanNode,
  rowCounts: ReadonlyMap<string, number>,
  arms: readonly ExplainedArm[],
  limit = seqScanRowLimit
): PlanAnalysis {
  const seqScans: PlanAnalysis["seqScans"] = [];
  const indexes = new Set<string>();
  walk(plan, (node) => {
    if (node["Index Name"]) indexes.add(node["Index Name"]);
    if (/Seq Scan$/u.test(node["Node Type"]) && node["Relation Name"])
      seqScans.push({
        table: node["Relation Name"],
        rows: rowCounts.get(node["Relation Name"]) ?? 0
      });
  });
  const failures: string[] = [];
  for (const scan of seqScans)
    if (scan.rows >= limit)
      failures.push(`Seq Scan on ${scan.table} (${scan.rows.toLocaleString("en-US")} rows)`);
  const results = arms.map((arm): ArmPlanResult => {
    const rows = rowCounts.get(arm.table) ?? 0;
    const scanned = seqScans.some((scan) => scan.table === arm.table);
    const status: ArmStatus = indexes.has(arm.index)
      ? "index"
      : rows < limit
        ? "small-table"
        : scanned
          ? "seq-scan"
          : "index-unused";
    if (status === "index-unused")
      failures.push(`${arm.arm} on ${arm.table} does not use ${arm.index}`);
    return { ...arm, status, rows };
  });
  return {
    seqScans,
    indexes: [...indexes].toSorted(),
    arms: results,
    failures: [...new Set(failures)]
  };
}

export interface ArmSummary extends ExplainedArm {
  rows: number;
  /** Queries whose plan used the index, scanned a small table, scanned a large one or skipped the index. */
  counts: Record<ArmStatus, number>;
  /** The first query that failed, for the report. */
  firstFailure: string | null;
}

export interface ExplainSummary {
  explained: number;
  arms: ArmSummary[];
  /** Distinct failures with how many queries hit each and the first such query. */
  failures: { reason: string; queries: number; example: string; examples: string[] }[];
  passed: boolean;
}

/** Folds the per-query analyses into the per-arm table and the failure list of the report. */
export function summarizeExplain(
  analyses: readonly { query: string; analysis: PlanAnalysis }[]
): ExplainSummary {
  const arms = new Map<string, ArmSummary>();
  const failures = new Map<
    string,
    { reason: string; queries: number; example: string; examples: string[] }
  >();
  for (const { query, analysis } of analyses) {
    for (const result of analysis.arms) {
      const key = `${result.arm}|${result.table}|${result.index}`;
      const summary = arms.get(key) ?? {
        arm: result.arm,
        table: result.table,
        index: result.index,
        rows: result.rows,
        counts: { index: 0, "small-table": 0, "seq-scan": 0, "index-unused": 0 },
        firstFailure: null
      };
      summary.counts[result.status] += 1;
      if (
        summary.firstFailure === null &&
        (result.status === "seq-scan" || result.status === "index-unused")
      )
        summary.firstFailure = query;
      arms.set(key, summary);
    }
    for (const reason of analysis.failures) {
      const known = failures.get(reason);
      if (known) {
        known.queries += 1;
        if (known.examples.length < 8) known.examples.push(query);
      } else failures.set(reason, { reason, queries: 1, example: query, examples: [query] });
    }
  }
  return {
    explained: analyses.length,
    arms: [...arms.values()],
    failures: [...failures.values()],
    passed: failures.size === 0 && analyses.length > 0
  };
}
