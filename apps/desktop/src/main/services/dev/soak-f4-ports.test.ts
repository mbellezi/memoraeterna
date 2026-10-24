import { describe, expect, it, vi } from "vitest";

import type { BudgetSnapshot } from "@app/domain";

import { createF4Ports, workerCapacity, type SoakF4PortsDeps } from "./soak-f4-ports.js";
import { soakSampleSchema } from "./soak-records.js";

// The F4 part of the driver's ports with the services replaced by fakes: what one minute's sample
// holds beyond F3's, and what a topic open and a burst ask of the services.
const now = Date.parse("2026-10-30T12:00:00Z");

const budget: BudgetSnapshot = {
  month: "2026-10",
  day: "2026-10-30",
  money: {
    spentUsd: 0.3,
    reservedUsd: 0,
    capUsd: 5,
    pauseShare: 0.8,
    continued: false,
    state: "open",
    priceTableVersion: "v"
  },
  calls: { usedCalls: 12, reservedCalls: 1, capCalls: 800, state: "open" }
};

function deps(overrides: Partial<SoakF4PortsDeps> = {}, rows: Record<string, unknown[]> = {}) {
  const queries: string[] = [];
  const pool = {
    query: vi.fn(async (sql: string) => {
      queries.push(sql);
      if (sql.includes("pg_stat_activity")) return { rows: [{ waiting: 1, longestMs: 4_000 }] };
      if (sql.includes("from topic_trees where status"))
        return { rows: rows.tree ?? [{ id: "tree-1" }] };
      return { rows: rows.default ?? [] };
    })
  };
  const calls = {
    overview: [] as string[],
    views: [] as unknown[],
    audits: [] as string[],
    wakes: 0
  };
  const value: SoakF4PortsDeps = {
    pool: pool as never,
    seed: 7,
    knowledge: { reviewNote: vi.fn(async () => ({ id: "n" })) } as never,
    topicOverview: async (id) => (calls.overview.push(id), { status: "ready" }),
    recordTopicView: async (input) => void calls.views.push(input),
    requestAudit: async (treeId) => void calls.audits.push(treeId),
    jobs: { wake: () => void (calls.wakes += 1) },
    status: {
      snapshot: () => ({
        state: "blocked",
        class: "cap",
        reason: "subscription_daily",
        params: { day: "2026-10-30" },
        coverage: { placed: 0.9, matched: 0.8, overviewsFresh: 0.5 }
      })
    },
    controls: {
      current: () => ({
        autonomy: "auto",
        paused: false,
        onlyIdle: false,
        onlyOnAc: false,
        monthlyCapUsd: 5
      })
    },
    power: { snapshot: () => ({ active: false, onBattery: false, overridden: true }) },
    budget: { snapshot: async () => budget },
    cap: {
      snapshot: () => ({
        capTokens: 4_700_000,
        hardCapTokens: 4_700_000,
        spentTokens: 1_000,
        reservedTokens: 0,
        calls: 3,
        refusals: 0,
        largestCallTokens: 600
      })
    },
    now: () => now,
    load: {
      ownPid: 1,
      exec: async () => ({ stdout: "" }),
      loadAverage: () => [1, 2, 3]
    },
    ...overrides
  };
  return { value, queries, calls, pool };
}

