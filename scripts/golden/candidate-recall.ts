/**
 * Candidate recall (F3 T43, retrieval diagnosis for gate 0): for every expected root pair, did any note
 * pair reach the decider, at what rank, through which signals. Computed from an export of the
 * matching candidate lists (`relations-export.ts`), fully offline.
 *
 *   npx tsx scripts/golden/candidate-recall.ts --export <relations-export.json> [--k 20]
 *
 * Before the freeze (decision D3) the pair-level result covers tuning pairs only. The held-out
 * partition is read through `preFreezeFeasibility` alone, which yields two aggregates and no pair.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import { readHeldOutAccess, sealedNotice, type HeldOutAccess } from "./freeze-guard.ts";
import { createRootIndex } from "./matching-evaluation.ts";
import { readMapping } from "./matching-evaluation-db.ts";
import {
  matchingFixtureMappingPath,
  pairKey,
  type MatchingMapping,
  type Partition
} from "./matching-fixture.ts";
import {
  aggregatePairScores,
  defaultCandidateDepth,
  notePairKey,
  readRelationsExport,
  type Aggregation,
  type PairScores,
  type RelationsExport
} from "./relations-export.ts";

export { defaultCandidateDepth };

export type Signal = "vector" | "text" | "graph";

export interface RootPairRecall {
  pair: string;
  partition: Partition;
  /** Both roots are in the library. */
  evaluable: boolean;
  /** Note pairs between the two roots. */
  notePairs: number;
  /** Note pairs that reached the decider. */
  reaching: number;
  /** Best rank among the reaching candidates (1 is best); null without candidate lists. */
  bestRank: number | null;
  /** Signals the best-ranked reaching candidate came through. */
  signals: Signal[];
  reached: boolean;
}

export interface CandidateRecall {
  k: number;
  /** `candidates` when the export holds candidate lists; otherwise decisions and relations (a lower bound). */
  basis: "candidates" | "decisions-and-relations";
  pairs: RootPairRecall[];
  summary: Record<Partition, { total: number; evaluable: number; reached: number }>;
  warnings: string[];
}

interface Reached {
  a: string;
  b: string;
  rank: number | null;
  signals: Signal[];
}

/** The note pairs that reached the decider: candidate rows ranked within k, else decisions and relations. */
function reachedNotePairs(
  data: RelationsExport,
  k: number
): { basis: CandidateRecall["basis"]; reached: Map<string, Reached> } {
  const reached = new Map<string, Reached>();
  const add = (a: string, b: string, rank: number | null, signals: Signal[]) => {
    const key = notePairKey(a, b);
    const existing = reached.get(key);
    const better =
      !existing ||
      (rank !== null && (existing.rank === null || rank < existing.rank)) ||
      (rank === null && existing.rank === null && signals.length > existing.signals.length);
    if (better) reached.set(key, { a, b, rank, signals });
  };
  if (data.candidates.length > 0) {
    for (const candidate of data.candidates) {
      if (candidate.finalRank > k) continue;
      const signals: Signal[] = [
        ...(candidate.vectorRank !== null ? (["vector"] as const) : []),
        ...(candidate.textRank !== null ? (["text"] as const) : []),
        ...(candidate.graphRank !== null ? (["graph"] as const) : [])
      ];
      add(candidate.sourceNoteId, candidate.targetNoteId, candidate.finalRank, signals);
    }
    return { basis: "candidates", reached };
  }
  for (const decision of data.decisions) add(decision.loNoteId, decision.hiNoteId, null, []);
  for (const relation of data.relations)
    add(relation.sourceNoteId, relation.targetNoteId, null, [
      ...(relation.vectorRank !== null ? (["vector"] as const) : []),
      ...(relation.textRank !== null ? (["text"] as const) : []),
      ...(relation.graphRank !== null ? (["graph"] as const) : [])
    ]);
  return { basis: "decisions-and-relations", reached };
}

