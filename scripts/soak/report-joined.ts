/**
 * The joined report of a complement (docs/f4-decisions.md D38a, owner 2026-10-30): a 7-day run that
 * a harness predicate stopped, and the tail that ran the rest of the same plan on a clone of its
 * profile (`soak7-tail`: tail minute = plan minute - shift, from the stopped run's last executed
 * plan minute T0). Each segment is analysed on its own with the report's predicates; the joined
 * lines compose them as D38a says: per segment for swap, jobs and helper restarts (two processes, and
 * the wall-clock gap is no plan time), E1 per plan day, E3 per segment window, E2, E4 and E5 over
 * the union, the Codex tokens summed against the registered cap.
 *
 *   npm run soak:report -- <stopped run> --join <tail run> [--out <md>] [--json <json>]
 *
 * It writes `report-joined.md` and `report-joined.json` into the tail's folder (never the stopped
 * run's). The per-segment reports are attached in the JSON.
 */
import { buildTimeline } from "../../apps/desktop/src/main/services/dev/soak-driver.ts";
import { soakProfileSchema } from "../../apps/desktop/src/main/services/dev/soak-plan.ts";
import type {
  ActionRecord,
  GroundTruthRecord,
  LocalFaultRecord,
  SoakEvent
} from "../../apps/desktop/src/main/services/dev/soak-records.ts";
import {
  codexRows,
  computeE1,
  computeE3,
  computeE5,
  e1CheckOf,
  e2Check,
  e3CheckOf,
  e5CheckOf,
  injectionCheck,
  loadCheck,
  predicateVersions,
  type E1Result,
  type E5Result
} from "./report-f4.ts";
import {
  analyzeRun,
  injectedJobFailures,
  injectedRows,
  ownRun,
  type Check,
  type CheckStatus,
  type LoadedRun,
  type SoakReport
} from "./report.ts";

const minute = 60_000;
const hour = 60 * minute;
const day = 24 * hour;
const toMs = (iso: string) => Date.parse(iso);
/** The local faults keep their own period in a tail (no offset field, D1): not plan-shifted. */
const localActionKinds: ReadonlySet<string> = new Set(["mlx_kill", "gguf_abort"]);
/** The predicates D38 found wrong and D38a fixed under scripts/soak, printed in the header. */
const fixedPredicates = ["swap", "e4", "jobs"] as const;

/** A joined report the inputs cannot make (exit 1): the reasons, one a line. */
export class JoinRefusal extends Error {
  public constructor(public readonly problems: string[]) {
    super(`the two runs cannot be joined:\n${problems.map((line) => `- ${line}`).join("\n")}`);
  }
}

export interface JoinedSegment {
  label: string;
  run: string;
  profile: string;
  seed: number;
  startedAt: string;
  endedAt: string | null;
  endReason: string | null;
  hours: number;
  /** Plan minute of the segment's minute 0 (0 for the stopped run, the shift for the tail). */
  planOffsetMinutes: number;
  /** The windows that opened in the segment, by id. */
  windows: string[];
  report: SoakReport;
}

export interface JoinedReport {
  run: string;
  generatedAt: string;
  verdict: "pass" | "review" | "fail";
  plan: {
    /** The stopped run's last executed plan minute. */
    t0Minute: number;
    /** Tail minute = plan minute - shift. */
    shiftMinutes: number;
    plannedHours: number;
    /** Plan time the two segments ran: the stopped run to T0, the tail after its warm-up. */
    coveredHours: number;
    /** Wall-clock time between the stopped run's end and the tail's start (no plan time). */
    gapHours: number;
  };
  notes: string[];
  segments: JoinedSegment[];
  checks: Check[];
  tables: {
    exposure: Array<Record<string, string | number>>;
    e3: Array<Record<string, string | number>>;
    injection: Array<Record<string, string | number>>;
    tokens: Array<Record<string, string | number>>;
    load: Array<Record<string, string | number>>;
    p0: Array<Record<string, string | number>>;
    failureAudit: Array<Record<string, string | number | null>>;
  };
  predicates: Record<string, number>;
}

const truthsOf = (run: LoadedRun) =>
  run.events.filter((event): event is GroundTruthRecord => event.type === "ground_truth");
const actionsOf = (run: LoadedRun) =>
  run.events.filter((event): event is ActionRecord => event.type === "action");
const localsOf = (run: LoadedRun) =>
  run.events.filter((event): event is LocalFaultRecord => event.type === "local");
const endOf = (run: LoadedRun) =>
  run.meta.endedAt
    ? toMs(run.meta.endedAt)
    : Math.max(toMs(run.meta.startedAt), ...run.samples.map((sample) => toMs(sample.at)));
