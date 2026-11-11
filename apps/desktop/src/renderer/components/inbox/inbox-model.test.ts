import { describe, expect, it } from "vitest";

import { inboxKinds, inboxVariants, type InboxItem, type InboxVerb } from "@app/domain";
import { createTranslator, supportedLanguageCodes } from "@app/i18n";

import { item, summary, uuid } from "./inbox-fixtures";
import {
  ageText,
  itemBody,
  itemHint,
  itemSubject,
  confidenceText,
  itemTitle,
  kindLabels,
  objectName,
  quarantineReason,
  reviewVariantLabel,
  riskLabels,
  verbLabel,
  verbLabels
} from "./inbox-model";

const en = createTranslator("en");
const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/iu;

/** Every variant of every kind, so each sentence of the closed tables is read. */
function everyItem(): InboxItem[] {
  const items: InboxItem[] = [];
  for (const kind of inboxKinds)
    for (const variant of inboxVariants[kind]) items.push(item(kind, { variant }));
  items.push(item("backlog", { variant: "other", params: {} }));
  items.push(item("backlog", { params: { reason: "settings_changed", notes: 3, pairs: 2 } }));
  items.push(item("budget", { variant: "money_100" }));
  items.push(item("suggestion", { params: { relationType: "supports", probability: null } }));
  items.push(item("suggestion", { params: { relationType: "supports", probability: 0.9 } }));
  items.push(item("suggestion", { params: { relationType: "supports", probability: 0.2 } }));
  return items;
}

