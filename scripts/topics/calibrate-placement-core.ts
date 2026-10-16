// T29a, placement and gate calibration (spec section 9): the registered grids, the adoption
// rules and the arithmetic of `calibrate-placement.ts`. Pure, so every rule is tested apart from
// the builds and the ranker runs. The rules below were registered (here and in
// docs/topic-placement-calibration.md) before any calibration run; every run uses the calibration
// seeds 7-12 only (datasets.ts), never an evaluation seed.
//
// Medians over seeds are the mean of the two middle values for an even count.

import type { TopicTreeConfig } from "@app/domain/topic-tree";

// ---------------------------------------------------------------------------
// Small statistics

export function median(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[middle] as number)
    : ((sorted[middle - 1] as number) + (sorted[middle] as number)) / 2;
}

export const share = (part: number, whole: number): number =>
  whole === 0 ? Number.NaN : part / whole;

/** Nearest-rank percentile (0 for none). */
export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  ] as number;
}

/**
 * Area under the ROC curve of `score` separating positives from negatives (Mann-Whitney, ties
 * count half). NaN when either class is empty.
 */
export function rocAuc(positives: readonly number[], negatives: readonly number[]): number {
  if (positives.length === 0 || negatives.length === 0) return Number.NaN;
  const all = [
    ...positives.map((value) => ({ value, positive: true })),
    ...negatives.map((value) => ({ value, positive: false }))
  ].sort((a, b) => a.value - b.value);
  let rankSum = 0;
  for (let start = 0; start < all.length;) {
    let end = start;
    while (end + 1 < all.length && all[end + 1]!.value === all[start]!.value) end += 1;
    const rank = (start + end) / 2 + 1;
    for (let index = start; index <= end; index += 1) if (all[index]!.positive) rankSum += rank;
    start = end + 1;
  }
  const p = positives.length;
  return (rankSum - (p * (p + 1)) / 2) / (p * negatives.length);
}

/**
 * Sample bimodality coefficient (SAS): (g^2 + 1) / (k + 3 (n-1)^2 / ((n-2)(n-3))), with g the
 * sample skewness and k the sample excess kurtosis. Above 5/9 suggests two modes. NaN below 4
 * values or with no spread.
 */
export function bimodalityCoefficient(values: readonly number[]): number {
  const n = values.length;
  if (n < 4) return Number.NaN;
  const mean = values.reduce((sum, value) => sum + value, 0) / n;
  let m2 = 0;
  let m3 = 0;
  let m4 = 0;
  for (const value of values) {
    const d = value - mean;
    m2 += d * d;
    m3 += d * d * d;
    m4 += d * d * d * d;
  }
  m2 /= n;
  m3 /= n;
  m4 /= n;
  if (m2 <= 1e-15) return Number.NaN;
  const g1 = m3 / m2 ** 1.5;
  const skew = (Math.sqrt(n * (n - 1)) / (n - 2)) * g1;
  const g2 = m4 / (m2 * m2) - 3;
  const kurtosis = ((n - 1) / ((n - 2) * (n - 3))) * ((n + 1) * g2 + 6);
  return (skew * skew + 1) / (kurtosis + (3 * (n - 1) ** 2) / ((n - 2) * (n - 3)));
}

// ---------------------------------------------------------------------------
// Registered grids

/** The placement parameters R1 varies (config.placement). */
export interface AdmissionPoint {
  /** z: placement.spreadFactor. */
  spreadFactor: number;
  /** a_min: placement.admissionFloor. */
  admissionFloor: number;
  spreadFloor: number;
  leafFloor: number;
}

export type AdmissionParameter = keyof AdmissionPoint;

export const admissionStart: AdmissionPoint = {
  spreadFactor: 2.5,
  admissionFloor: 0.15,
  spreadFloor: 0.03,
  leafFloor: 0
};

/** R1: one-at-a-time sweeps around the start values (Spike B's curves). */
export const admissionSweeps: { readonly [K in AdmissionParameter]: readonly number[] } = {
  spreadFactor: [1.5, 2, 2.5, 3, 3.5],
  admissionFloor: [0.1, 0.15, 0.25, 0.35],
  spreadFloor: [0, 0.01, 0.03, 0.05, 0.08],
  leafFloor: [0, 0.3, 0.4, 0.5]
};

export const admissionParameters: readonly AdmissionParameter[] = [
  "spreadFactor",
  "admissionFloor",
  "spreadFloor",
  "leafFloor"
];

export function admissionPointId(point: AdmissionPoint): string {
  return `z${point.spreadFactor}-a${point.admissionFloor}-s${point.spreadFloor}-l${point.leafFloor}`;
}

