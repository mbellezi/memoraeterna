/**
 * Offline re-scoring (F3 T43, used by T44 and T58): which note pairs a rule would show, re-derived from
 * an export of candidate lists, recorded decisions and relations (`relations-export.ts`) with no model
 * call, then scored against the fixture like a library.
 *
 *   npx tsx scripts/golden/rescore.ts --export <relations-export.json> --rule <rule> [options]
 *
 * Rules: `legacy-blend` (the v9 weighted score of F1a-F2, a frozen copy of the pipeline's arithmetic),
 * `legacy-blend-renormalized` (the same without the always-empty metadata weight), `decider-only:<t>`
 * (a recorded decider score of at least t, a lower bound for the generative fallback because pairs the
 * feasibility gate never sent have no score), `ranker:<max|mean>:<log-odds>` with `--scores`.
 *
 * Held-out results stay sealed until `frozen.json` exists (decision D3); `--parity` compares the
 * rescored pairs with a stored report and prints only whether they are the same.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

import { readHeldOutAccess, type HeldOutAccess } from "./freeze-guard.ts";
import {
  evaluateMatching,
  sealHeldOut,
  type EvaluationInput,
  type MatchingEvaluation
} from "./matching-evaluation.ts";
import { readMapping } from "./matching-evaluation-db.ts";
import { matchingFixtureMappingPath, type MatchingMapping } from "./matching-fixture.ts";
import {
  aggregatePairScores,
  notePairKey,
  parseRankerRule,
  readPairScores,
  readRelationsExport,
  type ExportCandidate,
  type ExportDecision,
  type ExportRelation,
  type PairScores,
  type RelationsExport
} from "./relations-export.ts";

// --- The legacy blend (frozen copy) --------------------------------------------------------------

/** The F1a-F2 note-matching settings that decided acceptance (`recommended-v1`, contract v9). */
export interface LegacyBlendSettings {
  threshold: number;
  withEmbeddingAndGraph: Readonly<Record<string, number>>;
  withEmbedding: Readonly<Record<string, number>>;
  withGraph: Readonly<Record<string, number>>;
  textAndMetadata: Readonly<Record<string, number>>;
  rerankerWeight: number;
  minRerankScore: number;
  requireReranking: boolean;
  includeWeakTypes: boolean;
  maxRelationsPerNote: number;
}

export const legacyBlendSettings: LegacyBlendSettings = {
  threshold: 0.6,
  withEmbeddingAndGraph: { vector: 0.45, text: 0.25, graph: 0.2, metadata: 0.1 },
  withEmbedding: { vector: 0.55, text: 0.3, metadata: 0.15 },
  withGraph: { text: 0.55, graph: 0.3, metadata: 0.15 },
  textAndMetadata: { text: 0.7, metadata: 0.3 },
  rerankerWeight: 0.4,
  minRerankScore: 0.65,
  requireReranking: true,
  includeWeakTypes: false,
  maxRelationsPerNote: 10
};

const weakTypes = new Set(["mentions", "related"]);

interface BlendInput {
  vector: number | null;
  text: number | null;
  metadata: number | null;
  graph: number | null;
  hasEmbedding: boolean;
  rerank: number | null;
}

/**
 * `calculateRelationScore` of `knowledge-processing.ts` as it stood at F2: the weight set follows which
 * signals exist, the base score is their weighted mean, and the decider score blends in at
 * `rerankerWeight`. With `renormalizeMetadata` the metadata term leaves the weight set instead of
 * counting as zero (decision D17's "absent signal is absent").
 */
export function legacyBlendScore(
  input: BlendInput,
  settings: LegacyBlendSettings,
  renormalizeMetadata: boolean
): number {
  const hasGraph = input.graph !== null;
  const selected = input.hasEmbedding
    ? hasGraph
      ? settings.withEmbeddingAndGraph
      : settings.withEmbedding
    : hasGraph
      ? settings.withGraph
      : settings.textAndMetadata;
  const values: Record<string, number> = {
    vector: input.vector ?? 0,
    text: input.text ?? 0,
    metadata: input.metadata ?? 0,
    graph: input.graph ?? 0
  };
  const entries = Object.entries(selected).filter(
    ([key]) => !(renormalizeMetadata && key === "metadata")
  );
  const totalWeight = entries.reduce((total, [, weight]) => total + weight, 0);
  const base =
    entries.reduce((total, [key, weight]) => total + values[key]! * weight, 0) / totalWeight;
  const blended =
    input.rerank === null
      ? base
      : base * (1 - settings.rerankerWeight) + input.rerank * settings.rerankerWeight;
  return Math.max(0, Math.min(1, blended));
}

