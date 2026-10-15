import { describe, expect, it } from "vitest";
import { renderToString } from "react-dom/server";
import { createTranslator, messages, supportedLanguageCodes } from "@app/i18n";
import { WikiWorkspace } from "./WikiWorkspace";
import { createLibraryHistoryState, libraryHistoryEntryFromState } from "./LibraryView";

const workspace = (
  language: (typeof supportedLanguageCodes)[number],
  overrides: { active?: boolean; noticeToken?: number | null } = {}
) =>
  renderToString(
    <WikiWorkspace
      t={createTranslator(language)}
      active={overrides.active ?? true}
      noticeToken={overrides.noticeToken ?? null}
      onOpenLibrary={() => undefined}
      onOpenSource={() => undefined}
    />
  );

describe("wiki workspace shell", () => {
  it("hosts the empty state with the Library and Ask entries in every language", () => {
    for (const language of supportedLanguageCodes) {
      const html = workspace(language);
      const copy = messages[language].topics.placeholder;
      expect(html, language).toContain('aria-labelledby="wiki-placeholder-title"');
      expect(html, language).toContain(copy.title);
      expect(html, language).toContain(copy.openLibrary);
      expect(html, language).toContain(copy.ask);
      expect(html, language).not.toContain("[[missing:");
    }
  });

  it("mounts nothing of the removed editor, tree or creation controls", () => {
    const html = workspace("en");
    expect(html).not.toContain('role="tree"');
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("<select");
    expect(html).not.toContain("<dialog");
  });

  it("shows the removed-page notice only for a link that asked for a page", () => {
    const notice = messages.en.topics.placeholder.notice;
    expect(workspace("en", { noticeToken: null })).not.toContain(notice);
    expect(workspace("en", { noticeToken: 1 })).toContain(notice);
  });

  it("lets a hidden Wiki use up the notice of an old link", () => {
    expect(workspace("en", { active: false, noticeToken: 1 })).not.toContain(
      messages.en.topics.placeholder.notice
    );
  });

  it("preserves the wiki origin in native source-history navigation", () => {
    expect(libraryHistoryEntryFromState(createLibraryHistoryState({ view: "wiki" }))).toEqual({
      view: "wiki"
    });
  });
});