/** The start point first, then every one-at-a-time variant (15 points). */
export function admissionPoints(): AdmissionPoint[] {
  const points: AdmissionPoint[] = [{ ...admissionStart }];
  for (const parameter of admissionParameters) {
    for (const value of admissionSweeps[parameter]) {
      if (value === admissionStart[parameter]) continue;
      points.push({ ...admissionStart, [parameter]: value });
    }
  }
  return points;
}

/** The parameter a one-at-a-time point varies, or null for the start point. */
export function variedParameter(point: AdmissionPoint): AdmissionParameter | null {
  return (
    admissionParameters.find((parameter) => point[parameter] !== admissionStart[parameter]) ?? null
  );
}

/** R2 grid (placement.ambiguityMargin). */
export const marginGrid: readonly number[] = [0, 0.005, 0.01, 0.015, 0.02, 0.025, 0.03, 0.04, 0.05];
export const startMargin = 0.015;

/** R3 grid (gate.temperature, gate.tau, gate.theta): 126 points. */
export const gateGrid = {
  temperature: [0.5, 1, 2],
  tau: [-2, -1, 0, 1, 2, 3, 4],
  theta: [0.3, 0.4, 0.5, 0.6, 0.7, 0.8]
} as const;

export interface GatePoint {
  temperature: number;
  tau: number;
  theta: number;
}

export const gateStart: GatePoint = { temperature: 1, tau: 0, theta: 0.5 };

export function gatePoints(): GatePoint[] {
  const points: GatePoint[] = [];
  for (const temperature of gateGrid.temperature)
    for (const tau of gateGrid.tau)
      for (const theta of gateGrid.theta) points.push({ temperature, tau, theta });
  return points;
}

export function gatePointId(point: GatePoint): string {
  return `T${point.temperature}-tau${point.tau}-theta${point.theta}`;
}

/** R4 grid (placement.labelWeight). */
export const labelWeightGrid: readonly number[] = [0, 0.1, 0.2, 0.3, 0.4, 0.5];

/** R5 split signals, scored so that a higher value means "more likely impure". */
export const splitSignals = [
  "coherence",
  "bimodality",
  "two-means-silhouette",
  "knn-modularity",
  "none-share"
] as const;
export type SplitSignal = (typeof splitSignals)[number];

/** R6 grid (repair.siblingMergeCosine). */
export const mergeGrid: readonly number[] = [0.75, 0.78, 0.8, 0.82, 0.85, 0.88, 0.9];
export const startMergeCosine = 0.85;

/** R7 grid (audit.misParentMargin). */
export const misParentGrid: readonly number[] = [0, 0.025, 0.05, 0.075, 0.1, 0.125, 0.15, 0.2];
/** The gate-A stability calibration's re-parent hysteresis (docs/kpi-f2.md): R7's floor. */
export const misParentFloor = 0.1;

/** Registered thresholds of the rules. */
export const ruleBars = {
  /** R1 (b): LOSO score gain a non-start value needs, in points. */
  losoGain: 0.01,
  /** R1 (b): corpus auto precision may drop at most this much. */
  corpusPrecisionDrop: 0.01,
  /** R1 (b): corpus admission to a leaf may drop at most this much. */
  corpusAdmissionDrop: 0.02,
  /** R1 (a): parity with Spike B. */
  parityPoints: 0.01,
  /** R2 and R3: D19 (a). */
  autoPrecision: 0.9,
  /** R3: every split's accepted precision at least this. */
  gateSplitPrecision: 0.85,
  /** R3: median accepted share of gated notes at least this. */
  gateAcceptedShare: 0.1,
  /** R3: ties of the correct share within this. */
  gateTie: 0.002,
  /** D19 (b). */
  newTopicGated: 0.5,
  /** D19 (c), seconds per gated note. */
  gateP95Seconds: 0.3,
  /** R4. */
  labelTop1Gain: 0.02,
  /** R5. */
  splitAuc: 0.75,
  splitMinLeaf: 6,
  pureShare: 0.9,
  impureShare: 0.6,
  noneShareMinNotes: 3,
  /** R6. */
  mergePrecision: 0.9,
  mergeMinPairs: 20,
  /** R7. */
  misParentPrecision: 0.9,
  plantedShare: 0.05,
  plantedMin: 5
} as const;

/** Spike B medians (title-stripped Louvain, docs/spikes/spike-b-topic-tree.md) for R1 (a). */
export const spikeBParity = {
  known: { top1: 0.889, admitted: 0.98, gated03: 0.278, autoPrecision03: 0.923 },
  new: { top1: 0.699, admitted: 0.873, gated03: 0.484, autoPrecision03: 0.719 }
} as const;

