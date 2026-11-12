import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator, supportedLanguageCodes, type LanguageCode } from "@app/i18n";

import { IcicleDiff, IcicleDiffView, type IcicleDiffViewProps } from "./IcicleDiff";
import type { IcicleDiffLoad, IcicleDiffSnapshot } from "./icicle-diff-controller";
import {
  boundedNodes,
  diffId,
  diffTopics,
  sampleDiffNodes,
  sampleTopicDiff
} from "./icicle-diff-fixtures";
import { diffCellKey } from "./icicle-layout";

const noop = () => undefined;

function snapshot(load: IcicleDiffLoad, selectedId: string | null = null): IcicleDiffSnapshot {
  return { load, selectedId };
}

const ready = (nodes = sampleDiffNodes(), hidden = 0, selectedId: string | null = null) =>
  snapshot({ status: "ready", nodes, hidden }, selectedId);

function view(
  state: IcicleDiffSnapshot,
  overrides: Partial<IcicleDiffViewProps> = {},
  language: LanguageCode = "en"
): string {
  return renderToString(
    <IcicleDiffView
      t={createTranslator(language)}
      snapshot={state}
      display="chart"
      onDisplay={noop}
      onSelect={noop}
      onRetry={noop}
      {...overrides}
    />
  );
}

const decode = (text: string) => text.replaceAll("&amp;", "&").replaceAll("&#x27;", "'");
const attribute = (tag: string, name: string): string | null => {
  const match = new RegExp(`\\s${name}="([^"]*)"`).exec(tag);
  return match ? decode(match[1]!) : null;
};

interface Block {
  key: string;
  tag: string;
  inner: string;
  label: string;
}

const blocks = (html: string): Block[] =>
  [...html.matchAll(/(<button\b[^>]*\bdata-cell="([^"]*)"[^>]*>)(.*?)<\/button>/g)].map(
    (match) => ({
      key: match[2]!,
      tag: match[1]!,
      inner: match[3]!,
      label: attribute(match[1]!, "aria-label") ?? ""
    })
  );
const block = (html: string, side: "before" | "after", n: number): Block =>
  blocks(html).find((entry) => entry.key === diffCellKey(side, diffId(n)))!;
const text = (html: string) => decode(html.replace(/<[^>]*>/g, " ").replace(/\s+/g, " "));

