import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator, supportedLanguageCodes } from "@app/i18n";

import { FakeTopics, id, noteLeaf, settle, sourceLeaf } from "./topic-fixtures";
import type { FakeTopic } from "./topic-fixtures";
import { TopicNavigatorView, type NavigatorOps } from "./TopicNavigator";
import { TopicNavigatorStore, type NavigatorSnapshot } from "./topic-navigator-store";
import { itemIdentity, type NavRowOps } from "./ops/nav-ops";
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
  pinnedItems: new Set(),
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

  it("gives the notes and sources of the tree an item actions button, and marks the pinned ones", async () => {
    const note = noteLeaf(1);
    const store = new TopicNavigatorStore(
      new FakeTopics({
        rootId: R,
        topics: [
          { id: R, parentId: null, title: null, children: [A] },
          { id: A, parentId: R, title: "Memory", leaves: [note, sourceLeaf(1)] }
        ]
      }).api
    );
    store.setActive(true);
    await settle();
    store.expand(A);
    await settle();
    const snapshot = store.getSnapshot();
    const plain = view(snapshot, ops());
    expect(plain.match(/aria-label="Topic actions"/g)).toHaveLength(1);
    expect(plain.match(/aria-label="Item actions"/g)).toHaveLength(2);
    // Still one tab stop for the tree, and no pin mark until the history pins one.
    expect(plain.match(/tabindex="0"/g)).toHaveLength(1);
    expect(plain).not.toContain(">Pinned<");
    const pinned = view(
      snapshot,
      ops({ rows: rows({ pinnedItems: new Set([itemIdentity("note", note.id)]) }) })
    );
    expect(pinned.match(/>Pinned</g)).toHaveLength(1);
    // A topic that only the history pins is marked too, though it is not protected.
    const topicOnly = view(
      snapshot,
      ops({ rows: rows({ pinnedItems: new Set([itemIdentity("topic", A)]) }) })
    );
    expect(topicOnly.match(/>Pinned</g)).toHaveLength(1);
    // Read-only without the operations: the leaves have no button either.
    expect(view(snapshot)).not.toContain("Item actions");
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
