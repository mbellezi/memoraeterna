/**
 * OpenAI Decisions scoring for the F3 bake-off (T46 part b, decision D6): the predicate configuration
 * of Spike A2, both directions, two candidate shuffles, over pool A, R_v6 and the fixture candidate
 * lists ONLY (synthetic fixture text and Spike A's synthetic benchmark text; never a golden or corpus
 * note). It reuses the spike's client, request design, runner and spend guards read-only:
 *
 *   npx tsx scripts/relations/bakeoff-decisions.ts plan              requests, tokens and cost; sends nothing
 *   npx tsx scripts/relations/bakeoff-decisions.ts run [--concurrency 4] [--env-file <.env>]
 *   npx tsx scripts/relations/bakeoff-decisions.ts scores            writes the score file from the raw logs
 *   npx tsx scripts/relations/bakeoff-decisions.ts scan <path>...    counts key-like strings in files
 *
 * The key is read from the gitignored `.env` at runtime by the spike's `readApiKey` (only `run` reads
 * it; `--env-file` names another checkout's file, as a worktree has none) and stays in that module's
 * client: it is never printed, logged, written, passed in an argument or put in the environment.
 * `scan` checks files for the key and for key-like strings and prints counts only.
 */
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";

import { loadFrozen, repositoryRoot } from "../spikes/reranker/dataset.ts";
import { logit } from "../spikes/reranker/metrics.ts";
import { costUsd, readRaw, type RawRecord } from "../spikes/decisions/budget.ts";
import { DecisionsClient, decisionsModel } from "../spikes/decisions/client.ts";
import {
  buildRequest,
  designFingerprint,
  maxCandidatesPerRequest,
  type BuiltRequest
} from "../spikes/decisions/design.ts";
import { apiKeyVariable, readApiKey, redactSecrets } from "../spikes/decisions/env.ts";
import { chunk } from "../spikes/decisions/plan.ts";
import { predicatesOf } from "../spikes/decisions/scores.ts";
import { runJobs, type Job } from "../spikes/decisions/runner.ts";
import {
  bakeoffDirectory,
  decisionsScoresFile,
  defaultSourcePaths,
  labelFixtureSchema,
  pairKeyOf,
  readSpikeNotes,
  type LabelFixture
} from "./bakeoff-sets.ts";
import { noteTextsSchema, renderNoteText, sha256Hex, type StoredNote } from "./note-texts.ts";
import { pairScoresFormat, readPairsFile } from "./pair-scoring.ts";

export const decisionsTask = "T46b";

/** Candidate orders of the two shuffles (the spike's `orderSalt`). */
export const shuffleSalts = ["bakeoff-1", "bakeoff-2"] as const;

export const decisionsSetNames = ["fixture-lists", "pool-A", "rv6"] as const;
export type DecisionsSetName = (typeof decisionsSetNames)[number];

export interface DirectedPairRef {
  query: string;
  doc: string;
}

export interface DecisionSets {
  /** Unordered pairs (lower id first) with the sets each belongs to. */
  pairs: Array<{ lo: string; hi: string; sets: DecisionsSetName[] }>;
  /** Both directions of every pair, grouped by query note (queries in id order, candidates in id order). */
  byQuery: Map<string, string[]>;
  /** The text a note has in a request: Spike A's, title, idea and 400 body characters. */
  texts: Map<string, string>;
}

/**
 * The directed pairs of the Decisions run: pool A and R_v6 from the label set and the fixture's
 * candidate lists (T44), each in both directions. Only fixture and Spike A notes can enter: a note of
 * another library fails the build, so no golden or corpus text can reach the provider.
 */
