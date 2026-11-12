import type { AskScope } from "@app/domain";
import type { MessageKey, Translator } from "@app/i18n";

import type {
  LibraryRow,
  LibraryRowStatus,
  LibraryRowsInput,
  LibraryRowsResult,
  LibrarySort
} from "../../../../shared/ipc-library";
import type { QuestionListItemView, QuestionsListInput } from "../../../../shared/ipc-questions";
import type { LibraryQuery } from "../../route";
import type { Density } from "../../state";

/**
 * The Library table's pure model (design record §7.3; spec T149): what a query asks of
 * `library.rows`, how a row reads (state, place, date), the state chips and the territory bar, the
 * Questions tab's rows, and the keys the table answers. Nothing here touches React or the DOM.
 */

/** Rows per page and what a live refresh re-reads (typed configuration, not a rule). */
export const libraryPaging = {
  pageSize: 50,
  /** A refresh re-reads in pages of each API's maximum (`library.rows` 100, `questions.list` 50). */
  refreshPages: { sources: 100, questions: 50 },
  /** A refresh re-reads this many rows; a list loaded deeper keeps the rows past it. */
  refreshCap: 500,
  /** The table asks for the next page when the window comes this close to the end. */
  nearEnd: 20,
  /** Typing, sorting and chip clicks settle this long before the read (about 10k rows cost 160-260 ms). */
  settleMs: 180,
  /** Live changes arrive in bursts while a source is written: one re-read per burst. */
  refreshDelayMs: 400
} as const;

/** The row heights of the table by density (design record §4.4: 12 or 8 px of padding) and of a title list. */
export const rowHeights: Readonly<Record<Density, number>> = { comfortable: 64, compact: 56 };
export const titleListRowHeight = 36;
/** The sticky header row of the table. */
export const headerHeight = 36;

// ---------------------------------------------------------------------------
// The query

export const defaultDirections: Readonly<Record<LibrarySort, "asc" | "desc">> = {
  title: "asc",
  status: "asc",
  added: "desc",
  updated: "desc",
  notes: "desc"
};

export interface ResolvedSort {
  sort: LibrarySort;
  dir: "asc" | "desc";
}

/** The sort a query means: Adicionada, newest first, until the person picks another. */
export function resolvedSort(query: LibraryQuery): ResolvedSort {
  const sort = query.sort ?? "added";
  return { sort, dir: query.dir ?? defaultDirections[sort] };
}

/** A header click: the same column flips its direction, another column starts at its own default. */
export function toggleSort(query: LibraryQuery, column: LibrarySort): LibraryQuery {
  const now = resolvedSort(query);
  const dir =
    now.sort === column ? (now.dir === "asc" ? "desc" : "asc") : defaultDirections[column];
  return { ...query, sort: column, dir };
}

/** The query with one field removed (optional fields are never written as `undefined`). */
export function withoutField(query: LibraryQuery, field: keyof LibraryQuery): LibraryQuery {
  const next = { ...query };
  delete next[field];
  return next;
}

/** The trimmed filter text, or null when there is none to send. */
export function filterText(query: LibraryQuery): string | null {
  const text = query.text?.trim();
  return text ? text.slice(0, 200) : null;
}

/** What identifies the rows a query reads: a change of it starts the table from its first page. */
export function queryKey(query: LibraryQuery): string {
  const { sort, dir } = resolvedSort(query);
  return [sort, dir, query.status ?? "", query.topic ?? "", filterText(query) ?? ""].join("|");
}

/** What the state chips and the territory bar count: a change of it asks for the counts again. */
export function facetKey(query: LibraryQuery): string {
  return [query.status ?? "", query.topic ?? "", filterText(query) ?? ""].join("|");
}

export function rowsInput(
  query: LibraryQuery,
  page: { cursor?: string | undefined; limit: number; facets: boolean }
): LibraryRowsInput {
  const { sort, dir } = resolvedSort(query);
  const text = filterText(query);
  const filter = {
    ...(query.status ? { status: query.status } : {}),
    ...(query.topic ? { topicId: query.topic } : {}),
    ...(text ? { query: text } : {})
  };
  return {
    sort,
    dir,
    ...(Object.keys(filter).length > 0 ? { filter } : {}),
    ...(page.cursor ? { cursor: page.cursor } : {}),
    limit: page.limit,
    ...(page.facets ? { facets: true } : {})
  };
}

