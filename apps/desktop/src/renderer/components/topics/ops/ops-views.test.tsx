import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator, supportedLanguageCodes } from "@app/i18n";

import { FakeTopics, id, settle, nodeSummary } from "../topic-fixtures";
import { FloatingMenu, nextEnabled, type MenuItem } from "./FloatingMenu";
import { InlineTitleEditor } from "./InlineTitleEditor";
import { TopicMoveDialog } from "./TopicMoveDialog";
import { TopicNameDialog } from "./TopicNameDialog";
import { TopicUndoToast } from "./TopicUndoToast";
import { actionRowOf, isPinnedRow, topicMenuItems } from "./nav-ops";
import { opsErrorText } from "./topic-ops";
import type { ShownNotice } from "./topic-ops-controller";
import { TopicPickerController } from "./topic-picker";
import type { NavRow, PlaceRow, TopicRow } from "../topic-navigation";

const en = createTranslator("en");
const noop = () => undefined;
const plain = (html: string) => html.replaceAll("<!-- -->", "");

const notice = (overrides: Partial<ShownNotice> = {}): ShownNotice => ({
  id: 1,
  key: "topics.ops.toast.renamed",
  title: "Memory",
  parent: null,
  changeSetId: id(50),
  state: "idle",
  ...overrides
});

const toast = (value: ShownNotice | null, t = en) =>
  plain(
    renderToString(
      <TopicUndoToast t={t} notice={value} onUndo={noop} onDismiss={noop} onHold={noop} />
    )
  );

describe("the notice that follows a change", () => {
  it("keeps a polite live region on the page even with nothing to say", () => {
    const html = toast(null);
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).not.toContain("<button");
  });

  it("says what happened and offers Undo and Dismiss, reachable by keyboard", () => {
    const html = toast(notice());
    expect(html).toContain("Renamed to Memory.");
    expect(html).toMatch(/<button[^>]*aria-keyshortcuts="U"[^>]*>.*Undo<\/button>/s);
    expect(html).toContain('aria-label="Dismiss"');
    expect(html).not.toContain("tabindex");
  });

  it("names both topics of a move, and says 'Unnamed topic' for one without a name", () => {
    const html = toast(
      notice({ key: "topics.ops.toast.moved", title: null, parent: "Open science" })
    );
    expect(html).toContain("Moved Unnamed topic under Open science.");
  });

  it("shows the states of an undo: working, blocked, failed, and done with nothing to undo", () => {
    expect(toast(notice({ state: "pending" }))).toMatch(
      /<button[^>]*disabled=""[^>]*>.*Undoing\.\.\./s
    );
    const blocked = toast(notice({ state: "blocked" }));
    expect(blocked).toContain("a later change depends on it");
    expect(blocked).not.toContain("Undo</button>");
    const failed = toast(notice({ state: "failed" }));
    expect(failed).toContain("The change could not be undone. Try again.");
    expect(failed).toContain("Undo</button>");
    const done = toast(
      notice({ key: "topics.ops.toast.undone", changeSetId: null, state: "none", title: null })
    );
    expect(done).toContain("Change undone.");
    expect(done).not.toContain("Undo</button>");
  });

  it("is written in every language, with no missing message", () => {
    for (const locale of supportedLanguageCodes) {
      const t = createTranslator(locale);
      for (const key of [
        "topics.ops.toast.renamed",
        "topics.ops.toast.moved",
        "topics.ops.toast.created",
        "topics.ops.toast.pinned",
        "topics.ops.toast.unpinned",
        "topics.ops.toast.placed",
        "topics.ops.toast.alsoPlaced",
        "topics.ops.toast.undone"
      ] as const) {
        const html = toast(notice({ key, title: "Alpha", parent: "Beta" }), t);
        expect(html, `${locale} ${key}`).not.toContain("[[missing");
        expect(html, `${locale} ${key}`).not.toContain("{title}");
        expect(html, `${locale} ${key}`).not.toContain("{parent}");
      }
    }
  });
});