export function buildDecisionSets(input: {
  labels: LabelFixture;
  fixtureLists: ReadonlyArray<readonly [string, string]>;
  fixtureNotes: ReadonlyMap<string, StoredNote>;
  spikeNotes: ReadonlyMap<string, StoredNote>;
}): DecisionSets {
  const sets = new Map<string, Set<DecisionsSetName>>();
  const ends = new Map<string, [string, string]>();
  const add = (a: string, b: string, set: DecisionsSetName): void => {
    const key = pairKeyOf(a, b);
    ends.set(key, a < b ? [a, b] : [b, a]);
    sets.set(key, (sets.get(key) ?? new Set()).add(set));
  };
  for (const [a, b] of input.fixtureLists) add(a, b, "fixture-lists");
  for (const item of input.labels.items) {
    if (item.kind !== "note") continue;
    const set = item.sets.includes("pool-A") ? "pool-A" : item.sets.includes("rv6") ? "rv6" : null;
    if (!set) continue;
    if (item.library !== "fixture" && item.library !== "spike-a")
      throw new Error(
        `Label ${item.pairId} is a ${item.library} pair: Decisions only reads synthetic text (D6).`
      );
    if (item.sets.includes("pool-A")) add(item.lo, item.hi, "pool-A");
    if (item.sets.includes("rv6")) add(item.lo, item.hi, "rv6");
  }
  const texts = new Map<string, string>();
  const byQuery = new Map<string, Set<string>>();
  const pairs: DecisionSets["pairs"] = [];
  for (const key of [...ends.keys()].sort()) {
    const [lo, hi] = ends.get(key)!;
    pairs.push({ lo, hi, sets: [...sets.get(key)!].sort() });
    for (const id of [lo, hi]) {
      const note = input.fixtureNotes.get(id) ?? input.spikeNotes.get(id);
      if (!note) throw new Error(`Note ${id} is neither a fixture nor a Spike A note.`);
      texts.set(id, renderNoteText(note, 400));
    }
    byQuery.set(lo, (byQuery.get(lo) ?? new Set()).add(hi));
    byQuery.set(hi, (byQuery.get(hi) ?? new Set()).add(lo));
  }
  return {
    pairs,
    byQuery: new Map(
      [...byQuery.entries()]
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([query, docs]) => [query, [...docs].sort()])
    ),
    texts
  };
}

export const runIdOf = (salt: string): string => `bakeoff-decisions__predicate__${salt}`;

/** One Decisions request per (query note, chunk of at most 20 candidates) for one shuffle. */
export function buildJobs(sets: DecisionSets, instruction: string, salt: string): Job[] {
  const jobs: Job[] = [];
  for (const [queryId, docs] of sets.byQuery) {
    chunk(docs, maxCandidatesPerRequest).forEach((candidateIds, index) => {
      const key = `bakeoff:${queryId}:${index}`;
      const built: BuiltRequest = buildRequest({
        key,
        instruction,
        query: { id: queryId, text: sets.texts.get(queryId)! },
        candidates: candidateIds.map((id) => ({ id, text: sets.texts.get(id)! })),
        config: "predicate",
        orderSalt: salt
      });
      jobs.push({
        key,
        kind: "bakeoff/predicate",
        meta: {
          stage: "bakeoff",
          config: "predicate",
          salt,
          queryId,
          candidateIds: built.candidateIds
        },
        request: built.request
      });
    });
  }
  return jobs;
}

// --- scores ----------------------------------------------------------------------------------------------

export interface DecisionScore {
  query: string;
  doc: string;
  /** Mean of the shuffles' predicate probabilities. */
  probability: number;
  /** `logit(probability)`, clamped as Spike A's log-odds are. */
  logOdds: number;
  shuffles: number[];
}

export interface DecisionScores {
  scores: DecisionScore[];
  /** Directed pairs no successful shuffle gave a probability for (refusals or failed requests). */
  missing: DirectedPairRef[];
  refusals: number;
}

/** The probabilities of the successful records of each shuffle, averaged per directed pair. */
export function scoresFromRecords(
  sets: DecisionSets,
  recordsByShuffle: ReadonlyArray<readonly RawRecord[]>
): DecisionScores {
  const probabilities = new Map<string, number[]>();
  let refusals = 0;
  for (const records of recordsByShuffle) {
    const latest = new Map<string, RawRecord>();
    for (const record of records) if (record.ok) latest.set(record.key, record);
    for (const record of latest.values())
      for (const { query, doc, probability } of predicatesOf(record)) {
        if (probability === null) {
          refusals += 1;
          continue;
        }
        const key = `${query}|${doc}`;
        probabilities.set(key, [...(probabilities.get(key) ?? []), probability]);
      }
  }
  const scores: DecisionScore[] = [];
  const missing: DirectedPairRef[] = [];
  for (const [query, docs] of sets.byQuery)
    for (const doc of docs) {
      const shuffles = probabilities.get(`${query}|${doc}`);
      if (!shuffles || shuffles.length === 0) {
        missing.push({ query, doc });
        continue;
      }
      const probability = shuffles.reduce((sum, value) => sum + value, 0) / shuffles.length;
      scores.push({ query, doc, probability, logOdds: logit(probability), shuffles });
    }
  return { scores, missing, refusals };
}

export interface Usage {
  requests: number;
  failedRequests: number;
  inputTokens: number;
  cachedTokens: number;
  outputTokens: number;
  reasoningTokens: number;
  usd: number;
}