// --- Rules ---------------------------------------------------------------------------------------

export type RescoreRule =
  | { kind: "legacy-blend"; renormalizeMetadata: boolean; settings: LegacyBlendSettings }
  | { kind: "decider-only"; threshold: number; includeWeakTypes: boolean }
  | { kind: "ranker"; aggregation: "max" | "mean"; threshold: number; scores: PairScores };

export const describeRule = (rule: RescoreRule): string =>
  rule.kind === "legacy-blend"
    ? rule.renormalizeMetadata
      ? "legacy blend, metadata renormalized"
      : "legacy blend (v9)"
    : rule.kind === "decider-only"
      ? `decider only at ${rule.threshold}`
      : `ranker ${rule.aggregation} of both directions at ${rule.threshold} log-odds`;

/** Parses a `--rule` value; `scores` is required for ranker rules. */
export function parseRescoreRule(text: string, scores?: PairScores): RescoreRule {
  if (text === "legacy-blend" || text === "legacy-blend-renormalized")
    return {
      kind: "legacy-blend",
      renormalizeMetadata: text.endsWith("renormalized"),
      settings: legacyBlendSettings
    };
  const decider = /^decider-only:(\d+(?:\.\d+)?)$/u.exec(text);
  if (decider)
    return { kind: "decider-only", threshold: Number(decider[1]), includeWeakTypes: false };
  if (text.startsWith("ranker:")) {
    if (!scores) throw new Error("A ranker rule needs --scores.");
    return { kind: "ranker", ...parseRankerRule(text.slice("ranker:".length)), scores };
  }
  throw new Error(
    `Unknown rule "${text}": use legacy-blend, legacy-blend-renormalized, decider-only:<t> or ranker:<max|mean>:<log-odds>.`
  );
}

// --- Candidate table -----------------------------------------------------------------------------

interface Verdict {
  score: number;
  type: string | null;
}

interface TableRow {
  sourceNoteId: string;
  targetNoteId: string;
  vector: number | null;
  text: number | null;
  metadata: number | null;
  graph: number | null;
  rerank: number | null;
  hasEmbedding: boolean;
  /** The relation row's own stored final score, for the blend check. */
  storedFinal: number | null;
  relationType: string | null;
}

/** Recorded decisions by unordered pair: the verdict of each direction. */
function indexDecisions(decisions: readonly ExportDecision[]) {
  const byPair = new Map<
    string,
    { lo: string; forward: Verdict | null; backward: Verdict | null }
  >();
  for (const decision of decisions) {
    const key = notePairKey(decision.loNoteId, decision.hiNoteId);
    const lo = decision.loNoteId < decision.hiNoteId ? decision.loNoteId : decision.hiNoteId;
    const entry = byPair.get(key) ?? { lo, forward: null, backward: null };
    // A pair judged by several deciders keeps the last verdict of each direction in file order;
    // `deciderKey` in the options narrows the decisions to one decider instead.
    if (decision.loToHiScore !== null)
      entry.forward = { score: decision.loToHiScore, type: decision.loToHiType };
    if (decision.hiToLoScore !== null)
      entry.backward = { score: decision.hiToLoScore, type: decision.hiToLoType };
    byPair.set(key, entry);
  }
  return byPair;
}

/**
 * The verdict for source to target: the direction's own, else the reverse direction's (a generative
 * decider judges an unordered pair once and the verdict answers both directions).
 */
function verdictFor(
  index: ReturnType<typeof indexDecisions>,
  source: string,
  target: string
): Verdict | null {
  const entry = index.get(notePairKey(source, target));
  if (!entry) return null;
  const sourceIsLo = source === entry.lo;
  return (
    (sourceIsLo ? entry.forward : entry.backward) ?? (sourceIsLo ? entry.backward : entry.forward)
  );
}

