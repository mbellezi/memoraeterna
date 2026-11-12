import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { fixtureId, notePage, relationItem, viewProps } from "./note-page-fixtures";
import { NotePageView } from "./NotePageView";

const render = (load: Parameters<typeof viewProps>[0], overrides = {}) =>
  renderToString(
    <NotePageView {...viewProps(load, { embedded: true, ...overrides })} />
  ).replaceAll("<!-- -->", "");

describe("the Note page in a panel (design record 6.3)", () => {
  it("puts the title and the meta first, then the status and the actions, then the prose", () => {
    const page = notePage();
    const html = render({ status: "ready", page });
    const title = html.indexOf("<h1");
    const meta = html.indexOf("Written by");
    const actions = html.indexOf("Mark as reviewed");
    const prose = html.indexOf("The curve is steep at first.");
    expect(title).toBeGreaterThan(-1);
    expect(meta).toBeGreaterThan(title);
    expect(actions).toBeGreaterThan(meta);
    expect(prose).toBeGreaterThan(actions);
  });

  it("holds the prose to the reading measure and drops the protection sentence", () => {
    const html = render({ status: "ready", page: notePage() });
    expect(html).toContain("max-w-(--measure)");
    expect(html).not.toContain("protected from automatic changes");
  });

  it("becomes the wide sheet from 760 px: a 600 px column and a 264 px margin for Evidence", () => {
    const html = render({ status: "ready", page: notePage() });
    expect(html).toContain("@container");
    expect(html).toContain("@min-[760px]:grid-cols-[minmax(0,600px)_264px]");
    expect(html).toContain("@min-[760px]:gap-x-12");
    // Evidence is a numbered quote, not a box.
    expect(html).toContain("italic");
    expect(html).not.toContain("rounded-lg border border-border px-4 py-3");
  });

  it("offers one way on from a note that is gone: closing the panel", () => {
    const html = render({ status: "missing" });
    expect(html).toContain("This note is no longer in your library.");
    expect(html).toContain(">Close panel<");
    // The previous panel says it once: a neutral word, no second sentence and no close.
    const quiet = render({ status: "missing" }, { compact: true });
    expect(quiet).toContain("No longer here");
    expect(quiet).not.toContain("no longer in your library");
    expect(quiet).not.toContain(">Close panel<");
  });

  it("keeps the previous panel quiet when the read failed: one caption, no glyph, no retry", () => {
    const html = render({ status: "error" }, { compact: true });
    expect(html).toContain("Unavailable");
    expect(html).not.toContain("Retry");
    expect(html).not.toContain('role="alert"');
  });

  it("draws quiet text actions and moves a note that already has a place", () => {
    const html = render(
      { status: "ready", page: notePage() },
      { place: { active: true, onPlaced: () => undefined } }
    );
    expect(html).toContain("Move to...");
    expect(html).not.toContain("Place in topic");
    expect(html).not.toContain("border-border-strong bg-surface text-foreground");
  });

  it("shows [n] of the prose as an accent numeral when Evidence lists that quote", () => {
    const base = notePage();
    const page = notePage({
      note: { ...base.note, bodyMarkdown: "A claim [1] and a stray [9]." }
    });
    const html = render({ status: "ready", page });
    expect(html).toContain('<sup class="ml-px text-xs font-semibold text-accent">1</sup>');
    expect(html).toContain("[9]");
  });

  it("calls the relations Connections, says the direction and offers a suggestion's answers", () => {
    const base = notePage();
    const page = notePage({
      relations: {
        total: 2,
        items: [
          relationItem({ id: fixtureId(60), type: "supports", direction: "incoming" }),
          relationItem({
            id: fixtureId(64),
            type: "extends",
            state: "suggested",
            probability: 0.7,
            other: { ...base.relations.items[0]!.other, id: fixtureId(65) }
          })
        ]
      }
    });
    const html = render({ status: "ready", page });
    expect(html).toContain(">Connections<");
    expect(html).toContain("supports this note");
    expect(html).toContain("border-dashed");
    expect(html).toContain(">Keep<");
    expect(html).toContain(">Remove<");
    // The graph belongs to the context panel: no List and Graph tabs here.
    expect(html).not.toContain('role="tablist"');
  });
});
