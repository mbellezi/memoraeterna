import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator, messages, supportedLanguageCodes, type LanguageCode } from "@app/i18n";
import {
  FakeTopics,
  historyEntry,
  id,
  noteLeaf,
  nodeSummary,
  settle,
  sourceLeaf,
  type FakeTopic
} from "./topic-fixtures";
import { TopicNavigatorView, type TopicNavigatorViewProps } from "./TopicNavigator";
import { TopicNavigatorStore, type NavigatorSnapshot } from "./topic-navigator-store";
import { branchDataFromTree, emptyBranch, rootBranchKey, unsortedKey } from "./topic-navigation";

const R = id(1);
const A = id(2);
const B = id(3);
const C = id(4);
const A1 = id(5);

const noop = () => undefined;
const view = (
  snapshot: NavigatorSnapshot,
  overrides: Partial<TopicNavigatorViewProps> = {},
  language: LanguageCode = "en"
) =>
  renderToString(
    <TopicNavigatorView
      t={createTranslator(language)}
      snapshot={snapshot}
      selectedTopicId={null}
      openFailed={false}
      onAsk={noop}
      onCollapseAll={noop}
      onToggle={noop}
      onActivate={noop}
      onRetryRoot={noop}
      onRetryPlaces={noop}
      onAskReembed={noop}
      onConfirmReembed={noop}
      onCancelReembed={noop}
      {...overrides}
    />
  );

const blank = (overrides: Partial<NavigatorSnapshot> = {}): NavigatorSnapshot => ({
  branches: new Map(),
  expanded: new Set(),
  places: { phase: "ready", pinned: [], recents: [] },
  status: null,
  reembed: "idle",
  reveal: null,
  ...overrides
});

function sample(): FakeTopics {
  const topics: FakeTopic[] = [
    {
      id: R,
      parentId: null,
      title: null,
      children: [A, B, C],
      leaves: [sourceLeaf(1, { unsorted: true }), noteLeaf(90, { unsorted: true })]
    },
    {
      id: A,
      parentId: R,
      title: "Memory & learning",
      children: [A1],
      leaves: [noteLeaf(1), sourceLeaf(2), noteLeaf(3, { role: "secondary" })]
    },
    { id: B, parentId: R, title: null, management: "human", health: "attention" },
    { id: C, parentId: R, title: "Open science", management: "pinned", health: "violation" },
    { id: A1, parentId: A, title: "Decay models", leaves: [noteLeaf(50)] }
  ];
  return new FakeTopics({ rootId: R, topics });
}

async function loaded(
  options: { expand?: string[]; fake?: FakeTopics } = {}
): Promise<NavigatorSnapshot> {
  const fake = options.fake ?? sample();
  const store = new TopicNavigatorStore(fake.api);
  store.setActive(true);
  await settle();
  for (const key of options.expand ?? []) store.expand(key);
  await settle();
  return store.getSnapshot();
}

const trees = (html: string) => html.match(/role="tree"/g)?.length ?? 0;
const items = (html: string) => html.match(/role="treeitem"/g)?.length ?? 0;
const stops = (html: string) => html.match(/tabindex="0"/g)?.length ?? 0;

