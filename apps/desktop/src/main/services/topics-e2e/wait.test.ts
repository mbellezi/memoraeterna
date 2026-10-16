import { describe, expect, it } from "vitest";

import { waitQuiet } from "./wait.js";
import type { WaitStop } from "./wait.js";

function clock() {
  let time = 0;
  return {
    now: () => time,
    sleep: async (ms: number) => {
      time += ms;
    }
  };
}

const base = { timeoutMs: 10_000, pollIntervalMs: 500, quietPolls: 3 };

describe("waiting for a queue to drain", () => {
  it("settles after the quiet polls in a row, not at the first empty one", async () => {
    const counts = [2, 1, 0, 0, 0];
    let polls = 0;
    const outcome = await waitQuiet({
      ...base,
      ...clock(),
      count: async () => counts[Math.min(polls++, counts.length - 1)]!,
      stopReason: async () => null
    });
    expect(outcome).toBe("settled");
    expect(polls).toBe(5);
  });

  it("starts counting again when the follow-up job of a finished one appears", async () => {
    const counts = [0, 0, 1, 0, 0, 0];
    let polls = 0;
    const outcome = await waitQuiet({
      ...base,
      ...clock(),
      count: async () => counts[Math.min(polls++, counts.length - 1)]!,
      stopReason: async () => null
    });
    expect(outcome).toBe("settled");
    expect(polls).toBe(6);
  });

  it("times out when jobs never end", async () => {
    const outcome = await waitQuiet({
      ...base,
      ...clock(),
      count: async () => 1,
      stopReason: async () => null
    });
    expect(outcome).toBe("timeout");
  });

  it("gives up at once on a replay miss or the live token cap, before polling the queue", async () => {
    for (const reason of ["cassette_miss", "token_limit"] as WaitStop[]) {
      let counted = 0;
      const outcome = await waitQuiet({
        ...base,
        ...clock(),
        count: async () => {
          counted += 1;
          return 1;
        },
        stopReason: async () => reason
      });
      expect(outcome).toBe(reason);
      expect(counted).toBe(0);
    }
  });

  it("stops when the reason appears in the middle of a wait", async () => {
    let polls = 0;
    const outcome = await waitQuiet({
      ...base,
      ...clock(),
      count: async () => 1,
      stopReason: async () => (++polls > 2 ? "cassette_miss" : null)
    });
    expect(outcome).toBe("cassette_miss");
  });
});
