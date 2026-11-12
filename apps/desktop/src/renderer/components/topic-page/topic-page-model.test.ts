import { describe, expect, it } from "vitest";
import { topicReadLimits, TopicPageSchema } from "@app/domain";
import { createTranslator, messages, supportedLanguageCodes } from "@app/i18n";

import {
  bannerOrigin,
  breadcrumb,
  changeBannerText,
  countLabel,
  eventTouchesPage,
  formatWhen,
  healthViews,
  isRootPage,
  isStaleCursor,
  mergeNoteLeaves,
  moreSubtopicsLabel,
  nextAnnouncement,
  noteSourceLine,
  relationsLabel,
  samePageContent,
  stanceRows,
  topicPageLoadDecision,
  topicPageOpenedObject,
  topicTitle
} from "./topic-page-model";
import { noteLeaf, topicFixtureId, topicPage } from "./topic-page-fixtures";

const en = createTranslator("en");
const pt = createTranslator("pt-BR");
// Local calendar components, so the day arithmetic holds in any time zone.
const local = (day: number, hour: number, minute: number) =>
  new Date(2026, 9, day, hour, minute, 0);

describe("the fixture and the contract", () => {
  it("is a valid topics.page answer", () => {
    expect(() => TopicPageSchema.parse(topicPage())).not.toThrow();
  });
});

describe("names", () => {
  it("shows a stored title as it is and localizes the missing ones", () => {
    expect(topicTitle(en, { title: "Decay models" }, false)).toBe("Decay models");
    expect(topicTitle(en, { title: null }, false)).toBe("Unnamed topic");
    expect(topicTitle(pt, { title: null }, false)).toBe("Tópico sem nome");
    expect(topicTitle(en, { title: null }, true)).toBe("All topics");
    expect(topicTitle(pt, { title: null }, true)).toBe("Todos os tópicos");
  });

  it("builds the path from the root, marks the page itself and never shows an ID", () => {
    const crumbs = breadcrumb(en, topicPage().path);
    expect(crumbs.map((crumb) => crumb.label)).toEqual([
      "All topics",
      "Memory and learning",
      "Forgetting curve"
    ]);
    expect(crumbs.map((crumb) => crumb.current)).toEqual([false, false, true]);
    expect(breadcrumb(en, [])).toEqual([]);
  });

  it("knows the root page by its missing parent", () => {
    const root = topicPage();
    expect(isRootPage(root)).toBe(false);
    expect(isRootPage({ topic: { ...root.topic, parentId: null } })).toBe(true);
  });
});

describe("counts", () => {
  it("uses the singular message for one and the plural for the rest, in every language", () => {
    for (const language of supportedLanguageCodes) {
      const t = createTranslator(language);
      for (const noun of ["notes", "sources", "subtopics", "items", "relations"] as const) {
        const one = countLabel(t, noun, 1);
        const many = countLabel(t, noun, 5);
        expect(one, `${language} ${noun}`).toMatch(/^1\b/);
        expect(many, `${language} ${noun}`).toMatch(/^5\b/);
        expect(one).not.toBe(many);
        expect(`${one}${many}`).not.toContain("[[missing:");
        expect(`${one}${many}`).not.toMatch(/\{count\}/);
      }
    }
  });

  it("groups thousands by the interface language", () => {
    expect(countLabel(en, "notes", 18632)).toBe("18,632 notes");
    expect(countLabel(pt, "notes", 18632)).toBe("18.632 notas");
    expect(countLabel(en, "notes", 0)).toBe("0 notes");
  });

  it("says how many subtopics the map leaves out", () => {
    expect(moreSubtopicsLabel(en, 1)).toBe("1 more subtopic is in the topic tree.");
    expect(moreSubtopicsLabel(en, 4)).toBe("4 more subtopics are in the topic tree.");
  });

  it("says that a note without relations has none", () => {
    expect(relationsLabel(en, 0)).toBe("No relations");
    expect(relationsLabel(en, 1)).toBe("1 relation");
    expect(relationsLabel(en, 6)).toBe("6 relations");
  });
});

