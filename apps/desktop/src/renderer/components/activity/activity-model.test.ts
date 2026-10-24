import {
  gardenerBlockerClasses,
  gardenerBlockerKey,
  gardenerBlockerReasons,
  gardenerStatusActions,
  GardenerStatusSnapshotSchema,
  type GardenerStatusSnapshot
} from "@app/domain";
import { createTranslator, supportedLanguageCodes } from "@app/i18n";
import { describe, expect, it } from "vitest";

import {
  actionButtons,
  actionEffects,
  actionsOf,
  budgetHold,
  budgetView,
  effectiveStatus,
  jobFactsOf,
  needsYouEntries,
  percentText,
  pillView,
  statusSection,
  undoKey,
  usedShare,
  withEmbedderLoading
} from "./activity-model";
import {
  activitySnapshot,
  budgetSnapshot,
  downloadingStatus,
  fixtureNow,
  idleStatus,
  jobProgress,
  money80Status,
  noRouteStatus,
  partialCoverage,
  pausedStatus,
  queueStatus,
  rateLimitedStatus,
  runningStatus,
  signInStatus
} from "./activity-fixtures";

const en = createTranslator("en");
const ready = (value: GardenerStatusSnapshot) => ({ status: "ready", value }) as const;

describe("the embedder loading as a download hold", () => {
  it("names the load when no work names it and no higher hold speaks", () => {
    for (const status of [idleStatus, runningStatus, queueStatus, rateLimitedStatus]) {
      const shown = withEmbedderLoading(status, true);
      expect(shown).toMatchObject({ state: "blocked", class: "download", reason: "model_loading" });
      expect(shown.coverage).toEqual(status.coverage);
      expect(GardenerStatusSnapshotSchema.safeParse(shown).success).toBe(true);
    }
  });

  it("leaves the status alone while a paused, no-model, cap or download hold speaks", () => {
    for (const status of [
      pausedStatus,
      noRouteStatus,
      signInStatus,
      money80Status,
      downloadingStatus
    ])
      expect(withEmbedderLoading(status, true)).toBe(status);
  });

  it("changes nothing once the load ended", () => {
    expect(withEmbedderLoading(runningStatus, false)).toBe(runningStatus);
  });

  it("is what the pill and the drawer read", () => {
    const snapshot = activitySnapshot({ status: ready(idleStatus), embedderLoading: true });
    expect(effectiveStatus(snapshot)).toMatchObject({ class: "download", reason: "model_loading" });
    expect(effectiveStatus(activitySnapshot())).toBeNull();
  });
});

describe("where a status lives in the drawer", () => {
  it("puts running and idle in Now, a hold in Waiting and a need in Needs you", () => {
    expect(statusSection(idleStatus)).toBe("now");
    expect(statusSection(runningStatus)).toBe("now");
    expect(statusSection(queueStatus)).toBe("now");
    expect(statusSection(pausedStatus)).toBe("waiting");
    expect(statusSection(rateLimitedStatus)).toBe("waiting");
    expect(statusSection(signInStatus)).toBe("needsYou");
    expect(statusSection(money80Status)).toBe("needsYou");
  });
});

describe("actions", () => {
  it("carries out every action the status can offer", () => {
    expect(Object.keys(actionEffects).sort()).toEqual([...gardenerStatusActions].sort());
    expect(actionEffects.resume.kind).toBe("resume");
    expect(actionEffects.continue_budget.kind).toBe("continueBudget");
    for (const action of gardenerStatusActions) {
      const effect = actionEffects[action];
      if (effect.kind === "navigate") expect(effect.to.view).toBe("settings");
    }
  });

  it("offers the sentence's own action, and the way out the pause near the limit names", () => {
    expect(actionsOf(idleStatus)).toEqual([]);
    expect(actionsOf(pausedStatus)).toEqual(["resume"]);
    expect(actionsOf(money80Status)).toEqual(["continue_budget", "raise_budget"]);
    expect(actionButtons(en, money80Status).map((button) => button.label)).toEqual([
      "Continue",
      "Raise the limit"
    ]);
  });

  it("labels every action in every locale", () => {
    for (const locale of supportedLanguageCodes)
      for (const action of gardenerStatusActions) {
        const [button] = actionButtons(createTranslator(locale), {
          ...pausedStatus,
          action
        });
        expect(button?.label, `${locale} ${action}`).toBeTruthy();
        expect(button?.label).not.toContain("[[missing");
      }
  });
});

describe("the budget's own hold", () => {
  it("reads the pause near the limit and the limit reached, nothing else", () => {
    expect(budgetHold(budgetSnapshot(), partialCoverage)).toBeNull();
    expect(
      budgetHold(budgetSnapshot({ state: "paused", continued: true }), partialCoverage)
    ).toBeNull();
    expect(budgetHold(budgetSnapshot({ state: "paused" }), partialCoverage)).toMatchObject({
      state: "attention",
      class: "cap",
      reason: "money_80",
      action: "continue_budget",
      params: { spentUsd: 1.2, capUsd: 5 }
    });
    expect(
      budgetHold(budgetSnapshot({ state: "exhausted", spentUsd: 5 }), partialCoverage)
    ).toMatchObject({ reason: "money_100", action: "raise_budget" });
  });

  it("builds snapshots the status contract accepts", () => {
    for (const state of ["paused", "exhausted"] as const) {
      const hold = budgetHold(budgetSnapshot({ state }), partialCoverage)!;
      expect(GardenerStatusSnapshotSchema.safeParse(hold).success).toBe(true);
    }
  });
});

