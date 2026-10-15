import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator, messages, supportedLanguageCodes, type Translator } from "@app/i18n";

import type { NotesListState, TopicPageLoad, TopicPageSnapshot } from "./topic-page-controller";
import { TopicOverviewSlot } from "./TopicOverviewSlot";
import { TopicAskSlot } from "./TopicAskSlot";
import { TopicPageView, type TopicPageViewProps } from "./TopicPageView";
import { noteLeaf, topicFixtureId, topicPage } from "./topic-page-fixtures";

const en = createTranslator("en");
const noop = () => undefined;
const plain = (html: string) => html.replaceAll("<!-- -->", "");
// What the server renderer does to text: the copy of a language with apostrophes is escaped.
const escaped = (copy: string) =>
  copy.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll("'", "&#x27;");
// Visible text only: attribute values (IDs used by aria and React) are not shown to the person.
const text = (html: string) => html.replace(/<[^>]*>/g, " ");
const readAt = new Date(2026, 9, 15, 18, 0, 0).getTime();

function snapshot(
  load: TopicPageLoad,
  overrides: Partial<TopicPageSnapshot> = {}
): TopicPageSnapshot {
  return {
    load,
    undo: { status: "idle" },
    notes: null,
    announcement: "",
    readAt,
    ...overrides
  };
}

function render(
  load: TopicPageLoad,
  overrides: Partial<TopicPageViewProps> = {},
  state: Partial<TopicPageSnapshot> = {},
  t: Translator = en
): string {
  return plain(
    renderToString(
      <TopicPageView
        t={t}
        snapshot={snapshot(load, state)}
        active
        actions={{ openTopic: noop, openNote: noop, openSource: noop }}
        openFailed={false}
        onRetry={noop}
        onUndo={noop}
        onShowAllNotes={noop}
        onLoadMoreNotes={noop}
        onRetryNotes={noop}
        {...overrides}
      />
    )
  );
}
const ready = (page = topicPage()): TopicPageLoad => ({ status: "ready", page });

describe("Topic page states", () => {
  it("shows a busy skeleton, a retryable failure and a missing topic", () => {
    const loading = render({ status: "loading" });
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain(">Loading...<");
    const error = render({ status: "error" });
    expect(error).toContain('role="alert"');
    expect(error).toContain("This topic could not be loaded.");
    expect(error).toContain(">Retry<");
    expect(render({ status: "missing" })).toContain("This topic no longer exists.");
  });

  it("names the kind of page and offers Close only when the host can close it", () => {
    expect(render(ready())).toContain(">Topic<");
    expect(render(ready())).not.toContain("Close topic");
    const closable = render(ready(), { onClose: noop });
    expect(closable).toContain('aria-label="Close topic"');
  });

  it("reports an entry that could not be opened", () => {
    expect(render(ready(), { openFailed: true })).toContain("That item could not be opened.");
  });

  it("announces the result of the last action politely", () => {
    const html = render(ready(), {}, { announcement: "Change undone." });
    expect(html).toMatch(/role="status" aria-live="polite">Change undone\.</);
  });
});

