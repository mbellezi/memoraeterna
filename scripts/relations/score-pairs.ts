/**
 * Local pair scoring harness (F3 T46a, spec 5.4 step 4 and 3.18): scores the note pairs of T44's candidate
 * exports in both directions with the Qwen3-Reranker on MLX or GGUF (the runtimes of Spike A, reused
 * read-only), measures B1, and checks the harness against Spike A's stored scores.
 *
 *   npx tsx scripts/relations/score-pairs.ts score  --runtime mlx|gguf --profile env-f [--profile env-g ...]
 *   npx tsx scripts/relations/score-pairs.ts b1     --runtime mlx|gguf [--profile env-f] [--call-sizes 16,32,48]
 *   npx tsx scripts/relations/score-pairs.ts parity --runtime mlx|gguf [--sample 300]
 *
 * Inputs: `<pairs-dir>/<profile>-pairs.json` (T44) and `<texts-dir>/<profile>-note-texts.json`
 * (`export-note-texts.ts`). Outputs under `<out-dir>`: `<profile>-<runtime>-<instruction>.json` in the
 * `memora-relations-pair-scores` format with the hashes of its inputs, `b1-<runtime>.json` and
 * `parity-<runtime>.json`. Local inference holds the machine-wide lock file
 * (`.cache/f2/LOCAL_MODEL_BUSY`, decision D45) and waits for any other local-model process; the lock is
 * removed when the run ends, also on failure. No embedding or generative model and no provider is used.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { loadavg } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import { loadFrozen, repositoryRoot } from "../spikes/reranker/dataset.ts";
import { instructionCandidates } from "../spikes/reranker/instructions.ts";
import { mean, percentile } from "../spikes/reranker/metrics.ts";
import { otherLocalModelJobs } from "../spikes/topic-tree/local-model-slot.ts";
import { drawPairs, measureB1, renderB1Markdown, type B1Result } from "./b1-benchmark.ts";
import { waitForModelsOutsideTheLock, withLocalModelLock } from "./local-model-lock.ts";
import { readNoteTexts, sha256Hex, type TextLookup } from "./note-texts.ts";
import {
  buildScoreFile,
  checkScoreFile,
  directedPairsOf,
  pairTexts,
  readPairsFile,
  scoreDirectedPairs,
  type PairScorer,
  type RuntimeBuild,
  type RuntimeKind
} from "./pair-scoring.ts";

const cacheDirectory = join(repositoryRoot, ".cache");

/** Spike A's frozen thresholds (log-odds, max of both directions): the rule the scores are read at. */
export const frozenThreshold: Record<RuntimeKind, number> = {
  mlx: 3.3125,
  "gguf-qwen3": 3.1626532246778707
};

export const defaultPaths = {
  pairsDir: join(cacheDirectory, "f3", "m0", "pairs"),
  textsDir: join(cacheDirectory, "f3", "scratch", "t46a"),
  outDir: join(cacheDirectory, "f3", "scores"),
  lock: join(cacheDirectory, "f2", "LOCAL_MODEL_BUSY")
} as const;

export interface PairRuntime extends PairScorer {
  dispose(): Promise<void>;
}

/** What the commands need from outside the process: the runtimes, the lock, the clock. Tests inject fakes. */
export interface Dependencies {
  openRuntime(kind: RuntimeKind, instruction: string): Promise<PairRuntime>;
  runtimeBuild(kind: RuntimeKind): Promise<RuntimeBuild>;
  /** Holds the local-model lock (and waits for the slot) while `work` runs. */
  withLock<T>(work: () => Promise<T>): Promise<T>;
  now(): Date;
  loadAverage(): number[];
  log(message: string): void;
}

