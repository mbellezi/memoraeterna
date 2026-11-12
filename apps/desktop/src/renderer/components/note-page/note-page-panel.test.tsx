import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { notePage, viewProps } from "./note-page-fixtures";
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
  });
});
