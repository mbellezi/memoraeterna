import { renderToString } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { createTranslator } from "@app/i18n";

import { sourceDetailSchema } from "../../shared/ipc";
import { AtomicNoteCard, SourceDetailView } from "./LibraryView";
import { MarkdownPreview } from "./MarkdownEditor";

const t = createTranslator("en");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const sourceId = id(1);
const documentId = id(2);
const chunkIds = [id(11), id(12), id(13)];
const spanIds = [id(21), id(22), id(23)];

const paragraphs = [
  "First paragraph of the document.",
  "Second paragraph, the one that is cited.",
  "Third paragraph at the end."
];
const markdown = `# A title\n\n${paragraphs.join("\n\n")}\n`;
const chunkOf = (index: number) => {
  const start = markdown.indexOf(paragraphs[index]!);
  return {
    id: chunkIds[index]!,
    content: paragraphs[index]!,
    chunkIndex: index,
    sourceSpanId: spanIds[index]!,
    startOffset: start,
    endOffset: start + paragraphs[index]!.length,
    page: index === 1 ? 7 : null
  };
};

const detail = () =>
  sourceDetailSchema.parse({
    id: sourceId,
    type: "StandaloneArticle",
    title: "An article",
    subtitle: null,
    sourceUri: null,
    language: "en",
    summary: null,
    metadata: {},
    updatedAt: "2026-10-14T10:00:00.000Z",
    assets: [],
    documents: [
      {
        id: documentId,
        title: "An article",
        canonicalMarkdown: markdown,
        language: "en",
        chunks: [0, 1, 2].map(chunkOf),
        assets: []
      }
    ],
    summaries: [],
    atomicNotes: [],
    relations: []
  });

const noop = () => undefined;
const view = (
  focusedPassage: Parameters<typeof SourceDetailView>[0]["focusedPassage"],
  language = "en"
) =>
  renderToString(
    <SourceDetailView
      detail={detail()}
      active
      focusedAtomicNoteId={null}
      allSources={[]}
      backLabel="Back"
      t={createTranslator(language)}
      onOpen={noop}
      onOpenPath={noop}
      onGoToLibrary={noop}
      onBack={noop}
      onProcess={noop}
      onDeleted={noop}
      onRefresh={noop}
      onPage={noop}
      offset={0}
      loading={false}
      loadError={false}
      metadataEnrichmentEnabled
      onOpenNote={noop}
      onNavigateObject={noop}
      focusedPassage={focusedPassage}
      onPassageShown={noop}
    />
  ).replaceAll("<!-- -->", "");

const passage = (chunkId: string | null, sourceSpanId: string | null = null) => ({
  passage: { chunkId, sourceSpanId, documentId: null },
  token: 1
});

describe("a citation opens the exact passage in the source reader", () => {
  it("opens on the content, highlights the cited block in the Markdown and the cited chunk", () => {
    const html = view(passage(chunkIds[1]!, spanIds[1]!));
    // The Markdown block of the passage is wrapped and marked; its neighbours are not.
    expect(html.match(/data-cited-passage="true"/g)).toHaveLength(1);
    expect(html).toMatch(
      /<div id="cited-passage" tabindex="-1" data-cited-passage="true"[^>]*><p[^>]*>Second paragraph, the one that is cited\.<\/p><\/div>/
    );
    expect(html).not.toMatch(/data-cited-passage="true"[^>]*><p[^>]*>First paragraph/);
    expect(html).not.toMatch(/data-cited-passage="true"[^>]*><p[^>]*>Third paragraph/);
    // The chunk entry is the only current one, with its anchor, label and page.
    expect(html.match(/aria-current="true"/g)).toHaveLength(1);
    expect(html).toMatch(
      new RegExp(`<li id="passage-chunk-${chunkIds[1]}"[^>]*aria-current="true"[^>]*>`)
    );
    expect(html).toContain("Cited passage");
    // The reader says what it shows, as a status, and does not warn.
    expect(html).toMatch(/role="status"[^>]*>.*Showing the cited passage.*Chunk 2 · Page 7/);
    expect(html).not.toContain("not in the current version");
  });

  it("finds the passage by its SourceSpan when the chunk is not known", () => {
    const html = view(passage(null, spanIds[2]!));
    expect(html).toMatch(
      new RegExp(`<li id="passage-chunk-${chunkIds[2]}"[^>]*aria-current="true"`)
    );
    expect(html).toContain("Chunk 3");
  });

  it("says so, and offers earlier versions, when the passage is not in the current version", () => {
    const html = view(passage(id(99), id(98)));
    expect(html).toContain('role="alert"');
    expect(html).toContain("This passage is not in the current version of the source");
    expect(html).toContain(">Show earlier versions<");
    expect(html).not.toContain("data-cited-passage");
    expect(html).not.toContain('aria-current="true"');
  });

  it("shows nothing special when no passage is cited", () => {
    const html = view(null);
    expect(html).not.toContain("data-cited-passage");
    expect(html).not.toContain("Showing the cited passage");
    expect(html).not.toContain("passage-chunk-");
  });

  it("puts the Where is this panel under the header of every source", () => {
    const html = view(null);
    expect(html).toContain('data-testid="where-is-this"');
    expect(html.indexOf('data-testid="where-is-this"')).toBeGreaterThan(html.indexOf("An article"));
    expect(html.indexOf('data-testid="where-is-this"')).toBeLessThan(
      html.indexOf('role="tablist"')
    );
  });

  it("is translated: the banner follows the interface language", () => {
    const html = view(passage(chunkIds[0]!), "pt-BR");
    expect(html).toContain(createTranslator("pt-BR")("objects.citation.showing"));
    expect(html).toContain(createTranslator("pt-BR")("objects.whereIsThis.title"));
  });
});

