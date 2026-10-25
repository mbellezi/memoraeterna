import { describe, expect, it } from "vitest";

import {
  gardenerBlockerClasses,
  gardenerBlockerKeys,
  type GardenerBlockerClass,
  type GardenerBlockerKey
} from "./blockers.js";
import {
  GardenerStatusConfigSchema,
  GardenerStatusSnapshotSchema,
  composeGardenerStatus,
  coverageShare,
  defaultGardenerStatusConfig,
  fullGardenerCoverage,
  gardenerStatusActionOf,
  gardenerStatusKinds,
  gardenerStatusNeedsPerson,
  quantizeEtaSeconds,
  sameGardenerStatus,
  stableGardenerStatus,
  workEtaSeconds,
  type GardenerStatusFacts,
  type StatusLaneFacts,
  type StatusTaskFacts
} from "./status.js";

const now = Date.UTC(2026, 9, 24, 15, 0, 0);
const minute = 60_000;

const task = (type: string, counts: Partial<StatusTaskFacts> = {}): StatusTaskFacts => ({
  type,
  running: 0,
  ready: 0,
  sameScope: 0,
  retrying: 0,
  scheduled: 0,
  ...counts
});

const lane = (counts: Partial<StatusLaneFacts> = {}): StatusLaneFacts => ({
  lane: "remote:codex",
  running: 0,
  waiting: 0,
  pausedForMs: null,
  breaker: { state: "closed", reopensInMs: null },
  failure: null,
  ...counts
});

const hold = (key: GardenerBlockerKey) => {
  const [blockerClass, reason] = key.split(".") as [GardenerBlockerClass, string];
  return { class: blockerClass, reason } as GardenerStatusFacts["gateHolds"][number];
};

const facts = (overrides: Partial<GardenerStatusFacts> = {}): GardenerStatusFacts => ({
  nowMs: now,
  gateHolds: [],
  tasks: [],
  blocked: [],
  lanes: [],
  downloads: { downloading: false, verifying: false, loading: false, etaSeconds: null },
  budget: null,
  durations: {},
  coverage: fullGardenerCoverage,
  ...overrides
});

const blocked = (
  type: string,
  key: GardenerBlockerKey,
  extra: { count?: number; earliestRunAfterMs?: number | null } = {}
) => {
  const [blockerClass, reason] = key.split(".") as [string, string];
  return {
    type,
    blockerClass,
    reason,
    count: extra.count ?? 1,
    earliestRunAfterMs: extra.earliestRunAfterMs ?? null
  };
};

describe("the status configuration", () => {
  it("starts from the spec's values", () => {
    expect(defaultGardenerStatusConfig).toEqual({
      etaSamples: 50,
      etaMinSamples: 3,
      laneFailureTtlMs: 900_000,
      modelLoadTtlMs: 600_000,
      scheduledWithinMs: 300_000,
      coverageTtlMs: 30_000,
      refreshWindowMs: 500,
      heartbeatMs: 30_000
    });
  });

  it("refuses values out of range and unknown fields", () => {
    expect(() => GardenerStatusConfigSchema.parse({ etaSamples: 2 })).toThrow();
    expect(() => GardenerStatusConfigSchema.parse({ etaMinSamples: 60 })).toThrow();
    expect(() => GardenerStatusConfigSchema.parse({ refreshWindowMs: 5 })).toThrow();
    expect(() => GardenerStatusConfigSchema.parse({ etaSamples: 10, etaMinSamples: 11 })).toThrow();
    expect(() => GardenerStatusConfigSchema.parse({ keepForever: true })).toThrow();
  });
});

