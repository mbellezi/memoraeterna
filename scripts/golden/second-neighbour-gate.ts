/**
 * F4 T71, option 2 of the batched-judge menu (F3 S1 fallback, spec 6 / T88): gate the second
 * neighbour. Two-neighbour discovery accepts 13 of the second library's 27 panel-positive pairs where
 * one neighbour accepts 6, but judges 2.96 pairs per source against a bar of 2. A gate judges the
 * second-neighbour pairs only when they are close to the first, so the cheap calls stay and the
 * likeliest misses come back. Offline and $0: no database, no model, no provider.
 *
 *   MEMORA_CACHE_ROOT=<main checkout>/.cache npx tsx scripts/golden/second-neighbour-gate.ts \
 *     [--orders 2000] [--replay-input f] [--labels f] [--tally f] [--context library=f ...] \
 *     [--verdicts library=f ...] [--json out.json] [--out report.md]
 *
 * Two evidence sets, one rule family (a fixed grid of round values; it was written after the LIB2
 * gaps were seen, so it is a hypothesis for T88 to pre-register, never a pre-registration itself):
 *  - LIB2: the labelled nearest and second-nearest pairs of the 10 GOLD and 20 CORP roots with the
 *    panel's majority label and the v5 judge's recorded verdict (SPG, SPC), and the cosines of the
 *    label inputs' context export. Those cosines are the topic-tree weighted root vectors the panel's
 *    pairs were chosen on, not the source matcher's composite vectors, so an absolute floor read here
 *    is a proxy; a relative gap travels better.
 *  - FIX: the source-order replay (`source-order-replay.ts`, 52 roots, composite vectors, the recorded
 *    verdicts of S0, S1, T53 and the closure) at two neighbours with the gate in front of the judge.
 *    It prices the gate in calls per source and shows which recorded acceptances it would have lost;
 *    a pair no recording judged stays unknown (counted as not accepted, as the replay does).
 * Informs T88; it is not a gate.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

import {
  pairKey,
  replayInputSchema,
  replayOutcomes,
  type OrderOutcome,
  type PairGate,
  type ReplayInput,
  type SelectedPairContext
} from "./source-order-replay.ts";

// --- The rule family -------------------------------------------------------------------------

/** A second-neighbour pair is judged when its cosine reaches `floor` or it trails the nearest by at most `maxGap`. */
export interface GateRule {
  id: string;
  floor: number | null;
  maxGap: number | null;
}

export const gateGaps = [0.01, 0.02, 0.03, 0.04, 0.05, 0.075, 0.1] as const;
export const gateFloors = [0.8, 0.85] as const;
/** The gaps a floor is also tried with. */
export const gateCombinedGaps = [0.02, 0.03, 0.05] as const;

export function gateRule(floor: number | null, maxGap: number | null): GateRule {
  const parts = [
    ...(maxGap === null ? [] : [`gap<=${maxGap}`]),
    ...(floor === null ? [] : [`cos>=${floor}`])
  ];
  return { id: parts.length ? parts.join(" or ") : "no extras", floor, maxGap };
}

/** The sweep: every gap alone, every floor alone, three gaps with every floor. */
export function defaultGateRules(): GateRule[] {
  return [
    ...gateGaps.map((gap) => gateRule(null, gap)),
    ...gateFloors.map((floor) => gateRule(floor, null)),
    ...gateCombinedGaps.flatMap((gap) => gateFloors.map((floor) => gateRule(floor, gap)))
  ];
}

/** What a rule reads of a pair: whether it exists only because of the second neighbour, and how far behind it is. */
export interface PairFeatures {
  extra: boolean;
  /** Cosine distance to the competing nearest root; 0 when the pair is not an extra. */
  gap: number;
  cosine: number;
}

/**
 * The features of a pair the replay selected. A pair is an extra when one neighbour would not have
 * selected it from either side: it is not the arriving root's nearest, it was not owed, and it does
 * not beat the candidate's stored nearest (or the candidate has none). Its gap is the smaller of the
 * two sides' distances to the nearest it trails.
 */