describe("Topic page structure", () => {
  it("renders one article with one heading, named sections and a named side column", () => {
    const html = render(ready());
    expect(html).toContain('aria-label="Topic: Forgetting curve"');
    expect(html.match(/<h1/g)).toHaveLength(1);
    expect(html).toMatch(/<h1[^>]*lang="en"[^>]*>Forgetting curve</);
    expect(html).toContain('<nav aria-label="Path"');
    expect(html).toContain('aria-label="Related to this topic"');
    expect(html.match(/<article/g)).toHaveLength(1);
    expect(html.match(/<aside/g)).toHaveLength(1);
    const order = [
      "<h1",
      "Map of content",
      "Subtopics",
      "Central notes",
      "Contributing sources"
    ].map((part) => html.indexOf(part));
    expect(order.every((position) => position >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(html.indexOf("Related topics")).toBeGreaterThan(html.indexOf("Contributing sources"));
  });

  it("drops the side column under the article when the container is narrow", () => {
    const html = render(ready());
    expect(html).toContain("@container");
    expect(html).toContain("@4xl:grid-cols-");
  });

  it("shows the path from the root with the page as the current entry", () => {
    const html = render(ready());
    expect(html).toMatch(/<button[^>]*>All topics<\/button>/);
    expect(html).toMatch(/<button[^>]*>Memory and learning<\/button>/);
    expect(html).toMatch(/<span aria-current="page"[^>]*>Forgetting curve<\/span>/);
  });
});

describe("Topic page header", () => {
  it("shows the description, the counts, the health and the other names", () => {
    const html = render(ready());
    expect(html).toContain("How retention falls with time since study");
    expect(text(html)).toContain("23 notes");
    expect(text(html)).toContain("4 sources");
    expect(text(html)).toContain("2 subtopics");
    expect(html).toContain("Good health");
    expect(html).toContain("Also called: Ebbinghaus curve, memory decay");
  });

  it("marks a topic that needs attention with a word as well as a colour", () => {
    const page = topicPage();
    const html = render(ready({ ...page, topic: { ...page.topic, health: "attention" } }));
    expect(html).toContain("Needs attention");
    expect(html).toContain("text-warning");
    const violation = render(ready({ ...page, topic: { ...page.topic, health: "violation" } }));
    expect(violation).toContain("Structure problem");
  });

  it("localizes an unnamed topic and says when a name is provisional", () => {
    const page = topicPage();
    const unnamed = render(
      ready({ ...page, topic: { ...page.topic, title: null, nameState: "unnamed" } })
    );
    expect(unnamed).toMatch(/<h1[^>]*>Unnamed topic</);
    expect(unnamed).not.toMatch(/<h1[^>]*lang=/);
    const provisional = render(
      ready({ ...page, topic: { ...page.topic, nameState: "provisional" } })
    );
    expect(provisional).toContain("Provisional name.");
    expect(render(ready())).not.toContain("Provisional name.");
  });

  it("shows the root as all topics and omits what a root does not have", () => {
    const page = topicPage();
    const root = render(
      ready({
        ...page,
        topic: { ...page.topic, parentId: null, title: null, description: null, aliases: [] },
        path: [page.path[0]!],
        counts: { notes: 3, sources: 0, subtopics: 0 },
        lastChange: null
      })
    );
    expect(root).toMatch(/<h1[^>]*>All topics</);
    // The only path entry is the page itself: a breadcrumb that repeats the heading is left out.
    expect(root).not.toContain("<nav");
    expect(root).not.toContain("Also called");
    expect(root).not.toContain("Organized automatically");
  });

  it("explains a redirect from a topic that was merged", () => {
    const html = render(ready({ ...topicPage(), redirectedFrom: topicFixtureId(77) }));
    expect(html).toContain("The topic you opened was merged into this one.");
    expect(render(ready())).not.toContain("was merged into this one");
  });
});

describe("Topic page change banner", () => {
  it("says what was organized automatically and offers Undo", () => {
    const html = render(ready());
    expect(text(html)).toMatch(/Organized automatically\. Today, .+: 2 items were placed\./);
    expect(html).toMatch(/<button[^>]*>.*Undo<\/button>/);
  });

  it("disables Undo while it is asked", () => {
    const html = render(ready(), {}, { undo: { status: "pending" } });
    expect(html).toMatch(/<button[^>]*disabled[^>]*>.*Undoing\.\.\.<\/button>/);
  });

  it("offers no Undo when the change cannot be undone, and says why when a later change blocks it", () => {
    const page = topicPage();
    const blocked = render(
      ready({ ...page, lastChange: { ...page.lastChange!, undo: "blocked" } })
    );
    expect(blocked).not.toMatch(/>Undo</);
    expect(blocked).toContain("a later change depends on it");
    const unavailable = render(
      ready({ ...page, lastChange: { ...page.lastChange!, undo: "unavailable" } })
    );
    expect(unavailable).toContain("Organized automatically");
    expect(unavailable).not.toMatch(/>Undo</);
    expect(unavailable).not.toContain("a later change depends on it");
  });

  it("shows a failed Undo as an alert and keeps the button", () => {
    const html = render(ready(), {}, { undo: { status: "failed" } });
    expect(html).toContain('role="alert"');
    expect(html).toContain("The change could not be undone. Try again.");
    expect(html).toMatch(/>Undo</);
  });

  it("shows no banner for a topic nothing touched", () => {
    expect(render(ready(topicPage({ lastChange: null })))).not.toContain("Organized automatically");
  });
});

describe("Topic page map of content", () => {
  it("shows subtopics with their counts and descriptions, localizing the unnamed ones", () => {
    const html = render(ready());
    expect(html).toContain("Decay models");
    expect(text(html)).toContain("11 items");
    expect(html).toContain("Exponential, power or a sum of exponentials");
    expect(html).toContain("Unnamed topic");
    expect(text(html)).toContain("9 items");
  });

  it("says how many subtopics the map leaves out", () => {
    const page = topicPage();
    const html = render(ready({ ...page, counts: { ...page.counts, subtopics: 20 } }));
    expect(html).toContain("18 more subtopics are in the topic tree.");
    expect(render(ready())).not.toContain("more subtopics are in the topic tree");
  });

  it("omits the subtopics of a topic that has none", () => {
    const html = render(
      ready(topicPage({ subtopics: [], counts: { notes: 23, sources: 4, subtopics: 0 } }))
    );
    expect(html).not.toContain(">Subtopics<");
  });

  it("lists the central notes in order with source, relations and who wrote them", () => {
    const html = render(ready());
    expect(text(html)).toContain("by centrality in the topic");
    const first = html.indexOf("Retention drops quickly");
    const second = html.indexOf("Ebbinghaus measured memory");
    const third = html.indexOf("Each spaced review");
    expect(first).toBeGreaterThan(0);
    expect(second).toBeGreaterThan(first);
    expect(third).toBeGreaterThan(second);
    expect(text(html)).toContain("6 relations");
    expect(text(html)).toContain("1 relation");
    expect(html).toContain("No relations");
    expect(html).toContain("Written by you");
    expect(html).toContain(">AI<");
    expect(html).toContain("Your note");
    expect(html).toContain('<span class="sr-only">Note: </span>');
  });

  it("falls back to the title when a note has no idea statement", () => {
    const page = topicPage();
    const html = render(
      ready({
        ...page,
        centralNotes: [{ ...page.centralNotes[0]!, idea: "", title: "Only a title" }]
      })
    );
    expect(html).toContain("Only a title");
  });

  it("says where a note was moved here from", () => {
    const page = topicPage();
    const html = render(
      ready({
        ...page,
        centralNotes: [
          {
            ...page.centralNotes[0]!,
            movedFrom: { id: topicFixtureId(40), title: null, at: "2026-10-14T10:00:00.000Z" }
          }
        ]
      })
    );
    expect(html).toContain("Moved here from Unnamed topic");
  });

  it("offers the whole list when the map shows only some of the notes", () => {
    const html = render(ready());
    expect(html).toContain("See all 23 notes");
    const complete = render(
      ready(topicPage({ counts: { notes: 3, sources: 4, subtopics: 2 }, moreNotes: 0 }))
    );
    expect(complete).not.toContain("See all");
  });

  it("shows the list being loaded, a page of it with More, and a failure with Retry", () => {
    const loading = render(ready(), {}, { notes: { status: "loading" } });
    expect(loading).toContain("All notes in this topic");
    expect(loading).toContain('aria-busy="true"');
    expect(loading).not.toContain("See all");
    const list: NotesListState = {
      status: "ready",
      notes: [
        noteLeaf(),
        noteLeaf({
          id: topicFixtureId(301),
          title: "Second",
          provenance: "human",
          sourceTitle: null
        })
      ],
      nextCursor: "c",
      more: "idle"
    };
    const listed = render(ready(), {}, { notes: list });
    expect(listed).toContain("Spaced review flattens the curve");
    expect(listed).toContain("Second");
    expect(listed).toContain("Show more notes");
    expect(
      render(ready(), {}, { notes: { ...list, nextCursor: null } as NotesListState })
    ).not.toContain("Show more notes");
    expect(render(ready(), {}, { notes: { ...list, more: "loading" } as NotesListState })).toMatch(
      /<button[^>]*disabled[^>]*>Show more notes/
    );
    const failed = render(ready(), {}, { notes: { status: "error" } });
    expect(failed).toContain("The notes could not be loaded.");
    expect(failed).toContain(">Retry<");
    const pageFailed = render(ready(), {}, { notes: { ...list, more: "error" } as NotesListState });
    expect(pageFailed).toContain("The notes could not be loaded.");
    expect(pageFailed).not.toContain("Show more notes");
  });

  it("lists the contributing sources with their note counts", () => {
    const html = render(ready());
    expect(html).toContain("Encyclopedia, English");
    expect(text(html)).toContain("8 notes");
    expect(text(html)).toContain("1 note");
  });

  it("says that an empty topic is empty", () => {
    const html = render(
      ready(
        topicPage({
          subtopics: [],
          centralNotes: [],
          sources: [],
          moreNotes: 0,
          counts: { notes: 0, sources: 0, subtopics: 0 },
          topic: { ...topicPage().topic, children: 0 }
        })
      )
    );
    expect(html).toContain("No notes or sources have been placed in this topic yet.");
    expect(html).not.toContain("Central notes");
  });

  it("states that the map needs no AI", () => {
    expect(render(ready())).toContain("built from the topic tree, without AI");
  });
});

describe("Topic page side column", () => {
  it("lists neighbouring topics with their relation counts and the stances of the notes", () => {
    const html = render(ready());
    expect(html).toContain("Related topics");
    expect(html).toContain("Spaced repetition");
    expect(text(html)).toContain("8 relations");
    expect(html).toContain("Relations of this topic&#x27;s notes");
    expect(html).toContain("supports");
    expect(html).toContain("contrasts");
    expect(html).toContain("depends on");
    expect(text(html)).toMatch(/supports\s*9/);
  });

  it("leaves out the sections that have nothing to show", () => {
    const html = render(
      ready(
        topicPage({
          relatedTopics: [],
          relationStances: {
            supports: 0,
            contrasts: 0,
            extends: 0,
            similar_to: 0,
            depends_on: 0,
            clarifies: 0,
            mentions: 0,
            related: 0
          }
        })
      )
    );
    expect(html).not.toContain("Related topics");
    expect(html).not.toContain("Relations of this topic");
  });
});

describe("Topic page slots", () => {
  it("leaves the overview and Ask slots empty for the tasks that fill them", () => {
    const actions = { openTopic: noop, openNote: noop, openSource: noop };
    const topic = { id: topicFixtureId(3), title: "Forgetting curve" };
    expect(
      renderToString(
        <TopicOverviewSlot
          t={en}
          topic={topic}
          overview={{ status: "absent", canWrite: false }}
          active
          actions={actions}
        />
      )
    ).toBe("");
    expect(renderToString(<TopicAskSlot t={en} topic={topic} active actions={actions} />)).toBe("");
  });
});

describe("Topic page copy", () => {
  it("renders in every language with no missing message, no ID and no raw key", () => {
    for (const language of supportedLanguageCodes) {
      const t = createTranslator(language);
      const html = render(ready(), { onClose: noop }, { notes: { status: "loading" } }, t);
      expect(html, language).not.toContain("[[missing:");
      expect(html, language).not.toContain("topics.page.");
      expect(html, language).not.toContain("topics.changeSets");
      expect(text(html), language).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
      expect(html, language).not.toContain("memora://");
      expect(html, language).toContain(escaped(messages[language].topics.page.map.title));
      expect(html, language).toContain(escaped(messages[language].topics.page.close));
      expect(html, language).toContain(escaped(messages[language].topics.page.map.hint));
    }
  });

  it("renders its other states in every language", () => {
    for (const language of supportedLanguageCodes) {
      const t = createTranslator(language);
      const copy = messages[language].topics.page;
      expect(render({ status: "error" }, {}, {}, t), language).toContain(escaped(copy.error));
      expect(render({ status: "missing" }, {}, {}, t), language).toContain(escaped(copy.missing));
      expect(
        render(
          ready(topicPage({ lastChange: null, redirectedFrom: topicFixtureId(7) })),
          {},
          {},
          t
        ),
        language
      ).toContain(escaped(copy.redirected));
    }
  });
});
