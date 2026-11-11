/**
 * The joined report of a complement (docs/f4-decisions.md D38a, owner 2026-10-30): a 7-day run that
 * a harness predicate stopped, and the tail or tails that ran the rest of the same plan, each on a
 * clone of the previous segment's profile (`soak7-tail`, `soak7-tail2`: tail minute = plan minute -
 * shift, from the previous segment's last executed plan minute T0). Each segment is analysed on its
 * own with the report's predicates; the joined lines compose them as D38a says: per segment for swap,
 * jobs and helper restarts (separate processes, and the wall-clock gaps are no plan time), E1 per
 * plan day, E3 per segment window, E2, E4 and E5 over the union, the Codex tokens summed against the
 * registered cap. A segment counts plan time from its T0 until the next segment's T0 (a tail that
 * ended early is clipped where the next one took over).
 *
 *   npm run soak:report -- <stopped run> --join <tail run> [--join <tail2 run>] [--out <md>] [--json <json>]
 *
 * It writes `report-joined.md` and `report-joined.json` into the last tail's folder (never an earlier
 * segment's). The per-segment reports are attached in the JSON.
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
    super(`the runs cannot be joined:\n${problems.map((line) => `- ${line}`).join("\n")}`);
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
  /** Plan minute of the segment's minute 0 (0 for the stopped run, the shift for a tail). */
  planOffsetMinutes: number;
  /** The plan minutes this segment counts: from its T0 (0 for the stopped run) to the next T0 or its end. */
  planFromMinute: number;
  planToMinute: number;
  /** The windows that opened in the segment, by id. */
  windows: string[];
  report: SoakReport;
}

