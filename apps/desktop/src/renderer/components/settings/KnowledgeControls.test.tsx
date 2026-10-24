import { renderToStaticMarkup } from "react-dom/server";
import { defaultKnowledgeControls, type BudgetSnapshot, type KnowledgeControls } from "@app/domain";
import { createTranslator, supportedLanguageCodes } from "@app/i18n";
import { describe, expect, it } from "vitest";

import { knowledgeControlDomIds } from "../../../shared/settings-registry";
import { KnowledgeControlsView } from "./KnowledgeControls";
import type { KnowledgeControlsState } from "./knowledge-controls-state";

const money = (override: Partial<BudgetSnapshot["money"]> = {}): BudgetSnapshot["money"] => ({
  spentUsd: 1.5,
  reservedUsd: 0,
  capUsd: 5,
  pauseShare: 0.8,
  continued: false,
  state: "open",
  priceTableVersion: "test",
  ...override
});

const ready = (
  controls: KnowledgeControls = defaultKnowledgeControls,
  extra: Partial<Extract<KnowledgeControlsState, { phase: "ready" }>> = {}
): KnowledgeControlsState => ({
  phase: "ready",
  saved: controls,
  shown: controls,
  saving: 0,
  outcome: "idle",
  ...extra
});

function render(
  state: KnowledgeControlsState,
  options: {
    locale?: Parameters<typeof createTranslator>[0];
    spend?: BudgetSnapshot["money"] | null;
  } = {}
) {
  return renderToStaticMarkup(
    <KnowledgeControlsView
      t={createTranslator(options.locale ?? "en")}
      state={state}
      spend={options.spend ?? null}
      onEdit={() => undefined}
      onRetry={() => undefined}
    />
  );
}

const tag = (html: string, id: string) =>
  html.match(new RegExp(`<(?:input|select)[^>]*id="${id}"[^>]*>`, "u"))?.[0] ?? "";

