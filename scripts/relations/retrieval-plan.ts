/**
 * The pure half of `explain-retrieval.ts`: reading an `EXPLAIN (FORMAT JSON)` plan for the gate of
 * `rules/data.md` (an index must serve the query that relies on it) and the statistics the report
 * prints.
 */

export interface PlanNode {
  "Node Type": string;
  "Relation Name"?: string;
  "Index Name"?: string;
  Plans?: PlanNode[];
}

export interface PlanFindings {
  /** Index scans, index-only scans and bitmap index scans, by index name. */
  indexScans: string[];
  /** Relations read by a sequential scan. */
  seqScans: string[];
  /** One line per scan of a relation, for the report. */
  scans: string[];
}

export function summarizePlan(root: PlanNode): PlanFindings {
  const findings: PlanFindings = { indexScans: [], seqScans: [], scans: [] };
  const visit = (node: PlanNode): void => {
    const type = node["Node Type"];
    if (node["Index Name"]) {
      findings.indexScans.push(node["Index Name"]);
      findings.scans.push(`${type} using ${node["Index Name"]}`);
    } else if (type === "Seq Scan" && node["Relation Name"]) {
      findings.seqScans.push(node["Relation Name"]);
      findings.scans.push(`Seq Scan on ${node["Relation Name"]}`);
    }
    for (const child of node.Plans ?? []) visit(child);
  };
  visit(root);
  return findings;
}

export interface GateContext {
  /** Estimated rows of the table the gate watches; a table this small is read faster in one pass. */
  rows: number;
  /** The gate starts at this many rows. */
  minRows: number;
}

/**
 * The text query must reach `atomic_notes` through both GIN indexes (a BitmapOr of the full-text
 * match and the trigram match) and never read it sequentially.
 */
export function textPlanProblems(findings: PlanFindings, context: GateContext): string[] {
  if (context.rows < context.minRows) return [];
  const problems: string[] = [];
  for (const index of ["atomic_notes_search_tsv_idx", "atomic_notes_title_trgm_idx"])
    if (!findings.indexScans.includes(index)) problems.push(`no scan of ${index}`);
  for (const table of findings.seqScans)
    if (table === "atomic_notes") problems.push("sequential scan of atomic_notes");
  return problems;
}

/**
 * The vector query must order by an HNSW index of its dimension table and read neither that table
 * nor `atomic_notes` sequentially. The partial index of migration 0058 is the one written for it;
 * where note vectors are nearly all the table holds the planner may price the global index of 0001
 * and 0008 the same, and both serve the query.
 */
export function vectorPlanProblems(
  findings: PlanFindings,
  dimensions: number,
  context: GateContext
): string[] {
  if (context.rows < context.minRows) return [];
  const problems: string[] = [];
  const indexes = [
    `embeddings_${dimensions}_note_hnsw_idx`,
    `embeddings_${dimensions}_embedding_hnsw_idx`
  ];
  if (!indexes.some((index) => findings.indexScans.includes(index)))
    problems.push(`no scan of ${indexes[0]}`);
  for (const table of findings.seqScans)
    if (table === "atomic_notes" || table === `embeddings_${dimensions}`)
      problems.push(`sequential scan of ${table}`);
  return problems;
}

/** Nearest-rank percentile of an ascending list. */
export function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) return Number.NaN;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(fraction * sorted.length) - 1))]!;
}

export interface Distribution {
  count: number;
  p50: number;
  p95: number;
  p99: number;
  max: number;
}

export function summarize(values: readonly number[]): Distribution {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    count: sorted.length,
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    p99: percentile(sorted, 0.99),
    max: sorted.at(-1) ?? Number.NaN
  };
}

/** Share of the first `k` of `reference` that the first `k` of `candidate` also hold. */
export function overlapAtK(candidate: readonly string[], reference: readonly string[], k: number) {
  const wanted = reference.slice(0, k);
  if (wanted.length === 0) return 1;
  const held = new Set(candidate.slice(0, k));
  return wanted.filter((id) => held.has(id)).length / wanted.length;
}

export function mean(values: readonly number[]): number {
  return values.length === 0
    ? Number.NaN
    : values.reduce((sum, value) => sum + value, 0) / values.length;
}

/**
 * Reciprocal rank fusion of rankings (best first), the way note matching fuses its text, vector
 * and graph lists: `sum(1 / (k + rank))`, ties by order of first appearance.
 */
export function fuseRankings(rankings: ReadonlyArray<readonly string[]>, k: number): string[] {
  const scores = new Map<string, number>();
  for (const ranking of rankings)
    ranking.forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + 1 / (k + index + 1)));
  return [...scores].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}
