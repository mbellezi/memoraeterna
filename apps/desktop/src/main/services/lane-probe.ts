import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import {
  aiLaneProbeConfigSchema,
  aiLaneProbeEnvironmentVariable,
  defaultAiLaneProbeConfig,
  redactSensitiveText,
  type AiLaneProbeConfig,
  type LaneSnapshot
} from "@app/ai";

import type { AiService, DefaultAiTaskResult } from "./ai-service.js";
import { laneProbePrompt } from "./lane-probe-fixture.js";

/**
 * DEV-only lane probe (`MEMORA_DEV_LANE_PROBE=<report path>`, F3 B5, T47b). It sends decide-sized
 * prompts on synthetic fixture text through the AI service at concurrency 1, 2 and 3, to learn how
 * many calls the owner's ChatGPT/Codex lane takes in parallel before it answers 429: the Codex
 * maximum is 3 only with no 429 at 3, and the gate-0 forecast is re-run with the measured gain.
 *
 * It spends about 40 calls (about 60k tokens) of the owner's quota, so it goes up one level at a
 * time and stops at the first level that sees a 429 or a failed call. It is refused when packaged,
 * with a cassette or another measurement run, and for a report outside `<workspace>/.cache`. The
 * job supervisor stays stopped while it runs (the caller treats it like a verdict-only run), so
 * nothing else uses the lane, and the app quits when it ends.
 */

export const laneProbeKnob = aiLaneProbeEnvironmentVariable;

/** The operation the probe's calls state; it has no route of its own, so `reranking` decides. */
export const laneProbeOperation = "lane_probe";

/** Output tokens a probe call may produce: its answer is one short JSON object. */
const probeMaxOutputTokens = 256;

/** Other DEV knobs that change what a call does, which the probe would then measure instead. */
const conflictingKnobs = [
  "MEMORA_AI_CASSETTE",
  "MEMORA_LEGACY_WIPE",
  "MEMORA_PROFILE_RESET",
  "MEMORA_GOLDEN_RUN",
  "MEMORA_GOLDEN_SOURCE_PAIRS",
  "MEMORA_GOLDEN_RESET",
  "MEMORA_MATCHING_PILOT",
  "MEMORA_MATCHING_BENCHMARK",
  "MEMORA_FAKE_REMOTE",
  "MEMORA_SOAK",
  "MEMORA_DEV_EXPLAIN_PROBE"
] as const;

export type LaneProbeRefusalCode =
  "packaged" | "invalidReport" | "conflictingKnob" | "localRoute" | "unknownLane" | "narrowLane";

export class LaneProbeRefusal extends Error {
  public constructor(
    public readonly code: LaneProbeRefusalCode,
    message: string
  ) {
    super(message);
    this.name = "LaneProbeRefusal";
  }
}

/**
 * Reads the knob: the absolute path of the JSON report, or null when it is unset. Refused when
 * packaged, together with another DEV measurement knob, and for a path that is not a `.json` file
 * under `<workspaceRoot>/.cache`.
 */
export function readLaneProbeKnob(
  env: Readonly<Record<string, string | undefined>>,
  options: { isPackaged: boolean; workspaceRoot: string }
): string | null {
  const raw = env[laneProbeKnob]?.trim();
  if (!raw) return null;
  if (options.isPackaged)
    throw new LaneProbeRefusal("packaged", `${laneProbeKnob} is refused in packaged builds`);
  const conflict = conflictingKnobs.find((name) => env[name]?.trim());
  if (conflict)
    throw new LaneProbeRefusal("conflictingKnob", `${laneProbeKnob} is refused with ${conflict}`);
  const cache = resolve(options.workspaceRoot, ".cache");
  const path = resolve(options.workspaceRoot, raw);
  if (!path.startsWith(cache + sep) || !path.endsWith(".json"))
    throw new LaneProbeRefusal(
      "invalidReport",
      `${laneProbeKnob} must name a .json report under ${cache}`
    );
  return path;
}

/**
 * Whether the knob asks for a probe that may run: set, and not refused. The app then keeps its job
 * supervisor stopped, as nothing else may use the lane the probe measures.
 */
export function laneProbeRequested(
  env: Readonly<Record<string, string | undefined>>,
  options: { isPackaged: boolean; workspaceRoot: string }
): boolean {
  try {
    return readLaneProbeKnob(env, options) !== null;
  } catch {
    return false;
  }
}

