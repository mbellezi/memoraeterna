import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator, messages, supportedLanguageCodes } from "@app/i18n";
import {
  WikiPlaceholder,
  WikiPlaceholderView,
  type WikiPlaceholderViewProps
} from "./WikiPlaceholder";

const t = createTranslator("en");
const view = (overrides: Partial<WikiPlaceholderViewProps> = {}) =>
  renderToString(
    <WikiPlaceholderView
      t={t}
      notice={false}
      onAsk={() => undefined}
      onDismissNotice={() => undefined}
      onOpenLibrary={() => undefined}
      {...overrides}
    />
  );

describe("the reading surface without an open topic", () => {
  it("says where to start and offers the Library and Ask, in every language", () => {
    for (const language of supportedLanguageCodes) {
      const text = messages[language].topics.placeholder;
      const html = view({ t: createTranslator(language) });
      expect(html, language).toContain(`<h2 id="wiki-placeholder-title"`);
      for (const copy of [text.title, text.openLibrary, text.ask])
        expect(html, language).toContain(copy);
      expect(html, language).not.toContain("[[missing");
    }
    // Every language has all of the copy, and nothing is left to translate.
    const keys = Object.keys(messages.en.topics.placeholder).sort();
    for (const language of supportedLanguageCodes) {
      expect(Object.keys(messages[language].topics.placeholder).sort(), language).toEqual(keys);
      for (const value of Object.values(messages[language].topics.placeholder))
        expect(value.trim(), language).not.toBe("");
    }
  });

  it("is a heading, one message and two actions, with no list, tree or editor", () => {
    const html = view();
    expect(html.match(/<h2/g)).toHaveLength(1);
    expect(html.match(/<button/g)).toHaveLength(2);
    expect(html).toContain(t("topics.placeholder.body"));
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain('role="tree"');
    expect(html).not.toContain("<textarea");
  });

  it("asks for a dialog with its Ask button and mounts none itself", () => {
    const html = view();
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).not.toContain("<dialog");
  });
});

describe("the notice for a link to the removed wiki", () => {
  const placeholder = (noticeToken: number | null, active = true) =>
    renderToString(
      <WikiPlaceholder
        t={t}
        active={active}
        noticeToken={noticeToken}
        onOpenLibrary={() => undefined}
        onAsk={() => undefined}
      />
    );

  it("shows only when a link asked for a wiki page, with a named dismiss control", () => {
    expect(placeholder(null)).not.toContain('role="status"');
    const html = placeholder(1);
    expect(html).toContain('role="status"');
    expect(html).toContain(t("topics.placeholder.notice"));
    expect(html).toContain(`aria-label="${t("topics.placeholder.dismiss")}"`);
    expect(view({ notice: true })).toContain(t("topics.placeholder.notice"));
    expect(view({ notice: false })).not.toContain(t("topics.placeholder.notice"));
  });

  it("says a topic is gone, in every language, when a link led to one the tree does not have", () => {
    expect(view({ notice: true, noticeKind: "topicNotFound" })).toContain(
      t("topics.placeholder.topicNotFound")
    );
    expect(view({ notice: true, noticeKind: "topicNotFound" })).not.toContain(
      t("topics.placeholder.notice")
    );
    // Without a kind it is still the notice about the removed wiki.
    expect(view({ notice: true, noticeKind: undefined })).toContain(t("topics.placeholder.notice"));
    for (const language of supportedLanguageCodes) {
      const copy = messages[language].topics.placeholder.topicNotFound;
      const html = view({
        t: createTranslator(language),
        notice: true,
        noticeKind: "topicNotFound"
      });
      expect(copy.trim(), language).not.toBe("");
      expect(html.replaceAll("&#x27;", "'"), language).toContain(copy);
      if (language !== "en")
        expect(copy, language).not.toBe(messages.en.topics.placeholder.topicNotFound);
    }
    const html = renderToString(
      <WikiPlaceholder
        t={t}
        active
        noticeToken={2}
        noticeKind="topicNotFound"
        onOpenLibrary={() => undefined}
        onAsk={() => undefined}
      />
    );
    expect(html).toContain('role="status"');
    expect(html).toContain(t("topics.placeholder.topicNotFound"));
  });

  it("belongs to one visit: a Wiki that is hidden has used it up", () => {
    expect(placeholder(1, false)).not.toContain(t("topics.placeholder.notice"));
    expect(placeholder(1, false)).not.toContain('role="status"');
  });
});