describe("health", () => {
  it("is a word and a tone for every value", () => {
    expect(Object.keys(healthViews).sort()).toEqual(["attention", "good", "violation"]);
    expect(en(healthViews.good.key)).toBe("balanced size");
    expect(healthViews.good.tone).toBe("success");
    expect(healthViews.attention.tone).toBe("warning");
    expect(healthViews.violation.tone).toBe("danger");
  });
});

describe("relation stances", () => {
  it("lists the types that have relations in the order of the legend, larger counts first", () => {
    const rows = stanceRows(topicPage().relationStances);
    expect(rows.map((row) => [row.type, row.count, row.stance])).toEqual([
      ["supports", 9, "supports"],
      ["contrasts", 1, "contradicts"],
      ["extends", 5, "extends"],
      ["depends_on", 3, "depends_on"],
      ["related", 7, "related"]
    ]);
    expect(rows.every((row) => en(row.wordKey).length > 0)).toBe(true);
  });

  it("orders types of one stance by count and leaves out the empty ones", () => {
    const rows = stanceRows({
      supports: 0,
      contrasts: 0,
      extends: 0,
      similar_to: 2,
      depends_on: 0,
      clarifies: 4,
      mentions: 0,
      related: 4
    });
    expect(rows.map((row) => row.type)).toEqual(["clarifies", "related", "similar_to"]);
    expect(stanceRows(topicPage({ relationStances: zeroStances() }).relationStances)).toEqual([]);
  });
});

function zeroStances() {
  return {
    supports: 0,
    contrasts: 0,
    extends: 0,
    similar_to: 0,
    depends_on: 0,
    clarifies: 0,
    mentions: 0,
    related: 0
  };
}

describe("notes", () => {
  it("names the source of a note, or that the person wrote it", () => {
    expect(noteSourceLine(en, { sourceTitle: "Handbook", provenance: "ai" })).toBe("Handbook");
    expect(noteSourceLine(en, { sourceTitle: null, provenance: "human" })).toBe("Written by you");
    expect(noteSourceLine(en, { sourceTitle: null, provenance: "ai" })).toBeNull();
  });

  it("appends a page of leaves once: notes only, never the same note twice", () => {
    const first = noteLeaf({ id: topicFixtureId(1) });
    const second = noteLeaf({ id: topicFixtureId(2) });
    const source = {
      kind: "source" as const,
      id: topicFixtureId(3),
      title: "A source",
      role: "primary" as const,
      unsorted: false,
      noteCount: 2
    };
    const merged = mergeNoteLeaves([first], [first, source, second, second]);
    expect(merged.map((note) => note.id)).toEqual([topicFixtureId(1), topicFixtureId(2)]);
  });

  it("recognizes a cursor the read side no longer accepts", () => {
    expect(isStaleCursor(new Error("topics.errors.stale"))).toBe(true);
    expect(
      isStaleCursor(
        new Error("Error invoking remote method 'app:topics:notes': topics.errors.stale")
      )
    ).toBe(true);
    expect(isStaleCursor(new Error("network"))).toBe(false);
  });
});

