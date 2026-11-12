import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { createTranslator, type Translator } from "@app/i18n";

import type { LibraryRow } from "../../../../shared/ipc-library";
import type { QuestionListItemView } from "../../../../shared/ipc-questions";
import { LibraryPeek, peekFrameState } from "./LibraryPeek";
import { initialPagedState, type PagedState } from "./paged-list";
import {
  LibraryView,
  libraryState,
  questionColumns,
  sourceColumns,
  type LibraryViewProps
} from "./LibraryRoot";
import type { LibraryFacets } from "./library-model";
import * as panel from "./library.panel";
import { destinationRoots } from "../../destinations";
import { matchPanel, panelRegistry } from "../../PanelStack";

const en = createTranslator("en");
const pt = createTranslator("pt-BR");
const noop = () => undefined;
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const row = (n: number, fields: Partial<LibraryRow> = {}): LibraryRow => ({
  id: id(n),
  title: `Source ${n}`,
  type: "Book",
  authors: [],
  addedAt: "2026-11-10T22:35:00.000Z",
  updatedAt: "2026-11-10T22:35:00.000Z",
  status: "ready",
  reason: null,
  noteCount: 4,
  place: { path: [{ id: id(100), title: "Nutrition" }], tentative: false },
  hasCover: false,
  ...fields
});

const facets: LibraryFacets = {
  territories: [
    { topic: { id: id(100), title: "Nutrition" }, count: 3 },
    { topic: null, count: 1 }
  ],
  statuses: { processing: 1, ready: 1, failed: 0, needsYou: 1, storedOnly: 1 }
};

const ready = <Item, Facets>(
  items: Item[],
  extra: Partial<PagedState<Item, Facets>> = {}
): PagedState<Item, Facets> => ({
  ...(initialPagedState as PagedState<Item, Facets>),
  status: "ready",
  items,
  total: items.length,
  ...extra
});

const data = <Item, Facets>(state: PagedState<Item, Facets>) => ({
  state,
  more: noop,
  retry: noop
});

function props(over: Partial<LibraryViewProps> = {}): LibraryViewProps {
  return {
    t: en,
    mode: "full",
    compactTier: false,
    tab: "sources",
    query: {},
    questionText: "",
    density: "comfortable",
    sources: data(
      ready<LibraryRow, LibraryFacets>(
        [
          row(1, {
            status: "processing",
            place: { path: [{ id: id(100), title: "Nutrition" }], tentative: true }
          }),
          row(2),
          row(3, { status: "needsYou", reason: "no_model.no_route", noteCount: 0, place: null }),
          row(4, { status: "storedOnly", noteCount: 0 })
        ],
        { facets, total: 48 }
      )
    ),
    questions: data(initialPagedState as PagedState<QuestionListItemView, never>),
    titles: new Map(),
    selected: null,
    peeking: false,
    expanded: false,
    currentKey: null,
    now: new Date("2026-11-11T12:00:00.000Z"),
    panelId: "panel",
    onTab: noop,
    onQuery: noop,
    onQuestionText: noop,
    onDensity: noop,
    onSelect: noop,
    onPeek: noop,
    onClosePeek: noop,
    onExpand: noop,
    onOpen: noop,
    ...over
  };
}

// The ribbon reads its place from the main process; a stub shows which place the sheet asks for.
vi.mock("../../PathRibbon", () => ({
  PathRibbon: ({ place }: { place?: string }) => (
    <span data-ribbon-state={place ?? "placed"} data-ribbon-stub="" />
  )
}));

const render = (over: Partial<LibraryViewProps> = {}) =>
  renderToString(<LibraryView {...props(over)} />);
const surface = 'data-surface="destination-library"';

describe("the frame's state", () => {
  it("is loading before the first page, error when it failed, empty with no rows and success otherwise", () => {
    expect(libraryState({ status: "loading", items: [] })).toBe("loading");
    expect(libraryState({ status: "error", items: [] })).toBe("error");
    expect(libraryState({ status: "ready", items: [] })).toBe("empty");
    expect(libraryState({ status: "ready", items: [1] })).toBe("success");
  });

  it.each([
    ["loading", { ...initialPagedState }],
    ["error", { ...initialPagedState, status: "error" as const }],
    ["empty", ready<LibraryRow, LibraryFacets>([], { total: 0, facets })],
    ["success", undefined]
  ])("writes %s on the frame, with the surface id", (state, sources) => {
    const html = render(
      sources ? { sources: data(sources as PagedState<LibraryRow, LibraryFacets>) } : {}
    );
    expect(html).toContain(surface);
    expect(html).toContain(`data-state="${state}"`);
  });
});

