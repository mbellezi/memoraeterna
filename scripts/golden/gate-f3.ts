/**
 * The F3 gate over several measurement samples (exit criteria X1 and S1 of the F3 spec, section 5.5):
 * each sample is one re-match run's library, scored per partition on the shown relations (applied,
 * suggested or kept) with the applied-only counts beside, then the mean and the minimum over samples.
 *
 * A sample summary holds counts only, so it can be stored and aggregated later. The held-out partition
 * is withheld from a summary unless the freeze record exists (decision D3): a sealed sample has no
 * held-out numbers at all, and every verdict that needs them is undecided.
 */
import { z } from "zod";

import { callsPerChapterSchema } from "./calls-per-chapter.ts";
import { sealedNotice, type HeldOutAccess } from "./freeze-guard.ts";
import type { LayerScore, MatchingEvaluation, PartitionScore } from "./matching-evaluation.ts";

export const gateSampleFormat = "memora-golden-gate-f3-sample";

const count = z.number().int().nonnegative();
const nullableNumber = z.number().nullable();

const layerSummarySchema = z.object({
  relations: count,
  rootPairs: count,
  expected: z.object({ found: count, total: count, evaluable: count }),
  forbidden: z.object({ linked: count, total: count, evaluable: count }),
  /** Linked root pairs that carry no label ("bridges"). */
  bridges: count
});
export type LayerSummary = z.infer<typeof layerSummarySchema>;

const partitionSummarySchema = z.object({
  roots: z.object({ total: count, resolved: count }),
  notes: count,
  /** Shown relations: applied, suggested or kept (decision D23). */
  shown: layerSummarySchema,
  /** Applied relations only, beside the shown ones. */
  applied: layerSummarySchema,
  sources: layerSummarySchema,
  either: layerSummarySchema
});
export type PartitionSummary = z.infer<typeof partitionSummarySchema>;

export const gateSampleSchema = z.object({
  format: z.literal(gateSampleFormat),
  version: z.literal(1),
  label: z.string(),
  database: z.string().nullable(),
  generatedAt: z.string().nullable(),
  heldOut: z.enum(["open", "sealed"]),
  partitions: z.object({
    tuning: partitionSummarySchema,
    holdout: partitionSummarySchema.nullable()
  }),
  source: z.object({
    roots: count,
    calls: count,
    replayed: count,
    callsPerRoot: nullableNumber,
    /** AI-call seconds per source (decision D2); wall seconds beside. */
    aiSecondsPerRoot: nullableNumber,
    wallSecondsPerRoot: nullableNumber,
    relations: z.object({ promoted: count, judged: count, unknown: count })
  }),
  notes: z.object({
    count,
    calls: count,
    replayed: count,
    callsPerNote: nullableNumber,
    secondsPerNote: nullableNumber
  }),
  callsPerChapter: callsPerChapterSchema.nullable(),
  warnings: z.array(z.string())
});
export type GateSample = z.infer<typeof gateSampleSchema>;

/** A stored sample read again after the freeze record was removed: its held-out numbers go. */
export function resealSample(sample: GateSample, reason: string): GateSample {
  if (sample.heldOut === "sealed") return sample;
  return {
    ...sample,
    heldOut: "sealed",
    partitions: { tuning: sample.partitions.tuning, holdout: null },
    warnings: [...sample.warnings, sealedNotice(reason)]
  };
}

const summarizeLayer = (layer: LayerScore): LayerSummary => ({
  relations: layer.relations,
  rootPairs: layer.rootPairs,
  expected: {
    found: layer.expected.hit,
    total: layer.expected.total,
    evaluable: layer.expected.evaluable
  },
  forbidden: {
    linked: layer.forbidden.hit,
    total: layer.forbidden.total,
    evaluable: layer.forbidden.evaluable
  },
  bridges: layer.unlabelledPairs
});

const summarizePartition = (score: PartitionScore): PartitionSummary => ({
  roots: score.roots,
  notes: score.notes,
  shown: summarizeLayer(score.layers.notes),
  applied: summarizeLayer(score.layers.notesApplied),
  sources: summarizeLayer(score.layers.sources),
  either: summarizeLayer(score.layers.either)
});