// ---------------------------------------------------------------------------
// R1 and R2: placement outcomes

/** What PLACE did with one held-out note at one admission point (margin applied later). */
export interface NoteOutcome {
  /** A leaf admitted the note (auto or gate at some margin). */
  admitted: boolean;
  /** Best admitted leaf minus the best other leaf; null without a rival (or not admitted). */
  margin: number | null;
  /** The best admitted leaf's majority label is the note's. */
  bestRight: boolean;
  /** The best-scoring leaf the beam reached (admitted or not) is right. */
  top1Right: boolean;
  /** The best right-label leaf reached was admitted (null: none reached). */
  rightAdmitted: boolean | null;
  /** The best wrong-label leaf reached was admitted (null: none reached). */
  wrongAdmitted: boolean | null;
}

export const isAuto = (outcome: NoteOutcome, margin: number): boolean =>
  outcome.admitted && (outcome.margin === null || outcome.margin >= margin);

export interface OutcomeSummary {
  notes: number;
  top1: number;
  admitted: number;
  rightAdmitted: number;
  wrongAdmitted: number;
  /** Per margin of `marginGrid` (same order). */
  byMargin: { margin: number; auto: number; gated: number; autoPrecision: number }[];
}

export function summarizeOutcomes(
  outcomes: readonly NoteOutcome[],
  margins: readonly number[] = marginGrid
): OutcomeSummary {
  const count = (test: (outcome: NoteOutcome) => boolean): number =>
    outcomes.reduce((total, outcome) => total + (test(outcome) ? 1 : 0), 0);
  const reachedRight = outcomes.filter((outcome) => outcome.rightAdmitted !== null);
  const reachedWrong = outcomes.filter((outcome) => outcome.wrongAdmitted !== null);
  return {
    notes: outcomes.length,
    top1: share(
      count((outcome) => outcome.top1Right),
      outcomes.length
    ),
    admitted: share(
      count((outcome) => outcome.admitted),
      outcomes.length
    ),
    rightAdmitted: share(
      reachedRight.filter((outcome) => outcome.rightAdmitted).length,
      reachedRight.length
    ),
    wrongAdmitted: share(
      reachedWrong.filter((outcome) => outcome.wrongAdmitted).length,
      reachedWrong.length
    ),
    byMargin: margins.map((margin) => {
      const auto = outcomes.filter((outcome) => isAuto(outcome, margin));
      return {
        margin,
        auto: share(auto.length, outcomes.length),
        gated: share(
          count((outcome) => outcome.admitted && !isAuto(outcome, margin)),
          outcomes.length
        ),
        autoPrecision: share(auto.filter((outcome) => outcome.bestRight).length, auto.length)
      };
    })
  };
}

export const atMargin = (summary: OutcomeSummary, margin: number) => {
  const row = summary.byMargin.find((entry) => Math.abs(entry.margin - margin) < 1e-12);
  if (!row) throw new RangeError(`Margin ${margin} is not in the summary`);
  return row;
};

/** One leave-one-source-out note (R1 b): its label leaf exists in the base tree or not. */
export interface LosoOutcome extends NoteOutcome {
  /** A base leaf carries the note's label (a known topic); otherwise a new topic. */
  known: boolean;
}

export interface LosoSummary {
  notes: number;
  known: number;
  /** R1 (b) score at `margin`. */
  score: number;
  knownAutoRight: number;
  newNotAbsorbed: number;
  /** Notes left waiting with no decider (gated or unadmitted). */
  waiting: number;
  /** Precision of the best admitted leaf on the gated notes (the margin-only fallback). */
  gatedBaselinePrecision: number;
}

export function summarizeLoso(outcomes: readonly LosoOutcome[], margin: number): LosoSummary {
  let knownAutoRight = 0;
  let newNotAbsorbed = 0;
  let waiting = 0;
  let gated = 0;
  let gatedRight = 0;
  for (const outcome of outcomes) {
    const auto = isAuto(outcome, margin);
    if (outcome.known && auto && outcome.bestRight) knownAutoRight += 1;
    if (!outcome.known && !auto) newNotAbsorbed += 1;
    if (!auto) waiting += 1;
    if (outcome.admitted && !auto) {
      gated += 1;
      if (outcome.bestRight) gatedRight += 1;
    }
  }
  return {
    notes: outcomes.length,
    known: outcomes.filter((outcome) => outcome.known).length,
    score: share(knownAutoRight + newNotAbsorbed, outcomes.length),
    knownAutoRight,
    newNotAbsorbed,
    waiting: share(waiting, outcomes.length),
    gatedBaselinePrecision: share(gatedRight, gated)
  };
}

