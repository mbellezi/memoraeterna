import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator, supportedLanguageCodes } from "@app/i18n";

import type { HeaderOps } from "./TopicHeader";
import { TopicPageView, type TopicPageViewProps } from "./TopicPageView";
import type { TopicPageSnapshot } from "./topic-page-controller";
import { bannerOrigin, changeBannerText } from "./topic-page-model";
import { topicFixtureAt, topicPage } from "./topic-page-fixtures";

const en = createTranslator("en");
const noop = () => undefined;
const plain = (html: string) => html.replaceAll("<!-- -->", "");

const headerOps = (overrides: Partial<HeaderOps> = {}): HeaderOps => ({
  renaming: false,
  busy: false,
  error: null,
  onStartRename: noop,
  onCommitRename: noop,
  onCancelRename: noop,
  onCreate: noop,
  onMove: noop,
  onTogglePin: noop,
  ...overrides
});

function render(
  page = topicPage(),
  ops?: HeaderOps,
  props: Partial<TopicPageViewProps> = {},
  t = en
): string {
  const snapshot: TopicPageSnapshot = {
    load: { status: "ready", page },
    undo: { status: "idle" },
    notes: null,
    announcement: "",
    readAt: new Date(topicFixtureAt).getTime()
  };
  return plain(
    renderToString(
      <TopicPageView
        t={t}
        snapshot={snapshot}
        active
        actions={{ openTopic: noop, openNote: noop, openSource: noop }}
        openFailed={false}
        onRetry={noop}
        onUndo={noop}
        onShowAllNotes={noop}
        onLoadMoreNotes={noop}
        onRetryNotes={noop}
        ops={ops}
        {...props}
      />
    )
  );
}

describe("the Topic page header with the human operations", () => {
  it("offers nothing to change without them", () => {
    const html = render();
    expect(html).not.toContain("New subtopic");
    expect(html).not.toContain("Move to...");
  });

  it("offers rename, a subtopic, a move and a pin as plain buttons in a labelled group", () => {
    const html = render(undefined, headerOps());
    expect(html).toContain('role="group"');
    expect(html).toContain('aria-label="Topic actions"');
    for (const label of ["Rename", "New subtopic", "Move to...", "Pin"]) {
      expect(html, label).toMatch(
        new RegExp(`<button[^>]*>[^]*?${label.replace(".", "\\.")}</button>`)
      );
    }
    // Pin is a toggle: its state is announced, not only drawn.
    expect(html).toContain('aria-pressed="false"');
  });

  it("offers Unpin for a pinned topic", () => {
    const page = topicPage();
    const html = render({ ...page, topic: { ...page.topic, management: "pinned" } }, headerOps());
    expect(html).toContain("Unpin");
    expect(html).toContain('aria-pressed="true"');
  });

  it("renames the heading in place with a field that holds the name", () => {
    const html = render(undefined, headerOps({ renaming: true }));
    expect(html).toMatch(
      /<h1[^>]*><input[^>]*aria-label="Topic name"[^>]*value="Forgetting curve"/
    );
    expect(html).toMatch(/<h1[^>]*lang="en"/);
    // The rename is on: it cannot be started twice.
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[^]*?Rename<\/button>/);
  });

  it("starts an unnamed topic's field empty, and says why an operation was refused", () => {
    const page = topicPage();
    const html = render(
      { ...page, topic: { ...page.topic, title: null, nameState: "unnamed" } },
      headerOps({ renaming: true, error: "topics.errors.duplicateTitle" })
    );
    expect(html).toMatch(/<input[^>]*value=""/);
    expect(html).toContain('role="alert"');
    expect(html).toContain("A topic with this name already exists here.");
  });

  it("offers only a new top-level topic on the root page", () => {
    const page = topicPage();
    const root = {
      ...page,
      topic: { ...page.topic, parentId: null, title: null },
      path: [{ id: page.topic.id, title: null }]
    };
    const html = render(root, headerOps());
    expect(html).toContain("New top-level topic");
    expect(html).not.toContain("Move to...");
    expect(html).not.toContain(">Rename<");
  });

  it("disables the actions while one is under way", () => {
    const html = render(undefined, headerOps({ busy: true }));
    expect(html.match(/<button[^>]*disabled=""/g)!.length).toBeGreaterThanOrEqual(4);
  });

  it("is written in every language", () => {
    for (const locale of supportedLanguageCodes) {
      const html = render(
        undefined,
        headerOps({ error: "topics.errors.invalid" }),
        {},
        createTranslator(locale)
      );
      expect(html, locale).not.toContain("[[missing");
    }
  });
});

describe("the banner after a change by the person", () => {
  it("reads every human title as the person's own change", () => {
    for (const key of [
      "humanRename",
      "humanMove",
      "humanCreate",
      "humanPin",
      "humanUnpin",
      "humanPlace"
    ]) {
      expect(bannerOrigin(`topics.changeSets.${key}`), key).toBe("human");
    }
    const text = changeBannerText(
      {
        changeSetId: "00000000-0000-4000-8000-000000000900",
        titleKey: "topics.changeSets.humanMove",
        titleParams: {},
        at: topicFixtureAt,
        undo: "available"
      },
      new Date(topicFixtureAt),
      en
    );
    expect(text).toMatch(/^Changed by you\./);
  });
});