describe("the F4 sample", () => {
  const base = {
    jobs: [
      {
        id: "run-1",
        type: "topic-name",
        lane: "light",
        status: "running",
        sourceItemId: null,
        attempts: 1,
        updatedAt: now - 1_000,
        runAfter: now - 60_000,
        lockedAt: now - 60_000,
        scopeKey: "tree:t:names"
      }
    ],
    lanes: [
      {
        lane: "remote:codex-1",
        limit: 2,
        running: 1,
        held: 0,
        waiting: { P0: 0, P1: 0, P2: 0, P3: 0 },
        rateLimits: 0,
        breaker: "closed",
        pausedForMs: null
      }
    ]
  };

  it("holds the status sentence, the worker states, the cap, the budget, the controls, the power, the locks and the load", async () => {
    const { value } = deps();
    const detail = await createF4Ports(value).sampleDetail(base);
    expect(detail.status).toMatchObject({
      state: "blocked",
      class: "cap",
      reason: "subscription_daily"
    });
    expect(detail.workers?.filter((worker) => worker.state === "idle")).toHaveLength(
      Object.values(workerCapacity()).reduce((sum, slots) => sum + slots, 0) - 1
    );
    expect(detail.workers?.find((worker) => worker.jobId === "run-1")).toMatchObject({
      worker: "model",
      state: "executing",
      scopeKey: "tree:t:names"
    });
    expect(detail.cap).toEqual({
      capTokens: 4_700_000,
      spentTokens: 1_000,
      reservedTokens: 0,
      calls: 3,
      refusals: 0,
      largestCallTokens: 600
    });
    expect(detail.budget).toMatchObject({
      callsState: "open",
      usedCalls: 12,
      reservedCalls: 1,
      capCalls: 800
    });
    expect(detail.controls).toMatchObject({ autonomy: "auto", monthlyCapUsd: 5 });
    expect(detail.power).toEqual({ active: false, onBattery: false, overridden: true });
    expect(detail.lockWaits).toEqual({ waiting: 1, longestMs: 4_000 });
    expect(detail.load?.loadAverage).toEqual([1, 2, 3]);
  });

  it("is a sample the report's schema accepts", async () => {
    const { value } = deps();
    const detail = await createF4Ports(value).sampleDetail(base);
    const sample = {
      at: new Date(now).toISOString(),
      elapsedMs: 0,
      lanes: base.lanes,
      jobs: base.jobs,
      jobCounts: { running: 1 },
      helper: null,
      appRssMb: 1,
      pageouts: null,
      pageSizeBytes: null,
      eventLoopLagP99Ms: null,
      dbPool: null,
      ...detail
    };
    expect(soakSampleSchema.safeParse(sample).success).toBe(true);
  });

  it("keeps a sample whose service failed: that part is null, the rest is there", async () => {
    const { value } = deps({
      budget: { snapshot: async () => Promise.reject(new Error("pool closed")) },
      status: {
        snapshot: () => {
          throw new Error("no status yet");
        }
      }
    });
    const detail = await createF4Ports(value).sampleDetail(base);
    expect(detail.budget).toBeNull();
    expect(detail.status).toBeNull();
    expect(detail.cap?.capTokens).toBe(4_700_000);
  });

  it("records a snapshot the contract does not accept as a fallback, which E5 counts", async () => {
    const { value } = deps({ status: { snapshot: () => ({ state: "dancing" }) } });
    const detail = await createF4Ports(value).sampleDetail(base);
    expect(detail.status).toEqual({ state: "invalid", fallback: true });
  });
});

describe("the F4 actions", () => {
  it("opens a topic page: the view recorded, then the overview asked for", async () => {
    const { value, calls } = deps(
      {},
      { default: [{ id: "topic-1", title: "Memory", hasOverview: false }] }
    );
    const detail = await createF4Ports(value).openTopic!(0);
    expect(calls.views).toEqual([{ id: "topic-1", title: "Memory" }]);
    expect(calls.overview).toEqual(["topic-1"]);
    expect(detail).toMatchObject({ outcome: "opened", hadOverview: false, status: "ready" });
  });

  it("opens nothing when no topic has enough notes, and fails the action with the facts when the overview fails", async () => {
    const none = deps({}, { default: [] });
    expect(await createF4Ports(none.value).openTopic!(0)).toEqual({ outcome: "no_topic" });
    const failing = deps(
      { topicOverview: async () => Promise.reject(new Error("errors.ai.noRoute")) },
      { default: [{ id: "topic-1", title: "Memory", hasOverview: true }] }
    );
    await expect(createF4Ports(failing.value).openTopic!(1)).rejects.toMatchObject({
      name: "SoakActionFailure",
      detail: { hadOverview: true }
    });
  });

  it("asks for an audit of the active tree and queues the notes to embed again", async () => {
    const { value, calls, queries } = deps(
      {},
      {
        default: [
          {
            atomicNoteId: "11111111-1111-4111-8111-111111111111",
            sourceItemId: "22222222-2222-4222-8222-222222222222"
          }
        ]
      }
    );
    const detail = await createF4Ports(value).contentionBurst!(0, 20);
    expect(calls.audits).toEqual(["tree-1"]);
    expect(detail).toMatchObject({ auditRequested: true, reembedsPicked: 1 });
    expect(calls.wakes).toBe(1);
    expect(queries.some((sql) => sql.includes("insert into jobs"))).toBe(true);
  });

  it("edits a note in the burst's root through the knowledge service, and says when there is none", async () => {
    const edited = deps(
      {},
      {
        default: [{ id: "note-1", title: "T", bodyMarkdown: "Body", updatedAt: new Date(now) }]
      }
    );
    const detail = await createF4Ports(edited.value).editBurstNote!(4, 2);
    expect(detail).toEqual({ outcome: "edited", rootIndex: 2 });
    expect(edited.value.knowledge.reviewNote).toHaveBeenCalledWith(
      expect.objectContaining({ id: "note-1", action: "edit" })
    );
    const none = deps({}, { default: [] });
    expect(await createF4Ports(none.value).editBurstNote!(4, 2)).toEqual({
      outcome: "no_note",
      rootIndex: 2
    });
  });
});