// ---------------------------------------------------------------------------
// R1: adoption of the admission values

/** One split's summary of one admission point on one dataset and holdout. */
export interface AdmissionRow {
  dataset: string;
  /** `known` (items holdout), `new` (articles with twins) or `loso`. */
  holdout: "known" | "new" | "loso";
  seed: number;
  point: string;
  values: AdmissionPoint;
  summary: OutcomeSummary | null;
  loso: LosoSummary | null;
}

export interface AdmissionChoice {
  adopted: AdmissionPoint;
  /** Per parameter: the qualifying values with their gains, and the verdict. */
  parameters: {
    parameter: AdmissionParameter;
    start: number;
    chosen: number;
    candidates: {
      value: number;
      losoScore: number;
      losoGain: number;
      precisionDrop: number;
      admissionDrop: number;
      qualifies: boolean;
    }[];
  }[];
  startLosoScore: number;
  combination: { checked: boolean; kept: boolean };
}

const medianOf = (rows: readonly AdmissionRow[], pick: (row: AdmissionRow) => number): number =>
  median(rows.map(pick).filter((value) => Number.isFinite(value)));

/** The LOSO score of a point: the median over seeds per set, averaged over the sets. */
export function losoScore(rows: readonly AdmissionRow[], point: string): number {
  const mine = rows.filter((row) => row.holdout === "loso" && row.point === point && row.loso);
  const sets = [...new Set(mine.map((row) => row.dataset))].sort();
  if (sets.length === 0) return Number.NaN;
  const perSet = sets.map((set) =>
    medianOf(
      mine.filter((row) => row.dataset === set),
      (row) => row.loso!.score
    )
  );
  return perSet.reduce((sum, value) => sum + value, 0) / perSet.length;
}

/** The worst (over corpus sets) median drop of known-topic auto precision and admission. */
export function corpusDrops(
  rows: readonly AdmissionRow[],
  point: string,
  startPoint: string,
  margin = startMargin
): { precisionDrop: number; admissionDrop: number } {
  const known = rows.filter((row) => row.holdout === "known" && row.summary);
  const sets = [...new Set(known.map((row) => row.dataset))].sort();
  let precisionDrop = Number.NEGATIVE_INFINITY;
  let admissionDrop = Number.NEGATIVE_INFINITY;
  for (const set of sets) {
    const of = (id: string) => known.filter((row) => row.dataset === set && row.point === id);
    const precision = (id: string) =>
      medianOf(of(id), (row) => atMargin(row.summary!, margin).autoPrecision);
    const admitted = (id: string) => medianOf(of(id), (row) => row.summary!.admitted);
    precisionDrop = Math.max(precisionDrop, precision(startPoint) - precision(point));
    admissionDrop = Math.max(admissionDrop, admitted(startPoint) - admitted(point));
  }
  return { precisionDrop, admissionDrop };
}

/**
 * R1 (b): each parameter keeps its start value unless a grid value raises the LOSO score by at
 * least `losoGain` without dropping corpus known-topic auto precision (at the start margin) by
 * more than `corpusPrecisionDrop` or admission by more than `corpusAdmissionDrop`; among
 * qualifying values the highest score wins (ties: nearest the start). When several parameters
 * change, `combined` (the rows of the combined point, when measured) must qualify too, otherwise
 * only the parameter with the largest gain changes.
 */
