import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator, supportedLanguageCodes, type MessageKey } from "@app/i18n";
import type { ObjectLocateResult } from "@app/domain";

import { WhereIsThisView, type WhereIsThisState } from "./WhereIsThis";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const t = createTranslator("en");
const escaped = (text: string) => text.replaceAll("'", "&#x27;");

const located = (overrides: Partial<ObjectLocateResult> = {}): ObjectLocateResult => ({
  object: { kind: "source", id: id(3), title: "Section A" },
  primaryPath: [
    { kind: "source", id: id(1), title: "The Book" },
    { kind: "source", id: id(2), title: "Chapter One" },
    { kind: "source", id: id(3), title: "Section A" }
  ],
  alsoIn: [{ kind: "topic", id: id(7), title: "Memory", legacy: true }],
  citedBy: [
    { kind: "note", id: id(8), title: "Spacing flattens forgetting", legacy: false },
    { kind: "question", id: id(9), title: "Why does spacing work?", legacy: true }
  ],
  counts: { alsoIn: 1, citedBy: 2, notes: 4, passages: 12, children: 0 },
  ...overrides
});
const ready = (result = located()): WhereIsThisState => ({
  status: "ready",
  address: `memora://source/${result.object.id}`,
  result
});

// React separates adjacent text nodes with comment markers; the person never sees them.
const plain = (html: string) => html.replaceAll("<!-- -->", "");
const render = (state: WhereIsThisState, extra: { openFailed?: boolean } = {}) =>
  plain(
    renderToString(
      <WhereIsThisView
        t={t}
        state={state}
        onOpen={() => undefined}
        onRetry={() => undefined}
        {...extra}
      />
    )
  );

describe("Where is this panel", () => {
  it("shows the path from the root: earlier segments are buttons, the current object is not", () => {
    const html = render(ready());
    expect(html).toContain('data-testid="where-is-this"');
    expect(html).toContain(">Where is this<");
    expect(html).toContain('aria-label="Path from the library root"');
    // The root and the chapter navigate; the section you are on does not.
    expect(html).toMatch(/<button[^>]*>The Book<\/button>/);
    expect(html).toMatch(/<button[^>]*>Chapter One<\/button>/);
    expect(html).not.toMatch(/<button[^>]*>Section A<\/button>/);
    expect(html).toContain('aria-current="location"');
    expect(html).toContain('Section A<span class="sr-only"> · you are here</span>');
  });

  it("lists the other places and the citations, marking legacy wiki pages, in an inline section", () => {
    const html = render(ready());
    expect(html).not.toContain("<dialog");
    expect(html).not.toContain('role="dialog"');
    expect(html).toContain("Also in · 1");
    expect(html).toContain("Cited by · 2");
    expect(html).toMatch(/<button[^>]*>Memory<\/button>/);
    expect(html).toMatch(/<button[^>]*>Spacing flattens forgetting<\/button>/);
    expect(html).toContain("Legacy wiki");
    expect(html).toContain(escaped(t("objects.whereIsThis.legacyHint")));
    // Each entry says what kind of object it is.
    for (const kind of ["Topic", "Note", "Question"]) expect(html).toContain(`>${kind}<`);
    // The note citing it is not marked legacy: two legacy badges (topic, question) only.
    expect(html.match(/Legacy wiki/g)).toHaveLength(2);
  });

  it("shows the non-zero counts and says how many entries are not shown", () => {
    const html = render(
      ready(located({ counts: { alsoIn: 40, citedBy: 2, notes: 0, passages: 12, children: 3 } }))
    );
    expect(html).toContain("Chunks");
    expect(html).toContain("Subitems");
    expect(html).not.toContain(">Notes<");
    expect(html).toContain("39 more not shown");
  });

  it("covers the empty state of each list", () => {
    const html = render(
      ready(
        located({
          alsoIn: [],
          citedBy: [],
          counts: { alsoIn: 0, citedBy: 0, notes: 0, passages: 0, children: 0 }
        })
      )
    );
    expect(html).toContain("It is not placed anywhere else.");
    expect(html).toContain("Nothing cites it yet.");
    expect(html).not.toContain("<dl");
  });

  it("covers loading, a missing object and a retryable failure", () => {
    const loading = render({ status: "loading" });
    expect(loading).toContain('aria-busy="true"');
    expect(loading).toContain('role="status"');
    expect(loading).toContain("Finding where this is...");
    expect(render({ status: "missing" })).toContain("This item is no longer in the library.");
    const failed = render({ status: "error" });
    expect(failed).toContain('role="alert"');
    expect(failed).toContain("Where this is could not be loaded.");
    expect(failed).toContain(">Retry<");
    expect(render(ready(), { openFailed: true })).toContain("That item could not be opened.");
    expect(render(ready())).not.toContain("That item could not be opened.");
  });

  it("never shows an identifier to the person", () => {
    const html = render(ready());
    expect(html).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(html).not.toContain("memora://");
  });

  it("is translated in every locale", () => {
    const keys: MessageKey[] = [
      "objects.whereIsThis.title",
      "objects.whereIsThis.loading",
      "objects.whereIsThis.missing",
      "objects.whereIsThis.error",
      "objects.whereIsThis.openFailed",
      "objects.whereIsThis.path",
      "objects.whereIsThis.here",
      "objects.whereIsThis.alsoIn",
      "objects.whereIsThis.alsoInEmpty",
      "objects.whereIsThis.citedBy",
      "objects.whereIsThis.citedByEmpty",
      "objects.whereIsThis.legacy",
      "objects.whereIsThis.legacyHint",
      "objects.whereIsThis.more",
      "objects.whereIsThis.counts.passages",
      "objects.whereIsThis.counts.notes",
      "objects.whereIsThis.counts.children",
      "objects.citation.openPassage",
      "objects.citation.noteOrigin",
      "objects.citation.showing",
      "objects.citation.unavailable",
      "objects.citation.earlierVersions",
      "objects.citation.cited",
      "objects.kinds.source",
      "objects.kinds.note",
      "objects.kinds.topic",
      "objects.kinds.question",
      "objects.kinds.entity",
      "objects.errors.unavailable",
      "objects.errors.unsupportedKind"
    ];
    for (const locale of supportedLanguageCodes) {
      const translate = createTranslator(locale);
      for (const key of keys) {
        const text = translate(key, { values: { count: 3 } });
        expect(text, `${locale} ${key}`).not.toContain("[[missing");
      }
      const html = renderToString(
        <WhereIsThisView
          t={translate}
          state={ready()}
          onOpen={() => undefined}
          onRetry={() => undefined}
        />
      );
      expect(html).toContain(escaped(translate("objects.whereIsThis.title")));
      expect(html).toContain(escaped(translate("objects.whereIsThis.alsoIn")));
    }
  });
});
