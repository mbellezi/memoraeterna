import { describe, expect, it } from "vitest";
import { createTranslator } from "@app/i18n";

import { libraryRowsLimit, type LibraryRow } from "../../../../shared/ipc-library";
import { questionListMaxLimit } from "../../../../shared/ipc-questions";
import {
  chipViews,
  defaultDirections,
  facetKey,
  formatAdded,
  isFiltered,
  isFilterKey,
  isPeekChord,
  libraryPaging,
  moveCursor,
  needsNextPage,
  orderKey,
  placeView,
  queryKey,
  questionsInput,
  reasonKey,
  resolvedSort,
  rowHeights,
  rowsInput,
  scopeLabel,
  scopeTopicIds,
  sourceMeta,
  statusView,
  tableAction,
  territoryViews,
  toggleSort,
  viewportInRows,
  withoutField,
  type LibraryFacets,
  type TableKeyInput
} from "./library-model";

const en = createTranslator("en");
const pt = createTranslator("pt-BR");
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const key = (input: Partial<TableKeyInput> & { key: string }): TableKeyInput => ({
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...input
});

describe("paging", () => {
  it("never asks a source for more rows in one request than its API takes", () => {
    expect(libraryPaging.refreshPages.sources).toBeLessThanOrEqual(libraryRowsLimit.max);
    expect(libraryPaging.refreshPages.questions).toBeLessThanOrEqual(questionListMaxLimit);
    expect(libraryPaging.pageSize).toBeLessThanOrEqual(questionListMaxLimit);
  });
});

describe("sorting", () => {
  it("starts at Adicionada, newest first, and gives each column its own first direction", () => {
    expect(resolvedSort({})).toEqual({ sort: "added", dir: "desc" });
    expect(defaultDirections).toEqual({
      title: "asc",
      status: "asc",
      added: "desc",
      updated: "desc",
      notes: "desc"
    });
    expect(resolvedSort({ sort: "title" })).toEqual({ sort: "title", dir: "asc" });
    expect(resolvedSort({ sort: "title", dir: "desc" })).toEqual({ sort: "title", dir: "desc" });
  });

  it("flips a column that is already sorted and starts another at its default", () => {
    expect(toggleSort({}, "added")).toEqual({ sort: "added", dir: "asc" });
    expect(toggleSort({ sort: "added", dir: "asc" }, "added")).toEqual({
      sort: "added",
      dir: "desc"
    });
    expect(toggleSort({}, "title")).toEqual({ sort: "title", dir: "asc" });
    expect(toggleSort({ sort: "title", dir: "asc" }, "notes")).toEqual({
      sort: "notes",
      dir: "desc"
    });
    // Other fields of the query stay.
    expect(toggleSort({ text: "café", status: "ready" }, "status")).toEqual({
      text: "café",
      status: "ready",
      sort: "status",
      dir: "asc"
    });
  });
});

describe("what a query asks of library.rows", () => {
  it("sends the sort, the filter and the page, and the counts only when asked", () => {
    expect(rowsInput({}, { limit: 50, facets: true })).toEqual({
      sort: "added",
      dir: "desc",
      limit: 50,
      facets: true
    });
    expect(
      rowsInput(
        { text: "  kefir ", status: "needsYou", topic: id(1), sort: "title" },
        { cursor: "c1", limit: 100, facets: false }
      )
    ).toEqual({
      sort: "title",
      dir: "asc",
      filter: { status: "needsYou", topicId: id(1), query: "kefir" },
      cursor: "c1",
      limit: 100
    });
  });

  it("sends no empty text, and no more than the API takes", () => {
    expect(rowsInput({ text: "   " }, { limit: 50, facets: false }).filter).toBeUndefined();
    const long = rowsInput({ text: "x".repeat(500) }, { limit: 50, facets: false });
    expect(long.filter?.query).toHaveLength(200);
  });

  it("asks for the counts again only when a filter changed, never for a sort", () => {
    const base = { status: "ready", text: "a" } as const;
    expect(facetKey({ ...base, sort: "title" })).toBe(facetKey({ ...base, sort: "notes" }));
    expect(queryKey({ ...base, sort: "title" })).not.toBe(queryKey({ ...base, sort: "notes" }));
    expect(facetKey(base)).not.toBe(facetKey({ ...base, status: "failed" }));
    expect(facetKey(base)).not.toBe(facetKey({ ...base, topic: id(2) }));
    expect(facetKey(base)).not.toBe(facetKey({ ...base, text: "b" }));
    // Whitespace around the text is not a new query.
    expect(queryKey({ text: " a " })).toBe(queryKey({ text: "a" }));
  });

  it("builds a questions page from the words of the filter", () => {
    expect(questionsInput(undefined, { limit: 50 })).toEqual({ limit: 50 });
    expect(questionsInput(" pH ", { cursor: "q", limit: 50 })).toEqual({
      cursor: "q",
      limit: 50,
      query: "pH"
    });
  });

  it("knows when something narrows the table, and drops one field without writing undefined", () => {
    expect(isFiltered({})).toBe(false);
    expect(isFiltered({ sort: "title" })).toBe(false);
    expect(isFiltered({ text: " " })).toBe(false);
    expect(isFiltered({ status: "failed" })).toBe(true);
    expect(isFiltered({ topic: id(3) })).toBe(true);
    const next = withoutField({ text: "a", status: "ready" }, "status");
    expect(next).toEqual({ text: "a" });
    expect("status" in next).toBe(false);
  });
});

