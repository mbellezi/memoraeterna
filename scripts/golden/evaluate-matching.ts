/**
 * Scores a library against the matching-quality fixture: expected and forbidden root pairs per
 * partition (from note relations and source relations aggregated to roots) and the cost of the
 * reranking calls per note.
 *
 *   npx tsx scripts/golden/evaluate-matching.ts --db <connection.json | postgres url> [options]
 *   npx tsx scripts/golden/evaluate-matching.ts --gate f3 --sample S0=<source> --sample S1=<source> ...
 *   npx tsx scripts/golden/evaluate-matching.ts --pre-freeze-feasibility --relations <export> --scores <scores>
 *
 * Read-only (default_transaction_read_only plus a read-only transaction). The report holds counts
 * and root ids only: no note text, no relation explanations, no password. The held-out partition is
 * sealed until `.cache/f3/freeze/frozen.json` exists (F3 decision D3).
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { z } from "zod";

import { preFreezeFeasibility, renderFeasibility } from "./candidate-recall.ts";
import { readHeldOutAccess, type HeldOutAccess } from "./freeze-guard.ts";
import {
  aggregateGate,
  defaultGateOptions,
  gateExitCode,
  gateSampleSchema,
  renderGateMarkdown,
  resealSample,
  summarizeSample,
  type GateSample
} from "./gate-f3.ts";
import {
  checkExitCode,
  evaluateMatching,
  renderEvaluationMarkdown,
  sealHeldOut,
  type EvaluationInput,
  type MatchingEvaluation
} from "./matching-evaluation.ts";
import {
  evaluateUsage,
  parseEvaluateArgs,
  readBenchmarkIds,
  readLibrary,
  readLibraryExport,
  readMapping,
  resolveEvaluationConnection,
  type EvaluateArgs,
  type EvaluationConnection,
  type ReadOptions
} from "./matching-evaluation-db.ts";
import type { MatchingMapping } from "./matching-fixture.ts";
import { readPairScores, readRelationsExport, type RelationsExport } from "./relations-export.ts";

/** What the command needs from outside: the database, and the freeze record. Tests inject fakes. */
export interface EvaluateDependencies {
  readLibrary: (
    connection: EvaluationConnection,
    mapping: MatchingMapping,
    options: ReadOptions
  ) => Promise<EvaluationInput>;
  readLibraryExport: (
    connection: EvaluationConnection,
    options: { statuses?: readonly string[] | undefined; label?: string | null | undefined }
  ) => Promise<RelationsExport>;
  readHeldOutAccess: (path?: string) => Promise<HeldOutAccess>;
  log: (message: string) => void;
}

export const defaultDependencies: EvaluateDependencies = {
  readLibrary,
  readLibraryExport,
  readHeldOutAccess,
  log: (message) => console.error(message)
};

export interface EvaluateOutcome {
  /** What to print on stdout; null when the report went to a file. */
  text: string | null;
  exitCode: 0 | 1 | 2;
}

async function write(path: string, content: string): Promise<void> {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, content);
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The parts of a stored evaluation the gate reads; the applied-only layer marks the F3 evaluator's output. */
const layers = z
  .object({
    notes: z.object({}).passthrough(),
    notesApplied: z.object({}).passthrough(),
    sources: z.object({}).passthrough(),
    either: z.object({}).passthrough()
  })
  .passthrough();
const storedPartition = z.object({ layers }).passthrough();
const storedEvaluationSchema = z
  .object({
    format: z.literal("memora-golden-matching-evaluation"),
    partitions: z.object({ tuning: storedPartition, holdout: storedPartition }),
    cost: z
      .object({
        noteMatching: z.object({}).passthrough(),
        sourceMatching: z.object({}).passthrough()
      })
      .passthrough(),
    resolution: z.object({ warnings: z.array(z.string()) }).passthrough(),
    exit: z.object({}).passthrough()
  })
  .passthrough();

/** One library, scored, with the held-out partition sealed unless the freeze record is open. */
async function evaluateLibrary(
  source: string,
  command: EvaluateArgs,
  mapping: MatchingMapping,
  access: HeldOutAccess,
  deps: EvaluateDependencies
) {
  const ids = command.ids ? await readBenchmarkIds(command.ids) : undefined;
  const connection = await resolveEvaluationConnection(source);
  deps.log(`[evaluate-matching] reading ${connection.description}`);
  const input = await deps.readLibrary(connection, mapping, {
    tasks: command.tasks,
    since: command.since,
    until: command.until,
    ids,
    statuses: command.options.statuses
  });
  const evaluation = evaluateMatching(input, command.options, command.tasks);
  return {
    connection,
    evaluation: access.open ? evaluation : sealHeldOut(evaluation, access.reason)
  };
}

