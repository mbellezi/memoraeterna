import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { inboxKinds, type InboxItem } from "@app/domain";
import { createTranslator, supportedLanguageCodes, type LanguageCode } from "@app/i18n";

import { countsOf, item, topicDiff, uuid } from "./inbox-fixtures";
import {
  initialInboxState,
  keyOf,
  reduceInbox,
  type InboxEvent,
  type InboxState
} from "./inbox-state";
import { InboxView, type InboxViewProps } from "./InboxView";

const noop = () => undefined;
const now = Date.UTC(2026, 9, 24, 8, 0, 0);

function stateOf(items: InboxItem[], ...events: InboxEvent[]): InboxState {
  return [
    { type: "loaded", items, nextCursor: null, at: now } as InboxEvent,
    { type: "counts", counts: countsOf(items) } as InboxEvent,
    ...events
  ].reduce(reduceInbox, initialInboxState());
}

function view(
  state: InboxState,
  overrides: Partial<InboxViewProps> = {},
  language: LanguageCode = "en"
) {
  return renderToString(
    <InboxView
      t={createTranslator(language)}
      state={state}
      idPrefix="inbox-test"
      openFailed={false}
      listRef={noop}
      detailRef={noop}
      onKey={noop}
      onRetry={noop}
      onFilter={noop}
      onSelect={noop}
      onLoadMore={noop}
      onVerb={noop}
      onUndo={noop}
      onHideUndo={noop}
      onToggleHelp={noop}
      onRetryDiff={noop}
      onOpenObject={noop}
      onOpenSettings={noop}
      {...overrides}
    />,
    {}
  );
}

const everyKind = inboxKinds.map((kind) => item(kind));

