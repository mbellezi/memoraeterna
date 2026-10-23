import { describe, expect, it } from "vitest";

import {
  BackgroundBlockedError,
  GardenerBlockerSchema,
  backgroundBlockerOf,
  compareGardenerBlockers,
  gardenerBlocker,
  gardenerBlockerClasses,
  gardenerBlockerClearing,
  gardenerBlockerKey,
  gardenerBlockerKeys,
  gardenerBlockerReasons,
  gardenerClearingEvents,
  gardenerReasonsClearedBy,
  gardenerTimeClearedReasons,
  highestGardenerBlocker,
  isBackgroundBlocked,
  parseGardenerBlockerKey
} from "./blockers.js";

describe("gardener blockers", () => {
  it("orders classes paused > no_model > cap > download > waiting > offline (D7)", () => {
    expect(gardenerBlockerClasses).toEqual([
      "paused",
      "no_model",
      "cap",
      "download",
      "waiting",
      "offline"
    ]);
    const one = (blockerClass: (typeof gardenerBlockerClasses)[number]) =>
      ({ class: blockerClass, reason: gardenerBlockerReasons[blockerClass][0] }) as never;
    for (let index = 1; index < gardenerBlockerClasses.length; index++)
      expect(
        compareGardenerBlockers(
          one(gardenerBlockerClasses[index - 1]!),
          one(gardenerBlockerClasses[index]!)
        )
      ).toBeLessThan(0);
  });

  it("lists the reasons of spec 3.1, each with one stable key", () => {
    expect(gardenerBlockerReasons.paused).toEqual([
      "user_pause",
      "autonomy_off",
      "only_idle_user_active",
      "only_ac_on_battery"
    ]);
    expect(gardenerBlockerReasons.no_model).toEqual([
      "no_route",
      "model_missing",
      "no_decider",
      "signin_required",
      "space_changed"
    ]);
    expect(gardenerBlockerReasons.cap).toEqual([
      "money_80",
      "money_100",
      "subscription_daily",
      "provider_quota",
      "feature_daily"
    ]);
    expect(gardenerBlockerReasons.offline).toEqual(["network_unreachable"]);
    expect(gardenerBlockerKeys).toHaveLength(25);
    expect(new Set(gardenerBlockerKeys).size).toBe(gardenerBlockerKeys.length);
    // Keys never carry a variable part: the route class of `no_route` is a parameter.
    for (const key of gardenerBlockerKeys) expect(key).toMatch(/^[a-z_]+\.[a-z_0-9]+$/u);
    expect(
      gardenerBlocker("no_model", "no_route", { params: { routeClass: "write-fast" } })
    ).toEqual({ class: "no_model", reason: "no_route", params: { routeClass: "write-fast" } });
  });

  it("picks the highest blocker of a set, the class first, then the reason's place", () => {
    expect(highestGardenerBlocker([])).toBeNull();
    const top = highestGardenerBlocker([
      gardenerBlocker("waiting", "queue"),
      null,
      gardenerBlocker("cap", "feature_daily"),
      gardenerBlocker("cap", "money_80"),
      gardenerBlocker("offline", "network_unreachable")
    ]);
    expect(top).toEqual({ class: "cap", reason: "money_80" });
    expect(
      highestGardenerBlocker([
        gardenerBlocker("paused", "only_ac_on_battery"),
        gardenerBlocker("paused", "user_pause")
      ])
    ).toEqual({ class: "paused", reason: "user_pause" });
  });

  it("parses stored pairs and refuses a reason of another class", () => {
    expect(parseGardenerBlockerKey("cap", "money_100")).toEqual({
      class: "cap",
      reason: "money_100"
    });
    expect(parseGardenerBlockerKey("cap", "user_pause")).toBeNull();
    expect(parseGardenerBlockerKey(null, null)).toBeNull();
    expect(GardenerBlockerSchema.safeParse({ class: "paused", reason: "no_route" }).success).toBe(
      false
    );
    expect(
      GardenerBlockerSchema.parse({ class: "waiting", reason: "provider_rate_limit", clearsAt: 5 })
    ).toEqual({ class: "waiting", reason: "provider_rate_limit", clearsAt: 5 });
  });

  it("gives every reason a way to clear: an event or its run_after, never neither", () => {
    expect(Object.keys(gardenerBlockerClearing).sort()).toEqual([...gardenerBlockerKeys].sort());
    for (const key of gardenerBlockerKeys) {
      const clearing = gardenerBlockerClearing[key];
      expect(clearing.events.length > 0 || clearing.atRunAfter, key).toBe(true);
    }
    const cleared = new Set(
      gardenerClearingEvents.flatMap((event) => gardenerReasonsClearedBy(event))
    );
    for (const key of gardenerBlockerKeys)
      expect(cleared.has(key) || gardenerTimeClearedReasons.includes(key), key).toBe(true);
  });

  it("clears exactly the reasons of an event", () => {
    expect(gardenerReasonsClearedBy("day_rollover")).toEqual([
      "cap.subscription_daily",
      "cap.feature_daily"
    ]);
    expect(gardenerReasonsClearedBy("month_rollover")).toEqual(["cap.money_80", "cap.money_100"]);
    expect(gardenerReasonsClearedBy("budget_continued")).toEqual(["cap.money_80"]);
    expect(gardenerReasonsClearedBy("download_settled")).toEqual([
      "no_model.model_missing",
      "no_model.no_decider",
      "download.model_downloading",
      "download.model_verifying",
      "download.model_loading"
    ]);
    expect(gardenerReasonsClearedBy("power_changed")).toEqual([
      "paused.only_idle_user_active",
      "paused.only_ac_on_battery"
    ]);
    expect(gardenerTimeClearedReasons).toContain("waiting.provider_rate_limit");
    expect(gardenerTimeClearedReasons).toContain("cap.provider_quota");
    expect(gardenerTimeClearedReasons).not.toContain("paused.user_pause");
    expect(gardenerTimeClearedReasons).not.toContain("cap.money_100");
  });

  it("recognizes a background refusal by shape, with its blocker", () => {
    const blocker = gardenerBlocker("paused", "user_pause");
    const error = new BackgroundBlockedError(blocker);
    expect(error.message).toBe("Background work is held: paused.user_pause");
    expect(isBackgroundBlocked(error)).toBe(true);
    expect(backgroundBlockerOf(error)).toEqual(blocker);
    // A copy of the class from another bundle carries the same code and blocker.
    expect(backgroundBlockerOf({ code: "gardener.blocked", blocker })).toEqual(blocker);
    expect(isBackgroundBlocked(new Error("paused"))).toBe(false);
    expect(isBackgroundBlocked({ code: "gardener.blocked", blocker: { class: "paused" } })).toBe(
      false
    );
    expect(gardenerBlockerKey(blocker)).toBe("paused.user_pause");
  });
});
