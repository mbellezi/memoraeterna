/**
 * Loss of today's reverse-only acceptances (F3 exit X2, decisions D2 and Q1). A set holds note pairs
 * the old pipeline accepted; a pair is kept when the new pipeline shows it and lost otherwise. The
 * literal loss counts every pair of the set; the adjudicated loss counts only the pairs a label rates
 * related (lost related over related). Same-root pairs are split out.
 *
 *   R_v6  Spike A's 37 tuning acceptances in one direction while the reverse was judged and rejected:
 *         npx tsx scripts/golden/reverse-only.ts --spike-dataset <dataset.json> --spike-scores <scores.json> --rule max:3.3125
 *   R_v9  the note pairs v9 accepted on the pinned fixture notes (a relations export), kept by a rule
 *         over ranker scores or by another export's shown relations:
 *         npx tsx scripts/golden/reverse-only.ts --set <v9-export.json> (--kept <export.json> | --scores <pair-scores.json> --rule max:3.3125)
 *
 * When some kept pairs are unlabelled (decision R10: the kept share of R_v9 comes from a 50-pair
 * sample), the adjudicated loss is estimated with the Wilson interval of that share.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

import {
  aggregatePairScores,
  notePairKey,
  parseRankerRule,
  readPairScores,
  readRelationsExport,
  spikeAFrozenRule,
  type Aggregation,
  type PairScores,
  type RelationsExport
} from "./relations-export.ts";

/** Decision D2/X2: at most 5% loss. */
export const lossBar = 0.05;

export interface ReversePair {
  a: string;
  b: string;
  sameRoot: boolean;
}

export interface LossGroup {
  total: number;
  kept: number;
  lost: number;
  /** lost over total; null for an empty group. */
  loss: number | null;
}

export interface AdjudicatedGroup {
  related: number;
  lostRelated: number;
  loss: number | null;
}

export interface LossEstimate {
  /** Share of the labelled kept pairs that are related, with its Wilson 95% interval. */
  keptRelatedShare: number;
  keptRelatedShareInterval: [number, number];
  /** lost related over lost related plus the estimated related kept pairs, with the interval that follows. */
  loss: number;
  lossInterval: [number, number];
  /** The bar lies inside the interval: label the remaining kept pairs and take the exact figure. */
  barInsideInterval: boolean;
}

export interface Adjudicated extends AdjudicatedGroup {
  keptRelated: number;
  notRelated: number;
  unlabelledKept: number;
  /** Lost pairs with no label: their relatedness is unknown, so the figure is not exact. */
  unlabelledLost: number;
  sameRoot: AdjudicatedGroup;
  crossRoot: AdjudicatedGroup;
  /** Present when some kept pairs are unlabelled. */
  estimate: LossEstimate | null;
}

export interface LossReport {
  set: string;
  literal: LossGroup & { sameRoot: LossGroup; crossRoot: LossGroup };
  adjudicated: Adjudicated | null;
}

/** Wilson score interval for a proportion. */
export function wilsonInterval(successes: number, trials: number, z = 1.96): [number, number] {
  if (trials <= 0) return [0, 1];
  const p = successes / trials;
  const denominator = 1 + (z * z) / trials;
  const center = (p + (z * z) / (2 * trials)) / denominator;
  const margin =
    (z * Math.sqrt((p * (1 - p)) / trials + (z * z) / (4 * trials * trials))) / denominator;
  return [Math.max(0, center - margin), Math.min(1, center + margin)];
}

const share = (part: number, whole: number): number | null => (whole > 0 ? part / whole : null);

function group(pairs: readonly ReversePair[], kept: (pair: ReversePair) => boolean): LossGroup {
  const keptCount = pairs.filter(kept).length;
  return {
    total: pairs.length,
    kept: keptCount,
    lost: pairs.length - keptCount,
    loss: share(pairs.length - keptCount, pairs.length)
  };
}

const pairId = (pair: ReversePair): string => notePairKey(pair.a, pair.b);

/**
 * The loss of a set of pairs. `kept` says whether the new pipeline shows a pair; `related` maps
 * unordered note-pair keys to the panel's majority verdict (a pair without an entry is unlabelled).
 */