describe("the Inbox screen", () => {
  it("shows a loading state while the first page is read", () => {
    const html = view(initialInboxState());
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    // No sentence is drawn: the bars keep the layout, and the status is for screen readers.
    expect(html).not.toContain("Loading your Inbox...");
    expect(html).toContain(">Loading<");
    expect(html).not.toContain('role="listbox"');
  });

  it("shows a failed load with a Retry that can be reached", () => {
    const html = view(reduceInbox(initialInboxState(), { type: "loadFailed" }));
    expect(html).toContain('role="alert"');
    expect(html).toContain("Your Inbox could not be loaded.");
    expect(html).toContain(">Retry<");
  });

  it("shows an empty Inbox as good news, and an empty filter as a way back", () => {
    const empty = view(stateOf([]));
    expect(empty).toContain("Nothing needs you");
    expect(empty).not.toContain('role="listbox"');
    const filtered = view(
      stateOf(
        [],
        { type: "filter", filter: { kind: "duplicate" } },
        { type: "loaded", items: [], nextCursor: null, at: now }
      )
    );
    expect(filtered).toContain("Nothing matches this filter.");
    // The filters stay so the person can leave the empty one.
    expect(filtered).toContain('aria-pressed="true"');
  });

  it("lists the items as a listbox with one tab stop, the selected one named by the list", () => {
    const html = view(stateOf(everyKind));
    expect(html).toContain('role="listbox"');
    expect(html).toContain('tabindex="0"');
    expect(html.match(/role="option"/gu)).toHaveLength(inboxKinds.length);
    expect(html).toContain('aria-selected="true"');
    expect(html.match(/aria-selected="true"/gu)).toHaveLength(1);
    expect(html).toContain('aria-activedescendant="inbox-test-option-0"');
    expect(html).toContain('aria-label="Items waiting for you"');
  });

  it("says each item's risk in a glyph and a word, and how long ago it arose", () => {
    const html = view(stateOf(everyKind));
    for (const word of ["High risk", "Medium risk", "Low risk"]) expect(html).toContain(word);
    expect(html).toContain("3 hours ago");
    expect(html).toContain('aria-hidden="true"');
  });

  it("shows the detail of the selected item with the verbs it offers and their keys", () => {
    const html = view(stateOf([item("review"), item("duplicate")]));
    expect(html).toContain("<h2");
    expect(html).toContain("Topic overview rewrite");
    expect(html).toContain("Involves");
    expect(html).toContain('aria-label="Open “Sleep”"');
    expect(html).toContain(">Apply<");
    expect(html).toContain(">Dismiss<");
    expect(html).toContain('aria-keyshortcuts="A"');
    expect(html).toContain('aria-keyshortcuts="X"');
    expect(html).toContain("<kbd");
  });

  it("draws Backspace on the remove button of a connection, and no X", () => {
    for (const kind of ["suggestion", "contradiction", "withdrawn"] as const) {
      const html = view(stateOf([item(kind)]));
      expect(html, kind).toContain(">Remove<");
      expect(html, kind).toContain('aria-keyshortcuts="Backspace"');
      expect(html, kind).toContain("⌫");
      expect(html, kind).not.toContain('aria-keyshortcuts="X"');
    }
  });

  it("offers the budget's continue as a button without a key", () => {
    const html = view(stateOf([item("budget")]));
    expect(html).toContain(">Continue<");
    expect(html).not.toContain('aria-keyshortcuts="A"');
    expect(html).toContain('aria-keyshortcuts="X"');
  });

  it("offers an Obsidian conflict a way to Settings and no verb", () => {
    const html = view(stateOf([item("obsidian_conflict")]));
    expect(html).toContain("Open Connections in Settings");
    expect(html).not.toContain(`aria-keyshortcuts="A"`);
    expect(html).not.toContain(`aria-keyshortcuts="X"`);
    expect(html).toContain("Notes/Sleep.md");
  });

  it("shows the change a review item would make: loading, failed, gone and the table", () => {
    const base = stateOf([item("review")]);
    const diff = (load: InboxState["diffs"][string]) =>
      view(reduceInbox(base, { type: "diff", changeSetId: uuid(900), load }));
    expect(diff({ status: "loading" })).toContain("Loading the changes...");
    const failed = diff({ status: "error" });
    expect(failed).toContain("The changes could not be loaded.");
    expect(failed).toContain(">Retry<");
    expect(diff({ status: "missing" })).toContain("This change is no longer available.");
    const topic = topicDiff();
    const html = view(
      reduceInbox(stateOf([item("review", { changeSet: topic.summary })]), {
        type: "diff",
        changeSetId: topic.summary.id,
        load: { status: "ready", diff: topic }
      })
    );
    // T95's icicles before and after, with the Chart/Table switch to their table alternative.
    expect(html).toContain("data-icicle-diff");
    expect(html).toContain("Change in the topic structure");
    expect(html).toContain("Topic tree before the change.");
    expect(html).toContain("Topic tree after the change.");
    expect(html).toContain(">Chart<");
    expect(html).toContain(">Table<");
    expect(html).toContain("3 more changed topics, deeper in the tree, are not listed.");
    expect(html).toContain("Select a block or a row to see what changed in that topic.");
    // The change is a word, not only a colour.
    for (const word of ["Moved", "Renamed", "Added", "Unchanged"]) expect(html).toContain(word);
  });

  it("shows a refusal beside the verbs, and a verb that is working", () => {
    const target = item("review");
    const key = keyOf(target);
    const refused = view(
      reduceInbox(stateOf([target]), { type: "actionRefused", key, message: "inbox.result.stale" })
    );
    expect(refused).toContain('role="alert"');
    expect(refused).toContain("This item changed. The list was refreshed.");
    const working = view(
      reduceInbox(stateOf([target]), { type: "actionPending", key, verb: "apply" })
    );
    expect(working).toContain("Working...");
    expect(working).toContain("disabled");
  });

  it("keeps an Undo for the last verb in view, reachable by button and by key", () => {
    const target = item("duplicate");
    const html = view(
      stateOf([item("backlog")], {
        type: "undoable",
        undo: {
          key: keyOf(target),
          kind: "duplicate",
          id: target.id,
          verb: "dismiss",
          message: "inbox.result.dismissed",
          params: {},
          status: "ready"
        }
      })
    );
    expect(html).toContain("Dismissed.");
    expect(html).toContain(">Undo<");
    expect(html).toContain("or press U");
    expect(html).toContain('aria-keyshortcuts="U"');
  });

  it("can hold the focus itself when the last item was decided, so U still reaches it", () => {
    const html = view(
      stateOf([], {
        type: "undoable",
        undo: {
          key: "duplicate:x",
          kind: "duplicate",
          id: uuid(1),
          verb: "dismiss",
          message: "inbox.result.dismissed",
          params: {},
          status: "ready"
        }
      })
    );
    expect(html).toContain("Nothing needs you");
    expect(html).toMatch(/^<div tabindex="-1" aria-label="Inbox" role="region"/u);
    expect(html).toContain("or press U");
  });

  it("shows the keyboard help when it is open, and says when keys do not work", () => {
    const closed = view(stateOf(everyKind));
    expect(closed).toContain('aria-expanded="false"');
    expect(closed).not.toContain("Next or previous item");
    const open = view(reduceInbox(stateOf(everyKind), { type: "help" }));
    expect(open).toContain('aria-expanded="true"');
    for (const text of ["Next or previous item", "Go to the details", "Undo the last decision"])
      expect(open).toContain(text);
    expect(open).toContain("never while you type or in a dialog");
    expect(open).toContain("Continuing past the spending limit is a button, never a key.");
  });

  it("words the keys sheet for the selected item: remove on a connection, dismiss on the rest", () => {
    const sheet = (state: InboxState) => view(reduceInbox(state, { type: "help" }));
    const connection = sheet(stateOf([item("suggestion")]));
    expect(connection).toContain("Remove a connection: it is never suggested again");
    expect(connection).not.toContain("Dismiss: it leaves the Inbox and nothing changes");
    const review = sheet(stateOf([item("review")]));
    expect(review).toContain("Dismiss: it leaves the Inbox and nothing changes");
    expect(review).not.toContain("Remove a connection");
    // Editing names is not offered anywhere: the writer takes none.
    expect(review).not.toContain("Edit the names before applying");
    expect(connection).not.toContain("Edit the names before applying");
  });

  it("shows only the item list when it is the previous panel, the selected item marked", () => {
    const html = view(stateOf(everyKind), { compact: true });
    expect(html).toContain('role="listbox"');
    expect(html.match(/role="option"/gu)).toHaveLength(inboxKinds.length);
    expect(html).toContain('aria-current="true"');
    expect(html).not.toContain("<h2");
    expect(html).not.toContain('aria-label="Filters"');
    expect(view(initialInboxState(), { compact: true })).toContain('aria-busy="true"');
    expect(view(stateOf([]), { compact: true })).toContain("Nothing needs you");
  });

  it("shows the previous panel's error and empty states on the shared words, as the full form does", () => {
    const failed = view(reduceInbox(initialInboxState(), { type: "loadFailed" }), {
      compact: true
    });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Your Inbox could not be loaded.");
    expect(failed).toContain("Nothing was decided or changed.");
    expect(failed.match(/Retry/gu)).toHaveLength(1);
    expect(view(initialInboxState(), { compact: true })).toContain('aria-busy="true"');
    const empty = view(stateOf([]), { compact: true });
    expect(empty).toContain("Nothing needs you");
    // The empty form is the dashed outline of the shared primitive, as in the full form.
    expect(empty).toContain("border-dashed");
  });

  it("gives the item list the width of its tier", () => {
    expect(view(stateOf(everyKind), { listWidth: 300 })).toContain("--inbox-list-w:300px");
    expect(view(stateOf(everyKind), { listWidth: 360 })).toContain("--inbox-list-w:360px");
  });

  it("filters by kind with the count of each, offering only the kinds that have items", () => {
    const html = view(
      stateOf([item("review"), item("duplicate"), item("duplicate", { id: uuid(41) })])
    );
    expect(html).toContain('aria-label="Duplicates: 2"');
    expect(html).toContain('aria-label="To review: 1"');
    expect(html).not.toContain("Obsidian conflicts");
    expect(html).toContain('aria-label="All: 3"');
    expect(html).toContain("Any risk");
  });

  it("lists suggested connections as a kind of their own, with their count", () => {
    const html = view(
      stateOf([item("suggestion"), item("suggestion", { id: uuid(86) }), item("duplicate")])
    );
    expect(html).toContain('aria-label="Suggested connections: 2"');
    expect(html).toContain('aria-label="Duplicates: 1"');
    // A kind with nothing waiting is not offered.
    expect(view(stateOf([item("duplicate")]))).not.toContain("Suggested connections");
  });

  it("shows a suggestion by both notes and its confidence, offering keep and remove and no dismiss", () => {
    const html = view(stateOf([item("suggestion")]));
    // The headline names what is at stake; the risk line of the detail carries kind and confidence.
    expect(html).toContain("Keep this connection?");
    expect(html).toMatch(
      /Suggested connection<\/span><span[^>]*>medium confidence \(64%\)<\/span>/u
    );
    expect(html).not.toContain("Suggested connection · ");
    expect(html).toContain("“Daylight sets the body clock”");
    expect(html).toContain("“Morning light shifts sleep timing”");
    expect(html).toContain("medium confidence (64%)");
    expect(html).toContain(">Keep<");
    expect(html).toContain(">Remove<");
    expect(html).not.toContain(">Dismiss<");
    expect(html).not.toContain(">Apply<");
    // The relation is named once, in the sentence, not again in a line of its own.
    expect(html).toContain("” supports “");
    expect(html).not.toContain("Connection: ");
    // Remove carries no X: x only dismisses (D34), and a suggestion has no dismiss.
    expect(html).not.toContain('aria-keyshortcuts="X"');
  });

  it("words an unknown confidence with no number (D33, Q37)", () => {
    const unknown = item("suggestion", { params: { relationType: "supports", probability: null } });
    const html = view(stateOf([unknown]));
    expect(html).toContain("unknown confidence");
    expect(html).not.toMatch(/%\)/u);
    expect(html).not.toContain("confidence (");
    const pt = view(stateOf([unknown]), {}, "pt-BR");
    expect(pt).toContain("confiança desconhecida");
    expect(pt).not.toMatch(/\d+\s?%/u);
  });

  it("offers to load more, and says when more could not be loaded", () => {
    const more = reduceInbox(stateOf([item("duplicate")]), {
      type: "loaded",
      items: [item("duplicate")],
      nextCursor: "next",
      at: now
    });
    expect(view(more)).toContain(">Load more<");
    expect(view(reduceInbox(more, { type: "moreLoading" }))).toContain("Loading more...");
    const failed = view(
      reduceInbox(reduceInbox(more, { type: "moreLoading" }), { type: "moreFailed" })
    );
    expect(failed).toContain("More items could not be loaded.");
  });

  it("announces a result to assistive technology without moving the focus", () => {
    const html = view(
      reduceInbox(stateOf([item("duplicate")]), {
        type: "announce",
        announcement: "inbox.result.accepted",
        params: { count: 3 }
      })
    );
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("Notes queued to be matched again: 3.");
  });

  it("says when an object could not be opened", () => {
    expect(view(stateOf([item("review")]), { openFailed: true })).toContain(
      "That could not be opened"
    );
  });

  for (const locale of supportedLanguageCodes) {
    it(`${locale}: renders every state with no gap, no raw key and no ID`, () => {
      const states = [
        initialInboxState(),
        reduceInbox(initialInboxState(), { type: "loadFailed" }),
        stateOf([]),
        reduceInbox(stateOf(everyKind), { type: "help" }),
        ...everyKind.map((target) =>
          reduceInbox(stateOf(everyKind), { type: "select", key: keyOf(target) })
        )
      ];
      for (const state of states) {
        const html = view(state, {}, locale);
        expect(html, locale).not.toMatch(/\[\[missing/u);
        expect(html, locale).not.toMatch(/inbox\.[a-z]+\.[a-zA-Z.]+/u);
        // IDs belong to attributes the interface keeps for itself, never to its text.
        const text = html.replace(/<[^>]*>/gu, " ");
        expect(text, locale).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/u);
      }
    });
  }
});

