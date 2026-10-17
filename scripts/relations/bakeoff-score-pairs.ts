/**
 * Bake-off scores of the local deciders (F3 T46 part b, spec 3.18): the Qwen3-Reranker on MLX and on
 * GGUF, scored through the product adapters (`product-ranker.ts`, the calls `AiService.rankPairs`
 * makes, so a calibration is fitted on product scores, R1), and bge-reranker-v2-m3 through the Spike A
 * scorer (control only, not in the catalog). Every instruction candidate and both note-text templates
 * (400 and 600 body characters) are scored for both directions of every pair of the bake-off sets
 * (`bakeoff-sets.ts`); `max` and `mean` are read from the two directions by the analysis.
 *
 *   npx tsx scripts/relations/bakeoff-score-pairs.ts score --runtime mlx|gguf|bge [--instructions a,b]
 *       [--bodies 400,600] [--out-dir <dir>] [--lock <file>] [--owner T46b]
 *   npx tsx scripts/relations/bakeoff-score-pairs.ts index      (rewrite index.json from the score files)
 *   npx tsx scripts/relations/bakeoff-score-pairs.ts summary    (AUC and coverage tables; descriptive only)
 *
 * Outputs under `<out-dir>` (default `.cache/f3/scores/bakeoff/`): `labels-<runtime>-<instruction>-t<body>.json`
 * in the `memora-relations-pair-scores` format with the hashes of every input, `index.json`, and
 * `summary.json` / `summary.md`. Local inference holds the machine-wide lock file
 * (`.cache/f2/LOCAL_MODEL_BUSY`, decision D45) and waits for any other local-model process; the lock is
 * removed when the run ends, also on failure. No provider is used.
 */
import { loadavg } from "node:os";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { z } from "zod";

import { readPairScores, aggregatePairScores } from "../golden/relations-export.ts";
import { repositoryRoot } from "../spikes/reranker/dataset.ts";
import { instructionCandidates } from "../spikes/reranker/instructions.ts";
import { auc, mean } from "../spikes/reranker/metrics.ts";
import type { ArtifactInfo, PairText } from "../spikes/reranker/runtimes.ts";
import { otherLocalModelJobs } from "../spikes/topic-tree/local-model-slot.ts";
import {
  bakeoffDirectory,
  decisionsScoresFile,
  defaultSourcePaths,
  inputFiles,
  labelFixtureSchema,
  pairKeyOf,
  type LabelItem
} from "./bakeoff-sets.ts";
import { waitForModelsOutsideTheLock, withLocalModelLock } from "./local-model-lock.ts";
import {
  noteTextDigest,
  readNoteTexts,
  sha256Hex,
  templateBodyCharacters,
  type ReadNoteTexts,
  type TextLookup
} from "./note-texts.ts";
import {
  directedPairsOf,
  noteIdsOf,
  pairScoresFormat,
  pairTexts,
  readPairsFile,
  scoreDirectedPairs,
  type DirectedPair,
  type ReadPairs
} from "./pair-scoring.ts";
import { openProductRanker, type ProductRuntime, type ProductScores } from "./product-ranker.ts";
import { defaultPaths, frozenThreshold, recordedPath } from "./score-pairs.ts";

export const bakeoffTask = "T46b";

/** The template's id in the calibration identity: the product's `relation-pair-text-v1`, at a body length. */
export const pairTextTemplateId = "relation-pair-text-v1";

export type BakeoffRuntime = ProductRuntime | "bge";

/** The instruction candidates of Spike A, the frozen one first. */
export const instructionOrder = ["mechanism", "relation", "study", "default"] as const;

export interface ConfigSpec {
  runtime: BakeoffRuntime;
  /** `none` for bge, a cross-encoder with no instruction. */
  instructionId: string;
  bodyCharacters: number;
}