/** One sample's counts; held-out is left out unless the freeze record is open. */
export function summarizeSample(
  label: string,
  evaluation: MatchingEvaluation,
  access: HeldOutAccess,
  context: { database?: string | null; generatedAt?: string | null } = {}
): GateSample {
  const open = access.open && evaluation.partitions.holdout.sealed !== true;
  const { noteMatching, sourceMatching } = evaluation.cost;
  const warnings = evaluation.resolution.warnings.filter(
    (warning) => !warning.startsWith("held-out sealed")
  );
  if (!open) warnings.push(sealedNotice(access.open ? "the evaluation was sealed" : access.reason));
  return {
    format: gateSampleFormat,
    version: 1,
    label,
    database: context.database ?? null,
    generatedAt: context.generatedAt ?? null,
    heldOut: open ? "open" : "sealed",
    partitions: {
      tuning: summarizePartition(evaluation.partitions.tuning),
      holdout: open ? summarizePartition(evaluation.partitions.holdout) : null
    },
    source: {
      roots: sourceMatching.roots,
      calls: sourceMatching.group.calls,
      replayed: sourceMatching.group.replayed,
      callsPerRoot: sourceMatching.callsPerRoot,
      aiSecondsPerRoot: sourceMatching.secondsPerRoot,
      wallSecondsPerRoot: sourceMatching.wallSecondsPerRoot,
      relations: sourceMatching.relationsByOrigin
    },
    notes: {
      count: noteMatching.notes,
      calls: noteMatching.group.calls,
      replayed: noteMatching.group.replayed,
      callsPerNote: noteMatching.callsPerNote,
      secondsPerNote: noteMatching.secondsPerNote
    },
    callsPerChapter: evaluation.cost.callsPerChapter,
    warnings
  };
}

// --- Aggregation ---------------------------------------------------------------------------------

export interface GateOptions {
  /** Samples required for a verdict (decision D2: four). */
  minSamples: number;
  /** X1: mean held-out expected pairs found over the samples. */
  minMeanExpected: number;
  /** X1: no sample below this many held-out expected pairs. */
  minSampleExpected: number;
  /** X1 and S1: forbidden root pairs linked allowed in any sample. */
  maxForbidden: number;
  /** S1: tuning expected pairs the source layer must link (25-26 of 26). */
  minTuningSourceExpected: number;
  /** S1: soft ceiling of held-out bridges; exceeding it is reported, not failed. */
  bridgeCeiling: number;
  /** S1: AI-call seconds per source. */
  maxSourceSeconds: number;
  /** S1: calls per source. */
  maxSourceCalls: number;
  /** Labels of the samples whose judge ran live: S1's time and replay checks apply to them. */
  liveJudge: readonly string[];
}

export const defaultGateOptions: GateOptions = {
  minSamples: 4,
  minMeanExpected: 27,
  minSampleExpected: 26,
  maxForbidden: 0,
  minTuningSourceExpected: 25,
  bridgeCeiling: 8,
  maxSourceSeconds: 5,
  maxSourceCalls: 2,
  liveJudge: []
};

export interface Series {
  values: Array<{ label: string; value: number | null }>;
  mean: number | null;
  min: number | null;
  max: number | null;
}

export interface GateVerdict {
  /** True/false once measured; null when it cannot be decided (see `note`). */
  pass: boolean | null;
  note?: string;
}

export interface GateReport {
  format: "memora-golden-gate-f3";
  version: 1;
  options: GateOptions;
  samples: GateSample[];
  series: {
    heldOutShownExpected: Series;
    heldOutShownForbidden: Series;
    heldOutAppliedExpected: Series;
    heldOutAppliedForbidden: Series;
    tuningShownExpected: Series;
    tuningShownForbidden: Series;
    heldOutSourceExpected: Series;
    heldOutSourceForbidden: Series;
    heldOutEitherExpected: Series;
    heldOutBridges: Series;
    tuningSourceExpected: Series;
    tuningSourceForbidden: Series;
    sourceAiSeconds: Series;
    sourceCalls: Series;
    sourceReplayed: Series;
  };
  verdicts: {
    x1Expected: GateVerdict;
    x1Forbidden: GateVerdict;
    tuningForbidden: GateVerdict;
    s1Quality: GateVerdict;
    s1Time: GateVerdict;
  };
  /** True/false once every verdict is decided; null otherwise. */
  pass: boolean | null;
}

function seriesOf(
  samples: readonly GateSample[],
  pick: (sample: GateSample) => number | null
): Series {
  const values = samples.map((sample) => ({ label: sample.label, value: pick(sample) }));
  const present = values.flatMap(({ value }) => (value === null ? [] : [value]));
  const complete = present.length === values.length && values.length > 0;
  return {
    values,
    mean: complete ? present.reduce((total, value) => total + value, 0) / present.length : null,
    min: complete ? Math.min(...present) : null,
    max: complete ? Math.max(...present) : null
  };
}