export function lossReport(
  name: string,
  pairs: readonly ReversePair[],
  kept: (pair: ReversePair) => boolean,
  related?: ReadonlyMap<string, boolean>,
  bar: number = lossBar
): LossReport {
  const literal = {
    ...group(pairs, kept),
    sameRoot: group(
      pairs.filter((pair) => pair.sameRoot),
      kept
    ),
    crossRoot: group(
      pairs.filter((pair) => !pair.sameRoot),
      kept
    )
  };
  if (!related) return { set: name, literal, adjudicated: null };

  const label = (pair: ReversePair) => related.get(pairId(pair));
  const adjudicate = (own: readonly ReversePair[]): AdjudicatedGroup => {
    const relatedPairs = own.filter((pair) => label(pair) === true);
    const lostRelated = relatedPairs.filter((pair) => !kept(pair)).length;
    return {
      related: relatedPairs.length,
      lostRelated,
      loss: share(lostRelated, relatedPairs.length)
    };
  };
  const all = adjudicate(pairs);
  const keptPairs = pairs.filter(kept);
  const lostPairs = pairs.filter((pair) => !kept(pair));
  const unlabelledKept = keptPairs.filter((pair) => label(pair) === undefined).length;
  const keptLabelled = keptPairs.filter((pair) => label(pair) !== undefined);
  const keptRelated = keptLabelled.filter((pair) => label(pair) === true).length;

  let estimate: LossEstimate | null = null;
  if (unlabelledKept > 0 && keptLabelled.length > 0) {
    const keptShare = keptRelated / keptLabelled.length;
    const [low, high] = wilsonInterval(keptRelated, keptLabelled.length);
    const lost = all.lostRelated;
    const lossAt = (p: number) =>
      lost + keptPairs.length * p > 0 ? lost / (lost + keptPairs.length * p) : 0;
    const interval: [number, number] = [lossAt(high), lossAt(low)];
    estimate = {
      keptRelatedShare: keptShare,
      keptRelatedShareInterval: [low, high],
      loss: lossAt(keptShare),
      lossInterval: interval,
      barInsideInterval: interval[0] <= bar && bar <= interval[1]
    };
  }
  return {
    set: name,
    literal,
    adjudicated: {
      ...all,
      keptRelated,
      notRelated: pairs.filter((pair) => label(pair) === false).length,
      unlabelledKept,
      unlabelledLost: lostPairs.filter((pair) => label(pair) === undefined).length,
      sameRoot: adjudicate(pairs.filter((pair) => pair.sameRoot)),
      crossRoot: adjudicate(pairs.filter((pair) => !pair.sameRoot)),
      estimate
    }
  };
}

// --- Inputs --------------------------------------------------------------------------------------

const spikeDatasetSchema = z
  .object({
    notes: z.array(z.object({ id: z.string(), root: z.string() }).passthrough()),
    rows: z.array(
      z
        .object({
          phase: z.string(),
          query: z.string(),
          doc: z.string(),
          accepted: z.boolean()
        })
        .passthrough()
    ),
    sets: z.object({ all: z.array(z.tuple([z.string(), z.string()])) }).passthrough()
  })
  .passthrough();
export type SpikeDataset = z.infer<typeof spikeDatasetSchema>;

const spikeScoresSchema = z
  .object({ set: z.literal("all"), logOdds: z.array(z.number()) })
  .passthrough();

export async function readSpikeDataset(path: string): Promise<SpikeDataset> {
  return spikeDatasetSchema.parse(JSON.parse(await readFile(path, "utf8")));
}

/** Spike A's score file (set `all`) as directional pair scores, aligned with `dataset.sets.all`. */
export async function readSpikeScores(path: string, dataset: SpikeDataset): Promise<PairScores> {
  const file = spikeScoresSchema.parse(JSON.parse(await readFile(path, "utf8")));
  if (file.logOdds.length !== dataset.sets.all.length)
    throw new Error("The score file does not match the dataset (set `all` lengths differ).");
  return {
    format: "memora-relations-pair-scores",
    version: 1,
    decider: "spike A scores",
    scale: "log-odds",
    scores: dataset.sets.all.map(([query, doc], index) => ({
      query,
      doc,
      logOdds: file.logOdds[index]!
    }))
  };
}

/**
 * R_v6: the old pipeline's tuning acceptances (the `economy` phase) whose reverse direction was
 * judged and rejected, with the same-root flag from the dataset's notes.
 */
export function spikeReverseOnly(dataset: SpikeDataset, phase = "economy"): ReversePair[] {
  const rows = dataset.rows.filter((row) => row.phase === phase);
  const byDirection = new Map(rows.map((row) => [`${row.query}|${row.doc}`, row]));
  const root = new Map(dataset.notes.map((note) => [note.id, note.root]));
  return rows
    .filter((row) => {
      if (!row.accepted) return false;
      const reverse = byDirection.get(`${row.doc}|${row.query}`);
      return reverse !== undefined && !reverse.accepted;
    })
    .map((row) => ({
      a: row.query,
      b: row.doc,
      sameRoot: root.get(row.query) === root.get(row.doc)
    }));
}

/** The pipeline keeps a pair when the aggregate of its two directions reaches the threshold. */
export function keptByRankerRule(
  scores: PairScores,
  rule: { aggregation: Aggregation; threshold: number }
): (pair: ReversePair) => boolean {
  const aggregated = aggregatePairScores(scores, rule.aggregation);
  return (pair) => (aggregated.get(pairId(pair)) ?? Number.NEGATIVE_INFINITY) >= rule.threshold;
}