/** Every configuration of a runtime, grouped by instruction so a GGUF context is built once. */
export function planConfigs(
  runtime: BakeoffRuntime,
  instructionIds: readonly string[] = instructionOrder,
  bodies: readonly number[] = templateBodyCharacters
): ConfigSpec[] {
  const ids = runtime === "bge" ? ["none"] : instructionIds;
  return ids.flatMap((instructionId) =>
    bodies.map((bodyCharacters) => ({ runtime, instructionId, bodyCharacters }))
  );
}

export const scoreFileName = (spec: ConfigSpec): string =>
  `labels-${spec.runtime}-${spec.instructionId}-t${spec.bodyCharacters}.json`;

export function instructionText(spec: ConfigSpec): string | null {
  if (spec.runtime === "bge") return null;
  const text = instructionCandidates[spec.instructionId];
  if (!text) throw new Error(`Unknown instruction "${spec.instructionId}".`);
  return text;
}

// --- The ranker behind a run ---------------------------------------------------------------------------

export interface BakeoffRanker {
  /** `product-adapter`: `AiService.rankPairs`'s adapters; `spike-scorer`: Spike A's (the bge control). */
  readonly path: "product-adapter" | "spike-scorer";
  readonly artifact: ArtifactInfo;
  readonly perCall: number | null;
  readonly helperBatchSize: number | null;
  runtimeBuild(): Promise<string>;
  rank(
    instruction: string | null,
    pairs: readonly PairText[],
    onProgress?: (done: number) => void
  ): Promise<ProductScores>;
  dispose(): Promise<void>;
}

async function openBgeControl(): Promise<BakeoffRanker> {
  const { openRuntime } = await import("../spikes/reranker/runtimes.ts");
  const runtime = await openRuntime("gguf-bge", undefined);
  const manifest = JSON.parse(
    await readFile(join(repositoryRoot, "node_modules", "node-llama-cpp", "package.json"), "utf8")
  ) as { version: string };
  return {
    path: "spike-scorer",
    artifact: runtime.artifact,
    perCall: null,
    helperBatchSize: null,
    runtimeBuild: async () => `node-llama-cpp@${manifest.version} (Spike A scorer)`,
    async rank(_instruction, pairs, onProgress) {
      const scored = await scoreDirectedPairs(runtime, [...pairs], {
        batchSize: 1,
        requestSize: 2_048,
        ...(onProgress ? { onProgress: (done: number) => onProgress(done) } : {})
      });
      return {
        logOdds: scored.logOdds,
        tokenCounts: scored.tokenCounts,
        truncated: 0,
        calls: scored.requests,
        wallMs: scored.wallMs,
        callMs: [scored.wallMs]
      };
    },
    dispose: () => runtime.dispose()
  };
}

export interface BakeoffDependencies {
  openRanker(runtime: BakeoffRuntime): Promise<BakeoffRanker>;
  /** Holds the local-model lock (and waits for the slot) while `work` runs. */
  withLock<T>(work: () => Promise<T>): Promise<T>;
  now(): Date;
  loadAverage(): number[];
  log(message: string): void;
}

export function defaultDependencies(lock: string, owner: string): BakeoffDependencies {
  return {
    async openRanker(runtime) {
      if (runtime === "bge") return openBgeControl();
      const ranker = await openProductRanker(runtime);
      return {
        path: "product-adapter",
        artifact: ranker.artifact,
        perCall: ranker.perCall,
        helperBatchSize: ranker.helperBatchSize,
        runtimeBuild: () => ranker.runtimeBuild(),
        rank: (instruction, pairs, onProgress) => ranker.rank(instruction ?? "", pairs, onProgress),
        dispose: () => ranker.dispose()
      };
    },
    withLock: (work) =>
      withLocalModelLock(
        {
          path: lock,
          owner,
          onWait: (path) => console.info(`Waiting for ${path} to disappear`)
        },
        async () => {
          await waitForModelsOutsideTheLock(otherLocalModelJobs, {
            onWait: (jobs) =>
              console.info(`Waiting for other local-model processes:\n  ${jobs.join("\n  ")}`)
          });
          return work();
        }
      ),
    now: () => new Date(),
    loadAverage: () => loadavg(),
    log: (message) => console.info(message)
  };
}

