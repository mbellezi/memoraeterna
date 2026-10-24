// Which matching values a stored decision was made under (F4 Q4, D33). Settings are provenance
// (D9): a stored note decision or source pair names no settings of its own, so the values in force
// are kept as a history of periods and a decision belongs to the period its time falls in. Only the
// values that shape a stored decision count: the generative decider's output budget (a note
// decision) and the six request-shaping source-judge values (the source pair key). Thresholds,
// identity limits, floors and the input budget decide new work only and open no period.
import { sha256 } from "@app/conversion";
import {
  matchingNoteDecisionValues,
  type MatchingConfiguration,
  type RelationsConfig
} from "@app/domain";
import { z } from "zod";

import { sourceJudgeRequestSettings } from "../source-relation-processing.js";

/** The `settings` row that holds the history. */
export const matchValuesHistorySettingKey = "relations.match.valuesHistory.v1";

/** Periods kept; the oldest absorbs everything before it when more would be kept. */
export const matchValuesHistoryLimit = 30;

const hash = z.string().min(1).max(100);
export const MatchValuesHistorySchema = z.object({
  /** Oldest first; the last period is the one in force. `from` null: since before it was first seen. */
  periods: z
    .array(
      z.object({
        from: z.string().datetime().nullable(),
        note: hash,
        pair: hash
      })
    )
    .min(1)
    .max(matchValuesHistoryLimit)
});
export type MatchValuesHistory = z.infer<typeof MatchValuesHistorySchema>;

export interface MatchValueHashes {
  /** The values that shape a note decision. */
  note: string;
  /** The request-shaping source-judge values: the ones in the source pair key. */
  pair: string;
}

const hashOf = (value: unknown) => sha256(JSON.stringify(value)).slice(0, 40);

/** The hashes of the values in force; equal hashes mean the same stored decisions stay valid. */
export function matchValueHashes(
  configuration: MatchingConfiguration,
  judge: Pick<
    RelationsConfig["sourceJudge"],
    "noteRelationsPerPair" | "exactEvidencePairs" | "boundedEvidenceChunks"
  >
): MatchValueHashes {
  return {
    note: hashOf(matchingNoteDecisionValues(configuration)),
    pair: hashOf(sourceJudgeRequestSettings(configuration.sourceRelationSettings, judge))
  };
}

/** A span of time: a bound that is null is open. */
export interface MatchValueRange {
  from: Date | null;
  to: Date | null;
}

export interface RecordedMatchValues {
  history: MatchValuesHistory;
  /** Whether the values in force changed since the last period (a new period was opened). */
  changed: boolean;
}

/**
 * Notes the values in force. The first sight opens a period that reaches back to the start: what
 * was decided before is taken to have been decided under the values then in force. A change opens
 * a period at `now`; the same values again do not.
 */
export function recordMatchValues(
  stored: unknown,
  hashes: MatchValueHashes,
  now: Date
): RecordedMatchValues {
  const parsed = MatchValuesHistorySchema.safeParse(stored);
  if (!parsed.success)
    return {
      history: { periods: [{ from: null, note: hashes.note, pair: hashes.pair }] },
      changed: false
    };
  const periods = parsed.data.periods;
  const last = periods.at(-1)!;
  if (last.note === hashes.note && last.pair === hashes.pair)
    return { history: parsed.data, changed: false };
  const next = [...periods, { from: now.toISOString(), note: hashes.note, pair: hashes.pair }];
  while (next.length > matchValuesHistoryLimit) {
    next.shift();
    next[0] = { ...next[0]!, from: null };
  }
  return { history: { periods: next }, changed: true };
}

/**
 * The spans of time in which the values of `kind` were not the ones in force: a decision made in
 * one of them was made under other values. Neighbouring spans are merged.
 */
export function otherValueRanges(
  history: MatchValuesHistory,
  kind: keyof MatchValueHashes
): MatchValueRange[] {
  const current = history.periods.at(-1)![kind];
  const ranges: MatchValueRange[] = [];
  history.periods.forEach((period, index) => {
    if (period[kind] === current) return;
    const from = period.from === null ? null : new Date(period.from);
    const nextPeriod = history.periods[index + 1];
    const to = nextPeriod?.from ? new Date(nextPeriod.from) : null;
    const previous = ranges.at(-1);
    if (
      previous &&
      previous.to !== null &&
      from !== null &&
      previous.to.getTime() === from.getTime()
    )
      previous.to = to;
    else ranges.push({ from, to });
  });
  return ranges;
}