export function usageOf(records: readonly RawRecord[]): Usage {
  const usage: Usage = {
    requests: records.length,
    failedRequests: records.filter((record) => !record.ok).length,
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    reasoningTokens: 0,
    usd: 0
  };
  for (const record of records) {
    usage.inputTokens += record.usage?.inputTokens ?? 0;
    usage.cachedTokens += record.usage?.cachedTokens ?? 0;
    usage.outputTokens += record.usage?.outputTokens ?? 0;
    usage.reasoningTokens += record.usage?.reasoningTokens ?? 0;
  }
  usage.usd = costUsd(usage.inputTokens);
  return usage;
}

// --- secrets scan ----------------------------------------------------------------------------------------

export interface ScanReport {
  files: number;
  /** Files holding the key itself (never the key). */
  keyHits: string[];
  /** Files holding a string shaped like a key or an authorization header value. */
  keyShapedHits: string[];
}

async function filesUnder(path: string): Promise<string[]> {
  const info = await stat(path);
  if (!info.isDirectory()) return [path];
  const names = await readdir(path);
  return (await Promise.all(names.map((name) => filesUnder(join(path, name))))).flat();
}

/** Looks for the secret and for key-shaped strings in files; reports file names and counts only. */
export async function scanForSecrets(
  paths: readonly string[],
  secrets: readonly string[]
): Promise<ScanReport> {
  const report: ScanReport = { files: 0, keyHits: [], keyShapedHits: [] };
  for (const root of paths)
    for (const file of await filesUnder(root)) {
      const text = (await readFile(file)).toString("utf8");
      report.files += 1;
      if (secrets.some((secret) => secret.length >= 8 && text.includes(secret)))
        report.keyHits.push(file);
      // `redactSecrets` rewrites exactly the shapes of a key and of an authorization header value.
      if (redactSecrets(text) !== text) report.keyShapedHits.push(file);
    }
  return report;
}

// --- commands --------------------------------------------------------------------------------------------

export async function loadDecisionSets(): Promise<{
  sets: DecisionSets;
  hashes: Record<string, string>;
}> {
  const labelsText = await readFile(defaultSourcePaths.labels, "utf8");
  const labels = labelFixtureSchema.parse(JSON.parse(labelsText));
  const fixturePairs = await readPairsFile(defaultSourcePaths.fixturePairs);
  const textsBytes = await readFile(defaultSourcePaths.texts.fixture);
  const fixtureNotes = new Map(
    noteTextsSchema.parse(JSON.parse(textsBytes.toString("utf8"))).notes.map((n) => [n.id, n])
  );
  const spike = await readSpikeNotes(
    defaultSourcePaths.spikeDataset,
    defaultSourcePaths.benchmarkDirectory
  );
  return {
    sets: buildDecisionSets({
      labels,
      fixtureLists: fixturePairs.file.pairs,
      fixtureNotes,
      spikeNotes: spike.notes
    }),
    hashes: {
      labels: sha256Hex(labelsText),
      fixturePairs: fixturePairs.sha256,
      fixtureTexts: sha256Hex(textsBytes),
      spikeDataset: spike.datasetSha256
    }
  };
}

function plan(sets: DecisionSets, instruction: string) {
  return shuffleSalts.map((salt) => {
    const jobs = buildJobs(sets, instruction, salt);
    return { salt, runId: runIdOf(salt), jobs };
  });
}

const optionsOf = (argv: readonly string[]) =>
  parseArgs({
    args: [...argv],
    options: {
      concurrency: { type: "string" },
      "env-file": { type: "string" },
      "out-dir": { type: "string" },
      "dry-run": { type: "boolean" },
      limit: { type: "string" }
    },
    allowPositionals: true,
    strict: true
  });