/** Debug candidates first, then relation rows for directed pairs no candidate row covers. */
function buildTable(data: RelationsExport): TableRow[] {
  const decisions = indexDecisions(data.decisions);
  const rows = new Map<string, TableRow>();
  const key = (row: { sourceNoteId: string; targetNoteId: string }) =>
    `${row.sourceNoteId}>${row.targetNoteId}`;
  const fromCandidate = (candidate: ExportCandidate): TableRow => ({
    sourceNoteId: candidate.sourceNoteId,
    targetNoteId: candidate.targetNoteId,
    vector: candidate.vectorScore,
    text: candidate.textScore,
    metadata: candidate.metadataScore,
    graph: candidate.graphScore,
    rerank: candidate.rerankScore,
    hasEmbedding: candidate.vectorScore !== null,
    storedFinal: candidate.finalScore,
    relationType: null
  });
  const fromRelation = (relation: ExportRelation): TableRow => ({
    sourceNoteId: relation.sourceNoteId,
    targetNoteId: relation.targetNoteId,
    vector: relation.vectorScore,
    text: relation.textScore,
    metadata: relation.metadataScore,
    graph: relation.graphScore,
    rerank: relation.rerankScore,
    hasEmbedding: relation.vectorScore !== null,
    storedFinal: relation.finalScore,
    relationType: relation.relationType
  });
  for (const candidate of data.candidates) rows.set(key(candidate), fromCandidate(candidate));
  for (const relation of data.relations) {
    const existing = rows.get(key(relation));
    if (existing) {
      existing.relationType ??= relation.relationType;
      existing.rerank ??= relation.rerankScore;
      existing.storedFinal ??= relation.finalScore;
      continue;
    }
    // A relation row keeps its pair's canonical order, not the direction that was judged: it only
    // stands in for the pair when no candidate row covers either direction.
    const reverse = rows.get(`${relation.targetNoteId}>${relation.sourceNoteId}`);
    if (!reverse) rows.set(key(relation), fromRelation(relation));
  }
  // Fill what the decisions know: the verdict of the pair and its type.
  for (const row of rows.values()) {
    const verdict = verdictFor(decisions, row.sourceNoteId, row.targetNoteId);
    if (row.rerank === null && verdict) row.rerank = verdict.score;
    row.relationType ??= verdict?.type ?? null;
  }
  return [...rows.values()];
}

// --- Applying a rule -----------------------------------------------------------------------------

export interface RescoreResult {
  rule: string;
  /** Directed candidate rows the rule looked at (decider-only and ranker rules look at decisions or scores instead). */
  considered: number;
  /** Note pairs the rule shows, as [lo, hi] id pairs. */
  acceptedNotePairs: Array<[string, string]>;
  /** Legacy blend only: how closely the recomputed final scores match the stored ones. */
  blendCheck: { compared: number; maxAbsoluteDifference: number | null } | null;
  warnings: string[];
}

export interface RescoreOptions {
  /** Only decisions of the decider whose key starts with this (default: all of them). */
  deciderKey?: string | undefined;
}

const sortedPair = (a: string, b: string): [string, string] => (a < b ? [a, b] : [b, a]);

type Applied = Omit<RescoreResult, "warnings">;

function applyLegacyBlend(
  data: RelationsExport,
  rule: Extract<RescoreRule, { kind: "legacy-blend" }>
): Applied {
  const { settings, renormalizeMetadata } = rule;
  const table = buildTable(data);
  const bySource = new Map<string, TableRow[]>();
  for (const row of table)
    bySource.set(row.sourceNoteId, [...(bySource.get(row.sourceNoteId) ?? []), row]);
  const accepted = new Map<string, [string, string]>();
  let compared = 0;
  let maxDifference: number | null = null;
  for (const rows of bySource.values()) {
    const scored = rows.map((row) => {
      const finalScore = legacyBlendScore(
        {
          vector: row.vector,
          text: row.text,
          metadata: row.metadata,
          graph: row.graph,
          hasEmbedding: row.hasEmbedding,
          rerank: row.rerank
        },
        settings,
        renormalizeMetadata
      );
      if (!renormalizeMetadata && row.storedFinal !== null && row.rerank !== null) {
        compared += 1;
        const difference = Math.abs(finalScore - row.storedFinal);
        maxDifference = Math.max(maxDifference ?? 0, difference);
      }
      const validated =
        row.rerank === null
          ? !settings.requireReranking
          : row.rerank > 0 && row.rerank >= settings.minRerankScore;
      const weak = weakTypes.has(row.relationType ?? "related");
      return {
        row,
        finalScore,
        qualifies:
          finalScore >= settings.threshold && validated && (settings.includeWeakTypes || !weak)
      };
    });
    scored.sort(
      (left, right) =>
        right.finalScore - left.finalScore ||
        left.row.targetNoteId.localeCompare(right.row.targetNoteId)
    );
    let taken = 0;
    for (const { row, qualifies } of scored) {
      if (!qualifies || taken >= settings.maxRelationsPerNote) continue;
      taken += 1;
      const pair = sortedPair(row.sourceNoteId, row.targetNoteId);
      accepted.set(notePairKey(...pair), pair);
    }
  }
  return {
    rule: describeRule(rule),
    considered: table.length,
    acceptedNotePairs: [...accepted.values()],
    blendCheck: renormalizeMetadata ? null : { compared, maxAbsoluteDifference: maxDifference }
  };
}