describe("the table in success", () => {
  const html = render();

  it("has the header's title, tabs, count and density toggle", () => {
    expect(html).toContain(">Library<");
    expect(html).toContain('role="tablist"');
    expect(html).toContain('aria-selected="true"');
    expect(html).toContain("48 sources");
    expect(html).toContain("Comfortable");
    expect(html).toContain("Compact");
  });

  it("has the five columns with the default sort on Added, newest first", () => {
    for (const label of ["Source", "Place in the tree", "Notes", "State", "Added"])
      expect(html).toContain(label);
    expect(html).toContain('aria-sort="descending"');
    expect(html.match(/aria-sort="/g)).toHaveLength(1);
    expect(html).toContain("newest first");
  });

  it("draws each state in words, with the reason it needs you and the way to notes", () => {
    expect(html).toContain("Generating");
    expect(html).toContain("Ready");
    expect(html).toContain("no model chosen yet");
    expect(html).toContain("Stored, no notes");
    expect(html).toContain("Generate notes");
  });

  it("says a place is likely when it is tentative, and shows no place for an unplaced source", () => {
    expect(html).toContain("likely:");
    expect(html).toContain("border-dashed");
    expect(html).toContain("No place");
  });

  it("has the state chips with their counts and the territory bar that adds up", () => {
    expect(html).toContain("All");
    expect(html).toContain("Needs you");
    expect(html).toContain("No notes");
    expect(html).not.toContain("Blocked");
    expect(html).toContain("By area:");
    expect(html).toContain("Nutrition");
  });

  it("has the keys of the table on the foot", () => {
    expect(html).toContain("choose");
    expect(html).toContain("peek");
    expect(html).toContain("open beside");
  });

  it("draws the quick-look sheet in place over the table when it is told to, under its own surface id", () => {
    const html = render({
      selected: id(2),
      peeking: true,
      peekPortal: false,
      surfaceId: "library-peek"
    });
    expect(html).toContain('data-surface="library-peek"');
    expect(html).toContain("Peeking");
    expect(html).toContain("Source 2");
    expect(render({ selected: id(2) })).not.toContain("Peeking");
  });

  it("draws a tentative source's place as tentative in the sheet's ribbon, never as placed", () => {
    const sheet = (selected: string) =>
      render({ selected, peeking: true, peekPortal: false, surfaceId: "library-peek" });
    expect(sheet(id(1))).toContain('data-ribbon-state="tentativeSource"');
    expect(sheet(id(2))).toContain('data-ribbon-state="placed"');
  });

  it("reports the sheet's own read as the frame's state for the screens tool", () => {
    const summary = { address: "", kind: "source", title: "", status: "current", updatedAt: "" };
    expect(peekFrameState({ status: "loading" })).toBe("loading");
    expect(peekFrameState({ status: "error" })).toBe("error");
    expect(peekFrameState({ status: "missing" })).toBe("error");
    expect(peekFrameState({ status: "ready", object: { ...summary, preview: "" } as never })).toBe(
      "empty"
    );
    expect(
      peekFrameState({
        status: "ready",
        object: { ...summary, preview: "", counts: { notes: 3 } } as never
      })
    ).toBe("success");
  });

  it("marks the sorted header and the selected row", () => {
    const selected = render({ selected: id(2) });
    expect(selected).toContain('aria-selected="true"');
    expect(selected).toContain("shadow:inset_2px_0_0_var(--accent)");
  });

  it("serves the grid as a table: rows are drawn, each with one tab stop at most", () => {
    expect(html).toContain('role="grid"');
    expect(html.match(/tabindex="0"/g)?.length ?? 0).toBeGreaterThanOrEqual(1);
  });
});

describe("the quick-look sheet's own states", () => {
  const sheet = (object: Parameters<typeof LibraryPeek>[0]["object"], kind = "source") =>
    renderToString(
      <LibraryPeek
        t={pt}
        address={`memora://${kind}/${id(7)}`}
        object={object}
        title="Ruas completas"
        meta="Fonte"
        portal={false}
        onClose={noop}
        onRetry={noop}
        onOpen={noop}
      />
    );
  const summary = {
    address: `memora://source/${id(7)}`,
    kind: "source",
    title: "Ruas completas",
    status: "current",
    updatedAt: "2026-11-10T22:35:00.000Z"
  };

  it("says what failed, what is kept and offers the shared retry word when the read failed", () => {
    const html = sheet({ status: "error" });
    expect(html).toContain("Não deu para ler esta fonte.");
    expect(html).toContain("Ela continua guardada; nada mudou.");
    expect(html).toContain("Tentar de novo");
    expect(sheet({ status: "error" }, "question")).toContain("Não deu para ler esta pergunta.");
  });

  it("teaches what comes next when the object has no summary and no counts yet", () => {
    const html = sheet({ status: "ready", object: { ...summary, preview: "" } as never });
    expect(html).toContain("O resumo aparece quando as notas terminarem.");
    expect(html).toContain("abre ao lado");
    const filled = sheet({
      status: "ready",
      object: { ...summary, preview: "Compara ruas.", counts: { notes: 2 } } as never
    });
    expect(filled).not.toContain("O resumo aparece");
  });
});

describe("the table in the compact tier", () => {
  it("drops Added and Notes, and keeps Source, Place and State", () => {
    const labels = (compact: boolean) => sourceColumns(en, compact).map((column) => column.id);
    expect(labels(false)).toEqual(["title", "place", "notes", "status", "added"]);
    expect(labels(true)).toEqual(["title", "place", "status"]);
    expect(questionColumns(en, false).map((column) => column.id)).toEqual([
      "text",
      "answers",
      "status",
      "asked"
    ]);
    expect(questionColumns(en, true).map((column) => column.id)).toEqual(["text", "status"]);
    const html = render({ compactTier: true });
    expect(html).not.toContain(">Added<");
    expect(html).not.toContain(">Notes<");
    expect(html).toContain(">State<");
  });
});

describe("loading, empty and error", () => {
  it("keeps the layout while loading: the header, the bars and eight rows in the shape of the table", () => {
    const html = render({
      sources: data(initialPagedState as PagedState<LibraryRow, LibraryFacets>)
    });
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain(">Library<");
    expect(html).toContain("By area:");
  });

  it("teaches what to do in an empty library", () => {
    const html = render({
      sources: data(
        ready<LibraryRow, LibraryFacets>([], {
          total: 0,
          facets: {
            territories: [],
            statuses: { processing: 0, ready: 0, failed: 0, needsYou: 0, storedOnly: 0 }
          }
        })
      )
    });
    expect(html).toContain("No sources yet.");
    expect(html).toContain("⌘N");
    expect(html).toContain("border-dashed");
    expect(html).not.toContain("Clear filters");
    // Nothing to filter yet: no filter field, chips, territory bar or count above the sentence.
    expect(html).not.toContain("searchbox");
    expect(html).not.toContain("By area:");
    expect(html).not.toContain("0 sources");
  });

  it("offers the empty library's one action, the shell's Add, as the drop zone's primary button", () => {
    const empty = ready<LibraryRow, LibraryFacets>([], { total: 0, facets });
    const without = render({ sources: data(empty) });
    expect(without).toContain("Drop files here to start");
    expect(without).not.toContain("Choose a file");
    const html = render({ sources: data(empty), onAdd: noop });
    expect(html).toContain("Choose a file");
    expect(html).toContain("Drop files here to start");
  });

  it("keeps the filter and the chips under an error, dimmed and inert", () => {
    const html = render({
      sources: data({
        ...(initialPagedState as PagedState<LibraryRow, LibraryFacets>),
        status: "error"
      })
    });
    expect(html).toContain("disabled");
    expect(html).toContain("inert");
  });

  it("marks the dimmed filter field as inactive as a whole, so its glyph and key hint are exempt from contrast", () => {
    const failed = render({
      sources: data({
        ...(initialPagedState as PagedState<LibraryRow, LibraryFacets>),
        status: "error"
      })
    });
    expect(failed).toContain('data-disabled=""');
    const working = render({
      sources: data(ready<LibraryRow, LibraryFacets>([row(1)], { total: 1, facets }))
    });
    expect(working).not.toContain("data-disabled");
  });

  it("says a filter matched nothing and offers to clear it", () => {
    const html = render({
      query: { text: "zzz" },
      sources: data(ready<LibraryRow, LibraryFacets>([], { total: 0, facets }))
    });
    expect(html).toContain("No sources match this filter.");
    expect(html).toContain("Clear filters");
    expect(html).toContain('data-state="empty"');
  });

  it("fails in place: one sentence, what is kept, and one retry", () => {
    const html = render({
      sources: data({
        ...(initialPagedState as PagedState<LibraryRow, LibraryFacets>),
        status: "error"
      })
    });
    expect(html).toContain('role="alert"');
    expect(html).toContain("Could not read the Library.");
    expect(html).toContain("Your sources and notes are safe.");
    expect(html.match(/Retry|Try again/g)?.length ?? 0).toBe(1);
  });

  it("reads in Portuguese, with no English chrome left", () => {
    const html = render({ t: pt });
    for (const word of [
      "Fonte",
      "Lugar na árvore",
      "Notas",
      "Estado",
      "Adicionada",
      "Precisa de você",
      "Guardada, sem notas",
      "Sem lugar",
      "provável:",
      "Gerar notas",
      "Por área:",
      "escolher",
      "abrir ao lado"
    ])
      expect(html, word).toContain(word);
    expect(html).not.toMatch(/\[\[missing/);
    expect(
      render({ t: pt, sources: data(initialPagedState as PagedState<LibraryRow, LibraryFacets>) })
    ).toContain("Biblioteca");
  });
});

describe("the Questions tab", () => {
  const question = (n: number, over: Partial<QuestionListItemView> = {}): QuestionListItemView => ({
    id: id(300 + n),
    text: `Why does it keep ${n}?`,
    language: "en",
    scope: { kind: "library" },
    status: "complete",
    createdAt: "2026-11-10T20:15:00.000Z",
    updatedAt: "2026-11-10T20:20:00.000Z",
    answerCount: n,
    ...over
  });
  const tab = (
    t: Translator = en,
    items = [question(1), question(2, { scope: { kind: "topic", topicId: id(100) } })]
  ) =>
    render({
      t,
      tab: "questions",
      questions: data(ready<QuestionListItemView, never>(items, { total: items.length })),
      titles: new Map([[id(100), "Nutrition"]])
    });

  it("lists each question with what it asked about, its answers, its state and its date", () => {
    const html = tab();
    expect(html).toContain("Why does it keep 1?");
    expect(html).toContain("Whole library");
    expect(html).toContain("Topic: Nutrition");
    expect(html).toContain("Answered");
    expect(html).toContain("Answers");
    expect(html).toContain("2 questions");
    expect(html).toContain('aria-sort="descending"');
  });

  it("has no state chips or territory bar, only the filter, and reads in Portuguese", () => {
    const html = tab(pt);
    expect(html).not.toContain("By area");
    expect(html).not.toContain("Por área");
    expect(html).toContain("Filtrar perguntas");
    expect(html).toContain("Toda a Biblioteca");
    expect(html).toContain("Tópico: Nutrition");
    expect(html).toContain("Respondida");
  });

  it("teaches in an empty tab", () => {
    const html = render({
      tab: "questions",
      questions: data(ready<QuestionListItemView, never>([], { total: 0 }))
    });
    expect(html).toContain("No saved questions yet.");
    expect(html).toContain("⌘K");
  });
});

describe("the compact form, as the previous panel", () => {
  it("is the list of titles with the open source marked, and no table", () => {
    const html = render({ mode: "compact", currentKey: id(2) });
    expect(html).toContain('data-mode="compact"');
    expect(html).toContain('data-variant="list"');
    expect(html).toContain('aria-current="true"');
    expect(html).toContain("Source 1");
    expect(html).not.toContain('role="columnheader"');
    expect(html).not.toContain("By area");
    expect(html).toContain(surface);
  });

  it("keeps its four states", () => {
    expect(
      render({
        mode: "compact",
        sources: data(initialPagedState as PagedState<LibraryRow, LibraryFacets>)
      })
    ).toContain('data-state="loading"');
    expect(
      render({
        mode: "compact",
        sources: data({
          ...(initialPagedState as PagedState<LibraryRow, LibraryFacets>),
          status: "error"
        })
      })
    ).toContain('role="alert"');
    expect(
      render({ mode: "compact", sources: data(ready<LibraryRow, LibraryFacets>([], { total: 0 })) })
    ).toContain('data-state="empty"');
  });
});

describe("the panel module", () => {
  it("takes the Library's view address, with or without a query, and nothing else", () => {
    expect(panel.match(destinationRoots.library)).toBe(true);
    expect(panel.match("memora://library?tab=questions&status=needsYou")).toBe(true);
    expect(panel.match(destinationRoots.home)).toBe(false);
    expect(panel.match(`memora://source/${id(1)}`)).toBe(false);
  });

  it("is found by the stack's glob for the Library's root, and for no other destination", () => {
    expect(matchPanel(panelRegistry, destinationRoots.library)?.kind).toBe("destination-library");
    expect(matchPanel(panelRegistry, destinationRoots.explore)).toBeNull();
  });

  it("is named by the destination and reports its own surface", () => {
    expect(panel.kind).toBe("destination-library");
    expect(panel.title(null, pt)).toBe("Biblioteca");
    expect(typeof panel.Component).toBe("function");
  });
});