/** The set of an export's relations (R_v9), with the same-root flag from its source hierarchy. */
export function exportPairs(data: RelationsExport): ReversePair[] {
  const parent = new Map(data.sources.map((source) => [source.id, source.parentId]));
  const sourceOf = new Map(data.notes.map((note) => [note.id, note.sourceItemId]));
  const top = (noteId: string): string | null => {
    let current = sourceOf.get(noteId);
    if (!current) return null;
    for (let depth = 0; depth < 20; depth += 1) {
      const up = parent.get(current);
      if (!up || !parent.has(up)) return current;
      current = up;
    }
    return current;
  };
  const seen = new Set<string>();
  const pairs: ReversePair[] = [];
  for (const relation of data.relations) {
    const key = notePairKey(relation.sourceNoteId, relation.targetNoteId);
    if (seen.has(key)) continue;
    seen.add(key);
    pairs.push({
      a: relation.sourceNoteId,
      b: relation.targetNoteId,
      sameRoot: top(relation.sourceNoteId) === top(relation.targetNoteId)
    });
  }
  return pairs;
}

/** The pairs an export shows: its relations the visibility verdict (or status) counts. */
export function keptByExport(data: RelationsExport): (pair: ReversePair) => boolean {
  const shown = new Set(
    data.relations
      .filter(
        (relation) => relation.shown ?? ["accepted", "pending_review"].includes(relation.status)
      )
      .map((relation) => notePairKey(relation.sourceNoteId, relation.targetNoteId))
  );
  return (pair) => shown.has(pairId(pair));
}

const labelsSchema = z.object({
  format: z.literal("memora-relations-labels"),
  version: z.literal(1),
  labels: z.array(z.object({ a: z.string(), b: z.string(), related: z.boolean() }))
});

/** The panel's majority verdict by unordered note pair. */
export async function readLabels(path: string): Promise<Map<string, boolean>> {
  const file = labelsSchema.parse(JSON.parse(await readFile(path, "utf8")));
  return new Map(file.labels.map((entry) => [notePairKey(entry.a, entry.b), entry.related]));
}

// --- Markdown ------------------------------------------------------------------------------------

const percent = (value: number | null): string =>
  value === null ? "n/a" : `${(value * 100).toFixed(1)}%`;

export function renderLossMarkdown(
  report: LossReport,
  context: { label?: string | null; rule?: string | null } = {}
): string {
  const { literal, adjudicated } = report;
  const lines = [
    `# Loss of reverse-only acceptances: ${report.set}${context.label ? ` (${context.label})` : ""}`,
    "",
    context.rule ? `Kept when ${context.rule}.` : "",
    "",
    "| | Pairs | Kept | Lost | Loss |",
    "| --- | ---: | ---: | ---: | ---: |",
    `| Literal, all pairs | ${literal.total} | ${literal.kept} | ${literal.lost} | ${percent(literal.loss)} |`,
    `| Same root | ${literal.sameRoot.total} | ${literal.sameRoot.kept} | ${literal.sameRoot.lost} | ${percent(literal.sameRoot.loss)} |`,
    `| Across roots | ${literal.crossRoot.total} | ${literal.crossRoot.kept} | ${literal.crossRoot.lost} | ${percent(literal.crossRoot.loss)} |`,
    ""
  ];
  if (adjudicated) {
    lines.push(
      "| Adjudicated (panel-related pairs) | Related | Lost related | Loss |",
      "| --- | ---: | ---: | ---: |",
      `| All | ${adjudicated.related} | ${adjudicated.lostRelated} | ${percent(adjudicated.loss)} |`,
      `| Same root | ${adjudicated.sameRoot.related} | ${adjudicated.sameRoot.lostRelated} | ${percent(adjudicated.sameRoot.loss)} |`,
      `| Across roots | ${adjudicated.crossRoot.related} | ${adjudicated.crossRoot.lostRelated} | ${percent(adjudicated.crossRoot.loss)} |`,
      ""
    );
    if (adjudicated.unlabelledLost)
      lines.push(
        `- ${adjudicated.unlabelledLost} lost pairs have no label: the adjudicated figure is not exact until they are labelled.`
      );
    if (adjudicated.estimate) {
      const estimate = adjudicated.estimate;
      lines.push(
        `- ${adjudicated.unlabelledKept} kept pairs are unlabelled: the kept pairs' related share is ${percent(estimate.keptRelatedShare)} (95% Wilson ${percent(estimate.keptRelatedShareInterval[0])} to ${percent(estimate.keptRelatedShareInterval[1])}), so the estimated loss is ${percent(estimate.loss)} (${percent(estimate.lossInterval[0])} to ${percent(estimate.lossInterval[1])}).`
      );
      if (estimate.barInsideInterval)
        lines.push(
          `- The ${percent(lossBar)} bar lies inside that interval: label the remaining kept pairs and take the exact figure.`
        );
    }
    lines.push("");
  }
  return `${lines
    .filter((line, index, all) => line !== "" || all[index - 1] !== "")
    .join("\n")
    .trimEnd()}\n`;
}

