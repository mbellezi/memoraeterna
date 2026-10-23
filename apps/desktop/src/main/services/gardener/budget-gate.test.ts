import {
  defaultKnowledgeControls,
  gardenerBlocker,
  type AiClassId,
  type BudgetSnapshot
} from "@app/domain";
import { describe, expect, it, vi } from "vitest";

import { BackgroundGate } from "./background-gate.js";
import { BudgetRelay, RemoteBudgetGate, budgetBlocker, type RouteMetering } from "./budget-gate.js";

function meters(
  money: BudgetSnapshot["money"]["state"],
  calls: BudgetSnapshot["calls"]["state"] = "open"
): BudgetSnapshot {
  return {
    month: "2026-10",
    day: "2026-10-23",
    money: {
      spentUsd: 0,
      reservedUsd: 0,
      capUsd: 5,
      pauseShare: 0.8,
      continued: false,
      state: money,
      priceTableVersion: "v"
    },
    calls: { usedCalls: 0, reservedCalls: 0, capCalls: 800, state: calls }
  };
}

function setup(routes: Partial<Record<AiClassId, RouteMetering>>) {
  const state = { snapshot: meters("open") };
  const budgetGate = new RemoteBudgetGate({
    snapshot: async () => state.snapshot,
    metering: async (routeClass) => routes[routeClass] ?? "none"
  });
  const gate = new BackgroundGate({
    controls: () => defaultKnowledgeControls,
    power: () => ({ active: false, onBattery: false, idleMs: 0, overridden: false }),
    kindGates: [budgetGate]
  });
  return { state, budgetGate, gate };
}

const kinds = ["topic-place", "topic-name", "topic-label-embed", "relation-link", "relation-match"];

describe("the budget gate at claim (F4 D7, D14)", () => {
  it("names the cap reason of a metered route, never one of a local route", () => {
    expect(budgetBlocker(meters("paused"), "money")).toEqual(gardenerBlocker("cap", "money_80"));
    expect(budgetBlocker(meters("exhausted"), "money")).toEqual(
      gardenerBlocker("cap", "money_100")
    );
    expect(budgetBlocker(meters("open", "exhausted"), "calls")).toEqual(
      gardenerBlocker("cap", "subscription_daily")
    );
    expect(budgetBlocker(meters("exhausted", "exhausted"), "none")).toBeNull();
    // A subscription route is not held by the money cap, a priced one not by the call cap.
    expect(budgetBlocker(meters("exhausted"), "calls")).toBeNull();
    expect(budgetBlocker(meters("open", "exhausted"), "money")).toBeNull();
  });

  it("holds the background kinds whose route the budget refuses, from its last read", async () => {
    const { state, budgetGate, gate } = setup({ "write-fast": "money", embed: "none" });
    expect(gate.heldKinds(kinds)).toEqual(new Set());
    state.snapshot = meters("exhausted");
    // Nothing changes before the gate reads the budget again: the claim path never waits on it.
    expect(gate.heldKinds(kinds)).toEqual(new Set());
    expect(await budgetGate.refresh()).toBe(true);
    // Naming writes on the priced route; label embedding runs locally; placement calls no model;
    // the mixed link kind is held only at admission, never at claim.
    expect(gate.forKinds(kinds)).toEqual(
      new Map([["topic-name", gardenerBlocker("cap", "money_100")]])
    );
    expect(gate.activeReasons(kinds).has("cap.money_100")).toBe(true);
    expect(gate.evaluatedReasons()).toEqual(
      expect.arrayContaining(["cap.money_80", "cap.money_100", "cap.subscription_daily"])
    );
    expect(await budgetGate.refresh()).toBe(false);
    // The person continued, or the month rolled over: the gate holds nothing and its rows clear.
    state.snapshot = meters("open");
    expect(await budgetGate.refresh()).toBe(true);
    expect(gate.heldKinds(kinds)).toEqual(new Set());
    expect(gate.activeReasons(kinds).has("cap.money_100")).toBe(false);
  });

  it("holds a subscription route at its daily calls only", async () => {
    const { state, budgetGate, gate } = setup({ "write-fast": "calls", embed: "money" });
    state.snapshot = meters("exhausted", "exhausted");
    await budgetGate.refresh();
    expect(gate.forKinds(kinds)).toEqual(
      new Map([
        ["topic-name", gardenerBlocker("cap", "subscription_daily")],
        ["topic-label-embed", gardenerBlocker("cap", "money_100")]
      ])
    );
  });
});

describe("the budget relay", () => {
  function relay(changed = true) {
    const snapshots: BudgetSnapshot[] = [];
    let reads = 0;
    const blockers = {
      reconcile: vi.fn(async () => undefined),
      notify: vi.fn(async () => undefined)
    };
    const gate = { refresh: vi.fn(async () => changed) };
    const budget = {
      snapshot: vi.fn(async () => {
        reads += 1;
        return meters("paused");
      }),
      continuePastPause: vi.fn(async () => ({ ...meters("open") }))
    };
    const instance = new BudgetRelay({
      budget,
      gate,
      blockers: () => blockers,
      publish: (snapshot) => snapshots.push(snapshot)
    });
    return { instance, snapshots, blockers, gate, budget, reads: () => reads };
  }

  it("reads the meters once per burst of changes, publishes them and re-gates when the gate moved", async () => {
    const { instance, snapshots, blockers, reads } = relay();
    instance.changed();
    instance.changed();
    instance.changed();
    await instance.settled();
    // The first change reads at once; the burst behind it costs one more read, not two.
    expect(reads()).toBe(2);
    expect(snapshots).toHaveLength(2);
    expect(blockers.reconcile).toHaveBeenCalledTimes(2);
  });

  it("re-gates nothing when what the gate holds did not change", async () => {
    const { instance, blockers } = relay(false);
    instance.changed();
    await instance.settled();
    expect(blockers.reconcile).not.toHaveBeenCalled();
  });

  it("continues past the pause share: the budget records it, the gate reads it, the rows go free", async () => {
    const { instance, blockers, gate, budget } = relay();
    await expect(instance.continuePastPause()).resolves.toMatchObject({
      money: { state: "open" }
    });
    expect(budget.continuePastPause).toHaveBeenCalledOnce();
    expect(gate.refresh).toHaveBeenCalledOnce();
    expect(blockers.notify).toHaveBeenCalledWith("budget_continued");
  });
});
