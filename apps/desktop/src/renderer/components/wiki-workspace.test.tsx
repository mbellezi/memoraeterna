import { describe, expect, it, vi, afterEach } from "vitest";
import { renderToString } from "react-dom/server";
import { createTranslator, messages, supportedLanguageCodes } from "@app/i18n";
import { ConsultationDialog } from "./ConsultationDialog";
import { TopicPage } from "./topic-page/TopicPage";
import { ShapeScreen } from "./topic-shape/ShapeScreen";
import { TopicNavigator } from "./topics/TopicNavigator";
import { WikiWorkspace, WikiWorkspaceView, type WikiWorkspaceViewProps } from "./WikiWorkspace";
import { createLibraryHistoryState, libraryHistoryEntryFromState } from "./LibraryView";

// The dialog is Ask's; here only whether and how the Wiki mounts it matters.
vi.mock("./ConsultationDialog", () => ({
  ConsultationDialog: vi.fn(() => <dialog data-testid="ask-dialog" />)
}));
// The navigator and the Topic page render as they are; the spies show what the Wiki hands them.
vi.mock("./topics/TopicNavigator", async (importOriginal) => {
  const original = await importOriginal<typeof import("./topics/TopicNavigator")>();
  return { ...original, TopicNavigator: vi.fn(original.TopicNavigator) };
});
vi.mock("./topic-page/TopicPage", async (importOriginal) => {
  const original = await importOriginal<typeof import("./topic-page/TopicPage")>();
  return { ...original, TopicPage: vi.fn(original.TopicPage) };
});

// The Map is the Shape view's; here only whether and how the Wiki mounts it matters.
vi.mock("./topic-shape/ShapeScreen", () => ({
  ShapeScreen: vi.fn(() => <div data-testid="shape-screen" />)
}));

afterEach(() => {
  vi.mocked(ShapeScreen).mockClear();
  vi.mocked(ConsultationDialog).mockClear();
  vi.mocked(TopicNavigator).mockClear();
  vi.mocked(TopicPage).mockClear();
});

const topicId = "00000000-0000-4000-8000-000000000001";
const otherTopicId = "00000000-0000-4000-8000-000000000002";
const lastProps = <Props,>(component: { mock: { calls: Props[][] } }): Props =>
  component.mock.calls.at(-1)![0]!;

