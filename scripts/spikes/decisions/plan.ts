/**
 * Which directed pairs each stage scores, and how they are grouped into requests.
 *
 * Spike A scored every judged row of the old pipeline plus its reverse. Stages here cover the same
 * pairs, one request per (query note, chunk of at most 20 candidates):
 *
 *   tuning-forward   `economy` rows: query = source note, candidates = its old shortlist
 *   tuning-reverse   the reverse (candidate -> query) of those rows, grouped by the old candidate
 *   holdout-forward  `validate` rows (held-out source notes against the whole library)
 *   holdout-reverse  the reverse of those rows
 *   extra            every other directed pair of Spike A's `all` set (baseline/coverage rows and
 *                    their reverses), used only for direction stability
 *
 * A directed pair is scored once, in the first stage that contains it.
 */
import type { Dataset, DatasetRow, Phase } from "../reranker/dataset.js";

import { maxCandidatesPerRequest } from "./design.js";

export const stageNames = [
  "tuning-forward",
  "tuning-reverse",
  "holdout-forward",
  "holdout-reverse",
  "extra"
] as const;
export type StageName = (typeof stageNames)[number];

export const heldOutStages: readonly StageName[] = ["holdout-forward", "holdout-reverse"];

export interface PlannedJob {
  key: string;
  stage: StageName;
  queryId: string;
  candidateIds: string[];
}

const pairId = (query: string, doc: string): string => `${query}|${doc}`;

function directedPairs(rows: readonly DatasetRow[], phase: Phase): Array<[string, string]> {
  const seen = new Map<string, [string, string]>();
  for (const row of rows) {
    if (row.phase === phase) seen.set(pairId(row.query, row.doc), [row.query, row.doc]);
  }
  return [...seen.values()];
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const parts = Math.ceil(items.length / size);
  const each = Math.ceil(items.length / parts);
  const result: T[][] = [];
  for (let start = 0; start < items.length; start += each)
    result.push(items.slice(start, start + each));
  return result;
}

function toJobs(stage: StageName, pairs: ReadonlyArray<readonly [string, string]>): PlannedJob[] {
  const byQuery = new Map<string, string[]>();
  for (const [query, doc] of pairs) {
    const list = byQuery.get(query) ?? [];
    list.push(doc);
    byQuery.set(query, list);
  }
  const jobs: PlannedJob[] = [];
  for (const [queryId, docs] of [...byQuery.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    chunk(docs, maxCandidatesPerRequest).forEach((candidateIds, index) => {
      jobs.push({ key: `${stage}:${queryId}:${index}`, stage, queryId, candidateIds });
    });
  }
  return jobs;
}

export function planStages(dataset: Dataset): Record<StageName, PlannedJob[]> {
  const taken = new Set<string>();
  const claim = (pairs: Array<[string, string]>): Array<[string, string]> => {
    const fresh = pairs.filter(([query, doc]) => !taken.has(pairId(query, doc)));
    for (const [query, doc] of fresh) taken.add(pairId(query, doc));
    return fresh;
  };
  const tuningForward = claim(directedPairs(dataset.rows, "economy"));
  const holdoutForward = claim(directedPairs(dataset.rows, "validate"));
  const reverseOf = (pairs: Array<[string, string]>): Array<[string, string]> =>
    pairs.map(([query, doc]) => [doc, query]);
  // Forward stages claim their pairs first so a reverse pair that is itself a forward row of the
  // same phase is scored with its own shortlist.
  const tuningReverse = claim(reverseOf(tuningForward));
  const holdoutReverse = claim(reverseOf(holdoutForward));
  const extra = claim(dataset.sets.all.map(([query, doc]) => [query, doc] as [string, string]));
  return {
    "tuning-forward": toJobs("tuning-forward", tuningForward),
    "tuning-reverse": toJobs("tuning-reverse", tuningReverse),
    "holdout-forward": toJobs("holdout-forward", holdoutForward),
    "holdout-reverse": toJobs("holdout-reverse", holdoutReverse),
    extra: toJobs("extra", extra)
  };
}