export function candidateRecall(
  data: RelationsExport,
  mapping: MatchingMapping,
  options: { k?: number } = {}
): CandidateRecall {
  const k = options.k ?? defaultCandidateDepth;
  const index = createRootIndex({ mapping, sources: data.sources, notes: data.notes });
  const { basis, reached } = reachedNotePairs(data, k);
  const byRootPair = new Map<string, { count: number; best: Reached | null }>();
  for (const entry of reached.values()) {
    const left = index.rootOfNote(entry.a);
    const right = index.rootOfNote(entry.b);
    if (!left || !right || left === right) continue;
    const key = pairKey(left, right);
    const slot = byRootPair.get(key) ?? { count: 0, best: null };
    slot.count += 1;
    if (
      !slot.best ||
      (entry.rank !== null && (slot.best.rank === null || entry.rank < slot.best.rank))
    )
      slot.best = entry;
    byRootPair.set(key, slot);
  }
  const notesOf = new Map<string, number>();
  for (const root of index.noteRoot.values())
    if (root) notesOf.set(root, (notesOf.get(root) ?? 0) + 1);

  const pairs: RootPairRecall[] = mapping.expectedRootPairs.map(({ pair, partition }) => {
    const key = pairKey(...pair);
    const hit = byRootPair.get(key);
    return {
      pair: key,
      partition,
      evaluable: index.resolved.has(pair[0]) && index.resolved.has(pair[1]),
      notePairs: (notesOf.get(pair[0]) ?? 0) * (notesOf.get(pair[1]) ?? 0),
      reaching: hit?.count ?? 0,
      bestRank: hit?.best?.rank ?? null,
      signals: hit?.best?.signals ?? [],
      reached: Boolean(hit)
    };
  });
  const summarize = (partition: Partition) => {
    const own = pairs.filter((entry) => entry.partition === partition);
    return {
      total: own.length,
      evaluable: own.filter((entry) => entry.evaluable).length,
      reached: own.filter((entry) => entry.reached).length
    };
  };
  const warnings = [...index.resolution.warnings];
  if (basis === "decisions-and-relations")
    warnings.push(
      "the export has no candidate lists: recall is a lower bound from decisions and relations, ranks unknown"
    );
  return {
    k,
    basis,
    pairs,
    summary: { tuning: summarize("tuning"), holdout: summarize("holdout") },
    warnings
  };
}

// --- The pre-freeze held-out read ----------------------------------------------------------------

export interface Feasibility {
  k: number;
  rule: { aggregation: Aggregation; threshold: number };
  /** Expected held-out root pairs some note pair of which reaches the decider. */
  reachable: { count: number; total: number };
  /** Held-out root pairs the ranker links at the rule, among note pairs that reached the decider. */
  ranker: { expected: number; expectedTotal: number; forbidden: number; forbiddenTotal: number };
}

/**
 * The two aggregates gate 0 reads on the held-out partition before the freeze (decision D3, R2):
 * how many expected root pairs are reachable at depth k, and how many expected and forbidden root
 * pairs a ranker links at a frozen rule. Counts only: no pair is identified.
 */
export function preFreezeFeasibility(
  data: RelationsExport,
  mapping: MatchingMapping,
  scores: PairScores,
  rule: { aggregation: Aggregation; threshold: number },
  k: number = defaultCandidateDepth
): Feasibility {
  const recall = candidateRecall(data, mapping, { k });
  const index = createRootIndex({ mapping, sources: data.sources, notes: data.notes });
  const { reached } = reachedNotePairs(data, k);
  const aggregated = aggregatePairScores(scores, rule.aggregation);
  const linked = new Set<string>();
  for (const [key, value] of aggregated) {
    if (value < rule.threshold || !reached.has(key)) continue;
    const [a, b] = key.split(":") as [string, string];
    const left = index.rootOfNote(a);
    const right = index.rootOfNote(b);
    if (left && right && left !== right) linked.add(pairKey(left, right));
  }
  const heldOut = (labelled: MatchingMapping["expectedRootPairs"]) =>
    labelled
      .filter((entry) => entry.partition === "holdout")
      .map((entry) => pairKey(...entry.pair));
  const expected = heldOut(mapping.expectedRootPairs);
  const forbidden = heldOut(mapping.forbiddenRootPairs);
  return {
    k,
    rule,
    reachable: { count: recall.summary.holdout.reached, total: expected.length },
    ranker: {
      expected: expected.filter((key) => linked.has(key)).length,
      expectedTotal: expected.length,
      forbidden: forbidden.filter((key) => linked.has(key)).length,
      forbiddenTotal: forbidden.length
    }
  };
}

/** Exactly the two lines of the pre-freeze read, with no pair identifier. */
export function renderFeasibility(feasibility: Feasibility, deciderLabel = "ranker"): string {
  const { reachable, ranker, rule, k } = feasibility;
  return [
    `held-out expected root pairs reachable at k=${k}: ${reachable.count} of ${reachable.total}`,
    `${deciderLabel} at ${rule.aggregation} of both directions >= ${rule.threshold} log-odds: held-out expected ${ranker.expected} of ${ranker.expectedTotal}, forbidden ${ranker.forbidden} of ${ranker.forbiddenTotal}`
  ].join("\n");
}

// --- Report --------------------------------------------------------------------------------------

