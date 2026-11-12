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
import { ShapeView, type ShapeViewProps } from "./ShapeView";

const noop = () => undefined;

function snapshot(overrides: Partial<ShapeSnapshot> = {}): ShapeSnapshot {
  return {
    load: { status: "ready", shape: sampleShape() },
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
      zoomPercent={100}
      onDisplay={noop}
      onZoomPercent={noop}
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
  it("shows the lens, the summary, the icicle, the selected topic, the warnings and the day's changes", () => {
    const html = view(snapshot());
    expect(html).toContain("<h1");
    expect(html).toContain(">Map</h1>");
    expect(html).toContain('role="tablist"');
    expect(html).toContain("Atlas");
    expect(html).toContain("· later");
    // The summary of the mockup, in order.
    for (const text of ["Items", "Topics", "Average depth", "Reachable", "Unsorted", "Warnings"]) {
      expect(html, text).toContain(`>${text}</dt>`);
    }
    for (const text of ["161", "17", "2.6", "100%", "1.9%", "2 minor · 0 serious"]) {
      expect(html, text).toContain(text);
    }
    expect(html).toContain("Zoomed into");
    expect(html).toContain("· the whole tree");
    expect(html).toContain("Width = items · row = level");
    expect(html).toContain("Warnings in the tree · 2");
    expect(html).toContain(">Changed today</h3>");
    expect(html).not.toContain("[[missing");
  });

  it("draws one button per topic plus Unsorted, each named for what a reader needs", () => {
    const labels = chartLabels(view(snapshot()));
    expect(labels).toHaveLength(19);
    expect(labels).toContain("Topics, 161 items, level 0, health: good");
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
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toContain("needs attention</span>");
    expect(html).toContain('class="lucide lucide-triangle-alert');
  });

  it("selects the root when nothing is selected or the selection is gone", () => {
    for (const selectedKey of [null, "topic:gone"]) {
      const html = view(snapshot({ selectedKey }));
      expect(html).toContain('class="font-reading text-2xl');
      expect(html).toMatch(/<h2[^>]*>Topics<\/h2>/);
    }
  });

  it("has one tab stop in the chart: the selected block, otherwise the root", () => {
    const tabStops = (html: string) =>
      [...html.matchAll(/<button[^>]*data-cell="([^"]*)"[^>]*tabindex="(-?\d)"/g)].filter(
        (match) => match[2] === "0"
      );
    const selected = topicCellKey(shapeId(sample.memory));
    expect(tabStops(view(snapshot({ selectedKey: selected }))).map((m) => m[1])).toEqual([
      selected
    ]);
    expect(tabStops(view(snapshot())).map((m) => m[1])).toEqual([
      topicCellKey(shapeId(sample.root))
    ]);
  });

  it("shows the items placed directly in a topic as a block that is not a control", () => {
    const html = view(snapshot());
    expect(html.match(/border-dashed border-border-strong"/g)).toHaveLength(2);
    expect(html).toContain(
      'aria-hidden="true" class="h-full w-full rounded-md border border-dashed'
    );
  });

  it("describes the selected topic like the mockup", () => {
    const html = view(snapshot({ selectedKey: topicCellKey(shapeId(sample.forgetting)) }));
    expect(html).toMatch(/<h2[^>]*>Forgetting curve<\/h2>/);
    expect(html).toContain("Topics › Memory and learning");
    expect(html).toContain("2 + 6 direct");
    expect(html).toContain("0.74");
    expect(html).toContain("+8");
    expect(html).toContain("Good");
    expect(html).toContain("Open topic");
    expect(html).toContain("Zoom into this branch");
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
});

describe("the table alternative", () => {
  it("lists every block of the chart with the same numbers, in the order of the chart", () => {
    const state = snapshot();
    const chart = chartLabels(view(state));
    const html = view(state, { display: "table" });
    const heads = tableHeads(html);
    expect(heads).toHaveLength(chart.length);
    const layout = buildIcicle(sampleNodes());
    const rows = tableRows(createTranslator("en"), layout, true, 0);
    expect(heads).toEqual(rows.map((row) => row.name));
    // Every name and count the chart announces is a row of the table.
    for (const row of rows) {
      const label = chart.find((entry) => entry.startsWith(`${row.name}, ${row.items} items`));
      expect(label, row.name).toBeDefined();
    }
  });

  it("is a real table: a caption, column headers and a header for each row", () => {
    const html = view(snapshot(), { display: "table" });
    expect(html).toContain("<caption");
    expect(html.match(/<th scope="col"/g)).toHaveLength(8);
    expect(html.match(/<th scope="row"/g)).toHaveLength(19);
    expect(html).toContain("The topic tree as a table");
    expect(html).not.toContain("data-cell");
    // The chart's controls do nothing for a table.
    expect(html).toMatch(/aria-label="Zoom in"[^>]*disabled=""/);
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
  it("draws only the blocks wide enough to see and says the table has the rest", () => {
    const nodes = bigNodes(2_000);
    const html = view(
      snapshot({ load: { status: "ready", shape: sampleShape({ nodes, truncated: true }) } })
    );
    const drawn = chartLabels(html).length;
    expect(drawn).toBeGreaterThan(20);
    expect(drawn).toBeLessThan(nodes.length);
    expect(html).toContain("Very narrow blocks are not drawn here");
    expect(html).toContain("Deeper levels are not drawn");
  });

  it("does not say so when everything is drawn", () => {
    const html = view(snapshot());
    expect(html).not.toContain("Very narrow blocks");
    expect(html).not.toContain("Deeper levels are not drawn");
  });
});

describe("zoom", () => {
  it("widens the chart by the zoom and names the level", () => {
    const html = view(snapshot(), { zoomPercent: 200 });
    expect(html).toContain("width:200%");
    expect(html).toContain('aria-label="Zoom 200%"');
    expect(html).toContain(">200%</output>");
  });

  it("cannot zoom out at 100% and cannot zoom in at the top", () => {
    expect(view(snapshot())).toMatch(/aria-label="Zoom out"[^>]*disabled=""/);
    expect(view(snapshot(), { zoomPercent: 800 })).toMatch(/aria-label="Zoom in"[^>]*disabled=""/);
    expect(view(snapshot(), { zoomPercent: 200 })).not.toMatch(
      /aria-label="Zoom out"[^>]*disabled=""/
    );
  });

  it("shows the way back up while a branch is zoomed", () => {
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
    expect(html).not.toContain("· the whole tree");
    // The branch's levels continue from the whole tree's.
    expect(chartLabels(html)[0]).toContain("level 1");
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
    // The proposal's buttons are described by its sentence.
    expect(html.match(/aria-describedby="/g)?.length).toBeGreaterThanOrEqual(2);
    expect(html).not.toContain("Inbox");
  });

  it("selects the topic a warning names", () => {
    const html = view(snapshot());
    expect(html).toMatch(/<button[^>]*>Testing effect<\/button>/);
    expect(html).toMatch(/<button[^>]*>Open science<\/button>/);
  });

  it("shows a quiet line when there is nothing to warn about", () => {
    const html = view(
      snapshot({ load: { status: "ready", shape: sampleShape({ warnings: [] }) } })
    );
    expect(html).toContain("No warnings. The tree is in good shape.");
    expect(html).toContain("Warnings in the tree · 0");
  });

  it("shows the answer being awaited and a refusal beside the proposal", () => {
    const id = shapeId(sample.pendingChange);
    const pending: Record<string, ChangeAction> = { [id]: { kind: "apply", status: "pending" } };
    const waiting = view(snapshot({ actions: pending }));
    expect(waiting).toContain("Working...");
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
    const closed = view(snapshot());
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).toContain("See before and after");
    const details: Record<string, ChangeDetail> = {
      [id]: { status: "ready", changeSet: sampleChangeSet() }
    };
    const open = view(snapshot({ details }));
    expect(open).toContain('aria-expanded="true"');
    expect(open).toContain("Hide before and after");
    expect(open).toContain("Testing effect, under Memory and learning");
    expect(open).toContain("Quizzing beats rereading, in Retrieval practice");
    expect(open).toContain(">Before</h4>");
    expect(open).toContain(">After</h4>");
  });

  it("shows the before and after loading, missing and failed", () => {
    const id = shapeId(sample.pendingChange);
    const states: Array<[ChangeDetail, string]> = [
      [{ status: "loading" }, "Loading..."],
      [{ status: "missing" }, "This change no longer exists."],
      [{ status: "error" }, "The details could not be loaded."]
    ];
    for (const [detail, text] of states) {
      expect(view(snapshot({ details: { [id]: detail } })), text).toContain(text);
    }
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
          load: {
            status: "ready",
            shape: sampleShape({ changedToday: [sampleChange({ undo })] })
          }
        })
      );
    expect(html("unavailable")).not.toContain(">Undo<");
    expect(html("blocked")).not.toContain(">Undo<");
    expect(html("blocked")).toContain("It cannot be undone now: a later change depends on it.");
  });

  it("shows an undo in progress, a refusal and a failure", () => {
    const id = shapeId(sample.todayChange);
    const withAction = (action: ChangeAction) => view(snapshot({ actions: { [id]: action } }));
    expect(withAction({ kind: "undo", status: "pending" })).toContain("Undoing...");
    expect(
      withAction({ kind: "undo", status: "blocked", messageKey: "topics.shape.changed.blocked" })
    ).toContain("a later change depends on it");
    const failed = withAction({
      kind: "undo",
      status: "failed",
      messageKey: "topics.shape.changed.failed"
    });
    expect(failed).toContain('role="alert"');
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
  it("shows a busy placeholder while loading, with no chart and no controls for it", () => {
    const html = view(snapshot({ load: { status: "loading" } }));
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Loading the topic tree...");
    expect(html).not.toContain("data-cell");
    expect(html).not.toContain("Zoom in");
  });

  it("shows a failure that can be retried", () => {
    const html = view(snapshot({ load: { status: "error" } }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("The topic tree could not be loaded.");
    expect(html).toContain(">Retry<");
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

  it("says the tree is being prepared when there is none yet", () => {
    expect(view(snapshot({ load: { status: "missing" } }))).toContain(
      messages.en.topics.navigator.preparing
    );
  });

  it("says nothing is organized when the tree holds no items, and still shows the day's changes", () => {
    const empty = sampleShape({
      nodes: [{ ...sampleNodes()[0]!, items: 0, directItems: 0, children: 0 }],
      summary: { ...sampleShape().summary, items: 0, topics: 0, unsortedShare: 0 }
    });
    const html = view(snapshot({ load: { status: "ready", shape: empty } }));
    expect(html).toContain("Nothing is organized yet.");
    expect(html).not.toContain("data-cell");
    expect(html).toContain("Changed today");
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
        snapshot({ load: { status: "loading" } })
      ];
      for (const state of states) {
        const html = view(state, {}, language);
        expect(html, language).not.toContain("[[missing");
        expect(html, language).toContain(`>${messages[language].topics.shape.title}</h1>`);
      }
      const table = view(snapshot(), { display: "table" }, language);
      expect(table, language).toContain(messages[language].topics.shape.table.caption);
      expect(view(snapshot(), {}, language), language).toContain(
        messages[language].topics.shape.chart.legendWidth
      );
    }
  });
});
