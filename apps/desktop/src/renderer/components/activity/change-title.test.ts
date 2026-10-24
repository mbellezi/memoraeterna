import {
  overviewChangeOrigins,
  relationChangeSetKinds,
  relationRunTitleKey,
  type ChangeSetSummary
} from "@app/domain";
import { createTranslator, supportedLanguageCodes } from "@app/i18n";
import { describe, expect, it } from "vitest";

import { changeSetTitle } from "./change-title";

const en = createTranslator("en");
const title = (titleKey: string, titleParams: ChangeSetSummary["titleParams"] = {}) =>
  changeSetTitle(en, { titleKey, titleParams });

describe("the sentence of a change-set", () => {
  it("fills the stored parameters, numbers in the interface locale", () => {
    expect(title("topics.changeSets.place", { items: 12 })).toBe("Placed 12 items in topics");
    expect(title("topics.changeSets.place", { items: 12_345 })).toBe(
      "Placed 12,345 items in topics"
    );
    expect(
      changeSetTitle(createTranslator("pt-BR"), {
        titleKey: "topics.changeSets.place",
        titleParams: { items: 12_345 }
      })
    ).toContain("12.345");
  });

  it("keeps a stored name as it is", () => {
    expect(title("changes.titles.relationMatched", { note: "Memory {palace}" })).toBe(
      "Connections checked for “Memory {palace}”"
    );
  });

  it("reads a key it does not know as a plain change, never as the key", () => {
    expect(title("topics.changeSets.unknown")).toBe("A change was made to your library.");
    expect(title("something.else.entirely")).toBe("A change was made to your library.");
    expect(title("toString")).toBe("A change was made to your library.");
  });

  it("words the topic engine's area regrouping and its undo, whatever the undone key", () => {
    expect(title("topics.changeSets.areas", { areas: 7, topics: 31 })).toBe(
      "Regrouped the top areas: 7 areas, 31 topics moved"
    );
    expect(title("topics.changeSets.undo", { undone: "topics.changeSets.rebalance" })).toBe(
      "Undid an earlier change to the topics"
    );
  });

  it("reads an unknown key as the plain sentence its host asks for", () => {
    expect(
      changeSetTitle(en, { titleKey: "nope", titleParams: {} }, "inbox.items.review.title")
    ).toBe(en("inbox.items.review.title"));
  });

  it("reads a title with a parameter missing as a plain change, never with a bare {name}", () => {
    expect(title("topics.changeSets.place")).toBe("A change was made to your library.");
    expect(title("topics.changeSets.place", { items: null })).toBe(
      "A change was made to your library."
    );
    expect(title("topics.changeSets.place", { items: true })).toBe(
      "A change was made to your library."
    );
  });

  it("covers every title the stores write, in every locale, without a bare parameter", () => {
    const keys = [
      "topics.changeSets.place",
      "topics.changeSets.build",
      "topics.changeSets.rebuild",
      "topics.changeSets.space",
      "topics.changeSets.rebalance",
      "topics.changeSets.proposal",
      "topics.changeSets.redirects",
      "topics.changeSets.naming",
      "topics.changeSets.humanRename",
      "topics.changeSets.gate",
      "topics.changeSets.areas",
      "topics.changeSets.undo",
      ...relationChangeSetKinds.map(relationRunTitleKey),
      ...overviewChangeOrigins.map((origin) => `changes.titles.overview.${origin}`),
      "changes.titles.relationMatched",
      "changes.titles.relationSuggested"
    ];
    const params = { items: 3, topics: 2, operations: 4, note: "N", source: "S", n: 5, areas: 6 };
    for (const locale of supportedLanguageCodes) {
      const t = createTranslator(locale);
      const fallback = t("activity.done.unknownChange");
      for (const titleKey of keys) {
        const text = changeSetTitle(t, { titleKey, titleParams: params });
        expect(text, `${locale} ${titleKey}`).not.toBe(fallback);
        expect(text, `${locale} ${titleKey}`).not.toMatch(/\{\w+\}|\[\[missing/);
      }
    }
  });
});