function applyDeciderOnly(
  data: RelationsExport,
  rule: Extract<RescoreRule, { kind: "decider-only" }>
): Applied {
  const accepted = new Map<string, [string, string]>();
  const consider = (a: string, b: string, score: number | null, type: string | null) => {
    if (score === null || score < rule.threshold) return;
    if (!rule.includeWeakTypes && weakTypes.has(type ?? "related")) return;
    const pair = sortedPair(a, b);
    accepted.set(notePairKey(...pair), pair);
  };
  for (const decision of data.decisions) {
    consider(decision.loNoteId, decision.hiNoteId, decision.loToHiScore, decision.loToHiType);
    consider(decision.loNoteId, decision.hiNoteId, decision.hiToLoScore, decision.hiToLoType);
  }
  const types = new Map(
    data.decisions.flatMap((decision) => [
      [
        `${decision.loNoteId}>${decision.hiNoteId}`,
        decision.loToHiType ?? decision.hiToLoType
      ] as const,
      [
        `${decision.hiNoteId}>${decision.loNoteId}`,
        decision.hiToLoType ?? decision.loToHiType
      ] as const
    ])
  );
  // Candidate rows carry the score of the direction that was actually judged.
  for (const candidate of data.candidates)
    consider(
      candidate.sourceNoteId,
      candidate.targetNoteId,
      candidate.rerankScore,
      types.get(`${candidate.sourceNoteId}>${candidate.targetNoteId}`) ?? null
    );
  return {
    rule: describeRule(rule),
    considered: data.decisions.length,
    acceptedNotePairs: [...accepted.values()],
    blendCheck: null
  };
}

function applyRanker(rule: Extract<RescoreRule, { kind: "ranker" }>): Applied {
  const scores = aggregatePairScores(rule.scores, rule.aggregation);
  const accepted: Array<[string, string]> = [];
  for (const [key, value] of scores)
    if (value >= rule.threshold) accepted.push(key.split(":") as [string, string]);
  return {
    rule: describeRule(rule),
    considered: scores.size,
    acceptedNotePairs: accepted,
    blendCheck: null
  };
}

export function rescore(
  data: RelationsExport,
  rule: RescoreRule,
  options: RescoreOptions = {}
): RescoreResult {
  const warnings: string[] = [];
  const keys = new Set(data.decisions.map((decision) => decision.deciderKey));
  if (options.deciderKey)
    data = {
      ...data,
      decisions: data.decisions.filter((decision) =>
        decision.deciderKey.startsWith(options.deciderKey!)
      )
    };
  else if (keys.size > 1)
    warnings.push(
      `the decisions of ${keys.size} deciders are mixed (last verdict wins); --decider-key narrows them to one`
    );
  const result =
    rule.kind === "legacy-blend"
      ? applyLegacyBlend(data, rule)
      : rule.kind === "decider-only"
        ? applyDeciderOnly(data, rule)
        : applyRanker(rule);
  return { ...result, warnings };
}

/** The export as a library whose note relations are the rescored pairs, scored against the fixture. */
export function rescoreEvaluation(
  data: RelationsExport,
  mapping: MatchingMapping,
  rule: RescoreRule,
  options: RescoreOptions = {}
): { result: RescoreResult; evaluation: MatchingEvaluation } {
  const result = rescore(data, rule, options);
  const input: EvaluationInput = {
    mapping,
    sources: data.sources.map((source) => ({
      id: source.id,
      parentId: source.parentId,
      title: source.title
    })),
    notes: data.notes,
    noteRelations: result.acceptedNotePairs.map(([sourceId, targetId]) => ({
      sourceId,
      targetId,
      status: "pending_review"
    })),
    sourceRelations: [],
    aiCalls: []
  };
  const evaluation = evaluateMatching(input);
  // A re-score has no AI calls: the evaluator's cost warnings do not apply.
  evaluation.resolution.warnings = evaluation.resolution.warnings.filter(
    (warning) => !warning.includes("calls in the library or window")
  );
  return { result, evaluation };
}