// --- The score file ------------------------------------------------------------------------------------

export interface BakeoffScoreInput {
  spec: ConfigSpec;
  instruction: string | null;
  pairs: ReadPairs;
  pairsPath: string;
  textsPath: string;
  texts: ReadNoteTexts;
  ranker: Pick<BakeoffRanker, "path" | "artifact" | "perCall" | "helperBatchSize">;
  runtimeBuild: string;
  directed: readonly DirectedPair[];
  scored: ProductScores;
  startedAt: string;
  finishedAt: string;
  hostLoadAverage: { before: number[]; after: number[] };
}

export interface BakeoffScoresFile {
  format: typeof pairScoresFormat;
  version: 1;
  decider: string;
  scale: "log-odds";
  scores: Array<{ query: string; doc: string; logOdds: number }>;
  run: {
    task: typeof bakeoffTask;
    set: "labels";
    path: BakeoffRanker["path"];
    runtime: BakeoffRuntime;
    instructionId: string;
    instruction: string | null;
    instructionSha256: string | null;
    template: { id: string; bodyCharacters: number };
    inputs: {
      pairsFile: string;
      pairsSha256: string;
      textsFile: string;
      textsSha256: string;
      /** SHA-256 over the rendered text each note had in this configuration (D13's rendered-input hashes). */
      noteTextDigest: string;
      notes: number;
      unorderedPairs: number;
      directedPairs: number;
    };
    model: ArtifactInfo;
    runtimeBuild: string;
    callPlan: { pairsPerCall: number | null; helperBatchSize: number | null; calls: number };
    timing: {
      startedAt: string;
      finishedAt: string;
      wallMs: number;
      msPerDirectedPair: number;
      callMsP50: number;
      callMsP95: number;
      hostLoadAverage: { before: number[]; after: number[] };
    };
    tokens: { mean: number; max: number } | null;
    truncatedPairs: number;
    scoresSha256: string;
  };
}

function quantile(values: readonly number[], fraction: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(fraction * sorted.length))]!;
}

export function deciderLabel(input: BakeoffScoreInput): string {
  const { spec, ranker } = input;
  return [
    `${spec.runtime}[${ranker.path}]:${ranker.artifact.name}@${ranker.artifact.revision.slice(0, 7)}`,
    `instruction=${spec.instructionId}`,
    `template=${pairTextTemplateId}:${spec.bodyCharacters}`,
    ...(ranker.perCall === null ? [] : [`pairs-per-call=${ranker.perCall}`]),
    ...(ranker.helperBatchSize === null ? [] : [`helper-batch=${ranker.helperBatchSize}`])
  ].join(" ");
}

