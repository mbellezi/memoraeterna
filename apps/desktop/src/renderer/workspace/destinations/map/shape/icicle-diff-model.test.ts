import { describe, expect, it } from "vitest";
import {
  createTranslator,
  messages,
  supportedLanguageCodes,
  translate,
  type MessageKey
} from "@app/i18n";

import {
  diffChangeOrder,
  diffChanges,
  diffCellLabel,
  diffLegend,
  diffRows,
  diffSideKeys,
  hiddenText,
  isTopicDiff,
  legendText,
  movedMark,
  resolveDiffSelection,
  topicNameOn
} from "./icicle-diff-model";
import { diffToneTokens } from "./diff-tones";
import {
  diffId,
  diffNode,
  diffTopics,
  sampleDiffNodes,
  sampleTopicDiff,
  standing
} from "./icicle-diff-fixtures";
import { buildDiffIcicle, diffCellKey } from "./icicle-layout";

const en = createTranslator("en");
const nodes = sampleDiffNodes();
const rows = diffRows(en, nodes);
const row = (n: number) => rows.find((entry) => entry.id === diffId(n))!;
const cell = (side: "before" | "after", n: number) =>
  buildDiffIcicle(nodes, side).byKey.get(diffCellKey(side, diffId(n)))!;

describe("the rows of the table and the selected topic", () => {
  it("lists every topic in the order of the read, named by title and never by id", () => {
    expect(rows.map((entry) => entry.name)).toEqual([
      "Topics",
      "Misc",
      "Memory",
      "Language",
      "Retrieval practice",
      "Spaced repetition",
      "Forgetting curve"
    ]);
    for (const entry of rows) expect(entry.name).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}/);
  });

  it("says what a topic was called and where it stood before and after", () => {
    expect(row(diffTopics.forgetting)).toMatchObject({
      change: "renamed",
      name: "Forgetting curve",
      was: "Forgetting",
      parentBefore: "Memory",
      parentAfter: "Memory"
    });
    expect(row(diffTopics.spacing)).toMatchObject({
      change: "moved",
      was: null,
      parentBefore: "Language",
      parentAfter: "Memory"
    });
  });

  it("does not claim a place on a side where the topic was not", () => {
    expect(row(diffTopics.retrieval)).toMatchObject({
      existedBefore: false,
      existsAfter: true,
      parentBefore: null,
      parentAfter: "Memory",
      itemsIn: 4
    });
    expect(row(diffTopics.misc)).toMatchObject({
      name: "Misc",
      existedBefore: true,
      existsAfter: false,
      parentBefore: "Topics",
      parentAfter: null,
      itemsOut: 6
    });
  });

  it("names the root, an untitled topic and a parent that the read does not list", () => {
    expect(row(diffTopics.root)).toMatchObject({ name: "Topics", parentBefore: null });
    const odd = diffRows(en, [
      standing(1, "renamed", null, null),
      diffNode(2, "moved", {
        parentBefore: diffId(diffTopics.elsewhere),
        parentAfter: diffId(1),
        titleBefore: "Child",
        titleAfter: "Child"
      }),
      diffNode(3, "added", {
        existedBefore: false,
        parentAfter: diffId(1),
        titleAfter: null
      })
    ]);
    expect(odd[1]).toMatchObject({ parentBefore: "another topic", parentAfter: "Topics" });
    expect(odd[2]).toMatchObject({ name: "Unnamed topic" });
    expect(topicNameOn(en, nodes[0]!, "before")).toBe("Topics");
    expect(topicNameOn(en, nodes[2]!, "after")).toBe("Memory");
  });

  it("falls back to the other side for a parent that is only listed there", () => {
    const only = diffRows(en, [
      standing(1, "removed", null, "Gone", { existsAfter: false }),
      diffNode(2, "moved", {
        parentBefore: diffId(1),
        parentAfter: diffId(1),
        titleBefore: "Kid",
        titleAfter: "Kid"
      })
    ]);
    expect(only[1]).toMatchObject({ parentBefore: "Gone", parentAfter: "Gone" });
  });

  it("keeps the selection only while the read lists the topic", () => {
    expect(resolveDiffSelection(nodes, diffId(diffTopics.spacing))).toBe(
      diffId(diffTopics.spacing)
    );
    expect(resolveDiffSelection(nodes, diffId(99))).toBeNull();
    expect(resolveDiffSelection(nodes, null)).toBeNull();
  });
});