describe("the status snapshot", () => {
  it("accepts only a reason of its class, and a blocked state only with one", () => {
    const base = { params: {}, coverage: fullGardenerCoverage };
    expect(GardenerStatusSnapshotSchema.parse({ ...base, state: "idle" }).state).toBe("idle");
    expect(
      GardenerStatusSnapshotSchema.parse({
        ...base,
        state: "blocked",
        class: "waiting",
        reason: "provider_rate_limit"
      }).reason
    ).toBe("provider_rate_limit");
    expect(() =>
      GardenerStatusSnapshotSchema.parse({
        ...base,
        state: "blocked",
        class: "cap",
        reason: "queue"
      })
    ).toThrow();
    expect(() => GardenerStatusSnapshotSchema.parse({ ...base, state: "blocked" })).toThrow();
    expect(() =>
      GardenerStatusSnapshotSchema.parse({ ...base, state: "idle", class: "cap" })
    ).toThrow();
    expect(() =>
      GardenerStatusSnapshotSchema.parse({ ...base, state: "idle", action: "resume" })
    ).toThrow();
    expect(() =>
      GardenerStatusSnapshotSchema.parse({ ...base, state: "idle", extra: true })
    ).toThrow();
  });

  it("keeps shares between 0 and 1 and refuses a time that is not a date", () => {
    expect(() =>
      GardenerStatusSnapshotSchema.parse({
        state: "idle",
        params: {},
        coverage: { placed: 1.2, matched: 1, overviewsFresh: 1 }
      })
    ).toThrow();
    expect(() =>
      GardenerStatusSnapshotSchema.parse({
        state: "idle",
        params: {},
        coverage: fullGardenerCoverage,
        eta: { kind: "at", at: "tomorrow" }
      })
    ).toThrow();
  });

  it("compares two snapshots by content", () => {
    const idle = composeGardenerStatus(facts());
    expect(sameGardenerStatus(null, idle)).toBe(false);
    expect(sameGardenerStatus(idle, composeGardenerStatus(facts()))).toBe(true);
    expect(
      sameGardenerStatus(
        idle,
        composeGardenerStatus(facts({ gateHolds: [hold("paused.user_pause")] }))
      )
    ).toBe(false);
  });
});

describe("a time that only drifted", () => {
  const limited = (at: number) =>
    composeGardenerStatus(
      facts({
        tasks: [task("topic-name", { ready: 1 })],
        lanes: [lane({ waiting: 1, pausedForMs: at - now })]
      })
    );

  it("keeps the previous time while the new one is within the tolerance", () => {
    const first = limited(now + 120_000);
    const drifted = limited(now + 120_040);
    expect(sameGardenerStatus(first, drifted)).toBe(false);
    expect(sameGardenerStatus(first, stableGardenerStatus(first, drifted))).toBe(true);
    expect(stableGardenerStatus(first, limited(now + 121_900)).eta).toEqual(first.eta);
  });

  it("takes the new time when it moved for real, or when there was none", () => {
    const first = limited(now + 120_000);
    const moved = limited(now + 180_000);
    expect(stableGardenerStatus(first, moved)).toEqual(moved);
    expect(stableGardenerStatus(null, moved)).toEqual(moved);
    const idle = composeGardenerStatus(facts());
    expect(stableGardenerStatus(first, idle)).toEqual(idle);
    expect(stableGardenerStatus(idle, first)).toEqual(first);
  });
});

describe("coverage shares", () => {
  it("rounds down to a whole percent and stays below 1 until it is complete", () => {
    expect(coverageShare(0, 0)).toBe(1);
    expect(coverageShare(5, 5)).toBe(1);
    expect(coverageShare(199, 200)).toBe(0.99);
    expect(coverageShare(1, 3)).toBe(0.33);
    expect(coverageShare(0, 10)).toBe(0);
  });

  it("is passed through to the snapshot", () => {
    const coverage = { placed: 0.5, matched: 0.25, overviewsFresh: 0.9 };
    expect(composeGardenerStatus(facts({ coverage })).coverage).toEqual(coverage);
  });
});