export function replayPairFeatures(context: SelectedPairContext): PairFeatures {
  const base = { extra: false, gap: 0, cosine: context.cosine };
  if (context.reason === "owed" || context.nearestRank === 1) return base;
  if (context.candidateNearestCosine === null || context.cosine > context.candidateNearestCosine)
    return base;
  const gaps = [context.candidateNearestCosine - context.cosine];
  if (context.nearestRank === 2 && context.nearestCosine !== null)
    gaps.push(context.nearestCosine - context.cosine);
  return { extra: true, gap: Math.min(...gaps), cosine: context.cosine };
}

export function ruleAllows(rule: GateRule | null, features: PairFeatures): boolean {
  if (!features.extra) return true;
  if (!rule) return true;
  return (
    (rule.floor !== null && features.cosine >= rule.floor) ||
    (rule.maxGap !== null && features.gap <= rule.maxGap)
  );
}

export const pairGateOf =
  (rule: GateRule): PairGate =>
  (context) =>
    ruleAllows(rule, replayPairFeatures(context));

// --- LIB2: the labelled second library -------------------------------------------------------

const labelSetSchema = z.object({
  items: z.array(
    z
      .object({
        pairId: z.string(),
        kind: z.string(),
        library: z.string(),
        loRoot: z.string().nullable().optional(),
        hiRoot: z.string().nullable().optional(),
        sets: z.array(
          z
            .object({
              set: z.string(),
              basis: z.string().nullable().optional(),
              anchor: z.string().nullable().optional()
            })
            .passthrough()
        )
      })
      .passthrough()
  )
});
const tallySchema = z.object({
  items: z.array(
    z
      .object({
        pairId: z.string(),
        kind: z.string(),
        related: z.object({ majority: z.boolean().nullable() }).passthrough()
      })
      .passthrough()
  )
});
const contextSchema = z.object({
  roots: z.array(
    z
      .object({
        id: z.string(),
        neighbours: z.array(z.object({ id: z.string(), cosine: z.number() })).default([])
      })
      .passthrough()
  )
});
const verdictReportSchema = z.object({
  pairs: z.array(
    z.object({ label: z.string(), status: z.string(), verdict: z.string() }).passthrough()
  )
});

export type Lib2Basis = "nearest" | "second-nearest";
export interface Lib2Event {
  basis: Lib2Basis;
  anchor: string;
  /** Cosine of the anchor and the other root of the pair. */
  cosine: number;
  /** Cosine of the anchor and its nearest root. */
  nearestCosine: number;
}
export interface Lib2Pair {
  pairId: string;
  library: string;
  /** The panel's majority label. */
  panel: boolean;
  /** The recorded v5 judge verdict; null when the verdict-only run has no such pair. */
  judge: { status: string; related: boolean } | null;
  events: Lib2Event[];
}

export interface Lib2Inputs {
  labelSet: z.infer<typeof labelSetSchema>;
  tally: z.infer<typeof tallySchema>;
  contexts: Record<string, z.infer<typeof contextSchema>>;
  verdicts: Record<string, z.infer<typeof verdictReportSchema>>;
}