export async function main(argv: readonly string[]): Promise<void> {
  const { values, positionals } = optionsOf(argv);
  const [command, ...rest] = positionals;
  const outDir = resolve(values["out-dir"] ?? bakeoffDirectory);
  if (command === "scan") {
    const key = await readApiKey(values["env-file"] ? resolve(values["env-file"]) : undefined);
    const report = await scanForSecrets(
      rest.map((path) => resolve(path)),
      [key]
    );
    console.info(
      `scanned ${report.files} files: ${report.keyHits.length} hold the ${apiKeyVariable} value, ` +
        `${report.keyShapedHits.length} hold a key-shaped string`
    );
    for (const file of [...report.keyHits, ...report.keyShapedHits]) console.info(`  ${file}`);
    if (report.keyHits.length > 0 || report.keyShapedHits.length > 0) process.exitCode = 1;
    return;
  }
  const frozen = await loadFrozen();
  const { sets, hashes } = await loadDecisionSets();
  const planned = plan(sets, frozen.instruction);
  const counts = {
    notes: sets.texts.size,
    unorderedPairs: sets.pairs.length,
    directedPairs: 2 * sets.pairs.length,
    ...Object.fromEntries(
      decisionsSetNames.map((name) => [
        name,
        sets.pairs.filter((p) => p.sets.includes(name)).length
      ])
    )
  };
  if (command === "plan") {
    console.info(JSON.stringify(counts));
    for (const { runId, jobs } of planned) {
      const chars = jobs.reduce((sum, job) => sum + JSON.stringify(job.request).length, 0);
      console.info(`${runId}: ${jobs.length} requests, ${chars} body characters`);
    }
    return;
  }
  if (command === "run") {
    const concurrency = Number(values.concurrency ?? 4);
    const limit = values.limit ? Number(values.limit) : undefined;
    const dryRun = values["dry-run"] === true;
    const apiKey = dryRun
      ? "dry-run-without-a-key"
      : await readApiKey(values["env-file"] ? resolve(values["env-file"]) : undefined);
    const client = new DecisionsClient({ apiKey });
    for (const { runId, jobs } of planned) {
      const outcome = await runJobs({
        runId: limit ? `${runId}__limit${limit}` : runId,
        jobs: limit ? jobs.slice(0, limit) : jobs,
        client,
        concurrency,
        dryRun
      });
      console.info(
        `${runId}: sent ${outcome.sent}, failed ${outcome.failed}, skipped ${outcome.skipped}, ` +
          `run spend US$ ${outcome.runUsd.toFixed(4)}, wall ${(outcome.wallMs / 1000).toFixed(1)} s` +
          (outcome.stoppedEarly ? `, stopped: ${outcome.stoppedEarly}` : "")
      );
      if (outcome.stoppedEarly) {
        process.exitCode = 1;
        return;
      }
    }
    return;
  }
  if (command === "scores") {
    const recordsByShuffle = await Promise.all(planned.map(({ runId }) => readRaw(runId)));
    const result = scoresFromRecords(sets, recordsByShuffle);
    const usage = recordsByShuffle.map(usageOf);
    const plannedRequests = planned.map(({ jobs }) => jobs.length);
    const file = {
      format: pairScoresFormat,
      version: 1,
      decider: `openai-decisions:${decisionsModel} predicate, both directions, ${shuffleSalts.length} shuffles`,
      scale: "log-odds",
      scores: result.scores,
      run: {
        task: decisionsTask,
        set: "decisions",
        sets: Object.fromEntries(
          decisionsSetNames.map((name) => [
            name,
            sets.pairs.filter((pair) => pair.sets.includes(name)).map((pair) => [pair.lo, pair.hi])
          ])
        ),
        design: {
          model: decisionsModel,
          configuration: "predicate",
          instructionId: frozen.instructionId,
          instructionSha256: sha256Hex(frozen.instruction),
          fingerprint: designFingerprint(frozen.instruction),
          template: { id: "relation-pair-text-v1", bodyCharacters: 400 },
          maxCandidatesPerRequest,
          shuffles: [...shuffleSalts],
          runIds: planned.map(({ runId }) => runId)
        },
        inputs: { ...hashes, ...counts },
        requests: { planned: plannedRequests, usage },
        missingPairs: result.missing.length,
        refusals: result.refusals,
        liveTokens: usage.reduce(
          (total, entry) => ({
            input: total.input + entry.inputTokens,
            output: total.output + entry.outputTokens,
            reasoning: total.reasoning + entry.reasoningTokens,
            cached: total.cached + entry.cachedTokens
          }),
          { input: 0, output: 0, reasoning: 0, cached: 0 }
        ),
        usd: usage.reduce((total, entry) => total + entry.usd, 0),
        scoresSha256: sha256Hex(JSON.stringify(result.scores))
      }
    };
    const path = join(outDir, decisionsScoresFile);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify(file)}\n`);
    console.info(
      `${result.scores.length} directed scores (${result.missing.length} missing, ${result.refusals} ` +
        `refusals), ${file.run.liveTokens.input} input tokens, US$ ${file.run.usd.toFixed(4)} -> ${path}`
    );
    return;
  }
  console.info(
    "Usage: npx tsx scripts/relations/bakeoff-decisions.ts <plan|run|scores|scan> [options]\n" +
      `(repository ${repositoryRoot})`
  );
}

if (import.meta.main) {
  try {
    await main(process.argv.slice(2));
  } catch (error) {
    // The message may echo a provider error: scrub it before it reaches the terminal.
    console.error(
      `[bakeoff-decisions] ${redactSecrets(error instanceof Error ? error.message : String(error))}`
    );
    process.exitCode = 1;
  }
}