const planOf = (run: LoadedRun) => run.meta.plan as Record<string, unknown> | null | undefined;
const worstOf = (statuses: readonly CheckStatus[]): CheckStatus =>
  statuses.includes("fail")
    ? "fail"
    : statuses.includes("review")
      ? "review"
      : statuses.includes("pass")
        ? "pass"
        : "n/a";
const num = (check: Check | undefined, key: string) => {
  const value = check?.data?.[key];
  return typeof value === "number" ? value : 0;
};
const pct = (part: number, whole: number) =>
  whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(2)} %`;

/**
 * The shift and T0 of a stopped run and its tail, and every reason they cannot be joined: the
 * same writer, the stopped run's plan (`soak7`) with every tail window at one shift of its own
 * window of the same id, nothing of the tail at or before T0, ids unique across the two, and the
 * plan covered.
 */
export function joinPlan(
  first: LoadedRun,
  tail: LoadedRun
): { shiftMinutes: number; t0Minute: number; problems: string[] } {
  const problems: string[] = [];
  if (!first.meta.f4 || !tail.meta.f4) problems.push("both runs must be 7-day F4 runs (meta.f4)");
  if (!first.meta.endReason) problems.push(`${first.meta.run} has not ended (meta endReason)`);
  if (!tail.meta.endReason)
    problems.push(
      `${tail.meta.run} has not ended (meta endReason): read its --status while it runs`
    );
  if (first.meta.realWriter?.providerConfigId !== tail.meta.realWriter?.providerConfigId)
    problems.push(
      `the real writers differ (${first.meta.realWriter?.providerConfigId ?? "none"} and ${tail.meta.realWriter?.providerConfigId ?? "none"})`
    );
  if (first.meta.profile !== "soak7")
    problems.push(`the stopped run's plan is ${first.meta.profile}, not soak7`);
  const tailPlan = planOf(tail);
  const tailF4 = tailPlan?.f4 as { windows?: unknown } | undefined;
  if (typeof tailPlan?.description !== "string" || !Array.isArray(tailF4?.windows))
    problems.push(`${tail.meta.run}'s meta does not record its plan (description and windows)`);
  // The shift: each tail window starts at its plan window's start less the shift.
  const planned = new Map((first.meta.f4?.windows ?? []).map((window) => [window.id, window]));
  const tailWindows = tail.meta.f4?.windows ?? [];
  const shifts = new Set<number>();
  for (const window of tailWindows) {
    const own = planned.get(window.id);
    if (!own) problems.push(`the tail's window ${window.id} is not in the stopped run's plan`);
    else shifts.add(own.startMinute - window.startMinute);
  }
  if (tailWindows.length === 0) problems.push("the tail has no window to derive its shift from");
  if (shifts.size > 1)
    problems.push(`the tail's windows are shifted unequally (${[...shifts].join(", ")} min)`);
  const shiftMinutes = shifts.size === 1 ? [...shifts][0]! : Number.NaN;
  // T0: the stopped run's last executed plan minute (its last action's schedule).
  const firstStart = toMs(first.meta.startedAt);
  const t0Minute = Math.max(
    0,
    ...actionsOf(first).map((action) => (toMs(action.scheduledAt) - firstStart) / minute)
  );
  if (Number.isFinite(shiftMinutes)) {
    for (const window of tailWindows)
      if (window.startMinute + shiftMinutes <= t0Minute)
        problems.push(
          `the tail's window ${window.id} starts at plan minute ${window.startMinute + shiftMinutes}, not after T0 ${t0Minute}`
        );
    const tailStart = toMs(tail.meta.startedAt);
    const early = actionsOf(tail).filter(
      (action) =>
        !localActionKinds.has(action.kind) &&
        (toMs(action.scheduledAt) - tailStart) / minute + shiftMinutes <= t0Minute
    );
    if (early.length > 0)
      problems.push(
        `${early.length} tail action(s) ran at or before T0 ${t0Minute} (the first: ${early[0]!.kind} #${early[0]!.index})`
      );
    const covered = shiftMinutes + tail.meta.durationMs / minute;
    if (covered < first.meta.durationMs / minute)
      problems.push(
        `the plan is not covered: ${shiftMinutes} + ${tail.meta.durationMs / minute} min < ${first.meta.durationMs / minute} min`
      );
  }
  // Window and expectation ids are unique across the two segments.
  const ids = (run: LoadedRun) => new Set(truthsOf(run).map((truth) => truth.id));
  const firstIds = ids(first);
  const shared = [...ids(tail)].filter((id) => firstIds.has(id));
  if (shared.length > 0)
    problems.push(`window or expectation ids in both segments: ${shared.slice(0, 6).join(", ")}`);
  return { shiftMinutes, t0Minute, problems };
}

