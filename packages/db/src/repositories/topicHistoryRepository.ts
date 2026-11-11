// The growth of topics over the last days (F5 D20, T134): how many items arrived as a primary
// placement in each topic on each day. It reads the structure events of applied change-sets and
// nothing else: `topic_daily_metrics` is tree-level, and a pending, dismissed or undone change-set
// has not (or no longer has) put anything anywhere.
//
// An arrival is what "new this week" counts on the Shape cells (`recent` in topicReadRepository):
// an item reaching a topic as its primary placement (`topicArrivalEventSql`: a first placement or
// a move into the topic, never a placement that only parks the item for the gate or its vector),
// in a change-set whose origin is content arriving (place, gate or human), never the engine
// rebuilding the tree. The day is the one in the time zone of the caller, as the other reads of
// "today" are.
import { topicReadLimits } from "@app/domain";

import type { PgPool } from "../client.js";
import { topicArrivalEventSql, topicArrivalOriginsSql } from "./topicReadRepository.js";

export interface TopicHistoryInput {
  /** Up to `topicReadLimits.historyTopicsMax` topics; a repeated ID is answered once. */
  topicIds: readonly string[];
  /** Days counted back from today, today included: 1 to `topicReadLimits.historyDaysMax`. */
  days: number;
}

export interface TopicHistoryDay {
  /** The local day, `YYYY-MM-DD`. */
  day: string;
  arrivals: number;
}

export interface TopicHistorySeries {
  topicId: string;
  /** Exactly `days` entries, oldest first; a day without arrivals is listed with 0. */
  daily: TopicHistoryDay[];
}

export interface TopicHistoryOptions {
  /** The clock (default now). */
  now?: Date;
  /** An IANA zone for the day boundaries (default the process's own zone). */
  timeZone?: string;
}

export class TopicHistoryError extends Error {
  override readonly name = "TopicHistoryError";
}

/**
 * `days`: $1 now, $2 zone, $3 days: the local days of the window, oldest first. The calendar
 * arithmetic is done on timestamps without a zone, so a day with a clock change is still one day.
 */
export const topicHistorySql = {
  days: `select to_char(g, 'YYYY-MM-DD') as day
      from generate_series(
        date_trunc('day', $1::timestamptz at time zone $2) - ($3::int - 1) * interval '1 day',
        date_trunc('day', $1::timestamptz at time zone $2),
        interval '1 day') as g
     order by g`,
  /**
   * $1 topic IDs, $2 now, $3 zone, $4 days: the arrivals per topic and day of the window. The
   * events of the requested topics come through the index on the topic and each is joined to its
   * change-set by key, so the cost follows what the topics hold rather than the size of the tree.
   */
  arrivals: `select e.topic_id as "topicId", to_char(cs.applied_at at time zone $3, 'YYYY-MM-DD') as day,
         count(*)::int as arrivals
      from topic_structure_events e
      join topic_change_sets cs on cs.id = e.change_set_id
     where e.topic_id = any($1::uuid[]) and e.op in ('item.place', 'item.move')
       and ${topicArrivalEventSql("e")}
       and cs.applied_at is not null and cs.status = 'applied'
       and cs.origin in ${topicArrivalOriginsSql}
       and cs.applied_at >= ((date_trunc('day', $2::timestamptz at time zone $3)
             - ($4::int - 1) * interval '1 day') at time zone $3)
       and cs.applied_at < ((date_trunc('day', $2::timestamptz at time zone $3)
             + interval '1 day') at time zone $3)
     group by e.topic_id, day`
} as const;

export function createTopicHistoryRepository(pool: PgPool) {
  return {
    /** `topics.history`: one series per requested topic, in the order asked, zeros included. */
    async readHistory(
      input: TopicHistoryInput,
      options: TopicHistoryOptions = {}
    ): Promise<TopicHistorySeries[]> {
      const { days } = input;
      if (!Number.isInteger(days) || days < 1 || days > topicReadLimits.historyDaysMax) {
        throw new TopicHistoryError(`days must be 1 to ${topicReadLimits.historyDaysMax}`);
      }
      const topicIds = [...new Set(input.topicIds)];
      if (topicIds.length > topicReadLimits.historyTopicsMax) {
        throw new TopicHistoryError(`at most ${topicReadLimits.historyTopicsMax} topics`);
      }
      if (topicIds.length === 0) return [];

      const now = options.now ?? new Date();
      const zone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      const window = (
        await pool.query<{ day: string }>(topicHistorySql.days, [now, zone, days])
      ).rows.map((row) => row.day);
      const counted = new Map<string, Map<string, number>>();
      const rows = await pool.query<{ topicId: string; day: string; arrivals: number }>(
        topicHistorySql.arrivals,
        [topicIds, now, zone, days]
      );
      for (const row of rows.rows) {
        const byDay = counted.get(row.topicId) ?? new Map<string, number>();
        byDay.set(row.day, row.arrivals);
        counted.set(row.topicId, byDay);
      }
      return topicIds.map((topicId) => ({
        topicId,
        daily: window.map((day) => ({ day, arrivals: counted.get(topicId)?.get(day) ?? 0 }))
      }));
    }
  };
}

export type TopicHistoryRepository = ReturnType<typeof createTopicHistoryRepository>;