export function chooseAdmission(
  rows: readonly AdmissionRow[],
  combined?: (point: AdmissionPoint) => readonly AdmissionRow[] | null
): AdmissionChoice {
  const startId = admissionPointId(admissionStart);
  const startScore = losoScore(rows, startId);
  const parameters = admissionParameters.map((parameter) => {
    const candidates = admissionSweeps[parameter]
      .filter((value) => value !== admissionStart[parameter])
      .map((value) => {
        const point = { ...admissionStart, [parameter]: value };
        const id = admissionPointId(point);
        const score = losoScore(rows, id);
        const drops = corpusDrops(rows, id, startId);
        const gain = score - startScore;
        return {
          value,
          losoScore: score,
          losoGain: gain,
          ...drops,
          qualifies:
            Number.isFinite(gain) &&
            gain >= ruleBars.losoGain - 1e-12 &&
            drops.precisionDrop <= ruleBars.corpusPrecisionDrop + 1e-12 &&
            drops.admissionDrop <= ruleBars.corpusAdmissionDrop + 1e-12
        };
      });
    const best = candidates
      .filter((candidate) => candidate.qualifies)
      .sort(
        (a, b) =>
          b.losoScore - a.losoScore ||
          Math.abs(a.value - admissionStart[parameter]) -
            Math.abs(b.value - admissionStart[parameter]) ||
          a.value - b.value
      )[0];
    return {
      parameter,
      start: admissionStart[parameter],
      chosen: best?.value ?? admissionStart[parameter],
      candidates,
      gain: best?.losoGain ?? 0
    };
  });
  const changed = parameters.filter((entry) => entry.chosen !== entry.start);
  let adopted: AdmissionPoint = { ...admissionStart };
  for (const entry of changed) adopted = { ...adopted, [entry.parameter]: entry.chosen };
  const combination = { checked: false, kept: true };
  if (changed.length > 1) {
    combination.checked = true;
    const measured = combined?.(adopted) ?? null;
    const id = admissionPointId(adopted);
    const all = measured ? [...rows, ...measured] : rows;
    const gain = losoScore(all, id) - startScore;
    const drops = corpusDrops(all, id, startId);
    combination.kept =
      measured !== null &&
      gain >= ruleBars.losoGain - 1e-12 &&
      drops.precisionDrop <= ruleBars.corpusPrecisionDrop + 1e-12 &&
      drops.admissionDrop <= ruleBars.corpusAdmissionDrop + 1e-12;
    if (!combination.kept) {
      const top = [...changed].sort((a, b) => b.gain - a.gain)[0]!;
      adopted = { ...admissionStart, [top.parameter]: top.chosen };
      for (const entry of parameters) {
        if (entry.parameter !== top.parameter) entry.chosen = entry.start;
      }
    }
  }
  return {
    adopted,
    parameters: parameters.map((entry) => ({
      parameter: entry.parameter,
      start: entry.start,
      chosen: entry.chosen,
      candidates: entry.candidates
    })),
    startLosoScore: startScore,
    combination
  };
}

// ---------------------------------------------------------------------------
// R2: the ambiguity margin

export interface MarginChoice {
  margin: number | null;
  /** Per margin: the minimum auto precision over every seed of every dataset. */
  table: { margin: number; minPrecision: number; medianPrecision: number; medianGated: number }[];
}

/** R2: the smallest margin whose known-topic auto precision is at least 0.90 in every split. */
export function chooseMargin(rows: readonly AdmissionRow[], point: AdmissionPoint): MarginChoice {
  const id = admissionPointId(point);
  const known = rows.filter((row) => row.holdout === "known" && row.point === id && row.summary);
  const table = marginGrid.map((margin) => {
    const entries = known.map((row) => atMargin(row.summary!, margin));
    const precisions = entries.map((entry) => entry.autoPrecision);
    return {
      margin,
      minPrecision: precisions.length > 0 ? Math.min(...precisions) : Number.NaN,
      medianPrecision: median(precisions),
      medianGated: median(entries.map((entry) => entry.gated))
    };
  });
  const chosen = table.find(
    (entry) => known.length > 0 && entry.minPrecision >= ruleBars.autoPrecision - 1e-12
  );
  return { margin: chosen?.margin ?? null, table };
}

// ---------------------------------------------------------------------------
// R3: the gate

/** One gated note of a gate split, with its candidates in the ranker's order. */
export interface GateNote {
  seed: number;
  /** The candidates the ranker scored: their log-odds and whether each is right. */
  logOdds: number[];
  right: boolean[];
  /** The margin-only choice (best admitted leaf) is right. */
  bestRight: boolean;
}

export interface GateSplitMetrics {
  seed: number;
  gated: number;
  accepted: number;
  acceptedRight: number;
  none: number;
}

/** softmax([logOdds..., tau] / T): accept the best candidate when its p reaches theta (D10). */
export function gateAccepts(
  logOdds: readonly number[],
  point: GatePoint
): { accepted: boolean; index: number } {
  if (logOdds.length === 0) return { accepted: false, index: -1 };
  const values = [...logOdds, point.tau].map((value) => value / point.temperature);
  const max = Math.max(...values);
  const exps = values.map((value) => Math.exp(value - max));
  const total = exps.reduce((sum, value) => sum + value, 0);
  let best = 0;
  for (let index = 1; index < logOdds.length; index += 1) {
    if ((exps[index] as number) > (exps[best] as number)) best = index;
  }
  return { accepted: (exps[best] as number) / total >= point.theta, index: best };
}

