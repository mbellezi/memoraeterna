/**
 * Turns the raw request logs of Spike A2 into per-pair scores.
 *
 * A directed pair (query note, candidate note) maps to the predicate probability of its request.
 * Refusals have no probability and are counted separately. When a pair appears in several runs
 * (it should not: `plan.ts` scores each pair once per configuration), the first stage in
 * `stageOrder` wins.
 */
import type { DecisionAnswer } from "./client.js";
import { readRaw, type RawRecord } from "./budget.js";
import { planStages, stageNames, type StageName } from "./plan.js";
import type { Dataset } from "../reranker/dataset.js";
import type { ConfigName } from "./design.js";

export const runIdOf = (stage: StageName, config: ConfigName, orderSalt = ""): string =>
  `${stage}__${config}${orderSalt ? `__order${orderSalt}` : ""}`;

export interface PairScore {
  probability: number | null;
  stage: StageName;
}

export interface TypedAnswer {
  choice: string;
  confidence: number;
  probabilities: Array<{ value: string | boolean; probability: number }>;
}

export interface StageData {
  stage: StageName;
  config: ConfigName;
  records: RawRecord[];
  /** Requests planned for the stage and how many of them succeeded. */
  planned: number;
  complete: boolean;
}

export interface Scores {
  stages: Map<string, StageData>;
  /** Predicate probability per directed pair from the `predicate` configuration. */
  predicate: Map<string, PairScore>;
  /** Predicate probability and relation type per directed pair from the `typed` configuration. */
  typedPredicate: Map<string, PairScore>;
  typedChoice: Map<string, TypedAnswer>;
  refusals: number;
}

export const pairId = (query: string, doc: string): string => `${query}|${doc}`;

function ingest(
  record: RawRecord,
  predicate: Map<string, PairScore>,
  choices: Map<string, TypedAnswer> | null,
  stage: StageName
): number {
  const meta = record.meta as { queryId: string; candidateIds: string[] };
  let refusals = 0;
  for (const answer of (record.answers ?? []) as DecisionAnswer[]) {
    const name = answer.name ?? "";
    const match = /^(rel|type)_c(\d+)$/.exec(name);
    if (!match) continue;
    const candidate = meta.candidateIds[Number(match[2]) - 1];
    if (!candidate) continue;
    const id = pairId(meta.queryId, candidate);
    if (answer.type === "refusal") {
      refusals += 1;
      if (match[1] === "rel" && !predicate.has(id)) predicate.set(id, { probability: null, stage });
    } else if (answer.type === "predicate" && match[1] === "rel") {
      if (!predicate.has(id)) predicate.set(id, { probability: answer.probability, stage });
    } else if (answer.type === "choice" && match[1] === "type" && choices) {
      choices.set(id, {
        choice: String(answer.choice),
        confidence: answer.confidence,
        probabilities: answer.probabilities
      });
    }
  }
  return refusals;
}

export async function loadScores(dataset: Dataset, orderSalt = ""): Promise<Scores> {
  const plan = planStages(dataset);
  const stages = new Map<string, StageData>();
  const predicate = new Map<string, PairScore>();
  const typedPredicate = new Map<string, PairScore>();
  const typedChoice = new Map<string, TypedAnswer>();
  let refusals = 0;
  for (const stage of stageNames) {
    for (const config of ["predicate", "typed"] as const) {
      if (orderSalt && config === "typed") continue;
      const records = (await readRaw(runIdOf(stage, config, orderSalt))).filter(
        (record) => record.ok
      );
      // Keep the latest successful record per key.
      const byKey = new Map(records.map((record) => [record.key, record]));
      const planned = plan[stage].length;
      if (byKey.size === 0) continue;
      const data: StageData = {
        stage,
        config,
        records: [...byKey.values()],
        planned,
        complete: plan[stage].every((job) => byKey.has(job.key))
      };
      stages.set(`${stage}/${config}`, data);
      for (const record of data.records) {
        if (config === "predicate") refusals += ingest(record, predicate, null, stage);
        else refusals += ingest(record, typedPredicate, typedChoice, stage);
      }
    }
  }
  return { stages, predicate, typedPredicate, typedChoice, refusals };
}

/** Predicate answers of one request as (query, candidate, probability) triples. */
export function predicatesOf(
  record: RawRecord
): Array<{ query: string; doc: string; probability: number | null }> {
  const meta = record.meta as { queryId: string; candidateIds: string[] };
  const result: Array<{ query: string; doc: string; probability: number | null }> = [];
  for (const answer of (record.answers ?? []) as DecisionAnswer[]) {
    const match = /^rel_c(\d+)$/.exec(answer.name ?? "");
    const doc = match ? meta.candidateIds[Number(match[1]) - 1] : undefined;
    if (!doc) continue;
    result.push({
      query: meta.queryId,
      doc,
      probability: answer.type === "predicate" ? answer.probability : null
    });
  }
  return result;
}