export interface JoinedReport {
  run: string;
  generatedAt: string;
  verdict: "pass" | "review" | "fail";
  plan: {
    /** The stopped run's last executed plan minute (the first tail's T0). */
    t0Minute: number;
    /** First tail minute = plan minute - shift. */
    shiftMinutes: number;
    /** Each tail's T0 and shift, in order (the first equals t0Minute and shiftMinutes). */
    seams: Array<{ tail: string; t0Minute: number; shiftMinutes: number; gapHours: number }>;
    plannedHours: number;
    /** Plan time the segments ran: each from its T0 to the next segment's T0 or its end. */
    coveredHours: number;
    /** Wall-clock time between consecutive segments, summed (no plan time). */
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
const round2 = (value: number) => Math.round(value * 100) / 100;
const pct = (part: number, whole: number) =>
  whole === 0 ? "n/a" : `${((part / whole) * 100).toFixed(2)} %`;

const isTail = (index: number) => index > 0;
/**
 * A segment's last executed plan minute: its own actions shifted; a tail's local faults (own period)
 * left out. Null when it executed no plan action (a tail quit in its warm-up): no T0 to join after.
 */
function lastPlanMinute(run: LoadedRun, shiftMinutes: number, tail: boolean): number | null {
  const start = toMs(run.meta.startedAt);
  const minutes = actionsOf(run)
    .filter((action) => !tail || !localActionKinds.has(action.kind))
    .map((action) => (toMs(action.scheduledAt) - start) / minute + shiftMinutes);
  return minutes.length === 0 ? (tail ? null : 0) : Math.max(...minutes);
}

/**
 * The shift and T0 of each tail and every reason the segments cannot be joined: the same writer, the
 * stopped run's plan (`soak7`) with every tail window at one shift of its own window of the same id,
 * nothing of a tail at or before its T0 (the previous segment's last executed plan minute), ids unique
 * across the segments, and the plan covered by each tail's planned duration.
 */
export function joinPlans(
  first: LoadedRun,
  tails: readonly LoadedRun[]
): { seams: Array<{ shiftMinutes: number; t0Minute: number }>; problems: string[] } {
  const problems: string[] = [];
  if (tails.length === 0) problems.push("a joined report needs at least one tail");
  if (!first.meta.f4 || tails.some((tail) => !tail.meta.f4))
    problems.push("every run must be a 7-day F4 run (meta.f4)");
  if (!first.meta.endReason) problems.push(`${first.meta.run} has not ended (meta endReason)`);
  if (first.meta.profile !== "soak7")
    problems.push(`the stopped run's plan is ${first.meta.profile}, not soak7`);
  const planned = new Map((first.meta.f4?.windows ?? []).map((window) => [window.id, window]));
  const seams: Array<{ shiftMinutes: number; t0Minute: number }> = [];
  let previous = { run: first, shiftMinutes: 0, index: 0 };
  tails.forEach((tail, position) => {
    const index = position + 1;
    const name = tail.meta.run;
    const where = tails.length > 1 ? `${name}: ` : "";
    if (!tail.meta.endReason)
      problems.push(`${name} has not ended (meta endReason): read its --status while it runs`);
    if (first.meta.realWriter?.providerConfigId !== tail.meta.realWriter?.providerConfigId)
      problems.push(
        `${where}the real writers differ (${first.meta.realWriter?.providerConfigId ?? "none"} and ${tail.meta.realWriter?.providerConfigId ?? "none"})`
      );
    const tailPlan = planOf(tail);
    const tailF4 = tailPlan?.f4 as { windows?: unknown } | undefined;
    if (typeof tailPlan?.description !== "string" || !Array.isArray(tailF4?.windows))
      problems.push(`${name}'s meta does not record its plan (description and windows)`);
    // The shift: each tail window starts at its plan window's start less the shift.
    const tailWindows = tail.meta.f4?.windows ?? [];
    const shifts = new Set<number>();
    for (const window of tailWindows) {
      const own = planned.get(window.id);
      if (!own)
        problems.push(`${where}the tail's window ${window.id} is not in the stopped run's plan`);
      else shifts.add(own.startMinute - window.startMinute);
    }
    if (tailWindows.length === 0)
      problems.push(`${where}the tail has no window to derive its shift from`);
    if (shifts.size > 1)
      problems.push(
        `${where}the tail's windows are shifted unequally (${[...shifts].join(", ")} min)`
      );
    const shiftMinutes = shifts.size === 1 ? [...shifts][0]! : Number.NaN;
    // T0: the previous segment's last executed plan minute (its last action's schedule).
    const last = lastPlanMinute(previous.run, previous.shiftMinutes, isTail(previous.index));
    if (last === null)
      problems.push(
        `${previous.run.meta.run} executed no plan action: leave it out of the join (the next tail's T0 would be undefined)`
      );
    const t0Minute = last ?? Number.NaN;
    if (Number.isFinite(shiftMinutes) && Number.isFinite(t0Minute)) {
      // The tail's minute 0 must not come after T0: the plan minutes between would run in no segment.
      if (shiftMinutes > t0Minute)
        problems.push(
          `${where}the tail starts at plan minute ${shiftMinutes}, after T0 ${round2(t0Minute)}: plan minutes ${round2(t0Minute)}-${shiftMinutes} ran in no segment (a segment missing from --join?)`
        );
      for (const window of tailWindows)
        if (window.startMinute + shiftMinutes <= t0Minute)
          problems.push(
            `${where}the tail's window ${window.id} starts at plan minute ${window.startMinute + shiftMinutes}, not after T0 ${t0Minute}`
          );
      const tailStart = toMs(tail.meta.startedAt);
      const early = actionsOf(tail).filter(
        (action) =>
          !localActionKinds.has(action.kind) &&
          (toMs(action.scheduledAt) - tailStart) / minute + shiftMinutes <= t0Minute
      );
      if (early.length > 0)
        problems.push(
          `${where}${early.length} tail action(s) ran at or before T0 ${t0Minute} (the first: ${early[0]!.kind} #${early[0]!.index})`
        );
      const covered = shiftMinutes + tail.meta.durationMs / minute;
      if (covered < first.meta.durationMs / minute)
        problems.push(
          `${where}the plan is not covered: ${shiftMinutes} + ${tail.meta.durationMs / minute} min < ${first.meta.durationMs / minute} min`
        );
    }
    previous = { run: tail, shiftMinutes, index };
    seams.push({ shiftMinutes, t0Minute });
  });
  // Window and expectation ids are unique across the segments.
  const ids = (run: LoadedRun) => new Set(truthsOf(run).map((truth) => truth.id));
  const seen = ids(first);
  for (const tail of tails) {
    const own = ids(tail);
    const shared = [...own].filter((id) => seen.has(id));
    if (shared.length > 0)
      problems.push(`window or expectation ids in both segments: ${shared.slice(0, 6).join(", ")}`);
    for (const id of own) seen.add(id);
  }
  return { seams, problems };
}

/** {@link joinPlans} for a stopped run and one tail. */
export function joinPlan(
  first: LoadedRun,
  tail: LoadedRun
): { shiftMinutes: number; t0Minute: number; problems: string[] } {
  const { seams, problems } = joinPlans(first, [tail]);
  return { ...seams[0]!, problems };
}

/** The windows that opened in a run (their ground-truth start), by id. */
const openedWindows = (run: LoadedRun) =>
  truthsOf(run)
    .filter((truth) => truth.phase === "start" && !truth.id.includes("#"))
    .map((truth) => truth.id);

/** A window the stop lifted before its planned end: how much of it did not run, in plan minutes. */
function liftedWindows(run: LoadedRun, shiftMinutes = 0): string[] {
  const start = toMs(run.meta.startedAt);
  const planned = new Map((run.meta.f4?.windows ?? []).map((window) => [window.id, window]));
  return truthsOf(run)
    .filter((truth) => truth.phase === "end" && !truth.id.includes("#") && planned.has(truth.id))
    .flatMap((truth) => {
      const window = planned.get(truth.id)!;
      const endedAt = (toMs(truth.at) - start) / minute + shiftMinutes;
      const plannedEnd = window.startMinute + window.durationMinutes + shiftMinutes;
      return plannedEnd - endedAt > 1
        ? [
            `${truth.id} was lifted at plan minute ${Math.round(endedAt)} instead of ${plannedEnd} (${Math.round(plannedEnd - endedAt)} min not run)`
          ]
        : [];
    });
}

/** The local faults the plan holds over its whole duration, and what each segment injected. */
function localFaultLine(runs: readonly LoadedRun[]): string {
  const parsed = soakProfileSchema.safeParse(runs[0]!.meta.plan);
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
  const line = (count: (run: LoadedRun) => number) =>
    `${runs.map(count).join(" + ")} = ${runs.reduce((sum, run) => sum + count(run), 0)}`;
  return `Local faults keep their own period in a tail (phase shifted, D1): helper kills ${line(kills)} of ${plannedOf("mlx_kill")} planned, GGUF aborts ${line(aborts)} of ${plannedOf("gguf_abort")}; helper restarts are checked per segment.`;
}

/** The known limits a tail's plan records in its description ("Known D1 limits ..."), if any. */
function knownLimits(run: LoadedRun): string | null {
  const description = planOf(run)?.description;
  if (typeof description !== "string") return null;
  const at = description.indexOf("Known D1 limits");
  return at < 0 ? null : description.slice(at);
}

/** The plan's windows that start at or after the covered end: they never ran in any segment. */
function notRunWindows(first: LoadedRun, coveredToMinute: number): string[] {
  const missed = (first.meta.f4?.windows ?? []).filter(
    (window) => window.startMinute >= coveredToMinute
  );
  return missed.length > 0
    ? [
        `Windows of the plan not run (they start after plan minute ${round2(coveredToMinute)}): ${missed
          .map((window) => `${window.id} at ${window.startMinute}`)
          .join(", ")}.`
      ]
    : [];
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
export function e4Joined(
  segments: readonly JoinedSegment[],
  unreached: { money?: string } = {}
): Check {
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
  // A money window the segments never reached leaves (c) unexercised: a review, not an n/a.
  const parts = [
    part("a"),
    part("b"),
    unreached.money && part("c") === "n/a" ? "review" : part("c")
  ];
  return {
    ...perSegment("e4-cap", segments),
    bar: `${checks[0]?.bar ?? ""} (each part from the segment that exercised it)`,
    status: parts.includes("fail")
      ? "fail"
      : parts.includes("review") || parts.every((entry) => entry === "n/a")
        ? "review"
        : "pass",
    value: parts.map((entry, index) => `${"abc"[index]}: ${entry}`).join(", "),
    details: [
      ...perSegment("e4-cap", segments).details,
      ...(unreached.money && parts[2] === "review"
        ? [
            `(c) the money window ${unreached.money} starts after the plan time covered: not exercised in the soak.`
          ]
        : [])
    ]
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
  const byDay = (pick: (result: E1Result) => ReadonlyArray<Record<string, number> | undefined>) => {
    const merged: Array<Record<string, number>> = [];
    for (const result of results)
      pick(result).forEach((row, index) => {
        const into = (merged[index] ??= {});
        for (const [worker, minutes] of Object.entries(row ?? {}))
          into[worker] = (into[worker] ?? 0) + minutes;
      });
    for (let index = 0; index < merged.length; index += 1) merged[index] ??= {};
    return merged;
  };
  const counts = (pick: (result: E1Result) => readonly number[]) => {
    const merged: number[] = [];
    for (const result of results)
      pick(result).forEach((count, index) => {
        merged[index] = (merged[index] ?? 0) + (count ?? 0);
      });
    return merged;
  };
  const exposure = byDay((result) => result.exposure);
  const idleWithDue: E1Result["idleWithDue"] = {};
  for (const result of results)
    for (const [worker, entry] of Object.entries(result.idleWithDue)) {
      const into = (idleWithDue[worker] ??= { samples: 0, longest: 0 });
      into.samples += entry.samples;
      into.longest = Math.max(into.longest, entry.longest);
    }
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
    derivedWorkerStates: results.some((result) => result.derivedWorkerStates),
    scopedExposure: byDay((result) => result.scopedExposure),
    scopedWithoutLink: byDay((result) => result.scopedWithoutLink),
    samplesByDay: counts((result) => result.samplesByDay),
    truncatedByDay: counts((result) => result.truncatedByDay),
    perSample: results.flatMap((result) => result.perSample),
    idleWithDue
  };
}

/** The Codex tokens of the segments against the registered expectation and cap. */
function tokensJoined(
  runs: readonly LoadedRun[],
  merged: LoadedRun,
  dayOf: (atMs: number) => number
): { check: Check; table: Array<Record<string, string | number>> } {
  const first = runs[0]!;
  const codex = first.meta.f4!.codex;
  const rows = codexRows(merged);
  const tokens = (row: (typeof rows)[number]) => (row.inputTokens ?? 0) + (row.outputTokens ?? 0);
  const total = rows.reduce((sum, row) => sum + tokens(row), 0);
  const unknown = rows.filter((row) => row.inputTokens === null || row.inputTokens === undefined);
  const lastCap = (run: LoadedRun) =>
    run.samples.toSorted((a, b) => toMs(a.at) - toMs(b.at)).at(-1)?.cap;
  const spent = runs.map((run) => lastCap(run)?.spentTokens ?? 0);
  const spentTotal = spent.reduce((sum, value) => sum + value, 0);
  const exhausted = runs.filter((run) =>
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
      "planned a day": Math.round(codex.expected / Math.max(1, first.meta.durationMs / day))
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
        runs
          .map(
            (run, index) =>
              `${run.meta.run}: harness cap ${run.meta.f4?.codex.cap ?? "-"}, spent ${spent[index]}`
          )
          .join("; "),
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

/**
 * How much of the plan the segments actually ran: joinPlans checks each tail's planned duration, this
 * the last tail's real end. A last tail that ended before its duration (a manual or host STOP, a
 * signal) without a failing check is no pass; an earlier tail's early end is information, the next
 * segment ran on from its T0.
 */
export function coverageCheck(
  tail: LoadedRun,
  coveredHours: number,
  plannedHours: number,
  earlier: readonly LoadedRun[] = []
): Check {
  const short = coveredHours < plannedHours;
  const early = tail.meta.endReason !== "duration";
  const which = earlier.length > 0 ? "last " : "";
  return {
    id: "plan-coverage",
    title: "Plan covered",
    bar: `the ${which}tail ended by its duration and the segments cover >= ${plannedHours} h of plan time (review otherwise)`,
    status: short || early ? "review" : "pass",
    value: `${coveredHours} h of ${plannedHours} h; the ${which}tail ended by ${tail.meta.endReason ?? "-"}`,
    details: [
      ...earlier
        .filter((run) => run.meta.endReason !== "duration")
        .map(
          (run) =>
            `${run.meta.run} ended by ${run.meta.endReason ?? "-"} before its duration; the next segment ran on from its last executed plan minute (information).`
        ),
      ...(early
        ? [
            `The ${which}tail ended by ${tail.meta.endReason ?? "-"}, not by its duration: read its STOP or the host's record.`
          ]
        : []),
      ...(short
        ? [
            `Plan time covered ${coveredHours} h < ${plannedHours} h: the windows after the ${which}tail's end did not run.`
          ]
        : [])
    ],
    data: { coveredHours, plannedHours }
  };
}

/** The label of a segment: the stopped run's name, a tail's profile less `soak7-`. */
const labelOf = (run: LoadedRun, index: number) =>
  index === 0
    ? run.meta.run.split("-").slice(0, 2).join("-")
    : run.meta.profile.startsWith("soak7-")
      ? run.meta.profile.slice("soak7-".length)
      : `tail${index}`;
/** Joins a stopped run and its tail or tails into one report (refuses with {@link JoinRefusal}). */
export function joinRuns(
  first: LoadedRun,
  tailOrTails: LoadedRun | readonly LoadedRun[],
  options: { explanations?: Record<string, string>; now?: Date } = {}
): JoinedReport {
  const tails: readonly LoadedRun[] = Array.isArray(tailOrTails)
    ? (tailOrTails as readonly LoadedRun[])
    : [tailOrTails as LoadedRun];
  const { seams, problems } = joinPlans(first, tails);
  if (problems.length > 0) throw new JoinRefusal(problems);
  const runs = [first, ...tails];
  const last = runs.at(-1)!;
  const starts = runs.map((run) => toMs(run.meta.startedAt));
  const shifts = [0, ...seams.map((seam) => seam.shiftMinutes)];
  // Segment i counts plan minutes [from_i, to_i): from its T0 (0 for r1) to the next T0 or its end.
  const planEnds = runs.map(
    (run, index) => shifts[index]! + (endOf(run) - starts[index]!) / minute
  );
  const fromMinutes = [0, ...seams.map((seam) => Math.max(seam.t0Minute, seam.shiftMinutes))];
  const toMinutes = runs.map((_, index) =>
    Math.min(planEnds[index]!, seams[index]?.t0Minute ?? Number.POSITIVE_INFINITY)
  );
  // A moment belongs to the latest segment that had started by then.
  const segmentAt = (at: number) =>
    starts.reduce((found, start, index) => (at >= start ? index : found), 0);
  const planMs = (at: number) => {
    const index = segmentAt(at);
    return at - starts[index]! + shifts[index]! * minute;
  };
  const dayOf = (at: number) => Math.floor(planMs(at) / day);
  const planDays = Math.floor(planEnds.at(-1)! / (day / minute));
  const reports = runs.map((run) => analyzeRun(run, options));
  const segments: JoinedSegment[] = runs.map((run, index) => ({
    label: labelOf(run, index),
    run: run.meta.run,
    profile: run.meta.profile,
    seed: run.meta.seed,
    startedAt: run.meta.startedAt,
    endedAt: run.meta.endedAt,
    endReason: run.meta.endReason,
    hours: reports[index]!.window.hours,
    planOffsetMinutes: shifts[index]!,
    planFromMinute: round2(fromMinutes[index]!),
    planToMinute: round2(toMinutes[index]!),
    windows: openedWindows(run),
    report: reports[index]!
  }));

  // The union of the runs' own records (E2, the injection ledger, the load ledger, tokens).
  const own = runs.map((run) => ownRun(run));
  const injected = own.map((run) => injectedRows(run));
  const injectedJobs = own.map((run, index) => injectedJobFailures(run, injected[index]!));
  const context = {
    injected: new Map(injected.flatMap((entries) => [...entries])),
    injectedJobs: new Map(injectedJobs.flatMap((entries) => [...entries]))
  };
  const merged: LoadedRun = {
    meta: first.meta,
    events: own.flatMap((run) => run.events),
    samples: own.flatMap((run) => run.samples),
    rows: own.flatMap((run) => run.rows),
    invalid: {}
  };

  // E1 by plan day: a tail's samples up to its T0 (its warm-up) are the previous segment's plan
  // minutes, and a segment's samples after the next T0 are the next segment's; neither counts twice.
  const e1 = e1CheckOf(
    mergeE1(
      own.map((run, index) =>
        computeE1(run, {
          dayOf,
          ...(index > 0
            ? {
                exposureFromMs: starts[index]! + (fromMinutes[index]! - shifts[index]!) * minute + 1
              }
            : {}),
          ...(seams[index]
            ? {
                exposureToMs:
                  starts[index]! + (seams[index]!.t0Minute - shifts[index]!) * minute + 1
              }
            : {})
        })
      )
    ),
    planDays
  );
  // E3 per segment window, summed; what was created outside every window is listed apart.
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
      .map((segment, index) => {
        const from = own[index]!.meta.warmupMs / hour;
        const to = (endOf(own[index]!) - toMs(own[index]!.meta.startedAt) - day) / hour;
        return to <= from
          ? `${segment.label} no window (shorter than its warm-up + 24 h)`
          : `${segment.label} tasks created ${from.toFixed(2)} h to ${to.toFixed(2)} h (plan minutes ${round2(shifts[index]! + from * 60)}-${round2(shifts[index]! + to * 60)})`;
      })
      .join(", ")}.`,
    `Not measurable at the seam (created outside every window: a warm-up, a segment's last 24 h, a tail too short for a window; information): ${
      [...seam]
        .toSorted(([a], [b]) => a.localeCompare(b))
        .map(([kind, count]) => `${kind} ${count}`)
        .join(", ") || "none"
    }.`
  );
  // The plan's windows after the covered end ran in no segment: E5 and E4 (c) read them as not exercised.
  const unreached = (first.meta.f4?.windows ?? []).filter(
    (window) => window.startMinute >= toMinutes.at(-1)!
  );
  const e5Merged = mergeE5(own.map((run) => computeE5(run)));
  e5Merged.notExercised.push(
    ...unreached
      .filter((window) => window.expect || window.kind === "money")
      .map((window) => ({ window: window.id, why: "not_reached" as const }))
  );
  const e5 = e5CheckOf(e5Merged);
  const moneyUnreached = unreached.find((window) => window.kind === "money")?.id;
  e5.bar += " (over the union of the segments)";
  const e2 = e2Check(merged, context);
  e2.bar += " (over the union of the segments; an input seen in both counts once)";
  const injection = injectionCheck(merged);
  const tokens = tokensJoined(runs, merged, dayOf);
  const load = loadCheck(merged, { dayOf });

  const coveredHours = round2(
    runs.reduce((sum, _, index) => sum + Math.max(0, toMinutes[index]! - fromMinutes[index]!), 0) /
      60
  );
  const checks: Check[] = [
    coverageCheck(last, coveredHours, first.meta.durationMs / hour, tails.slice(0, -1)),
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
    e4Joined(segments, moneyUnreached ? { money: moneyUnreached } : {}),
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
  const gaps = tails.map((tail, index) => (toMs(tail.meta.startedAt) - endOf(runs[index]!)) / hour);
  const gapHours = gaps.reduce((sum, value) => sum + value, 0);
  const several = tails.length > 1;
  const notes = [
    ...seams.map(
      (entry, index) =>
        `T0 = plan minute ${round2(entry.t0Minute)} (${segments[index]!.label}'s last executed action); ${segments[index + 1]!.label} minute = plan minute - ${entry.shiftMinutes}${index === seams.length - 1 ? `; plan time covered ${coveredHours.toFixed(2)} h of ${first.meta.durationMs / hour} h` : ""}.`
    ),
    `Plan minutes counted: ${segments.map((segment) => `${segment.label} ${segment.planFromMinute}-${segment.planToMinute}`).join(", ")}.`,
    several
      ? `The wall-clock gaps between the segments, ${gaps.map((value) => `${value.toFixed(2)} h`).join(" and ")}, are no plan time: the app was closed.`
      : `The wall-clock gap between the segments, ${gapHours.toFixed(2)} h, is no plan time: the app was closed.`,
    `Seeds: ${segments.map((segment) => `${segment.label} ${segment.seed}`).join(", ")} (a new seed in ${several ? "each" : "the"} tail, so the corpus order and the seeded picks do not repeat; injection draws and kill jitter differ from a single run).`,
    `${segments[0]!.label} ended by ${first.meta.endReason}; the harness predicates D38 found wrong are fixed and re-evaluated here: ${fixedPredicates.map((name) => `${name} v${predicateVersions[name]}`).join(", ")}.`,
    ...tails
      .slice(0, -1)
      .map(
        (tail, index) =>
          `${segments[index + 1]!.label} ended by ${tail.meta.endReason ?? "-"} at plan minute ${round2(planEnds[index + 1]!)}; it counts to ${segments[index + 2]!.label}'s T0 ${round2(seams[index + 1]!.t0Minute)} (its later minutes are ${segments[index + 2]!.label}'s first counted minutes and count there, once; ${segments[index + 2]!.label}'s warm-up repeats plan minutes ${seams[index + 1]!.shiftMinutes}-${round2(seams[index + 1]!.t0Minute)}, counted in ${segments[index + 1]!.label}).`
      ),
    `Windows run: ${segments.map((segment) => `${segment.label} ${segment.windows.join(", ") || "none"}`).join("; ")}.`,
    ...runs.flatMap((run, index) =>
      liftedWindows(run, shifts[index]).map((line) => `${segments[index]!.label}: ${line}.`)
    ),
    ...notRunWindows(first, toMinutes.at(-1)!),
    ...tails.flatMap((tail, index) => {
      const limits = knownLimits(tail);
      return limits ? [`${segments[index + 1]!.label}'s plan records: ${limits}`] : [];
    }),
    localFaultLine(runs)
  ];
  return {
    run: runs.map((run) => run.meta.run).join(" + "),
    generatedAt: (options.now ?? new Date()).toISOString(),
    verdict: statuses.includes("fail") ? "fail" : statuses.includes("review") ? "review" : "pass",
    plan: {
      t0Minute: seams[0]!.t0Minute,
      shiftMinutes: seams[0]!.shiftMinutes,
      seams: seams.map((entry, index) => ({
        tail: tails[index]!.meta.run,
        t0Minute: entry.t0Minute,
        shiftMinutes: entry.shiftMinutes,
        gapHours: round2(gaps[index]!)
      })),
      plannedHours: first.meta.durationMs / hour,
      coveredHours,
      gapHours: round2(gapHours)
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
        "plan minutes counted": `${segment.planFromMinute}-${segment.planToMinute}`,
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
    "## X6 and E1-E5 over the segments",
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