/**
 * How the probe's calls divide between its levels: in proportion to the concurrency, each level
 * with at least one call per slot, and exactly `config.calls` in all (largest remainder).
 */
export function laneProbePlan(
  config: AiLaneProbeConfig
): Array<{ concurrency: number; calls: number }> {
  const slots = config.levels.reduce((sum, level) => sum + level, 0);
  const spare = config.calls - slots;
  const shares = config.levels.map((level) => {
    const exact = (spare * level) / slots;
    return { level, whole: Math.floor(exact), fraction: exact - Math.floor(exact) };
  });
  let left = spare - shares.reduce((sum, share) => sum + share.whole, 0);
  const byFraction = [...shares].sort((a, b) => b.fraction - a.fraction || b.level - a.level);
  for (const share of byFraction) {
    if (left <= 0) break;
    share.whole += 1;
    left -= 1;
  }
  return shares.map((share) => ({ concurrency: share.level, calls: share.level + share.whole }));
}

export interface LaneProbeLevelReport {
  concurrency: number;
  /** Calls planned for the level. */
  calls: number;
  /** Calls started: fewer than planned when the level stopped on its first failure. */
  attempted: number;
  ok: number;
  failed: number;
  /** Calls that needed more than one request to the provider. */
  retried: number;
  /** Rate limits (429s and stated resets) the lane observed during the level. */
  rateLimits: number;
  wallMs: number;
  /** Answered calls per minute of wall time; null when none was answered. */
  callsPerMinute: number | null;
  latencyMs: { p50: number | null; p95: number | null; max: number | null };
  inputTokens: number | null;
  outputTokens: number | null;
  /** Up to five distinct redacted error messages. */
  errors: string[];
}

export interface LaneProbeVerdict {
  /** The Codex lane maximum B5 supports: the highest level without a 429 or a failed call. */
  codexMax: number | null;
  /** Throughput of each clean level relative to concurrency 1. */
  gain: Record<string, number>;
  /** The concurrency the lane delivers at `codexMax` (its gain); null when unknown. */
  measuredC: number | null;
  /** Multiplies the forecast's R/c values, which assume c = 2: 2 / measuredC. */
  rOverCFactor: number | null;
  note: string;
}

export interface LaneProbeReport {
  version: "lane-probe-v1";
  startedAt: string;
  finishedAt: string;
  config: AiLaneProbeConfig;
  route: { profileId: string; providerId: string; modelId: string } | null;
  lane: { key: string; maximum: number } | null;
  levels: LaneProbeLevelReport[];
  stoppedAfter: { concurrency: number; reason: "rate_limited" | "failed" } | null;
  verdict: LaneProbeVerdict | null;
  /** Set when the probe could not measure; the levels it did measure are kept. */
  error?: string;
}

/** What the probe uses of the AI service. */
export type LaneProbeAi = Pick<AiService, "runDefaultTask" | "laneSnapshots">;

const percentile = (sorted: number[], fraction: number): number | null =>
  sorted.length === 0 ? null : sorted[Math.max(0, Math.ceil(fraction * sorted.length) - 1)]!;

/** Whether a level says the lane takes its concurrency: answers, no 429, no failed call. */
const cleanLevel = (level: LaneProbeLevelReport) =>
  level.ok > 0 && level.failed === 0 && level.rateLimits === 0;

/** The verdict of the levels measured: the Codex maximum and the gain the forecast needs. */
export function laneProbeVerdict(levels: readonly LaneProbeLevelReport[]): LaneProbeVerdict {
  let codexMax: number | null = null;
  for (const level of levels) {
    if (!cleanLevel(level)) break;
    codexMax = level.concurrency;
  }
  const base = levels.find((level) => level.concurrency === 1)?.callsPerMinute ?? null;
  const gain: Record<string, number> = {};
  for (const level of levels)
    if (base && level.callsPerMinute)
      gain[String(level.concurrency)] = Number((level.callsPerMinute / base).toFixed(2));
  const measuredC = codexMax === null ? null : (gain[String(codexMax)] ?? null);
  const rOverCFactor = measuredC ? Number((2 / measuredC).toFixed(2)) : null;
  const dirty = levels.find((level) => !cleanLevel(level));
  const note =
    codexMax === null
      ? "No level ran clean: keep the Codex maximum at 1 and read the errors."
      : dirty
        ? `Concurrency ${dirty.concurrency} saw ${dirty.rateLimits} rate limits and ${dirty.failed} failed calls: the Codex maximum is ${codexMax}.`
        : `No 429 and no failed call up to concurrency ${codexMax}: the Codex maximum can be ${codexMax}.`;
  return { codexMax, gain, measuredC, rOverCFactor, note };
}

