import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTranslator, messages, supportedLanguageCodes } from "@app/i18n";
import { ConsultationDialog } from "../ConsultationDialog";
import {
  WikiPlaceholder,
  WikiPlaceholderView,
  type WikiPlaceholderViewProps
} from "./WikiPlaceholder";

// The dialog is T10's; here only whether and how the placeholder mounts it matters.
vi.mock("../ConsultationDialog", () => ({
  ConsultationDialog: vi.fn(() => <dialog data-testid="ask-dialog" />)
}));

const t = createTranslator("en");
const view = (overrides: Partial<WikiPlaceholderViewProps> = {}) =>
  renderToString(
    <WikiPlaceholderView
      t={t}
      active
      askOpen={false}
      notice={false}
      onAsk={() => undefined}
      onCloseAsk={() => undefined}
      onDismissNotice={() => undefined}
      onOpenLibrary={() => undefined}
      onOpenSource={() => undefined}
      {...overrides}
    />
  );

afterEach(() => {
  vi.mocked(ConsultationDialog).mockClear();
});

describe("the Wiki empty state", () => {
  it("says the old wiki is gone and offers the Library and Ask, in every language", () => {
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

  it("mounts nothing of Ask, so nothing loads, until Ask is opened", () => {
    const html = renderToString(
      <WikiPlaceholder
        t={t}
        active
        noticeToken={null}
        onOpenLibrary={() => undefined}
        onOpenSource={() => undefined}
      />
    );
    expect(ConsultationDialog).not.toHaveBeenCalled();
    expect(html).not.toContain("<dialog");
    expect(view()).not.toContain("<dialog");
    expect(ConsultationDialog).not.toHaveBeenCalled();
  });

  it("opens Ask in place on the whole library, and Ask closes back to the empty state", () => {
    const onCloseAsk = vi.fn();
    const onOpenSource = vi.fn();
    const html = view({ askOpen: true, onCloseAsk, onOpenSource });
    expect(html).toContain("<dialog");
    expect(ConsultationDialog).toHaveBeenCalledTimes(1);
    const props = vi.mocked(ConsultationDialog).mock.calls[0]![0];
    expect(props).toMatchObject({ active: true, initialQuestion: "" });
    props.onClose();
    expect(onCloseAsk).toHaveBeenCalledTimes(1);
    props.onOpenSource("source-id", "note-id");
    expect(onOpenSource).toHaveBeenCalledWith("source-id", "note-id");
  });

  it("keeps no modal open while the Wiki is hidden, and keeps Ask's state", () => {
    view({ askOpen: true, active: false });
    expect(vi.mocked(ConsultationDialog).mock.calls[0]![0]).toMatchObject({ active: false });
    // Hidden with Ask closed mounts nothing either.
    vi.mocked(ConsultationDialog).mockClear();
    view({ askOpen: false, active: false });
    expect(ConsultationDialog).not.toHaveBeenCalled();
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
        onOpenSource={() => undefined}
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

  it("belongs to one visit: a Wiki that is hidden has used it up", () => {
    expect(placeholder(1, false)).not.toContain(t("topics.placeholder.notice"));
    expect(placeholder(1, false)).not.toContain('role="status"');
  });
});