/** The labelled neighbour pairs with their panel label, recorded verdict and the anchors' cosines. */
export function buildLib2Pairs(inputs: Lib2Inputs): { pairs: Lib2Pair[]; problems: string[] } {
  const problems: string[] = [];
  const panel = new Map(
    inputs.tally.items
      .filter((item) => item.kind === "source")
      .map((item) => [item.pairId, item.related.majority] as const)
  );
  const verdict = new Map<string, { status: string; related: boolean }>();
  for (const report of Object.values(inputs.verdicts))
    for (const pair of report.pairs)
      verdict.set(pair.label, { status: pair.status, related: pair.verdict === "related" });
  const neighbours = new Map<string, Map<string, Array<{ id: string; cosine: number }>>>();
  for (const [library, context] of Object.entries(inputs.contexts))
    neighbours.set(library, new Map(context.roots.map((root) => [root.id, root.neighbours])));
  const pairs = new Map<string, Lib2Pair>();
  for (const item of inputs.labelSet.items) {
    if (item.kind !== "source") continue;
    for (const set of item.sets) {
      if (set.set !== "source-neighbours") continue;
      if (set.basis !== "nearest" && set.basis !== "second-nearest") continue;
      const list = neighbours.get(item.library)?.get(set.anchor ?? "");
      const other = item.loRoot === set.anchor ? item.hiRoot : item.loRoot;
      const found = list?.find((neighbour) => neighbour.id === other);
      const nearest = list?.[0];
      if (!list || !found || !nearest) {
        problems.push(`${item.pairId}: no cosine for ${set.basis} anchor ${String(set.anchor)}`);
        continue;
      }
      const rank = list.indexOf(found) + 1;
      if (rank !== (set.basis === "nearest" ? 1 : 2))
        problems.push(
          `${item.pairId}: labelled ${set.basis} but rank ${rank} in its anchor's list`
        );
      const label = panel.get(item.pairId);
      if (label === undefined || label === null) {
        problems.push(`${item.pairId}: no panel majority`);
        continue;
      }
      const entry = pairs.get(item.pairId) ?? {
        pairId: item.pairId,
        library: item.library,
        panel: label,
        judge: verdict.get(item.pairId) ?? null,
        events: []
      };
      entry.events.push({
        basis: set.basis,
        anchor: set.anchor ?? "",
        cosine: found.cosine,
        nearestCosine: nearest.cosine
      });
      pairs.set(item.pairId, entry);
    }
  }
  return { pairs: [...pairs.values()].sort((a, b) => (a.pairId < b.pairId ? -1 : 1)), problems };
}

/** The features a rule reads of one second-nearest event of the labelled set. */
export const lib2EventFeatures = (event: Lib2Event): PairFeatures => ({
  extra: true,
  gap: event.nearestCosine - event.cosine,
  cosine: event.cosine
});

export interface Lib2Row {
  rule: string;
  /** Pairs the judge would be asked about. */
  judgedPairs: number;
  /** Of them, pairs that exist only as someone's second neighbour. */
  secondOnlyJudged: number;
  panelPositives: number;
  acceptedInU: number;
  recall: number;
  panelNegativesAccepted: number;
  /** Judged pairs per anchor: the labelled set's stand-in for judge calls per source. */
  callsPerAnchor: number;
}

/**
 * Pair-level, as the F3 second-library check: a pair is judged when it is a nearest pair of some
 * anchor, or a second-nearest pair the rule allows. `null` judges nearest pairs only (one
 * neighbour); `"all"` judges every labelled pair (two neighbours).
 */
export function evaluateLib2(
  pairs: readonly Lib2Pair[],
  rule: GateRule | "nearest-only" | "all"
): Lib2Row {
  const anchors = new Set(pairs.flatMap((pair) => pair.events.map((event) => event.anchor)));
  const judged = pairs.filter((pair) =>
    pair.events.some(
      (event) =>
        event.basis === "nearest" ||
        rule === "all" ||
        (rule !== "nearest-only" && ruleAllows(rule, lib2EventFeatures(event)))
    )
  );
  const positives = pairs.filter((pair) => pair.panel);
  const accepted = judged.filter((pair) => pair.panel && pair.judge?.related);
  return {
    rule: typeof rule === "string" ? rule : rule.id,
    judgedPairs: judged.length,
    secondOnlyJudged: judged.filter((pair) =>
      pair.events.every((event) => event.basis === "second-nearest")
    ).length,
    panelPositives: positives.length,
    acceptedInU: accepted.length,
    recall: positives.length ? accepted.length / positives.length : 0,
    panelNegativesAccepted: judged.filter((pair) => !pair.panel && pair.judge?.related).length,
    callsPerAnchor: anchors.size ? judged.length / anchors.size : 0
  };
}

// --- FIX: the source-order replay behind the gate --------------------------------------------

