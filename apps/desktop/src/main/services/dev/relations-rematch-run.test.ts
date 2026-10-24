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
import { noCompositeBackfill, RematchSummarySchema } from "./relations-rematch-summary.js";

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
    seedBackgroundNotes: async (rootIds, deciderKey) => {
      events.push(`seed-notes:${rootIds.join(",")}:${deciderKey}`);
      return rootIds.length * 3;
    },
    recordCandidates: async () => {
      events.push("record-candidates");
      return true;
    },
    backfillComposites: async () => noCompositeBackfill,
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
    catalogHeaders: async () => ({ refresh: "off", reason: "relations_rematch", jobs: 0 }),
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
    discovery: "on",
    candidates: "off",
    digest: { expected: digest, actual: digest },
    lanesMode: "serial",
    link: "drain",
    helperBatchSize: null,
    relations: { discoveryNeighbours: 1, sourceJudge: { mode: "perRoot", maxPairsPerCall: 12 } },
    p0Probe: null,
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
      "seed-notes::decider-key",
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

  it("keeps the candidate lists before it clears, and says which knobs it ran with", async () => {
    const h = harness();
    const summary = await runRematch(
      h.ports,
      input(h, buildRematchPlan(library(), arrival), { discovery: "off", candidates: "record" })
    );
    expect(h.events.slice(0, 3)).toEqual(["decider", "record-candidates", "clear:all"]);
    expect(summary).toMatchObject({ outcome: "completed", discovery: "off", candidates: "record" });
    // The default run keeps neither.
    const plain = harness();
    const defaults = await runRematch(
      plain.ports,
      input(plain, buildRematchPlan(library(), arrival))
    );
    expect(plain.events).not.toContain("record-candidates");
    expect(defaults).toMatchObject({ discovery: "on", candidates: "off" });
  });

  it("says which link runtime and helper batch it ran with, and runs no probe by default", async () => {
    const h = harness();
    const plain = await runRematch(h.ports, input(h, buildRematchPlan(library(), arrival)));
    expect(plain).toMatchObject({ link: "drain", helperBatchSize: null, p0Probe: null });
    const timing = harness();
    const product = await runRematch(
      timing.ports,
      input(timing, buildRematchPlan(library(), arrival), {
        link: "product",
        lanesMode: "product",
        helperBatchSize: 1
      })
    );
    expect(product).toMatchObject({
      link: "product",
      lanes: { mode: "product" },
      helperBatchSize: 1
    });
    expect(RematchSummarySchema.parse(product).link).toBe("product");
  });

  it("records the discovery neighbours and the source judge mode it matched under (F4 D21)", async () => {
    const h = harness();
    const relations = {
      discoveryNeighbours: 2,
      sourceJudge: { mode: "perPair" as const, maxPairsPerCall: 12 }
    };
    const summary = await runRematch(
      h.ports,
      input(h, buildRematchPlan(library(), arrival), { relations })
    );
    expect(RematchSummarySchema.parse(summary).relations).toEqual(relations);
    // A summary written before F4 reads as not recorded.
    const older: Partial<typeof summary> = { ...summary };
    delete older.relations;
    expect(RematchSummarySchema.parse(older).relations).toBeNull();
  });

  it("probes P0 once an interval from the run's clock until the links drain, with a text no cassette holds", async () => {
    const h = harness({}, { matchMs: 4_000, openJobs: [1, 1, 1, 1, 0, 0] });
    const texts: string[] = [];
    let failures = 0;
    const summary = await runRematch(
      h.ports,
      input(h, buildRematchPlan(library(), arrival), {
        p0Probe: {
          intervalMs: 10_000,
          run: async (text) => {
            texts.push(text);
            h.clock.now += texts.length === 2 ? 1_500 : 200;
            if (texts.length === 3) {
              failures += 1;
              throw new Error("embedding refused");
            }
          }
        }
      })
    );
    expect(summary.outcome).toBe("completed");
    expect(texts.length).toBeGreaterThanOrEqual(2);
    expect(new Set(texts).size).toBe(texts.length);
    expect(texts.every((text) => text.includes("run-1"))).toBe(true);
    expect(summary.p0Probe).toMatchObject({ intervalMs: 10_000, failed: failures });
    expect(summary.p0Probe!.calls).toBe(texts.length);
    expect(summary.p0Probe!.wallMs.max).toBe(1_500);
  });

  it("stops before it clears when the candidate lists cannot be kept", async () => {
    const h = harness({ recordCandidates: async () => false });
    const summary = await runRematch(
      h.ports,
      input(h, buildRematchPlan(library(), arrival), { candidates: "record" })
    );
    expect(summary.outcome).toBe("failed");
    expect(summary.error).toContain("candidate lists cannot be kept");
    expect(h.events.some((event) => event.startsWith("clear"))).toBe(false);
  });

  describe("the composite backfill, its first step (T53f)", () => {
    const facts = {
      ...noCompositeBackfill,
      jobs: 1,
      examined: 11,
      written: 11,
      current: 0,
      waitedMs: 4_200,
      placements: {
        backfilledRoots: 11,
        withCurrentNotes: 11,
        moved: 0,
        movedWithCurrentNotes: 0,
        topicJobsOpen: 0,
        moves: []
      }
    };

    it("drains before the clear and before any root is released, and the summary says how many it wrote", async () => {
      const h = harness({
        backfillComposites: async (call) => {
          h.events.push(`composites:${call.timeoutMs}:${call.pollMs}`);
          expect(call.signal).toBe(h.controller.signal);
          return facts;
        }
      });
      const summary = await runRematch(h.ports, input(h, buildRematchPlan(library(), arrival)));
      expect(summary.outcome).toBe("completed");
      expect(h.events.slice(0, 3)).toEqual(["decider", "composites:60000:1000", "clear:all"]);
      expect(h.events.indexOf("composites:60000:1000")).toBeLessThan(
        h.events.indexOf("match:book-1")
      );
      expect(summary.compositeBackfill).toEqual(facts);
      // The summary round-trips through its schema, as the report reads it.
      expect(
        RematchSummarySchema.parse(JSON.parse(JSON.stringify(summary))).compositeBackfill
      ).toEqual(facts);
    });

    it("starts the run's clock once the backfill has drained, so its calls are not in the measured span", async () => {
      const since: Date[] = [];
      const h = harness({
        backfillComposites: async () => {
          h.clock.now += 30_000;
          return facts;
        },
        facts: async (from) => {
          since.push(from);
          return {
            aiCalls: [],
            firstDecideAdmissionAt: new Date(start + 30_500),
            lastCommitAt: new Date(start + 50_500),
            noteRelations: [],
            typings: [],
            sourceRelations: [],
            linkJobs: []
          };
        }
      });
      const summary = await runRematch(h.ports, input(h, buildRematchPlan(library(), arrival)));
      expect(summary.startedAt).toBe(new Date(start + 30_000).toISOString());
      expect(since).toEqual([new Date(start + 30_000)]);
      // The first release is at the start of the clock, and X3's T0 is measured from it.
      expect(summary.timeline[0]!.releasedAtMs).toBe(0);
      expect(summary.clock.t0Ms).toBe(500);
    });

    it("runs after the candidate lists are secured, so a refusal leaves the library untouched", async () => {
      const h = harness({
        recordCandidates: async () => false,
        backfillComposites: async () => {
          h.events.push("composites");
          return facts;
        }
      });
      const summary = await runRematch(
        h.ports,
        input(h, buildRematchPlan(library(), arrival), { candidates: "record" })
      );
      expect(summary.outcome).toBe("failed");
      expect(h.events).not.toContain("composites");
    });

    it("stops before it clears or releases a root when a hierarchy root still has no composite", async () => {
      const h = harness({
        backfillComposites: async () => ({
          ...facts,
          written: 9,
          remaining: 2,
          skipped: ["no_embedding"]
        })
      });
      const summary = await runRematch(h.ports, input(h, buildRematchPlan(library(), arrival)));
      expect(summary.outcome).toBe("failed");
      expect(summary.error).toContain("2 hierarchy roots still have no composite vector");
      expect(summary.error).toContain("no_embedding");
      expect(h.events.some((event) => event.startsWith("clear"))).toBe(false);
      expect(h.matches).toEqual([]);
      // What the backfill did before it stopped the run is still told.
      expect(summary.compositeBackfill).toMatchObject({ written: 9, remaining: 2 });
    });

    it("fails the run, with the summary written, when the backfill itself throws", async () => {
      const h = harness({
        backfillComposites: async () => {
          throw new Error("embedding model unavailable");
        }
      });
      const summary = await runRematch(h.ports, input(h, buildRematchPlan(library(), arrival)));
      expect(summary).toMatchObject({ outcome: "failed", error: "embedding model unavailable" });
      expect(summary.compositeBackfill).toEqual(noCompositeBackfill);
      expect(h.matches).toEqual([]);
    });

    it("reads a summary written before the backfill existed as one that backfilled nothing", async () => {
      const h = harness();
      const summary = await runRematch(h.ports, input(h, buildRematchPlan(library(), arrival)));
      const { compositeBackfill: _written, ...older } = JSON.parse(
        JSON.stringify(summary)
      ) as Record<string, unknown>;
      void _written;
      expect(RematchSummarySchema.parse(older).compositeBackfill).toEqual(noCompositeBackfill);
    });
  });

  describe("the catalog-header refresh (T53h)", () => {
    it("is off in a re-match, and the summary says so and counts the refresh jobs it saw", async () => {
      const h = harness();
      const summary = await runRematch(h.ports, input(h, buildRematchPlan(library(), arrival)));
      expect(summary.catalogHeaders).toEqual({
        refresh: "off",
        reason: "relations_rematch",
        jobs: 0
      });
      expect(
        RematchSummarySchema.parse(JSON.parse(JSON.stringify(summary))).catalogHeaders
      ).toEqual(summary.catalogHeaders);
    });

    it("reports a refresh job the run saw, so a replay that met one is visible", async () => {
      const h = harness({
        catalogHeaders: async () => ({ refresh: "off", reason: "relations_rematch", jobs: 1 })
      });
      const summary = await runRematch(h.ports, input(h, buildRematchPlan(library(), arrival)));
      expect(summary.catalogHeaders.jobs).toBe(1);
    });

    it("says unknown when the policy cannot be read, and for a summary written before it", async () => {
      const h = harness({
        catalogHeaders: async () => {
          throw new Error("database closed");
        }
      });
      const summary = await runRematch(h.ports, input(h, buildRematchPlan(library(), arrival)));
      expect(summary.outcome).toBe("completed");
      expect(summary.catalogHeaders).toEqual({ refresh: "unknown", reason: null, jobs: 0 });
      const { catalogHeaders: _written, ...older } = JSON.parse(JSON.stringify(summary)) as Record<
        string,
        unknown
      >;
      void _written;
      expect(RematchSummarySchema.parse(older).catalogHeaders.refresh).toBe("unknown");
    });
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
    // The background's source state, then its notes' match state under the run's decider key, then the first root.
    expect(h.events.slice(0, 5)).toEqual([
      "decider",
      "clear:paper,memo",
      "seed:book",
      "seed-notes:book:decider-key",
      "match:paper"
    ]);
    expect(h.matches.map((call) => call.fence.rootSourceItemIds)).toEqual([
      ["book", "paper"],
      ["book", "paper", "memo"]
    ]);
    expect(summary.background).toBe("matched");
    expect(summary.backgroundSeeded).toBe(1);
    expect(summary.backgroundNotesSeeded).toBe(3);
    expect(summary.plan).toMatchObject({ released: 2, background: 1 });
  });

  it("seeds no match state when no root is left in the background", async () => {
    const h = harness();
    const summary = await runRematch(h.ports, input(h, buildRematchPlan(library(), arrival)));
    // The port is asked with an empty list (it records nothing); the summary says 0 notes.
    expect(h.events).toContain("seed-notes::decider-key");
    expect(summary.backgroundNotesSeeded).toBe(0);
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