// --- Parity with a stored report -----------------------------------------------------------------

const layerSchema = z.object({
  expected: z.object({ hitPairs: z.array(z.string()) }).passthrough(),
  forbidden: z.object({ hitPairs: z.array(z.string()) }).passthrough()
});
const storedReportSchema = z
  .object({
    format: z.literal("memora-golden-matching-evaluation"),
    partitions: z.object({
      tuning: z.object({ layers: z.object({ notes: layerSchema }).passthrough() }).passthrough(),
      holdout: z.object({ layers: z.object({ notes: layerSchema }).passthrough() }).passthrough()
    })
  })
  .passthrough();

export interface ParityPartition {
  /** The rescored and the stored root pairs are the same set. */
  same: boolean;
  /** Pairs found in one and not the other (counts only: a pair list would disclose held-out pairs). */
  differing: number;
  /**
   * The stored report's own expected and forbidden counts, given only when the sets are the same:
   * the rescore then reproduces a published figure and discloses nothing new.
   */
  reproduces: { expected: number; forbidden: number } | null;
}
export type Parity = Record<"tuning" | "holdout", ParityPartition>;

/** Compares the linked expected and forbidden root pairs of the note layer with a stored report's. */
export function compareWithStoredReport(evaluation: MatchingEvaluation, stored: unknown): Parity {
  const report = storedReportSchema.parse(stored);
  const compare = (partition: "tuning" | "holdout"): ParityPartition => {
    const mine = evaluation.partitions[partition].layers.notes;
    const theirs = report.partitions[partition].layers.notes;
    const left = new Set([...mine.expected.hitPairs, ...mine.forbidden.hitPairs]);
    const right = new Set([...theirs.expected.hitPairs, ...theirs.forbidden.hitPairs]);
    const differing =
      [...left].filter((pair) => !right.has(pair)).length +
      [...right].filter((pair) => !left.has(pair)).length;
    return {
      same: differing === 0,
      differing,
      reproduces:
        differing === 0
          ? {
              expected: theirs.expected.hitPairs.length,
              forbidden: theirs.forbidden.hitPairs.length
            }
          : null
    };
  };
  return { tuning: compare("tuning"), holdout: compare("holdout") };
}

const describeParity = (partition: ParityPartition): string =>
  partition.reproduces
    ? `same pairs (the stored report links ${partition.reproduces.expected} expected and ${partition.reproduces.forbidden} forbidden)`
    : `${partition.differing} pairs differ`;

// --- Report --------------------------------------------------------------------------------------

export function renderRescoreMarkdown(
  result: RescoreResult,
  evaluation: MatchingEvaluation,
  context: { label?: string | null; parity?: { parity: Parity; against: string } | null }
): string {
  const lines = [`# Offline re-score${context.label ? `: ${context.label}` : ""}`, ""];
  lines.push(
    `Rule: ${result.rule}. ${result.considered} candidate rows or decisions considered, ${result.acceptedNotePairs.length} note pairs shown.`,
    ""
  );
  if (result.blendCheck)
    lines.push(
      `Blend check: ${result.blendCheck.compared} stored final scores recomputed, largest difference ${result.blendCheck.maxAbsoluteDifference === null ? "not available" : result.blendCheck.maxAbsoluteDifference.toExponential(2)}.`,
      ""
    );
  lines.push(
    "| Partition | Expected linked | Forbidden linked | Root pairs |",
    "| --- | ---: | ---: | ---: |"
  );
  for (const partition of ["tuning", "holdout"] as const) {
    const score = evaluation.partitions[partition];
    const layer = score.layers.notes;
    lines.push(
      score.sealed
        ? `| held-out | sealed | sealed | sealed |`
        : `| ${partition === "holdout" ? "held-out" : "tuning"} | ${layer.expected.hit}/${layer.expected.total} | ${layer.forbidden.hit}/${layer.forbidden.total} | ${layer.rootPairs} |`
    );
  }
  lines.push("");
  const tuning = evaluation.partitions.tuning.layers.notes;
  lines.push(
    `Tuning: expected not linked: ${tuning.expected.missPairs.join(", ") || "none"}; forbidden linked: ${tuning.forbidden.hitPairs.join(", ") || "none"}.`,
    ""
  );
  if (!evaluation.partitions.holdout.sealed) {
    const held = evaluation.partitions.holdout.layers.notes;
    lines.push(
      `Held-out: expected not linked: ${held.expected.missPairs.join(", ") || "none"}; forbidden linked: ${held.forbidden.hitPairs.join(", ") || "none"}.`,
      ""
    );
  }
  if (context.parity) {
    const { parity, against } = context.parity;
    lines.push(
      `Parity with ${against}: tuning ${describeParity(parity.tuning)}; held-out ${describeParity(parity.holdout)}.`,
      ""
    );
  }
  for (const warning of [...result.warnings, ...evaluation.resolution.warnings])
    lines.push(`- ${warning}`);
  return `${lines.join("\n").trimEnd()}\n`;
}