describe("the Inbox's sentences, in every language", () => {
  for (const locale of supportedLanguageCodes) {
    const t = createTranslator(locale);
    it(`${locale}: every kind and variant reads without a gap, a brace or an ID`, () => {
      for (const entry of everyItem()) {
        for (const [name, text] of [
          ["title", itemTitle(t, entry)],
          ["body", itemBody(t, entry)],
          ["subject", itemSubject(t, entry)],
          ["hint", itemHint(t, entry) ?? ""]
        ] as const) {
          const where = `${locale} ${entry.kind}/${entry.variant} ${name}`;
          expect(text, where).not.toMatch(/\[\[missing/u);
          expect(text, where).not.toMatch(/[{}]/u);
          expect(text, where).not.toMatch(uuidPattern);
          if (name !== "hint") expect(text.trim(), where).not.toBe("");
        }
        expect(t(kindLabels[entry.kind])).not.toMatch(/\[\[missing/u);
      }
      for (const risk of Object.values(riskLabels)) expect(t(risk)).not.toMatch(/\[\[missing/u);
    });
  }
});

describe("what an item says", () => {
  it("names the two notes of a relation and says which kind of withdrawal it was", () => {
    const body = itemBody(en, item("withdrawn"));
    expect(body).toContain("“Caffeine”");
    // A note without a title reads as untitled, never as an ID.
    expect(body).toContain("“Untitled”");
    expect(body).toContain("explanation");
    expect(itemBody(en, item("withdrawn", { variant: "typer" }))).toContain("Typing");
    expect(itemBody(en, item("withdrawn", { variant: "other" }))).toContain("automatically");
    expect(itemBody(en, item("contradiction"))).toContain("“Naps help”");
    expect(itemBody(en, item("duplicate", { variant: "title" }))).toContain("same title");
    expect(itemBody(en, item("duplicate", { variant: "both" }))).toContain("same title and");
  });

  it("words a suggestion by both notes and how sure the decider was, with no number when unknown", () => {
    const body = itemBody(en, item("suggestion"));
    expect(body).toContain("“Daylight sets the body clock”");
    expect(body).toContain("“Morning light shifts sleep timing”");
    expect(body).toContain("medium confidence (64%)");
    const unknown = itemBody(
      en,
      item("suggestion", { params: { relationType: "supports", probability: null } })
    );
    expect(unknown).toContain("unknown confidence");
    expect(unknown).not.toMatch(/\d/u);
    // The word and the number follow the band and the language.
    expect(confidenceText(en, 0.85)).toBe("high confidence (85%)");
    expect(confidenceText(en, 0.5)).toBe("low confidence (50%)");
    expect(confidenceText(createTranslator("pt-BR"), 0.64)).toBe("confiança média (64%)");
    expect(confidenceText(createTranslator("pt-BR"), null)).toBe("confiança desconhecida");
    // A probability that is not a number reads as unknown, never as zero.
    expect(
      itemBody(en, item("suggestion", { params: { relationType: "supports", probability: "x" } }))
    ).toContain("unknown confidence");
  });

  it("words a quarantined task by its task and why it failed", () => {
    expect(itemTitle(en, item("quarantined"))).toBe("Updating a topic overview keeps failing");
    expect(itemTitle(en, item("quarantined", { variant: "unheard" }))).toBe(
      "A background task keeps failing"
    );
    expect(itemBody(en, item("quarantined"))).toContain("the model's answer could not be used");
    expect(quarantineReason(en, "call_failed")).toContain("could not be reached");
    expect(quarantineReason(en, "invalid")).toContain("not valid");
    expect(quarantineReason(en, "something odd")).toBe("an unexpected problem");
    expect(quarantineReason(en, null)).toBe("an unexpected problem");
  });

  it("formats amounts and counts for the language, and the path as stored", () => {
    expect(itemBody(en, item("budget"))).toBe("$4.12 of $5.00 used this month.");
    expect(itemBody(createTranslator("pt-BR"), item("budget"))).toContain("US$");
    expect(itemBody(en, item("backlog", { params: { notes: 12345 } }))).toContain("12,345");
    expect(
      itemBody(createTranslator("pt-BR"), item("backlog", { params: { notes: 12345 } }))
    ).toContain("12.345");
    expect(itemBody(en, item("backlog", { variant: "other" }))).toContain("optional task");
    // The Divergences an overview patch kept name the topic and count the points (D17).
    const divergence = item("contradiction", {
      variant: "divergence",
      risk: "high",
      params: { divergences: 1234 },
      objects: [{ kind: "topic", id: uuid(40), title: "Sleep" }]
    });
    expect(itemTitle(en, divergence)).toBe("New evidence disagrees with a topic overview");
    expect(itemBody(en, divergence)).toBe(
      "The overview of “Sleep” was extended, and some new evidence disagrees with what it says. The disagreement is kept beside the text, never merged into it. Keep it there, or dismiss this. Points of disagreement: 1,234."
    );
    expect(itemSubject(en, divergence)).toBe("“Sleep”");
    // Matching values that changed (T98) count the notes and the source pairs they decided.
    const settings = item("backlog", {
      params: { reason: "settings_changed", notes: 1200, pairs: 34 }
    });
    expect(itemTitle(en, settings)).toBe("Match notes again with the current matching settings?");
    expect(itemBody(en, settings)).toBe(
      "1,200 notes and 34 source pairs were matched with other matching settings. Nothing changes unless you accept."
    );
    expect(
      itemTitle(en, item("backlog", { params: { reason: "decider_changed", notes: 2 } }))
    ).toBe("Match notes again with the current model?");
    expect(itemBody(en, item("obsidian_conflict"))).toContain("“Notes/Sleep.md”");
    expect(itemBody(en, item("obsidian_conflict", { variant: "deleted" }))).toContain("deleted");
    expect(itemBody(en, item("obsidian_conflict", { variant: "projection" }))).toContain(
      "generated"
    );
    expect(itemSubject(en, item("obsidian_conflict"))).toBe("Notes/Sleep.md");
  });

  it("tells the two budget states apart and adds a hint where one helps", () => {
    expect(itemTitle(en, item("budget"))).toContain("paused");
    expect(itemTitle(en, item("budget", { variant: "money_100" }))).toContain("reached");
    expect(itemHint(en, item("budget"))).toContain("Continue");
    expect(itemHint(en, item("budget", { variant: "money_100" }))).toContain("next month");
    expect(itemHint(en, item("duplicate"))).toContain("Dismiss");
    expect(itemHint(en, item("obsidian_conflict"))).toContain("Connections");
    expect(itemHint(en, item("review"))).toBeNull();
  });

  it("lists the objects an item names, or what kind of item it is", () => {
    expect(itemSubject(en, item("duplicate"))).toBe("“Nap” · “Siesta”");
    expect(itemSubject(en, item("backlog"))).toBe("Optional re-match");
    expect(itemSubject(en, item("review", { objects: [], variant: "relation" }))).toBe(
      "Connections"
    );
    expect(itemSubject(en, item("review", { objects: [], variant: "mystery" }))).toBe("To review");
    expect(reviewVariantLabel(en, "overview")).toBe("Topic overview");
    expect(reviewVariantLabel(en, "mystery")).toBeNull();
  });

  it("names an object by its title, or says it is untitled or unnamed", () => {
    expect(objectName(en, { kind: "note", id: uuid(1), title: "Naps" })).toBe("Naps");
    expect(objectName(en, { kind: "note", id: uuid(1), title: null })).toBe("Untitled");
    expect(objectName(en, { kind: "note", id: uuid(1), title: "  " })).toBe("Untitled");
    expect(objectName(en, { kind: "topic", id: uuid(1), title: null })).toBe("Unnamed topic");
  });
});

describe("a change-set's title", () => {
  // The closed table is Activity's (`activity/change-title.ts`, tested there); the Inbox reads it
  // with its own plain sentence for a key it does not know.
  const review = (titleKey: string, titleParams: Record<string, number> = {}) =>
    item("review", { changeSet: summary({ titleKey, titleParams }) });

  it("looks the stored key up in the closed table and fills its parameters", () => {
    expect(itemTitle(en, review("topics.changeSets.place", { items: 12 }))).toBe(
      "Placed 12 items in topics"
    );
    expect(itemTitle(en, review("changes.titles.overview.patch"))).toBe("Topic overview extended");
    expect(
      itemTitle(createTranslator("pt-BR"), review("topics.changeSets.place", { items: 1234 }))
    ).toContain("1.234");
  });

  it("reads a key the table does not know, or a title with a parameter missing, as a plain review", () => {
    const plain = en("inbox.items.review.title");
    expect(itemTitle(en, review("not.a.key"))).toBe(plain);
    expect(itemTitle(en, review("__proto__"))).toBe(plain);
    expect(itemTitle(en, review("topics.changeSets.place"))).toBe(plain);
    expect(itemTitle(en, item("review", { changeSet: null }))).toBe(plain);
  });

  it("titles a review item by its change-set", () => {
    expect(
      itemTitle(
        en,
        item("review", { changeSet: summary({ titleKey: "changes.titles.overview.rewrite" }) })
      )
    ).toBe("Topic overview rewrite");
  });
});

describe("verbs and time", () => {
  it("labels every verb an item can offer, per kind", () => {
    const expectations: Array<[InboxItem["kind"], InboxVerb, string]> = [
      ["review", "apply", "Apply"],
      ["review", "dismiss", "Dismiss"],
      ["contradiction", "apply", "Keep"],
      ["contradiction", "dismiss", "Remove"],
      ["suggestion", "apply", "Keep"],
      ["suggestion", "dismiss", "Remove"],
      ["withdrawn", "apply", "Keep"],
      ["withdrawn", "dismiss", "Remove"],
      ["quarantined", "retry", "Retry"],
      ["duplicate", "dismiss", "Not a duplicate"],
      ["backlog", "apply", "Match again"],
      ["budget", "apply", "Continue"]
    ];
    for (const [kind, verb, label] of expectations) expect(verbLabel(en, kind, verb)).toBe(label);
    // A Divergence is kept beside the text or its item dismissed: nothing is removed (D17).
    expect(verbLabel(en, "contradiction", "apply", "divergence")).toBe("Keep");
    expect(verbLabel(en, "contradiction", "dismiss", "divergence")).toBe("Dismiss");
    expect(verbLabel(en, "contradiction", "dismiss", "relation")).toBe("Remove");
    for (const kind of inboxKinds)
      for (const verb of Object.keys(verbLabels[kind]) as InboxVerb[])
        for (const locale of supportedLanguageCodes)
          expect(verbLabel(createTranslator(locale), kind, verb)).not.toMatch(/\[\[missing/u);
  });

  it("says how long ago an item arose, in the language of the interface", () => {
    const now = Date.UTC(2026, 9, 24, 12, 0, 0);
    const ago = (ms: number) => new Date(now - ms).toISOString();
    expect(ageText(en, ago(10_000), now)).toBe("just now");
    expect(ageText(en, ago(5 * 60_000), now)).toBe("5 minutes ago");
    expect(ageText(en, ago(3 * 3_600_000), now)).toBe("3 hours ago");
    expect(ageText(en, ago(2 * 86_400_000), now)).toBe("2 days ago");
    expect(ageText(en, ago(65 * 86_400_000), now)).toBe("2 months ago");
    expect(ageText(createTranslator("pt-BR"), ago(3 * 3_600_000), now)).toBe("há 3 horas");
    // A time ahead of now, or unreadable, is never a negative age.
    expect(ageText(en, new Date(now + 60_000).toISOString(), now)).toBe("just now");
    expect(ageText(en, "not a date", now)).toBe("just now");
  });
});
