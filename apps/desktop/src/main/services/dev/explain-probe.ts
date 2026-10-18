import { mkdir, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import { shownNoteRelationSql, type PgPool, type RelationExplanationWriter } from "@app/db";
import { isRelationUnrelated, isRelationVeto, type RelationExplainOutcome } from "@app/domain";

import type { AiService } from "../ai-service.js";
import { isMeasurementProfilePath, profilesDirectory } from "../profile-reset.js";
import { RelationExplanationService } from "../relation-explanation-service.js";

/**
 * DEV-only explanation probe (`MEMORA_DEV_EXPLAIN_PROBE=<report path>`, F3 T59). It opens relations
 * of the library the way the Note page does (the service the card asks, with a listener for the
 * streamed text), one after the other, and again, and measures what the owner waits for: the time to
 * the first text and to the validated explanation, and whether the second open makes no call.
 *
 * It spends the tokens of `MEMORA_DEV_EXPLAIN_PROBE_OPENS` explanations (10 by default, about 10k
 * tokens on a remote writer), writes the explanations it gets and withdraws the relations the writer
 * finds unrelated, so it runs only on a clone inside `<workspace>/.cache/profiles/`, never on the
 * owner's library. It is refused when packaged, outside such a clone, with a cassette or another
 * measurement run, and for a report outside `<workspace>/.cache`; a refusal leaves the app as it
 * was. The job supervisor stays stopped while it runs, so nothing else uses the writer, and the app
 * quits when it ends.
 */

export const explainProbeKnob = "MEMORA_DEV_EXPLAIN_PROBE";
export const explainProbeOpensKnob = "MEMORA_DEV_EXPLAIN_PROBE_OPENS";
export const explainProbeDefaultOpens = 10;
export const explainProbeMaxOpens = 50;

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
  "MEMORA_DEV_LANE_PROBE",
  "MEMORA_TYPER_CHECK",
  "MEMORA_RELATIONS_REMATCH",
  "MEMORA_GOLDEN_NOTE_PAIRS",
  "MEMORA_GOLDEN_TOPICS"
] as const;

export type ExplainProbeRefusalCode =
  "packaged" | "outsideProfiles" | "invalidReport" | "conflictingKnob" | "opens";

export class ExplainProbeRefusal extends Error {
  public constructor(
    public readonly code: ExplainProbeRefusalCode,
    message: string
  ) {
    super(message);
    this.name = "ExplainProbeRefusal";
  }
}

export interface ExplainProbeSettings {
  reportPath: string;
  opens: number;
}

type Env = Readonly<Record<string, string | undefined>>;

interface ExplainProbeEnvironment {
  isPackaged: boolean;
  workspaceRoot: string;
  /** The profile folder the app runs on: only a clone inside `.cache/profiles/` may be probed. */
  userDataPath: string;
}

/**
 * Reads the knobs: the absolute path of the JSON report and the number of relations to open, or
 * null when the probe is not asked for. Refused when packaged, on a profile that is not inside
 * `<workspaceRoot>/.cache/profiles/` (the probe writes explanations and withdraws relations),
 * together with another DEV measurement knob, for a path that is not a `.json` file under
 * `<workspaceRoot>/.cache` and for a count that is not 1 to 50.
 */
export function readExplainProbeKnob(
  env: Env,
  options: ExplainProbeEnvironment
): ExplainProbeSettings | null {
  const raw = env[explainProbeKnob]?.trim();
  if (!raw) return null;
  if (options.isPackaged)
    throw new ExplainProbeRefusal("packaged", `${explainProbeKnob} is refused in packaged builds`);
  const profiles = resolve(options.workspaceRoot, ...profilesDirectory);
  const inside = relative(profiles, resolve(options.userDataPath));
  if (inside === "" || inside.startsWith("..") || isAbsolute(inside))
    throw new ExplainProbeRefusal(
      "outsideProfiles",
      `${explainProbeKnob} only runs on a clone inside .cache/profiles/ (set MEMORA_USER_DATA_DIR)`
    );
  const conflict = conflictingKnobs.find((name) => env[name]?.trim());
  if (conflict)
    throw new ExplainProbeRefusal(
      "conflictingKnob",
      `${explainProbeKnob} is refused with ${conflict}`
    );
  const cache = resolve(options.workspaceRoot, ".cache");
  const reportPath = resolve(options.workspaceRoot, raw);
  if (!reportPath.startsWith(cache + sep) || !reportPath.endsWith(".json"))
    throw new ExplainProbeRefusal(
      "invalidReport",
      `${explainProbeKnob} must name a .json report under ${cache}`
    );
  const asked = env[explainProbeOpensKnob]?.trim();
  const opens = asked === undefined || asked === "" ? explainProbeDefaultOpens : Number(asked);
  if (!Number.isInteger(opens) || opens < 1 || opens > explainProbeMaxOpens)
    throw new ExplainProbeRefusal(
      "opens",
      `${explainProbeOpensKnob} must be a whole number from 1 to ${explainProbeMaxOpens}`
    );
  return { reportPath, opens };
}

