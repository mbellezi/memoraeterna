import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator, supportedLanguageCodes } from "@app/i18n";

import { FakeTopics, id, settle } from "./topic-fixtures";
import type { FakeTopic } from "./topic-fixtures";
import { TopicNavigatorView, type NavigatorOps } from "./TopicNavigator";
import { TopicNavigatorStore, type NavigatorSnapshot } from "./topic-navigator-store";
import type { NavRowOps } from "./ops/nav-ops";
import { topicKey } from "./topic-navigation";

const R = id(1);
const A = id(2);
const B = id(3);
const noop = () => undefined;

function sample(): FakeTopics {
  const topics: FakeTopic[] = [
    { id: R, parentId: null, title: null, children: [A, B] },
    { id: A, parentId: R, title: "Memory & learning" },
    { id: B, parentId: R, title: null, management: "pinned" }
  ];
  return new FakeTopics({ rootId: R, topics });
}

async function loaded(): Promise<NavigatorSnapshot> {
  const store = new TopicNavigatorStore(sample().api);
  store.setActive(true);
  await settle();
  return store.getSnapshot();
}

const rows = (overrides: Partial<NavRowOps> = {}): NavRowOps => ({
  renamingKey: null,
  invalid: false,
  busy: false,
  onStartRename: noop,
  onCommitRename: noop,
  onCancelRename: noop,
  onOpenMenu: noop,
  ...overrides
});

const ops = (overrides: Partial<NavigatorOps> = {}): NavigatorOps => ({
  rows: rows(),
  error: null,
  menu: null,
  overlay: null,
  onCreateTop: noop,
  ...overrides
});

const view = (snapshot: NavigatorSnapshot, value?: NavigatorOps, language = "en") =>
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
      ops={value}
    />
  ).replaceAll("<!-- -->", "");

describe("the navigator with the human operations", () => {
  it("is read-only without them: no editor, no actions, no new topic", async () => {
    const html = view(await loaded());
    expect(html).not.toContain("Topic actions");
    expect(html).not.toContain("New top-level topic");
    expect(html).not.toContain("<input");
  });

  it("gives every topic row an actions button that is not a tab stop, and a way to add a topic", async () => {
    const html = view(await loaded(), ops());
    expect(html.match(/aria-label="Topic actions"/g)).toHaveLength(2);
    expect(html.match(/aria-haspopup="menu"/g)).toHaveLength(2);
    // One tab stop for the whole tree, as before: the buttons are reached by menu key or F2.
    expect(html.match(/tabindex="0"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="New top-level topic"');
    expect(html).toContain('aria-haspopup="dialog"');
  });

  it("hides the new-topic button until the tree is read", () => {
    const html = view(
      {
        branches: new Map(),
        expanded: new Set(),
        places: { phase: "ready", pinned: [], recents: [] },
        status: null,
        reembed: "idle",
        reveal: null
      },
      ops({ onCreateTop: null })
    );
    expect(html).not.toContain("New top-level topic");
  });

  it("swaps the name of the row being renamed for a labelled field holding it", async () => {
    const html = view(await loaded(), ops({ rows: rows({ renamingKey: topicKey(A) }) }));
    expect(html.match(/<input/g)).toHaveLength(1);
    expect(html).toMatch(/<input[^>]*aria-label="Topic name"[^>]*value="Memory &amp; learning"/);
    // The unnamed topic keeps its italic placeholder name.
    expect(html).toContain("Unnamed topic");
  });

  it("starts the field of an unnamed topic empty, and marks a refused name invalid", async () => {
    const html = view(
      await loaded(),
      ops({ rows: rows({ renamingKey: topicKey(B), invalid: true }) })
    );
    expect(html).toMatch(/<input[^>]*value=""/);
    expect(html).toContain('aria-invalid="true"');
  });

  it("tells a refusal that has no dialog of its own, and shows the notice and the open menu", async () => {
    const html = view(
      await loaded(),
      ops({
        error: "topics.errors.stale",
        menu: <div data-menu="">menu</div>,
        overlay: <div data-overlay="">notice</div>
      })
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain("This topic changed since you opened it.");
    expect(html).toContain("data-menu");
    expect(html).toContain("data-overlay");
  });

  it("is written in every language", async () => {
    const snapshot = await loaded();
    for (const locale of supportedLanguageCodes) {
      const html = view(snapshot, ops({ error: "topics.errors.depthCap" }), locale);
      expect(html, locale).not.toContain("[[missing");
    }
  });
});
