import type { TimelineEntry } from "./soak-driver.js";
import type { CodexTokenPlan, SoakF4Plan, SoakWindowSpec } from "./soak-plan-f4.js";

/**
 * The Codex token budget of the 7-day soak (F4 T89, spec 5.4 "Day-1 checkpoint and drop order",
 * pre-registered): the plan's window-aware hourly profile, the projection of the run's spend from
 * what was measured, and the five drop steps applied, never reverted, whenever spent plus the
 * projection passes the cap at an hourly check. Never dropped: note edits, contention bursts, every
 * fault and window, the mid-run cap, the money window, at least two imports and four Asks a day.
 * Past step 5 the run goes on at that floor and the orchestrator asks the owner; reaching the hard
 * cap ends the remote leg and the run reads inconclusive.
 *
 * Pure: the driver feeds it the timeline, the steps applied and the spend it measured.
 */

const minute = 60_000;
const hour = 60 * minute;

/** The steps in the order they are taken; each removes entries of the timeline from the moment it is applied. */
export const dropStepLabels: Readonly<Record<number, string>> = {
  1: "explanation bursts off and opens every 2 h",
  2: "Ask every 6 h",
  3: "explanation backfill cap 20 -> 10 a day",
  4: "topic opens every 4 h",
  5: "imports every 12 h"
};
export const dropStepNumbers = [1, 2, 3, 4, 5] as const;

/**
 * The step that removes an entry of the timeline, when one of the applied steps does. The entries
 * kept are the even ones of their kind: a baseline of one every 1, 3 or 2 hours becomes one every 2,
 * 6 or 4 hours. Step 3 removes no entry (it lowers the backfill's cap).
 */
export function droppedBy(
  entry: Pick<TimelineEntry, "kind" | "index">,
  steps: ReadonlySet<number>
): number | null {
  if (steps.has(1) && entry.kind === "explain_burst") return 1;
  if (steps.has(1) && entry.kind === "explain" && entry.index % 2 === 1) return 1;
  if (steps.has(2) && entry.kind === "ask" && entry.index % 2 === 1) return 2;
  if (steps.has(4) && entry.kind === "topic_open" && entry.index % 2 === 1) return 4;
  if (steps.has(5) && entry.kind === "article" && entry.index % 2 === 1) return 5;
  return null;
}

/** A step applied, and when (milliseconds from the start of the run). */
export interface AppliedDropStep {
  step: number;
  atMs: number;
}

const stepsAt = (applied: readonly AppliedDropStep[], atMs: number) =>
  new Set(applied.filter((entry) => entry.atMs <= atMs).map((entry) => entry.step));

/** The Codex tokens one entry of the timeline is planned to cost. */
export function plannedEntryTokens(
  entry: Pick<TimelineEntry, "kind">,
  tokens: CodexTokenPlan
): number {
  switch (entry.kind) {
    case "article":
    case "typing_fault":
    case "source_reimport":
    case "ask":
    case "explain":
    case "explain_burst":
    case "topic_open":
    case "note_edit":
    case "burst_edit":
    case "contention_burst":
      return tokens[entry.kind];
    case "post_outage_probe":
      return tokens.explain;
    case "edit_wave":
      return tokens.edit_wave ?? 0;
    default:
      return 0;
  }
}

/**
 * How much of an hour's planned tokens the windows leave: 1 outside any window, less where a
 * window that blocks remote work covers part of it (the plan's `windowTokenFactor` of its kind).
 */
export function hourFactor(
  hourIndex: number,
  windows: readonly SoakWindowSpec[],
  factors: SoakF4Plan["codex"]["windowTokenFactor"]
): number {
  const from = hourIndex * hour;
  const to = from + hour;
  let factor = 1;
  for (const window of windows) {
    const start = window.startMinute * minute;
    const end = start + window.durationMinutes * minute;
    const overlap = Math.max(0, Math.min(to, end) - Math.max(from, start));
    if (overlap === 0) continue;
    factor -= (overlap / hour) * (1 - (factors[window.kind] ?? 1));
  }
  return Math.max(0, factor);
}