/** The pair-level report; held-out rows and totals appear only when the freeze record is open. */
export function renderCandidateRecallMarkdown(
  recall: CandidateRecall,
  access: HeldOutAccess,
  context: { label?: string | null } = {}
): string {
  const lines = [`# Candidate recall${context.label ? `: ${context.label}` : ""}`, ""];
  const partitions: Partition[] = access.open ? ["tuning", "holdout"] : ["tuning"];
  lines.push(
    `Depth k = ${recall.k}; a note pair reaches the decider when it is in a candidate list within k (${recall.basis}).`,
    ""
  );
  for (const partition of partitions) {
    const own = recall.pairs.filter((entry) => entry.partition === partition);
    const summary = recall.summary[partition];
    lines.push(
      `## Expected ${partition === "holdout" ? "held-out" : "tuning"} root pairs: ${summary.reached} of ${summary.total} reached the decider`,
      "",
      "| Root pair | Reached | Note pairs reaching | Of possible | Best rank | Signals |",
      "| --- | --- | ---: | ---: | ---: | --- |",
      ...own.map(
        (entry) =>
          `| ${entry.pair} | ${entry.reached ? "yes" : entry.evaluable ? "NO" : "not in the library"} | ${entry.reaching} | ${entry.notePairs} | ${entry.bestRank ?? "n/a"} | ${entry.signals.join(", ") || "n/a"} |`
      ),
      ""
    );
  }
  if (!access.open) lines.push(`Held-out: ${sealedNotice(access.reason)}.`, "");
  for (const warning of recall.warnings) lines.push(`- ${warning}`);
  return `${lines.join("\n").trimEnd()}\n`;
}

// --- Command line --------------------------------------------------------------------------------

export const candidateRecallUsage = `Usage: npx tsx scripts/golden/candidate-recall.ts --export <relations-export.json> [options]

For every expected root pair: did any note pair reach the decider, at what rank, through which signals.

  --export <file>    Relations export (evaluate-matching.ts --export-relations).
  --k <n>            Candidate depth (default ${defaultCandidateDepth}).
  --mapping <file>   Fixture mapping (default ${matchingFixtureMappingPath}).
  --label <text>     Name for the report header.
  --out <file.md>    Write the Markdown report here (default: print it).
  --json <file>      Also write the result as JSON (held-out rows only when the freeze record is open).
  --frozen <file>    The freeze record (default .cache/f3/freeze/frozen.json).
  --help             Show this text.

Before the freeze only tuning pairs are reported (decision D3); the held-out aggregates come from
evaluate-matching.ts --pre-freeze-feasibility.`;

export async function runCandidateRecall(
  argv: readonly string[],
  access?: HeldOutAccess
): Promise<string | null> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      export: { type: "string" },
      k: { type: "string" },
      mapping: { type: "string" },
      label: { type: "string" },
      out: { type: "string" },
      json: { type: "string" },
      frozen: { type: "string" },
      help: { type: "boolean", short: "h" }
    },
    strict: true,
    allowPositionals: false
  });
  if (values.help) return candidateRecallUsage;
  if (!values.export) throw new Error("--export is required.");
  const k = values.k === undefined ? defaultCandidateDepth : Number(values.k);
  if (!Number.isInteger(k) || k <= 0) throw new Error("--k must be a positive integer.");
  const data = await readRelationsExport(values.export);
  const mapping = await readMapping(values.mapping ?? matchingFixtureMappingPath);
  const heldOut = access ?? (await readHeldOutAccess(values.frozen));
  const recall = candidateRecall(data, mapping, { k });
  const markdown = renderCandidateRecallMarkdown(recall, heldOut, { label: values.label ?? null });
  const write = async (path: string, content: string) => {
    const target = resolve(path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  };
  if (values.json) {
    const visible = heldOut.open ? recall : sealCandidateRecall(recall);
    await write(values.json, `${JSON.stringify(visible, null, 2)}\n`);
  }
  if (values.out) {
    await write(values.out, markdown);
    return null;
  }
  return markdown;
}

/** The recall without its held-out rows and totals (decision D3 before the freeze). */
export function sealCandidateRecall(recall: CandidateRecall): Omit<CandidateRecall, "summary"> & {
  heldOut: "sealed";
  summary: Pick<CandidateRecall["summary"], "tuning">;
} {
  return {
    ...recall,
    pairs: recall.pairs.filter((entry) => entry.partition === "tuning"),
    summary: { tuning: recall.summary.tuning },
    heldOut: "sealed"
  };
}

if (import.meta.main) {
  try {
    const output = await runCandidateRecall(process.argv.slice(2));
    if (output !== null) console.info(output);
  } catch (error) {
    console.error(`[candidate-recall] ${error instanceof Error ? error.message : String(error)}`);
    console.error("Run with --help for usage.");
    process.exitCode = 1;
  }
}