const row = (fields: Partial<LibraryRow> = {}): LibraryRow => ({
  id: id(1),
  title: "Kefir e kombucha em casa",
  type: "Book",
  authors: ["A. Autor", "B. Autora"],
  addedAt: "2026-11-10T22:35:00.000Z",
  updatedAt: "2026-11-10T22:35:00.000Z",
  status: "ready",
  reason: null,
  noteCount: 14,
  place: null,
  hasCover: false,
  ...fields
});

describe("the statuses of a row", () => {
  it("words each of the five in the design's terms", () => {
    const words = (status: LibraryRow["status"]) => en(statusView(row({ status })).word);
    expect(words("ready")).toBe("Ready");
    expect(words("processing")).toBe("Generating");
    expect(words("needsYou")).toBe("Needs you");
    expect(words("failed")).toBe("Blocked");
    expect(words("storedOnly")).toBe("Stored, no notes");
    expect(pt(statusView(row({ status: "needsYou" })).word)).toBe("Precisa de você");
    expect(pt(statusView(row({ status: "storedOnly" })).word)).toBe("Guardada, sem notas");
  });

  it("gives a second line to a source that needs you, one that is blocked and one stored only", () => {
    const detail = (status: LibraryRow["status"], reason: string | null = null) =>
      statusView(row({ status, reason })).detail;
    expect(detail("ready")).toBeNull();
    expect(detail("processing")).toBeNull();
    expect(en(detail("needsYou", "no_model.no_route") as never)).toBe("no model chosen yet");
    expect(en(detail("failed") as never)).toBe("stopped; the source is kept");
    expect(en(detail("storedOnly") as never)).toBe("Generate notes");
  });

  it("names every blocker that holds work for a person, and a plain fallback for any other", () => {
    for (const reason of [
      "no_model.no_route",
      "no_model.model_missing",
      "no_model.signin_required",
      "cap.money_80",
      "cap.money_100"
    ])
      expect(reasonKey(reason)).not.toBe("libraryTable.reasons.other");
    expect(reasonKey("waiting.queue")).toBe("libraryTable.reasons.other");
    expect(reasonKey(null)).toBe("libraryTable.reasons.other");
  });

  it("marks the tones the design uses: success, running, warning, danger, idle", () => {
    expect(
      (["ready", "processing", "needsYou", "failed", "storedOnly"] as const).map(
        (status) => statusView(row({ status })).tone
      )
    ).toEqual(["success", "running", "warning", "danger", "idle"]);
  });
});

describe("the place of a row", () => {
  const path = [1, 2, 3, 4].map((n) => ({ id: id(n), title: `T${n}` }));

  it("shows the last two crumbs and says when there are more above", () => {
    expect(placeView(null)).toEqual({ kind: "none", crumbs: [], deeper: false });
    expect(placeView({ path: path.slice(0, 1), tentative: false })).toMatchObject({
      kind: "placed",
      deeper: false
    });
    const deep = placeView({ path, tentative: false });
    expect(deep.crumbs.map((crumb) => crumb.title)).toEqual(["T3", "T4"]);
    expect(deep.deeper).toBe(true);
    expect(placeView({ path: path.slice(0, 2), tentative: false }).deeper).toBe(false);
  });

  it("calls a place tentative when the row says so", () => {
    expect(placeView({ path: path.slice(0, 2), tentative: true }).kind).toBe("tentative");
  });
});

describe("the words under a title", () => {
  it("writes the type and the authors, and only the type when there are none", () => {
    expect(sourceMeta(en, row())).toBe("Book · A. Autor, B. Autora");
    expect(sourceMeta(pt, row({ type: "Video", authors: [] }))).toBe("Vídeo");
    expect(sourceMeta(pt, row({ type: "WebArticle", authors: [] }))).toBe("Artigo da web");
  });
});