/**
 * Whether the knob asks for a probe that may run: set, and not refused. The app then keeps its job
 * supervisor stopped, as nothing else may use the writer the probe measures.
 */
export function explainProbeRequested(env: Env, options: ExplainProbeEnvironment): boolean {
  try {
    return readExplainProbeKnob(env, options) !== null;
  } catch {
    return false;
  }
}

/** The value at rank ceil(p x n) of the sorted values (nearest rank); null without values. */
export function nearestRank(values: readonly number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil(p * sorted.length))) - 1]!;
}

export interface LatencySummary {
  count: number;
  p50: number | null;
  p95: number | null;
  max: number | null;
}

export function summarizeLatencies(values: readonly number[]): LatencySummary {
  const rounded = values.map((value) => Math.round(value));
  return {
    count: rounded.length,
    p50: nearestRank(rounded, 0.5),
    p95: nearestRank(rounded, 0.95),
    max: rounded.length ? Math.max(...rounded) : null
  };
}

export interface ExplainProbeOpen {
  relationId: string;
  outcome: "explained" | "vetoed" | "unrelated" | "none" | "failed";
  error?: string;
  /** Text left for the card before the validated explanation. */
  streamed: boolean;
  /** Messages the card received (the text so far, coalesced). */
  messages: number;
  /** From the open to the first text; null when none was streamed. */
  firstDeltaMs: number | null;
  /** From the open to the validated explanation (or the veto). */
  totalMs: number;
  characters: number;
  /** Model calls this open made. */
  calls: number;
}

export interface ExplainProbePass {
  opens: ExplainProbeOpen[];
  calls: number;
  inputTokens: number;
  outputTokens: number;
  /** Calls whose provider did not report tokens: those are unknown, not zero. */
  callsWithUnknownTokens: number;
  explained: number;
  vetoed: number;
  /** Relations the writer found unrelated that stay as they are (a human verdict). */
  unrelated: number;
  streamed: number;
  firstDeltaMs: LatencySummary;
  totalMs: LatencySummary;
}

export interface ExplainProbeReport {
  format: "explain-probe-v1";
  generatedAt: string;
  opens: number;
  writer: RelationExplanationWriter | null;
  firstOpen: ExplainProbePass;
  secondOpen: ExplainProbePass;
  /** The bar of T59: a second open of the same relations makes no call. */
  secondOpenMakesNoCall: boolean;
  error?: string;
}

/** What the probe counts of the model calls the service makes. */
export interface ExplainProbeMeter {
  calls: number;
  inputTokens: number;
  outputTokens: number;
  callsWithUnknownTokens: number;
}

type RunDefaultTask = AiService["runDefaultTask"];

/**
 * Counts the model calls of a service: the same function, so the call keeps the class, priority and
 * context its caller states. The tokens a provider did not report are unknown, not zero.
 */
export function metered(run: RunDefaultTask, meter: ExplainProbeMeter): RunDefaultTask {
  return async (...args) => {
    meter.calls += 1;
    const execution = await run(...args);
    if (execution?.inputTokens === undefined || execution.outputTokens === undefined)
      meter.callsWithUnknownTokens += 1;
    meter.inputTokens += execution?.inputTokens ?? 0;
    meter.outputTokens += execution?.outputTokens ?? 0;
    return execution;
  };
}

export interface ExplainProbeDeps {
  /** The relations to open, in order. */
  relationIds: readonly string[];
  /** The service a card asks, with the listener it gives for the streamed text. */
  explain: (
    relationId: string,
    onText: (text: string) => void
  ) => Promise<RelationExplainOutcome | null>;
  meter: ExplainProbeMeter;
  now?: () => number;
}

