import { describe, expect, it } from "vitest";
import { createTranslator } from "@app/i18n";

import {
  appendMentions,
  entityTypeLabel,
  groupMentions,
  hiddenTopicCount,
  otherNames,
  remainingMentions,
  reportedState,
  sourcesArePartial,
  sourcesOf,
  topicChips,
  type EntityLoad
} from "./entity-model";
import { entityEmptyPage, entityFirstPage, entitySecondPage } from "./entity-fixtures";

const en = createTranslator("en");
const pt = createTranslator("pt-BR");

describe("entityTypeLabel", () => {
  it("speaks the stored kind in the person's language and shows an unknown kind as stored", () => {
    expect(entityTypeLabel(pt, "Person")).toBe("Pessoa");
    expect(entityTypeLabel(en, "FieldOfStudy")).toBe("Field of study");
    expect(entityTypeLabel(pt, "organism")).toBe("organism");
  });
});

describe("groupMentions", () => {
  it("keeps the repository's order, one group per topic, the notes that are not placed last", () => {
    const groups = groupMentions(entityFirstPage.mentions.items);
    expect(groups.map((group) => [group.title, group.notes.length, group.total])).toEqual([
      ["Lactic fermentation", 6, 6],
      ["Immunology", 2, 3]
    ]);
  });

  it("keeps a group whole when a page boundary falls inside it", () => {
    const all = [...entityFirstPage.mentions.items, ...entitySecondPage.mentions.items];
    const groups = groupMentions(all);
    expect(groups.map((group) => [group.title, group.notes.length])).toEqual([
      ["Lactic fermentation", 6],
      ["Immunology", 3],
      ["Fermented foods", 2]
    ]);
  });

  it("puts the notes with no topic in one group with no total, and leaves an unnamed topic empty", () => {
    const base = entityFirstPage.mentions.items[0]!;
    const groups = groupMentions([
      { ...base, noteId: "a", topicId: "t-unnamed", topicTitle: "", topicNotes: 2 },
      { ...base, noteId: "b", topicId: null, topicTitle: "", topicNotes: 0 },
      { ...base, noteId: "c", topicId: null, topicTitle: "", topicNotes: 0 }
    ]);
    expect(
      groups.map((group) => [group.topicId, group.title, group.notes.length, group.total])
    ).toEqual([
      ["t-unnamed", "", 1, 2],
      [null, "", 2, 0]
    ]);
  });
});

describe("sources", () => {
  it("lists each loaded source once, in the order the mentions name them", () => {
    expect(sourcesOf(entityFirstPage.mentions.items).map((source) => source.title)).toEqual([
      "Food microbiology, ch. 3",
      "Kefir and kombucha at home",
      "The gut and its tenants"
    ]);
  });

  it("leaves out a mention whose source is gone", () => {
    const base = entityFirstPage.mentions.items[0]!;
    expect(sourcesOf([{ ...base, sourceId: null, sourceTitle: null }])).toEqual([]);
  });

  it("says the list is partial only while mentions are unloaded and a source is missing from them", () => {
    expect(sourcesArePartial(entityFirstPage)).toBe(true);
    const all = appendMentions(entityFirstPage, entitySecondPage);
    expect(sourcesOf(all.mentions.items)).toHaveLength(4);
    expect(sourcesArePartial(all)).toBe(false);
    // Every source named although the cursor is still open: nothing is missing.
    expect(sourcesArePartial({ ...entityFirstPage, counts: { notes: 11, sources: 3 } })).toBe(
      false
    );
  });
});

describe("appendMentions", () => {
  it("adds the next page after the loaded one and takes its cursor, keeping the first page's topics", () => {
    const all = appendMentions(entityFirstPage, entitySecondPage);
    expect(all.mentions.items).toHaveLength(11);
    expect(all.mentions.next).toBeUndefined();
    expect(all.topics).toBe(entityFirstPage.topics);
    expect(all.coMentioned).toBe(entityFirstPage.coMentioned);
  });

  it("does not list a note twice when two reads overlap", () => {
    const overlap = {
      ...entitySecondPage,
      mentions: {
        items: [entityFirstPage.mentions.items[7]!, ...entitySecondPage.mentions.items]
      }
    };
    expect(appendMentions(entityFirstPage, overlap).mentions.items).toHaveLength(11);
  });

  it("counts what is not loaded yet", () => {
    expect(remainingMentions(entityFirstPage)).toBe(3);
    expect(remainingMentions(appendMentions(entityFirstPage, entitySecondPage))).toBe(0);
  });
});

describe("otherNames", () => {
  it("drops the entity's own name, empty names and repeats, whatever their case", () => {
    expect(
      otherNames({
        ...entityFirstPage.entity,
        canonicalName: "Lactobacillus",
        aliases: ["lactobacillus", " lactobacilli ", "Lactobacilli", "", "lactic acid bacteria"]
      })
    ).toEqual(["lactobacilli", "lactic acid bacteria"]);
  });
});

describe("topics", () => {
  it("puts the topic with most notes first, marked, then the others", () => {
    expect(topicChips(entityFirstPage.topics)).toEqual([
      { id: expect.any(String), title: "Lactic fermentation", densest: true },
      { id: expect.any(String), title: "Immunology", densest: false },
      { id: expect.any(String), title: "Fermented foods", densest: false }
    ]);
  });

  it("lists no topic for an entity that is placed nowhere, and does not mistake the root for one", () => {
    expect(topicChips(entityEmptyPage.topics)).toEqual([]);
    expect(topicChips(undefined)).toEqual([]);
    expect(
      topicChips({
        primary: [{ kind: "topic", id: "root", title: "" }],
        alsoIn: [],
        alsoInCount: 0
      })
    ).toEqual([]);
  });

  it("counts the places the page does not list", () => {
    expect(hiddenTopicCount(entityFirstPage.topics)).toBe(0);
    expect(
      hiddenTopicCount({
        primary: [],
        alsoIn: [{ kind: "topic", id: "x", title: "X" }],
        alsoInCount: 6
      })
    ).toBe(5);
  });
});

describe("reportedState", () => {
  const ready = (page: typeof entityFirstPage): EntityLoad => ({
    status: "ready",
    page,
    more: "idle"
  });

  it("tells the frame loading, error, success, and empty for a gone entity and for no mentions", () => {
    expect(reportedState({ status: "loading" })).toBe("loading");
    expect(reportedState({ status: "error" })).toBe("error");
    expect(reportedState({ status: "missing" })).toBe("empty");
    expect(reportedState(ready(entityEmptyPage))).toBe("empty");
    expect(reportedState(ready(entityFirstPage))).toBe("success");
  });
});