export interface ReplayGateRow {
  rule: string;
  neighbours: 1 | 2;
  orders: number;
  callsPerSource: { mean: number; max: number };
  /** Pairs per source the gate kept from the judge. */
  skippedPerSource: number;
  /** Calls per source if the judge took an arriving root's pairs in one call (D21's option 1). */
  batchedCallsPerSource: number;
  /** Pairs in one such call, on average. */
  pairsPerBatchedCall: number;
  expected: { min: number; mean: number };
  forbiddenMax: number;
  /** Pairs per order the judge reached with no recording (counted as not accepted). */
  unjudgedPerOrder: number;
  /** Per order, gated-out pairs a recording accepted: relations the gate would have cost. */
  lostRecordedAcceptancesPerOrder: number;
  /** Pairs some order gated out whose recorded verdict is an acceptance. */
  lostRecordedAcceptancePairs: number;
  /**
   * The S1 closure: distinct pairs the judge reaches in some order that no recording judged, which a
   * re-measure judges live once; by the share of orders that reach them (F3 judged those at 5%).
   */
  closure: { reached: number; atLeast1: number; atLeast5: number; atLeast10: number };
}

const mean = (values: readonly number[]) =>
  values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;

export function summarizeReplayGate(
  input: ReplayInput,
  outcomes: readonly OrderOutcome[],
  label: { rule: string; neighbours: 1 | 2 }
): ReplayGateRow {
  const sources = Math.max(1, input.roots.length);
  const accepted = new Set(
    input.verdicts.filter((verdict) => verdict.accepted).map((verdict) => pairKey(...verdict.pair))
  );
  const lost = outcomes.map((outcome) => outcome.skipped.filter((key) => accepted.has(key)).length);
  const lostPairs = new Set(
    outcomes.flatMap((outcome) => outcome.skipped.filter((key) => accepted.has(key)))
  );
  const reached = new Map<string, number>();
  for (const outcome of outcomes)
    for (const key of outcome.unjudged) reached.set(key, (reached.get(key) ?? 0) + 1);
  const reachedBy = (share: number) =>
    [...reached.values()].filter((count) => count / Math.max(1, outcomes.length) >= share).length;
  return {
    ...label,
    orders: outcomes.length,
    callsPerSource: {
      mean: mean(outcomes.map((outcome) => outcome.calls / sources)),
      max: Math.max(0, ...outcomes.map((outcome) => outcome.calls / sources))
    },
    skippedPerSource: mean(outcomes.map((outcome) => outcome.skipped.length / sources)),
    batchedCallsPerSource: mean(outcomes.map((outcome) => outcome.batches / sources)),
    pairsPerBatchedCall:
      mean(outcomes.map((outcome) => outcome.calls)) /
      Math.max(1, mean(outcomes.map((outcome) => outcome.batches))),
    expected: {
      min: Math.min(...outcomes.map((outcome) => outcome.expected)),
      mean: mean(outcomes.map((outcome) => outcome.expected))
    },
    forbiddenMax: Math.max(0, ...outcomes.map((outcome) => outcome.forbidden)),
    unjudgedPerOrder: mean(outcomes.map((outcome) => outcome.unjudged.length)),
    lostRecordedAcceptancesPerOrder: mean(lost),
    lostRecordedAcceptancePairs: lostPairs.size,
    closure: {
      reached: reached.size,
      atLeast1: reachedBy(0.01),
      atLeast5: reachedBy(0.05),
      atLeast10: reachedBy(0.1)
    }
  };
}

export interface ReplayExtras {
  /** Second-neighbour pairs per source that two neighbours add to one (all orders sampled). */
  perSource: number;
  maxCosine: number;
  medianGap: number;
}

/** The pairs only the second neighbour selects, as the gate sees them (`orders` seeded orders). */
export function replayExtras(input: ReplayInput, orders: number): ReplayExtras {
  const cosines: number[] = [];
  const gaps: number[] = [];
  const outcomes = replayOutcomes(input, {
    orders,
    neighbours: 2,
    pairGate: (context) => {
      const features = replayPairFeatures(context);
      if (features.extra) {
        cosines.push(features.cosine);
        gaps.push(features.gap);
      }
      return true;
    }
  });
  const sorted = gaps.toSorted((a, b) => a - b);
  return {
    perSource: outcomes.length
      ? cosines.length / outcomes.length / Math.max(1, input.roots.length)
      : 0,
    maxCosine: Math.max(0, ...cosines),
    medianGap: sorted[Math.floor(sorted.length / 2)] ?? 0
  };
}