interface Measurement {
  ai: LaneProbeAi;
  config?: AiLaneProbeConfig;
  /** Milliseconds on a monotonic clock; the wall clock by default. */
  now?: () => number;
}

/**
 * Runs the probe. Never throws: a refusal or an error ends the report with `error`, keeping the
 * levels measured so far.
 */
export async function measureLanes(options: Measurement): Promise<LaneProbeReport> {
  const { ai } = options;
  const now = options.now ?? Date.now;
  const config = aiLaneProbeConfigSchema.parse(options.config ?? defaultAiLaneProbeConfig);
  const report: LaneProbeReport = {
    version: "lane-probe-v1",
    startedAt: new Date().toISOString(),
    finishedAt: "",
    config,
    route: null,
    lane: null,
    levels: [],
    stoppedAfter: null,
    verdict: null
  };
  try {
    await probeLevels(ai, config, now, report);
  } catch (error) {
    report.error = redactSensitiveText(error).slice(0, 400);
  }
  // A probe that could not measure has no verdict: its last level is unfinished.
  report.verdict =
    report.error || report.levels.length === 0 ? null : laneProbeVerdict(report.levels);
  report.finishedAt = new Date().toISOString();
  return report;
}

async function probeLevels(
  ai: LaneProbeAi,
  config: AiLaneProbeConfig,
  now: () => number,
  report: LaneProbeReport
): Promise<void> {
  let lane: string | undefined;
  const rateLimits = () =>
    ai.laneSnapshots().find((snapshot) => snapshot.lane === lane)?.rateLimits ?? 0;
  let promptIndex = 0;
  for (const { concurrency, calls } of laneProbePlan(config)) {
    const level: LaneProbeLevelReport = {
      concurrency,
      calls,
      attempted: 0,
      ok: 0,
      failed: 0,
      retried: 0,
      rateLimits: 0,
      wallMs: 0,
      callsPerMinute: null,
      latencyMs: { p50: null, p95: null, max: null },
      inputTokens: null,
      outputTokens: null,
      errors: []
    };
    report.levels.push(level);
    const latencies: number[] = [];
    let halted = false;
    const call = async () => {
      const index = promptIndex++;
      level.attempted += 1;
      const started = now();
      try {
        const result = await ai.runDefaultTask(
          "reranking",
          laneProbePrompt(index),
          {
            operation: laneProbeOperation,
            stage: laneProbeOperation,
            origin: laneProbeOperation,
            priority: "P2",
            // A DEV probe the developer starts: audited, never refused by the budget.
            budgetClass: "user"
          },
          undefined,
          { maxOutputTokens: probeMaxOutputTokens }
        );
        if (!result) throw new Error("errors.ai.noCompatibleModel");
        requireCodexRoute(result);
        report.route ??= {
          profileId: result.profileId,
          providerId: result.providerId,
          modelId: result.modelId
        };
        level.ok += 1;
        if ((result.attempts ?? 1) > 1) level.retried += 1;
        if (result.inputTokens !== undefined)
          level.inputTokens = (level.inputTokens ?? 0) + result.inputTokens;
        if (result.outputTokens !== undefined)
          level.outputTokens = (level.outputTokens ?? 0) + result.outputTokens;
      } catch (error) {
        if (error instanceof LaneProbeRefusal) throw error;
        level.failed += 1;
        halted = true;
        const message = redactSensitiveText(error).slice(0, 200);
        if (!level.errors.includes(message) && level.errors.length < 5) level.errors.push(message);
      }
      latencies.push(now() - started);
    };

    const levelStart = now();
    // A lane that does not exist yet has seen no rate limit.
    const limitsBefore = lane === undefined ? 0 : rateLimits();
    const rateLimited = () => lane !== undefined && rateLimits() > limitsBefore;
    const before = ai.laneSnapshots();
    // The first call of the probe runs alone: it creates the lane, which is then identified.
    let planned = calls;
    if (lane === undefined) {
      await call();
      planned -= 1;
      if (level.ok > 0) {
        lane = identifyLane(before, ai.laneSnapshots(), config);
        report.lane = laneOf(ai.laneSnapshots(), lane);
        halted = halted || rateLimited();
      }
    }
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (planned > 0 && !halted) {
          planned -= 1;
          await call();
          if (rateLimited()) halted = true;
        }
      })
    );
    level.wallMs = Math.round(now() - levelStart);
    level.rateLimits = lane === undefined ? 0 : rateLimits() - limitsBefore;
    level.callsPerMinute =
      level.ok > 0 && level.wallMs > 0
        ? Number(((level.ok * 60_000) / level.wallMs).toFixed(2))
        : null;
    const sorted = [...latencies].sort((a, b) => a - b);
    level.latencyMs = {
      p50: percentile(sorted, 0.5),
      p95: percentile(sorted, 0.95),
      max: sorted.at(-1) ?? null
    };
    if (level.rateLimits > 0 || level.failed > 0) {
      report.stoppedAfter = {
        concurrency,
        reason: level.rateLimits > 0 ? "rate_limited" : "failed"
      };
      return;
    }
  }
}