/** The windows that opened in a run (their ground-truth start), by id. */
const openedWindows = (run: LoadedRun) =>
  truthsOf(run)
    .filter((truth) => truth.phase === "start" && !truth.id.includes("#"))
    .map((truth) => truth.id);

/** A window the stop lifted before its planned end: how much of it did not run. */
function liftedWindows(run: LoadedRun): string[] {
  const start = toMs(run.meta.startedAt);
  const planned = new Map((run.meta.f4?.windows ?? []).map((window) => [window.id, window]));
  return truthsOf(run)
    .filter((truth) => truth.phase === "end" && !truth.id.includes("#") && planned.has(truth.id))
    .flatMap((truth) => {
      const window = planned.get(truth.id)!;
      const endedAt = (toMs(truth.at) - start) / minute;
      const plannedEnd = window.startMinute + window.durationMinutes;
      return plannedEnd - endedAt > 1
        ? [
            `${truth.id} was lifted at plan minute ${Math.round(endedAt)} instead of ${plannedEnd} (${Math.round(plannedEnd - endedAt)} min not run)`
          ]
        : [];
    });
}

/** The local faults the plan holds over its whole duration, and what each segment injected. */
function localFaultLine(first: LoadedRun, tail: LoadedRun): string {
  const parsed = soakProfileSchema.safeParse(first.meta.plan);
  const plannedOf = (kind: string) =>
    parsed.success
      ? String(buildTimeline(parsed.data).filter((entry) => entry.kind === kind).length)
      : "?";
  const kills = (run: LoadedRun) =>
    localsOf(run).filter((fault) => fault.kind === "mlx_kill" && fault.detail.killed === true)
      .length;
  const aborts = (run: LoadedRun) =>
    localsOf(run).filter((fault) => fault.kind === "gguf_abort" && fault.detail.stage === "armed")
      .length;
  return `Local faults keep their own period in the tail (phase shifted, D1): helper kills ${kills(first)} + ${kills(tail)} = ${kills(first) + kills(tail)} of ${plannedOf("mlx_kill")} planned, GGUF aborts ${aborts(first)} + ${aborts(tail)} = ${aborts(first) + aborts(tail)} of ${plannedOf("gguf_abort")}; helper restarts are checked per segment.`;
}

/** A segment's check by id. */
const checkOf = (report: SoakReport, id: string) => report.checks.find((check) => check.id === id);

/** A line whose segments are judged apart: the worst status, each segment's value and details. */
function perSegment(
  id: string,
  segments: readonly JoinedSegment[],
  value?: (checks: Array<Check | undefined>) => string
): Check {
  const checks = segments.map((segment) => checkOf(segment.report, id));
  const known = checks.find((check) => check !== undefined);
  return {
    id,
    title: known?.title ?? id,
    bar: `${known?.bar ?? ""} (each segment on its own)`,
    status: worstOf(checks.map((check) => check?.status ?? "n/a")),
    value:
      value?.(checks) ??
      segments
        .map((segment, index) => `${segment.label}: ${checks[index]?.value ?? "not run"}`)
        .join("; "),
    details: segments.flatMap((segment, index) =>
      (checks[index]?.details ?? []).map((detail) => `${segment.label}: ${detail}`)
    )
  };
}

function pastDeadlineJoined(segments: readonly JoinedSegment[]): Check {
  const checks = segments.map((segment) => checkOf(segment.report, "past-deadline"));
  const sum = (key: string) => checks.reduce((total, check) => total + num(check, key), 0);
  return {
    ...perSegment("past-deadline", segments),
    bar: checks[0]?.bar ?? "",
    value: `${sum("audited")} audited, ${sum("watchdog")} by the watchdog, ${sum("noDeadline")} without a deadline (of ${sum("calls")} calls)`
  };
}