describe("the banner of the last change", () => {
  const now = local(15, 18, 0);

  it("names the day: today, yesterday or the date", () => {
    expect(formatWhen(local(15, 13, 41).toISOString(), now, en)).toMatch(/^Today, 1:41\sPM$/);
    expect(formatWhen(local(14, 23, 59).toISOString(), now, en)).toMatch(/^Yesterday, 11:59\sPM$/);
    expect(formatWhen(local(10, 9, 5).toISOString(), now, en)).toMatch(/Oct 10, 2026/);
    expect(formatWhen(local(15, 13, 41).toISOString(), now, pt)).toBe("Hoje, 13:41");
    expect(formatWhen(local(14, 8, 2).toISOString(), now, pt)).toBe("Ontem, 08:02");
  });

  it("reads each known origin as an automatic change, with the item count when the title has one", () => {
    const at = local(15, 13, 41).toISOString();
    const change = (titleKey: string, titleParams = {}) => ({
      changeSetId: topicFixtureId(1),
      titleKey,
      titleParams,
      at,
      undo: "available" as const
    });
    expect(changeBannerText(change("topics.changeSets.place", { items: 2 }), now, pt)).toBe(
      "Organizado automaticamente. Hoje, 13:41: 2 itens foram colocados."
    );
    expect(changeBannerText(change("topics.changeSets.place", { items: 1 }), now, pt)).toBe(
      "Organizado automaticamente. Hoje, 13:41: 1 item foi colocado."
    );
    expect(changeBannerText(change("topics.changeSets.place"), now, pt)).toBe(
      "Organizado automaticamente. Hoje, 13:41: novos itens foram colocados."
    );
    expect(changeBannerText(change("topics.changeSets.place", { items: 0 }), now, en)).toContain(
      "new items were placed"
    );
    for (const origin of ["build", "gate", "rebalance", "audit", "naming", "areas", "rebuild"]) {
      expect(changeBannerText(change(`topics.changeSets.${origin}`), now, en), origin).toMatch(
        /^Organized automatically\. Today, .+: .+\.$/
      );
    }
    expect(changeBannerText(change("topics.changeSets.human"), now, en)).toMatch(
      /^Changed by you\. Today, /
    );
    expect(changeBannerText(change("topics.changeSets.undo"), now, en)).toMatch(
      /^Change undone\. Today, /
    );
  });

  it("never shows a key it does not know", () => {
    expect(bannerOrigin("topics.changeSets.place")).toBe("place");
    expect(bannerOrigin("topics.changeSets.future")).toBe("other");
    expect(bannerOrigin("something.else")).toBe("other");
    expect(bannerOrigin("topics.changeSets.constructor")).toBe("other");
    const text = changeBannerText(
      {
        changeSetId: topicFixtureId(1),
        titleKey: "topics.changeSets.future",
        titleParams: { items: 3 },
        at: local(15, 13, 41).toISOString(),
        undo: "unavailable"
      },
      now,
      en
    );
    expect(text).toMatch(/^Organized automatically\. Today, /);
    expect(text).not.toContain("topics.changeSets");
    expect(text).not.toContain("{");
  });
});

describe("when the page loads", () => {
  const base = {
    active: true,
    wasHidden: false,
    outcome: null,
    key: "a|0",
    topicChanged: false,
    showing: false
  };

  it("loads a page it has not loaded, with a loading state", () => {
    expect(topicPageLoadDecision(base)).toBe("load");
  });

  it("loads nothing while hidden", () => {
    expect(topicPageLoadDecision({ ...base, active: false })).toBe("skip");
  });

  it("does not load again for a key that finished", () => {
    expect(
      topicPageLoadDecision({ ...base, outcome: { key: "a|0", ok: false, hasData: false } })
    ).toBe("skip");
  });

  it("refreshes in place when shown again after a good load of the same key", () => {
    expect(
      topicPageLoadDecision({
        ...base,
        wasHidden: true,
        showing: true,
        outcome: { key: "a|0", ok: true, hasData: true }
      })
    ).toBe("silent");
  });

  it("loads again, visibly, when the last load failed", () => {
    expect(
      topicPageLoadDecision({
        ...base,
        wasHidden: true,
        outcome: { key: "a|0", ok: false, hasData: false }
      })
    ).toBe("skip");
    expect(topicPageLoadDecision({ ...base, key: "a|1" })).toBe("load");
  });

  it("refreshes the page on screen when its key moved on, and always loads another topic", () => {
    expect(
      topicPageLoadDecision({
        ...base,
        key: "a|1",
        showing: true,
        outcome: { key: "a|0", ok: true, hasData: true }
      })
    ).toBe("silent");
    expect(topicPageLoadDecision({ ...base, topicChanged: true, showing: true, key: "b|0" })).toBe(
      "load"
    );
  });
});

