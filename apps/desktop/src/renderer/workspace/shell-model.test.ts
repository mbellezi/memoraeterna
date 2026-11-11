import { describe, expect, it } from "vitest";
import { createTranslator, supportedLanguageCodes } from "@app/i18n";

import { appDestinationIds, legacyViewIds } from "../../shared/app-menu";
import { destinationIds } from "./destinations";
import { layoutConfig, tierFor } from "./layout-config";
import {
  hasNavigator,
  layoutCustomProperties,
  legacyHostFor,
  legacyTitleKeys,
  menuDestinationIds,
  navigatorDestinations,
  nextRegion,
  pillDropsWaiting,
  railDestinations,
  regionIds,
  titleBarLayout,
  titleBarMetrics
} from "./shell-model";

describe("the five destinations", () => {
  it("are exactly five, in rail order, and the menu names the same five", () => {
    expect(railDestinations).toEqual(["home", "explore", "library", "inbox", "map"]);
    expect(railDestinations).toHaveLength(5);
    expect(railDestinations).toEqual([...destinationIds]);
    expect(menuDestinationIds).toEqual([...appDestinationIds]);
  });

  it("each hosts an old view until its replacement lands, and Home and the Library may share one", () => {
    expect(Object.keys(legacyHostFor).sort()).toEqual([...railDestinations].sort());
  });
});

describe("the navigator", () => {
  it("exists in Explore only, so Cmd-\\ acts nowhere else", () => {
    expect(navigatorDestinations).toEqual(["explore"]);
    expect(hasNavigator("explore")).toBe(true);
    for (const place of ["home", "library", "inbox", "map", "settings"] as const)
      expect(hasNavigator(place), place).toBe(false);
  });
});

describe("the old screens", () => {
  it("are named by an existing message each, in the order the menu lists them", () => {
    expect(Object.keys(legacyTitleKeys)).toEqual([...legacyViewIds]);
    for (const language of supportedLanguageCodes) {
      const t = createTranslator(language);
      for (const key of Object.values(legacyTitleKeys))
        expect(t(key, { missingKeyBehavior: "throw" }), `${language} ${key}`).not.toBe("");
    }
  });
});

describe("the custom properties", () => {
  it("are one tier of layout-config at each window width", () => {
    for (const width of [960, 1179, 1180, 1280, 1439, 1440, 1920]) {
      const tier = tierFor(width);
      const props = layoutCustomProperties(width);
      expect(props["--rail-w"], String(width)).toBe(`${tier.railW}px`);
      expect(props["--nav-w"]).toBe(`${tier.navW}px`);
      expect(props["--ctx-w"]).toBe(`${tier.ctxW}px`);
      expect(props["--prev-w"]).toBe(`${tier.prevW}px`);
      expect(props["--spine-w"]).toBe(`${tier.spineW}px`);
      expect(props["--row-h"]).toBe(`${tier.rowH}px`);
      expect(props["--ind"]).toBe(`${tier.ind}px`);
      expect(props["--top-pl"]).toBe(`${tier.topPl}px`);
      expect(props["--top-gap"]).toBe(`${tier.topGap}px`);
      expect(props["--top-min"]).toBe(`${layoutConfig.topMin}px`);
      expect(props["--omni-min"]).toBe(`${layoutConfig.omniMin}px`);
      expect(props["--top-h"]).toBe("48px");
    }
  });

  it("make the rail 64 px below 1180 and 72 px from it", () => {
    expect(layoutCustomProperties(1179)["--rail-w"]).toBe("64px");
    expect(layoutCustomProperties(960)["--rail-w"]).toBe("64px");
    expect(layoutCustomProperties(1180)["--rail-w"]).toBe("72px");
  });
});

/**
 * The longest sentence the pill can say, over every language: the longest status message the
 * Gardener has (with its time left) plus both clauses. Measured at 13 px Inter, a character is
 * about 7 px wide.
 */