/** The repair rate over the union: each class's counted and set-aside calls and repairs summed. */
function repairsJoined(segments: readonly JoinedSegment[]): Check {
  const checks = segments.map((segment) => checkOf(segment.report, "repairs"));
  const totals = new Map<string, number>();
  for (const check of checks)
    for (const [key, value] of Object.entries(check?.data ?? {}))
      if (typeof value === "number") totals.set(key, (totals.get(key) ?? 0) + value);
  const classes = [
    ...new Set(
      [...totals.keys()]
        .filter((key) => key.startsWith("counted.") || key.startsWith("apart."))
        .map((key) => key.split(".").slice(1, -1).join("."))
    )
  ].sort();
  const of = (side: "counted" | "apart", what: "calls" | "repairs") =>
    classes.reduce((total, name) => total + (totals.get(`${side}.${name}.${what}`) ?? 0), 0);
  const calls = of("counted", "calls");
  const repairs = of("counted", "repairs");
  const unconstrained = totals.get("unconstrained") ?? 0;
  const status: CheckStatus =
    calls === 0 ? "review" : repairs / calls <= 0.02 && unconstrained === 0 ? "pass" : "fail";
  return {
    id: "repairs",
    title: checks[0]?.title ?? "Repairs (D35)",
    bar: `${checks[0]?.bar ?? ""} (over the union of the segments)`,
    status,
    value: `${repairs} of ${calls} = ${pct(repairs, calls)} counted; set aside by decision 31a: ${of("apart", "calls")} local writer call(s), ${of("apart", "repairs")} repair(s) = ${pct(of("apart", "repairs"), of("apart", "calls"))} (information)`,
    details: classes.map(
      (name) =>
        `${name}: counted ${totals.get(`counted.${name}.repairs`) ?? 0} of ${totals.get(`counted.${name}.calls`) ?? 0}; set aside ${totals.get(`apart.${name}.repairs`) ?? 0} of ${totals.get(`apart.${name}.calls`) ?? 0}`
    )
  };
}

function jobsJoined(segments: readonly JoinedSegment[], id: string): Check {
  const checks = segments.map((segment) => checkOf(segment.report, id));
  const count = checks.reduce((total, check) => total + num(check, "count"), 0);
  const explained = checks.reduce((total, check) => total + num(check, "explained"), 0);
  return perSegment(id, segments, () =>
    id === "jobs-blocked"
      ? `${count} candidate(s), ${explained} explained`
      : id === "jobs-inactive"
        ? `${count} (limit ${Math.max(...checks.map((check) => num(check, "limitSeconds")))} s)`
        : `${count}`
  );
}

/** Swap per segment, each after its own warm-up: no 24 h window crosses the seam. */
export function swapJoined(segments: readonly JoinedSegment[]): Check {
  const checks = segments.map((segment) => checkOf(segment.report, "swap"));
  const worst = checks
    .map((check, index) => ({ check, segment: segments[index]! }))
    .filter(({ check }) => typeof check?.data?.worstMb === "number")
    .toSorted((a, b) => num(b.check, "worstMb") - num(a.check, "worstMb"))[0];
  return {
    ...perSegment("swap", segments),
    value: worst
      ? `worst 24 h ${num(worst.check, "worstMb").toFixed(1)} MB (${worst.segment.label}, from ${String(worst.check!.data!.worstFrom)}); after warm-up ${segments
          .map(
            (segment, index) =>
              `${segment.label} ${checks[index]?.data ? num(checks[index], "totalMb").toFixed(1) : "-"} MB`
          )
          .join(", ")} (information; no 24 h window crosses the seam)`
      : "pageouts were not readable after warm-up"
  };
}

function p0Joined(segments: readonly JoinedSegment[]): Check {
  const checks = segments.map((segment) => checkOf(segment.report, "p0-wait"));
  const sum = (key: string) => checks.reduce((total, check) => total + num(check, key), 0);
  return perSegment(
    "p0-wait",
    segments,
    () => `${sum("groups")} lane/class group(s) over the segments, ${sum("over")} over the bound`
  );
}

function helperJoined(segments: readonly JoinedSegment[]): Check {
  const checks = segments.map((segment) => checkOf(segment.report, "helper-restarts"));
  const sum = (key: string) => checks.reduce((total, check) => total + num(check, key), 0);
  return perSegment(
    "helper-restarts",
    segments,
    () =>
      `${sum("restarts")} restart(s) for ${sum("kills")} injected kill(s), checked per segment (${segments
        .map(
          (segment, index) =>
            `${segment.label} ${num(checks[index], "restarts")}/${num(checks[index], "kills")}`
        )
        .join(", ")})`
  );
}