export function gateSplitMetrics(notes: readonly GateNote[], point: GatePoint): GateSplitMetrics[] {
  const seeds = [...new Set(notes.map((note) => note.seed))].sort((a, b) => a - b);
  return seeds.map((seed) => {
    const mine = notes.filter((note) => note.seed === seed);
    let accepted = 0;
    let acceptedRight = 0;
    for (const note of mine) {
      const verdict = gateAccepts(note.logOdds, point);
      if (!verdict.accepted) continue;
      accepted += 1;
      if (note.right[verdict.index]) acceptedRight += 1;
    }
    return { seed, gated: mine.length, accepted, acceptedRight, none: mine.length - accepted };
  });
}

export interface GatePointSummary {
  point: GatePoint;
  id: string;
  medianPrecision: number;
  minPrecision: number;
  medianAcceptedShare: number;
  medianCorrectShare: number;
  medianNoneShare: number;
  eligible: boolean;
}

export function summarizeGatePoint(notes: readonly GateNote[], point: GatePoint): GatePointSummary {
  const splits = gateSplitMetrics(notes, point);
  const precisions = splits.map((split) => share(split.acceptedRight, split.accepted));
  const finite = precisions.filter((value) => Number.isFinite(value));
  const medianPrecision = median(finite);
  const minPrecision =
    finite.length === splits.length && finite.length > 0 ? Math.min(...finite) : Number.NaN;
  const medianAcceptedShare = median(splits.map((split) => share(split.accepted, split.gated)));
  return {
    point,
    id: gatePointId(point),
    medianPrecision,
    minPrecision,
    medianAcceptedShare,
    medianCorrectShare: median(splits.map((split) => share(split.acceptedRight, split.gated))),
    medianNoneShare: median(splits.map((split) => share(split.none, split.gated))),
    eligible:
      medianPrecision >= ruleBars.autoPrecision - 1e-12 &&
      minPrecision >= ruleBars.gateSplitPrecision - 1e-12 &&
      medianAcceptedShare >= ruleBars.gateAcceptedShare - 1e-12
  };
}

const startDistance = (point: GatePoint): [number, number, number] => [
  Math.abs(point.tau - gateStart.tau),
  Math.abs(point.temperature - gateStart.temperature),
  Math.abs(point.theta - gateStart.theta)
];

function compareNearStart(a: GatePoint, b: GatePoint): number {
  const da = startDistance(a);
  const db = startDistance(b);
  return (
    (da[0] as number) - (db[0] as number) ||
    (da[1] as number) - (db[1] as number) ||
    (da[2] as number) - (db[2] as number) ||
    a.temperature - b.temperature ||
    a.tau - b.tau ||
    a.theta - b.theta
  );
}

export interface GateChoice {
  chosen: GatePointSummary | null;
  /** "eligible" (rule steps 1-2) or "fallback" (step 3, no eligible point). */
  how: "eligible" | "fallback" | "none";
  summaries: GatePointSummary[];
  /** Margin-only baseline on the same gated notes (median over splits). */
  baseline: { precision: number; correctShare: number };
  /** The ranker's best candidate, whatever the rule says (median over splits). */
  rankerTop1: number;
}

/**
 * R3: among points with median accepted precision >= 0.90, every split >= 0.85 and median
 * accepted share >= 0.10, the highest median correct share (ties within 0.002: higher median
 * precision, then nearest the start); with none eligible, the highest median precision among
 * points with median accepted share >= 0.10.
 */
export function chooseGate(notes: readonly GateNote[]): GateChoice {
  const summaries = gatePoints().map((point) => summarizeGatePoint(notes, point));
  const eligible = summaries.filter((summary) => summary.eligible);
  let chosen: GatePointSummary | null;
  let how: GateChoice["how"];
  if (eligible.length > 0) {
    const top = Math.max(...eligible.map((summary) => summary.medianCorrectShare));
    chosen =
      eligible
        .filter((summary) => summary.medianCorrectShare >= top - ruleBars.gateTie - 1e-12)
        .sort(
          (a, b) => b.medianPrecision - a.medianPrecision || compareNearStart(a.point, b.point)
        )[0] ?? null;
    how = "eligible";
  } else {
    const floor = summaries.filter(
      (summary) =>
        summary.medianAcceptedShare >= ruleBars.gateAcceptedShare - 1e-12 &&
        Number.isFinite(summary.medianPrecision)
    );
    chosen =
      floor.sort(
        (a, b) => b.medianPrecision - a.medianPrecision || compareNearStart(a.point, b.point)
      )[0] ?? null;
    how = chosen ? "fallback" : "none";
  }
  const seeds = [...new Set(notes.map((note) => note.seed))];
  const baselinePrecision = median(
    seeds.map((seed) => {
      const mine = notes.filter((note) => note.seed === seed);
      return share(mine.filter((note) => note.bestRight).length, mine.length);
    })
  );
  const rankerTop1 = median(
    seeds.map((seed) => {
      const mine = notes.filter((note) => note.seed === seed && note.logOdds.length > 0);
      return share(
        mine.filter((note) => note.right[gateAccepts(note.logOdds, gateStart).index]).length,
        mine.length
      );
    })
  );
  return {
    chosen,
    how,
    summaries,
    baseline: { precision: baselinePrecision, correctShare: baselinePrecision },
    rankerTop1
  };
}

