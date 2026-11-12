import { describe, expect, it } from "vitest";
import { topicChangeSetOrigins, topicReadLimits } from "@app/domain";
import { createTranslator, supportedLanguageCodes, type LanguageCode } from "@app/i18n";

import { buildIcicle, topicCellKey, unsortedCellKey } from "./icicle-layout";
import {
  cellLabel,
  changeText,
  childrenText,
  coherenceText,
  compareView,
  depthText,
  nodeName,
  panelModel,
  resolveSelection,
  shareText,
  tableRows,
  timeText,
  warningViews,
  warningsValue,
  weekText
} from "./shape-model";
import {
  sample,
  sampleChange,
  sampleChangeSet,
  sampleNodes,
  sampleWarnings,
  shapeId,
  shapeNode
} from "./shape-fixtures";

const en = createTranslator("en");
const layout = buildIcicle(sampleNodes());
const key = (n: number) => topicCellKey(shapeId(n));
const everyLanguage = (): Array<[LanguageCode, ReturnType<typeof createTranslator>]> =>
  supportedLanguageCodes.map((code) => [code, createTranslator(code)]);

describe("names", () => {
  it("calls the root of the tree Topics, an unnamed topic Unnamed topic and a branch root by its place", () => {
    const [root, , , , , , , , , unnamed] = sampleNodes();
    expect(nodeName(en, root!, true)).toBe("Topics");
    expect(nodeName(en, unnamed!, true)).toBe("Unnamed topic");
    // The root of a zoomed branch is a topic like any other, not the tree.
    expect(nodeName(en, root!, false)).toBe("Unnamed topic");
    expect(nodeName(en, { title: "Kept", parentId: null }, true)).toBe("Kept");
  });
});

describe("numbers", () => {
  it("formats shares, depth, coherence and the week in the interface language", () => {
    expect(shareText(en, 3 / 161)).toBe("1.9%");
    expect(shareText(createTranslator("pt-BR"), 3 / 161)).toBe("1,9%");
    expect(shareText(en, 1)).toBe("100%");
    expect(depthText(en, 2.6)).toBe("2.6");
    expect(depthText(createTranslator("pt-BR"), 2.64)).toBe("2,6");
    expect(coherenceText(en, 0.74)).toBe("0.74");
    expect(coherenceText(en, null)).toBe("—");
    expect(weekText(en, 8)).toBe("+8");
    expect(weekText(en, 0)).toBe("0");
    expect(warningsValue(en, 2, 0)).toBe("2 minor · 0 serious");
    expect(timeText(en, "not a date")).toBe("");
  });

  it("writes the children of a topic as subtopics plus direct items", () => {
    expect(childrenText(en, 2, 6)).toBe("2 + 6 direct");
    expect(childrenText(en, 0, 6)).toBe("6 direct");
    expect(childrenText(en, 3, 0)).toBe("3");
    expect(childrenText(en, 0, 0)).toBe("0");
    expect(childrenText(createTranslator("pt-BR"), 2, 6)).toBe("2 + 6 diretos");
  });
});

describe("block labels", () => {
  it("names the topic, its items, its level and its health", () => {
    const forgetting = layout.byKey.get(key(sample.forgetting))!;
    expect(cellLabel(en, forgetting, true, 0)).toBe(
      "Forgetting curve, 26 items, level 2, health: good"
    );
    const science = layout.byKey.get(key(sample.science))!;
    expect(cellLabel(en, science, true, 0)).toContain("health: needs attention");
    expect(cellLabel(en, layout.byKey.get(unsortedCellKey)!, true, 0)).toBe(
      "Unsorted, 3 items, level 1"
    );
    // A branch starts at its level in the whole tree.
    expect(cellLabel(en, forgetting, false, 2)).toContain("level 4");
  });
});

describe("the selected block", () => {
  it("falls back to the root when the selection is gone", () => {
    expect(resolveSelection(layout, key(sample.decay))).toBe(key(sample.decay));
    expect(resolveSelection(layout, "topic:gone")).toBe(key(sample.root));
    expect(resolveSelection(layout, null)).toBe(key(sample.root));
  });

  it("reads like the mockup: items, level, children, coherence, week and health", () => {
    const growth = new Map([[shapeId(sample.forgetting), 8]]);
    const model = panelModel(en, layout, key(sample.forgetting), true, 0, growth)!;
    expect(model).toMatchObject({
      kind: "topic",
      title: "Forgetting curve",
      trail: ["Topics", "Memory and learning"],
      items: 26,
      level: 2,
      childrenText: "2 + 6 direct",
      growth: 8,
      growthText: "+8",
      subtopics: 2,
      coherenceText: "0.74",
      health: "good",
      mark: null,
      canZoom: true
    });
  });

  it("zooms into a branch only from a topic that has subtopics and is not the chart's root", () => {
    expect(panelModel(en, layout, key(sample.root), true, 0)!.canZoom).toBe(false);
    expect(panelModel(en, layout, key(sample.decay), true, 0)!.canZoom).toBe(false);
    expect(panelModel(en, layout, key(sample.memory), true, 0)!.canZoom).toBe(true);
  });

  it("marks a topic the person created or pinned", () => {
    expect(panelModel(en, layout, key(sample.testing), true, 0)!.mark).toBe("Created by you");
  });

  it("describes the unsorted items without topic facts", () => {
    const model = panelModel(en, layout, unsortedCellKey, true, 0)!;
    expect(model).toMatchObject({ kind: "unsorted", title: "Unsorted", items: 3, health: null });
    expect(model.canZoom).toBe(false);
    expect(panelModel(en, layout, `direct:${shapeId(sample.forgetting)}`, true, 0)).toBeNull();
  });
});

