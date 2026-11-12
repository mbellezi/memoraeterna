import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator, messages, supportedLanguageCodes, type LanguageCode } from "@app/i18n";

import { buildIcicle, topicCellKey, unsortedCellKey } from "./icicle-layout";
import type { ChangeAction, ChangeDetail, ShapeSnapshot } from "./shape-controller";
import {
  bigNodes,
  sample,
  sampleChange,
  sampleChangeSet,
  sampleNodes,
  sampleShape,
  shapeId
} from "./shape-fixtures";
import { tableRows } from "./shape-model";
import { escapeStep, ShapeView, type ShapeViewProps } from "./ShapeView";

const noop = () => undefined;

function snapshot(overrides: Partial<ShapeSnapshot> = {}): ShapeSnapshot {
  return {
    load: { status: "ready", shape: sampleShape() },
    growth: {
      status: "ready",
      byTopic: new Map([
        [shapeId(sample.forgetting), 8],
        [shapeId(sample.memory), 9],
        [shapeId(sample.root), 12]
      ])
    },
    zoom: [{ id: null, title: null, depth: 0 }],
    selectedKey: null,
    actions: {},
    details: {},
    announcement: "",
    readAt: Date.UTC(2026, 9, 15, 18, 0, 0),
    ...overrides
  };
}

function view(
  state: ShapeSnapshot,
  overrides: Partial<ShapeViewProps> = {},
  language: LanguageCode = "en"
): string {
  return renderToString(
    <ShapeView
      t={createTranslator(language)}
      snapshot={state}
      display="chart"
      onDisplay={noop}
      onRetry={noop}
      onSelect={noop}
      onZoomInto={noop}
      onZoomTo={noop}
      onOpenTopic={noop}
      onReview={noop}
      onUndo={noop}
      onToggleDetails={noop}
      onRetryDetails={noop}
      {...overrides}
    />
  );
}