describe("the states of the icicle diff", () => {
  it("shows a quiet placeholder while it loads", () => {
    const html = view(snapshot({ status: "loading" }));
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Loading the change...");
    expect(blocks(html)).toHaveLength(0);
  });

  it("keeps a failure visible and retryable", () => {
    const html = view(snapshot({ status: "error" }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("The change could not be loaded.");
    expect(html).toContain(">Retry<");
  });

  it("says when the change is gone, has no topic structure, or touched nothing", () => {
    expect(text(view(snapshot({ status: "missing" })))).toContain("This change no longer exists.");
    expect(text(view(snapshot({ status: "unsupported" })))).toContain(
      "This change has no topic structure to draw."
    );
    const empty = view(ready([]));
    expect(text(empty)).toContain("This change did not touch the topic structure.");
    expect(blocks(empty)).toHaveLength(0);
    expect(empty).not.toContain('role="tablist"');
  });

  it("draws nothing before the first read", () => {
    const html = view(snapshot({ status: "idle" }));
    expect(blocks(html)).toHaveLength(0);
    expect(text(html).trim()).toBe("");
    const stateful = renderToString(
      <IcicleDiff
        t={createTranslator("en")}
        target={{ kind: "topic", id: diffId(700) }}
        load={() => Promise.resolve(sampleTopicDiff())}
      />
    );
    expect(blocks(stateful)).toHaveLength(0);
  });
});

describe("the icicles of a change", () => {
  const html = view(ready());

  it("draws the tree before and the tree after, each as a group of buttons", () => {
    // A marker a host's single-key shortcuts can test against (`closest("[data-icicle-diff]")`).
    expect(html).toContain('data-icicle-diff=""');
    expect(html).toContain('role="tablist"');
    expect(html).toMatch(/<h4[^>]*>Before<\/h4>/);
    expect(html).toMatch(/<h4[^>]*>After<\/h4>/);
    expect(html).toContain(
      'aria-label="Topic tree before the change. Each block is a button that selects a topic."'
    );
    expect(html).toContain(
      'aria-label="Topic tree after the change. Each block is a button that selects a topic."'
    );
    const all = blocks(html);
    expect(all.filter((entry) => entry.key.startsWith("before:"))).toHaveLength(6);
    expect(all.filter((entry) => entry.key.startsWith("after:"))).toHaveLength(6);
    expect(block(html, "before", diffTopics.misc)).toBeDefined();
    expect(
      blocks(html).some((entry) => entry.key === diffCellKey("after", diffId(diffTopics.misc)))
    ).toBe(false);
    expect(
      blocks(html).some(
        (entry) => entry.key === diffCellKey("before", diffId(diffTopics.retrieval))
      )
    ).toBe(false);
  });

  it("names each block for what a reader needs, never by id", () => {
    expect(block(html, "after", diffTopics.forgetting).label).toBe(
      "Forgetting curve, Renamed, level 2"
    );
    expect(block(html, "before", diffTopics.forgetting).label).toBe("Forgetting, Renamed, level 2");
    expect(block(html, "before", diffTopics.misc).label).toBe(
      "Misc, Removed, level 1, moved out: 6 items"
    );
    expect(block(html, "after", diffTopics.retrieval).label).toBe(
      "Retrieval practice, Added, level 2, moved in: 4 items"
    );
    // The ids live in the `data-cell` hooks only, never in a name, a label or a title.
    expect(html.replaceAll(/ data-cell="[^"]*"/g, "")).not.toMatch(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/
    );
  });

  it("tints by token and pairs every tint with its own glyph", () => {
    const expected: Array<[Block, string, string]> = [
      [block(html, "after", diffTopics.retrieval), "--state-success-soft", "lucide-plus"],
      [block(html, "before", diffTopics.misc), "--state-danger-soft", "lucide-minus"],
      [block(html, "after", diffTopics.spacing), "--state-info-soft", "lucide-move-right"],
      [block(html, "after", diffTopics.forgetting), "--state-info-soft", "lucide-pencil"],
      [block(html, "after", diffTopics.memory), "--state-info-soft", "lucide-arrow-right-left"],
      [block(html, "after", diffTopics.root), "--surface-soft", "lucide-circle-dashed"]
    ];
    // A block too small for its name carries its glyph in the legend, beside its letter.
    const legend = html.slice(html.indexOf("Small blocks, by letter"));
    for (const [entry, token, glyph] of expected) {
      expect(attribute(entry.tag, "style"), entry.key).toContain(`background:var(${token})`);
      expect(entry.inner + legend, entry.key).toContain(glyph);
    }
    const glyphs = new Set(expected.map(([, , glyph]) => glyph));
    expect(glyphs.size).toBe(expected.length);
    expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(/);
  });

  it("writes the name and the change in a wide block and a letter key in a narrow one", () => {
    const wide = block(html, "after", diffTopics.retrieval);
    expect(text(wide.inner)).toContain("Retrieval practice");
    expect(text(wide.inner)).toContain("Added");
    expect(text(wide.inner)).toContain("+4");
    const narrow = block(html, "after", diffTopics.forgetting);
    expect(text(narrow.inner).trim()).toMatch(/^[a-z]$/);
    expect(narrow.label).toContain("Forgetting curve");
    expect(text(block(html, "before", diffTopics.misc).inner)).toContain("−6");
  });

  it("never shows a bare number in a block: a count always has its name or its words beside it", () => {
    for (const entry of blocks(html)) {
      const words = text(entry.inner).trim();
      expect(words, entry.key).not.toMatch(/^[+−]?\d+$/);
    }
  });

  it("names every lettered block in a legend under the lanes, once per topic", () => {
    const legend = [
      ...html.matchAll(/<li class="inline-flex items-center gap-1\.5"><span[^>]*>([a-z])<\/span>/g)
    ].map((match) => match[1]);
    expect(legend.length).toBeGreaterThan(0);
    expect(new Set(legend).size).toBe(legend.length);
    expect(html).toContain('aria-label="Small blocks, by letter"');
    expect(text(html)).toContain("Forgetting · Renamed");
    // A letter on a block is a letter of the legend, on either side of the diff.
    const letters = new Set(
      blocks(html)
        .map((entry) => text(entry.inner).trim())
        .filter((entry) => /^[a-z]$/.test(entry))
    );
    for (const letter of letters) expect(legend).toContain(letter);
  });

  it("holds one tab stop per side and moves it to the selected topic", () => {
    const stops = (page: string) =>
      blocks(page)
        .filter((entry) => attribute(entry.tag, "tabindex") === "0")
        .map((entry) => entry.key);
    expect(stops(html)).toEqual([
      diffCellKey("before", diffId(diffTopics.root)),
      diffCellKey("after", diffId(diffTopics.root))
    ]);
    const selected = view(ready(sampleDiffNodes(), 0, diffId(diffTopics.spacing)));
    expect(stops(selected)).toEqual([
      diffCellKey("before", diffId(diffTopics.spacing)),
      diffCellKey("after", diffId(diffTopics.spacing))
    ]);
  });

  it("rings the selected topic on both sides, or on the one side it is on", () => {
    const pressed = (page: string) =>
      blocks(page)
        .filter((entry) => attribute(entry.tag, "aria-pressed") === "true")
        .map((entry) => entry.key);
    expect(pressed(html)).toEqual([]);
    const both = view(ready(sampleDiffNodes(), 0, diffId(diffTopics.spacing)));
    expect(pressed(both)).toHaveLength(2);
    expect(attribute(block(both, "after", diffTopics.spacing).tag, "style")).toContain(
      "box-shadow:inset 0 0 0 2px var(--accent)"
    );
    const one = view(ready(sampleDiffNodes(), 0, diffId(diffTopics.misc)));
    expect(pressed(one)).toEqual([diffCellKey("before", diffId(diffTopics.misc))]);
    // A selection the read lost is no selection.
    expect(pressed(view(ready(sampleDiffNodes(), 0, diffId(99))))).toEqual([]);
  });

  it("explains the colours with a legend that counts topics, and says how much was left out", () => {
    const legend = text(html);
    for (const item of [
      "Added: 1",
      "Removed: 1",
      "Moved: 1",
      "Renamed: 1",
      "Items moved: 2",
      "Unchanged: 1"
    ])
      expect(legend, item).toContain(item);
    expect(legend).not.toContain("Edited");
    expect(legend).toContain("Wider block = more items moved · row = level");
    expect(legend).not.toContain("1 more changed");
    expect(text(view(ready(sampleDiffNodes(), 3)))).toContain(
      "3 more changed topics, deeper in the tree, are not listed."
    );
  });

  it("marks a topic whose parent the read does not list", () => {
    const moved = sampleDiffNodes().filter((node) => node.id !== diffId(diffTopics.language));
    const page = view(ready(moved));
    expect(attribute(block(page, "before", diffTopics.spacing).tag, "class")).toContain(
      "border-dashed"
    );
    expect(text(page)).toContain("the topic above it is not listed");
    expect(text(html)).not.toContain("the topic above it is not listed");
  });

  it("says when a side has nothing", () => {
    const created = view(ready([sampleDiffNodes()[0]!, sampleDiffNodes()[4]!]));
    expect(text(created)).toContain("Before");
    const only = view(ready([{ ...sampleDiffNodes()[4]!, parentAfter: null }]));
    expect(text(only)).toContain("No topic stood here before the change.");
  });

  it("does not draw what is too narrow and sends the reader to the table", () => {
    const page = view(ready(boundedNodes(200), 12));
    const drawn = blocks(page);
    expect(drawn.length).toBeGreaterThan(0);
    expect(drawn.length).toBeLessThan(400);
    expect(text(page)).toContain(
      "Very narrow blocks are not drawn here. The table lists every topic."
    );
    expect(text(page)).toContain("12 more changed topics");
  });
});

describe("the selected topic", () => {
  it("asks for a selection first", () => {
    expect(text(view(ready()))).toContain(
      "Select a block or a row to see what changed in that topic."
    );
  });

  it("tells what happened to the topic in words, with a way to open it", () => {
    const page = view(ready(sampleDiffNodes(), 0, diffId(diffTopics.forgetting)), {
      onOpenTopic: noop
    });
    const words = text(page);
    expect(words).toContain("Selected topic");
    expect(words).toContain("Forgetting curve · was Forgetting");
    expect(words).toContain("Renamed");
    expect(words).toContain("Under, before Memory");
    expect(words).toContain("Under, after Memory");
    expect(page).toContain('aria-live="polite"');
    expect(page).toContain(">Open topic<");
  });

  it("offers no way to open a topic that is gone, or when the host cannot open one", () => {
    const gone = view(ready(sampleDiffNodes(), 0, diffId(diffTopics.misc)), { onOpenTopic: noop });
    expect(gone).not.toContain(">Open topic<");
    expect(text(gone)).toContain("No longer exists");
    expect(view(ready(sampleDiffNodes(), 0, diffId(diffTopics.spacing)))).not.toContain(
      ">Open topic<"
    );
  });

  it("says where a new topic did not stand before", () => {
    const page = text(view(ready(sampleDiffNodes(), 0, diffId(diffTopics.retrieval))));
    expect(page).toContain("Did not exist");
    expect(page).toContain("Under, after Memory");
  });
});

describe("the table alternative", () => {
  const html = view(ready(), { display: "table" });

  it("swaps the chart for a table that lists every topic once", () => {
    expect(blocks(html)).toHaveLength(0);
    expect(html).toContain("<table");
    expect(html).toContain("Topics this change touched, with their place before and after");
    expect(html.match(/<th scope="row"/g)).toHaveLength(7);
    expect(html).toMatch(/<th scope="col"[^>]*>Topic<\/th>/);
    for (const head of ["Change", "Under, before", "Under, after", "Items in", "Items out"])
      expect(html, head).toContain(`>${head}</th>`);
    expect(html).toContain('aria-selected="true"');
  });

  it("carries the same facts as the chart: names, change words, places and counts", () => {
    const words = text(html);
    expect(words).toContain("Forgetting curve was Forgetting");
    expect(words).toContain("Retrieval practice");
    expect(words).toContain("Did not exist");
    expect(words).toContain("No longer exists");
    expect(words).toContain("Top of the tree");
    for (const change of ["Added", "Removed", "Moved", "Renamed", "Items moved", "Unchanged"])
      expect(words, change).toContain(change);
    expect(html).toContain("lucide-plus");
    expect(html).toContain("lucide-minus");
    expect(html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/);
  });

  it("marks the selected row as pressed", () => {
    const page = view(ready(sampleDiffNodes(), 0, diffId(diffTopics.spacing)), {
      display: "table"
    });
    expect(page.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(page).toContain("bg-accent-soft");
  });

  it("lists all 200 topics of a bounded diff, including the ones too narrow to draw", () => {
    const page = view(ready(boundedNodes(200)), { display: "table" });
    expect(page.match(/<th scope="row"/g)).toHaveLength(200);
  });
});

describe("the diff in every language", () => {
  it("reads without a missing message in the chart, the table and every state", () => {
    for (const locale of supportedLanguageCodes) {
      const pages = [
        view(
          ready(sampleDiffNodes(), 2, diffId(diffTopics.forgetting)),
          { onOpenTopic: noop },
          locale
        ),
        view(ready(sampleDiffNodes(), 0, diffId(diffTopics.misc)), { display: "table" }, locale),
        view(ready([]), {}, locale),
        view(snapshot({ status: "loading" }), {}, locale),
        view(snapshot({ status: "error" }), {}, locale),
        view(snapshot({ status: "missing" }), {}, locale),
        view(snapshot({ status: "unsupported" }), {}, locale)
      ];
      for (const page of pages) {
        expect(page, locale).not.toContain("[[missing");
        expect(page, locale).not.toMatch(/\{\w+\}/);
      }
    }
  });
});