describe("the table alternative", () => {
  it("lists exactly the selectable blocks of the chart, in the same order", () => {
    const rows = tableRows(en, layout, true, 0);
    expect(rows.map((row) => row.key)).toEqual(layout.order);
    expect(rows).toHaveLength(19);
    for (const row of rows) {
      expect(row.items, row.key).toBe(layout.byKey.get(row.key)!.value);
      expect(row.level, row.key).toBe(layout.byKey.get(row.key)!.row);
    }
  });

  it("carries the numbers a person reads off the chart", () => {
    const growth = new Map([[shapeId(sample.forgetting), 8]]);
    const rows = new Map(tableRows(en, layout, true, 0, growth).map((row) => [row.key, row]));
    expect(rows.get(key(sample.forgetting))).toMatchObject({
      name: "Forgetting curve",
      kind: "topic",
      direct: 6,
      subtopics: 2,
      growth: "+8",
      coherence: "0.74",
      health: "good"
    });
    expect(rows.get(unsortedCellKey)).toMatchObject({
      kind: "unsorted",
      name: "Unsorted",
      items: 3,
      direct: null,
      subtopics: null,
      health: null
    });
    expect(rows.get(key(sample.science))!.health).toBe("attention");
    expect(rows.get(key(sample.testing))!.mark).toBe("Created by you");
  });
});

describe("warnings", () => {
  const views = warningViews(en, sampleWarnings(), layout, true);

  it("turns a proposal into a decision with its change-set and its impact", () => {
    const proposal = views[0]!;
    expect(proposal.proposal).toEqual({
      changeSetId: shapeId(sample.pendingChange),
      riskLabel: "Medium impact"
    });
    expect(proposal.subject).toEqual({ name: "Testing effect", cellKey: key(sample.testing) });
    expect(proposal.text).toContain("waits for your decision");
    expect(proposal.tone).toBe("warning");
    expect(proposal.awaiting).toBe(false);
  });

  it("turns an invariant into a sentence about its topic", () => {
    const chain = views[1]!;
    expect(chain.proposal).toBeNull();
    expect(chain.subject!.name).toBe("Open science");
    expect(chain.text).toBe("Chain of one: it holds only one subtopic.");
  });

  it("names a topic below the levels shown without a block to select", () => {
    const [view] = warningViews(
      en,
      [
        {
          topicId: shapeId(999),
          code: "fan-out-above-hard-max",
          params: { invariant: "I3", severity: "hard", awaitingApproval: false, value: 31.4 },
          changeSetId: null,
          pendingReview: false
        }
      ],
      layout,
      true
    );
    expect(view!.subject).toEqual({ name: "A topic below the levels shown", cellKey: null });
    expect(view!.tone).toBe("danger");
    expect(view!.text).toBe("It holds 31 subtopics, far too many to scan.");
  });

  it("says that a protected topic is only reported", () => {
    const [view] = warningViews(
      en,
      [
        {
          topicId: shapeId(sample.testing),
          code: "leaf-size-outside-range",
          params: { severity: "soft", awaitingApproval: true, value: 5 },
          changeSetId: null,
          pendingReview: false
        }
      ],
      layout,
      true
    );
    expect(view!.awaiting).toBe(true);
  });

  it("falls back to a general sentence for a code it does not know, never to the raw code", () => {
    const [soft, hard, proposal] = warningViews(
      en,
      [
        {
          topicId: null,
          code: "something-new",
          params: { severity: "soft" },
          changeSetId: null,
          pendingReview: false
        },
        {
          topicId: null,
          code: "topic-unreachable",
          params: { severity: "hard" },
          changeSetId: null,
          pendingReview: false
        },
        {
          topicId: null,
          code: "pending-review",
          params: { origin: "someday", risk: "extreme" },
          changeSetId: shapeId(5),
          pendingReview: true
        }
      ],
      layout,
      true
    );
    expect(soft!.text).toBe("This topic needs attention.");
    expect(hard!.text).toBe("The structure has a problem that the app repairs by itself.");
    expect(proposal!.text).toBe(
      "A change to the structure is proposed. It waits for your decision."
    );
    expect(proposal!.proposal!.riskLabel).toBeNull();
    expect(soft!.subject).toBeNull();
    for (const view of [soft, hard, proposal]) {
      expect(view!.text).not.toMatch(/something-new|topic-unreachable|someday|extreme/);
    }
  });

  it("has a sentence in every language for every reason, proposal and impact it names", () => {
    const codes = [
      "single-child",
      "fan-out-outside-range",
      "fan-out-above-hard-max",
      "leaf-size-outside-range",
      "leaf-above-hard-max",
      "depth-above-target",
      "depth-above-cap",
      "coherence-below-floor",
      "duplicate-sibling-title",
      "unknown"
    ];
    for (const [language, t] of everyLanguage()) {
      const stored = codes.map((code) => ({
        topicId: shapeId(sample.science),
        code,
        params: { severity: "soft", awaitingApproval: false, value: 0.4 },
        changeSetId: null,
        pendingReview: false
      }));
      const proposals = ["rebalance", "areas", "rebuild", "other"].flatMap((origin) =>
        ["high", "medium", "low"].map((risk) => ({
          topicId: null,
          code: "pending-review",
          params: { origin, risk },
          changeSetId: shapeId(7),
          pendingReview: true
        }))
      );
      for (const view of warningViews(t, [...stored, ...proposals], layout, true)) {
        expect(view.text, language).not.toContain("[[missing");
        expect(view.text.length, language).toBeGreaterThan(8);
        expect(view.proposal?.riskLabel ?? "", language).not.toContain("[[missing");
      }
    }
  });
});