const decode = (text: string) => text.replaceAll("&amp;", "&").replaceAll("&#x27;", "'");
const chartLabels = (html: string): string[] =>
  [...html.matchAll(/<button[^>]*data-cell="[^"]*"[^>]*aria-label="([^"]*)"/g)].map((match) =>
    decode(match[1]!)
  );
const tableHeads = (html: string): string[] =>
  [
    ...html.matchAll(
      /<th scope="row"[^>]*>.*?<span class="\[overflow-wrap:anywhere\]">([^<]*)<\/span>/g
    )
  ].map((match) => decode(match[1]!));

describe("the Shape view", () => {
  it("says what the Map shows in one line, then the chart, the selected topic and its table", () => {
    const html = view(snapshot());
    expect(html).toContain("Size and health of the tree: 161 notes in 17 topics");
    expect(html).toContain('aria-label="Display"');
    expect(html).toContain("Chart and table");
    expect(html).toContain("Table only");
    expect(html).toContain("Areas");
    expect(html).toContain("Subtopics");
    expect(html).toContain("The same numbers as a table");
    expect(html).toContain("Height = notes");
    // The chart is never shown without its table, and no summary of statistics stands in for it.
    expect(html).toContain("<caption");
    expect(html).not.toContain("Average depth");
    expect(html).not.toContain("[[missing");
  });

  it("draws the first three levels as buttons, never the root, each named for a reader", () => {
    const labels = chartLabels(view(snapshot()));
    expect(labels).toHaveLength(18);
    expect(labels.some((label) => label.startsWith("Topics,"))).toBe(false);
    expect(labels).toContain("Memory and learning, 90 items, level 1, health: good");
    expect(labels).toContain("Forgetting curve, 26 items, level 2, health: good");
    expect(labels).toContain("Open science, 10 items, level 1, health: needs attention");
    expect(labels).toContain("Unnamed topic, 11 items, level 2, health: good");
    expect(labels).toContain("Unsorted, 3 items, level 1");
  });

  it("marks attention with a glyph and a word as well as a ring, and the selected block with aria-pressed", () => {
    const html = view(snapshot({ selectedKey: topicCellKey(shapeId(sample.forgetting)) }));
    expect(html).toContain("inset 0 0 0 2px var(--state-warning)");
    expect(html).toContain("inset 0 0 0 2px var(--accent)");
    expect(html).toContain('class="lucide lucide-triangle-alert');
    // The chart's selected block and its row in the table are the same topic.
    expect(html.match(/data-cell="[^"]*"[^>]*aria-pressed="true"/g)).toHaveLength(1);
    expect(
      html.match(/<button[^>]*aria-pressed="true"[^>]*title="Forgetting curve"/g)
    ).toHaveLength(1);
  });

  it("selects the root when nothing is selected or the selection is gone", () => {
    for (const selectedKey of [null, "topic:gone"]) {
      const html = view(snapshot({ selectedKey }));
      expect(html).toMatch(/<h2[^>]*>Topics<\/h2>/);
    }
  });

  it("has one tab stop in the chart: the selected block, otherwise the first one drawn", () => {
    const tabStops = (html: string) =>
      [...html.matchAll(/<button[^>]*data-cell="([^"]*)"[^>]*tabindex="(-?\d)"/g)].filter(
        (match) => match[2] === "0"
      );
    const selected = topicCellKey(shapeId(sample.memory));
    expect(tabStops(view(snapshot({ selectedKey: selected }))).map((m) => m[1])).toEqual([
      selected
    ]);
    expect(tabStops(view(snapshot()))).toHaveLength(1);
  });

  it("sorts siblings by size, so the largest block comes first", () => {
    const labels = chartLabels(view(snapshot()));
    const names = labels.map((label) => label.split(",")[0]);
    expect(names.indexOf("Memory and learning")).toBeLessThan(names.indexOf("Literature"));
    expect(names.indexOf("Literature")).toBeLessThan(names.indexOf("Open science"));
  });

  it("shows the items placed directly in a topic as a dashed block that is not a control", () => {
    const html = view(snapshot());
    expect(html).toContain('aria-hidden="true" class="absolute rounded-md border border-dashed');
  });

  it("describes the selected topic in one line with its growth over seven days", () => {
    const html = view(snapshot({ selectedKey: topicCellKey(shapeId(sample.forgetting)) }));
    expect(html).toMatch(/<h2[^>]*>Forgetting curve<\/h2>/);
    expect(html).toContain("Topics › Memory and learning");
    expect(html).toContain("26 notes · 2 direct subtopics · +8 notes in 7 days");
    expect(html).toContain("Good");
    expect(html).toContain("Open topic");
    expect(html).toContain("Zoom into this branch");
  });

  it("leaves the growth out of the line while the history is not read", () => {
    const html = view(
      snapshot({
        growth: { status: "loading" },
        selectedKey: topicCellKey(shapeId(sample.forgetting))
      })
    );
    expect(html).toContain("26 notes · 2 direct subtopics</p>");
    expect(html).not.toContain("in 7 days");
  });

  it("offers no branch zoom for the root, a leaf or Unsorted", () => {
    for (const n of [sample.root, sample.decay]) {
      const html = view(snapshot({ selectedKey: topicCellKey(shapeId(n)) }));
      expect(html).toMatch(/<button[^>]*disabled=""[^>]*>(<svg.*?<\/svg>)?Zoom into this branch/);
    }
    const unsorted = view(snapshot({ selectedKey: unsortedCellKey }));
    expect(unsorted).not.toContain("Zoom into this branch");
    expect(unsorted).not.toContain("Open topic");
    expect(unsorted).toContain("Items waiting for a place");
  });

  it("points to the Inbox when a proposal for the selected topic waits there", () => {
    const withProposal = view(snapshot({ selectedKey: topicCellKey(shapeId(sample.testing)) }), {
      onOpenInbox: noop
    });
    expect(withProposal).toContain("Next step");
    expect(withProposal).toContain("See the proposal in the Inbox");
    const without = view(snapshot({ selectedKey: topicCellKey(shapeId(sample.memory)) }), {
      onOpenInbox: noop
    });
    expect(without).not.toContain("See the proposal in the Inbox");
  });
});

describe("the zoom-out band and Esc", () => {
  const origin = { topicId: shapeId(sample.forgetting), title: "Forgetting curve" };

  it("names where the person was and marks the topic that holds it", () => {
    const html = view(snapshot(), { origin, onBack: noop });
    expect(html).toContain("You are seeing the whole tree.");
    expect(html).toContain("goes back to Forgetting curve, where you were.");
    expect(html).toContain(">Back<");
    expect(html).toContain("here = holds where you were");
    // The ancestors in the chart and the rows of the table carry the marker.
    expect(html).toContain("Forgetting curve, 26 items, level 2, health: good, here");
    expect(html).toContain("Memory and learning, 90 items, level 1, health: good, here");
    expect(html).toContain("inset 3px 0 0 0 var(--accent)");
  });

  it("shows no band when the person did not come from an object", () => {
    expect(view(snapshot())).not.toContain("You are seeing the whole tree.");
  });

  it("zooms out one step, then leaves, and only when it came from an object", () => {
    expect(escapeStep(3, false)).toBe("zoomOut");
    expect(escapeStep(2, true)).toBe("zoomOut");
    expect(escapeStep(1, true)).toBe("leave");
    expect(escapeStep(1, false)).toBeNull();
  });
});

describe("the table", () => {
  it("lists every topic with the same numbers as the chart, in the order of the chart", () => {
    const state = snapshot();
    const html = view(state, { display: "table" });
    const heads = tableHeads(html);
    const layout = buildIcicle(sampleNodes(), { wholeTree: true, sortBySize: true });
    const rows = tableRows(createTranslator("en"), layout, true, 0, null);
    expect(heads).toEqual(rows.map((row) => row.name));
    expect(heads).toHaveLength(19);
  });

  it("is a real table: a caption, column headers with the 7-day growth, a header for each row", () => {
    const html = view(snapshot(), { display: "table" });
    expect(html).toContain("<caption");
    expect(html.match(/<th scope="col"/g)).toHaveLength(8);
    expect(html).toContain(">7 days</th>");
    expect(html.match(/<th scope="row"/g)).toHaveLength(19);
    expect(html).not.toContain("data-cell");
    expect(html).toContain("+8");
  });

  it("shows a dash where the growth was not read", () => {
    const html = view(snapshot({ growth: { status: "error" } }), { display: "table" });
    expect(html).not.toContain("+8");
    expect(html).toContain(">—<");
  });

  it("is beside the chart with Notes, Health and 7 days, the selected row marked", () => {
    const html = view(snapshot({ selectedKey: topicCellKey(shapeId(sample.memory)) }));
    expect(html).toContain('<col style="width:52px"/>');
    expect(html).toContain('<col style="width:124px"/>');
    expect(html).toContain('<col style="width:64px"/>');
    expect(html).toContain("bg-surface-selected");
  });

  it("adds rows a page at a time for a big tree", () => {
    const nodes = bigNodes(2_000);
    const html = view(
      snapshot({ load: { status: "ready", shape: sampleShape({ nodes, truncated: true }) } }),
      { display: "table" }
    );
    expect(html.match(/<th scope="row"/g)).toHaveLength(200);
    expect(html).toContain("Show more topics");
  });
});

describe("a big tree", () => {
  it("draws the blocks it can read, groups the small ones and says the table has the rest", () => {
    const nodes = bigNodes(2_000);
    const html = view(
      snapshot({ load: { status: "ready", shape: sampleShape({ nodes, truncated: true }) } })
    );
    const drawn = chartLabels(html).length;
    expect(drawn).toBeGreaterThan(5);
    expect(drawn).toBeLessThan(nodes.length);
    expect(html).toContain("Small blocks are grouped; the table lists each one.");
    expect(html).toContain("topics sit deeper");
    expect(html).toContain("Deeper levels are not drawn");
  });

  it("says nothing of the sort when everything is drawn", () => {
    const html = view(snapshot());
    expect(html).not.toContain("Small blocks are grouped");
    expect(html).not.toContain("topics sit deeper");
  });
});

describe("a branch", () => {
  it("shows the way back up and continues the levels from the whole tree's", () => {
    const html = view(
      snapshot({
        zoom: [
          { id: null, title: null, depth: 0 },
          { id: shapeId(sample.memory), title: "Memory and learning", depth: 1 }
        ],
        load: {
          status: "ready",
          shape: sampleShape({
            nodes: [
              { ...sampleNodes()[1]!, parentId: null, depth: 0 },
              ...sampleNodes()
                .filter((node) => node.parentId === shapeId(sample.memory))
                .map((node) => ({ ...node, depth: 1 }))
            ]
          })
        }
      })
    );
    expect(html).toMatch(/<button[^>]*>Topics<\/button>/);
    expect(html).toContain('aria-current="location"');
    expect(html).toContain("Level 2");
    expect(chartLabels(html)[0]).toContain("level 2");
  });
});

describe("warnings and proposals", () => {
  it("offers Apply, Dismiss and the before and after only for a proposal", () => {
    const html = view(snapshot());
    expect(html.match(/>Apply</g)).toHaveLength(1);
    expect(html.match(/>Dismiss</g)).toHaveLength(1);
    expect(html).toContain("waits for your decision");
    expect(html).toContain("Medium impact");
    expect(html).toContain("Chain of one: it holds only one subtopic.");
    expect(html.match(/aria-describedby="/g)?.length).toBeGreaterThanOrEqual(2);
  });

  it("shows a quiet line when there is nothing to warn about", () => {
    const html = view(
      snapshot({ load: { status: "ready", shape: sampleShape({ warnings: [] }) } })
    );
    expect(html).toContain("No warnings. The tree is in good shape.");
  });

  it("shows the answer being awaited and a refusal beside the proposal", () => {
    const id = shapeId(sample.pendingChange);
    const pending: Record<string, ChangeAction> = { [id]: { kind: "apply", status: "pending" } };
    const waiting = view(snapshot({ actions: pending }));
    expect(waiting).toMatch(/<button[^>]*disabled=""[^>]*>Working\.\.\.<\/button>/);
    const failed: Record<string, ChangeAction> = {
      [id]: { kind: "dismiss", status: "failed", messageKey: "topics.errors.unavailable" }
    };
    const refused = view(snapshot({ actions: failed }));
    expect(refused).toContain('role="alert"');
    expect(refused).toContain("This action is not available yet.");
  });

  it("opens the before and after of a proposal", () => {
    const id = shapeId(sample.pendingChange);
    expect(view(snapshot())).toContain("See before and after");
    const details: Record<string, ChangeDetail> = {
      [id]: { status: "ready", changeSet: sampleChangeSet() }
    };
    const open = view(snapshot({ details }));
    expect(open).toContain("Hide before and after");
    expect(open).toContain("Testing effect, under Memory and learning");
    expect(open).toContain("Quizzing beats rereading, in Retrieval practice");
  });
});

describe("what changed today", () => {
  it("lists a change with its time, its before and after and an Undo", () => {
    const html = view(snapshot());
    expect(html).toContain("The structure was rebalanced. Items moved: 8.");
    expect(html).toMatch(/· \d{1,2}:\d{2}/);
    expect(html).toContain(">Undo<");
  });

  it("offers no Undo for a change that cannot be undone, and says why when a later change depends on it", () => {
    const html = (undo: "blocked" | "unavailable") =>
      view(
        snapshot({
          load: { status: "ready", shape: sampleShape({ changedToday: [sampleChange({ undo })] }) }
        })
      );
    expect(html("unavailable")).not.toContain(">Undo<");
    expect(html("blocked")).toContain("It cannot be undone now: a later change depends on it.");
  });

  it("shows an undo in progress and a failure", () => {
    const id = shapeId(sample.todayChange);
    const withAction = (action: ChangeAction) => view(snapshot({ actions: { [id]: action } }));
    expect(withAction({ kind: "undo", status: "pending" })).toContain("Undoing...");
    const failed = withAction({
      kind: "undo",
      status: "failed",
      messageKey: "topics.shape.changed.failed"
    });
    expect(failed).toContain("The change could not be undone. Try again.");
  });

  it("says when nothing changed", () => {
    const html = view(
      snapshot({ load: { status: "ready", shape: sampleShape({ changedToday: [] }) } })
    );
    expect(html).toContain("Nothing changed today.");
  });
});

describe("loading, empty and error states", () => {
  it("is a busy region with the layout's shape while loading, and no chart", () => {
    const html = view(snapshot({ load: { status: "loading" } }));
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Loading");
    expect(html).not.toContain("data-cell");
    expect(html).not.toContain('aria-label="Display"');
  });

  it("says in one sentence what failed, what is kept, and offers one retry", () => {
    const html = view(snapshot({ load: { status: "error" } }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("The map could not be loaded.");
    expect(html).toContain("Your sources and notes are untouched.");
    expect(html.match(/>Retry</g)).toHaveLength(1);
  });

  it("says a branch is gone and offers the way back", () => {
    const html = view(
      snapshot({
        load: { status: "missing" },
        zoom: [
          { id: null, title: null, depth: 0 },
          { id: shapeId(5), title: "Gone", depth: 1 }
        ]
      })
    );
    expect(html).toContain("This branch no longer exists.");
    expect(html).toContain("Back to the whole tree");
  });

  it("teaches when there are no topics yet", () => {
    const html = view(snapshot({ load: { status: "missing" } }));
    expect(html).toContain("The map appears when there are topics.");
    expect(html).toContain("topics are born on their own");
  });

  it("teaches when the tree holds no items", () => {
    const empty = sampleShape({
      nodes: [{ ...sampleNodes()[0]!, items: 0, directItems: 0, children: 0 }],
      summary: { ...sampleShape().summary, items: 0, topics: 0, unsortedShare: 0 }
    });
    const html = view(snapshot({ load: { status: "ready", shape: empty } }));
    expect(html).toContain("The map appears when there are topics.");
    expect(html).not.toContain("data-cell");
  });

  it("shows the previous panel as its table alone, the open topic marked", () => {
    const html = view(snapshot(), {
      compact: true,
      currentTopicId: shapeId(sample.memory)
    });
    expect(html).not.toContain("data-cell");
    expect(html).not.toContain('aria-label="Display"');
    expect(html.match(/<th scope="col"/g)).toHaveLength(2);
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
  });

  it("announces results in a polite live region", () => {
    const html = view(snapshot({ announcement: "Change undone." }));
    expect(html).toMatch(
      /<p class="sr-only" role="status" aria-live="polite">Change undone\.<\/p>/
    );
  });
});

describe("every language", () => {
  it("renders the whole view with no missing message", () => {
    for (const language of supportedLanguageCodes) {
      const id = shapeId(sample.pendingChange);
      const states = [
        snapshot({ details: { [id]: { status: "ready", changeSet: sampleChangeSet() } } }),
        snapshot({ actions: { [id]: { kind: "apply", status: "pending" } } }),
        snapshot({ load: { status: "error" } }),
        snapshot({ load: { status: "loading" } }),
        snapshot({ load: { status: "missing" } })
      ];
      for (const state of states)
        expect(view(state, {}, language), language).not.toContain("[[missing");
      const table = view(snapshot(), { display: "table" }, language);
      expect(table, language).toContain(messages[language].topics.shape.table.caption);
      expect(view(snapshot(), {}, language), language).toContain(
        messages[language].map.chart.legend.height
      );
    }
  });
});