describe("the Inbox destination's key bar, risk groups and verdicts (T142 UX round 1)", () => {
  const mixed = [
    item("review"),
    item("quarantined", { id: "refresh|topic:2" }),
    item("suggestion"),
    item("withdrawn"),
    item("duplicate")
  ];

  it("draws the 40 px key bar from the keys the selected item offers, and the note beside it", () => {
    const html = view(stateOf(mixed), { keyBar: true });
    expect(html).toContain("<footer");
    expect(html).toContain("h-10");
    for (const word of ["navigate", "open", "accept", "dismiss", "undo", "shortcuts"])
      expect(html).toContain(`>${word}<`);
    // Backspace and e are the sheet's and the bar's only where they are offered: the review item
    // offers no remove, and nothing offers the names.
    expect(html).not.toContain(">remove<");
    expect(html).not.toContain(">edit<");
    expect(html).toContain("Single-key shortcuts do not work inside text fields.");
    // The note drops below 1180 px.
    expect(html).toContain("max-[1179px]:hidden");
  });

  it("lists remove, not dismiss, in the bar when a connection is selected", () => {
    const html = view(stateOf(mixed, { type: "select", key: keyOf(mixed[2]!) } as InboxEvent), {
      keyBar: true
    });
    expect(html).toContain(">remove<");
    expect(html).not.toContain(">dismiss<");
  });

  it("has no bar in the previous-panel form or without the option, where a button opens the sheet", () => {
    expect(view(stateOf(mixed), { keyBar: true, compact: true })).not.toContain("<footer");
    const plain = view(stateOf(mixed));
    expect(plain).not.toContain("<footer");
    expect(plain).toContain("Keyboard shortcuts");
  });

  it("offers no keyboard help when nothing waits or the read failed: there is no key to press", () => {
    const empty = view(stateOf([]));
    expect(empty).toContain("Nothing needs you");
    expect(empty).not.toContain("Keyboard shortcuts");
    const failed = view(reduceInbox(initialInboxState(), { type: "loadFailed" }));
    expect(failed).not.toContain("Keyboard shortcuts");
    // A filter that finds nothing keeps the help, with the filters beside it.
    const filtered = view(
      stateOf([], { type: "filter", filter: { kind: "review" } } as InboxEvent)
    );
    expect(filtered).toContain("Keyboard shortcuts");
  });

  it("opens the sheet above the bar, built from the same keys", () => {
    const html = view(stateOf(mixed, { type: "help", open: true } as InboxEvent), { keyBar: true });
    expect(html).toContain('aria-expanded="true"');
    expect(html).toContain("bottom-full");
    expect(html).toContain("Show or hide this help");
  });

  it("heads each run of risk once and names the risk to a screen reader on every option", () => {
    const html = view(stateOf(mixed));
    const headers = html.match(/role="presentation"/gu) ?? [];
    const risks = new Set(mixed.map((entry) => entry.risk));
    expect(headers).toHaveLength(risks.size);
    expect(html.match(/class="sr-only">(High|Medium|Low) risk</gu)).toHaveLength(mixed.length);
  });

  it("draws the list's keyboard ring inside the selected row, so no parent clips it", () => {
    const html = view(stateOf(mixed));
    expect(html).toContain("group-focus-visible:-outline-offset-2");
    expect(html).not.toMatch(/<ul[^>]*focus-visible:outline-offset-2/u);
  });

  it("keeps the verdict on a connection unfilled, with a line saying what each verb stores", () => {
    const html = view(stateOf([item("suggestion")]));
    expect(html).toContain("The connection stays and counts as your decision.");
    expect(html).toContain("The connection goes, and the Gardener does not suggest it again.");
    // Neither verb is the filled (primary) button: a verdict has no safe default.
    expect(html).not.toMatch(
      /<button[^>]*border-accent bg-accent text-accent-foreground[^>]*>Keep/u
    );
    expect(html).toContain("aria-describedby");
    // A withdrawn connection comes back when it is kept.
    expect(view(stateOf([item("withdrawn")]))).toContain(
      "The connection comes back and counts as your decision."
    );
    // A structure proposal keeps its filled Apply and carries no such lines.
    const review = view(stateOf([item("review")]));
    expect(review).not.toContain("counts as your decision");
    expect(review).toMatch(/<button[^>]*border-accent bg-accent[^>]*>Apply/u);
  });

  it("states the count in the subtitle and folds the kinds into one select below 1180 px", () => {
    const html = view(stateOf(mixed));
    expect(html).toContain("5 decisions · riskiest first");
    expect(html).toContain("min-[1180px]:hidden");
    expect(html).toContain("max-[1179px]:hidden");
    expect(view(stateOf([item("review")]))).toContain("1 decision waits for you");
  });

  it("folds the kinds into the select at any width when too many would fill a second row of chips", () => {
    const html = view(stateOf(everyKind));
    expect(html).not.toContain("min-[1180px]:hidden");
    expect(html).toContain("Type");
  });

  it("offers neither filters nor keys when the read failed or nothing waits", () => {
    const failed = view(reduceInbox(initialInboxState(), { type: "loadFailed" }), { keyBar: true });
    expect(failed).not.toContain("<footer");
    expect(failed).not.toContain("Any risk");
    expect(view(stateOf([]), { keyBar: true })).not.toContain("<footer");
  });

  it("keeps the layout while loading: a list column and a detail sheet, no sentence", () => {
    const html = view(initialInboxState(), { listWidth: 300 });
    expect(html).toContain("--inbox-list-w:300px");
    expect(html).toContain("grid-cols-[var(--inbox-list-w)_minmax(0,1fr)]");
  });

  it("keeps the type control a select and the key bar to the always-valid keys while loading", () => {
    const html = view(initialInboxState(), { keyBar: true });
    // The same control as once the items arrive, at every width, disabled until then.
    expect(html).toContain("gap-2 hidden");
    expect(html).toMatch(
      /<select[^>]*disabled=""[^>]*><option value="" selected="">All<\/option>/u
    );
    expect(html).not.toContain("text-secondary-foreground min-[1180px]:hidden");
    for (const word of ["dismiss", "remove", "accept", "retry"])
      expect(html).not.toContain(`>${word}<`);
    expect(html).toContain("undo");
  });

  it("teaches in the empty state with a dashed outline and the Gardener's promise", () => {
    const html = view(stateOf([]));
    expect(html).toContain("border-dashed");
    expect(html).toContain("Nothing needs you");
    expect(html).toContain("The Gardener asks here when a change is risky.");
  });
});