// ---------------------------------------------------------------------------
// R5: split signals

export interface LeafSignals {
  seed: number;
  dataset: string;
  size: number;
  /** Majority-label share of the leaf's members. */
  purity: number;
  signals: Partial<Record<SplitSignal, number>>;
}

export interface SplitSignalVerdict {
  signal: SplitSignal | "off";
  auc: { signal: SplitSignal; dataset: string; auc: number; impure: number; pure: number }[];
}

/** R5: AUC of each signal (impure positive) per dataset; activate the best only at >= 0.75 on all. */
export function splitSignalVerdict(leaves: readonly LeafSignals[]): SplitSignalVerdict {
  const datasets = [...new Set(leaves.map((leaf) => leaf.dataset))].sort();
  const auc: SplitSignalVerdict["auc"] = [];
  for (const signal of splitSignals) {
    for (const dataset of datasets) {
      const scored = leaves.filter(
        (leaf) =>
          leaf.dataset === dataset &&
          leaf.size >= ruleBars.splitMinLeaf &&
          Number.isFinite(leaf.signals[signal] ?? Number.NaN)
      );
      const impure = scored.filter((leaf) => leaf.purity < ruleBars.impureShare);
      const pure = scored.filter((leaf) => leaf.purity >= ruleBars.pureShare);
      if (impure.length === 0 && pure.length === 0) continue;
      auc.push({
        signal,
        dataset,
        auc: rocAuc(
          impure.map((leaf) => leaf.signals[signal] as number),
          pure.map((leaf) => leaf.signals[signal] as number)
        ),
        impure: impure.length,
        pure: pure.length
      });
    }
  }
  const passing = splitSignals
    .map((signal) => {
      const rows = auc.filter((entry) => entry.signal === signal);
      return {
        signal,
        rows,
        worst: rows.length > 0 ? Math.min(...rows.map((entry) => entry.auc)) : Number.NaN
      };
    })
    .filter(
      (entry) =>
        entry.rows.length > 0 &&
        entry.rows.every((row) => Number.isFinite(row.auc)) &&
        entry.worst >= ruleBars.splitAuc - 1e-12
    )
    .sort((a, b) => b.worst - a.worst);
  return { signal: passing[0]?.signal ?? "off", auc };
}

// ---------------------------------------------------------------------------
// R6: sibling merge

export interface SiblingPair {
  dataset: string;
  seed: number;
  cosine: number;
  /** Combined size of the two leaves. */
  size: number;
  /** Same majority article-with-twin unit. */
  sameUnit: boolean;
}

export interface ThresholdTable {
  value: number;
  pairs: number;
  precision: number;
  /** Lowest per-seed precision over seeds with at least one pair, over every dataset. */
  minSeedPrecision: number;
  qualifies: boolean;
}

/** R6: the smallest cosine with precision >= 0.90 in every seed with pairs and >= 20 pairs per dataset. */
export function chooseMergeCosine(
  pairs: readonly SiblingPair[],
  maxSize: number
): { chosen: number | null; table: ThresholdTable[] } {
  const eligible = pairs.filter((pair) => pair.size <= maxSize);
  const datasets = [...new Set(eligible.map((pair) => pair.dataset))].sort();
  const table = mergeGrid.map((value) => {
    const above = eligible.filter((pair) => pair.cosine >= value);
    let minSeedPrecision = Number.POSITIVE_INFINITY;
    let enough = datasets.length > 0;
    for (const dataset of datasets) {
      const mine = above.filter((pair) => pair.dataset === dataset);
      if (mine.length < ruleBars.mergeMinPairs) enough = false;
      for (const seed of new Set(mine.map((pair) => pair.seed))) {
        const seeded = mine.filter((pair) => pair.seed === seed);
        minSeedPrecision = Math.min(
          minSeedPrecision,
          share(seeded.filter((pair) => pair.sameUnit).length, seeded.length)
        );
      }
    }
    if (!Number.isFinite(minSeedPrecision)) minSeedPrecision = Number.NaN;
    return {
      value,
      pairs: above.length,
      precision: share(above.filter((pair) => pair.sameUnit).length, above.length),
      minSeedPrecision,
      qualifies: enough && minSeedPrecision >= ruleBars.mergePrecision - 1e-12
    };
  });
  return { chosen: table.find((entry) => entry.qualifies)?.value ?? null, table };
}