describe("what needs the person", () => {
  const entries = (status: GardenerStatusSnapshot, budget = budgetSnapshot()) =>
    needsYouEntries({ t: en, status, budget, now: fixtureNow });

  it("lists nothing for a calm library", () => {
    expect(entries(idleStatus)).toEqual([]);
    expect(entries(pausedStatus)).toEqual([]);
  });

  it("lists the status's own need with its actions", () => {
    const [entry, ...rest] = entries(signInStatus);
    expect(rest).toEqual([]);
    expect(entry?.sentence.headline).toContain("sign in");
    expect(entry?.actions.map((action) => action.id)).toEqual(["sign_in"]);
  });

  it("adds the budget's hold when a higher hold hides it, and never twice", () => {
    const paused = budgetSnapshot({ state: "paused", spentUsd: 4.1 });
    expect(entries(signInStatus, paused).map((entry) => entry.key)).toEqual(["status", "budget"]);
    expect(entries(money80Status, paused).map((entry) => entry.key)).toEqual(["status"]);
    expect(entries(idleStatus, paused).map((entry) => entry.key)).toEqual(["budget"]);
  });

  it("works without the meters", () => {
    expect(entries(signInStatus, null as never).map((entry) => entry.key)).toEqual(["status"]);
  });
});

describe("the pill", () => {
  it("says it is checking, then that the status is unavailable", () => {
    expect(pillView(en, activitySnapshot())).toEqual({
      glyph: "loading",
      text: "Checking what is happening...",
      badge: 0
    });
    expect(pillView(en, activitySnapshot({ status: { status: "error" } }))).toMatchObject({
      glyph: "error",
      text: "Activity is not available right now."
    });
  });

  it("shows the sentence with a glyph for each state, and the time left", () => {
    const view = (status: GardenerStatusSnapshot) =>
      pillView(en, activitySnapshot({ status: ready(status) }));
    expect(view(idleStatus)).toMatchObject({
      glyph: "check",
      text: "Your library is up to date."
    });
    expect(view(runningStatus)).toMatchObject({ glyph: "working" });
    expect(view(runningStatus).text).toContain("About 10 minutes left.");
    expect(view(pausedStatus)).toMatchObject({ glyph: "waiting" });
    expect(view(signInStatus)).toMatchObject({ glyph: "attention" });
    expect(view(rateLimitedStatus).text).toMatch(/Resumes around/);
  });

  it("carries the Inbox count as a badge and shows the embedder loading", () => {
    const view = pillView(
      en,
      activitySnapshot({ status: ready(idleStatus), inboxTotal: 3, embedderLoading: true })
    );
    expect(view).toMatchObject({ glyph: "waiting", badge: 3 });
    expect(view.text).toContain("loading into memory");
  });

  it("speaks every hold in every locale", () => {
    for (const locale of supportedLanguageCodes) {
      const t = createTranslator(locale);
      for (const blockerClass of gardenerBlockerClasses)
        for (const reason of gardenerBlockerReasons[blockerClass]) {
          const key = gardenerBlockerKey({ class: blockerClass, reason });
          const status = GardenerStatusSnapshotSchema.parse({
            state: "blocked",
            class: blockerClass,
            reason,
            params: { routeClass: "embed", spentUsd: 4, capUsd: 5 },
            coverage: partialCoverage
          });
          const { text } = pillView(t, activitySnapshot({ status: ready(status) }));
          expect(text, `${locale} ${key}`).not.toMatch(/\[\[missing|\{\w+\}/);
          expect(text.length).toBeGreaterThan(0);
        }
    }
  });
});

describe("numbers", () => {
  it("shows a whole percent in the interface locale", () => {
    expect(percentText("en", 0.92)).toBe("92%");
    expect(percentText("pt-BR", 1)).toBe("100%");
    expect(percentText("en", 1.4)).toBe("100%");
    expect(percentText("en", -1)).toBe("0%");
  });

  it("rounds a used share down, so a limit never reads full early", () => {
    expect(usedShare(4.999, 5)).toBe(0.99);
    expect(usedShare(5, 5)).toBe(1);
    expect(usedShare(0, 5)).toBe(0);
    expect(usedShare(1, 0)).toBe(1);
    expect(usedShare(0, 0)).toBe(0);
  });

  it("views the month's spend against the limit and the subscription's allowance", () => {
    expect(budgetView("en", budgetSnapshot())).toEqual({
      money: { spent: "$1.20", cap: "$5.00", share: 0.24, state: "open" },
      subscription: null
    });
    const view = budgetView(
      "en",
      budgetSnapshot({ state: "paused", spentUsd: 4.1 }, { usedCalls: 190, reservedCalls: 10 })
    );
    expect(view.money).toMatchObject({ share: 0.82, state: "paused" });
    expect(view.subscription).toEqual({ share: 0.25 });
  });
});

describe("job counts", () => {
  it("add the lanes together and name no lane", () => {
    expect(
      jobFactsOf(
        jobProgress({ running: 1, queued: 4, blocked: 2 }, { running: 1, queued: 3, blocked: 0 })
      )
    ).toEqual({ running: 2, waiting: 7, onHold: 2 });
  });
});

describe("keys", () => {
  it("names an undo by the store and the change-set", () => {
    expect(undoKey({ kind: "relation", id: "00000000-0000-4000-8000-000000000001" })).toBe(
      "relation:00000000-0000-4000-8000-000000000001"
    );
  });
});