async function openOnce(
  deps: ExplainProbeDeps,
  relationId: string,
  now: () => number
): Promise<ExplainProbeOpen> {
  const before = deps.meter.calls;
  const started = now();
  let firstDeltaMs: number | null = null;
  let messages = 0;
  let characters = 0;
  const open = (
    outcome: ExplainProbeOpen["outcome"],
    fields: Partial<ExplainProbeOpen> = {}
  ): ExplainProbeOpen => ({
    relationId,
    outcome,
    streamed: messages > 0,
    messages,
    firstDeltaMs,
    totalMs: Math.round(now() - started),
    characters,
    calls: deps.meter.calls - before,
    ...fields
  });
  try {
    const result = await deps.explain(relationId, (text) => {
      // An empty message says the preview is void; it is not the first text.
      if (text.length === 0) return;
      messages += 1;
      if (firstDeltaMs === null) firstDeltaMs = Math.round(now() - started);
    });
    if (result === null) return open("none");
    if (isRelationVeto(result)) return open("vetoed");
    if (isRelationUnrelated(result)) return open("unrelated");
    characters = result.text.length;
    return open("explained", { characters });
  } catch (error) {
    return open("failed", { error: error instanceof Error ? error.message : String(error) });
  }
}

function summarizePass(
  opens: ExplainProbeOpen[],
  meter: ExplainProbeMeter,
  before: ExplainProbeMeter
) {
  const pass: ExplainProbePass = {
    opens,
    calls: meter.calls - before.calls,
    inputTokens: meter.inputTokens - before.inputTokens,
    outputTokens: meter.outputTokens - before.outputTokens,
    callsWithUnknownTokens: meter.callsWithUnknownTokens - before.callsWithUnknownTokens,
    explained: opens.filter((open) => open.outcome === "explained").length,
    vetoed: opens.filter((open) => open.outcome === "vetoed").length,
    unrelated: opens.filter((open) => open.outcome === "unrelated").length,
    streamed: opens.filter((open) => open.streamed).length,
    firstDeltaMs: summarizeLatencies(
      opens.flatMap((open) => (open.firstDeltaMs === null ? [] : [open.firstDeltaMs]))
    ),
    totalMs: summarizeLatencies(opens.map((open) => open.totalMs))
  };
  return pass;
}

/**
 * Opens every relation once, then every relation again, and reports both passes. A failed open is
 * recorded and the probe goes on; the second pass opens the same relations, so a relation the writer
 * found unrelated answers its verdict again with no call, and one that failed is tried again.
 */
export async function measureExplanations(
  deps: ExplainProbeDeps
): Promise<Pick<ExplainProbeReport, "firstOpen" | "secondOpen" | "secondOpenMakesNoCall">> {
  const now = deps.now ?? (() => performance.now());
  const snapshot = (): ExplainProbeMeter => ({ ...deps.meter });
  const run = async () => {
    const opens: ExplainProbeOpen[] = [];
    for (const relationId of deps.relationIds) opens.push(await openOnce(deps, relationId, now));
    return opens;
  };
  const beforeFirst = snapshot();
  const first = await run();
  const firstOpen = summarizePass(first, deps.meter, beforeFirst);
  const beforeSecond = snapshot();
  const second = await run();
  const secondOpen = summarizePass(second, deps.meter, beforeSecond);
  return { firstOpen, secondOpen, secondOpenMakesNoCall: secondOpen.calls === 0 };
}

/** Relations the Note page shows that have no explanation yet, in a fixed pseudo-random order. */
export async function pickRelationsToOpen(
  pool: Pick<PgPool, "query">,
  limit: number
): Promise<string[]> {
  const result = await pool.query<{ id: string }>(
    `select r.id
       from atomic_note_relations r
       join atomic_notes a on a.id = r.source_atomic_note_id
       join atomic_notes b on b.id = r.target_atomic_note_id
       left join atomic_note_relation_explanations x on x.relation_id = r.id
      where ${shownNoteRelationSql("r", ["a", "b"])} and x.relation_id is null
      order by md5(r.id::text)
      limit $1`,
    [limit]
  );
  return result.rows.map((row) => row.id);
}