function longestPill(): { text: string; px: number } {
  let text = "";
  for (const language of supportedLanguageCodes) {
    const t = createTranslator(language);
    const strings = [
      t("gardener.status.idle"),
      t("gardener.status.running"),
      t("gardener.status.paused.only_ac_on_battery"),
      t("gardener.status.paused.autonomy_off"),
      t("gardener.status.cap.money_100"),
      t("gardener.status.no_model.model_missing"),
      t("gardener.status.waiting.queue"),
      t("gardener.status.waiting.same_scope")
    ];
    const longest = strings.reduce((a, b) => (a.length >= b.length ? a : b));
    const sentence = `${longest} ${t("gardener.status.eta.duration", { values: { duration: "12 minutes" } })} · ${t("workspace.status.waiting", { values: { count: 12 } })} | ${t("workspace.status.needsYouMany", { values: { count: 12 } })}`;
    if (sentence.length > text.length) text = sentence;
  }
  return { text, px: Math.ceil(text.length * 7) + 56 };
}

describe("the title bar grid", () => {
  it("keeps the omni trigger at least 240 px at 960 px with the longest pill sentence, and the pill truncates", () => {
    const layout = titleBarLayout(960);
    const pill = longestPill();
    expect(layout.omni).toBeGreaterThanOrEqual(layoutConfig.omniMin);
    // The sentence needs more than the slot has: it truncates inside the pill, it never reflows.
    expect(pill.px).toBeGreaterThan(layout.status);
    expect(layout.status).toBeGreaterThan(0);
    expect(layout.status).toBeLessThanOrEqual(titleBarMetrics.statusMax);
  });

  it("never lets two columns overlap: the columns and their gaps fit the bar at every width", () => {
    for (let width = 960; width <= 2560; width += 10) {
      const tier = tierFor(width);
      const layout = titleBarLayout(width);
      // The unused gap is left out on purpose: it is derived from the other columns, so adding it
      // back would make the sum equal the bar by construction. The four columns, the three flex gaps
      // and both paddings must fit on their own.
      const used =
        tier.topPl +
        layout.name +
        layout.omni +
        layout.status +
        layout.add +
        titleBarMetrics.padRight +
        3 * tier.topGap;
      expect(used, String(width)).toBeLessThanOrEqual(width - tier.railW + 0.001);
      expect(layout.gap, String(width)).toBeGreaterThanOrEqual(0);
      expect(layout.omni, String(width)).toBeGreaterThanOrEqual(layoutConfig.omniMin);
      expect(layout.omni, String(width)).toBeLessThanOrEqual(titleBarMetrics.omniMax);
      expect(layout.status, String(width)).toBeLessThanOrEqual(titleBarMetrics.statusMax);
    }
  });

  it("starts the omni trigger at the navigator's edge at every width, so it never moves between screens", () => {
    for (const width of [960, 1180, 1280, 1440, 1800]) {
      const tier = tierFor(width);
      const { name } = titleBarLayout(width);
      // Left padding, the name column and one gap: the same x as the end of rail plus navigator.
      expect(tier.topPl + name + tier.topGap, String(width)).toBe(tier.navW);
    }
  });

  it("gives the trigger and the slot the room they ask for at 1440 px", () => {
    const layout = titleBarLayout(1440);
    expect(layout.omni).toBe(titleBarMetrics.omniMax);
    expect(layout.status).toBe(titleBarMetrics.statusMax);
  });

  it("drops the pill's waiting clause from the compact tier down", () => {
    expect(pillDropsWaiting(960)).toBe(true);
    expect(pillDropsWaiting(1179)).toBe(true);
    expect(pillDropsWaiting(1180)).toBe(false);
  });
});

describe("F6 regions", () => {
  it("cycle rail, top bar, navigator, stack, context, over the regions on screen", () => {
    const all = [...regionIds];
    expect(nextRegion(all, null, 1)).toBe("rail");
    expect(nextRegion(all, "rail", 1)).toBe("titleBar");
    expect(nextRegion(all, "titleBar", 1)).toBe("navigator");
    expect(nextRegion(all, "context", 1)).toBe("rail");
    expect(nextRegion(all, "rail", -1)).toBe("context");
    expect(nextRegion(all, null, -1)).toBe("context");
    // Without a navigator (any destination but Explore) the top bar leads to the stack.
    const without = all.filter((id) => id !== "navigator");
    expect(nextRegion(without, "titleBar", 1)).toBe("stack");
    expect(nextRegion(without, "stack", -1)).toBe("titleBar");
    expect(nextRegion([], "rail", 1)).toBeNull();
  });
});