// ---------------------------------------------------------------------------
// R7: mis-parent margin

/** One re-parent proposal on a tree with planted errors. */
export interface MisParentProposal {
  dataset: string;
  seed: number;
  /** Uncle cosine minus parent cosine. */
  gain: number;
  /** A planted topic proposed back to its original parent. */
  restoresPlanted: boolean;
}

export interface MisParentRun {
  dataset: string;
  seed: number;
  planted: number;
  /** Every candidate proposal at margin 0 (the grid filters by gain). */
  proposals: MisParentProposal[];
}

export function misParentTable(runs: readonly MisParentRun[]) {
  return misParentGrid.map((margin) => {
    let minPrecision = Number.POSITIVE_INFINITY;
    let tp = 0;
    let all = 0;
    let planted = 0;
    for (const run of runs) {
      const kept = run.proposals.filter((proposal) => proposal.gain >= margin - 1e-12);
      const hits = kept.filter((proposal) => proposal.restoresPlanted).length;
      tp += hits;
      all += kept.length;
      planted += run.planted;
      if (kept.length > 0) minPrecision = Math.min(minPrecision, hits / kept.length);
    }
    return {
      margin,
      proposals: all,
      precision: share(tp, all),
      minRunPrecision: Number.isFinite(minPrecision) ? minPrecision : Number.NaN,
      recall: share(tp, planted)
    };
  });
}

/**
 * R7: the smallest grid margin at or above the stability floor (0.1) whose precision is at least
 * 0.90 in every run (seed and dataset); also the smallest margin meeting the bar without the floor.
 */
export function chooseMisParentMargin(runs: readonly MisParentRun[]): {
  chosen: number | null;
  withoutFloor: number | null;
  table: ReturnType<typeof misParentTable>;
} {
  const table = misParentTable(runs);
  const passes = (entry: (typeof table)[number]) =>
    runs.length > 0 &&
    (entry.proposals === 0 || entry.minRunPrecision >= ruleBars.misParentPrecision - 1e-12);
  return {
    chosen:
      table.find((entry) => entry.margin >= misParentFloor - 1e-12 && passes(entry))?.margin ??
      null,
    withoutFloor: table.find(passes)?.margin ?? null,
    table
  };
}

// ---------------------------------------------------------------------------
// The adopted values (the JSON T29b and the calibration rows read)

export interface AdoptedGate {
  /** Catalog id of the ranker (`mlx-qwen3-reranker-0.6b`, `gguf-qwen3-reranker-0.6b-q8-0`). */
  catalogId: string;
  runtime: "mlx" | "gguf";
  /** The decider key the offline runs computed (gateDeciderKey of the catalog entry). */
  deciderKey: string;
  temperature: number;
  tau: number;
  theta: number;
  how: GateChoice["how"];
  metrics: Record<string, number | string | null>;
}

/** The config paths T29b applies, from the adopted values (placement and structure rows). */
export function configOverrides(adopted: {
  admission: AdmissionPoint;
  margin: number;
  gateDefault: GatePoint;
  labelWeight: number;
  splitSignal: { signal: SplitSignal | "off"; threshold: number | null };
  siblingMergeCosine: number;
  misParentMargin: number;
}): Record<string, number | string | null> {
  return {
    "placement.spreadFactor": adopted.admission.spreadFactor,
    "placement.admissionFloor": adopted.admission.admissionFloor,
    "placement.spreadFloor": adopted.admission.spreadFloor,
    "placement.leafFloor": adopted.admission.leafFloor,
    "placement.ambiguityMargin": adopted.margin,
    "placement.labelWeight": adopted.labelWeight,
    "gate.temperature": adopted.gateDefault.temperature,
    "gate.tau": adopted.gateDefault.tau,
    "gate.theta": adopted.gateDefault.theta,
    "splitSignal.signal": adopted.splitSignal.signal,
    "splitSignal.threshold": adopted.splitSignal.threshold,
    "repair.siblingMergeCosine": adopted.siblingMergeCosine,
    "audit.misParentMargin": adopted.misParentMargin
  };
}

/** The gate group of a configuration with one decider's calibrated values. */
export function gateConfigFor(
  base: TopicTreeConfig["gate"],
  point: GatePoint
): TopicTreeConfig["gate"] {
  return { ...base, temperature: point.temperature, tau: point.tau, theta: point.theta };
}
