import { describe, expect, it } from "vitest";

import {
  buildRematchPlan,
  type RematchMode,
  type RematchPlan,
  type RematchRoot
} from "./relations-rematch-plan.js";
import {
  runRematch,
  type MatchRecordInput,
  type MatchRecordResult,
  type RematchPorts,
  type RematchRunInput
} from "./relations-rematch-run.js";
import type { ClearedCounts, RunFacts } from "./relations-rematch-state.js";
import { RematchSummarySchema } from "./relations-rematch-summary.js";

const start = Date.parse("2026-10-17T10:00:00.000Z");
const digest = { notes: 6, sha256: "a".repeat(64) };

/** Three roots: a book with two chapters, a document with two notes, and a document with one. */
const root = (
  id: string,
  records: Array<[string, number]>,
  partition: string | null = null
): RematchRoot => ({
  id,
  title: `Title ${id}`,
  partition,
  records: records.map(([recordId, notes]) => ({ id: recordId, title: recordId, notes })),
  notes: records.reduce((sum, [, notes]) => sum + notes, 0)
});
const library = () => [
  root("book", [
    ["book-1", 2],
    ["book-2", 1]
  ]),
  root("paper", [["paper", 2]]),
  root("memo", [["memo", 1]])
];
const arrival: RematchMode = { kind: "arrival", order: { kind: "manifest" } };

const cleared: ClearedCounts = {
  noteRelations: 5,
  decisions: 8,
  typings: 2,
  noteMatchState: 6,
  sourceRelations: 1,
  sourceDecisions: 1,
  sourceMatchState: 0,
  runs: 3,
  events: 9
};

interface Harness {
  ports: RematchPorts;
  events: string[];
  matches: MatchRecordInput[];
  clock: { now: number };
  controller: AbortController;
}

function harness(
  overrides: Partial<RematchPorts> = {},
  options: {
    openJobs?: number[];
    matchMs?: number;
    facts?: Partial<RunFacts>;
  } = {}
): Harness {
  const events: string[] = [];
  const matches: MatchRecordInput[] = [];
  const clock = { now: start };
  const openJobs = [...(options.openJobs ?? [0, 0])];
  const controller = new AbortController();
  const ports: RematchPorts = {
    deciderKey: async () => {
      events.push("decider");
      return "decider-key";
    },
    clear: async (input) => {
      events.push(`clear:${input.scope === "all" ? "all" : input.scope.rootIds.join(",")}`);
      return cleared;
    },
    seedBackground: async (rootIds) => {
      events.push(`seed:${rootIds.join(",")}`);
      return rootIds.length;
    },
    noteIds: async (recordId) => [`${recordId}-n1`],
    matchRecord: async (input): Promise<MatchRecordResult> => {
      matches.push(input);
      events.push(`match:${input.recordId}`);
      clock.now += options.matchMs ?? 1_000;
      return { decided: 1, accepted: 1 };
    },
    enqueueLink: async (rootId) => {
      events.push(`link:${rootId}`);
    },
    openLinkJobs: async () => {
      events.push("open");
      return openJobs.length > 1 ? openJobs.shift()! : (openJobs[0] ?? 0);
    },
    facts: async () => ({
      aiCalls: [],
      firstDecideAdmissionAt: new Date(start + 500),
      lastCommitAt: new Date(start + 20_500),
      noteRelations: [],
      typings: [],
      sourceRelations: [],
      linkJobs: [],
      ...options.facts
    }),
    cassette: () => null,
    now: () => new Date(clock.now),
    sleep: async (ms) => {
      clock.now += ms;
    },
    log: () => undefined,
    ...overrides
  };
  return { ports, events, matches, clock, controller };
}