// --- Command line --------------------------------------------------------------------------------

export const reverseOnlyUsage = `Usage: npx tsx scripts/golden/reverse-only.ts (--spike-dataset <dataset.json> --spike-scores <scores.json> | --set <export.json>) [options]

Loss of the old pipeline's reverse-only acceptances: pairs of the set the new pipeline does not show.

  --spike-dataset <file>  Spike A dataset.json: the set is R_v6, its tuning acceptances in one direction only.
  --spike-scores <file>   Spike A score file of set \`all\` (the ranker's log-odds).
  --set <file>            A relations export: the set is its relations (R_v9 from a v9 end state).
  --kept <file>           A relations export whose shown relations are the kept pairs.
  --scores <file>         Pair scores (memora-relations-pair-scores); with --rule they decide the kept pairs.
  --rule <rule>           Ranker rule max:<log-odds> or mean:<log-odds> (default max:${spikeAFrozenRule.threshold}, Spike A's MLX rule).
  --labels <file>         Panel verdicts (memora-relations-labels): adds the adjudicated loss.
  --name <text>           Name of the set in the report (default R_v6 or R_v9).
  --label <text>          Name for the report header.
  --out <file.md>         Write the Markdown report here (default: print it).
  --json <file>           Also write the result as JSON.
  --help                  Show this text.`;

export async function runReverseOnly(argv: readonly string[]): Promise<string | null> {
  const { values } = parseArgs({
    args: [...argv],
    options: {
      "spike-dataset": { type: "string" },
      "spike-scores": { type: "string" },
      set: { type: "string" },
      kept: { type: "string" },
      scores: { type: "string" },
      rule: { type: "string" },
      labels: { type: "string" },
      name: { type: "string" },
      label: { type: "string" },
      out: { type: "string" },
      json: { type: "string" },
      help: { type: "boolean", short: "h" }
    },
    strict: true,
    allowPositionals: false
  });
  if (values.help) return reverseOnlyUsage;
  const rule = values.rule
    ? parseRankerRule(values.rule)
    : {
        aggregation: spikeAFrozenRule.aggregation as Aggregation,
        threshold: spikeAFrozenRule.threshold as number
      };
  const related = values.labels ? await readLabels(values.labels) : undefined;

  let name: string;
  let pairs: ReversePair[];
  let kept: (pair: ReversePair) => boolean;
  let description: string;
  if (values["spike-dataset"]) {
    if (!values["spike-scores"])
      throw new Error("--spike-scores is required with --spike-dataset.");
    const dataset = await readSpikeDataset(values["spike-dataset"]);
    const scores = await readSpikeScores(values["spike-scores"], dataset);
    name = values.name ?? "R_v6";
    pairs = spikeReverseOnly(dataset);
    kept = keptByRankerRule(scores, rule);
    description = `the ${rule.aggregation} of both directions reaches ${rule.threshold} log-odds`;
  } else if (values.set) {
    name = values.name ?? "R_v9";
    pairs = exportPairs(await readRelationsExport(values.set));
    if (values.kept) {
      kept = keptByExport(await readRelationsExport(values.kept));
      description = "the other export shows the pair";
    } else if (values.scores) {
      kept = keptByRankerRule(await readPairScores(values.scores), rule);
      description = `the ${rule.aggregation} of both directions reaches ${rule.threshold} log-odds`;
    } else throw new Error("Give --kept or --scores to say which pairs the new pipeline keeps.");
  } else throw new Error("Give --spike-dataset (R_v6) or --set (an export of the set).");

  const report = lossReport(name, pairs, kept, related);
  const markdown = renderLossMarkdown(report, { label: values.label ?? null, rule: description });
  const write = async (path: string, content: string) => {
    const target = resolve(path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  };
  if (values.json) await write(values.json, `${JSON.stringify(report, null, 2)}\n`);
  if (values.out) {
    await write(values.out, markdown);
    return null;
  }
  return markdown;
}

if (import.meta.main) {
  try {
    const output = await runReverseOnly(process.argv.slice(2));
    if (output !== null) console.info(output);
  } catch (error) {
    console.error(`[reverse-only] ${error instanceof Error ? error.message : String(error)}`);
    console.error("Run with --help for usage.");
    process.exitCode = 1;
  }
}