/** R6 over the union: a fault kind exercised in either segment counts. */
function remoteDeadlinesJoined(segments: readonly JoinedSegment[]): Check {
  const checks = segments.map((segment) => checkOf(segment.report, "remote-deadlines"));
  const sum = (key: string) => checks.reduce((total, check) => total + num(check, key), 0);
  const firstByteMs = num(checks[0], "firstByteMs");
  const stallMs = num(checks[0], "stallMs");
  const problems: string[] = [];
  if (sum("lateOk") < sum("late"))
    problems.push(
      `${sum("late") - sum("lateOk")} of ${sum("late")} late first bytes did not end at the ${firstByteMs} ms bound`
    );
  if (sum("stallOk") < sum("stalled"))
    problems.push(
      `${sum("stalled") - sum("stallOk")} of ${sum("stalled")} stalls did not end at the ${stallMs} ms bound`
    );
  if (sum("codexWire") === 0 || sum("codexAudited") === 0)
    problems.push("no Codex-wire call ran through the Codex adapter");
  if (sum("remoteOtherTotal") > 0)
    problems.push(
      `${sum("remoteOtherTotal")} remote call(s) carry a total deadline that is not the remote one`
    );
  const unobserved = sum("late") === 0 || sum("stalled") === 0;
  return {
    id: "remote-deadlines",
    title: checks[0]?.title ?? "Remote deadlines exercised (R6)",
    bar: `${checks[0]?.bar ?? ""} (over the union of the segments)`,
    status: problems.length > 0 ? "fail" : unobserved ? "review" : "pass",
    value: `first byte: ${sum("lateOk")}/${sum("late")} at ${firstByteMs} ms; stall: ${sum("stallOk")}/${sum("stalled")} at ${stallMs} ms; Codex-wire calls ${sum("codexWire")} (${sum("codexAudited")} audited); remote totals ${sum("remote") - sum("remoteOtherTotal")}/${sum("remote")}`,
    details: [
      ...problems,
      ...(unobserved && problems.length === 0
        ? ["A fault kind was never injected in either segment: nothing to check for it."]
        : [])
    ]
  };
}

/** E4: each part from the segment that exercised it; a part failed in either segment fails. */
export function e4Joined(segments: readonly JoinedSegment[]): Check {
  const checks = segments.map((segment) => checkOf(segment.report, "e4-cap"));
  const part = (key: "a" | "b" | "c"): CheckStatus => {
    const statuses = checks.map((check) => (check?.data?.[key] ?? "n/a") as CheckStatus);
    return statuses.includes("fail")
      ? "fail"
      : statuses.includes("pass")
        ? "pass"
        : statuses.includes("review")
          ? "review"
          : "n/a";
  };
  const parts = [part("a"), part("b"), part("c")];
  return {
    ...perSegment("e4-cap", segments),
    bar: `${checks[0]?.bar ?? ""} (each part from the segment that exercised it)`,
    status: parts.includes("fail")
      ? "fail"
      : parts.includes("review") || parts.every((entry) => entry === "n/a")
        ? "review"
        : "pass",
    value: parts.map((entry, index) => `${"abc"[index]}: ${entry}`).join(", ")
  };
}

/** E5 over the union: the segments' comparisons summed, their misses and gaps listed together. */
export function mergeE5(results: readonly E5Result[]): E5Result {
  const sum = (pick: (result: E5Result) => number) =>
    results.reduce((total, result) => total + pick(result), 0);
  return {
    laneFaults: results.flatMap((result) => result.laneFaults),
    laneFaultChecks: sum((result) => result.laneFaultChecks),
    notExercised: results.flatMap((result) => result.notExercised),
    checked: sum((result) => result.checked),
    matched: sum((result) => result.matched),
    unaffected: results.flatMap((result) => result.unaffected),
    classMismatches: results.flatMap((result) => result.classMismatches),
    reasonMismatches: sum((result) => result.reasonMismatches),
    recoveryMismatches: results.flatMap((result) => result.recoveryMismatches),
    fallbackSamples: sum((result) => result.fallbackSamples),
    samplesWithBlocked: sum((result) => result.samplesWithBlocked),
    samplesWithStatus: sum((result) => result.samplesWithStatus)
  };
}

/** E1's results by plan day: exposure added day by day, events and waits together. */
function mergeE1(results: readonly E1Result[]): E1Result {
  const exposure: Array<Record<string, number>> = [];
  for (const result of results)
    result.exposure.forEach((row, index) => {
      const into = (exposure[index] ??= {});
      for (const [worker, minutes] of Object.entries(row ?? {}))
        into[worker] = (into[worker] ?? 0) + minutes;
    });
  for (let index = 0; index < exposure.length; index += 1) exposure[index] ??= {};
  const waits = (pick: (result: E1Result) => Record<string, number[]>) => {
    const merged: Record<string, number[]> = {};
    for (const result of results)
      for (const [worker, values] of Object.entries(pick(result)))
        (merged[worker] ??= []).push(...values);
    return merged;
  };
  return {
    events: results.flatMap((result) => result.events),
    lockEvents: results.flatMap((result) => result.lockEvents),
    exposure,
    queueWaits: waits((result) => result.queueWaits),
    sameScopeWaits: waits((result) => result.sameScopeWaits),
    derivedWorkerStates: results.some((result) => result.derivedWorkerStates)
  };
}