describe("what counts as a change of the page", () => {
  it("ignores the tree generation: the same content is the same page", () => {
    const page = topicPage();
    expect(samePageContent(page, { ...page, generation: page.generation + 5 })).toBe(true);
    expect(
      samePageContent(page, { ...page, counts: { ...page.counts, notes: page.counts.notes + 1 } })
    ).toBe(false);
  });

  it("reads again for a newer generation that touches what the page shows", () => {
    const page = topicPage();
    const event = (generation: number, topicIds: string[] | null) => ({
      treeId: topicFixtureId(999),
      generation,
      topicIds,
      changeSetId: null
    });
    expect(eventTouchesPage(event(13, [page.topic.id]), page, 12)).toBe(true);
    expect(eventTouchesPage(event(13, [page.subtopics[0]!.id]), page, 12)).toBe(true);
    expect(eventTouchesPage(event(13, [page.relatedTopics[0]!.id]), page, 12)).toBe(true);
    expect(eventTouchesPage(event(13, [page.path[1]!.id]), page, 12)).toBe(true);
    expect(eventTouchesPage(event(13, null), page, 12)).toBe(true);
  });

  it("does not read again for an old generation or an unrelated topic", () => {
    const page = topicPage();
    const event = (generation: number, topicIds: string[] | null) => ({
      treeId: topicFixtureId(999),
      generation,
      topicIds,
      changeSetId: null
    });
    expect(eventTouchesPage(event(12, [page.topic.id]), page, 12)).toBe(false);
    expect(eventTouchesPage(event(11, null), page, 12)).toBe(false);
    expect(eventTouchesPage(event(20, [topicFixtureId(555)]), page, 12)).toBe(false);
    expect(eventTouchesPage(event(20, []), page, 12)).toBe(false);
  });
});

describe("the open recorded in the history", () => {
  it("is the topic that was resolved, titled in the interface language", () => {
    const page = topicPage();
    expect(topicPageOpenedObject(en, page)).toEqual({
      kind: "topic",
      id: page.topic.id,
      title: "Forgetting curve"
    });
    const unnamed = topicPage({ topic: { ...page.topic, title: null, nameState: "unnamed" } });
    expect(topicPageOpenedObject(pt, unnamed).title).toBe("Tópico sem nome");
  });
});

describe("announcements", () => {
  it("speak again when the same outcome repeats", () => {
    expect(nextAnnouncement("", "Change undone.")).toBe("Change undone.");
    expect(nextAnnouncement("Change undone.", "Change undone.")).toBe("Change undone.\u00a0");
  });
});

describe("the copy of the page", () => {
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
  const flat = (value: object, prefix = ""): Array<[string, string]> =>
    Object.entries(value).flatMap(([key, child]) =>
      typeof child === "string"
        ? [[`${prefix}${key}`, child] as [string, string]]
        : flat(child as object, `${prefix}${key}.`)
    );

  it("is complete in the five languages with the same placeholders", () => {
    const expected = flat(messages.en.topics.page);
    expect(expected.length).toBeGreaterThan(60);
    for (const locale of supportedLanguageCodes) {
      const actual = new Map(flat(messages[locale].topics.page));
      expect([...actual.keys()].sort(), locale).toEqual(expected.map(([key]) => key).sort());
      for (const [key, text] of expected) {
        expect(actual.get(key), `${locale} ${key}`).toBeTruthy();
        expect(placeholders(actual.get(key)!).sort(), `${locale} ${key}`).toEqual(
          placeholders(text).sort()
        );
      }
    }
  });

  it("stays inside the bounds of the contract it renders", () => {
    expect(topicReadLimits.centralNotesDefault).toBe(6);
    expect(topicReadLimits.itemsPageDefault).toBe(50);
  });
});