describe("the date of a row", () => {
  const now = new Date(2026, 10, 11, 12, 0, 0);
  const at = (days: number, h: number, m: number) =>
    new Date(2026, 10, 11 - days, h, m, 0).toISOString();

  it("says today and yesterday with the time, then the day and month", () => {
    expect(formatAdded(pt, at(0, 9, 12), now)).toBe("hoje, 09:12");
    expect(formatAdded(pt, at(1, 22, 35), now)).toBe("ontem, 22:35");
    expect(formatAdded(pt, at(8, 10, 0), now)).toBe("3 nov");
    expect(formatAdded(en, at(1, 22, 35), now)).toBe("yesterday, 10:35 PM");
  });

  it("adds the year to a date of another year and survives a bad date", () => {
    expect(formatAdded(pt, new Date(2025, 4, 2, 10, 0, 0).toISOString(), now)).toMatch(/2025/);
    expect(formatAdded(pt, "not a date", now)).toBe("");
  });
});

describe("the state chips and the territory bar", () => {
  const facets = (over: Partial<LibraryFacets["statuses"]> = {}): LibraryFacets => ({
    territories: [
      { topic: { id: id(1), title: "Ciências da vida" }, count: 13 },
      { topic: { id: id(2), title: "Nutrição" }, count: 9 },
      { topic: null, count: 2 }
    ],
    statuses: { processing: 1, ready: 43, failed: 0, needsYou: 1, storedOnly: 3, ...over }
  });

  it("counts Todas as every state together, and shows no count before the first read", () => {
    const chips = chipViews(facets(), undefined);
    expect(chips.map((chip) => [chip.id, chip.count])).toEqual([
      ["all", 48],
      ["processing", 1],
      ["needsYou", 1],
      ["storedOnly", 3]
    ]);
    expect(chipViews(null, undefined).every((chip) => chip.count === null)).toBe(true);
  });

  it("shows Bloqueadas only while a source is blocked or the chip is chosen", () => {
    expect(chipViews(facets({ failed: 2 }), undefined).map((chip) => chip.id)).toContain("failed");
    expect(chipViews(facets(), undefined).map((chip) => chip.id)).not.toContain("failed");
    expect(chipViews(facets(), "failed").map((chip) => chip.id)).toContain("failed");
  });

  it("lists each area with its count, the sources with no place last, adding up to the total", () => {
    const territories = territoryViews(facets());
    expect(territories.map((entry) => entry.title)).toEqual(["Ciências da vida", "Nutrição", ""]);
    expect(territories.at(-1)?.id).toBeNull();
    expect(territories.reduce((sum, entry) => sum + entry.count, 0)).toBe(24);
    expect(territoryViews(null)).toEqual([]);
  });
});

describe("the foot's order note", () => {
  it("has words for every sort in both directions", () => {
    for (const sort of ["title", "added", "updated", "notes", "status"] as const)
      for (const dir of ["asc", "desc"] as const)
        expect(pt(orderKey({ sort, dir })), `${sort} ${dir}`).not.toMatch(/missing/);
    expect(pt(orderKey(resolvedSort({})))).toBe("as mais novas primeiro");
    expect(en(orderKey({ sort: "title", dir: "asc" }))).toBe("by title, A to Z");
  });
});

describe("the questions' scopes", () => {
  const titles = new Map<string, string | null>([
    [id(1), "Nutrição"],
    [id(2), null]
  ]);

  it("says what each was asked about", () => {
    expect(scopeLabel(pt, { kind: "library" }, titles)).toBe("Toda a Biblioteca");
    expect(scopeLabel(pt, { kind: "topic", topicId: id(1) }, titles)).toBe("Tópico: Nutrição");
    expect(scopeLabel(pt, { kind: "topic", topicId: id(2) }, titles)).toBe(
      "Um tópico que não existe mais"
    );
    expect(scopeLabel(pt, { kind: "topic", topicId: id(3) }, titles)).toBe("Um tópico");
    expect(scopeLabel(en, { kind: "sources", sourceIds: [id(5)] }, titles)).toBe("1 source");
    expect(scopeLabel(en, { kind: "sources", sourceIds: [id(5), id(6)] }, titles)).toBe(
      "2 sources"
    );
  });

  it("lists each topic scope once for one batch of titles", () => {
    expect(
      scopeTopicIds([
        { scope: { kind: "topic", topicId: id(1) } },
        { scope: { kind: "library" } },
        { scope: { kind: "topic", topicId: id(1) } },
        { scope: { kind: "sources", sourceIds: [id(9)] } },
        { scope: { kind: "topic", topicId: id(2) } }
      ])
    ).toEqual([id(1), id(2)]);
  });
});