function evaluationJson(
  evaluation: MatchingEvaluation,
  command: EvaluateArgs,
  mapping: MatchingMapping,
  database: string
) {
  return {
    ...evaluation,
    context: {
      label: command.label,
      database,
      fixture: mapping.fixture,
      manifest: mapping.manifest,
      idsFile: command.ids,
      window: { since: command.since?.toISOString(), until: command.until?.toISOString() },
      generatedAt: new Date().toISOString()
    }
  };
}

async function runLegacy(
  command: EvaluateArgs,
  access: HeldOutAccess,
  deps: EvaluateDependencies
): Promise<EvaluateOutcome> {
  const mapping = await readMapping(command.mapping);
  const { connection, evaluation } = await evaluateLibrary(
    command.db!,
    command,
    mapping,
    access,
    deps
  );
  const markdown = renderEvaluationMarkdown(evaluation, {
    label: command.label,
    database: connection.description,
    fixtureSha256: mapping.fixture.sha256
  });
  if (command.json) {
    await write(
      command.json,
      `${JSON.stringify(evaluationJson(evaluation, command, mapping, connection.description), null, 2)}\n`
    );
    deps.log(`[evaluate-matching] wrote ${command.json}`);
  }
  const exitCode = command.check ? checkExitCode(evaluation.exit.pass) : 0;
  if (command.out) {
    await write(command.out, markdown);
    deps.log(`[evaluate-matching] wrote ${command.out}`);
    return { text: null, exitCode };
  }
  return { text: markdown, exitCode };
}

/** Loads the samples one source names: a library, a stored sample, a stored gate report or a stored evaluation. */
async function loadSamples(
  spec: { label: string | null; source: string },
  command: EvaluateArgs,
  getMapping: () => Promise<MatchingMapping>,
  access: HeldOutAccess,
  deps: EvaluateDependencies
): Promise<GateSample[]> {
  let parsed: unknown = null;
  if (!/^postgres(ql)?:\/\//iu.test(spec.source)) {
    try {
      parsed = JSON.parse(await readFile(spec.source, "utf8"));
    } catch {
      throw new Error(`Cannot read the sample "${spec.source}".`);
    }
  }
  const relabel = (sample: GateSample): GateSample => ({
    ...sample,
    label: spec.label ?? sample.label
  });
  const guard = (sample: GateSample): GateSample =>
    access.open ? sample : resealSample(sample, access.reason);
  if (isRecord(parsed) && parsed.format === "memora-golden-gate-f3-sample")
    return [guard(relabel(gateSampleSchema.parse(parsed)))];
  if (isRecord(parsed) && parsed.format === "memora-golden-gate-f3") {
    const stored = gateSampleSchema.array().parse(parsed.samples);
    // A label names one sample; a stored report keeps the labels it was stored with.
    return stored.map((sample) => guard(stored.length === 1 ? relabel(sample) : sample));
  }
  if (isRecord(parsed) && parsed.format === "memora-golden-matching-evaluation") {
    const checked = storedEvaluationSchema.safeParse(parsed);
    if (!checked.success)
      throw new Error(
        `"${spec.source}" is an evaluation from before the F3 gate (no applied-only layer): run the current evaluator again.`
      );
    const stored = parsed as unknown as MatchingEvaluation;
    const evaluation = access.open ? stored : sealHeldOut(stored, access.reason);
    const context = isRecord(parsed.context) ? parsed.context : {};
    return [
      summarizeSample(spec.label ?? String(context.label ?? spec.source), evaluation, access, {
        database: typeof context.database === "string" ? context.database : null,
        generatedAt: typeof context.generatedAt === "string" ? context.generatedAt : null
      })
    ];
  }
  if (parsed !== null && !(isRecord(parsed) && typeof parsed.connectionString === "string"))
    throw new Error(`"${spec.source}" is neither a connection nor a stored sample or evaluation.`);
  const { connection, evaluation } = await evaluateLibrary(
    spec.source,
    command,
    await getMapping(),
    access,
    deps
  );
  return [
    summarizeSample(spec.label ?? connection.description, evaluation, access, {
      database: connection.description,
      generatedAt: new Date().toISOString()
    })
  ];
}