describe("Markdown highlight", () => {
  const render = (value: string, highlight?: { start: number; end: number; id: string }) =>
    renderToString(<MarkdownPreview markdown={value} emptyLabel="empty" highlight={highlight} />);

  it("marks the run of blocks the range touches as one passage with a single anchor", () => {
    const value = "alpha\n\nbeta\n\ngamma\n\ndelta";
    const start = value.indexOf("beta") + 2;
    const end = value.indexOf("gamma") + 2;
    const html = render(value, { start, end, id: "here" });
    expect(html.match(/data-cited-passage="true"/g)).toHaveLength(1);
    expect(html.match(/id="here"/g)).toHaveLength(1);
    // Both touched blocks share the one highlight; their neighbours stay outside it.
    expect(html).toMatch(/id="here"[^>]*><p[^>]*>beta<\/p><p[^>]*>gamma<\/p><\/div>/);
    expect(html).toMatch(/<p[^>]*>alpha<\/p><div id="here"/);
    expect(html).toMatch(/<\/div><p[^>]*>delta<\/p>/);
  });

  it("measures offsets in the stored text, whatever its line endings", () => {
    const value = "one\r\n\r\ntwo\r\n\r\nthree";
    const start = value.indexOf("two");
    const html = render(value, { start, end: start + 3, id: "here" });
    expect(html).toMatch(/id="here"[^>]*><p[^>]*>two/);
    expect(html.match(/data-cited-passage="true"/g)).toHaveLength(1);
  });

  it("keeps headings, lists and code blocks whole when they are cited", () => {
    const value = "# Head\n\n- one\n- two\n\n```\ncode\n```\n";
    const list = render(value, {
      start: value.indexOf("- two"),
      end: value.indexOf("- two") + 5,
      id: "x"
    });
    expect(list).toMatch(
      /data-cited-passage="true"[^>]*><ul[^>]*><li[^>]*>one<\/li><li[^>]*>two<\/li>/
    );
    const code = render(value, {
      start: value.indexOf("code"),
      end: value.indexOf("code") + 4,
      id: "x"
    });
    expect(code).toMatch(/data-cited-passage="true"[^>]*><pre/);
    expect(render(value, { start: 0, end: 4, id: "x" })).toMatch(
      /data-cited-passage="true"[^>]*><h1/
    );
  });

  it("renders exactly as before without a highlight or outside every block", () => {
    const value = "alpha\n\nbeta";
    expect(render(value)).not.toContain("data-cited-passage");
    expect(render(value, { start: 500, end: 600, id: "x" })).not.toContain("data-cited-passage");
    expect(render(value, { start: 3, end: 3, id: "x" })).not.toContain("data-cited-passage");
  });
});

describe("note cards", () => {
  const note = {
    ownership: "source",
    supersessionStatus: "current",
    id: id(30),
    title: "Spacing flattens the curve",
    bodyMarkdown: "Reviewing at spaced intervals flattens the forgetting curve.",
    ideaStatement: "Spacing flattens forgetting.",
    language: "en",
    status: "active",
    sourceItemId: sourceId,
    sourceSpanId: spanIds[1]!,
    evidenceChunkId: chunkIds[1]!,
    generationModel: "model",
    generationPromptVersion: "atomic-note-v4",
    humanProtected: false,
    createdAt: "2026-10-14T10:00:00.000Z",
    updatedAt: "2026-10-14T10:00:00.000Z"
  } as Parameters<typeof AtomicNoteCard>[0]["note"];

  it("is a summary whose title opens the Note page", () => {
    const html = renderToString(<AtomicNoteCard note={note} focused t={t} onOpenNote={noop} />);
    expect(html).toMatch(/<button[^>]*>Spacing flattens the curve<\/button>/);
    expect(html).toContain("Spacing flattens forgetting.");
    expect(html).toContain('id="atomic-note-');
    expect(html).toContain("ring-accent");
    // The page shows the text, the passage and where the note is: the card does not.
    expect(html).not.toContain("Reviewing at spaced intervals");
    expect(html).not.toContain("where-is-this");
    expect(html).not.toContain("Open the passage this note comes from");
    expect(html).not.toContain("aria-expanded");
  });

  it("shows the title as text without a way to open the page", () => {
    const bare = renderToString(<AtomicNoteCard note={note} t={t} />);
    expect(bare).not.toContain("<button");
    expect(bare).toContain("Spacing flattens the curve");
    expect(bare).not.toContain("ring-accent");
  });
});
