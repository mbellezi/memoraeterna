import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";

import { topicsHistoryChannels } from "../shared/ipc-topics-history.js";
import { createTopicsHistoryApi } from "./topics-history-api.js";

describe("createTopicsHistoryApi", () => {
  const topicId = randomUUID();
  const series = [{ topicId, daily: [{ day: "2026-11-11", arrivals: 2 }] }];

  it("validates a request before it leaves and an answer before the page sees it", async () => {
    const invoke = vi.fn(async () => series);
    const api = createTopicsHistoryApi(invoke);
    expect(await api.history({ topicIds: [topicId], days: 1 })).toEqual(series);
    expect(invoke).toHaveBeenCalledWith(topicsHistoryChannels.topicsHistory, {
      topicIds: [topicId],
      days: 1
    });
    await expect(api.history({ topicIds: [topicId], days: 91 })).rejects.toThrow();
    await expect(api.history({ topicIds: ["nope"], days: 7 })).rejects.toThrow();
    expect(invoke).toHaveBeenCalledTimes(1);
    const badDay = createTopicsHistoryApi(async () => [
      { topicId, daily: [{ day: "yesterday", arrivals: 1 }] }
    ]);
    await expect(badDay.history({ topicIds: [topicId], days: 1 })).rejects.toThrow();
    const negative = createTopicsHistoryApi(async () => [
      { topicId, daily: [{ day: "2026-11-11", arrivals: -1 }] }
    ]);
    await expect(negative.history({ topicIds: [topicId], days: 1 })).rejects.toThrow();
  });
});
