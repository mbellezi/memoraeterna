import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createTranslator, supportedLanguageCodes } from "@app/i18n";

import { parseViewAddress } from "../../workspace/route";
import { ObjectLinkProvider } from "../../workspace/ObjectLink";
import { askAboutTopicAddress, TopicAskSlot, TopicAskView } from "./TopicAskSlot";
import { topicFixtureId } from "./topic-page-fixtures";

const topic = { id: topicFixtureId(3), title: "Forgetting curve" };
/** Server rendering separates adjacent text nodes with comments; the person sees none. */
const plain = (html: string) => html.replaceAll("<!-- -->", "");
const view = (onOpen: (() => void) | undefined, locale = "en") =>
  plain(
    renderToString(<TopicAskView t={createTranslator(locale)} topic={topic} onOpen={onOpen} />)
  );

describe("Ask about this topic", () => {
  it("offers one button that opens the Ask panel, and imports no dialog", () => {
    const html = view(() => undefined);
    expect(html).toContain(">Ask</h2>");
    expect(html).toContain("Get a cited answer from the notes in this topic and its subtopics.");
    expect(html).toMatch(/<button[^>]*>.*Ask about this topic<\/button>/);
    // It opens a panel beside the page, not a dialog over it.
    expect(html).not.toContain("aria-haspopup");
    expect(html).not.toContain("<dialog");
  });

  it("is not drawn where nothing can open a panel, rather than drawn dead", () => {
    expect(view(undefined)).toBe("");
    const outside = plain(
      renderToString(<TopicAskSlot t={createTranslator("en")} topic={topic} />)
    );
    expect(outside).toBe("");
  });

  it("is drawn inside a panel, where the page's links open beside it", () => {
    const html = plain(
      renderToString(
        <ObjectLinkProvider t={createTranslator("en")} onOpen={vi.fn()}>
          <TopicAskSlot t={createTranslator("en")} topic={topic} />
        </ObjectLinkProvider>
      )
    );
    expect(html).toContain("Ask about this topic");
  });

  it("asks about the topic and its subtopics: the Ask panel with the topic as its scope", () => {
    const address = askAboutTopicAddress(topic.id);
    expect(address).toBe(`memora://ask?scope=${encodeURIComponent(`memora://topic/${topic.id}`)}`);
    expect(parseViewAddress(address)).toEqual({
      view: "ask",
      scope: { kind: "topic", id: topic.id }
    });
  });

  it("speaks every language, with no missing message and no raw key", () => {
    for (const locale of supportedLanguageCodes) {
      const html = view(() => undefined, locale);
      expect(html, locale).not.toContain("[[missing:");
      expect(html, locale).not.toContain("topics.page.ask");
    }
    expect(view(() => undefined, "pt-BR")).toContain("Perguntar sobre este tópico");
  });
});