export function questionsInput(
  text: string | undefined,
  page: { cursor?: string | undefined; limit: number }
): QuestionsListInput {
  const query = text?.trim().slice(0, 200);
  return {
    ...(page.cursor ? { cursor: page.cursor } : {}),
    limit: page.limit,
    ...(query ? { query } : {})
  };
}

/** True when anything narrows the table: a filter, a state or an area. */
export const isFiltered = (query: LibraryQuery): boolean =>
  filterText(query) !== null || query.status !== undefined || query.topic !== undefined;

// ---------------------------------------------------------------------------
// A source row

export type StatusTone = "success" | "running" | "warning" | "danger" | "idle";

export interface StatusView {
  status: LibraryRowStatus;
  tone: StatusTone;
  word: MessageKey;
  /** The second line: why it needs you, what is kept when it is blocked, or the way to notes. */
  detail: MessageKey | null;
}

const statusWords: Readonly<Record<LibraryRowStatus, MessageKey>> = {
  ready: "libraryTable.status.ready",
  processing: "libraryTable.status.processing",
  needsYou: "libraryTable.status.needsYou",
  failed: "libraryTable.status.failed",
  storedOnly: "libraryTable.status.storedOnly"
};

const statusTones: Readonly<Record<LibraryRowStatus, StatusTone>> = {
  ready: "success",
  processing: "running",
  needsYou: "warning",
  failed: "danger",
  storedOnly: "idle"
};

/** The blockers that hold a source for a person (`gardenerStatusNeedsPerson`), in short words. */
const reasonKeys: Readonly<Record<string, MessageKey>> = {
  "no_model.no_route": "libraryTable.reasons.noRoute",
  "no_model.model_missing": "libraryTable.reasons.modelMissing",
  "no_model.signin_required": "libraryTable.reasons.signIn",
  "cap.money_80": "libraryTable.reasons.moneyNear",
  "cap.money_100": "libraryTable.reasons.moneyReached"
};

export function reasonKey(reason: string | null): MessageKey {
  return (reason !== null ? reasonKeys[reason] : undefined) ?? "libraryTable.reasons.other";
}

export function statusView(row: Pick<LibraryRow, "status" | "reason">): StatusView {
  const detail: MessageKey | null =
    row.status === "needsYou"
      ? reasonKey(row.reason)
      : row.status === "failed"
        ? "libraryTable.reasons.failed"
        : row.status === "storedOnly"
          ? "libraryTable.actions.generate"
          : null;
  return {
    status: row.status,
    tone: statusTones[row.status],
    word: statusWords[row.status],
    detail
  };
}

export interface PlaceView {
  kind: "none" | "placed" | "tentative";
  /** The last two crumbs; an unnamed topic has an empty title (the view says "Tópico sem nome"). */
  crumbs: readonly { id: string; title: string }[];
  /** There are more crumbs above the two shown ("…"). */
  deeper: boolean;
}

export const placeCrumbsShown = 2;

export function placeView(place: LibraryRow["place"]): PlaceView {
  if (!place) return { kind: "none", crumbs: [], deeper: false };
  return {
    kind: place.tentative ? "tentative" : "placed",
    crumbs: place.path.slice(-placeCrumbsShown),
    deeper: place.path.length > placeCrumbsShown
  };
}

/** The type word of a source. */
export const sourceTypeKeys: Readonly<Record<LibraryRow["type"], MessageKey>> = {
  PersonalNote: "libraryTable.types.PersonalNote",
  DailyNote: "libraryTable.types.DailyNote",
  WebArticle: "libraryTable.types.WebArticle",
  Book: "libraryTable.types.Book",
  BookChapter: "libraryTable.types.BookChapter",
  PeriodicalIssue: "libraryTable.types.PeriodicalIssue",
  AcademicPaper: "libraryTable.types.AcademicPaper",
  DocumentSection: "libraryTable.types.DocumentSection",
  StandaloneArticle: "libraryTable.types.StandaloneArticle",
  Video: "libraryTable.types.Video",
  GenericDocument: "libraryTable.types.GenericDocument"
};

/** "Livro · A. Autor, B. Autora": the type, then the authors. */
export function sourceMeta(t: Translator, row: Pick<LibraryRow, "type" | "authors">): string {
  return [t(sourceTypeKeys[row.type]), row.authors.join(", ")].filter(Boolean).join(" · ");
}

// ---------------------------------------------------------------------------
// Dates

const dayStart = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());