function input(
  h: Harness,
  plan: RematchPlan,
  extra: Partial<RematchRunInput> = {}
): RematchRunInput {
  return {
    runId: "run-1",
    jobId: "job-1",
    profile: { name: "env-f-s0", kind: "env-f" },
    plan,
    mode: arrival,
    background: "none",
    digest: { expected: digest, actual: digest },
    lanesMode: "serial",
    drainTimeoutMs: 60_000,
    drainPollMs: 1_000,
    signal: h.controller.signal,
    ...extra
  };
}

describe("a re-match run", () => {
  it("clears first, then decides each root's records and queues its link job before the next root", async () => {
    const h = harness();
    const summary = await runRematch(h.ports, input(h, buildRematchPlan(library(), arrival)));
    expect(summary.outcome).toBe("completed");
    expect(h.events.filter((event) => event !== "open")).toEqual([
      "decider",
      "clear:all",
      "seed:",
      "match:book-1",
      "match:book-2",
      "link:book",
      "match:paper",
      "link:paper",
      "match:memo",
      "link:memo"
    ]);
    expect(summary.cleared).toEqual(cleared);
    expect(summary.deciderKey).toBe("decider-key");
    expect(summary.matching).toEqual({ decided: 4, accepted: 4 });
  });

  it("shows retrieval only the roots released so far, a snapshot for each call", async () => {
    const h = harness();
    await runRematch(h.ports, input(h, buildRematchPlan(library(), arrival)));
    expect(h.matches.map((call) => [call.recordId, call.fence.rootSourceItemIds])).toEqual([
      ["book-1", ["book"]],
      ["book-2", ["book"]],
      ["paper", ["book", "paper"]],
      ["memo", ["book", "paper", "memo"]]
    ]);
    // The call is told which root and job it works for, and gets the run's signal.
    expect(h.matches[2]).toMatchObject({ rootId: "paper", jobId: "job-1", noteIds: ["paper-n1"] });
    expect(h.matches[0]!.signal).toBe(h.controller.signal);
  });

  it("releases the next root only when the previous root's decide step committed", async () => {
    const gate = Promise.withResolvers<void>();
    const h = harness();
    const original = h.ports.matchRecord;
    let calls = 0;
    h.ports.matchRecord = async (call) => {
      calls += 1;
      if (calls === 2) await gate.promise;
      return original(call);
    };
    const run = runRematch(h.ports, input(h, buildRematchPlan(library(), arrival)));
    await new Promise((resolve) => setTimeout(resolve, 20));
    // The book's second chapter is still deciding: no link job, no next root.
    expect(h.events).toContain("match:book-1");
    expect(h.events).not.toContain("link:book");
    expect(h.events).not.toContain("match:paper");
    gate.resolve();
    await run;
    expect(h.events.indexOf("link:book")).toBeLessThan(h.events.indexOf("match:paper"));
  });

  it("queues one link job per root, after its last record, and none for a root with no note left", async () => {
    const h = harness({
      noteIds: async (recordId) => (recordId === "book-2" ? [] : [`${recordId}-n1`])
    });
    await runRematch(h.ports, input(h, buildRematchPlan(library(), arrival)));
    expect(h.events.filter((event) => event.startsWith("link:"))).toEqual([
      "link:book",
      "link:paper",
      "link:memo"
    ]);
    expect(h.events).not.toContain("match:book-2");
  });

  it("shows a burst every root from the start", async () => {
    const h = harness();
    const summary = await runRematch(
      h.ports,
      input(h, buildRematchPlan(library(), { kind: "burst" }), { mode: { kind: "burst" } })
    );
    for (const call of h.matches)
      expect(call.fence.rootSourceItemIds).toEqual(["book", "paper", "memo"]);
    expect(summary.mode).toBe("burst");
    expect(summary.order).toBeNull();
  });

  it("with a matched background clears only the released roots and keeps the background visible", async () => {
    const h = harness();
    const plan = buildRematchPlan(library(), arrival, ["Title paper", "memo"]);
    const summary = await runRematch(h.ports, input(h, plan, { background: "matched" }));
    expect(h.events.slice(0, 4)).toEqual([
      "decider",
      "clear:paper,memo",
      "seed:book",
      "match:paper"
    ]);
    expect(h.matches.map((call) => call.fence.rootSourceItemIds)).toEqual([
      ["book", "paper"],
      ["book", "paper", "memo"]
    ]);
    expect(summary.background).toBe("matched");
    expect(summary.backgroundSeeded).toBe(1);
    expect(summary.plan).toMatchObject({ released: 2, background: 1 });
  });

  it("without a validated decider fails before it clears anything", async () => {
    const h = harness({ deciderKey: async () => null });
    const summary = await runRematch(h.ports, input(h, buildRematchPlan(library(), arrival)));
    expect(summary.outcome).toBe("failed");
    expect(summary.error).toContain("no validated decider");
    expect(h.events).toEqual([]);
    expect(summary.timeline).toEqual([]);
  });

  it("fails when a record's matching is skipped, keeping the root it stopped at", async () => {
    const h = harness({
      matchRecord: async (call) =>
        call.recordId === "paper"
          ? { decided: 0, accepted: 0, skipped: "waiting_for_decider" }
          : { decided: 1, accepted: 1 }
    });
    const summary = await runRematch(h.ports, input(h, buildRematchPlan(library(), arrival)));
    expect(summary.outcome).toBe("failed");
    expect(summary.error).toContain("waiting_for_decider");
    expect(
      summary.timeline.map((entry) => [entry.rootId, entry.decideCommittedAtMs !== null])
    ).toEqual([
      ["book", true],
      ["paper", false]
    ]);
    // It does not wait for link jobs after a failure.
    expect(h.events).not.toContain("open");
  });

  it("ends canceled when its signal aborts", async () => {
    const h = harness();
    const original = h.ports.matchRecord;
    h.ports.matchRecord = async (call) => {
      const result = await original(call);
      if (call.recordId === "book-1") h.controller.abort();
      return result;
    };
    const summary = await runRematch(h.ports, input(h, buildRematchPlan(library(), arrival)));
    expect(summary.outcome).toBe("canceled");
    expect(summary.error).toBeNull();
    expect(h.events).not.toContain("link:book");
  });
});