const evaluable = (layer: LayerSummary | undefined): boolean =>
  layer !== undefined &&
  layer.expected.evaluable === layer.expected.total &&
  layer.forbidden.evaluable === layer.forbidden.total;

const combine = (...passes: Array<boolean | null>): boolean | null =>
  passes.includes(false) ? false : passes.includes(null) ? null : true;

export function aggregateGate(
  samples: readonly GateSample[],
  options: GateOptions = defaultGateOptions
): GateReport {
  const held = (pick: (partition: PartitionSummary) => number) => (sample: GateSample) =>
    sample.partitions.holdout ? pick(sample.partitions.holdout) : null;
  const tuning = (pick: (partition: PartitionSummary) => number) => (sample: GateSample) =>
    pick(sample.partitions.tuning);
  const series = {
    heldOutShownExpected: seriesOf(
      samples,
      held((p) => p.shown.expected.found)
    ),
    heldOutShownForbidden: seriesOf(
      samples,
      held((p) => p.shown.forbidden.linked)
    ),
    heldOutAppliedExpected: seriesOf(
      samples,
      held((p) => p.applied.expected.found)
    ),
    heldOutAppliedForbidden: seriesOf(
      samples,
      held((p) => p.applied.forbidden.linked)
    ),
    tuningShownExpected: seriesOf(
      samples,
      tuning((p) => p.shown.expected.found)
    ),
    tuningShownForbidden: seriesOf(
      samples,
      tuning((p) => p.shown.forbidden.linked)
    ),
    heldOutSourceExpected: seriesOf(
      samples,
      held((p) => p.sources.expected.found)
    ),
    heldOutSourceForbidden: seriesOf(
      samples,
      held((p) => p.sources.forbidden.linked)
    ),
    heldOutEitherExpected: seriesOf(
      samples,
      held((p) => p.either.expected.found)
    ),
    heldOutBridges: seriesOf(
      samples,
      held((p) => p.sources.bridges)
    ),
    tuningSourceExpected: seriesOf(
      samples,
      tuning((p) => p.sources.expected.found)
    ),
    tuningSourceForbidden: seriesOf(
      samples,
      tuning((p) => p.sources.forbidden.linked)
    ),
    sourceAiSeconds: seriesOf(samples, (sample) => sample.source.aiSecondsPerRoot),
    sourceCalls: seriesOf(samples, (sample) => sample.source.callsPerRoot),
    sourceReplayed: seriesOf(samples, (sample) => sample.source.replayed)
  };

  const enough = samples.length >= options.minSamples;
  const fewNote = `${samples.length} of ${options.minSamples} samples`;
  const sealed = samples.some((sample) => sample.heldOut === "sealed");
  const sealedNote = "held-out sealed until the freeze (decision D3)";
  const evaluableHeld = samples.every((sample) => evaluable(sample.partitions.holdout?.shown));

  const decided = (
    check: () => boolean,
    context: { needsHeldOut: boolean; needsSamples: boolean; needsEvaluable?: boolean }
  ): GateVerdict => {
    if (context.needsHeldOut && sealed) return { pass: null, note: sealedNote };
    if (context.needsSamples && !enough) return { pass: null, note: fewNote };
    if (context.needsEvaluable && !evaluableHeld)
      return { pass: null, note: "some labelled pairs involve roots that are not in the library" };
    return { pass: check() };
  };

  const x1Expected = decided(
    () =>
      series.heldOutShownExpected.mean! >= options.minMeanExpected &&
      series.heldOutShownExpected.min! >= options.minSampleExpected,
    { needsHeldOut: true, needsSamples: true, needsEvaluable: true }
  );
  const x1Forbidden = decided(() => series.heldOutShownForbidden.max! <= options.maxForbidden, {
    needsHeldOut: true,
    needsSamples: true,
    needsEvaluable: true
  });
  const tuningForbidden = decided(() => series.tuningShownForbidden.max! <= options.maxForbidden, {
    needsHeldOut: false,
    needsSamples: false
  });

  const liveLabels = new Set(options.liveJudge);
  const s1Samples = options.liveJudge.length
    ? samples.filter((sample) => liveLabels.has(sample.label))
    : samples;
  const s1Series = (series: Series) =>
    seriesOf(s1Samples, (sample) => {
      const entry = series.values.find((value) => value.label === sample.label);
      return entry?.value ?? null;
    });
  const s1Quality =
    s1Samples.length === 0
      ? ({ pass: null, note: "no sample to judge the source layer on" } satisfies GateVerdict)
      : decided(
          () =>
            s1Series(series.heldOutSourceExpected).min! >= options.minMeanExpected &&
            s1Series(series.heldOutSourceForbidden).max! <= options.maxForbidden &&
            s1Series(series.heldOutEitherExpected).min! >= options.minMeanExpected &&
            s1Series(series.tuningSourceExpected).min! >= options.minTuningSourceExpected &&
            s1Series(series.tuningSourceForbidden).max! <= options.maxForbidden,
          { needsHeldOut: true, needsSamples: false, needsEvaluable: true }
        );
  const s1Time: GateVerdict =
    options.liveJudge.length === 0
      ? { pass: null, note: "no sample named as a live-judge run (--live-judge)" }
      : s1Samples.length < options.liveJudge.length
        ? { pass: null, note: "a live-judge sample is missing" }
        : (() => {
            const seconds = s1Series(series.sourceAiSeconds);
            const calls = s1Series(series.sourceCalls);
            const replayed = s1Series(series.sourceReplayed);
            if (seconds.max === null || calls.max === null)
              return {
                pass: null,
                note: "source-matching cost is unknown (no monitoring records)"
              };
            return {
              pass:
                seconds.max <= options.maxSourceSeconds &&
                calls.max <= options.maxSourceCalls &&
                (replayed.max ?? 0) === 0
            };
          })();

  const verdicts = { x1Expected, x1Forbidden, tuningForbidden, s1Quality, s1Time };
  return {
    format: "memora-golden-gate-f3",
    version: 1,
    options,
    samples: [...samples],
    series,
    verdicts,
    pass: combine(x1Expected.pass, x1Forbidden.pass, s1Quality.pass, s1Time.pass)
  };
}