/** The probe measures the Codex lane: a call that did not run on a remote ChatGPT/Codex model says the route is wrong. */
function requireCodexRoute(result: DefaultAiTaskResult): void {
  if (result.runtime !== "remote" || result.providerId !== "openai-codex")
    throw new LaneProbeRefusal(
      "localRoute",
      `The reranking route ran on ${result.providerId} (${result.runtime}); route it to a ChatGPT/Codex profile first.`
    );
}

/**
 * The remote lane the first call used: the one lane that changed while it ran. The probe is the only
 * traffic of its app, so exactly one does; anything else is not measured.
 */
function identifyLane(
  before: readonly LaneSnapshot[],
  after: readonly LaneSnapshot[],
  config: AiLaneProbeConfig
): string {
  const changed = after.filter((snapshot) => {
    if (!snapshot.lane.startsWith("remote:")) return false;
    const earlier = before.find((candidate) => candidate.lane === snapshot.lane);
    return (
      !earlier ||
      earlier.successStreak !== snapshot.successStreak ||
      earlier.rateLimits !== snapshot.rateLimits
    );
  });
  if (changed.length !== 1)
    throw new LaneProbeRefusal(
      "unknownLane",
      `The first call changed ${changed.length} remote lanes; the probe needs a quiet app with one.`
    );
  const lane = changed[0]!;
  const top = Math.max(...config.levels);
  if (lane.maximum < top)
    throw new LaneProbeRefusal(
      "narrowLane",
      `The lane allows ${lane.maximum} calls at once and the probe tries ${top}: serial lanes (MEMORA_AI_LANES, a golden run)?`
    );
  return lane.lane;
}

const laneOf = (snapshots: readonly LaneSnapshot[], key: string) => {
  const snapshot = snapshots.find((candidate) => candidate.lane === key);
  return snapshot ? { key, maximum: snapshot.maximum } : null;
};

export interface LaneProbeStartup {
  env: Readonly<Record<string, string | undefined>>;
  isPackaged: boolean;
  workspaceRoot: string;
  ai: LaneProbeAi;
  logger?: Pick<Console, "info" | "error">;
}

/**
 * Runs the probe the knob asks for and writes its report. `off` when the knob is unset, `refused`
 * when it may not run (nothing was sent), `failed` when the report carries an error, else `done`.
 */
export async function runLaneProbe(
  options: LaneProbeStartup
): Promise<"off" | "refused" | "done" | "failed"> {
  const logger = options.logger ?? console;
  let path: string | null;
  try {
    path = readLaneProbeKnob(options.env, options);
  } catch (error) {
    logger.error(`LANE_PROBE refused: ${error instanceof Error ? error.message : String(error)}`);
    return "refused";
  }
  if (path === null) return "off";
  const report = await measureLanes({ ai: options.ai });
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(report, null, 2)}\n`);
  const summary = report.verdict
    ? `codexMax=${report.verdict.codexMax} measuredC=${report.verdict.measuredC}`
    : "no level measured";
  if (report.error) logger.error(`LANE_PROBE failed: ${report.error} (${summary}); report ${path}`);
  else logger.info(`LANE_PROBE done: ${summary}; report ${path}`);
  return report.error ? "failed" : "done";
}