/** The Codex tokens of both segments against the registered expectation and cap. */
function tokensJoined(
  first: LoadedRun,
  tail: LoadedRun,
  merged: LoadedRun,
  dayOf: (atMs: number) => number,
  planDays: number
): { check: Check; table: Array<Record<string, string | number>> } {
  const codex = first.meta.f4!.codex;
  const rows = codexRows(merged);
  const tokens = (row: (typeof rows)[number]) => (row.inputTokens ?? 0) + (row.outputTokens ?? 0);
  const total = rows.reduce((sum, row) => sum + tokens(row), 0);
  const unknown = rows.filter((row) => row.inputTokens === null || row.inputTokens === undefined);
  const lastCap = (run: LoadedRun) =>
    run.samples.toSorted((a, b) => toMs(a.at) - toMs(b.at)).at(-1)?.cap;
  const spent = [first, tail].map((run) => lastCap(run)?.spentTokens ?? 0);
  const spentTotal = spent.reduce((sum, value) => sum + value, 0);
  const exhausted = [first, tail].filter((run) =>
    run.events.some((event) => event.type === "cap" && event.action === "exhausted")
  );
  const drops = merged.events.filter(
    (event): event is Extract<SoakEvent, { type: "drop_step" }> => event.type === "drop_step"
  );
  const byDay = new Map<number, number>();
  for (const row of rows) {
    const index = dayOf(toMs(row.startedAt));
    byDay.set(index, (byDay.get(index) ?? 0) + tokens(row));
  }
  const table = [...byDay]
    .toSorted(([a], [b]) => a - b)
    .map(([index, value]) => ({
      "plan day": index + 1,
      "Codex tokens": value,
      "planned a day": Math.round(codex.expected / Math.max(1, planDays))
    }));
  const status: CheckStatus =
    exhausted.length > 0 || spentTotal > codex.cap || total > codex.cap
      ? "fail"
      : drops.some((entry) => entry.step === 5)
        ? "review"
        : "pass";
  return {
    table,
    check: {
      id: "tokens",
      title: "Tokens and cap",
      bar: "the segments' harness spend summed stays under the registered cap; a segment that reached its own hard cap is inconclusive; drop steps are reported",
      status,
      value: `${total} tokens in ${rows.length} Codex call(s) (${unknown.length} without a count) against ${codex.expected} expected for the plan and a cap of ${codex.cap}; harness cap spent ${spent.join(" + ")} = ${spentTotal}; ${drops.length} drop step(s)`,
      details: [
        `${first.meta.run}: harness cap ${first.meta.f4!.codex.cap}, spent ${spent[0]}; ${tail.meta.run}: harness cap ${tail.meta.f4?.codex.cap ?? "-"}, spent ${spent[1]}`,
        ...drops.map(
          (entry) =>
            `drop step ${entry.step} at ${entry.at}: ${entry.note ?? ""} (${entry.spentTokens} spent + ${entry.projectedTokens} projected > ${entry.capTokens})`
        ),
        ...exhausted.map(
          (run) => `${run.meta.run} reached its hard cap: the run is inconclusive, not passed.`
        )
      ]
    }
  };
}