export function evaluateReplayGate(
  input: ReplayInput,
  options: { orders: number; rule: GateRule | null; neighbours: 1 | 2 }
): ReplayGateRow {
  const outcomes = replayOutcomes(input, {
    orders: options.orders,
    neighbours: options.neighbours,
    ...(options.rule ? { pairGate: pairGateOf(options.rule) } : {})
  });
  return summarizeReplayGate(input, outcomes, {
    rule: options.rule
      ? options.rule.id
      : options.neighbours === 1
        ? "one neighbour"
        : "all extras",
    neighbours: options.neighbours
  });
}

// --- The report ------------------------------------------------------------------------------

export interface GateBars {
  /** LIB2: panel-positive pairs the judge must accept (D21's microbenchmark bar). */
  minAccepted: number;
  /** LIB2: panel-negative pairs it may accept at most. */
  maxPanelNegatives: number;
  /** FIX: judge calls per source (S1). */
  maxCallsPerSource: number;
}
/** Pre-registered reading of the sweep. */
export const gateBars: GateBars = { minAccepted: 12, maxPanelNegatives: 5, maxCallsPerSource: 2 };
/** F3's measured fixed latency per judge call (S0 2.89 s / 1.60 calls; S0N2 5.09 s / 2.96 calls). */
export const secondsPerJudgeCall = 1.75;

export interface GateReport {
  format: "memora-second-neighbour-gate";
  version: 1;
  orders: number;
  bars: GateBars;
  inputs: Array<{ name: string; path: string; sha256: string }>;
  problems: string[];
  lib2: {
    pairs: number;
    anchors: number;
    panelPositives: number;
    secondOnlyPositives: number;
    rows: Lib2Row[];
  };
  replay: { roots: number; extras: ReplayExtras; rows: ReplayGateRow[] };
  /** Rules that meet all three bars: LIB2 acceptances and panel-negatives, and FIX calls per source. */
  meetingAllBars: string[];
  /** Of the rules that meet the two LIB2 bars, the one with the fewest FIX calls per source. */
  closest: { rule: string; callsPerSource: number; acceptedInU: number } | null;
}

export function buildGateReport(input: {
  lib2Pairs: readonly Lib2Pair[];
  problems: string[];
  replayInput: ReplayInput;
  orders: number;
  inputs: GateReport["inputs"];
  rules?: readonly GateRule[];
  bars?: GateBars;
}): GateReport {
  const rules = input.rules ?? defaultGateRules();
  const bars = input.bars ?? gateBars;
  const lib2Rows = [
    evaluateLib2(input.lib2Pairs, "nearest-only"),
    ...rules.map((rule) => evaluateLib2(input.lib2Pairs, rule)),
    evaluateLib2(input.lib2Pairs, "all")
  ];
  const replayRows = [
    evaluateReplayGate(input.replayInput, { orders: input.orders, rule: null, neighbours: 1 }),
    ...rules.map((rule) =>
      evaluateReplayGate(input.replayInput, { orders: input.orders, rule, neighbours: 2 })
    ),
    evaluateReplayGate(input.replayInput, { orders: input.orders, rule: null, neighbours: 2 })
  ];
  const positives = input.lib2Pairs.filter((pair) => pair.panel);
  const lib2Pass = rules
    .map((rule) => ({
      rule: rule.id,
      lib2: lib2Rows.find((row) => row.rule === rule.id)!,
      replay: replayRows.find((row) => row.rule === rule.id)!
    }))
    .filter(
      ({ lib2 }) =>
        lib2.acceptedInU >= bars.minAccepted &&
        lib2.panelNegativesAccepted <= bars.maxPanelNegatives
    )
    .toSorted((a, b) => a.replay.callsPerSource.mean - b.replay.callsPerSource.mean);
  const closest = lib2Pass[0];
  return {
    format: "memora-second-neighbour-gate",
    version: 1,
    orders: input.orders,
    bars,
    inputs: input.inputs,
    problems: input.problems,
    lib2: {
      pairs: input.lib2Pairs.length,
      anchors: new Set(input.lib2Pairs.flatMap((pair) => pair.events.map((event) => event.anchor)))
        .size,
      panelPositives: positives.length,
      secondOnlyPositives: positives.filter((pair) =>
        pair.events.every((event) => event.basis === "second-nearest")
      ).length,
      rows: lib2Rows
    },
    replay: {
      roots: input.replayInput.roots.length,
      extras: replayExtras(input.replayInput, Math.min(input.orders, 200)),
      rows: replayRows
    },
    meetingAllBars: lib2Pass
      .filter(({ replay }) => replay.callsPerSource.mean <= bars.maxCallsPerSource)
      .map(({ rule }) => rule),
    closest: closest
      ? {
          rule: closest.rule,
          callsPerSource: closest.replay.callsPerSource.mean,
          acceptedInU: closest.lib2.acceptedInU
        }
      : null
  };
}