describe("the title editor and the dialogs", () => {
  it("renders the editor as a labelled text field with the name selected for editing", () => {
    const html = plain(
      renderToString(
        <InlineTitleEditor
          initial="Memory"
          label="Topic name"
          invalid
          onCommit={noop}
          onCancel={noop}
        />
      )
    );
    expect(html).toMatch(/<input[^>]*aria-label="Topic name"/);
    expect(html).toContain('value="Memory"');
    expect(html).toContain('aria-invalid="true"');
  });

  it("asks for a name under the topic it names, or at the top level", () => {
    const under = plain(
      renderToString(
        <TopicNameDialog
          t={en}
          parentTitle="Memory"
          top={false}
          busy={false}
          error={null}
          onSubmit={noop}
          onCancel={noop}
        />
      )
    );
    expect(under).toContain("New subtopic in Memory");
    expect(under).toMatch(/<dialog[^>]*aria-labelledby/);
    expect(under).toContain(">Create<");
    const top = plain(
      renderToString(
        <TopicNameDialog
          t={en}
          parentTitle={null}
          top
          busy
          error="topics.errors.duplicateTitle"
          onSubmit={noop}
          onCancel={noop}
        />
      )
    );
    expect(top).toContain("New top-level topic");
    expect(top).toContain('role="alert"');
    expect(top).toContain("A topic with this name already exists here.");
    expect(top).toContain("Working...");
  });

  it("limits the count a refusal names to the real limits", () => {
    expect(opsErrorText(en, "topics.ops.rename.tooLong")).toContain("120");
    expect(opsErrorText(en, "viewHistory.pinLimit")).toContain("10");
  });
});

describe("the Move to dialog", () => {
  const R = id(1);
  const A = id(2);
  const B = id(3);
  const fake = () =>
    new FakeTopics({
      rootId: R,
      topics: [
        { id: R, parentId: null, title: null, children: [A, B] },
        { id: A, parentId: R, title: "Memory & learning", children: [] },
        { id: B, parentId: R, title: null }
      ]
    });

  const dialog = (
    picker: TopicPickerController,
    overrides: Partial<Parameters<typeof TopicMoveDialog>[0]> = {}
  ) =>
    plain(
      renderToString(
        <TopicMoveDialog
          t={en}
          mode="move"
          subjectTitle="Decay"
          currentParentId={null}
          picker={picker}
          busy={false}
          error={null}
          onConfirm={noop}
          onCancel={noop}
          {...overrides}
        />
      )
    );

  it("says it is loading before the first level is read", () => {
    const html = dialog(new TopicPickerController(() => fake().api, null));
    expect(html).toContain("Move Decay");
    expect(html).toContain("Loading topics...");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Move here<\/button>/);
  });

  it("lists the subtopics of the level on show, with the path, a filter and a way up", async () => {
    const picker = new TopicPickerController(() => fake().api, null);
    picker.open();
    await settle();
    const html = dialog(picker);
    expect(html).toContain('aria-label="Location"');
    expect(html).toContain(">All topics<");
    expect(html).toContain("Memory &amp; learning");
    expect(html).toContain("Unnamed topic");
    expect(html).toContain('aria-label="Filter topics"');
    expect(html).toContain('aria-label="Up one level"');
    expect(html).toMatch(
      /<button[^>]*disabled=""[^>]*aria-label="Up one level"|aria-label="Up one level"[^>]*disabled/
    );
    expect(html).toContain(">Cancel<");
    expect(html).not.toMatch(/<button[^>]*disabled=""[^>]*>Move here<\/button>/);
  });

  it("does not move a topic to the parent it already has, and says so", async () => {
    const picker = new TopicPickerController(() => fake().api, null);
    picker.open();
    await settle();
    const html = dialog(picker, { currentParentId: R });
    expect(html).toContain("It is already here.");
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>Move here<\/button>/);
  });

  it("offers an empty level, a failed read and a place that is not the root for an item", async () => {
    const failing = fake();
    failing.failNext.tree = "boom";
    const broken = new TopicPickerController(() => failing.api, null);
    broken.open();
    await settle();
    const error = dialog(broken);
    expect(error).toContain('role="alert"');
    expect(error).toContain("The topics could not be loaded.");
    expect(error).toContain("Retry");

    const picker = new TopicPickerController(() => fake().api, null);
    picker.open();
    await settle();
    picker.enter({ id: A, title: "Memory & learning" });
    await settle();
    const empty = dialog(picker, { mode: "place", subjectTitle: "A note" });
    expect(empty).toContain("Place A note in a topic");
    expect(empty).toContain("There are no subtopics here.");
    expect(empty).toContain(">Place here<");
    expect(empty).toContain(">Also show here<");
    expect(empty).not.toMatch(/<button[^>]*disabled=""[^>]*>Place here<\/button>/);

    // At the root an item is not placed: the engine keeps those in Unsorted.
    const root = new TopicPickerController(() => fake().api, null);
    root.open();
    await settle();
    const atRoot = dialog(root, { mode: "place", subjectTitle: "A note" });
    expect(atRoot).toContain("Open a topic to place it there.");
    expect(atRoot).toMatch(/<button[^>]*disabled=""[^>]*>Place here<\/button>/);
  });

  it("is written in every language, with no missing message", async () => {
    const picker = new TopicPickerController(() => fake().api, null);
    picker.open();
    await settle();
    for (const locale of supportedLanguageCodes) {
      const html = plain(
        renderToString(
          <TopicMoveDialog
            t={createTranslator(locale)}
            mode="place"
            subjectTitle="Alpha"
            currentParentId={null}
            picker={picker}
            busy={false}
            error="topics.errors.cycle"
            onConfirm={noop}
            onCancel={noop}
          />
        )
      );
      expect(html, locale).not.toContain("[[missing");
      expect(html, locale).not.toContain("{title}");
    }
  });
});

