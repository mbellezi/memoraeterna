import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator } from "@app/i18n";

import type { TopicPageLoad, TopicPageSnapshot } from "./topic-page-controller";
import { TopicPageView, type TopicPageViewProps } from "./TopicPageView";
import { topicFixtureId, topicPage } from "./topic-page-fixtures";

const en = createTranslator("en");
const noop = () => undefined;
const plain = (html: string) => html.replaceAll("<!-- -->", "");

function render(load: TopicPageLoad, overrides: Partial<TopicPageViewProps> = {}): string {
  const snapshot: TopicPageSnapshot = {
    load,
    undo: { status: "idle" },
    notes: null,
    announcement: "",
    readAt: 0
  };
  return plain(
    renderToString(
      <TopicPageView
        t={en}
        snapshot={snapshot}
        active
        actions={{ openTopic: noop, openNote: noop, openSource: noop, openAddress: noop }}
        openFailed={false}
        onRetry={noop}
        onUndo={noop}
        onShowAllNotes={noop}
        onLoadMoreNotes={noop}
        onRetryNotes={noop}
        embedded
        {...overrides}
      />
    )
  );
}

describe("the Topic page in a panel (design record 6.1)", () => {
  it("puts the facts directly under the title, with the record's separators", () => {
    const html = render({ status: "ready", page: topicPage() });
    const title = html.indexOf("<h1");
    const meta = html.indexOf("23 notes");
    const description = html.indexOf("How retention falls");
    expect(title).toBeGreaterThan(-1);
    expect(meta).toBeGreaterThan(title);
    expect(description).toBeGreaterThan(meta);
    expect(html).toContain("Balanced size");
    expect(html).toContain(">·</span>");
  });

  it("keeps the topic's actions in one menu beside the title and draws no pin of its own", () => {
    const ops = {
      renaming: false,
      busy: false,
      error: null,
      onStartRename: noop,
      onCommitRename: noop,
      onCancelRename: noop,
      onCreate: noop,
      onMove: noop,
      onTogglePin: noop
    };
    const html = render({ status: "ready", page: topicPage() }, { ops });
    expect(html).toContain('aria-haspopup="menu"');
    expect(html).not.toContain('aria-pressed="false"');
    expect(html).not.toContain(">Pin<");
    // Outside a panel the actions stay a row of buttons, the pin among them.
    const library = render({ status: "ready", page: topicPage() }, { ops, embedded: false });
    expect(library).toContain(">Pin<");
  });

  it("says an area of the tree has no notes of its own and points at its subtopics", () => {
    const html = render({
      status: "ready",
      page: topicPage({ centralNotes: [], moreNotes: 0 })
    });
    expect(html).toContain("No notes of its own yet.");
  });

  it("lists the subtopics before the notes in the previous panel and marks the one that opened the top", () => {
    const page = topicPage();
    const opened = page.subtopics[0]!;
    const html = render(
      { status: "ready", page },
      { compact: true, current: `memora://topic/${opened.id}` }
    );
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    expect(html.indexOf("Decay models")).toBeGreaterThan(-1);
    expect(html.indexOf("Decay models")).toBeLessThan(html.indexOf("Retention falls fast"));
    const marked = html.slice(html.indexOf('aria-current="true"') - 200);
    expect(marked).toContain("before:bg-accent");
    expect(marked.indexOf("Decay models")).toBeLessThan(marked.indexOf("Retention falls fast"));
    // A note opened from the panel marks its own row, not a topic's.
    const note = render(
      { status: "ready", page },
      { compact: true, current: `memora://note/${page.centralNotes[0]!.id}` }
    );
    expect(note.match(/aria-current="true"/g)).toHaveLength(1);
    expect(topicFixtureId(10)).toBe(opened.id);
  });

  it("offers one way on from a topic that is gone: closing the panel", () => {
    const html = render({ status: "missing" });
    expect(html).toContain("This topic is no longer in the tree.");
    expect(html).toContain(">Close panel<");
  });
});