describe("Settings › Knowledge: the six controls", () => {
  it("shows a status while the controls load, and no control", () => {
    const html = render({ phase: "loading" });
    expect(html).toMatch(/role="status"[^>]*>[^]*Loading the controls/u);
    for (const id of Object.values(knowledgeControlDomIds))
      expect(html).not.toContain(`id="${id}"`);
  });

  it("keeps a failed read visible, with the way to try again", () => {
    const html = render({ phase: "error" });
    expect(html).toContain('role="alert"');
    expect(html).toContain("The controls could not be loaded.");
    expect(html).toContain("Try again");
    for (const id of Object.values(knowledgeControlDomIds))
      expect(html).not.toContain(`id="${id}"`);
  });

  it("shows the six controls with their defaults, each with a label and a description", () => {
    const html = render(ready());
    const ids = Object.values(knowledgeControlDomIds);
    expect(ids).toHaveLength(6);
    for (const id of ids) {
      expect(html, id).toContain(`id="${id}"`);
      expect(html, id).toContain(`for="${id}"`);
    }
    expect(html).toMatch(/<option value="auto" selected="">Automatic<\/option>/u);
    expect(tag(html, knowledgeControlDomIds.monthlyCapUsd)).toContain('value="5"');
    expect(tag(html, knowledgeControlDomIds.paused)).not.toContain("checked");
    expect(html).toMatch(/<option value="balanced" selected="">Balanced<\/option>/u);
    expect(tag(html, knowledgeControlDomIds.onlyIdle)).not.toContain("checked");
    expect(tag(html, knowledgeControlDomIds.onlyOnAc)).not.toContain("checked");
    // Booleans are switches, choices are selects, the cap is a number.
    expect(tag(html, knowledgeControlDomIds.paused)).toContain('type="checkbox"');
    expect(tag(html, knowledgeControlDomIds.monthlyCapUsd)).toContain('type="number"');
    expect(html).toContain("Automatic organizing");
  });

  it("describes the chosen autonomy and tree shape, and says a new shape is reviewed first", () => {
    const html = render(
      ready({ ...defaultKnowledgeControls, autonomy: "suggest", treeShape: "deep" })
    );
    expect(html).toContain("Proposes what it would change and waits for your review");
    expect(html).not.toContain("Applies its changes and keeps each one undoable");
    expect(html).toContain("More levels, with fewer topics on each.");
    expect(html).toContain("Nothing moves until you review it");
    for (const id of [knowledgeControlDomIds.autonomy, knowledgeControlDomIds.treeShape])
      expect(tag(html, id)).toContain(`aria-describedby="${id}-help"`);
  });

  it("shows the stored values", () => {
    const html = render(
      ready({
        autonomy: "off",
        monthlyCapUsd: 12.5,
        paused: true,
        treeShape: "broad",
        onlyIdle: true,
        onlyOnAc: true
      })
    );
    expect(html).toMatch(/<option value="off" selected="">Off<\/option>/u);
    expect(tag(html, knowledgeControlDomIds.monthlyCapUsd)).toContain('value="12.5"');
    expect(html).toMatch(/<option value="broad" selected="">Broad<\/option>/u);
    for (const id of [
      knowledgeControlDomIds.paused,
      knowledgeControlDomIds.onlyIdle,
      knowledgeControlDomIds.onlyOnAc
    ])
      expect(tag(html, id), id).toContain('checked=""');
  });

  it("follows a save: saving, saved, and a failure that puts the old value back", () => {
    expect(render(ready(defaultKnowledgeControls, { saving: 1 }))).toContain("Saving…");
    expect(render(ready(defaultKnowledgeControls, { outcome: "saved" }))).toContain("Saved.");
    const failed = render(ready(defaultKnowledgeControls, { outcome: "failed" }));
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("The change could not be saved. The previous value is back.");
    // Always one polite region for the quiet states, so a change is announced.
    expect(render(ready())).toMatch(/<p role="status"[^>]*><\/p>/u);
  });

  it("shows the month's spend against the cap, and why remote work waits near it", () => {
    expect(render(ready(), { spend: null })).not.toContain("spent this month");
    const open = render(ready(), { spend: money() });
    expect(open).toContain("$1.50 of $5.00 spent this month");
    expect(open).not.toContain("Continue it from the Activity panel");
    expect(render(ready(), { spend: money({ state: "paused" }) })).toContain(
      "Remote background work is paused near the cap."
    );
    expect(render(ready(), { spend: money({ state: "exhausted", spentUsd: 5 }) })).toContain(
      "The cap is reached."
    );
  });

  it("explains that a subscription is counted in calls, not money", () => {
    expect(render(ready())).toContain("Subscription models such as Codex are not metered in money");
  });

  it("is written in every interface language", () => {
    const english = render(ready(), { spend: money({ state: "paused" }) });
    for (const locale of supportedLanguageCodes) {
      const t = createTranslator(locale);
      const html = render(ready(), { locale, spend: money({ state: "paused" }) });
      for (const key of [
        "settings.knowledge.title",
        "settings.knowledge.autonomy.label",
        "settings.knowledge.cap.label",
        "settings.knowledge.pause.label",
        "settings.knowledge.treeShape.label",
        "settings.knowledge.onlyIdle.label",
        "settings.knowledge.onlyOnAc.label",
        "settings.knowledge.treeShape.note",
        "settings.knowledge.cap.state.paused"
      ] as const)
        expect(html, `${locale} ${key}`).toContain(t(key).replaceAll("&", "&amp;"));
      expect(html, locale).not.toContain("[[missing");
      if (locale !== "en") expect(html, locale).not.toBe(english);
    }
    // The failure states exist in every language too.
    for (const locale of supportedLanguageCodes) {
      const t = createTranslator(locale);
      expect(render({ phase: "error" }, { locale })).toContain(
        t("settings.knowledge.states.retry")
      );
      expect(render(ready(defaultKnowledgeControls, { outcome: "failed" }), { locale })).toContain(
        t("settings.knowledge.states.saveFailed")
      );
    }
  });
});