const fixed = (value: number, digits: number) => value.toFixed(digits);

export function renderGateMarkdown(report: GateReport): string {
  const replay = new Map(report.replay.rows.map((row) => [row.rule, row]));
  const name = (rule: string) =>
    rule === "nearest-only"
      ? "one neighbour"
      : rule === "all"
        ? "all extras (two neighbours)"
        : rule;
  const rows = report.lib2.rows.map((lib2) => {
    const fix = replay.get(
      lib2.rule === "nearest-only"
        ? "one neighbour"
        : lib2.rule === "all"
          ? "all extras"
          : lib2.rule
    );
    const control = lib2.rule === "nearest-only" || lib2.rule === "all";
    const cells = fix
      ? [
          fixed(fix.callsPerSource.mean, 2),
          fixed(fix.callsPerSource.max, 2),
          fixed(fix.callsPerSource.mean * secondsPerJudgeCall, 2),
          control
            ? "n/a"
            : `${fixed(fix.lostRecordedAcceptancesPerOrder, 2)} (${fix.lostRecordedAcceptancePairs})`,
          fixed(fix.batchedCallsPerSource, 2),
          `${fixed(fix.expected.mean, 1)} / ${fix.expected.min}`,
          String(fix.forbiddenMax)
        ]
      : Array.from({ length: 7 }, () => "-");
    return `| ${name(lib2.rule)} | ${lib2.acceptedInU} / ${lib2.panelPositives} | ${lib2.panelNegativesAccepted} | ${lib2.judgedPairs} (${fixed(lib2.callsPerAnchor, 2)}) | ${cells.join(" | ")} |`;
  });
  const batched = replay.get("all extras");
  const closureRows = [
    "one neighbour",
    ...(report.closest ? [report.closest.rule] : []),
    "all extras"
  ].map((rule) => {
    const fix = replay.get(rule)!;
    return `| ${rule} | ${fix.closure.reached} | ${fix.closure.atLeast1} | ${fix.closure.atLeast5} | ${fix.closure.atLeast10} |`;
  });
  return [
    "# Second-neighbour gate (F4 T71, option 2)",
    "",
    `Offline over recorded data: LIB2's ${report.lib2.pairs} labelled pairs (${report.lib2.panelPositives} panel-positive, ${report.lib2.secondOnlyPositives} of them second-nearest only, ${report.lib2.anchors} anchors) and ${report.orders} seeded arrival orders of the ${report.replay.roots}-root replay. Informs T88; it is not a gate.`,
    "",
    "A second-neighbour pair is judged when its cosine reaches the floor or it trails the nearest by at most the gap. Nearest pairs are always judged. The sweep is a fixed grid of round values; it was written after the LIB2 gaps were seen, so the pre-registration of a rule is T88's.",
    "",
    "| Rule | LIB2 accepted in U | LIB2 panel-negatives accepted | LIB2 judged pairs (per anchor) | FIX calls per source, mean | max | est. AI-call s (inference) | FIX recorded acceptances lost per order (pairs) | FIX calls per source if one call takes a root | FIX expected linked, mean / min | FIX forbidden, max |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...rows,
    "",
    "Pairs to judge live once for an S1 re-measure (reached by some order, judged by no recording), by the share of orders that reach them:",
    "",
    "| Rule | Reached | by 1% of orders | by 5% (F3's closure) | by 10% |",
    "| --- | ---: | ---: | ---: | ---: |",
    ...closureRows,
    "",
    `Bars read from the sweep: LIB2 accepted in U at least ${report.bars.minAccepted}, panel-negatives accepted at most ${report.bars.maxPanelNegatives} (D21), FIX calls per source at most ${report.bars.maxCallsPerSource} (S1).`,
    report.meetingAllBars.length
      ? `Rules meeting all three: ${report.meetingAllBars.map((id) => `\`${id}\``).join(", ")}.`
      : "No rule of the sweep meets all three bars.",
    ...(report.closest
      ? [
          `Of the rules meeting the two LIB2 bars, \`${report.closest.rule}\` costs the fewest calls: ${fixed(report.closest.callsPerSource, 2)} per source (${report.closest.acceptedInU}/${report.lib2.panelPositives} accepted).`
        ]
      : ["No rule of the sweep meets the two LIB2 bars."]),
    ...(batched
      ? [
          `One call per arriving root (option 1) would cost ${fixed(batched.batchedCallsPerSource, 2)} calls per source for two neighbours, ${fixed(batched.pairsPerBatchedCall, 2)} pairs per call.`
        ]
      : []),
    "",
    "Reading:",
    "",
    "- LIB2's cosines are the label inputs' topic-tree weighted root vectors, not the source matcher's composite vectors (FIX); an absolute floor carries over only as a hint, a gap better.",
    `- The estimated seconds use ${secondsPerJudgeCall} s per judge call (F3: 1.81 s at one neighbour, 1.72 s at two); calls are the binding bar.`,
    `- FIX's second-neighbour pairs number ${fixed(report.replay.extras.perSource, 2)} per source, trail the nearest by a median ${fixed(report.replay.extras.medianGap, 3)} and reach at most cosine ${fixed(report.replay.extras.maxCosine, 2)}${
      report.replay.extras.maxCosine < Math.min(...gateFloors)
        ? ` (its clusters link by promotion first): a floor read on LIB2 never fires there, so FIX prices the gaps only, and LIB2's judged pairs per anchor is the closer picture of a real library.`
        : "."
    }`,
    "- A pair no recording judged stays unknown in FIX (not accepted), so recorded acceptances lost is a lower bound of what a gate costs.",
    "- A gated-out pair must be recorded as decided by the gate, never as owed, or a re-plan selects it again.",
    "- The rule is chosen on 30 second-nearest pairs, 7 of them accepted: a hypothesis for T88's microbenchmark, not a result.",
    ...(report.problems.length
      ? ["", "Input problems:", "", ...report.problems.map((problem) => `- ${problem}`)]
      : []),
    ""
  ].join("\n");
}

// --- Command line ----------------------------------------------------------------------------

const cacheRoot =
  process.env.MEMORA_CACHE_ROOT ?? resolve(import.meta.dirname, "..", "..", ".cache");

export const secondNeighbourGateUsage = `Second-neighbour gate (F4 T71, option 2): offline, $0.

  --orders <n>              Seeded arrival orders of the replay (default 2000).
  --replay-input <file>     A memora-source-order-replay-input file (default: F3's final S1 replay input).
  --labels <file>           The panel's label set (default: F3's label-set.json).
  --tally <file>            The panel's tally (default: F3's tally.json).
  --context <library=file>  A label inputs context export per library (default golden and corpus).
  --verdicts <library=file> A source pair verdict report per library (default SPG and SPC).
  --json <file>             Also write the report as JSON.
  --out <file.md>           Write the Markdown report here (default: print it).
  --help                    Show this text.