export function buildBakeoffScoreFile(input: BakeoffScoreInput): BakeoffScoresFile {
  const { directed, scored, spec } = input;
  if (scored.logOdds.length !== directed.length)
    throw new Error("The number of scores differs from the number of directed pairs.");
  const scores = directed.map(({ query, doc }, index) => ({
    query,
    doc,
    logOdds: scored.logOdds[index]!
  }));
  const lookup: TextLookup = (id) => input.texts.rendered.get(id);
  const noteIds = noteIdsOf(input.pairs.file.pairs);
  return {
    format: pairScoresFormat,
    version: 1,
    decider: deciderLabel(input),
    scale: "log-odds",
    scores,
    run: {
      task: bakeoffTask,
      set: "labels",
      path: input.ranker.path,
      runtime: spec.runtime,
      instructionId: spec.instructionId,
      instruction: input.instruction,
      instructionSha256: input.instruction === null ? null : sha256Hex(input.instruction),
      template: { id: pairTextTemplateId, bodyCharacters: spec.bodyCharacters },
      inputs: {
        pairsFile: recordedPath(input.pairsPath),
        pairsSha256: input.pairs.sha256,
        textsFile: recordedPath(input.textsPath),
        textsSha256: input.texts.sha256,
        noteTextDigest: noteTextDigest(lookup, noteIds),
        notes: noteIds.length,
        unorderedPairs: input.pairs.file.pairs.length,
        directedPairs: directed.length
      },
      model: input.ranker.artifact,
      runtimeBuild: input.runtimeBuild,
      callPlan: {
        pairsPerCall: input.ranker.perCall,
        helperBatchSize: input.ranker.helperBatchSize,
        calls: scored.calls
      },
      timing: {
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        wallMs: scored.wallMs,
        msPerDirectedPair: scored.wallMs / Math.max(1, directed.length),
        callMsP50: quantile(scored.callMs, 0.5),
        callMsP95: quantile(scored.callMs, 0.95),
        hostLoadAverage: input.hostLoadAverage
      },
      tokens:
        scored.tokenCounts.length > 0
          ? { mean: mean(scored.tokenCounts), max: Math.max(...scored.tokenCounts) }
          : null,
      truncatedPairs: scored.truncated,
      scoresSha256: sha256Hex(JSON.stringify(scores))
    }
  };
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`);
}

// --- score -----------------------------------------------------------------------------------------------

export interface ScoreCommand {
  runtime: BakeoffRuntime;
  instructionIds: readonly string[];
  bodies: readonly number[];
  pairsPath: string;
  textsPath: string;
  outDir: string;
}

export async function runBakeoffScore(
  command: ScoreCommand,
  deps: BakeoffDependencies
): Promise<string[]> {
  // Everything that can be wrong with the inputs fails before the lock is taken.
  const pairs = await readPairsFile(command.pairsPath);
  const directed = directedPairsOf(pairs.file.pairs);
  const byBody = new Map<number, { texts: ReadNoteTexts; prompts: PairText[] }>();
  for (const bodyCharacters of command.bodies) {
    const texts = await readNoteTexts(command.textsPath, bodyCharacters);
    byBody.set(bodyCharacters, {
      texts,
      prompts: pairTexts(directed, (id) => texts.rendered.get(id))
    });
  }
  const specs = planConfigs(command.runtime, command.instructionIds, command.bodies);
  for (const spec of specs) instructionText(spec);
  const written: string[] = [];
  await deps.withLock(async () => {
    const ranker = await deps.openRanker(command.runtime);
    try {
      const runtimeBuild = await ranker.runtimeBuild();
      const first = specs[0]!;
      // The first call loads the model: it is not part of any configuration's timing.
      await ranker.rank(
        instructionText(first),
        byBody.get(first.bodyCharacters)!.prompts.slice(0, 4)
      );
      for (const spec of specs) {
        const { texts, prompts } = byBody.get(spec.bodyCharacters)!;
        const instruction = instructionText(spec);
        deps.log(
          `${scoreFileName(spec)}: ${prompts.length} directed pairs ` +
            `(load ${deps
              .loadAverage()
              .map((v) => v.toFixed(1))
              .join(" ")})`
        );
        const before = deps.loadAverage();
        const startedAt = deps.now().toISOString();
        let reported = 0;
        const scored = await ranker.rank(instruction, prompts, (done) => {
          if (done - reported >= 300 || done === prompts.length) {
            reported = done;
            deps.log(`  ${done}/${prompts.length}`);
          }
        });
        const file = buildBakeoffScoreFile({
          spec,
          instruction,
          pairs,
          pairsPath: command.pairsPath,
          textsPath: command.textsPath,
          texts,
          ranker,
          runtimeBuild,
          directed,
          scored,
          startedAt,
          finishedAt: deps.now().toISOString(),
          hostLoadAverage: { before, after: deps.loadAverage() }
        });
        const path = join(command.outDir, scoreFileName(spec));
        await writeJson(path, file);
        written.push(path);
        deps.log(
          `  ${file.run.timing.msPerDirectedPair.toFixed(1)} ms per directed pair, ` +
            `${file.run.truncatedPairs} truncated, -> ${path}`
        );
      }
    } finally {
      await ranker.dispose();
    }
  });
  await writeIndex(command.outDir);
  return written;
}

// --- index -----------------------------------------------------------------------------------------------

export interface IndexEntry {
  file: string;
  sha256: string;
  runtime: string;
  path: string;
  instructionId: string;
  bodyCharacters: number;
  decider: string;
  directedPairs: number;
  scoresSha256: string;
  pairsSha256: string;
  textsSha256: string;
  noteTextDigest: string;
  msPerDirectedPair: number;
  startedAt: string;
}

const scoreFilePattern = /^labels-(mlx|gguf|bge)-[a-z0-9-]+-t\d+\.json$/u;

const scoreFileSchema = z.object({
  decider: z.string(),
  run: z.object({
    runtime: z.string(),
    path: z.string(),
    instructionId: z.string(),
    template: z.object({ bodyCharacters: z.number() }),
    inputs: z.object({
      directedPairs: z.number(),
      pairsSha256: z.string(),
      textsSha256: z.string(),
      noteTextDigest: z.string()
    }),
    timing: z.object({ msPerDirectedPair: z.number(), startedAt: z.string() }),
    scoresSha256: z.string()
  })
});

/** The bake-off score files of a directory, with the hash of each and of the inputs it was scored from. */
export async function readIndex(directory: string): Promise<IndexEntry[]> {
  const entries: IndexEntry[] = [];
  for (const file of (await readdir(directory))
    .filter((name) => scoreFilePattern.test(name))
    .sort()) {
    const bytes = await readFile(join(directory, file));
    const parsed = scoreFileSchema.parse(JSON.parse(bytes.toString("utf8")));
    entries.push({
      file,
      sha256: sha256Hex(bytes),
      runtime: parsed.run.runtime,
      path: parsed.run.path,
      instructionId: parsed.run.instructionId,
      bodyCharacters: parsed.run.template.bodyCharacters,
      decider: parsed.decider,
      directedPairs: parsed.run.inputs.directedPairs,
      scoresSha256: parsed.run.scoresSha256,
      pairsSha256: parsed.run.inputs.pairsSha256,
      textsSha256: parsed.run.inputs.textsSha256,
      noteTextDigest: parsed.run.inputs.noteTextDigest,
      msPerDirectedPair: parsed.run.timing.msPerDirectedPair,
      startedAt: parsed.run.timing.startedAt
    });
  }
  return entries;
}

export async function writeIndex(directory: string): Promise<IndexEntry[]> {
  const entries = await readIndex(directory);
  await writeJson(join(directory, "index.json"), {
    format: "memora-bakeoff-score-index",
    version: 1,
    task: bakeoffTask,
    files: entries
  });
  return entries;
}

// --- summary (descriptive: the selection rule is T58's) ----------------------------------------------------

export interface SummaryRow {
  file: string;
  aggregation: "max" | "mean";
  /** AUC of the aggregated score for `related`, by pool and over pools A-C; null when a class is empty. */
  auc: Record<string, number | null>;
  /** Fit and eval splits of pools A-C, for the instruction choice and its clean check. */
  aucFit: number | null;
  aucEval: number | null;
  /** Share of R_v6 and of R_v9 at or above the runtime's frozen Spike A threshold (max or mean). */
  rv6AtFrozenThreshold: number | null;
  rv9AtFrozenThreshold: number | null;
}

export function summarizeScoreFile(
  items: readonly LabelItem[],
  rv9Keys: ReadonlySet<string>,
  file: string,
  runtime: string,
  scores: Parameters<typeof aggregatePairScores>[0]
): SummaryRow[] {
  const thresholds: Record<string, number | undefined> = {
    mlx: frozenThreshold.mlx,
    gguf: frozenThreshold["gguf-qwen3"]
  };
  const threshold = thresholds[runtime];
  return (["max", "mean"] as const).map((aggregation) => {
    const aggregated = aggregatePairScores(scores, aggregation);
    const scoreOf = (item: LabelItem): number | undefined =>
      aggregated.get(item.lo < item.hi ? `${item.lo}:${item.hi}` : `${item.hi}:${item.lo}`);
    const labelled = items.filter(
      (item) => item.kind === "note" && item.pool !== null && item.related !== null
    );
    // A scorer may cover only some pools (Decisions scores pool A and the fixture, never B or C).
    const aucOf = (subset: readonly LabelItem[]): number | null => {
      const scored = (related: boolean) =>
        subset
          .filter((item) => item.related === related)
          .map((item) => scoreOf(item))
          .filter((score): score is number => score !== undefined);
      return auc(scored(true), scored(false));
    };
    const share = (keys: Iterable<string>): number | null => {
      if (threshold === undefined) return null;
      const list = [...keys];
      if (list.length === 0) return null;
      return (
        list.filter((key) => {
          const score = aggregated.get(key.replace("|", ":"));
          return score !== undefined && score >= threshold;
        }).length / list.length
      );
    };
    const result: Record<string, number | null> = { all: aucOf(labelled) };
    for (const pool of ["A", "B", "C"])
      result[pool] = aucOf(labelled.filter((i) => i.pool === pool));
    const rv6 = items.filter((item) => item.sets.includes("rv6"));
    return {
      file,
      aggregation,
      auc: result,
      aucFit: aucOf(labelled.filter((i) => i.split === "fit")),
      aucEval: aucOf(labelled.filter((i) => i.split === "eval")),
      rv6AtFrozenThreshold: share(rv6.map((item) => pairKeyOf(item.lo, item.hi))),
      rv9AtFrozenThreshold: share(rv9Keys)
    };
  });
}

const fixed = (value: number | null, digits = 3): string =>
  value === null ? "-" : value.toFixed(digits);

export function renderSummary(rows: readonly SummaryRow[], entries: readonly IndexEntry[]): string {
  const byFile = new Map(entries.map((entry) => [entry.file, entry]));
  const lines = [
    "# Bake-off scores: AUC of the aggregated score for `related`",
    "",
    "Descriptive only: the selection rule (D3) is applied by T58 on the fit labels. Pools A-C are the",
    "panel's labelled note pairs; R_v6 and R_v9 are evaluation-only sets (share at the frozen Spike A",
    "threshold of the runtime, meaningful for the `mechanism` instruction at 400 characters).",
    "",
    "| Scores | Rule | AUC all | A | B | C | fit | eval | R_v6 | R_v9 | ms/pair |",
    "| --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |"
  ];
  for (const row of rows)
    lines.push(
      `| ${row.file.replace(/^labels-|\.json$/gu, "")} | ${row.aggregation} | ${fixed(row.auc.all!)} | ` +
        `${fixed(row.auc.A!)} | ${fixed(row.auc.B!)} | ${fixed(row.auc.C!)} | ${fixed(row.aucFit)} | ` +
        `${fixed(row.aucEval)} | ${fixed(row.rv6AtFrozenThreshold, 2)} | ` +
        `${fixed(row.rv9AtFrozenThreshold, 2)} | ${fixed(byFile.get(row.file)?.msPerDirectedPair ?? null, 1)} |`
    );
  return `${lines.join("\n")}\n`;
}

export async function runSummary(
  directory: string,
  labelsPath: string,
  rv9PairsPath: string
): Promise<string> {
  const labels = labelFixtureSchema.parse(JSON.parse(await readFile(labelsPath, "utf8")));
  const pairs = await readPairsFile(rv9PairsPath);
  const membership = (pairs.file as { membership?: Record<string, string[]> }).membership ?? {};
  const rv9Keys = new Set(
    Object.entries(membership)
      .filter(([, sets]) => sets.includes("rv9"))
      .map(([key]) => key)
  );
  const entries = await readIndex(directory);
  const rows = (
    await Promise.all(
      entries.map(async (entry) =>
        summarizeScoreFile(
          labels.items,
          rv9Keys,
          entry.file,
          entry.runtime,
          await readPairScores(join(directory, entry.file))
        )
      )
    )
  ).flat();
  // Decisions (D6) covers pool A, R_v6 and the fixture lists only: its other columns stay empty.
  const decisions = await readPairScores(join(directory, decisionsScoresFile)).catch(() => null);
  if (decisions)
    rows.push(
      ...summarizeScoreFile(labels.items, rv9Keys, decisionsScoresFile, "decisions", decisions)
    );
  const markdown = renderSummary(rows, entries);
  await writeJson(join(directory, "summary.json"), { task: bakeoffTask, rows });
  await writeFile(join(directory, "summary.md"), markdown);
  return markdown;
}

// --- command line ----------------------------------------------------------------------------------------

const usage = `Usage: npx tsx scripts/relations/bakeoff-score-pairs.ts <score|index|summary> [options]

  score   --runtime mlx|gguf|bge [--instructions mechanism,relation,study,default] [--bodies 400,600]
  index   rewrites index.json from the score files of the directory
  summary writes summary.json and summary.md (AUC per pool and split, R_v6 and R_v9 coverage)

Common: --out-dir (default .cache/f3/scores/bakeoff), --pairs, --texts, --lock (default
  .cache/f2/LOCAL_MODEL_BUSY), --owner <task id> (default T46b)`;

const list = (text: string | undefined, fallback: readonly string[]): string[] =>
  text === undefined
    ? [...fallback]
    : text
        .split(",")
        .map((part) => part.trim())
        .filter(Boolean);

export async function main(argv: readonly string[], deps?: BakeoffDependencies): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      runtime: { type: "string" },
      instructions: { type: "string" },
      bodies: { type: "string" },
      "out-dir": { type: "string" },
      pairs: { type: "string" },
      texts: { type: "string" },
      lock: { type: "string" },
      owner: { type: "string" },
      help: { type: "boolean", short: "h" }
    },
    allowPositionals: true,
    strict: true
  });
  const [subcommand] = positionals;
  if (values.help || !subcommand) {
    console.info(usage);
    return;
  }
  const outDir = resolve(values["out-dir"] ?? bakeoffDirectory);
  const pairsPath = resolve(values.pairs ?? join(bakeoffDirectory, inputFiles.pairs));
  if (subcommand === "index") {
    const entries = await writeIndex(outDir);
    console.info(`index.json: ${entries.length} score files`);
  } else if (subcommand === "summary") {
    console.info(await runSummary(outDir, defaultSourcePaths.labels, pairsPath));
  } else if (subcommand === "score") {
    if (values.runtime !== "mlx" && values.runtime !== "gguf" && values.runtime !== "bge")
      throw new Error("--runtime is mlx, gguf or bge.");
    const bodies = list(values.bodies, templateBodyCharacters.map(String)).map(Number);
    if (bodies.some((body) => !(templateBodyCharacters as readonly number[]).includes(body)))
      throw new Error(`--bodies is a list of ${templateBodyCharacters.join(", ")}.`);
    await runBakeoffScore(
      {
        runtime: values.runtime,
        instructionIds: list(values.instructions, instructionOrder),
        bodies,
        pairsPath,
        textsPath: resolve(values.texts ?? join(bakeoffDirectory, inputFiles.texts)),
        outDir
      },
      deps ??
        defaultDependencies(resolve(values.lock ?? defaultPaths.lock), values.owner ?? bakeoffTask)
    );
  } else {
    throw new Error(`Unknown command "${subcommand}".\n${usage}`);
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(
      `[bakeoff-score-pairs] ${error instanceof Error ? error.message : String(error)}`
    );
    process.exitCode = 1;
  }
}