export interface ExplainProbeStartup extends ExplainProbeEnvironment {
  env: Env;
  pool: PgPool;
  ai: Pick<AiService, "runDefaultTask">;
  getContentLanguage: () => Promise<string>;
  resolveWriter: () => Promise<RelationExplanationWriter | null>;
  logger?: Pick<Console, "info" | "error">;
  now?: () => Date;
}

/**
 * Runs the probe the knob asks for and writes its report. `off` when the knob is unset, `refused`
 * when it may not run (nothing was sent), `failed` when the report carries an error or a relation
 * could not be opened, else `done`.
 */
export async function runExplainProbe(
  options: ExplainProbeStartup
): Promise<"off" | "refused" | "done" | "failed"> {
  const logger = options.logger ?? console;
  let settings: ExplainProbeSettings | null;
  try {
    settings = readExplainProbeKnob(options.env, options);
  } catch (error) {
    logger.error(
      `EXPLAIN_PROBE refused: ${error instanceof Error ? error.message : String(error)}`
    );
    return "refused";
  }
  if (settings === null) return "off";
  // The folder may be a link out of the profiles (the read above only compares paths).
  if (!(await isMeasurementProfilePath(options.userDataPath, options.workspaceRoot))) {
    logger.error(
      `EXPLAIN_PROBE refused: ${explainProbeKnob} only runs on a clone inside .cache/profiles/`
    );
    return "refused";
  }
  const meter: ExplainProbeMeter = {
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    callsWithUnknownTokens: 0
  };
  // The service is the one a card asks; only its model calls are counted.
  const service = new RelationExplanationService({
    getPool: () => options.pool,
    ai: { runDefaultTask: metered(options.ai.runDefaultTask.bind(options.ai), meter) },
    getContentLanguage: options.getContentLanguage,
    resolveWriter: options.resolveWriter
  });
  let report: ExplainProbeReport;
  const empty = measureExplanationsOfNothing();
  try {
    const writer = await options.resolveWriter();
    const relationIds = await pickRelationsToOpen(options.pool, settings.opens);
    logger.info(`EXPLAIN_PROBE start: ${relationIds.length} relations`);
    const measured = await measureExplanations({
      relationIds,
      explain: (relationId, onText) => service.explain({ relationId }, onText),
      meter
    });
    const failed = [...measured.firstOpen.opens, ...measured.secondOpen.opens].some(
      (open) => open.outcome === "failed"
    );
    report = {
      format: "explain-probe-v1",
      generatedAt: (options.now ?? (() => new Date()))().toISOString(),
      opens: relationIds.length,
      writer,
      ...measured,
      ...(failed ? { error: "At least one relation could not be explained." } : {})
    };
  } catch (error) {
    report = {
      format: "explain-probe-v1",
      generatedAt: (options.now ?? (() => new Date()))().toISOString(),
      opens: 0,
      writer: null,
      ...empty,
      error: error instanceof Error ? error.message : String(error)
    };
  }
  await mkdir(dirname(settings.reportPath), { recursive: true });
  await writeFile(settings.reportPath, `${JSON.stringify(report, null, 2)}\n`);
  const first = report.firstOpen;
  const summary =
    `first-delta p50=${first.firstDeltaMs.p50} p95=${first.firstDeltaMs.p95} ms, ` +
    `total p50=${first.totalMs.p50} p95=${first.totalMs.p95} ms, ` +
    `second open calls=${report.secondOpen.calls}`;
  if (report.error)
    logger.error(
      `EXPLAIN_PROBE failed: ${report.error} (${summary}); report ${settings.reportPath}`
    );
  else logger.info(`EXPLAIN_PROBE done: ${summary}; report ${settings.reportPath}`);
  return report.error ? "failed" : "done";
}

function measureExplanationsOfNothing(): Pick<
  ExplainProbeReport,
  "firstOpen" | "secondOpen" | "secondOpenMakesNoCall"
> {
  const pass = (): ExplainProbePass => ({
    opens: [],
    calls: 0,
    inputTokens: 0,
    outputTokens: 0,
    callsWithUnknownTokens: 0,
    explained: 0,
    vetoed: 0,
    unrelated: 0,
    streamed: 0,
    firstDeltaMs: summarizeLatencies([]),
    totalMs: summarizeLatencies([])
  });
  return { firstOpen: pass(), secondOpen: pass(), secondOpenMakesNoCall: false };
}