describe("what changed today", () => {
  it("reads a change by its origin, with the numbers it carries", () => {
    expect(changeText(en, sampleChange())).toBe("The structure was rebalanced. Items moved: 8.");
    expect(changeText(en, sampleChange({ titleParams: {} }))).toBe("The structure was rebalanced.");
    expect(changeText(en, sampleChange({ origin: "naming", titleParams: { topics: 4 } }))).toBe(
      "Topics named: 4."
    );
    expect(changeText(en, sampleChange({ origin: "human" }))).toBe("You changed the structure.");
  });

  it("reads a change this view does not know as a plain change, not a key", () => {
    for (const origin of ["place", "gate", "undo"] as const) {
      expect(
        changeText(en, sampleChange({ origin, titleKey: `topics.changeSets.${origin}` }))
      ).toBe("The structure changed.");
    }
  });

  it("has a sentence in every language for every origin", () => {
    for (const [language, t] of everyLanguage()) {
      for (const origin of topicChangeSetOrigins) {
        const text = changeText(
          t,
          sampleChange({ origin, titleParams: { items: 3, topics: 2, operations: 1 } })
        );
        expect(text, `${language} ${origin}`).not.toContain("[[missing");
        expect(text.length).toBeGreaterThan(8);
      }
    }
  });
});

describe("before and after", () => {
  it("lists topics under their parents and items in their topics", () => {
    const view = compareView(en, sampleChangeSet());
    expect(view.before.map((line) => line.text)).toEqual([
      "Testing effect, under Memory and learning",
      "Quizzing beats rereading, in Testing effect"
    ]);
    expect(view.after.map((line) => line.text)).toEqual([
      "Retrieval practice, under Memory and learning",
      "Quizzing beats rereading, in Retrieval practice"
    ]);
    expect(view.partial).toBe(false);
  });

  it("names an unnamed topic and reports a partial list", () => {
    const changeSet = sampleChangeSet();
    changeSet.before.topics[0]!.title = null;
    changeSet.truncated = true;
    const view = compareView(en, changeSet);
    expect(view.before[0]!.text).toBe("Unnamed topic, under Memory and learning");
    expect(view.partial).toBe(true);
  });
});

describe("the deepest level the read reaches (7)", () => {
  const depth = topicReadLimits.shapeDepthMax;
  const chain = Array.from({ length: depth + 1 }, (_, level) =>
    shapeNode(level + 1, level === 0 ? null : level, level, `Level ${level}`, depth + 1 - level, {
      directItems: 1,
      children: level === depth ? 0 : 1
    })
  );
  const deep = buildIcicle(chain, { wholeTree: false });
  const deepest = topicCellKey(shapeId(depth + 1));

  it("names the level of a block at depth 7, and 7 more below a branch that starts at level 3", () => {
    expect(cellLabel(en, deep.byKey.get(deepest)!, false, 0)).toContain("level 7");
    expect(cellLabel(en, deep.byKey.get(deepest)!, false, 3)).toContain("level 10");
    expect(panelModel(en, deep, deepest, false, 0)).toMatchObject({
      level: 7,
      trail: expect.any(Array),
      canZoom: false
    });
    expect(panelModel(en, deep, deepest, false, 0)!.trail).toHaveLength(depth);
  });

  it("lists every level in the table, deepest last", () => {
    const rows = tableRows(en, deep, false, 0);
    expect(rows.map((row) => row.level)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    expect(rows.at(-1)).toMatchObject({ kind: "topic", subtopics: 0, direct: 1 });
  });
});