/**
 * "hoje, 09:12", "ontem, 22:35", "3 nov" (with the year when it is not this one). Computed from
 * `now` when the view renders; nothing ticks it (D16).
 */
export function formatAdded(t: Translator, iso: string, now: Date): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const days = Math.round((dayStart(now).getTime() - dayStart(date).getTime()) / 86_400_000);
  const time = new Intl.DateTimeFormat(t.locale, { hour: "2-digit", minute: "2-digit" }).format(
    date
  );
  if (days === 0) return t("libraryTable.dates.today", { values: { time } });
  if (days === 1) return t("libraryTable.dates.yesterday", { values: { time } });
  const sameYear = date.getFullYear() === now.getFullYear();
  return new Intl.DateTimeFormat(t.locale, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" })
  })
    .format(date)
    .replace(/ de /g, " ")
    .replace(/\./g, "");
}

// ---------------------------------------------------------------------------
// The state chips and the territory bar

export const stateChips = ["all", "processing", "needsYou", "storedOnly", "failed"] as const;
export type StateChip = (typeof stateChips)[number];

export type LibraryFacets = NonNullable<LibraryRowsResult["facets"]>;

export interface ChipView {
  id: StateChip;
  /** Null while the counts are not read yet. */
  count: number | null;
}

/**
 * The chips of the bar: Todas, Gerando, Precisa de você, Sem notas, and Bloqueadas only while a
 * source is blocked or the chip is the one chosen (the design shows four; a blocked source must
 * stay reachable). Each count ignores its own filter, so a chosen chip keeps its siblings' numbers.
 */
export function chipViews(
  facets: LibraryFacets | null,
  chosen: LibraryRowStatus | undefined
): ChipView[] {
  const count = (chip: StateChip): number | null =>
    facets === null
      ? null
      : chip === "all"
        ? Object.values(facets.statuses).reduce((sum, value) => sum + value, 0)
        : facets.statuses[chip];
  return stateChips
    .map((id): ChipView => ({ id, count: count(id) }))
    .filter(
      (chip) =>
        chip.id !== "failed" || (chip.count !== null && chip.count > 0) || chosen === "failed"
    );
}

export interface TerritoryView {
  /** The root topic's ID; null for the sources with no place. */
  id: string | null;
  title: string;
  count: number;
}

/** The territory bar: each root topic and its count, then "Sem lugar" last; the counts add up. */
export function territoryViews(facets: LibraryFacets | null): TerritoryView[] {
  return (facets?.territories ?? []).map((entry) => ({
    id: entry.topic?.id ?? null,
    title: entry.topic?.title ?? "",
    count: entry.count
  }));
}

/** How many areas show before "Mostrar todas". */
export const territoryShown = 8;

// ---------------------------------------------------------------------------
// The foot

const orderKeys: Readonly<Record<LibrarySort, Readonly<Record<"asc" | "desc", MessageKey>>>> = {
  added: {
    desc: "libraryTable.order.addedDesc",
    asc: "libraryTable.order.addedAsc"
  },
  updated: {
    desc: "libraryTable.order.updatedDesc",
    asc: "libraryTable.order.updatedAsc"
  },
  title: { asc: "libraryTable.order.titleAsc", desc: "libraryTable.order.titleDesc" },
  notes: { desc: "libraryTable.order.notesDesc", asc: "libraryTable.order.notesAsc" },
  status: { asc: "libraryTable.order.statusAsc", desc: "libraryTable.order.statusDesc" }
};

export const orderKey = (sort: ResolvedSort): MessageKey => orderKeys[sort.sort][sort.dir];

// ---------------------------------------------------------------------------
// The Questions tab

export const questionStatusKeys: Readonly<Record<QuestionListItemView["status"], MessageKey>> = {
  running: "libraryTable.questionStatus.running",
  complete: "libraryTable.questionStatus.complete",
  canceled: "libraryTable.questionStatus.canceled",
  failed: "libraryTable.questionStatus.failed"
};

export const questionStatusTones: Readonly<Record<QuestionListItemView["status"], StatusTone>> = {
  running: "running",
  complete: "success",
  canceled: "idle",
  failed: "warning"
};

/** The topic IDs the scopes of these questions name, for one batch of titles. */
export function scopeTopicIds(questions: readonly Pick<QuestionListItemView, "scope">[]): string[] {
  const ids = new Set<string>();
  for (const question of questions)
    if (question.scope.kind === "topic") ids.add(question.scope.topicId);
  return [...ids];
}

