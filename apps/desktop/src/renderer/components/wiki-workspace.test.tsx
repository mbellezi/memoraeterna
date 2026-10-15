import { describe, expect, it, vi, afterEach } from "vitest";
import { renderToString } from "react-dom/server";
import { createTranslator, messages, supportedLanguageCodes } from "@app/i18n";
import { ConsultationDialog } from "./ConsultationDialog";
import { WikiWorkspace, WikiWorkspaceView, type WikiWorkspaceViewProps } from "./WikiWorkspace";
import { createLibraryHistoryState, libraryHistoryEntryFromState } from "./LibraryView";

// The dialog is Ask's; here only whether and how the Wiki mounts it matters.
vi.mock("./ConsultationDialog", () => ({
  ConsultationDialog: vi.fn(() => <dialog data-testid="ask-dialog" />)
}));

afterEach(() => {
  vi.mocked(ConsultationDialog).mockClear();
});

const view = (
  language: (typeof supportedLanguageCodes)[number],
  overrides: Partial<WikiWorkspaceViewProps> = {}
) =>
  renderToString(
    <WikiWorkspaceView
      t={createTranslator(language)}
      active
      noticeToken={null}
      selectedTopicId={null}
      askOpen={false}
      onOpenTopic={() => undefined}
      onAsk={() => undefined}
      onCloseAsk={() => undefined}
      topicId={null}
      onNavigate={() => undefined}
      onCloseTopic={() => undefined}
      onOpenLibrary={() => undefined}
      onOpenSource={() => undefined}
      {...overrides}
    />
  );

describe("wiki workspace shell", () => {
  it("hosts the topic navigator beside the reading surface in every language", () => {
    for (const language of supportedLanguageCodes) {
      const html = view(language);
      const copy = messages[language].topics;
      expect(html, language).toContain(`aria-label="${messages[language].wiki.navigation}"`);
      expect(html, language).toContain(copy.navigator.title);
      expect(html, language).toContain(copy.navigator.topics);
      expect(html, language).toContain('aria-labelledby="wiki-placeholder-title"');
      expect(html, language).toContain(copy.placeholder.openLibrary);
      expect(html, language).not.toContain("[[missing:");
    }
  });

  it("keeps the Ask entry in the navigator and in the reading surface", () => {
    const html = view("en");
    expect(html.match(/aria-haspopup="dialog"/g)).toHaveLength(2);
    expect(html).not.toContain("<dialog");
    expect(ConsultationDialog).not.toHaveBeenCalled();
  });

  it("mounts nothing of the removed editor, creation controls or a modal", () => {
    const html = view("en");
    expect(html).not.toContain("<textarea");
    expect(html).not.toContain("<select");
    expect(html).not.toContain("<dialog");
  });

  it("opens Ask in place on the whole library, and Ask closes back to the Wiki", () => {
    const onCloseAsk = vi.fn();
    const onOpenSource = vi.fn();
    const html = view("en", { askOpen: true, onCloseAsk, onOpenSource });
    expect(html).toContain("<dialog");
    expect(ConsultationDialog).toHaveBeenCalledTimes(1);
    const props = vi.mocked(ConsultationDialog).mock.calls[0]![0];
    expect(props).toMatchObject({ active: true, initialQuestion: "" });
    props.onClose();
    expect(onCloseAsk).toHaveBeenCalledTimes(1);
    props.onOpenSource("source-id", "note-id");
    expect(onOpenSource).toHaveBeenCalledWith("source-id", "note-id");
  });

  it("keeps no modal open while the Wiki is hidden", () => {
    view("en", { askOpen: true, active: false });
    expect(vi.mocked(ConsultationDialog).mock.calls[0]![0]).toMatchObject({ active: false });
    vi.mocked(ConsultationDialog).mockClear();
    view("en", { askOpen: false, active: false });
    expect(ConsultationDialog).not.toHaveBeenCalled();
  });

  it("mounts Ask only after it was asked for", () => {
    const html = renderToString(
      <WikiWorkspace
        t={createTranslator("en")}
        active
        noticeToken={null}
        topicId={null}
        onNavigate={() => undefined}
        onCloseTopic={() => undefined}
        onOpenLibrary={() => undefined}
        onOpenSource={() => undefined}
      />
    );
    expect(html).not.toContain("<dialog");
    expect(ConsultationDialog).not.toHaveBeenCalled();
  });

  it("shows the removed-page notice only for a link that asked for a page", () => {
    const notice = messages.en.topics.placeholder.notice;
    expect(view("en", { noticeToken: null })).not.toContain(notice);
    expect(view("en", { noticeToken: 1 })).toContain(notice);
  });

  it("hosts the Topic page, with its close control, instead of the empty state when a topic is open", () => {
    const html = view("en", { topicId: "00000000-0000-4000-8000-000000000001" });
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('aria-label="Close topic"');
    expect(html).not.toContain("wiki-placeholder-title");
  });

  it("lets a hidden Wiki use up the notice of an old link", () => {
    const html = renderToString(
      <WikiWorkspace
        t={createTranslator("en")}
        active={false}
        noticeToken={1}
        topicId={null}
        onNavigate={() => undefined}
        onCloseTopic={() => undefined}
        onOpenLibrary={() => undefined}
        onOpenSource={() => undefined}
      />
    );
    expect(html).not.toContain(messages.en.topics.placeholder.notice);
  });

  it("preserves the wiki origin in native source-history navigation", () => {
    expect(libraryHistoryEntryFromState(createLibraryHistoryState({ view: "wiki" }))).toEqual({
      view: "wiki"
    });
  });
});