async function runGate(
  command: EvaluateArgs,
  access: HeldOutAccess,
  deps: EvaluateDependencies
): Promise<EvaluateOutcome> {
  // The fixture mapping is only needed to score a library; stored samples carry their counts.
  let mapping: Promise<MatchingMapping> | undefined;
  const getMapping = () => (mapping ??= readMapping(command.mapping));
  const specs = [
    ...(command.db ? [{ label: command.label, source: command.db }] : []),
    ...command.samples
  ];
  const samples: GateSample[] = [];
  for (const spec of specs)
    samples.push(...(await loadSamples(spec, command, getMapping, access, deps)));
  const labels = samples.map((sample) => sample.label);
  const duplicate = labels.find((label, index) => labels.indexOf(label) !== index);
  if (duplicate !== undefined) throw new Error(`Two samples are labelled "${duplicate}".`);
  const unknownJudge = command.liveJudge.filter((label) => !labels.includes(label));
  if (unknownJudge.length)
    throw new Error(`--live-judge names samples that are not loaded: ${unknownJudge.join(", ")}.`);
  const gateOptions = {
    ...defaultGateOptions,
    minSamples: command.minSamples,
    minMeanExpected: command.options.minExpected,
    maxForbidden: command.options.maxForbidden,
    liveJudge: command.liveJudge
  };
  const report = aggregateGate(samples, gateOptions);
  const markdown = renderGateMarkdown(report, { title: command.label ?? "" });
  if (command.json) {
    await write(
      command.json,
      `${JSON.stringify({ ...report, context: { label: command.label, generatedAt: new Date().toISOString() } }, null, 2)}\n`
    );
    deps.log(`[evaluate-matching] wrote ${command.json}`);
  }
  const exitCode = command.check ? gateExitCode(report.pass) : 0;
  if (command.out) {
    await write(command.out, markdown);
    deps.log(`[evaluate-matching] wrote ${command.out}`);
    return { text: null, exitCode };
  }
  return { text: markdown, exitCode };
}

/** The whole command: parses `argv`, reads what it names and returns what to print and the exit code. */
export async function runEvaluate(
  argv: readonly string[],
  deps: EvaluateDependencies = defaultDependencies
): Promise<EvaluateOutcome> {
  const command = parseEvaluateArgs(argv);
  if (command.kind === "help") return { text: evaluateUsage, exitCode: 0 };

  if (command.kind === "feasibility") {
    // Two held-out aggregates and nothing else: no log line, no file, no pair.
    const data = await readRelationsExport(command.relations);
    const mapping = await readMapping(command.mapping);
    const scores = await readPairScores(command.scores);
    const feasibility = preFreezeFeasibility(data, mapping, scores, command.rule, command.k);
    return { text: renderFeasibility(feasibility, command.label ?? "ranker"), exitCode: 0 };
  }

  if (command.kind === "export") {
    const connection = await resolveEvaluationConnection(command.db);
    deps.log(`[evaluate-matching] exporting ${connection.description}`);
    const data = await deps.readLibraryExport(connection, {
      statuses: command.statuses,
      label: command.label
    });
    await write(command.out, `${JSON.stringify(data)}\n`);
    deps.log(
      `[evaluate-matching] wrote ${command.out} (${data.notes.length} notes, ${data.candidates.length} candidates, ${data.decisions.length} decisions, ${data.relations.length} relations)`
    );
    return { text: null, exitCode: 0 };
  }

  const access = await deps.readHeldOutAccess(command.frozen ?? undefined);
  if (!access.open)
    deps.log(`[evaluate-matching] held-out sealed until the freeze: ${access.reason}`);
  return command.gate === "f3" ? runGate(command, access, deps) : runLegacy(command, access, deps);
}

if (import.meta.main) {
  try {
    const outcome = await runEvaluate(process.argv.slice(2));
    if (outcome.text !== null) console.info(outcome.text);
    process.exitCode = outcome.exitCode;
  } catch (error) {
    // Driver errors can echo the connection string; report only a content-free summary.
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `[evaluate-matching] ${message.replace(/postgres(ql)?:\/\/\S+/giu, "postgres://***")}`
    );
    console.error("Run with --help for usage.");
    process.exitCode = 1;
  }
}