Files default to the F3 data under $MEMORA_CACHE_ROOT (default: the checkout's .cache).`;

const sha256 = (text: string) => createHash("sha256").update(text).digest("hex");

async function readJson(
  path: string,
  inputs: GateReport["inputs"],
  name: string
): Promise<unknown> {
  const text = await readFile(resolve(path), "utf8");
  inputs.push({ name, path: relative(cacheRoot, resolve(path)), sha256: sha256(text) });
  return JSON.parse(text);
}

function keyed(values: readonly string[] | undefined, fallback: Record<string, string>) {
  if (!values?.length) return fallback;
  return Object.fromEntries(
    values.map((value) => {
      const at = value.indexOf("=");
      if (at < 1) throw new Error(`Expected library=file, got "${value}".`);
      return [value.slice(0, at), value.slice(at + 1)] as const;
    })
  );
}

export async function runSecondNeighbourGate(argv: readonly string[]): Promise<string | null> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      orders: { type: "string" },
      "replay-input": { type: "string" },
      labels: { type: "string" },
      tally: { type: "string" },
      context: { type: "string", multiple: true },
      verdicts: { type: "string", multiple: true },
      json: { type: "string" },
      out: { type: "string" },
      help: { type: "boolean", short: "h" }
    },
    strict: true,
    allowPositionals: false
  });
  if (values.help) return secondNeighbourGateUsage;
  const orders = values.orders === undefined ? 2000 : Number(values.orders);
  if (!Number.isInteger(orders) || orders < 1 || orders > 100_000)
    throw new Error(`Expected --orders as an integer from 1 to 100000, got ${values.orders}.`);
  const inputs: GateReport["inputs"] = [];
  const contexts = keyed(values.context, {
    golden: resolve(cacheRoot, "f3/labels/inputs/env-g-context.json"),
    corpus: resolve(cacheRoot, "f3/labels/inputs/env-c-context.json")
  });
  const verdicts = keyed(values.verdicts, {
    golden: resolve(cacheRoot, "f3/m2/runs/SPG/source-pair-verdicts.json"),
    corpus: resolve(cacheRoot, "f3/m2/runs/SPC/source-pair-verdicts.json")
  });
  const replayInput = replayInputSchema.parse(
    await readJson(
      values["replay-input"] ?? resolve(cacheRoot, "f3/m2/out/s1-replay-final/replay-input.json"),
      inputs,
      "replay-input"
    )
  );
  const lib2 = buildLib2Pairs({
    labelSet: labelSetSchema.parse(
      await readJson(
        values.labels ?? resolve(cacheRoot, "f3/labels/label-set.json"),
        inputs,
        "labels"
      )
    ),
    tally: tallySchema.parse(
      await readJson(values.tally ?? resolve(cacheRoot, "f3/labels/tally.json"), inputs, "tally")
    ),
    contexts: Object.fromEntries(
      await Promise.all(
        Object.entries(contexts).map(
          async ([library, path]) =>
            [
              library,
              contextSchema.parse(await readJson(path, inputs, `context:${library}`))
            ] as const
        )
      )
    ),
    verdicts: Object.fromEntries(
      await Promise.all(
        Object.entries(verdicts).map(
          async ([library, path]) =>
            [
              library,
              verdictReportSchema.parse(await readJson(path, inputs, `verdicts:${library}`))
            ] as const
        )
      )
    )
  });
  const report = buildGateReport({
    lib2Pairs: lib2.pairs,
    problems: lib2.problems,
    replayInput,
    orders,
    inputs: inputs.toSorted((a, b) => (a.name < b.name ? -1 : 1))
  });
  const write = async (path: string, content: string) => {
    const target = resolve(path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  };
  if (values.json) await write(values.json, `${JSON.stringify(report, null, 2)}\n`);
  const markdown = renderGateMarkdown(report);
  if (values.out) {
    await write(values.out, markdown);
    return null;
  }
  return markdown;
}

if (import.meta.main) {
  try {
    const output = await runSecondNeighbourGate(process.argv.slice(2));
    if (output !== null) console.info(output);
  } catch (error) {
    console.error(
      `[second-neighbour-gate] ${error instanceof Error ? error.message : String(error)}`
    );
    console.error("Run with --help for usage.");
    process.exitCode = 1;
  }
}
