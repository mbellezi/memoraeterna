import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createTranslator, supportedLanguageCodes } from "@app/i18n";
import type { ViewHistoryEntry } from "../../shared/view-history";
import {
  LibraryView,
  libraryBackLabelKey,
  libraryClosesSource,
  libraryHistoryEntryForOpening
} from "./LibraryView";
import { RecentObjectsView, type RecentsState } from "./RecentObjects";

const sourceId = "00000000-0000-4000-8000-0000000000a1";
const noteId = "00000000-0000-4000-8000-0000000000b1";

const entry = (overrides: Partial<ViewHistoryEntry> = {}): ViewHistoryEntry => ({
  address: `memora://source/${sourceId}`,
  kind: "source",
  id: sourceId,
  title: "Memory and attention",
  parentAddress: null,
  openedAt: "2026-10-15T10:00:00.000Z",
  openCount: 1,
  pinned: false,
  ...overrides
});

const handlers = {
  onOpen: vi.fn(),
  onTogglePin: vi.fn(),
  onAskClear: vi.fn(),
  onConfirmClear: vi.fn(),
  onCancelClear: vi.fn(),
  onRetry: vi.fn()
};

function render(
  state: RecentsState,
  options: { confirmingClear?: boolean; busy?: boolean; failed?: boolean; language?: string } = {}
) {
  return renderToString(
    <RecentObjectsView
      t={createTranslator(options.language ?? "en")}
      state={state}
      confirmingClear={options.confirmingClear ?? false}
      busy={options.busy ?? false}
      failed={options.failed ?? false}
      {...handlers}
    />
  );
}

describe("the Recents list", () => {
  it("shows a loading state", () => {
    const html = render({ status: "loading" });
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading recent items...");
    expect(html).not.toContain("Clear recents");
  });

  it("shows a retryable error", () => {
    const html = render({ status: "error" });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Recent items could not be loaded.");
    expect(html).toContain("Retry");
  });

  it("explains an empty list from the user's side", () => {
    const html = render({ status: "ready", entries: [] });
    expect(html).toContain("Nothing opened yet. Sources and notes you open appear here.");
    expect(html).not.toContain("Clear recents");
  });

  it("lists the entries with a kind label, a glyph and a pin control that names its target", () => {
    const html = render({
      status: "ready",
      entries: [
        entry({ pinned: true }),
        entry({
          address: `memora://note/${noteId}`,
          kind: "note",
          id: noteId,
          title: "A note about sleep",
          parentAddress: `memora://source/${sourceId}`
        })
      ]
    });
    expect(html).toContain("Memory and attention");
    expect(html).toContain("A note about sleep");
    expect(html).toContain(">Source<");
    expect(html).toContain(">Note<");
    // Pinned entries are marked with a glyph and text, not only a colour; the control names the action.
    expect(html).toContain("fill-current");
    expect(html).toContain(">Pinned<");
    expect(html).toContain('aria-label="Unpin Memory and attention"');
    expect(html).toContain('aria-label="Pin A note about sleep"');
    expect(html).toContain("Clear recents");
    // No raw ID or address reaches the screen.
    expect(html).not.toContain(sourceId);
    expect(html).not.toContain("memora://");
  });

  it("offers clearing only when there is something to clear, and says what stays", () => {
    expect(render({ status: "ready", entries: [entry({ pinned: true })] })).not.toContain(
      "Clear recents"
    );
    const html = render({ status: "ready", entries: [entry()] }, { confirmingClear: true });
    expect(html).toContain("Clear recent items? Pinned items stay.");
    expect(html).toContain(">Clear<");
    expect(html).toContain("Cancel");
    expect(html).not.toContain("Clear recents");
  });

  it("disables the controls while a change is in flight and reports a failed one", () => {
    const busy = render({ status: "ready", entries: [entry()] }, { busy: true });
    expect(busy.match(/disabled=""/g)?.length).toBeGreaterThanOrEqual(2);
    const failed = render({ status: "ready", entries: [entry()] }, { failed: true });
    expect(failed).toContain("The change could not be saved.");
  });

  it("is written in every interface language", () => {
    for (const language of supportedLanguageCodes) {
      const t = createTranslator(language);
      const html = render({ status: "ready", entries: [entry()] }, { language });
      expect(html, language).toContain(t("viewHistory.title"));
      expect(html, language).toContain(t("viewHistory.kind.source"));
      expect(html, language).not.toContain("[[missing");
    }
    expect(render({ status: "loading" }, { language: "pt-BR" })).toContain("Recentes");
  });
});

describe("the Library start view", () => {
  it("shows the Recents list above the sources", () => {
    const html = renderToString(
      <LibraryView t={createTranslator("en")} onOpenRecent={() => undefined} />
    );
    expect(html).toContain('id="library-recents-title"');
    expect(html).toContain("Loading recent items...");
    // Under the search and filter controls, above the list of sources (loading here).
    const recents = html.indexOf("library-recents-title");
    expect(recents).toBeGreaterThan(html.indexOf("Filter by source type"));
    expect(recents).toBeLessThan(html.indexOf(">Loading...<"));
  });

  it("has no Recents list when nothing can open one", () => {
    expect(renderToString(<LibraryView t={createTranslator("en")} />)).not.toContain(
      "library-recents-title"
    );
  });

  it("closes the open source with Close Panel only while it is the shown view", () => {
    expect(libraryClosesSource(true, sourceId)).toBe(true);
    expect(libraryClosesSource(true, null)).toBe(false);
    expect(libraryClosesSource(false, sourceId)).toBe(false);
  });
});

describe("opening a recent entry in the Library", () => {
  it("leaves Back on the Library list, like an import, and repairs a foreign history entry", () => {
    expect(
      libraryHistoryEntryForOpening("recents", { view: "library", path: [], fromSearch: false })
    ).toBeNull();
    expect(libraryHistoryEntryForOpening("recents", { view: "wiki" })).toEqual({
      view: "library",
      path: [],
      fromSearch: false
    });
    expect(libraryHistoryEntryForOpening("recents", null)).toEqual({
      view: "library",
      path: [],
      fromSearch: false
    });
  });

  it("labels Back as the Library, never as a return to search", () => {
    const openedTarget = { sourceItemId: sourceId, origin: "recents" as const, token: 1 };
    expect(libraryBackLabelKey({ stack: [sourceId], openedTarget, fromSearch: false })).toBe(
      "library.back"
    );
  });
});