/** Joins a stopped run and its tail into one report (refuses with {@link JoinRefusal}). */
export function joinRuns(
  first: LoadedRun,
  tail: LoadedRun,
  options: { explanations?: Record<string, string>; now?: Date } = {}
): JoinedReport {
  const { shiftMinutes, t0Minute, problems } = joinPlan(first, tail);
  if (problems.length > 0) throw new JoinRefusal(problems);
  const firstStart = toMs(first.meta.startedAt);
  const tailStart = toMs(tail.meta.startedAt);
  const planMs = (at: number) =>
    at >= tailStart ? at - tailStart + shiftMinutes * minute : at - firstStart;
  const dayOf = (at: number) => Math.floor(planMs(at) / day);
  const coveredMinutes = shiftMinutes + (endOf(tail) - tailStart) / minute;
  const planDays = Math.floor(coveredMinutes / (day / minute));
  const reports = [first, tail].map((run) => analyzeRun(run, options));
  const segments: JoinedSegment[] = [first, tail].map((run, index) => ({
    label: index === 0 ? run.meta.run.split("-").slice(0, 2).join("-") : "tail",
    run: run.meta.run,
    profile: run.meta.profile,
    seed: run.meta.seed,
    startedAt: run.meta.startedAt,
    endedAt: run.meta.endedAt,
    endReason: run.meta.endReason,
    hours: reports[index]!.window.hours,
    planOffsetMinutes: index === 0 ? 0 : shiftMinutes,
    windows: openedWindows(run),
    report: reports[index]!
  }));

  // The union of the two runs' own records (E2, the injection ledger, the load ledger, tokens).
  const own = [ownRun(first), ownRun(tail)] as const;
  const injected = own.map((run) => injectedRows(run));
  const injectedJobs = own.map((run, index) => injectedJobFailures(run, injected[index]!));
  const context = {
    injected: new Map([...injected[0]!, ...injected[1]!]),
    injectedJobs: new Map([...injectedJobs[0]!, ...injectedJobs[1]!])
  };
  const merged: LoadedRun = {
    meta: first.meta,
    events: [...own[0].events, ...own[1].events],
    samples: [...own[0].samples, ...own[1].samples],
    rows: [...own[0].rows, ...own[1].rows],
    invalid: {}
  };

  // E1 by plan day; the tail's samples up to T0 (its warm-up) are r1's plan minutes, not again.
  const e1 = e1CheckOf(
    mergeE1([
      computeE1(own[0], { dayOf }),
      computeE1(own[1], {
        dayOf,
        exposureFromMs: tailStart + (t0Minute - shiftMinutes) * minute + 1
      })
    ]),
    planDays
  );
  // E3 per segment window, summed; what was created outside both windows is listed apart.
  const e3Parts = own.map((run, index) => computeE3(run, { injectedJobs: injectedJobs[index]! }));
  const e3 = e3CheckOf({
    rows: e3Parts.flatMap((part) => part.rows),
    outside: e3Parts.flatMap((part) => part.outside),
    windows: e3Parts.flatMap((part) => part.windows),
    short: e3Parts.every((part) => part.short)
  });
  const seam = new Map<string, number>();
  for (const row of e3Parts.flatMap((part) => part.outside))
    seam.set(row.kind, (seam.get(row.kind) ?? 0) + 1);
  e3.check.bar += " (each segment over its own window, summed)";
  e3.check.details.push(
    `Each segment's window: ${segments
      .map(
        (segment, index) =>
          `${segment.label} tasks created ${(own[index]!.meta.warmupMs / hour).toFixed(2)} h to ${Math.max(0, (endOf(own[index]!) - toMs(own[index]!.meta.startedAt) - day) / hour).toFixed(2)} h`
      )
      .join(", ")}.`,
    `Not measurable at the seam (created outside both windows: a warm-up, a segment's last 24 h, before the tail's start; information): ${
      [...seam]
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([kind, count]) => `${kind} ${count}`)
        .join(", ") || "none"
    }.`
  );
  const e5 = e5CheckOf(mergeE5(own.map((run) => computeE5(run))));
  e5.bar += " (over the union of the segments)";
  const e2 = e2Check(merged, context);
  e2.bar += " (over the union of the segments; an input seen in both counts once)";
  const injection = injectionCheck(merged);
  const tokens = tokensJoined(first, tail, merged, dayOf, planDays);
  const load = loadCheck(merged, { dayOf });

  const checks: Check[] = [
    pastDeadlineJoined(segments),
    repairsJoined(segments),
    jobsJoined(segments, "jobs-inactive"),
    jobsJoined(segments, "jobs-stuck"),
    jobsJoined(segments, "jobs-blocked"),
    swapJoined(segments),
    p0Joined(segments),
    perSegment("breaker", segments),
    helperJoined(segments),
    perSegment("failure-handling", segments),
    remoteDeadlinesJoined(segments),
    e1.check,
    e2,
    e3.check,
    e4Joined(segments),
    e5,
    injection.check,
    tokens.check,
    load.check
  ];
  // The audited sample: each segment's own draw, at most 50 together, in proportion.
  const audits = reports.map((report) => report.failureAudit);
  const audited = audits.reduce((sum, rows) => sum + rows.length, 0);
  const failureAudit = audits.flatMap((rows, index) =>
    rows
      .slice(0, audited <= 50 ? rows.length : Math.round((50 * rows.length) / audited))
      .map((row) => ({ segment: segments[index]!.label, ...row }))
  );
  const statuses = checks.map((check) => check.status);
  const gapHours = (tailStart - endOf(first)) / hour;
  const notes = [
    `T0 = plan minute ${t0Minute} (${segments[0]!.label}'s last executed action); tail minute = plan minute - ${shiftMinutes}; plan time covered ${(Math.min(t0Minute, (endOf(first) - firstStart) / minute) / 60 + (coveredMinutes - t0Minute) / 60).toFixed(2)} h of ${first.meta.durationMs / hour} h.`,
    `The wall-clock gap between the segments, ${gapHours.toFixed(2)} h, is no plan time: the app was closed.`,
    `Seeds: ${segments.map((segment) => `${segment.label} ${segment.seed}`).join(", ")} (a new seed in the tail, so the corpus order and the seeded picks do not repeat; injection draws and kill jitter differ from a single run).`,
    `${segments[0]!.label} ended by ${first.meta.endReason}; the harness predicates D38 found wrong are fixed and re-evaluated here: ${fixedPredicates.map((name) => `${name} v${predicateVersions[name]}`).join(", ")}.`,
    `Windows run: ${segments.map((segment) => `${segment.label} ${segment.windows.join(", ") || "none"}`).join("; ")}.`,
    ...liftedWindows(first).map((line) => `${segments[0]!.label}: ${line}.`),
    localFaultLine(first, tail)
  ];
  return {
    run: `${first.meta.run} + ${tail.meta.run}`,
    generatedAt: (options.now ?? new Date()).toISOString(),
    verdict: statuses.includes("fail") ? "fail" : statuses.includes("review") ? "review" : "pass",
    plan: {
      t0Minute,
      shiftMinutes,
      plannedHours: first.meta.durationMs / hour,
      coveredHours:
        Math.round(
          ((Math.min(t0Minute, (endOf(first) - firstStart) / minute) + coveredMinutes - t0Minute) /
            60) *
            100
        ) / 100,
      gapHours: Math.round(gapHours * 100) / 100
    },
    notes,
    segments,
    checks,
    tables: {
      exposure: e1.table,
      e3: e3.table,
      injection: injection.table,
      tokens: tokens.table,
      load: load.table,
      p0: segments.flatMap((segment) =>
        segment.report.tables.p0.map((row) => ({ segment: segment.label, ...row }))
      ),
      failureAudit
    },
    predicates: { ...predicateVersions }
  };
}