// --- Command line --------------------------------------------------------------------------------

export const rescoreUsage = `Usage: npx tsx scripts/golden/rescore.ts --export <relations-export.json> --rule <rule> [options]

Re-derives the note pairs a rule would show from an export of candidate lists, decisions and relations
(no model call) and scores them against the matching fixture.

  --export <file>    Relations export (evaluate-matching.ts --export-relations).
  --rule <rule>      legacy-blend | legacy-blend-renormalized | decider-only:<t> | ranker:<max|mean>:<log-odds>
  --scores <file>    Pair scores for a ranker rule (memora-relations-pair-scores).
  --decider-key <p>  Only the recorded decisions of the decider whose key starts with p.
  --mapping <file>   Fixture mapping (default ${matchingFixtureMappingPath}).
  --parity <file>    A stored evaluation report (--json of evaluate-matching.ts): print whether the rescored
                     root pairs are the same, never the held-out pairs themselves.
  --label <text>     Name for the report header.
  --out <file.md>    Write the Markdown report here (default: print it).
  --json <file>      Also write the accepted note pairs and the evaluation (held-out sealed before the freeze).
  --frozen <file>    The freeze record (default .cache/f3/freeze/frozen.json).
  --help             Show this text.

The held-out partition is sealed until the freeze record exists (decision D3).`;

export async function runRescore(
  argv: readonly string[],
  access?: HeldOutAccess
): Promise<string | null> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      export: { type: "string" },
      rule: { type: "string" },
      scores: { type: "string" },
      "decider-key": { type: "string" },
      mapping: { type: "string" },
      parity: { type: "string" },
      label: { type: "string" },
      out: { type: "string" },
      json: { type: "string" },
      frozen: { type: "string" },
      help: { type: "boolean", short: "h" }
    },
    strict: true,
    allowPositionals: false
  });
  if (values.help) return rescoreUsage;
  if (!values.export || !values.rule) throw new Error("--export and --rule are required.");
  const data = await readRelationsExport(values.export);
  const scores = values.scores ? await readPairScores(values.scores) : undefined;
  const rule = parseRescoreRule(values.rule, scores);
  const mapping = await readMapping(values.mapping ?? matchingFixtureMappingPath);
  const { result, evaluation } = rescoreEvaluation(data, mapping, rule, {
    deciderKey: values["decider-key"]
  });
  const heldOut = access ?? (await readHeldOutAccess(values.frozen));
  const parity = values.parity
    ? {
        parity: compareWithStoredReport(
          evaluation,
          JSON.parse(await readFile(values.parity, "utf8")) as unknown
        ),
        against: values.parity
      }
    : null;
  const shown = heldOut.open ? evaluation : sealHeldOut(evaluation, heldOut.reason);
  const markdown = renderRescoreMarkdown(result, shown, { label: values.label ?? null, parity });
  const write = async (path: string, content: string) => {
    const target = resolve(path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  };
  if (values.json)
    await write(
      values.json,
      `${JSON.stringify({ rule: result.rule, acceptedNotePairs: heldOut.open ? result.acceptedNotePairs : undefined, evaluation: shown, parity }, null, 2)}\n`
    );
  if (values.out) {
    await write(values.out, markdown);
    return null;
  }
  return markdown;
}

if (import.meta.main) {
  try {
    const output = await runRescore(process.argv.slice(2));
    if (output !== null) console.info(output);
  } catch (error) {
    console.error(`[rescore] ${error instanceof Error ? error.message : String(error)}`);
    console.error("Run with --help for usage.");
    process.exitCode = 1;
  }
}