describe("the actions menu", () => {
  const items = (disabled: boolean[]): MenuItem[] =>
    disabled.map((flag, n) => ({
      id: `i${n}`,
      label: `Item ${n}`,
      disabled: flag,
      onSelect: noop
    }));

  it("moves between enabled items, wrapping round", () => {
    const list = items([false, true, false, false]);
    expect(nextEnabled(list, -1, 1)).toBe(0);
    expect(nextEnabled(list, 0, 1)).toBe(2);
    expect(nextEnabled(list, 3, 1)).toBe(0);
    expect(nextEnabled(list, 0, -1)).toBe(3);
    expect(nextEnabled(list, 2, -1)).toBe(0);
    expect(nextEnabled(items([true, true]), 0, 1)).toBe(-1);
  });

  it("renders a labelled menu of menu items at the point it was asked for", () => {
    const html = plain(
      renderToString(
        <FloatingMenu
          label="Topic actions"
          anchor={{ x: 4, y: 4 }}
          items={items([false, true])}
          onClose={noop}
        />
      )
    );
    // The server has no window; the menu clamps against one, so render it where one exists.
    expect(html).toContain('role="menu"');
    expect(html).toContain('aria-label="Topic actions"');
    expect(html.match(/role="menuitem"/g)).toHaveLength(2);
    expect(html).toMatch(/disabled=""/);
  });

  const topicRow = (management: "ai" | "pinned" = "ai"): TopicRow => ({
    type: "topic",
    key: "t:x",
    level: 1,
    parentKey: null,
    posInSet: 1,
    setSize: 1,
    node: nodeSummary({ id: id(2), title: "Memory", management }),
    expandable: false,
    expanded: false
  });
  const placeRow = (pinned: boolean): PlaceRow => ({
    type: "place",
    key: "p:x",
    level: 1,
    parentKey: null,
    posInSet: 1,
    setSize: 1,
    place: {
      address: `memora://topic/${id(2)}`,
      kind: "topic",
      id: id(2),
      title: "Memory",
      pinned,
      count: 3,
      health: "good",
      management: "ai",
      source: null
    }
  });
  const actions = { rename: noop, create: noop, move: noop, togglePin: noop };

  it("offers a topic its four actions, with Pin or Unpin by its protection", () => {
    expect(topicMenuItems(en, topicRow(), actions, false).map((item) => item.label)).toEqual([
      "Rename",
      "New subtopic",
      "Move to...",
      "Pin"
    ]);
    expect(topicMenuItems(en, topicRow("pinned"), actions, false).at(-1)?.label).toBe("Unpin");
    expect(topicMenuItems(en, topicRow(), actions, true).every((item) => item.disabled)).toBe(true);
  });

  it("offers a topic in Pinned or Recents only to pin or unpin it", () => {
    expect(topicMenuItems(en, placeRow(true), actions, false).map((item) => item.label)).toEqual([
      "Unpin"
    ]);
    expect(topicMenuItems(en, placeRow(false), actions, false).map((item) => item.label)).toEqual([
      "Pin"
    ]);
    expect(isPinnedRow(placeRow(true))).toBe(true);
    expect(isPinnedRow(topicRow())).toBe(false);
  });

  it("gives actions to topics only: not to leaves, notes in Recents or the Unsorted group", () => {
    const leaf = { type: "unsorted", key: "unsorted" } as unknown as NavRow;
    expect(actionRowOf(leaf)).toBeNull();
    const note = {
      ...placeRow(false),
      place: { ...placeRow(false).place, kind: "note" }
    } as NavRow;
    expect(actionRowOf(note)).toBeNull();
    expect(actionRowOf(topicRow())).not.toBeNull();
  });
});
