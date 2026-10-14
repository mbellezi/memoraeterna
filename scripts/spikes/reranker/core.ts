/**
 * Shared evaluation logic for Spike A: turns per-row scores into root-level and note-level
 * metrics on the tuning and held-out partitions of the matching benchmark.
 *
 * Primary candidate sets (the pipeline's own shortlists, 20 candidates per note):
 *   tuning   the `economy` phase rows (frozen configuration, tuning notes as sources)
 *   holdout  the `validate` phase rows (held-out notes as sources, whole library as candidates)
 */
import type { Dataset, DatasetNote, DatasetRow, Partition, Phase } from "./dataset.js";
import {
  auc,
  labelledScores,
  pairKey,
  rootPairScores,
  type LabelledScores,
  type RootRow
} from "./metrics.js";

/** The old judge's own verdict: `rerank_score >= minRerankScore` of the frozen configuration. */
export const oldJudgeYesAt = 0.65;

export const primaryPhase: Record<Partition, Phase> = { tuning: "economy", holdout: "validate" };

export interface Context {
  dataset: Dataset;
  noteById: Map<string, DatasetNote>;
  labelKeys: Record<Partition, { expected: string[]; forbidden: string[] }>;
  rowsByPhase: Map<Phase, DatasetRow[]>;
}

export function buildContext(dataset: Dataset): Context {
  const keys = (partition: Partition, kind: "expected" | "forbidden"): string[] =>
    dataset.labels
      .filter((label) => label.partition === partition && label.kind === kind)
      .map((label) => pairKey(...label.pair));
  const rowsByPhase = new Map<Phase, DatasetRow[]>();
  for (const row of dataset.rows) {
    const list = rowsByPhase.get(row.phase) ?? [];
    list.push(row);
    rowsByPhase.set(row.phase, list);
  }
  return {
    dataset,
    noteById: new Map(dataset.notes.map((note) => [note.id, note])),
    labelKeys: {
      tuning: { expected: keys("tuning", "expected"), forbidden: keys("tuning", "forbidden") },
      holdout: { expected: keys("holdout", "expected"), forbidden: keys("holdout", "forbidden") }
    },
    rowsByPhase
  };
}

export type RowScore = (row: DatasetRow) => number;

export function pairId(query: string, doc: string): string {
  return `${query}|${doc}`;
}

/** Looks a reranker's log-odds up by (query note, candidate note), in either direction. */
export function logOddsLookup(
  pairs: ReadonlyArray<readonly [string, string]>,
  logOdds: readonly number[]
): (query: string, doc: string) => number {
  const map = new Map<string, number>();
  pairs.forEach(([query, doc], index) => map.set(pairId(query, doc), logOdds[index]!));
  return (query, doc) => {
    const value = map.get(pairId(query, doc));
    if (value === undefined) throw new Error(`No score for pair ${query} -> ${doc}`);
    return value;
  };
}

export interface SplitEvaluation {
  partition: Partition;
  rows: DatasetRow[];
  rootScores: Map<string, number>;
  labelled: LabelledScores;
  rootAuc: number | null;
}

export function evaluateSplit(
  context: Context,
  partition: Partition,
  score: RowScore
): SplitEvaluation {
  const rows = context.rowsByPhase.get(primaryPhase[partition]) ?? [];
  const rootRows: RootRow[] = rows.map((row) => ({
    rootA: context.noteById.get(row.query)!.root,
    rootB: context.noteById.get(row.doc)!.root,
    score: score(row)
  }));
  const rootScores = rootPairScores(rootRows);
  const labelled = labelledScores(
    rootScores,
    context.labelKeys[partition].expected,
    context.labelKeys[partition].forbidden
  );
  return {
    partition,
    rows,
    rootScores,
    labelled,
    rootAuc: auc(labelled.expected, labelled.forbidden)
  };
}

/** Note-level AUC of `score` against the old judge's yes/no verdict (agreement, not truth). */
export function aucVersusOldJudge(
  rows: readonly DatasetRow[],
  score: RowScore,
  verdict: "llm-yes" | "accepted"
): number | null {
  const isYes = (row: DatasetRow): boolean =>
    verdict === "accepted" ? row.accepted : row.oldLlm >= oldJudgeYesAt;
  return auc(rows.filter(isYes).map(score), rows.filter((row) => !isYes(row)).map(score));
}