// --- Markdown ------------------------------------------------------------------------------------

const verdictText = (verdict: GateVerdict): string =>
  verdict.pass === null ? "not decided" : verdict.pass ? "pass" : "FAIL";
const fixed = (value: number | null, digits = 1): string =>
  value === null ? "unknown" : value.toFixed(digits);
const valuesText = (series: Series): string =>
  series.values.map(({ label, value }) => `${label} ${value ?? "sealed"}`).join(", ") || "none";
const meanMin = (series: Series): string =>
  series.mean === null ? "n/a" : `mean ${fixed(series.mean)}, min ${series.min}`;

export function renderGateMarkdown(report: GateReport, context: { title?: string } = {}): string {
  const { series, verdicts, options } = report;
  const lines = [`# F3 matching gate${context.title ? `: ${context.title}` : ""}`, ""];
  lines.push(
    `${report.samples.length} samples (${options.minSamples} expected by decision D2): ${report.samples.map((sample) => sample.label).join(", ") || "none"}. Shown relations are applied, suggested or kept (decision D23).`,
    ""
  );
  lines.push(
    "## X1 and S1",
    "",
    "| Measure | Per sample | Aggregate | Bar | Verdict |",
    "| --- | --- | --- | --- | --- |",
    `| X1 held-out expected linked (shown) | ${valuesText(series.heldOutShownExpected)} | ${meanMin(series.heldOutShownExpected)} | mean at least ${options.minMeanExpected}, no sample below ${options.minSampleExpected} (of 28) | ${verdictText(verdicts.x1Expected)} |`,
    `| X1 held-out forbidden linked (shown) | ${valuesText(series.heldOutShownForbidden)} | max ${series.heldOutShownForbidden.max ?? "n/a"} | at most ${options.maxForbidden} in every sample (of 35) | ${verdictText(verdicts.x1Forbidden)} |`,
    `| Held-out expected linked (applied only) | ${valuesText(series.heldOutAppliedExpected)} | ${meanMin(series.heldOutAppliedExpected)} | reported | |`,
    `| Held-out forbidden linked (applied only) | ${valuesText(series.heldOutAppliedForbidden)} | max ${series.heldOutAppliedForbidden.max ?? "n/a"} | reported | |`,
    `| Tuning expected linked (shown) | ${valuesText(series.tuningShownExpected)} | ${meanMin(series.tuningShownExpected)} | reported (of 26) | |`,
    `| Tuning forbidden linked (shown) | ${valuesText(series.tuningShownForbidden)} | max ${series.tuningShownForbidden.max ?? "n/a"} | 0 expected (of 25) | ${verdictText(verdicts.tuningForbidden)} |`,
    `| S1 source layer held-out expected | ${valuesText(series.heldOutSourceExpected)} | ${meanMin(series.heldOutSourceExpected)} | at least ${options.minMeanExpected} (of 28) | ${verdictText(verdicts.s1Quality)} |`,
    `| S1 source layer held-out forbidden | ${valuesText(series.heldOutSourceForbidden)} | max ${series.heldOutSourceForbidden.max ?? "n/a"} | 0 (of 35) | |`,
    `| S1 either layer held-out expected | ${valuesText(series.heldOutEitherExpected)} | ${meanMin(series.heldOutEitherExpected)} | at least ${options.minMeanExpected} | |`,
    `| S1 source layer tuning expected | ${valuesText(series.tuningSourceExpected)} | ${meanMin(series.tuningSourceExpected)} | at least ${options.minTuningSourceExpected} (of 26) | |`,
    `| S1 source layer tuning forbidden | ${valuesText(series.tuningSourceForbidden)} | max ${series.tuningSourceForbidden.max ?? "n/a"} | 0 (of 25) | |`,
    `| S1 held-out bridges | ${valuesText(series.heldOutBridges)} | max ${series.heldOutBridges.max ?? "n/a"} | soft ceiling ${options.bridgeCeiling} | ${series.heldOutBridges.max === null ? "not decided" : series.heldOutBridges.max <= options.bridgeCeiling ? "within" : "over the ceiling"} |`,
    `| S1 AI-call seconds per source | ${report.samples.map((sample) => `${sample.label} ${fixed(sample.source.aiSecondsPerRoot, 2)}`).join(", ")} | max ${fixed(series.sourceAiSeconds.max, 2)} | at most ${options.maxSourceSeconds} (live-judge samples) | ${verdictText(verdicts.s1Time)} |`,
    `| S1 calls per source | ${report.samples.map((sample) => `${sample.label} ${fixed(sample.source.callsPerRoot, 2)}`).join(", ")} | max ${fixed(series.sourceCalls.max, 2)} | at most ${options.maxSourceCalls} | |`,
    `| S1 replayed source calls | ${report.samples.map((sample) => `${sample.label} ${sample.source.replayed}`).join(", ")} | max ${series.sourceReplayed.max ?? "n/a"} | 0 in live-judge samples | |`,
    `| All | | | | ${report.pass === null ? "not decided" : report.pass ? "pass" : "FAIL"} |`,
    ""
  );
  for (const verdict of Object.values(verdicts)) if (verdict.note) lines.push(`- ${verdict.note}`);
  if (lines.at(-1) !== "") lines.push("");

  lines.push(
    "## Source matching per sample",
    "",
    "| Sample | Sources | Calls | Replayed | Calls per source | AI seconds per source | Wall seconds per source | Promoted | Judged | Origin unknown |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...report.samples.map(
      (sample) =>
        `| ${sample.label} | ${sample.source.roots} | ${sample.source.calls} | ${sample.source.replayed} | ${fixed(sample.source.callsPerRoot, 2)} | ${fixed(sample.source.aiSecondsPerRoot, 2)} | ${fixed(sample.source.wallSecondsPerRoot, 2)} | ${sample.source.relations.promoted} | ${sample.source.relations.judged} | ${sample.source.relations.unknown} |`
    ),
    ""
  );

  lines.push(
    "## Note matching and calls per chapter",
    "",
    "| Sample | Notes | Note-matching calls | Replayed | Seconds per note | Generative calls per 30-chunk chapter |",
    "| --- | ---: | ---: | ---: | ---: | ---: |",
    ...report.samples.map(
      (sample) =>
        `| ${sample.label} | ${sample.notes.count} | ${sample.notes.calls} | ${sample.notes.replayed} | ${fixed(sample.notes.secondsPerNote, 2)} | ${fixed(sample.callsPerChapter?.generative.perChapter ?? null, 1)} |`
    ),
    ""
  );

  const warned = report.samples.filter((sample) => sample.warnings.length);
  if (warned.length)
    lines.push(
      "## Warnings",
      "",
      ...warned.flatMap((sample) =>
        sample.warnings.map((warning) => `- ${sample.label}: ${warning}`)
      ),
      ""
    );
  return `${lines
    .join("\n")
    .replace(/\n{3,}/gu, "\n\n")
    .trimEnd()}\n`;
}

/** `--check`: 0 when every verdict passes, 1 when one fails, 2 when none failed but one is undecided. */
export const gateExitCode = (pass: boolean | null): 0 | 1 | 2 =>
  pass === true ? 0 : pass === false ? 1 : 2;