/** Whether any window touches the hour (such hours are left out of the measured ÷ planned ratio). */
export function hourHasWindow(hourIndex: number, windows: readonly SoakWindowSpec[]): boolean {
  const from = hourIndex * hour;
  return windows.some((window) => {
    const start = window.startMinute * minute;
    return start < from + hour && start + window.durationMinutes * minute > from;
  });
}

export interface BudgetPlanInput {
  entries: readonly TimelineEntry[];
  plan: SoakF4Plan;
  windows: readonly SoakWindowSpec[];
  applied: readonly AppliedDropStep[];
}

/** The tokens planned for each hour of the run under the steps in force at the time of each entry. */
export function plannedTokensByHour(input: BudgetPlanInput, hours: number): number[] {
  const { tokens, windowTokenFactor } = input.plan.codex;
  const planned = Array.from({ length: hours }, () => 0);
  for (const entry of input.entries) {
    const at = Math.floor(entry.atMs / hour);
    if (at >= hours) continue;
    if (droppedBy(entry, stepsAt(input.applied, entry.atMs)) !== null) continue;
    planned[at]! +=
      plannedEntryTokens(entry, tokens) * hourFactor(at, input.windows, windowTokenFactor);
  }
  for (let at = 0; at < hours; at += 1)
    planned[at]! += tokens.backgroundPerHour * hourFactor(at, input.windows, windowTokenFactor);
  return planned;
}

export interface ProjectionInput extends BudgetPlanInput {
  nowMs: number;
  spentTokens: number;
  capTokens: number;
  durationMs: number;
  /** The tokens measured in each completed hour of the run, oldest first. */
  actualByHour: readonly number[];
}

export interface Projection {
  /** Tokens the rest of the run is projected to use. */
  projectedTokens: number;
  /** Measured ÷ planned over the last 24 h outside the windows (1 until six such hours exist). */
  ratio: number;
  hoursInRatio: number;
  willPassCap: boolean;
}

/**
 * The projection of the rest of the run: the plan's remaining hours under the steps in force, scaled
 * by measured ÷ planned over the last 24 completed hours outside every window.
 */
export function projectSpend(input: ProjectionInput): Projection {
  const hours = Math.ceil(input.durationMs / hour);
  const planned = plannedTokensByHour(input, hours);
  const completed = Math.min(input.actualByHour.length, Math.floor(input.nowMs / hour));
  let measured = 0;
  let expected = 0;
  let used = 0;
  for (let at = Math.max(0, completed - 24); at < completed; at += 1) {
    if (hourHasWindow(at, input.windows)) continue;
    measured += input.actualByHour[at] ?? 0;
    expected += planned[at] ?? 0;
    used += 1;
  }
  const ratio = used >= 6 && expected > 0 ? measured / expected : 1;
  // The rest of the current hour counts at its share.
  const currentHour = Math.floor(input.nowMs / hour);
  let remaining = 0;
  for (let at = currentHour; at < hours; at += 1) {
    const share = at === currentHour ? 1 - (input.nowMs - currentHour * hour) / hour : 1;
    remaining += (planned[at] ?? 0) * share;
  }
  const projectedTokens = Math.round(remaining * ratio);
  return {
    projectedTokens,
    ratio,
    hoursInRatio: used,
    willPassCap: input.spentTokens + projectedTokens > input.capTokens
  };
}

export interface DropDecision extends Projection {
  /** The step to apply now, or null when the projection fits or every step is taken. */
  step: number | null;
  /** Every step is applied and the projection still passes the cap: the orchestrator asks the owner. */
  overFloor: boolean;
}

/** The hourly check: the next step when spent plus projection passes the cap, one at a time. */
export function decideDrop(input: ProjectionInput): DropDecision {
  const projection = projectSpend(input);
  if (!projection.willPassCap) return { ...projection, step: null, overFloor: false };
  const taken = new Set(input.applied.map((entry) => entry.step));
  const next = dropStepNumbers.find((step) => !taken.has(step)) ?? null;
  return { ...projection, step: next, overFloor: next === null };
}