describe("the words of a block", () => {
  it("names a block with its topic, its change and its level", () => {
    expect(diffCellLabel(en, cell("after", diffTopics.forgetting))).toBe(
      "Forgetting curve, Renamed, level 2"
    );
    expect(diffCellLabel(en, cell("before", diffTopics.forgetting))).toBe(
      "Forgetting, Renamed, level 2"
    );
    expect(diffCellLabel(en, cell("after", diffTopics.root))).toBe("Topics, Unchanged, level 0");
  });

  it("adds the items moved out of a topic before and into it after, with a sign", () => {
    expect(diffCellLabel(en, cell("before", diffTopics.misc))).toBe(
      "Misc, Removed, level 1, moved out: 6 items"
    );
    expect(diffCellLabel(en, cell("after", diffTopics.retrieval))).toBe(
      "Retrieval practice, Added, level 2, moved in: 4 items"
    );
    expect(diffCellLabel(en, cell("after", diffTopics.memory))).toBe(
      "Memory, Items moved, level 1, moved in: 5 items"
    );
    expect(movedMark(cell("before", diffTopics.misc))).toBe("−6");
    expect(movedMark(cell("after", diffTopics.retrieval))).toBe("+4");
    expect(movedMark(cell("after", diffTopics.spacing))).toBeNull();
    // Out of a topic is counted before, into it after: Language lost 3 and gained none.
    expect(movedMark(cell("after", diffTopics.language))).toBeNull();
    expect(movedMark(cell("before", diffTopics.language))).toBe("−3");
  });

  it("speaks in the interface language", () => {
    const pt = createTranslator("pt-BR");
    expect(diffCellLabel(pt, cell("after", diffTopics.forgetting))).toBe(
      "Forgetting curve, Renomeado, nível 2"
    );
    expect(diffCellLabel(pt, cell("before", diffTopics.misc))).toBe(
      "Misc, Removido, nível 1, saíram: 6 itens"
    );
  });

  it("counts the kinds of change the read holds, in a fixed order, and says how many were left out", () => {
    expect(diffLegend(nodes)).toEqual([
      { change: "added", count: 1 },
      { change: "removed", count: 1 },
      { change: "moved", count: 1 },
      { change: "renamed", count: 1 },
      { change: "items", count: 2 },
      { change: "context", count: 1 }
    ]);
    expect(diffLegend([])).toEqual([]);
    expect(legendText(en, { change: "items", count: 2 })).toBe("Items moved: 2");
    expect(hiddenText(en, 1)).toBe("1 more changed topic, deeper in the tree, is not listed.");
    expect(hiddenText(en, 1234)).toBe(
      "1,234 more changed topics, deeper in the tree, are not listed."
    );
  });

  it("recognizes a topic diff and nothing else", () => {
    expect(isTopicDiff(sampleTopicDiff())).toBe(true);
    expect(isTopicDiff({ ...sampleTopicDiff(), kind: "relation", relations: [] } as never)).toBe(
      false
    );
  });
});

describe("colour never stands alone", () => {
  it("gives every kind of change a tone, a word and a different glyph", () => {
    expect(Object.keys(diffChanges).sort()).toEqual([...diffChangeOrder].sort());
    for (const change of diffChangeOrder) {
      expect(diffToneTokens[diffChanges[change].tone]).toBeDefined();
      expect(en(diffChanges[change].key)).not.toMatch(/\[\[missing/);
    }
    const words = diffChangeOrder.map((change) => en(diffChanges[change].key));
    expect(new Set(words).size).toBe(words.length);
  });

  it("tints additions, removals and edits differently, and unchanged topics quietly", () => {
    expect(diffChanges.added.tone).toBe("success");
    expect(diffChanges.removed.tone).toBe("danger");
    expect(diffChanges.moved.tone).toBe("info");
    expect(diffChanges.context.tone).toBe("neutral");
    expect(diffToneTokens.success.fill).toBe("--state-success-soft");
    expect(diffToneTokens.danger.fill).toBe("--state-danger-soft");
    expect(diffToneTokens.neutral.fill).toBe("--surface-soft");
  });
});

describe("the copy of the diff", () => {
  const flat = (value: object, prefix = ""): Array<[string, string]> =>
    Object.entries(value).flatMap(([key, child]) =>
      typeof child === "string"
        ? [[`${prefix}${key}`, child] as [string, string]]
        : flat(child as object, `${prefix}${key}.`)
    );
  const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]);
  const expected = flat(messages.en.topics.shape.diff);

  it("is complete in every locale, with the same parameters and no variable key", () => {
    expect(expected.length).toBeGreaterThan(40);
    for (const locale of supportedLanguageCodes) {
      const actual = new Map(flat(messages[locale].topics.shape.diff));
      expect([...actual.keys()].sort(), locale).toEqual(expected.map(([key]) => key).sort());
      for (const [key, text] of expected) {
        expect(placeholders(actual.get(key)!), `${locale} ${key}`).toEqual(placeholders(text));
        expect(
          translate(locale, `topics.shape.diff.${key}` as MessageKey, {
            missingKeyBehavior: "throw",
            values: { title: "T", change: "C", level: 1, items: "2", count: "3", parent: "P" }
          })
        ).not.toMatch(/\{\w+\}/u);
      }
    }
  });

  it("covers the side headings the chart uses", () => {
    for (const keys of Object.values(diffSideKeys))
      for (const key of Object.values(keys)) expect(en(key)).not.toMatch(/\[\[missing/);
  });
});