describe("the navigator's states", () => {
  it("says it is loading before anything is read, with no tree", () => {
    const html = view(blank());
    // A busy region that says "Loading" at once; its eight skeleton rows show after 150 ms.
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain("Loading");
    expect(html).not.toContain("animate-spin");
    expect(trees(html)).toBe(0);
  });

  it("says the topics could not be loaded, with a way to try again", () => {
    const html = view(blank({ branches: new Map([[rootBranchKey, emptyBranch("error")]]) }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("Could not load the tree.");
    expect(html).toContain("Pinned and Recents are still here.");
    expect(html).toContain("Retry");
    expect(trees(html)).toBe(0);
  });

  it("says a failed tree once, with no second retry, when the surface beside it has one", () => {
    const failed = blank({ branches: new Map([[rootBranchKey, emptyBranch("error")]]) });
    const html = view(failed, { retryBeside: true });
    expect(html).toContain("Could not load the tree.");
    expect(html).not.toContain("Retry");
    expect(html).not.toContain('role="alert"');
  });

  it("stacks the sentence of a failed Pinned and Recents read above its retry", () => {
    const html = view(blank({ places: { phase: "error", pinned: [], recents: [] } }));
    expect(html).toContain("Pinned and recent items could not be loaded.");
    expect(html).toContain("Retry");
    expect(html).not.toContain("flex-1 text-xs");
  });

  it("says the tree is being prepared when there is none yet", () => {
    const html = view(blank({ branches: new Map([[rootBranchKey, emptyBranch("ready")]]) }));
    expect(html).toContain("Your topic tree is being prepared.");
    expect(trees(html)).toBe(0);
  });

  it("says nothing is organized yet when the tree holds nothing", async () => {
    const fake = new FakeTopics({ rootId: R, topics: [{ id: R, parentId: null, title: null }] });
    const html = view(await loaded({ fake }));
    expect(html).toContain("Topics grow on their own.");
    expect(html).toContain("You do not need to create folders.");
    expect(trees(html)).toBe(0);
  });

  it("calls a library that holds nothing and builds nothing empty, not being prepared", () => {
    const none = {
      phase: "active" as const,
      counts: { items: 0, placed: 0, pending: 0, needsGate: 0 }
    };
    const html = view(
      blank({ branches: new Map([[rootBranchKey, emptyBranch("ready")]]), status: none })
    );
    expect(html).toContain("Topics grow on their own.");
    expect(html).not.toContain("being prepared");
    const building = view(
      blank({
        branches: new Map([[rootBranchKey, emptyBranch("ready")]]),
        status: { ...none, phase: "building" as const }
      })
    );
    expect(building).toContain("Your topic tree is being prepared.");
  });

  it("shows the tree, with the count of everything in it, once loaded", async () => {
    const html = view(await loaded());
    expect(html).toContain("Explore");
    expect(html).toContain("Memory &amp; learning");
    expect(html).toContain("Open science");
    // Memory holds two of its own and Decay models one, and the root holds two unsorted: five in all.
    expect(html).toMatch(/>Tree<\/span><span class="[^"]*tabular-nums">5 items<\/span>/);
  });

  it("draws the failure of one branch inside the tree and keeps the rest", async () => {
    const snapshot = await loaded({ expand: [A] });
    const branches = new Map(snapshot.branches);
    branches.set(A, emptyBranch("error"));
    const html = view({ ...snapshot, branches });
    expect(html).toContain("Could not load. Retry");
    expect(html).toContain("Open science");
    const loading = new Map(snapshot.branches);
    loading.set(A, emptyBranch("loading"));
    const loadingHtml = view({ ...snapshot, branches: loading });
    expect(loadingHtml).toContain("Loading...");
    expect(loadingHtml).toContain('aria-busy="true"');
  });

  it("draws the failure to read more", async () => {
    const snapshot = await loaded({ expand: [A] });
    const a = snapshot.branches.get(A)!;
    const branches = new Map(snapshot.branches);
    branches.set(A, {
      ...a,
      data: { ...a.data!, moreItems: 2 },
      moreItems: "error"
    });
    expect(view({ ...snapshot, branches })).toContain("Could not load more. Retry");
    branches.set(A, { ...a, data: { ...a.data!, moreItems: 2 }, moreItems: "idle" });
    expect(view({ ...snapshot, branches })).toContain("2 more");
  });

  it("says when a note or source could not be opened and when places could not be loaded", async () => {
    const snapshot = await loaded();
    const html = view(
      { ...snapshot, places: { phase: "error", pinned: [], recents: [] } },
      { openFailed: true }
    );
    expect(html).toContain("That item could not be opened.");
    expect(html).toContain("Pinned and recent items could not be loaded.");
    expect(view(snapshot)).not.toContain("That item could not be opened.");
  });
});

describe("the topic tree", () => {
  it("is an outline with one tab stop, levels, sizes and open states", async () => {
    const html = view(await loaded({ expand: [A] }), {});
    const tree = html.slice(html.indexOf('aria-labelledby="topic-nav-topics"'));
    expect(tree).toContain('aria-level="1"');
    expect(tree).toContain('aria-level="2"');
    expect(tree).toContain('aria-expanded="true"');
    expect(tree).toContain('aria-expanded="false"');
    expect(tree).toContain('aria-posinset="1"');
    expect(tree).toContain('aria-setsize="3"');
    // Memory (open): Decay models, then its leaves.
    expect(tree).toContain("Decay models");
    expect(tree).toContain("Note 1");
    expect(tree).toContain("Source 2");
    // Two trees on this page have a tab stop: the topics and the Unsorted group.
    expect(trees(html)).toBe(2);
    expect(stops(html)).toBe(2);
    expect(html).toContain('aria-labelledby="topic-nav-topics"');
    expect(html).toContain('<h3 id="topic-nav-topics"');
  });

  it("marks what each topic is: created by you, protected, needing attention, unnamed", async () => {
    const html = view(await loaded());
    expect(html).toContain("Created by you");
    expect(html).toContain("Pinned");
    expect(html).toContain("Needs attention");
    expect(html).toContain("Structure problem");
    expect(html).toContain("Unnamed topic");
    // Colour never stands alone: each mark has words, and the glyph itself is hidden from readers.
    expect(html).toContain('class="sr-only">Needs attention');
  });

  it("marks leaves that also appear in a topic, and gives a source its note count", async () => {
    const html = view(await loaded({ expand: [A] }));
    expect(html).toContain("Also placed here");
    expect(html).toContain("Notes: 3");
  });

  it("marks the topic that is open as selected", async () => {
    const html = view(await loaded(), { selectedTopicId: A });
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain('aria-current="true"');
    expect(html.match(/aria-selected="true"/g)).toHaveLength(1);
    expect(view(await loaded())).not.toContain('aria-selected="true"');
  });

  it("offers the Unsorted group with the count of what waits, closed and open", async () => {
    const closed = view(await loaded());
    expect(closed).toContain("Unsorted");
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain("Source 1");
    const open = view(await loaded({ expand: [unsortedKey] }));
    expect(open).toContain("Source 1");
    expect(open).toContain("Note 90");
    // Everything there waits, so the per-leaf marker is not repeated.
    expect(open).not.toContain("Waiting for a place");
  });

  it("marks a leaf that waits at an internal topic", async () => {
    const fake = sample();
    fake.topics.get(A)!.leaves = [noteLeaf(1, { unsorted: true })];
    expect(view(await loaded({ fake, expand: [A] }))).toContain("Waiting for a place");
  });

  it("draws a bounded number of rows however long the tree is", async () => {
    const snapshot = await loaded();
    const parent = nodeSummary({ id: R, title: null, items: 9000, children: 5000 });
    const nodes = Array.from({ length: 5000 }, (_, n) =>
      nodeSummary({ id: id(10_000 + n), parentId: R, title: `Topic ${n}`, items: 2, children: 1 })
    );
    const branches = new Map(snapshot.branches);
    branches.set(
      rootBranchKey,
      emptyBranch(
        "ready",
        branchDataFromTree({
          generation: 1,
          parent,
          nodes,
          items: [],
          moreItems: 0,
          unsorted: 0,
          nextCursor: null
        })
      )
    );
    const html = view({ ...snapshot, branches });
    // The tree is as tall as all its rows, and draws the ones in the first screen.
    expect(html).toContain(`height:${5000 * 28}px`);
    expect(items(html)).toBeLessThan(80);
    expect(html).toContain("Topic 0");
    expect(html).not.toContain("Topic 4999");
  });

  it("offers Collapse all only while something is open", async () => {
    const closed = view(await loaded());
    expect(closed).toMatch(/aria-label="Collapse all"[^>]*disabled/);
    const open = view(await loaded({ expand: [A] }));
    expect(open).not.toMatch(/aria-label="Collapse all"[^>]*disabled/);
  });
});

describe("pinned and recent items", () => {
  it("shows each list only when it has entries, with counts and pin marks for topics", async () => {
    const fake = sample();
    fake.history = [
      historyEntry({
        address: `memora://topic/${A}`,
        kind: "topic",
        id: A,
        title: "Memory & learning",
        pinned: true
      }),
      historyEntry({
        address: `memora://source/${id(8)}`,
        id: id(8),
        title: "A pinned book",
        pinned: true
      }),
      historyEntry({ address: `memora://source/${id(9)}`, id: id(9), title: "A recent book" })
    ];
    const html = view(await loaded({ fake }));
    expect(html).toContain('<h3 id="topic-nav-pinned"');
    expect(html).toContain('<h3 id="topic-nav-recents"');
    expect(html).toContain("A pinned book");
    expect(html).toContain("A recent book");
    expect(html).toContain("Items: 3");
    expect(trees(html)).toBe(4);
    const none = view(await loaded());
    expect(none).not.toContain("topic-nav-pinned");
    expect(none).not.toContain("topic-nav-recents");
  });
});

describe("every language", () => {
  it("draws every state with no missing copy, and the same keys in all five", async () => {
    const snapshot = await loaded({ expand: [A, unsortedKey] });
    const failed = new Map(snapshot.branches);
    failed.set(A, emptyBranch("error"));
    const states = [
      blank(),
      blank({ branches: new Map([[rootBranchKey, emptyBranch("error")]]) }),
      blank({ branches: new Map([[rootBranchKey, emptyBranch("ready")]]) }),
      snapshot,
      { ...snapshot, branches: failed }
    ];
    for (const language of supportedLanguageCodes) {
      for (const state of states) {
        const html = view(state, { openFailed: true }, language);
        expect(html, language).not.toContain("[[missing");
      }
    }
    const walk = (value: object, prefix = ""): string[] =>
      Object.entries(value).flatMap(([key, child]) =>
        typeof child === "string" ? [`${prefix}${key}`] : walk(child as object, `${prefix}${key}.`)
      );
    for (const namespace of ["navigator", "status", "placeholder"] as const) {
      const expected = walk(messages.en.topics[namespace]).sort();
      for (const language of supportedLanguageCodes) {
        expect(
          walk(messages[language].topics[namespace]).sort(),
          `${language} ${namespace}`
        ).toEqual(expected);
      }
    }
  });

  it("keeps the placeholders of every message, so no language leaves a token behind", () => {
    const tokens = (text: string) =>
      [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
    const walk = (value: object, prefix = ""): Array<[string, string]> =>
      Object.entries(value).flatMap(([key, child]) =>
        typeof child === "string"
          ? [[`${prefix}${key}`, child] as [string, string]]
          : walk(child as object, `${prefix}${key}.`)
      );
    for (const namespace of ["navigator", "status"] as const) {
      const english = new Map(walk(messages.en.topics[namespace]));
      for (const language of supportedLanguageCodes) {
        for (const [key, text] of walk(messages[language].topics[namespace])) {
          expect(tokens(text), `${language} ${namespace}.${key}`).toEqual(
            tokens(english.get(key)!)
          );
          expect(text.trim(), `${language} ${namespace}.${key}`).not.toBe("");
        }
      }
    }
  });

  it("formats counts in the interface language", async () => {
    const fake = sample();
    fake.topics.get(A)!.leaves = Array.from({ length: 1500 }, (_, n) => noteLeaf(n));
    const snapshot = await loaded({ fake });
    expect(view(snapshot, {}, "en")).toContain(">1,501<");
    expect(view(snapshot, {}, "pt-BR")).toContain(">1.501<");
  });
});
