import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createTranslator, supportedLanguageCodes } from "@app/i18n";

import { openCitedSource, TopicAskSlot, TopicAskView } from "./TopicAskSlot";
import { topicFixtureId } from "./topic-page-fixtures";

const noop = () => undefined;
const actions = { openTopic: noop, openNote: noop, openSource: noop };
const topic = { id: topicFixtureId(3), title: "Forgetting curve" };
/** Server rendering separates adjacent text nodes with comments; the person sees none. */
const plain = (html: string) => html.replaceAll("<!-- -->", "");
const view = (open: boolean, locale = "en") =>
  plain(
    renderToString(
      <TopicAskView
        t={createTranslator(locale)}
        topic={topic}
        active
        actions={actions}
        open={open}
        onOpen={noop}
        onClose={noop}
      />
    )
  );

describe("Ask about this topic", () => {
  it("offers one button that opens a dialog, and loads and holds nothing before it is used", () => {
    const html = view(false);
    expect(html).toContain(">Ask</h2>");
    expect(html).toContain("Get a cited answer from the notes in this topic and its subtopics.");
    expect(html).toMatch(
      /<button[^>]*aria-haspopup="dialog"[^>]*>.*Ask about this topic<\/button>/
    );
    expect(html).not.toContain("<dialog");
    // The slot starts closed.
    const withoutIds = (markup: string) => markup.replace(/_R_\w*_/g, "id");
    expect(
      withoutIds(
        plain(
          renderToString(
            <TopicAskSlot t={createTranslator("en")} topic={topic} active actions={actions} />
          )
        )
      )
    ).toBe(withoutIds(html));
  });

  it("opens the library's Ask limited to the topic, with a name for the dialog", () => {
    const html = view(true);
    expect(html).toContain("<dialog");
    expect(html).toContain('aria-labelledby="consultation-heading"');
    expect(html).toContain("Cited answers");
  });

  it("speaks every language, with no missing message and no raw key", () => {
    for (const locale of supportedLanguageCodes) {
      const html = view(false, locale);
      expect(html, locale).not.toContain("[[missing:");
      expect(html, locale).not.toContain("topics.page.ask");
    }
    expect(view(false, "pt-BR")).toContain("Perguntar sobre este tópico");
  });

  it("opens a cited source, or the note when the citation names one", () => {
    const openNote = vi.fn();
    const openSource = vi.fn();
    const open = openCitedSource({ openNote, openSource });
    open(topicFixtureId(10));
    expect(openSource).toHaveBeenCalledWith(topicFixtureId(10));
    expect(openNote).not.toHaveBeenCalled();
    open(topicFixtureId(10), topicFixtureId(11));
    expect(openNote).toHaveBeenCalledWith(topicFixtureId(11));
    expect(openSource).toHaveBeenCalledTimes(1);
  });
});
