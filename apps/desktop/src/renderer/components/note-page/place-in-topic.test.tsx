import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator, supportedLanguageCodes } from "@app/i18n";

import { NotePageView, type NotePageViewProps } from "./NotePageView";
import { notePage } from "./note-page-fixtures";
import { PlaceInTopic } from "./PlaceInTopic";

const noop = () => undefined;

function render(overrides: Partial<NotePageViewProps> = {}, status = "active"): string {
  const page = notePage();
  return renderToString(
    <NotePageView
      t={createTranslator("en")}
      backLabel="Back to library"
      load={{
        status: "ready",
        page: { ...page, note: { ...page.note, status: status as typeof page.note.status } }
      }}
      editing={null}
      review={{ pending: false, failed: false }}
      openCard={null}
      explanations={{}}
      more={{ status: "idle" }}
      openFailed={false}
      announcement=""
      onBack={noop}
      onRetry={noop}
      onMarkReviewed={noop}
      onStartEdit={noop}
      onDraftChange={noop}
      onSave={noop}
      onCancelEdit={noop}
      onDiscardAndReload={noop}
      onEscapeEdit={noop}
      onOpenNote={noop}
      onOpenPassage={noop}
      onOpenPlacement={noop}
      onCardEvent={noop}
      onRetryExplanation={noop}
      onShowMore={noop}
      {...overrides}
    />
  ).replaceAll("<!-- -->", "");
}

describe("Place in topic on the Note page", () => {
  it("is offered next to the note's other actions when the page can place it", () => {
    const html = render({ place: { active: true, onPlaced: noop } });
    expect(html).toMatch(/<button[^>]*aria-haspopup="dialog"[^>]*>[^]*?Place in topic<\/button>/);
    // The edit action stays after it, as before.
    expect(html.indexOf("Place in topic")).toBeLessThan(html.indexOf(">Edit<"));
  });

  it("is not offered without the host's wiring, to a note out of use, or while editing", () => {
    expect(render()).not.toContain("Place in topic");
    expect(render({ place: { active: true, onPlaced: noop } }, "rejected")).not.toContain(
      "Place in topic"
    );
    expect(render({ place: { active: true, onPlaced: noop } }, "archived")).not.toContain(
      "Place in topic"
    );
  });

  it("keeps a live region for its notice and opens no dialog until asked", () => {
    const html = renderToString(
      <PlaceInTopic
        t={createTranslator("en")}
        noteId="00000000-0000-4000-8000-000000000001"
        noteTitle="A note"
        active
        onPlaced={noop}
      />
    );
    expect(html).toContain('role="status"');
    expect(html).not.toContain("<dialog");
  });

  it("is written in every language", () => {
    for (const locale of supportedLanguageCodes) {
      const html = renderToString(
        <PlaceInTopic
          t={createTranslator(locale)}
          noteId="00000000-0000-4000-8000-000000000001"
          noteTitle="A note"
          active
          onPlaced={noop}
        />
      );
      expect(html, locale).not.toContain("[[missing");
    }
  });
});