describe("the keys of the table", () => {
  it("moves the cursor with the arrows, Home, End and the page keys", () => {
    expect(tableAction(key({ key: "ArrowDown" }))).toEqual({ type: "move", key: "down" });
    expect(tableAction(key({ key: "ArrowUp" }))).toEqual({ type: "move", key: "up" });
    expect(tableAction(key({ key: "Home" }))).toEqual({ type: "move", key: "home" });
    expect(tableAction(key({ key: "End" }))).toEqual({ type: "move", key: "end" });
    expect(tableAction(key({ key: "PageDown" }))).toEqual({ type: "move", key: "pageDown" });
    expect(tableAction(key({ key: "PageUp" }))).toEqual({ type: "move", key: "pageUp" });
  });

  it("opens beside with Enter and in the panel with Option-Enter", () => {
    expect(tableAction(key({ key: "Enter" }))).toEqual({ type: "open", replace: false });
    expect(tableAction(key({ key: "Enter", altKey: true }))).toEqual({
      type: "open",
      replace: true
    });
  });

  it("peeks with Space and with Cmd-Y or Ctrl-Y, and leaves other chords alone", () => {
    expect(tableAction(key({ key: " ", code: "Space" }))).toEqual({ type: "peek" });
    expect(tableAction(key({ key: "y", metaKey: true }))).toEqual({ type: "peek" });
    expect(tableAction(key({ key: "Y", ctrlKey: true }))).toEqual({ type: "peek" });
    expect(isPeekChord(key({ key: "y", metaKey: true }))).toBe(true);
    expect(isPeekChord(key({ key: "y", metaKey: true, shiftKey: true }))).toBe(false);
    expect(isPeekChord(key({ key: "y" }))).toBe(false);
    expect(tableAction(key({ key: "ArrowDown", metaKey: true }))).toBeNull();
    expect(tableAction(key({ key: "ArrowDown", shiftKey: true }))).toBeNull();
    expect(tableAction(key({ key: "a" }))).toBeNull();
  });

  it("answers nothing while an input method composes", () => {
    expect(tableAction(key({ key: "Enter", isComposing: true }))).toBeNull();
    expect(isPeekChord(key({ key: "y", metaKey: true, isComposing: true }))).toBe(false);
  });

  it("focuses the filter by the physical slash key and by the character", () => {
    expect(isFilterKey(key({ key: "/", code: "Slash" }))).toBe(true);
    // ABNT2: the slash is typed from another key, the physical Slash key types ";" or ":".
    expect(isFilterKey(key({ key: ";", code: "Slash" }))).toBe(true);
    expect(isFilterKey(key({ key: "/", code: "KeyQ" }))).toBe(true);
    expect(isFilterKey(key({ key: "/", code: "Slash", metaKey: true }))).toBe(false);
    expect(isFilterKey(key({ key: "a", code: "KeyA" }))).toBe(false);
  });

  it("keeps the cursor inside the rows that are loaded", () => {
    expect(moveCursor(-1, 10, "down")).toBe(0);
    expect(moveCursor(-1, 10, "up")).toBe(0);
    expect(moveCursor(0, 10, "up")).toBe(0);
    expect(moveCursor(9, 10, "down")).toBe(9);
    expect(moveCursor(3, 10, "home")).toBe(0);
    expect(moveCursor(3, 10, "end")).toBe(9);
    expect(moveCursor(3, 10, "pageDown")).toBe(9);
    expect(moveCursor(7, 10, "pageUp")).toBe(0);
    expect(moveCursor(2, 0, "down")).toBe(-1);
    expect(moveCursor(50, 10, "up")).toBe(8);
  });
});

describe("the window", () => {
  it("turns the navigator's 28 px units into rows of this table, rounding out", () => {
    // 28 px units 0-40 are 1120 px: 17.5 rows of 64 px.
    expect(viewportInRows({ first: 0, end: 40 }, 28, rowHeights.comfortable, 100)).toEqual({
      first: 0,
      end: 18
    });
    // 56 px rows are two units each.
    expect(viewportInRows({ first: 10, end: 30 }, 28, rowHeights.compact, 100)).toEqual({
      first: 5,
      end: 15
    });
    expect(viewportInRows({ first: 0, end: 400 }, 28, 56, 12)).toEqual({ first: 0, end: 12 });
    expect(rowHeights).toEqual({ comfortable: 64, compact: 56 });
  });

  it("asks for the next page near the end, once, and not after a failure", () => {
    const base = { windowEnd: 40, count: 50, hasMore: true, busy: false, failed: false };
    expect(needsNextPage(base)).toBe(true);
    expect(needsNextPage({ ...base, windowEnd: 10 })).toBe(false);
    expect(needsNextPage({ ...base, hasMore: false })).toBe(false);
    expect(needsNextPage({ ...base, busy: true })).toBe(false);
    expect(needsNextPage({ ...base, failed: true })).toBe(false);
    expect(libraryPaging.nearEnd).toBeLessThan(libraryPaging.pageSize);
  });
});
