// The topic history read of the IPC (F5 D20, D30): the growth column of Map > Shape and the strip
// on Home. The wave's wiring card (T171) spreads the channel into `ipcChannels` and the member into
// `DesktopApi.topics`; until then this area has its own channel and its own typed surface, so the
// schemas, the main handler and the preload bridge agree on one source.
import { topicReadLimits } from "@app/domain";
import { z } from "zod";

/** The channels of the area, `app:topics:*`; T171 spreads them into `ipcChannels`. */
export const topicsHistoryChannels = {
  topicsHistory: "app:topics:history"
} as const;

/**
 * `topics.history`: up to 200 topics and up to 90 days (today included). A repeated topic is
 * answered once; the days follow the person's clock.
 */
export const TopicsHistoryInputSchema = z
  .object({
    topicIds: z.array(z.string().uuid()).max(topicReadLimits.historyTopicsMax),
    days: z.number().int().min(1).max(topicReadLimits.historyDaysMax)
  })
  .strict();
export type TopicsHistoryInput = z.input<typeof TopicsHistoryInputSchema>;

export const TopicHistoryDaySchema = z
  .object({
    /** The local day, `YYYY-MM-DD`. */
    day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u),
    /** Items that arrived in the topic as a primary placement that day. */
    arrivals: z.number().int().min(0)
  })
  .strict();

export const TopicHistorySeriesSchema = z
  .object({
    topicId: z.string().uuid(),
    /** `days` entries, oldest first, days without arrivals included with 0. */
    daily: z.array(TopicHistoryDaySchema).min(1).max(topicReadLimits.historyDaysMax)
  })
  .strict();
export type TopicHistorySeries = z.infer<typeof TopicHistorySeriesSchema>;

export const TopicsHistorySchema = z
  .array(TopicHistorySeriesSchema)
  .max(topicReadLimits.historyTopicsMax);
export type TopicsHistory = z.infer<typeof TopicsHistorySchema>;

/** The member `window.app.topics.history` as this area defines it. */
export interface TopicsHistoryApi {
  /** Daily primary-placement arrivals per topic over the last days, one series per topic asked. */
  history: (input: TopicsHistoryInput) => Promise<TopicsHistory>;
}