const mark: Record<CheckStatus, string> = {
  pass: "PASS",
  fail: "FAIL",
  review: "REVIEW",
  "n/a": "n/a"
};
const cell = (value: string | number | null) =>
  String(value ?? "-")
    .replace(/\|/gu, "\\|")
    .replace(/\s+/gu, " ");
function table(rows: ReadonlyArray<Record<string, string | number | null>>): string[] {
  if (rows.length === 0) return ["_None._", ""];
  const header = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  return [
    `| ${header.join(" | ")} |`,
    `| ${header.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${header.map((key) => cell(row[key] ?? null)).join(" | ")} |`),
    ""
  ];
}

/** The Markdown of a joined report. */
export function renderJoinedReport(report: JoinedReport): string {
  const lines = [
    `# Joined soak report: ${report.run}`,
    "",
    `A complement under D38a: ${report.segments.length} segments of one plan, ${report.plan.coveredHours} h of its ${report.plan.plannedHours} h. Generated ${report.generatedAt}.`,
    "",
    `**Verdict: ${mark[report.verdict]}**`,
    "",
    ...table(
      report.segments.map((segment) => ({
        segment: segment.label,
        run: segment.run,
        profile: segment.profile,
        "plan minute 0": segment.planOffsetMinutes,
        started: segment.startedAt,
        ended: segment.endedAt ?? "-",
        "ended by": segment.endReason ?? "-",
        hours: segment.hours,
        verdict: mark[segment.report.verdict]
      }))
    ),
    ...report.notes.map((note) => `- ${note}`),
    "",
    `Predicates evaluated: ${Object.entries(report.predicates)
      .map(([name, version]) => `${name} v${version}`)
      .join(", ")}. The per-segment reports are in the JSON (segments[].report).`,
    "",
    "## X6 and E1-E5 over the two segments",
    "",
    ...table(
      report.checks.map((check) => ({
        check: check.title,
        bar: check.bar,
        result: mark[check.status],
        value: check.value
      }))
    )
  ];
  for (const check of report.checks.filter((entry) => entry.details.length > 0))
    lines.push(`### ${check.title}`, "", ...check.details.map((detail) => `- ${detail}`), "");
  lines.push(
    "## E1 contention exposure (lane-minutes a plan day)",
    "",
    ...table(report.tables.exposure),
    "## E3 within 24 h, by kind and by blocker window",
    "",
    ...table(report.tables.e3),
    "## Injection ledger (Codex lane)",
    "",
    ...table(report.tables.injection),
    "## Codex tokens by plan day",
    "",
    ...table(report.tables.tokens),
    "## Load ledger by plan day",
    "",
    ...table(report.tables.load),
    "## P0 wait",
    "",
    ...table(report.tables.p0),
    "## Audited sample of non-injected failures",
    "",
    ...table(report.tables.failureAudit)
  );
  return lines.join("\n");
}