describe("precedence (D7, D27)", () => {
  it("names the highest class that holds anything: paused > no_model > cap > download > waiting > offline", () => {
    const holds = [
      hold("paused.user_pause"),
      hold("no_model.no_route"),
      hold("cap.money_80"),
      hold("download.model_downloading"),
      hold("waiting.provider_rate_limit"),
      hold("offline.network_unreachable")
    ];
    expect(holds.map((entry) => entry.class)).toEqual([...gardenerBlockerClasses]);
    for (let from = 0; from < holds.length; from += 1) {
      const snapshot = composeGardenerStatus(facts({ gateHolds: holds.slice(from) }));
      expect(snapshot.class).toBe(gardenerBlockerClasses[from]);
    }
  });

  it("keeps the ordinary queue behind every other class, offline included", () => {
    for (const other of [
      "offline.network_unreachable",
      "download.model_loading",
      "cap.provider_quota"
    ] as const)
      for (const ordinary of [
        "waiting.queue",
        "waiting.same_scope",
        "waiting.retry_backoff"
      ] as const)
        expect(
          composeGardenerStatus(facts({ gateHolds: [hold(ordinary), hold(other)] })).class,
          `${other} over ${ordinary}`
        ).toBe(other.split(".")[0]);
  });

  it("explains a task with every one of the 25 reasons held as a standing hold", () => {
    for (const key of gardenerBlockerKeys) {
      const [blockerClass, reason] = key.split(".");
      const snapshot = composeGardenerStatus(facts({ gateHolds: [hold(key)] }));
      expect(`${snapshot.class}.${snapshot.reason}`, key).toBe(key);
      expect(snapshot.class).toBe(blockerClass);
      expect(snapshot.reason).toBe(reason);
      expect(snapshot.action, key).toBe(gardenerStatusActionOf[key] ?? undefined);
      expect(GardenerStatusSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    }
  });

  it("keeps the generic queue behind a provider problem inside the waiting class", () => {
    const snapshot = composeGardenerStatus(
      facts({
        tasks: [task("topic-name", { running: 0, ready: 3, sameScope: 1 })],
        lanes: [lane({ running: 1, pausedForMs: 90_000 })]
      })
    );
    expect(snapshot).toMatchObject({ class: "waiting", reason: "provider_rate_limit" });
  });

  it("orders the waiting reasons from the specific to the generic", () => {
    const order = [
      "waiting.provider_rate_limit",
      "waiting.provider_unavailable",
      "waiting.local_memory",
      "waiting.waiting_for_embeddings",
      "waiting.same_scope",
      "waiting.queue",
      "waiting.retry_backoff"
    ] as const;
    for (let from = 0; from < order.length; from += 1) {
      const snapshot = composeGardenerStatus(
        facts({ gateHolds: order.slice(from).map((key) => hold(key)) })
      );
      expect(`${snapshot.class}.${snapshot.reason}`).toBe(order[from]);
    }
  });

  it("gives a standing control priority over the work it does not hold", () => {
    const snapshot = composeGardenerStatus(
      facts({
        gateHolds: [hold("paused.autonomy_off")],
        tasks: [task("topic-place", { running: 1 }), task("topic-name", { ready: 2 })]
      })
    );
    expect(snapshot).toMatchObject({ state: "running", class: "paused", reason: "autonomy_off" });
  });
});

describe("the state", () => {
  it("is idle with nothing to do and nothing in the way", () => {
    expect(composeGardenerStatus(facts())).toEqual({
      state: "idle",
      params: {},
      coverage: fullGardenerCoverage
    });
  });

  it("stays idle under a standing hold when no task waits, and still says why", () => {
    expect(composeGardenerStatus(facts({ gateHolds: [hold("paused.user_pause")] }))).toMatchObject({
      state: "idle",
      class: "paused",
      reason: "user_pause",
      action: "resume"
    });
  });

  it("is running while a task runs", () => {
    expect(
      composeGardenerStatus(facts({ tasks: [task("topic-place", { running: 1 })] }))
    ).toMatchObject({ state: "running" });
  });

  it("is running while tasks only wait their turn, and says so", () => {
    for (const counts of [{ ready: 2 }, { scheduled: 1 }, { sameScope: 1 }] as const) {
      const snapshot = composeGardenerStatus(facts({ tasks: [task("topic-place", counts)] }));
      expect(snapshot.state).toBe("running");
      expect(snapshot.class).toBe("waiting");
      expect(["queue", "same_scope"]).toContain(snapshot.reason);
    }
  });

  it("is blocked when tasks wait behind a hold and nothing runs", () => {
    const snapshot = composeGardenerStatus(
      facts({
        tasks: [task("topic-name", { ready: 1 })],
        gateHolds: [hold("paused.only_idle_user_active")]
      })
    );
    expect(snapshot).toMatchObject({ state: "blocked", class: "paused" });
    expect(
      composeGardenerStatus(facts({ tasks: [task("topic-name", { retrying: 1 })] }))
    ).toMatchObject({ state: "blocked", class: "waiting", reason: "retry_backoff" });
  });

  it("needs the person for the reasons only the person can clear", () => {
    expect([...gardenerStatusNeedsPerson].sort()).toEqual([
      "cap.money_100",
      "cap.money_80",
      "no_model.model_missing",
      "no_model.no_route",
      "no_model.signin_required"
    ]);
    for (const key of gardenerStatusNeedsPerson) {
      const snapshot = composeGardenerStatus(
        facts({ gateHolds: [hold(key)], tasks: [task("topic-place", { running: 1 })] })
      );
      expect(snapshot.state, key).toBe("attention");
      expect(snapshot.action, key).toBeDefined();
    }
  });
});

describe("a non-running task always has a reason (E5)", () => {
  const kinds = ["topic-place", "topic-name", "topic-gate", "relation-link", "relation-match"];

  it("explains queued, retrying, scheduled and same-scope tasks of every Gardener kind", () => {
    for (const type of gardenerStatusKinds) {
      for (const counts of [
        { ready: 1 },
        { sameScope: 1 },
        { retrying: 1 },
        { scheduled: 1 }
      ] satisfies Array<Partial<StatusTaskFacts>>) {
        const snapshot = composeGardenerStatus(facts({ tasks: [task(type, counts)] }));
        expect(snapshot.class, `${type} ${JSON.stringify(counts)}`).toBeDefined();
        expect(snapshot.reason).toBeDefined();
      }
    }
  });

  it("explains a task blocked by every reason, and one blocked by a reason it does not know", () => {
    for (const type of kinds)
      for (const key of gardenerBlockerKeys) {
        const snapshot = composeGardenerStatus(facts({ blocked: [blocked(type, key)] }));
        expect(snapshot.class, `${type} ${key}`).toBeDefined();
      }
    const unknown = composeGardenerStatus(
      facts({
        blocked: [
          {
            type: "topic-name",
            blockerClass: "cap",
            reason: "from_the_future",
            count: 1,
            earliestRunAfterMs: null
          }
        ]
      })
    );
    expect(unknown).toMatchObject({ class: "waiting", reason: "queue" });
  });

  it("ignores rows that are not Gardener tasks", () => {
    expect(
      composeGardenerStatus(
        facts({
          tasks: [task("ingestion", { ready: 4 })],
          blocked: [blocked("note-embedding", "cap.money_80")]
        })
      )
    ).toMatchObject({ state: "idle" });
  });

  it("names an import a provider outage set aside, as it names a Gardener task (D7)", () => {
    for (const key of ["offline.network_unreachable", "waiting.provider_unavailable"] as const)
      expect(
        composeGardenerStatus(facts({ blocked: [blocked("ingestion", key, { count: 2 })] }))
      ).toMatchObject({
        state: "blocked",
        class: key.split(".")[0],
        reason: key.split(".")[1]
      });
    // The lane's own memory says the same while the import waits: the network did not answer.
    expect(
      composeGardenerStatus(
        facts({
          blocked: [blocked("ingestion", "offline.network_unreachable")],
          lanes: [
            lane({
              breaker: { state: "open", reopensInMs: 20_000 },
              failure: { kind: "unreachable", ageMs: 1_000 }
            })
          ]
        })
      )
    ).toMatchObject({ state: "blocked", class: "offline", reason: "network_unreachable" });
  });
});

describe("blocked tasks", () => {
  it("names the route class a missing route is about, from the kind of the blocked task", () => {
    expect(
      composeGardenerStatus(facts({ blocked: [blocked("topic-gate", "no_model.no_route")] }))
    ).toMatchObject({ class: "no_model", reason: "no_route", params: { routeClass: "decide" } });
    expect(
      composeGardenerStatus(facts({ blocked: [blocked("topic-name", "no_model.no_route")] })).params
    ).toEqual({ routeClass: "write-fast" });
    expect(
      composeGardenerStatus(facts({ blocked: [blocked("topic-place", "no_model.no_route")] }))
        .params
    ).toEqual({ routeClass: "embed" });
  });

  it("gives the time a time-bound wait clears, and none for a wait that only an event clears", () => {
    const at = now + 7 * minute;
    const timed = composeGardenerStatus(
      facts({
        blocked: [blocked("topic-name", "no_model.signin_required", { earliestRunAfterMs: at })]
      })
    );
    expect(timed.eta).toEqual({ kind: "at", at: new Date(at).toISOString() });
    const evented = composeGardenerStatus(
      facts({ blocked: [blocked("topic-name", "paused.user_pause", { earliestRunAfterMs: at })] })
    );
    expect(evented.eta).toBeUndefined();
    const past = composeGardenerStatus(
      facts({
        blocked: [
          blocked("topic-name", "no_model.signin_required", { earliestRunAfterMs: now - 1 })
        ]
      })
    );
    expect(past.eta).toBeUndefined();
  });

  it("clears a daily cap at the next local midnight and a month's cap at the next month", () => {
    const day = composeGardenerStatus(facts({ gateHolds: [hold("cap.subscription_daily")] }));
    const midnight = new Date(now);
    midnight.setHours(24, 0, 0, 0);
    expect(day.eta).toEqual({ kind: "at", at: midnight.toISOString() });
    const feature = composeGardenerStatus(
      facts({ blocked: [blocked("topic-name", "cap.feature_daily")] })
    );
    expect(feature.eta).toEqual({ kind: "at", at: midnight.toISOString() });
    const month = composeGardenerStatus(facts({ gateHolds: [hold("cap.money_100")] }));
    expect(month.eta).toEqual({
      kind: "at",
      at: new Date(new Date(now).getFullYear(), new Date(now).getMonth() + 1, 1).toISOString()
    });
    // At 80% the person decides; nothing clears by itself.
    expect(composeGardenerStatus(facts({ gateHolds: [hold("cap.money_80")] })).eta).toBeUndefined();
  });

  it("carries the amounts of a money cap", () => {
    const snapshot = composeGardenerStatus(
      facts({
        gateHolds: [hold("cap.money_80")],
        budget: { spentUsd: 4.0049, capUsd: 5 }
      })
    );
    expect(snapshot.params).toEqual({ capUsd: 5, spentUsd: 4 });
  });
});

describe("the AI lanes", () => {
  const remoteWork = [task("topic-name", { ready: 1 })];

  it("explains a paused lane with the time it resumes", () => {
    const snapshot = composeGardenerStatus(
      facts({ tasks: remoteWork, lanes: [lane({ waiting: 1, pausedForMs: 5 * minute })] })
    );
    expect(snapshot).toMatchObject({
      class: "waiting",
      reason: "provider_rate_limit",
      eta: { kind: "at", at: new Date(now + 5 * minute).toISOString() }
    });
  });

  it("says nothing about a lane no work could use", () => {
    expect(
      composeGardenerStatus(
        facts({
          tasks: [task("topic-place", { running: 1 })],
          lanes: [lane({ pausedForMs: minute })]
        })
      )
    ).toMatchObject({ state: "running" });
    expect(composeGardenerStatus(facts({ lanes: [lane({ pausedForMs: minute })] })).state).toBe(
      "idle"
    );
  });

  it("ignores the local lane", () => {
    const snapshot = composeGardenerStatus(
      facts({
        tasks: remoteWork,
        lanes: [lane({ lane: "local", waiting: 2, breaker: { state: "open", reopensInMs: 1_000 } })]
      })
    );
    expect(snapshot.reason).toBe("queue");
  });

  it("reads an open breaker as a provider that does not answer, until it reopens", () => {
    const snapshot = composeGardenerStatus(
      facts({
        tasks: remoteWork,
        lanes: [lane({ breaker: { state: "open", reopensInMs: 30_000 } })]
      })
    );
    expect(snapshot).toMatchObject({
      class: "waiting",
      reason: "provider_unavailable",
      eta: { kind: "at", at: new Date(now + 30_000).toISOString() }
    });
    const probing = composeGardenerStatus(
      facts({
        tasks: remoteWork,
        lanes: [lane({ breaker: { state: "half_open", reopensInMs: null } })]
      })
    );
    expect(probing).toMatchObject({ class: "waiting", reason: "provider_unavailable" });
    expect(probing.eta).toBeUndefined();
  });

  it("reads an unreachable network behind an open breaker as offline", () => {
    const snapshot = composeGardenerStatus(
      facts({
        tasks: remoteWork,
        lanes: [
          lane({
            breaker: { state: "open", reopensInMs: 30_000 },
            failure: { kind: "unreachable", ageMs: 2_000 }
          })
        ]
      })
    );
    expect(snapshot).toMatchObject({ class: "offline", reason: "network_unreachable" });
    // The tasks it makes wait for their next attempt are explained by the outage, not by the retry.
    expect(
      composeGardenerStatus(
        facts({
          tasks: [task("topic-name", { ready: 2, retrying: 3, sameScope: 1 })],
          lanes: [
            lane({
              breaker: { state: "open", reopensInMs: 30_000 },
              failure: { kind: "unreachable", ageMs: 2_000 }
            })
          ]
        })
      )
    ).toMatchObject({ state: "blocked", class: "offline", reason: "network_unreachable" });
    // One failed call is a hiccup, not an outage: the breaker has not opened.
    expect(
      composeGardenerStatus(
        facts({
          tasks: remoteWork,
          lanes: [lane({ failure: { kind: "unreachable", ageMs: 100 } })]
        })
      ).reason
    ).toBe("queue");
  });

  it("reads a refused sign-in as a sign-in the person has to renew, without a breaker", () => {
    const snapshot = composeGardenerStatus(
      facts({
        tasks: remoteWork,
        lanes: [lane({ failure: { kind: "unauthorized", ageMs: 1_000 } })]
      })
    );
    expect(snapshot).toMatchObject({
      state: "attention",
      class: "no_model",
      reason: "signin_required",
      action: "sign_in"
    });
  });

  it("forgets a failure older than the configured window", () => {
    const stale = composeGardenerStatus(
      facts({
        tasks: remoteWork,
        lanes: [
          lane({
            breaker: { state: "open", reopensInMs: 5_000 },
            failure: {
              kind: "unauthorized",
              ageMs: defaultGardenerStatusConfig.laneFailureTtlMs + 1
            }
          })
        ]
      })
    );
    expect(stale.reason).toBe("provider_unavailable");
  });

  it("puts a rate limit and an outage together under the one that is more specific", () => {
    const snapshot = composeGardenerStatus(
      facts({
        tasks: remoteWork,
        lanes: [lane({ pausedForMs: minute, breaker: { state: "open", reopensInMs: 9_000 } })]
      })
    );
    expect(snapshot.reason).toBe("provider_rate_limit");
  });
});

describe("a lane's problem affects only the work that takes that lane (spec 3.8)", () => {
  const codex = "remote:codex";
  const priced = "remote:priced";
  const signedOut = lane({ lane: codex, failure: { kind: "unauthorized", ageMs: 11_000 } });
  const idle = lane({ lane: priced });
  const backfill = "relation-explain-backfill";

  it("names the cap that holds the work, not a sign-in on a lane none of it takes (gate S 10-25, 12:25-12:29)", () => {
    // The money window routed the explanations to the priced fake and the budget held them at 80%;
    // a random 401 hit the Codex lane, which ran and queued nothing.
    const gate = facts({
      gateHolds: [hold("cap.money_80")],
      budget: { spentUsd: 0.065336, capUsd: 0.097728 },
      blocked: [blocked(backfill, "cap.money_80", { count: 6 })],
      lanes: [lane({ lane: "local" }), signedOut, idle],
      kindLanes: { [backfill]: priced }
    });
    expect(composeGardenerStatus(gate)).toMatchObject({
      state: "attention",
      class: "cap",
      reason: "money_80",
      params: { capUsd: 0.1, spentUsd: 0.07 },
      action: "continue_budget"
    });
    // A lane the facts do not tell is any remote lane's, as before the lanes were read.
    expect(composeGardenerStatus({ ...gate, kindLanes: undefined })).toMatchObject({
      class: "no_model",
      reason: "signin_required"
    });
  });

  it("still names a refused sign-in for work routed to that lane, held or not", () => {
    for (const work of [
      { tasks: [task(backfill, { ready: 1 })] },
      { blocked: [blocked(backfill, "cap.money_80", { count: 6 })] }
    ])
      expect(
        composeGardenerStatus(
          facts({
            ...work,
            gateHolds: [hold("cap.money_80")],
            lanes: [signedOut, idle],
            kindLanes: { [backfill]: codex }
          })
        )
      ).toMatchObject({ state: "attention", class: "no_model", reason: "signin_required" });
  });

  it("still names the problem of a lane whose own calls run or wait, whatever the tasks take", () => {
    expect(
      composeGardenerStatus(
        facts({
          tasks: [task(backfill, { ready: 1 })],
          lanes: [{ ...signedOut, waiting: 1 }, idle],
          kindLanes: { [backfill]: priced }
        })
      )
    ).toMatchObject({ class: "no_model", reason: "signin_required" });
  });

  it("reads a rate limit, an outage and an unreachable network on their own lane's work only", () => {
    const problems: Array<[Partial<StatusLaneFacts>, string]> = [
      [{ pausedForMs: 5 * minute }, "waiting.provider_rate_limit"],
      [{ breaker: { state: "open", reopensInMs: 30_000 } }, "waiting.provider_unavailable"],
      [
        {
          breaker: { state: "open", reopensInMs: 30_000 },
          failure: { kind: "unreachable", ageMs: 2_000 }
        },
        "offline.network_unreachable"
      ]
    ];
    for (const [problem, key] of problems) {
      const at = (routed: string) =>
        composeGardenerStatus(
          facts({
            tasks: [task("topic-overview", { ready: 2 })],
            lanes: [lane({ lane: codex, ...problem }), idle],
            kindLanes: { "topic-overview": routed }
          })
        );
      const onCodex = at(codex);
      expect(`${onCodex.class}.${onCodex.reason}`).toBe(key);
      // On the other lane the tasks only wait their turn.
      expect(at(priced)).toMatchObject({ state: "running", class: "waiting", reason: "queue" });
    }
  });

  it("leaves out work routed to a local model and work no route serves", () => {
    for (const routed of ["local", null])
      expect(
        composeGardenerStatus(
          facts({
            tasks: [task("topic-name", { ready: 1 })],
            lanes: [signedOut],
            kindLanes: { "topic-name": routed }
          })
        )
      ).toMatchObject({ class: "waiting", reason: "queue" });
  });

  it("takes a kind whose lane is not told as work on every remote lane", () => {
    // The decider's lane is not read (a local ranker, the generative writer or the Decisions API).
    expect(
      composeGardenerStatus(
        facts({
          tasks: [task("relation-match", { ready: 1 }), task(backfill, { ready: 1 })],
          lanes: [signedOut, idle],
          kindLanes: { [backfill]: priced }
        })
      )
    ).toMatchObject({ class: "no_model", reason: "signin_required" });
  });
});

describe("downloads", () => {
  const idleDownloads = { downloading: false, verifying: false, loading: false, etaSeconds: null };

  it("explains waiting work with the model that is arriving, and its time left", () => {
    const snapshot = composeGardenerStatus(
      facts({
        tasks: [task("topic-gate", { ready: 1 })],
        downloads: { ...idleDownloads, downloading: true, etaSeconds: 410 }
      })
    );
    expect(snapshot).toMatchObject({
      class: "download",
      reason: "model_downloading",
      eta: { kind: "duration", seconds: 420 }
    });
  });

  it("covers a model being verified and one being loaded", () => {
    const work = [task("topic-gate", { ready: 1 })];
    expect(
      composeGardenerStatus(
        facts({ tasks: work, downloads: { ...idleDownloads, verifying: true } })
      )
    ).toMatchObject({ class: "download", reason: "model_verifying" });
    expect(
      composeGardenerStatus(facts({ tasks: work, downloads: { ...idleDownloads, loading: true } }))
    ).toMatchObject({ class: "download", reason: "model_loading" });
  });

  it("stays quiet when no work waits for a model", () => {
    expect(
      composeGardenerStatus(facts({ downloads: { ...idleDownloads, downloading: true } })).state
    ).toBe("idle");
  });

  it("reads a missing model or ranker as the download that brings it", () => {
    const snapshot = composeGardenerStatus(
      facts({
        blocked: [
          blocked("topic-gate", "no_model.no_decider"),
          blocked("topic-name", "no_model.model_missing")
        ],
        downloads: { ...idleDownloads, verifying: true }
      })
    );
    expect(snapshot).toMatchObject({ class: "download", reason: "model_verifying" });
    // A route that was never chosen is still the person's to choose, download or not.
    expect(
      composeGardenerStatus(
        facts({
          blocked: [blocked("topic-gate", "no_model.no_route")],
          downloads: { ...idleDownloads, downloading: true }
        })
      )
    ).toMatchObject({ class: "no_model", reason: "no_route" });
  });
});

describe("the time left (D27)", () => {
  const samples = (ms: number, count = 5) => Array.from({ length: count }, () => ms);

  it("rounds to 30 seconds, then to a minute, then to five minutes", () => {
    expect(quantizeEtaSeconds(44)).toBe(30);
    expect(quantizeEtaSeconds(46)).toBe(60);
    expect(quantizeEtaSeconds(119)).toBe(120);
    expect(quantizeEtaSeconds(200)).toBe(180);
    expect(quantizeEtaSeconds(3_599)).toBe(3_600);
    expect(quantizeEtaSeconds(10_100)).toBe(10_200);
    expect(quantizeEtaSeconds(10_000)).toBe(9_900);
  });

  it("is the median of a kind's last tasks times the tasks ahead of it", () => {
    const eta = workEtaSeconds({
      tasks: [task("topic-place", { running: 1, ready: 9 })],
      durations: { "topic-place": [1_000, 5_000, 2_000, 2_000, 99_000_000] }
    });
    // The median is 2 s; 10 tasks ahead on the one worker take 20 s, rounded to 30.
    expect(eta).toBe(30);
  });

  it("takes only the last samples", () => {
    const durations = [...samples(600_000, 20), ...samples(1_000, 50)];
    expect(
      workEtaSeconds(
        {
          tasks: [task("topic-place", { ready: 60 })],
          durations: { "topic-place": durations }
        },
        { etaSamples: 50, etaMinSamples: 3 }
      )
    ).toBe(60);
  });

  it("runs the kinds of one worker one after another and the workers side by side", () => {
    // topic-place and topic-sweep share the compute worker; topic-name runs on the model worker.
    const base = {
      durations: {
        "topic-place": samples(10_000),
        "topic-sweep": samples(20_000),
        "topic-name": samples(60_000)
      }
    };
    expect(
      workEtaSeconds({
        ...base,
        tasks: [task("topic-place", { ready: 3 }), task("topic-sweep", { ready: 1 })]
      })
    ).toBe(60);
    expect(
      workEtaSeconds({
        ...base,
        tasks: [
          task("topic-place", { ready: 3 }),
          task("topic-sweep", { ready: 1 }),
          task("topic-name", { ready: 2 })
        ]
      })
    ).toBe(120);
  });

  it("has no estimate when a kind with work ahead has too few finished tasks", () => {
    expect(
      workEtaSeconds({
        tasks: [task("topic-place", { ready: 3 }), task("topic-name", { ready: 1 })],
        durations: { "topic-place": samples(1_000), "topic-name": samples(1_000, 2) }
      })
    ).toBeNull();
    expect(workEtaSeconds({ tasks: [task("topic-place")], durations: {} })).toBeNull();
  });

  it("counts a long queue in whole five-minute steps", () => {
    // 400 tasks of 30 s on the one worker are 12,000 s, a multiple of five minutes.
    expect(
      workEtaSeconds({
        tasks: [task("topic-name", { ready: 400 })],
        durations: { "topic-name": samples(30_000) }
      })
    ).toBe(12_000);
  });

  it("shows the work ahead in the running and waiting states", () => {
    const snapshot = composeGardenerStatus(
      facts({
        tasks: [task("topic-place", { running: 1, ready: 29 })],
        durations: { "topic-place": samples(4_000) }
      })
    );
    expect(snapshot.eta).toEqual({ kind: "duration", seconds: 120 });
  });

  it("does not show work ahead under a hold that is not about the queue", () => {
    const snapshot = composeGardenerStatus(
      facts({
        gateHolds: [hold("paused.autonomy_off")],
        tasks: [task("topic-place", { running: 1, ready: 29 })],
        durations: { "topic-place": samples(4_000) }
      })
    );
    expect(snapshot.eta).toBeUndefined();
  });

  it("shows the time a hold clears in place of the work ahead", () => {
    const snapshot = composeGardenerStatus(
      facts({
        tasks: [task("topic-name", { ready: 2 })],
        durations: { "topic-name": samples(4_000) },
        lanes: [lane({ waiting: 1, pausedForMs: 2 * minute })]
      })
    );
    expect(snapshot.eta?.kind).toBe("at");
  });

  it("never exposes a count of calls or tasks", () => {
    const snapshot = composeGardenerStatus(
      facts({
        tasks: [task("topic-name", { running: 1, ready: 40, retrying: 2 })],
        blocked: [blocked("relation-link", "cap.provider_quota", { count: 7 })],
        durations: { "topic-name": samples(4_000) },
        budget: { spentUsd: 1, capUsd: 5 }
      })
    );
    const text = JSON.stringify(snapshot);
    for (const forbidden of ["count", "calls", "tasks", "queued"])
      expect(text, forbidden).not.toContain(forbidden);
    expect(Object.keys(snapshot.params)).toEqual([]);
  });
});