export function defaultDependencies(lock: string, owner: string): Dependencies {
  return {
    async openRuntime(kind, instruction) {
      const { openRuntime } = await import("../spikes/reranker/runtimes.ts");
      return openRuntime(kind, instruction);
    },
    async runtimeBuild(kind) {
      if (kind === "mlx") {
        const { defaultHelperPath } = await import("../spikes/lib/mlx-helper-client.ts");
        return { kind: "mlx-helper", sha256: sha256Hex(await readFile(defaultHelperPath)) };
      }
      const manifest = JSON.parse(
        await readFile(
          join(repositoryRoot, "node_modules", "node-llama-cpp", "package.json"),
          "utf8"
        )
      ) as { version: string };
      return { kind: "node-llama-cpp", version: manifest.version };
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

/** A path as a score file records it: relative to the checkout when inside it, so a worktree's path does not leak in. */
export function recordedPath(path: string): string {
  const relativePath = relative(repositoryRoot, path);
  return relativePath.startsWith("..") || isAbsolute(relativePath) ? path : relativePath;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${JSON.stringify(value)}\n`);
}

export async function resolveInstruction(
  requested: string | undefined
): Promise<{ id: string; text: string }> {
  const frozen = await loadFrozen();
  const id = requested ?? frozen.instructionId;
  const text = instructionCandidates[id];
  if (!text) throw new Error(`Unknown instruction "${id}".`);
  if (id === frozen.instructionId && text !== frozen.instruction)
    throw new Error(`The instruction "${id}" differs from Spike A's frozen.json.`);
  return { id, text };
}

export const runtimeKindOf = (name: "mlx" | "gguf"): RuntimeKind =>
  name === "mlx" ? "mlx" : "gguf-qwen3";

// --- score ---------------------------------------------------------------------------------------

export interface ScoreCommand {
  runtime: RuntimeKind;
  profiles: string[];
  instructionId: string;
  instruction: string;
  batchSize: number;
  requestSize: number;
  pairsDir: string;
  textsDir: string;
  outDir: string;
}

export async function runScore(command: ScoreCommand, deps: Dependencies): Promise<string[]> {
  // Everything that can be wrong with the inputs fails before the lock is taken.
  const jobs = await Promise.all(
    command.profiles.map(async (profile) => {
      const pairs = await readPairsFile(join(command.pairsDir, `${profile}-pairs.json`));
      const textsPath = join(command.textsDir, `${profile}-note-texts.json`);
      const texts = await readNoteTexts(textsPath);
      const lookup: TextLookup = (id) => texts.rendered.get(id);
      const directed = directedPairsOf(pairs.file.pairs);
      return {
        profile,
        pairs,
        textsPath,
        texts,
        lookup,
        directed,
        prompts: pairTexts(directed, lookup)
      };
    })
  );
  const build = await deps.runtimeBuild(command.runtime);
  const written: string[] = [];
  await deps.withLock(async () => {
    const runtime = await deps.openRuntime(command.runtime, command.instruction);
    try {
      await runtime.scorePairs(jobs[0]!.prompts.slice(0, 4), command.batchSize);
      for (const job of jobs) {
        deps.log(
          `${job.profile} ${command.runtime}: ${job.directed.length} directed pairs ` +
            `(batch ${command.batchSize}, request ${command.requestSize}, load ${deps
              .loadAverage()
              .map((v) => v.toFixed(1))
              .join(" ")})`
        );
        const before = deps.loadAverage();
        const startedAt = deps.now().toISOString();
        let reported = 0;
        const scored = await scoreDirectedPairs(runtime, job.prompts, {
          batchSize: command.batchSize,
          requestSize: command.requestSize,
          onProgress: (done, total) => {
            if (done - reported >= 2_000 || done === total) {
              reported = done;
              deps.log(`  ${done}/${total}`);
            }
          }
        });
        const file = buildScoreFile({
          profile: job.profile,
          runtime: command.runtime,
          instructionId: command.instructionId,
          instruction: command.instruction,
          pairs: job.pairs,
          textsPath: recordedPath(job.textsPath),
          textsSha256: job.texts.sha256,
          lookup: job.lookup,
          artifact: runtime.artifact,
          build,
          options: { batchSize: command.batchSize, requestSize: command.requestSize },
          directed: job.directed,
          scored,
          startedAt,
          finishedAt: deps.now().toISOString(),
          hostLoadAverage: { before, after: deps.loadAverage() }
        });
        checkScoreFile(file, job.pairs.file);
        const path = join(
          command.outDir,
          `${job.profile}-${command.runtime === "mlx" ? "mlx" : "gguf"}-${command.instructionId}.json`
        );
        await writeJson(path, file);
        written.push(path);
        const accepted = file.scores.filter(
          (score) => score.logOdds >= frozenThreshold[command.runtime]
        ).length;
        deps.log(
          `  ${file.run.timing.msPerDirectedPair.toFixed(1)} ms per directed pair, ` +
            `${accepted} directed scores >= ${frozenThreshold[command.runtime]} -> ${path}`
        );
      }
    } finally {
      await runtime.dispose();
    }
  });
  return written;
}

// --- b1 ------------------------------------------------------------------------------------------

export interface B1Command {
  runtime: RuntimeKind;
  profile: string;
  instructionId: string;
  instruction: string;
  callSizes: number[];
  helperBatches: number[];
  repeats: number;
  callsPerRepeat: number;
  seed: number;
  pairsDir: string;
  textsDir: string;
  out: string;
}

export async function runB1(
  command: B1Command,
  deps: Dependencies
): Promise<{ result: B1Result; markdown: string }> {
  const pairs = await readPairsFile(join(command.pairsDir, `${command.profile}-pairs.json`));
  const textsPath = join(command.textsDir, `${command.profile}-note-texts.json`);
  const texts = await readNoteTexts(textsPath);
  const candidates = pairTexts(directedPairsOf(pairs.file.pairs), (id) => texts.rendered.get(id));
  const build = await deps.runtimeBuild(command.runtime);
  return deps.withLock(async () => {
    const runtime = await deps.openRuntime(command.runtime, command.instruction);
    try {
      const before = deps.loadAverage();
      const startedAt = deps.now().toISOString();
      const result = await measureB1(runtime, candidates, {
        callSizes: command.callSizes,
        helperBatches: command.helperBatches,
        batched: command.runtime === "mlx",
        repeats: command.repeats,
        callsPerRepeat: command.callsPerRepeat,
        seed: command.seed,
        onCall: (done, total) => {
          if (done % 30 === 0 || done === total) deps.log(`  B1 ${done}/${total} calls`);
        }
      });
      const hostLoadAverage = { before, after: deps.loadAverage() };
      const markdown = renderB1Markdown(result, { runtime: command.runtime, hostLoadAverage });
      await writeJson(command.out, {
        format: "memora-relations-b1",
        version: 1,
        task: "T46a",
        runtime: command.runtime,
        instructionId: command.instructionId,
        instructionSha256: sha256Hex(command.instruction),
        model: runtime.artifact,
        build,
        inputs: {
          profile: command.profile,
          pairsSha256: pairs.sha256,
          textsSha256: texts.sha256
        },
        startedAt,
        finishedAt: deps.now().toISOString(),
        hostLoadAverage,
        result
      });
      await writeFile(command.out.replace(/\.json$/u, ".md"), markdown);
      return { result, markdown };
    } finally {
      await runtime.dispose();
    }
  });
}

// --- parity --------------------------------------------------------------------------------------

/** Spike A's pair set with its rendered note text and the log-odds it stored for it. */
export interface ParityReference {
  pairs: Array<[string, string]>;
  textOf: ReadonlyMap<string, string>;
  logOdds: readonly number[];
  batchSize: number;
}

export interface ParityReport {
  runtime: RuntimeKind;
  sample: number;
  referencePairs: number;
  referenceBatchSize: number;
  helperBatchSize: number;
  maxAbsDelta: number;
  meanAbsDelta: number;
  p99AbsDelta: number;
  threshold: number;
  /** Pairs on the other side of the threshold in the two runs. */
  thresholdFlips: number;
}

export function compareScores(
  reference: readonly number[],
  rescored: readonly number[],
  threshold: number
): Pick<ParityReport, "maxAbsDelta" | "meanAbsDelta" | "p99AbsDelta" | "thresholdFlips"> {
  if (reference.length !== rescored.length)
    throw new Error("The two score lists differ in length.");
  const deltas = reference.map((value, index) => Math.abs(value - rescored[index]!));
  return {
    maxAbsDelta: Math.max(...deltas),
    meanAbsDelta: mean(deltas),
    p99AbsDelta: percentile(deltas, 0.99),
    thresholdFlips: reference.filter(
      (value, index) => value >= threshold !== rescored[index]! >= threshold
    ).length
  };
}

export interface ParityCommand {
  runtime: RuntimeKind;
  instructionId: string;
  instruction: string;
  sample: number;
  seed: number;
  batchSize: number;
  out: string;
}

export async function runParity(
  command: ParityCommand,
  reference: ParityReference,
  deps: Dependencies
): Promise<ParityReport> {
  const indices = drawPairs(
    reference.pairs.map((_, index) => index),
    Math.min(command.sample, reference.pairs.length),
    command.seed
  ).sort((a, b) => a - b);
  const prompts = indices.map((index) => {
    const [query, doc] = reference.pairs[index]!;
    const left = reference.textOf.get(query);
    const right = reference.textOf.get(doc);
    if (left === undefined || right === undefined)
      throw new Error("Spike A's dataset has no text for a sampled note.");
    return { query: left, document: right };
  });
  const build = await deps.runtimeBuild(command.runtime);
  return deps.withLock(async () => {
    const runtime = await deps.openRuntime(command.runtime, command.instruction);
    try {
      const scored = await scoreDirectedPairs(runtime, prompts, {
        batchSize: command.batchSize,
        requestSize: 2_048
      });
      const threshold = frozenThreshold[command.runtime];
      const report: ParityReport = {
        runtime: command.runtime,
        sample: indices.length,
        referencePairs: reference.pairs.length,
        referenceBatchSize: reference.batchSize,
        helperBatchSize: command.batchSize,
        threshold,
        ...compareScores(
          indices.map((index) => reference.logOdds[index]!),
          scored.logOdds,
          threshold
        )
      };
      await writeJson(command.out, {
        format: "memora-relations-parity",
        version: 1,
        task: "T46a",
        instructionId: command.instructionId,
        instructionSha256: sha256Hex(command.instruction),
        model: runtime.artifact,
        build,
        seed: command.seed,
        report
      });
      return report;
    } finally {
      await runtime.dispose();
    }
  });
}

async function loadParityReference(
  kind: RuntimeKind,
  instructionId: string
): Promise<ParityReference> {
  const [{ loadDataset }, { loadScoreFile }] = await Promise.all([
    import("../spikes/reranker/dataset.ts"),
    import("../spikes/reranker/scores.ts")
  ]);
  const dataset = await loadDataset();
  const stored = await loadScoreFile(kind, instructionId, "all", 16);
  if (stored.logOdds.length !== dataset.sets.all.length)
    throw new Error("Spike A's stored scores do not match its dataset.");
  return {
    pairs: dataset.sets.all.map(([a, b]) => [a, b]),
    textOf: new Map(dataset.notes.map((note) => [note.id, note.text])),
    logOdds: stored.logOdds,
    batchSize: stored.batchSize
  };
}

// --- command line --------------------------------------------------------------------------------

const usage = `Usage: npx tsx scripts/relations/score-pairs.ts <score|b1|parity> --runtime mlx|gguf [options]

  score   --profile <name> (repeatable)  both directions of a profile's pairs; writes <profile>-<runtime>-<instruction>.json
  b1      [--profile env-f] [--call-sizes 16,32,48] [--helper-batches 16,32,48] [--repeats 3]
          [--calls-per-repeat 10] [--seed 20261017]   ms per directed pair per call size and helper batch
  parity  [--sample 300] [--seed 20261017]   rescores a sample of Spike A's pairs and compares with its stored scores

Common: --instruction <id> (default Spike A's frozen one), --batch <n> (helper batch, default 16),
  --request-size <n> (directed pairs per request, default 2048), --pairs-dir, --texts-dir, --out-dir,
  --lock <file> (default .cache/f2/LOCAL_MODEL_BUSY), --owner <task id> (default T46a), --out <file>`;

const numbers = (text: string, flag: string): number[] => {
  const values = text.split(",").map((part) => Number(part.trim()));
  if (values.length === 0 || values.some((value) => !Number.isInteger(value) || value <= 0))
    throw new Error(`${flag} must be a comma-separated list of positive integers.`);
  return values;
};

const positive = (text: string | undefined, fallback: number, flag: string): number => {
  const value = text === undefined ? fallback : Number(text);
  if (!Number.isInteger(value) || value <= 0)
    throw new Error(`${flag} must be a positive integer.`);
  return value;
};

export async function main(argv: readonly string[], deps?: Dependencies): Promise<void> {
  const { values, positionals } = parseArgs({
    args: [...argv],
    options: {
      runtime: { type: "string" },
      profile: { type: "string", multiple: true },
      instruction: { type: "string" },
      batch: { type: "string" },
      "request-size": { type: "string" },
      "call-sizes": { type: "string" },
      "helper-batches": { type: "string" },
      repeats: { type: "string" },
      "calls-per-repeat": { type: "string" },
      sample: { type: "string" },
      seed: { type: "string" },
      "pairs-dir": { type: "string" },
      "texts-dir": { type: "string" },
      "out-dir": { type: "string" },
      lock: { type: "string" },
      owner: { type: "string" },
      out: { type: "string" },
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
  if (values.runtime !== "mlx" && values.runtime !== "gguf")
    throw new Error("--runtime is mlx or gguf.");
  const runtime = runtimeKindOf(values.runtime);
  const instruction = await resolveInstruction(values.instruction);
  const outDir = resolve(values["out-dir"] ?? defaultPaths.outDir);
  const dependencies =
    deps ?? defaultDependencies(resolve(values.lock ?? defaultPaths.lock), values.owner ?? "T46a");
  const batchSize = positive(values.batch, 16, "--batch");
  const seed = positive(values.seed, 20_261_017, "--seed");
  if (subcommand === "score") {
    if (!values.profile || values.profile.length === 0) throw new Error("--profile is required.");
    await runScore(
      {
        runtime,
        profiles: values.profile,
        instructionId: instruction.id,
        instruction: instruction.text,
        batchSize,
        requestSize: positive(values["request-size"], 2_048, "--request-size"),
        pairsDir: resolve(values["pairs-dir"] ?? defaultPaths.pairsDir),
        textsDir: resolve(values["texts-dir"] ?? defaultPaths.textsDir),
        outDir
      },
      dependencies
    );
  } else if (subcommand === "b1") {
    const { markdown } = await runB1(
      {
        runtime,
        profile: values.profile?.[0] ?? "env-f",
        instructionId: instruction.id,
        instruction: instruction.text,
        callSizes: numbers(values["call-sizes"] ?? "16,32,48", "--call-sizes"),
        helperBatches: numbers(values["helper-batches"] ?? "16,32,48", "--helper-batches"),
        repeats: positive(values.repeats, 3, "--repeats"),
        callsPerRepeat: positive(values["calls-per-repeat"], 10, "--calls-per-repeat"),
        seed,
        pairsDir: resolve(values["pairs-dir"] ?? defaultPaths.pairsDir),
        textsDir: resolve(values["texts-dir"] ?? defaultPaths.textsDir),
        out: resolve(values.out ?? join(outDir, `b1-${values.runtime}.json`))
      },
      dependencies
    );
    console.info(markdown);
  } else if (subcommand === "parity") {
    const report = await runParity(
      {
        runtime,
        instructionId: instruction.id,
        instruction: instruction.text,
        sample: positive(values.sample, 300, "--sample"),
        seed,
        batchSize,
        out: resolve(values.out ?? join(outDir, `parity-${values.runtime}.json`))
      },
      await loadParityReference(runtime, instruction.id),
      dependencies
    );
    console.info(JSON.stringify(report, null, 2));
  } else {
    throw new Error(`Unknown command "${subcommand}".\n${usage}`);
  }
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    console.error(`[score-pairs] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
