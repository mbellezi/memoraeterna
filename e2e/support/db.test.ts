import { describe, expect, it } from "vitest";

import { waitForSettled, type ProfileDb, type UnfinishedJob } from "./db.js";

const job = (type: string, extra: Partial<UnfinishedJob> = {}): UnfinishedJob => ({
  type,
  status: "queued",
  dedupeKey: null,
  blockedClass: null,
  ...extra
});

/** A database whose unfinished jobs are `polls[n]` at the n-th poll (the last one repeats). */
function fakeDb(polls: UnfinishedJob[][]) {
  let poll = 0;
  const db: ProfileDb = {
    async query<Row extends Record<string, unknown>>() {
      const rows = polls[Math.min(poll, polls.length - 1)]!;
      poll += 1;
      return rows as unknown as Row[];
    },
    close: async () => undefined
  };
  return { db, polls: () => poll };
}

const instant = { pollMs: 1, quietPolls: 3, sleep: async () => undefined };

describe("waitForSettled", () => {
  it("never settles while a debounced knowledge job is still queued for later", async () => {
    // A relation match and a topic overview wait out their debounce (run_after in the future):
    // nothing runs and the queue does not change, but the work is not done.
    const { db } = fakeDb([[job("relation-match"), job("topic-overview")]]);
    await expect(waitForSettled(db, { ...instant, timeoutMs: 50 })).rejects.toThrow(
      /relation-match 1, topic-overview 1/u
    );
  });

  it("settles once the debounced jobs have run and the queue stays empty", async () => {
    const pending = [job("relation-match")];
    const { db, polls } = fakeDb([
      pending,
      pending,
      pending,
      pending,
      [job("x", { status: "running" })],
      []
    ]);
    await waitForSettled(db, { ...instant, timeoutMs: 60_000 });
    expect(polls()).toBe(8);
  });

  it("does not wait for the periodic passes, a set-aside job or a model download", async () => {
    const { db, polls } = fakeDb([
      [
        job("gardener-retention", { dedupeKey: "gardener-retention" }),
        job("relation-explain-backfill", { dedupeKey: "relation-explain-backfill:pass" }),
        job("relation-explain", { blockedClass: "answer" }),
        job("local-model-download")
      ]
    ]);
    await waitForSettled(db, { ...instant, timeoutMs: 60_000 });
    expect(polls()).toBe(3);
  });

  it("waits for a per-relation explanation the backfill queued", async () => {
    const { db } = fakeDb([
      [job("relation-explain-backfill", { dedupeKey: "relation-explain-backfill:r1" })]
    ]);
    await expect(waitForSettled(db, { ...instant, timeoutMs: 50 })).rejects.toThrow(
      /relation-explain-backfill 1/u
    );
  });
});
