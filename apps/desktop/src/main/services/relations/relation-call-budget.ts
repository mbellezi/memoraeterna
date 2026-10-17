// The daily cap of background remote relation calls (F3 D26), until F4's money cap. One counter per
// local day in the setting `relations.ai.dailyCalls`: every remote typing or discovery call of a
// link job or sweep counts; a background call (P2, P3) is refused once the day's count reaches
// the cap, an interactive one (P1, an interactive import's link job) is counted and never refused.
// Calls on the local lane, and every call of a golden or re-match run (drain mode, whose token cap
// bounds it), are not counted.
import { z } from "zod";

import type { Queryable } from "@app/db";
import { relationsDailyCallsSettingKey } from "@app/domain";

import { aiTaskPriority, type AiPriorityInput } from "../ai-priority.js";

/** The stored counter: the local day it counts, its calls, and how many of them were P1 or P0. */
export const RelationDailyCallsSchema = z
  .object({
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    calls: z.number().int().nonnegative(),
    interactiveCalls: z.number().int().nonnegative()
  })
  .strict();
export type RelationDailyCalls = z.infer<typeof RelationDailyCallsSchema>;

/** What the status shows: today's count against the cap. */
export interface RelationCallStatus extends RelationDailyCalls {
  cap: number;
  /** True once background calls are refused for the rest of the day. */
  capped: boolean;
}

/** The local calendar day of `at`, as `YYYY-MM-DD`. */
export function localDay(at: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** The start of the local day after `at`'s: when a capped day's count starts again. */
export function nextLocalDay(at: Date): Date {
  return new Date(at.getFullYear(), at.getMonth(), at.getDate() + 1);
}

export interface RelationCallBudget {
  /**
   * Asks for one call on `lane`: true when it may run (and it is counted, if it counts), false at
   * the cap. `drain` (golden and re-match runs) and the local lane always run uncounted.
   */
  reserve(input: {
    lane: "local" | "remote";
    priority: AiPriorityInput;
    drain?: boolean;
  }): Promise<boolean>;
  /** Whether a background remote call would be refused now. */
  capped(): Promise<boolean>;
  status(): Promise<RelationCallStatus>;
}

/**
 * The budget over the settings table. One statement per reservation, so two link jobs at once
 * never both take the last call: the increment happens only while the day's count is under the cap
 * (or for an interactive call), on the row it locks.
 */
export function createRelationCallBudget(options: {
  db: () => Queryable;
  cap: () => number;
  now?: () => Date;
}): RelationCallBudget {
  const now = options.now ?? (() => new Date());
  const read = async (): Promise<RelationDailyCalls> => {
    const day = localDay(now());
    const result = await options
      .db()
      .query<{ value: unknown }>(`select value from settings where key = $1`, [
        relationsDailyCallsSettingKey
      ]);
    const parsed = RelationDailyCallsSchema.safeParse(result.rows[0]?.value);
    return parsed.success && parsed.data.day === day
      ? parsed.data
      : { day, calls: 0, interactiveCalls: 0 };
  };
  return {
    async reserve(input) {
      if (input.drain || input.lane === "local") return true;
      const priority = aiTaskPriority({ priority: input.priority });
      const interactive = priority === "P0" || priority === "P1";
      const cap = options.cap();
      if (!interactive && cap <= 0) return false;
      const day = localDay(now());
      const result = await options.db().query(
        `insert into settings as s (key, value)
         values ($1, jsonb_build_object('day', $2::text, 'calls', 1,
                 'interactiveCalls', case when $3::boolean then 1 else 0 end))
         on conflict (key) do update set
           value = case
             when s.value->>'day' is distinct from $2::text then excluded.value
             else jsonb_build_object('day', $2::text,
               'calls', coalesce((s.value->>'calls')::int, 0) + 1,
               'interactiveCalls', coalesce((s.value->>'interactiveCalls')::int, 0)
                 + case when $3::boolean then 1 else 0 end)
           end,
           updated_at = now()
         where $3::boolean or s.value->>'day' is distinct from $2::text
           or coalesce((s.value->>'calls')::int, 0) < $4::int
         returning s.key`,
        [relationsDailyCallsSettingKey, day, interactive, cap]
      );
      return (result.rowCount ?? result.rows.length) > 0;
    },
    async capped() {
      return (await read()).calls >= options.cap();
    },
    async status() {
      const counted = await read();
      const cap = options.cap();
      return { ...counted, cap, capped: counted.calls >= cap };
    }
  };
}

/** The error a discovery call refused at the cap stops with; the link job defers discovery on it. */
export const relationDailyCapError = "errors.relations.dailyCapReached";
