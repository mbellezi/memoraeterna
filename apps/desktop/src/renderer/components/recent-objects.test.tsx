import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createTranslator, supportedLanguageCodes } from "@app/i18n";
import { viewHistoryBounds, type ViewHistoryEntry } from "../../shared/view-history";
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
    // No raw ID or address reaches the screen (markers for focus are attributes, never text).
    const visible = html.replace(/<[^>]*>/gu, "");
    expect(visible).not.toContain(sourceId);
    expect(visible).not.toContain("memora://");
  });

  it("groups pinned entries before the recent ones, naming each group", () => {
    const both = render({
      status: "ready",
      entries: [
        entry({ pinned: true }),
        entry({
          address: `memora://note/${noteId}`,
          kind: "note",
          id: noteId,
          title: "Recent note"
        })
      ]
    });
    expect(both.indexOf(">Pinned<")).toBeGreaterThan(-1);
    expect(both.indexOf(">Recent<")).toBeGreaterThan(both.indexOf(">Pinned<"));
    expect(both.indexOf("Recent note")).toBeGreaterThan(both.indexOf(">Recent<"));
    expect(both).toContain('aria-labelledby="library-recents-pinned"');
    expect(both).toContain('aria-labelledby="library-recents-recent"');
    // A list of recents alone needs no sub-heading under the Recents title.
    const recentsOnly = render({ status: "ready", entries: [entry()] });
    expect(recentsOnly).not.toContain("<h3");
    // Pins alone keep their group heading and offer nothing to clear.
    const pinsOnly = render({ status: "ready", entries: [entry({ pinned: true })] });
    expect(pinsOnly).toContain(">Pinned<");
    expect(pinsOnly).not.toContain(">Recent<");
  });

  it("keeps the recents on the list and offers clearing when every pin slot is taken", () => {
    const pins = Array.from({ length: viewHistoryBounds.pinMax }, (_, index) =>
      entry({
        address: `memora://source/00000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`,
        id: `00000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`,
        title: `Pinned source ${index}`,
        pinned: true
      })
    );
    const html = render({ status: "ready", entries: [...pins, entry({ title: "Fresh recent" })] });
    expect(html).toContain("Fresh recent");
    expect(html).toContain("Clear recents");
    // No more pins: the note says why, and only the entries that are not pinned lose their control.
    expect(html).toContain("You can pin up to 10 items. Unpin one to pin another.");
    const control = (title: string) => {
      const tag = html.match(new RegExp(`<button[^>]*aria-label="${title}"[^>]*>`, "u"))?.[0];
      expect(tag, title).toBeDefined();
      return tag!;
    };
    expect(control("Pin Fresh recent")).toContain('disabled=""');
    expect(control("Unpin Pinned source 0")).not.toContain('disabled=""');
    // With a free slot the control is enabled and no note is shown.
    const free = render({
      status: "ready",
      entries: [...pins.slice(1), entry({ title: "Fresh recent" })]
    });
    expect(free).not.toContain("You can pin up to");
    expect(free.match(/<button[^>]*aria-label="Pin Fresh recent"[^>]*>/u)?.[0]).not.toContain(
      'disabled=""'
    );
  });

  it("names the clear confirmation so focus can move into it, and the title so it can come back", () => {
    const html = render({ status: "ready", entries: [entry()] }, { confirmingClear: true });
    const group = html.match(/<div[^>]*role="group"[^>]*>/u)?.[0] ?? "";
    expect(group).toContain('tabindex="-1"');
    expect(group).toContain('data-recents-focus="clear-confirmation"');
    // The group is labelled by the question, which is announced when focus enters it.
    const labelledBy = /aria-labelledby="([^"]+)"/u.exec(group)?.[1];
    expect(labelledBy).toBe("library-recents-clear-question");
    expect(html).toContain(`id="${labelledBy}"`);
    expect(html.match(/<h2[^>]*>/u)?.[0]).toContain('data-recents-focus="title"');
    expect(html.match(/<h2[^>]*>/u)?.[0]).toContain('tabindex="-1"');
    // The Clear button that the confirmation replaces is the place Cancel returns to.
    const idle = render({ status: "ready", entries: [entry()] });
    expect(idle).toContain('data-recents-focus="clear-button"');
    expect(idle).not.toContain('role="group"');
  });

  it("marks each pin control with its address, so focus can follow it between the groups", () => {
    const html = render({ status: "ready", entries: [entry()] });
    expect(html).toContain(`data-recents-pin="memora://source/${sourceId}"`);
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