const view = (
  language: (typeof supportedLanguageCodes)[number],
  overrides: Partial<WikiWorkspaceViewProps> = {}
) =>
  renderToString(
    <WikiWorkspaceView
      t={createTranslator(language)}
      active
      noticeToken={null}
      askOpen={false}
      onAsk={() => undefined}
      onCloseAsk={() => undefined}
      lens="topic"
      onLens={() => undefined}
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

  it("hosts the Topic page, with its close control, in the reading surface beside the navigator", () => {
    const html = view("en", { topicId });
    expect(html).toContain(`aria-label="${messages.en.wiki.navigation}"`);
    expect(html).toContain(messages.en.topics.navigator.title);
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain(`aria-label="${messages.en.topics.page.close}"`);
    // Where to start stays mounted under the open topic, hidden.
    expect(html).toMatch(/<div hidden="">\s*<section aria-labelledby="wiki-placeholder-title"/);
    expect(view("en")).not.toContain('<div hidden="">');
    expect(view("en")).not.toContain(messages.en.topics.page.close);
    expect(TopicPage).toHaveBeenCalledTimes(1);
  });

  it("hands the Topic page its topic, its links and the close, live only while the Wiki is shown", () => {
    const onNavigate = vi.fn();
    const onCloseTopic = vi.fn();
    view("en", { topicId, onNavigate, onCloseTopic });
    const page = lastProps(vi.mocked(TopicPage));
    expect(page).toMatchObject({ topicId, active: true });
    page.onNavigate({ type: "topic", topicId: otherTopicId });
    expect(onNavigate).toHaveBeenCalledWith({ type: "topic", topicId: otherTopicId });
    page.onClose?.();
    expect(onCloseTopic).toHaveBeenCalledTimes(1);

    view("en", { topicId, active: false });
    expect(lastProps(vi.mocked(TopicPage))).toMatchObject({ topicId, active: false });
  });

  it("opens a topic from the tree, Pinned or Recents the way every other link opens it", () => {
    const onNavigate = vi.fn();
    const onOpenSource = vi.fn();
    const onAsk = vi.fn();
    view("en", { topicId, onNavigate, onOpenSource, onAsk });
    const navigator = lastProps(vi.mocked(TopicNavigator));
    // The open topic is the navigator's selection, so it is revealed in the tree.
    expect(navigator).toMatchObject({ active: true, selectedTopicId: topicId });
    navigator.onOpenTopic(otherTopicId);
    expect(onNavigate).toHaveBeenCalledWith({ type: "topic", topicId: otherTopicId });
    navigator.onOpenSource("source-id", "note-id");
    expect(onOpenSource).toHaveBeenCalledWith("source-id", "note-id");
    navigator.onAsk?.();
    expect(onAsk).toHaveBeenCalledTimes(1);

    view("en", { topicId: null });
    expect(lastProps(vi.mocked(TopicNavigator))).toMatchObject({ selectedTopicId: null });
  });

  it("keeps the Ask entry in the navigator while a topic is open", () => {
    const html = view("en", { topicId });
    const [navigatorPart] = html.split('<div hidden="">');
    expect(navigatorPart!.match(/aria-haspopup="dialog"/g)).toHaveLength(1);
  });

  it("uses up the notice of an old link while a topic covers where to start", () => {
    const notice = messages.en.topics.placeholder.notice;
    expect(view("en", { noticeToken: 1, topicId })).not.toContain(notice);
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

  it("offers the Topic and Map lenses as tabs, the Topic first, each controlling its panel", () => {
    for (const language of supportedLanguageCodes) {
      const html = view(language);
      const copy = messages[language].topics.shape.tabs;
      expect(html, language).toContain('role="tablist"');
      expect(html, language).toContain(`aria-label="${copy.label}"`);
      expect(html, language).toContain(copy.topic);
      expect(html, language).toContain(copy.map);
      expect(html, language).not.toContain("[[missing:");
    }
    const html = view("en");
    expect(html.match(/role="tab"/g)).toHaveLength(2);
    expect(html.match(/role="tabpanel"/g)).toHaveLength(2);
    expect(html).toMatch(/id="[^"]*-tab-topic"[^>]*aria-selected="true"/);
    expect(html).toMatch(/id="[^"]*-tab-map"[^>]*aria-selected="false"/);
    // The Map is mounted from the start, hidden, so it keeps its branch and selection.
    expect(html).toMatch(/hidden=""[^>]*><div data-testid="shape-screen"/);
  });

  it("shows the Map instead of the Topic lens, each live only while it shows", () => {
    view("en", { lens: "topic", topicId });
    expect(lastProps(vi.mocked(ShapeScreen))).toMatchObject({ active: false });
    expect(lastProps(vi.mocked(TopicPage))).toMatchObject({ active: true });
    vi.mocked(TopicPage).mockClear();

    const html = view("en", { lens: "map", topicId });
    expect(lastProps(vi.mocked(ShapeScreen))).toMatchObject({ active: true });
    expect(lastProps(vi.mocked(TopicPage))).toMatchObject({ topicId, active: false });
    expect(html).toMatch(/id="[^"]*-tab-map"[^>]*aria-selected="true"/);
    expect(html).not.toMatch(/hidden=""[^>]*><div data-testid="shape-screen"/);
    // A hidden Wiki loads nothing, whatever lens it was left on.
    view("en", { lens: "map", active: false });
    expect(lastProps(vi.mocked(ShapeScreen))).toMatchObject({ active: false });
  });

  it("opens a topic from the Map the way every other link opens it", () => {
    const onNavigate = vi.fn();
    view("en", { lens: "map", onNavigate });
    lastProps(vi.mocked(ShapeScreen)).onNavigate({ type: "topic", topicId: otherTopicId });
    expect(onNavigate).toHaveBeenCalledWith({ type: "topic", topicId: otherTopicId });
  });

  it("preserves the wiki origin in native source-history navigation", () => {
    expect(libraryHistoryEntryFromState(createLibraryHistoryState({ view: "wiki" }))).toEqual({
      view: "wiki"
    });
  });
});