/**
 * What a question was asked about: the whole library, a topic by its title (a topic that is gone
 * says so) or a number of sources. `titles` maps a topic ID to its title, or null once it is known
 * to be gone; a topic not looked up yet reads "Um tópico".
 */
export function scopeLabel(
  t: Translator,
  scope: AskScope,
  titles: ReadonlyMap<string, string | null>
): string {
  if (scope.kind === "library") return t("libraryTable.scope.library");
  if (scope.kind === "sources") {
    const count = scope.sourceIds.length;
    return t(count === 1 ? "libraryTable.count.sourcesOne" : "libraryTable.count.sourcesMany", {
      values: { count }
    });
  }
  const title = titles.get(scope.topicId);
  if (title === null) return t("libraryTable.scope.topicGone");
  if (title === undefined) return t("libraryTable.scope.topicPending");
  return t("libraryTable.scope.topic", { values: { title } });
}

// ---------------------------------------------------------------------------
// Keys

export type MoveKey = "up" | "down" | "home" | "end" | "pageUp" | "pageDown";

export type TableAction =
  { type: "move"; key: MoveKey } | { type: "open"; replace: boolean } | { type: "peek" };

/** The part of a KeyboardEvent the table reads. */
export interface TableKeyInput {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
}

const moveKeys: Readonly<Record<string, MoveKey>> = {
  ArrowUp: "up",
  ArrowDown: "down",
  Home: "home",
  End: "end",
  PageUp: "pageUp",
  PageDown: "pageDown"
};

/** Cmd-Y (Ctrl-Y elsewhere), by character: quick-look from anywhere in the Library (A4). */
export function isPeekChord(event: TableKeyInput): boolean {
  return (
    !event.isComposing &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    !event.shiftKey &&
    event.key.toLowerCase() === "y"
  );
}

/**
 * What a key does on the focused table: arrows, Home, End and the page keys move the row, Enter
 * opens it beside (Option-Enter in this panel), Space peeks (outside text fields: the caller
 * checks), Cmd-Y peeks.
 */
export function tableAction(event: TableKeyInput): TableAction | null {
  if (event.isComposing) return null;
  if (isPeekChord(event)) return { type: "peek" };
  if (event.metaKey || event.ctrlKey) return null;
  const move = moveKeys[event.key];
  if (move && !event.altKey && !event.shiftKey) return { type: "move", key: move };
  if (event.key === "Enter" && !event.shiftKey) return { type: "open", replace: event.altKey };
  if ((event.key === " " || event.code === "Space") && !event.altKey && !event.shiftKey)
    return { type: "peek" };
  return null;
}

/** The index a movement key leads to, kept inside the loaded rows. */
export function moveCursor(index: number, count: number, key: MoveKey, page = 8): number {
  if (count <= 0) return -1;
  const last = count - 1;
  const from = index < 0 ? 0 : Math.min(index, last);
  switch (key) {
    case "up":
      return index < 0 ? 0 : Math.max(0, from - 1);
    case "down":
      return index < 0 ? 0 : Math.min(last, from + 1);
    case "home":
      return 0;
    case "end":
      return last;
    case "pageUp":
      return Math.max(0, from - page);
    case "pageDown":
      return Math.min(last, from + page);
  }
}

/** "/" focuses the filter, by physical key (design record §12: ABNT2 and US-International). */
export function isFilterKey(event: TableKeyInput): boolean {
  return (
    !event.isComposing &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey &&
    (event.code === "Slash" || event.key === "/")
  );
}

// ---------------------------------------------------------------------------
// The window

/**
 * The rows `RowWindow` says are in view, given in its 28 px units, as indexes of rows `rowHeight`
 * tall: the first row is rounded down and the end up, so a row that is partly in view is drawn.
 */
export function viewportInRows(
  viewport: { first: number; end: number },
  unit: number,
  rowHeight: number,
  count: number
): { first: number; end: number } {
  return {
    first: Math.min(count, Math.floor((viewport.first * unit) / rowHeight)),
    end: Math.min(count, Math.ceil((viewport.end * unit) / rowHeight))
  };
}

/** The table needs its next page: the window is near the end of the rows it has. */
export function needsNextPage(input: {
  windowEnd: number;
  count: number;
  hasMore: boolean;
  busy: boolean;
  failed: boolean;
}): boolean {
  return (
    input.hasMore &&
    !input.busy &&
    !input.failed &&
    input.windowEnd >= input.count - libraryPaging.nearEnd
  );
}