describe("draining the link jobs", () => {
  it("waits until no job is left twice in a row", async () => {
    const h = harness({}, { openJobs: [3, 2, 0, 1, 0, 0] });
    const summary = await runRematch(h.ports, input(h, buildRematchPlan(library(), arrival)));
    expect(summary.outcome).toBe("completed");
    expect(h.events.filter((event) => event === "open")).toHaveLength(6);
    expect(summary.drainedAt).not.toBeNull();
  });

  it("gives up after the timeout and says so", async () => {
    const h = harness({}, { openJobs: [1] });
    const summary = await runRematch(
      h.ports,
      input(h, buildRematchPlan(library(), arrival), { drainTimeoutMs: 5_000, drainPollMs: 1_000 })
    );
    expect(summary.outcome).toBe("drainTimeout");
    expect(summary.drainedAt).toBeNull();
    expect(summary.error).toBeNull();
  });
});

describe("the run summary", () => {
  it("holds X3's clock, the timeline with the link jobs, and the cassette's counts", async () => {
    const link = (rootId: string, started: number, finished: number) => ({
      rootId,
      status: "succeeded",
      attempts: 1,
      createdAt: new Date(start + started - 100),
      startedAt: new Date(start + started),
      finishedAt: new Date(start + finished),
      error: null
    });
    const h = harness(
      {
        cassette: () => ({
          mode: "replay",
          directory: "/repo/.cache/golden/cassettes/x",
          timing: "recorded",
          served: 40,
          recorded: 0,
          misses: 1,
          liveLocalMisses: 2,
          liveTokens: 0,
          maxLiveTokens: null,
          waitedMs: 12_000,
          byTask: { reranking: { served: 30, recorded: 0, misses: 0 } },
          missDetails: [{ taskType: "atomic-note-generation", key: "k".repeat(64) }]
        })
      },
      {
        facts: {
          linkJobs: [link("book", 3_000, 9_000), link("paper", 4_000, 12_000)],
          aiCalls: [
            {
              taskType: "reranking",
              workloadClass: "decide",
              lane: "local",
              calls: 4,
              replayed: 0,
              failed: 0,
              repairs: 0,
              inputTokens: 0,
              outputTokens: 0,
              durationMs: { total: 400, p50: 90, p95: 120 },
              requeueMs: { p50: 0, p95: 3 }
            }
          ]
        }
      }
    );
    const summary = await runRematch(h.ports, input(h, buildRematchPlan(library(), arrival)));
    expect(RematchSummarySchema.parse(JSON.parse(JSON.stringify(summary)))).toEqual(summary);
    // T0 at 0.5 s, T1 at 20.5 s: 20 s for 4 notes is 1,000 s for 200.
    expect(summary.clock).toEqual({
      t0Ms: 500,
      t1Ms: 20_500,
      rawMs: 20_000,
      notesReleased: 4,
      normalized200Ms: 1_000_000
    });
    expect(
      summary.timeline.map((entry) => [entry.title, entry.releasedAtMs, entry.decideCommittedAtMs])
    ).toEqual([
      ["Title book", 0, 2_000],
      ["Title paper", 2_000, 3_000],
      ["Title memo", 3_000, 4_000]
    ]);
    expect(summary.timeline[0]!.link).toMatchObject({
      jobs: 1,
      startedAtMs: 3_000,
      finishedAtMs: 9_000
    });
    expect(summary.timeline[1]!.link).toMatchObject({ startedAtMs: 4_000, finishedAtMs: 12_000 });
    expect(summary.timeline[2]!.link).toBeNull();
    expect(summary.linkJobs).toEqual({ total: 2, byStatus: { succeeded: 2 }, failures: [] });
    expect(summary.cassette).toMatchObject({
      mode: "replay",
      timing: "recorded",
      served: 40,
      misses: 1,
      liveLocalMisses: 2,
      waitedMs: 12_000
    });
    expect(summary.aiCalls).toHaveLength(1);
    expect(summary).toMatchObject({
      lanes: { mode: "serial" },
      profile: { name: "env-f-s0", kind: "env-f" },
      order: { kind: "manifest", seed: null },
      startedAt: "2026-10-17T10:00:00.000Z"
    });
  });

  it("names a seeded order and survives facts that cannot be read", async () => {
    const h = harness({
      facts: async () => {
        throw new Error("database closed");
      }
    });
    const summary = await runRematch(
      h.ports,
      input(h, buildRematchPlan(library(), arrival), {
        mode: { kind: "arrival", order: { kind: "seeded", seed: 20261031 } }
      })
    );
    expect(summary.order).toEqual({ kind: "seeded", seed: 20261031 });
    expect(summary.clock).toMatchObject({
      t0Ms: null,
      t1Ms: null,
      rawMs: null,
      normalized200Ms: null
    });
    expect(summary.outcome).toBe("completed");
  });

  it("reports a link job that failed", async () => {
    const h = harness(
      {},
      {
        facts: {
          linkJobs: [
            {
              rootId: "paper",
              status: "failed",
              attempts: 3,
              createdAt: new Date(start),
              startedAt: new Date(start + 1_000),
              finishedAt: new Date(start + 2_000),
              error: "errors.ai.providerUnavailable"
            }
          ]
        }
      }
    );
    const summary = await runRematch(h.ports, input(h, buildRematchPlan(library(), arrival)));
    expect(summary.linkJobs.failures).toEqual([
      { rootId: "paper", error: "errors.ai.providerUnavailable" }
    ]);
    expect(summary.timeline[1]!.link).toMatchObject({
      status: "failed",
      error: "errors.ai.providerUnavailable"
    });
  });
});
