import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type Ref
} from "react";
import { parseObjectAddress } from "@app/domain";
import type { Translator } from "@app/i18n";

import { Button } from "../../../components/ui/button";
import { EmptyState } from "../../../components/ui/empty-state";
import { ErrorState } from "../../../components/ui/error-state";
import { ObjectKindGlyph, objectKindTextClass } from "../../../components/glyphs";
import { Kbd } from "../../../components/ui/kbd";
import { LoadingState, Skeleton } from "../../../components/ui/skeleton";
import { cn } from "../../../lib/cn";
import type { LibraryRow } from "../../../../shared/ipc-library";
import type { QuestionListItemView } from "../../../../shared/ipc-questions";
import { tierFor } from "../../layout-config";
import type { PanelLoadState } from "../../PanelFrame";
import type { PanelProps } from "../../PanelStack";
import { parseViewAddress, type LibraryQuery, type LibraryTab } from "../../route";
import type { Density } from "../../state";
import { useViewportWidth } from "../../use-workspace";
import {
  FilterField,
  LibraryFoot,
  LibraryHeader,
  StateChips,
  TerritoryBar,
  questionsCount,
  sourcesCount
} from "./LibraryBars";
import { LibraryGrid, RowSkeleton, type GridColumn } from "./LibraryGrid";
import { LibraryList, questionAddress, sourceAddress } from "./LibraryList";
import { LibraryPeek, libraryPeekSurface, peekFrameState } from "./LibraryPeek";
import type { RibbonPlace } from "../../PathRibbon";
import { QuestionsTable } from "./LibraryQuestions";
import { DateCell, NotesCell, PlaceCell, SourceTitleCell, StateCell } from "./library-cells";
import {
  isFilterKey,
  isFiltered,
  isPeekChord,
  resolvedSort,
  rowHeights,
  scopeLabel,
  sourceMeta,
  titleListRowHeight,
  toggleSort,
  withoutField,
  type LibraryFacets
} from "./library-model";
import type { LibrarySort } from "../../../../shared/ipc-library";
import {
  useLibraryQuestions,
  useLibrarySources,
  usePeekObject,
  useScopeTitles,
  type PagedData
} from "./use-library-data";

/**
 * The Library destination's root (design record §7.3; spec T149): a header with the Fontes and
 * Perguntas tabs and the density toggle, the filter bar and the territory bar, the virtualized
 * table, and a foot with the keys. It is the root surface of the Library's stack, so it draws its
 * own frame (`data-surface`, `data-state`) and takes the stack's `mode`: `full` is the table, and
 * `compact` (the previous panel, once a Source is open beside it) is its list of titles with the
 * open row marked. In a window below 1180 px the table drops Adicionada and Notas (Estado and Fonte
 * never drop, and the page never scrolls sideways).
 *
 * `LibraryRoot` holds the person's choices and reads the data; `LibraryView` draws them, so each
 * state is tested without a screen.
 */

export const librarySurface = "destination-library";

export interface LibraryRootProps extends PanelProps {
  /**
   * Screens only: opens the sheet on the first row and draws it in place instead of in a portal, so
   * a capture shows it; the frame then reports `library-peek`.
   */
  preview?: "peek";
  /** The Library header's density, kept per device in `memora.workspace.v1`. */
  density?: Density;
  onDensity?: (density: Density) => void;
  /** The shell's Add command (Cmd-N): the empty Library offers it as its one action. */
  onAdd?: () => void;
  /** Screens only: what the frame reports as `data-surface` (the Library's other captures). */
  surfaceId?: string;
}

/** The column set of the Fontes table: Notas and Adicionada drop in the compact tier. */
export function sourceColumns(t: Translator, compact: boolean): GridColumn[] {
  const columns: GridColumn[] = [
    {
      id: "title",
      label: t("libraryTable.columns.source"),
      track: compact ? "minmax(0,1.05fr)" : "minmax(0,1.5fr)",
      sortable: true
    },
    {
      id: "place",
      label: t("libraryTable.columns.place"),
      track: compact ? "minmax(0,1fr)" : "minmax(0,1.2fr)"
    }
  ];
  if (!compact)
    columns.push({
      id: "notes",
      label: t("libraryTable.columns.notes"),
      track: "72px",
      align: "end",
      sortable: true
    });
  columns.push({
    id: "status",
    label: t("libraryTable.columns.state"),
    track: "196px",
    sortable: true
  });
  if (!compact)
    columns.push({
      id: "added",
      label: t("libraryTable.columns.added"),
      track: "168px",
      sortable: true
    });
  return columns;
}

export function questionColumns(t: Translator, compact: boolean): GridColumn[] {
  const columns: GridColumn[] = [
    { id: "text", label: t("libraryTable.columns.question"), track: "minmax(0,1fr)" }
  ];
  if (!compact)
    columns.push({
      id: "answers",
      label: t("libraryTable.columns.answers"),
      track: "96px",
      align: "end"
    });
  columns.push({ id: "status", label: t("libraryTable.columns.state"), track: "172px" });
  if (!compact)
    columns.push({ id: "asked", label: t("libraryTable.columns.asked"), track: "168px" });
  return columns;
}

/** The state the frame reports: what the active tab's first read says. */
export function libraryState(data: {
  status: "loading" | "ready" | "error";
  items: readonly unknown[];
}): PanelLoadState {
  if (data.status === "error") return "error";
  if (data.status === "loading") return "loading";
  return data.items.length === 0 ? "empty" : "success";
}

const isEditable = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

// ---------------------------------------------------------------------------
// The body's loading states

/** Eight rows in the shape of the table while the first page is read; no wider than the table. */
function TableSkeleton({
  t,
  columns,
  density
}: {
  t: Translator;
  columns: readonly GridColumn[];
  density: Density;
}) {
  const tracks = columns.map((column) => column.track).join(" ");
  return (
    <LoadingState t={t} className="gap-0">
      <div className="border-t border-border">
        {Array.from({ length: 8 }, (_, index) => (
          <div
            key={index}
            style={{ gridTemplateColumns: tracks, height: rowHeights[density] }}
            className="grid items-start border-b border-border px-4 pt-3"
          >
            {columns.map((column, at) => (
              <div key={column.id} className={cn("min-w-0", at === 0 ? "pr-4" : "px-4")}>
                <RowSkeleton wide={at === 0 && index % 2 === 0} />
              </div>
            ))}
          </div>
        ))}
      </div>
    </LoadingState>
  );
}

/** The previous panel's rows are one line each: one bar per row, at the list's row height. */
function ListSkeleton({ t }: { t: Translator }) {
  return (
    <LoadingState t={t} className="gap-0 px-4 pt-1">
      {Array.from({ length: 8 }, (_, index) => (
        <div
          key={index}
          style={{ height: titleListRowHeight }}
          className="flex items-center border-b border-border"
        >
          <Skeleton className={cn("h-3.5", index % 2 === 0 ? "w-3/5" : "w-2/5")} />
        </div>
      ))}
    </LoadingState>
  );
}

// ---------------------------------------------------------------------------
// The view

type Row = LibraryRow | QuestionListItemView;

export interface LibraryViewProps {
  t: Translator;
  mode: "full" | "compact";
  /** The window is in the compact tier (below 1180 px): the table drops two columns. */
  compactTier: boolean;
  tab: LibraryTab;
  query: LibraryQuery;
  questionText: string;
  density: Density;
  sources: PagedData<LibraryRow, LibraryFacets>;
  questions: PagedData<QuestionListItemView, never>;
  titles: ReadonlyMap<string, string | null>;
  /** The key of the row the cursor is on. */
  selected: string | null;
  peeking: boolean;
  /** The territory bar shows every area, not the first few. */
  expanded: boolean;
  /** The open Source or Question beside the table, for the compact list. */
  currentKey: string | null;
  now: Date;
  panelId: string;
  inputRef?: Ref<HTMLInputElement>;
  onTab: (tab: LibraryTab) => void;
  onQuery: (change: (query: LibraryQuery) => LibraryQuery) => void;
  onQuestionText: (text: string) => void;
  onDensity: (density: Density) => void;
  onSelect: (key: string) => void;
  /** Space or Cmd-Y on a row: open the sheet, or close it. */
  onPeek: (key: string) => void;
  onClosePeek: () => void;
  onExpand: (expanded: boolean) => void;
  onOpen: (address: string) => void;
  onKeyDown?: (event: KeyboardEvent<HTMLElement>) => void;
  /** The shell's Add command; the empty Library offers it. */
  onAdd?: () => void;
  /** What the frame reports as `data-surface`. */
  surfaceId?: string;
  /** Draw the sheet in place instead of in a portal (the screens tool). */
  peekPortal?: boolean;
}

export function LibraryView(props: LibraryViewProps) {
  const {
    t,
    mode,
    compactTier,
    tab,
    query,
    questionText,
    density,
    sources,
    questions,
    titles,
    selected,
    peeking,
    expanded,
    currentKey,
    now,
    panelId,
    inputRef,
    onTab,
    onQuery,
    onQuestionText,
    onDensity,
    onSelect,
    onPeek,
    onClosePeek,
    onExpand,
    onOpen,
    onKeyDown,
    onAdd,
    surfaceId = librarySurface,
    peekPortal
  } = props;
  const onSources = tab === "sources";
  const data = onSources ? sources : questions;
  const state = libraryState(data.state);
  const sort = resolvedSort(query);
  const filtered = onSources ? isFiltered(query) : questionText.trim() !== "";
  const total = data.state.total;
  const count = total === null ? "" : onSources ? sourcesCount(t, total) : questionsCount(t, total);
  // Nothing to count, filter or sort: the empty Library is the sentence and its action.
  const bare = state === "empty" && !filtered;
  const addressOf = (id: string) => (onSources ? sourceAddress(id) : questionAddress(id));
  const openRow = (row: Row) => onOpen(addressOf(row.id));
  const retry = data.retry;
  const errorMessage = t(
    onSources ? "libraryTable.states.sourcesError" : "libraryTable.states.questionsError"
  );
  const keptMessage = t(
    onSources ? "libraryTable.states.sourcesKept" : "libraryTable.states.questionsKept"
  );
  const peekRow = peeking
    ? (data.state.items as readonly Row[]).find((row) => row.id === selected)
    : undefined;

  // What the sheet shows of the row it looks at, and how that row is placed: a source whose place
  // is only likely, or a question still being answered, is never drawn as placed (design record §9).
  const peekInfo = (row: Row | undefined): { title: string; meta: string; place: RibbonPlace } => {
    if (!row) return { title: "", meta: "", place: "placed" };
    return "text" in row
      ? {
          title: row.text,
          meta: [t("objects.kinds.question"), scopeLabel(t, row.scope, titles)].join(" · "),
          place: row.status === "running" ? "tentativeQuestion" : "placed"
        }
      : {
          title: row.title,
          meta: [t("objects.kinds.source"), sourceMeta(t, row)].join(" · "),
          place: row.place?.tentative ? "tentativeSource" : "placed"
        };
  };
  const peek = peekInfo(peekRow);
  const peekAddress = peekRow ? addressOf(peekRow.id) : null;
  const { object: peekObject, retry: retryPeek } = usePeekObject(peekAddress);
  // The screens tool's capture of the sheet reports the sheet's own read, once the rows are there.
  const frameState =
    surfaceId === libraryPeekSurface && state !== "error"
      ? peekRow
        ? peekFrameState(peekObject)
        : undefined
      : state;

  const gridCommon = {
    t,
    density,
    selectedKey: selected,
    onSelect,
    onOpen: openRow,
    onPeek
  };

  // --- The compact form: the title list of the previous panel -----------------------------------
  if (mode === "compact") {
    const list = (
      <LibraryList
        t={t}
        tab={tab}
        sources={sources}
        questions={questions}
        density={density}
        selected={selected}
        currentKey={currentKey}
        onSelect={onSelect}
        onPeek={onPeek}
        onOpen={onOpen}
      />
    );
    return (
      <section
        data-surface={surfaceId}
        data-state={frameState}
        data-mode="compact"
        aria-label={t("libraryTable.title")}
        {...(onKeyDown ? { onKeyDown } : {})}
        className="flex h-full min-h-0 flex-col bg-background"
      >
        <header className="flex-none px-4 pt-4 pb-2">
          <h2 className="m-0 font-reading text-lg font-semibold">{t("libraryTable.title")}</h2>
          {count === "" || state === "empty" ? null : (
            <p className="m-0 text-xs text-muted-foreground">{count}</p>
          )}
        </header>
        {state === "loading" ? (
          <ListSkeleton t={t} />
        ) : state === "error" ? (
          <div className="px-4">
            <ErrorState
              t={t}
              message={errorMessage}
              kept={keptMessage}
              retryLabel={t("shell.actions.retry")}
              onRetry={retry}
            />
          </div>
        ) : state === "empty" ? (
          <div className="px-4">
            <EmptyState
              variant="compact"
              headline={t(
                onSources
                  ? "libraryTable.states.sourcesEmpty"
                  : "libraryTable.states.questionsEmpty"
              )}
            />
          </div>
        ) : (
          list
        )}
        <LibraryPeek
          t={t}
          address={peekAddress}
          object={peekObject}
          title={peek.title}
          meta={peek.meta}
          place={peek.place}
          onClose={onClosePeek}
          onRetry={retryPeek}
          onOpen={onOpen}
          {...(peekPortal === undefined ? {} : { portal: peekPortal })}
        />
      </section>
    );
  }

  // --- The table ----------------------------------------------------------------------------------
  const columns = onSources ? sourceColumns(t, compactTier) : questionColumns(t, compactTier);
  const sortedBy = { id: sort.sort === "updated" ? "added" : sort.sort, dir: sort.dir };
  const emptyBody = filtered ? (
    <EmptyState
      className="max-w-xl"
      headline={t(
        onSources ? "libraryTable.states.sourcesFiltered" : "libraryTable.states.questionsFiltered"
      )}
      action={
        <Button
          onClick={() =>
            onSources
              ? onQuery((now_) =>
                  withoutField(withoutField(withoutField(now_, "text"), "status"), "topic")
                )
              : onQuestionText("")
          }
        >
          {t("libraryTable.filter.clearAll")}
        </Button>
      }
    />
  ) : onSources ? (
    <EmptyState
      variant="page"
      className="max-w-xl bg-surface"
      icon={<ObjectKindGlyph kind="source" size={20} className={objectKindTextClass.source} />}
      headline={t("libraryTable.states.sourcesEmpty")}
      action={
        <>
          {onAdd ? (
            <Button variant="primary" onClick={onAdd}>
              {t("libraryTable.actions.chooseFile")}
            </Button>
          ) : null}
          <span className="inline-flex flex-wrap items-center gap-1.5 text-sm text-secondary-foreground">
            {t("libraryTable.states.sourcesEmptyHint")} <Kbd>⌘N</Kbd>
          </span>
        </>
      }
    >
      <p className="m-0">{t("libraryTable.states.sourcesEmptyBody")}</p>
      <p className="m-0 mt-3 font-semibold text-foreground">
        {t("libraryTable.states.sourcesEmptyDrop")}
      </p>
    </EmptyState>
  ) : (
    <EmptyState
      variant="page"
      className="max-w-xl bg-surface"
      icon={<ObjectKindGlyph kind="question" size={20} className={objectKindTextClass.question} />}
      headline={t("libraryTable.states.questionsEmpty")}
    >
      <p className="m-0">{t("libraryTable.states.questionsEmptyBody")}</p>
      <p className="m-0 mt-3 inline-flex items-center gap-1.5 whitespace-nowrap">
        {t("libraryTable.states.questionsEmptyShortcut")} <Kbd>⌘K</Kbd>
      </p>
    </EmptyState>
  );

  return (
    <section
      data-surface={surfaceId}
      data-state={frameState}
      data-mode="full"
      aria-label={t("libraryTable.title")}
      {...(onKeyDown ? { onKeyDown } : {})}
      className="flex h-full min-h-0 flex-col bg-background"
    >
      <LibraryHeader
        t={t}
        tab={tab}
        onTab={onTab}
        panelId={panelId}
        count={bare ? "" : count}
        density={density}
        onDensity={onDensity}
      />
      <div id={panelId} role="tabpanel" className="flex min-h-0 flex-1 flex-col">
        {bare ? null : (
          <div className="flex flex-none flex-wrap items-center gap-x-3 gap-y-2 px-8 pb-3">
            <FilterField
              t={t}
              value={onSources ? (query.text ?? "") : questionText}
              onChange={(text) =>
                onSources
                  ? onQuery((now_) => (text ? { ...now_, text } : withoutField(now_, "text")))
                  : onQuestionText(text)
              }
              label={t(
                onSources
                  ? "libraryTable.filter.sourcesLabel"
                  : "libraryTable.filter.questionsLabel"
              )}
              placeholder={t(
                onSources
                  ? "libraryTable.filter.sourcesPlaceholder"
                  : "libraryTable.filter.questionsPlaceholder"
              )}
              disabled={state === "error"}
              {...(inputRef ? { inputRef } : {})}
            />
            {onSources ? (
              <div
                inert={state === "error"}
                className={cn("max-w-full", state === "error" && "opacity-60")}
              >
                <StateChips
                  t={t}
                  facets={sources.state.facets}
                  status={query.status}
                  onStatus={(status) =>
                    onQuery((now_) => (status ? { ...now_, status } : withoutField(now_, "status")))
                  }
                />
              </div>
            ) : null}
          </div>
        )}
        {onSources && !bare ? (
          <TerritoryBar
            t={t}
            facets={sources.state.facets}
            loading={state === "loading"}
            topic={query.topic}
            onTopic={(topic) =>
              onQuery((now_) => (topic ? { ...now_, topic } : withoutField(now_, "topic")))
            }
            expanded={expanded}
            onExpand={onExpand}
          />
        ) : null}

        {state === "loading" ? (
          <TableSkeleton t={t} columns={columns} density={density} />
        ) : state === "error" ? (
          <div className="px-8 pt-1">
            <ErrorState
              t={t}
              className="max-w-xl"
              message={errorMessage}
              kept={keptMessage}
              retryLabel={t("shell.actions.retry")}
              onRetry={retry}
            />
          </div>
        ) : state === "empty" ? (
          <div className="px-8 pt-1">{emptyBody}</div>
        ) : onSources ? (
          <LibraryGrid<LibraryRow>
            {...gridCommon}
            label={t("libraryTable.tabs.sources")}
            columns={columns}
            items={sources.state.items}
            itemKey={(row) => row.id}
            renderCell={(column, row, cell) => {
              switch (column.id) {
                case "title":
                  return <SourceTitleCell t={t} row={row} cell={cell} />;
                case "place":
                  return <PlaceCell t={t} row={row} />;
                case "notes":
                  return <NotesCell count={row.noteCount} />;
                case "status":
                  return <StateCell t={t} row={row} onGenerate={() => openRow(row)} />;
                default:
                  return <DateCell t={t} iso={row.addedAt} now={now} />;
              }
            }}
            sort={sortedBy}
            onSort={(id) => onQuery((now_) => toggleSort(now_, id as LibrarySort))}
            hasMore={sources.state.hasMore}
            loadingMore={sources.state.loadingMore}
            moreFailed={sources.state.moreFailed}
            onMore={sources.more}
            onRetryMore={sources.retry}
            stale={sources.state.stale}
            skeleton={<RowSkeleton />}
          />
        ) : (
          <QuestionsTable
            t={t}
            columns={columns}
            questions={questions}
            titles={titles}
            density={density}
            selected={selected}
            now={now}
            onSelect={onSelect}
            onPeek={onPeek}
            onOpen={openRow}
          />
        )}
      </div>
      {state === "success" ? (
        <LibraryFoot t={t} count={count} sort={onSources ? sort : null} />
      ) : null}
      <LibraryPeek
        t={t}
        address={peekAddress}
        object={peekObject}
        title={peek.title}
        meta={peek.meta}
        place={peek.place}
        onClose={onClosePeek}
        onRetry={retryPeek}
        onOpen={onOpen}
        {...(peekPortal === undefined ? {} : { portal: peekPortal })}
      />
    </section>
  );
}

// ---------------------------------------------------------------------------
// The root

export function LibraryRoot({
  t,
  address,
  mode,
  active,
  onState,
  onOpen,
  current,
  density: densityProp,
  onDensity: onDensityProp,
  onAdd,
  surfaceId,
  preview
}: LibraryRootProps) {
  const view = parseViewAddress(address);
  const fromAddress = view?.view === "library" ? view : { view: "library" as const };
  const [tab, setTab] = useState<LibraryTab>(fromAddress.tab ?? "sources");
  const [query, setQuery] = useState<LibraryQuery>(fromAddress.query ?? {});
  const [questionText, setQuestionText] = useState("");
  const [seen, setSeen] = useState(address);
  // A new root address (a deep link that redirected this root) starts the view from it.
  if (seen !== address) {
    setSeen(address);
    setTab(fromAddress.tab ?? "sources");
    setQuery(fromAddress.query ?? {});
  }
  const [densityLocal, setDensityLocal] = useState<Density>("comfortable");
  const [selected, setSelected] = useState<string | null>(null);
  const [peeking, setPeeking] = useState(preview === "peek");
  const [expanded, setExpanded] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const panelId = useId();

  const compactTier = tierFor(useViewportWidth()).name === "compact";
  const sources = useLibrarySources(query, active && tab === "sources");
  const questions = useLibraryQuestions(questionText, active && tab === "questions");
  const titles = useScopeTitles(questions.state.items, active && tab === "questions");
  const data = tab === "sources" ? sources.state : questions.state;
  const state = libraryState(data);

  useEffect(() => {
    onState(state);
  }, [state, onState]);

  // The sheet closes with the row it was on.
  const rows = data.items as readonly Row[];
  const selectedRow = useMemo(
    () =>
      rows.find((row) => row.id === selected) ??
      (preview === "peek" && selected === null ? rows[0] : undefined),
    [rows, selected, preview]
  );

  const onTab = useCallback((next: LibraryTab) => {
    setTab(next);
    setPeeking(false);
    setSelected(null);
  }, []);
  const onPeek = useCallback((key: string) => {
    setSelected(key);
    setPeeking((value) => !value);
  }, []);

  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    if (event.defaultPrevented) return;
    if (isPeekChord(event.nativeEvent)) {
      event.preventDefault();
      const first = rows[0];
      if (peeking) setPeeking(false);
      else if (selectedRow || first) {
        if (!selectedRow && first) setSelected(first.id);
        setPeeking(true);
      }
      return;
    }
    if (isFilterKey(event.nativeEvent) && !isEditable(event.target)) {
      event.preventDefault();
      input.current?.focus();
    }
  };

  return (
    <LibraryView
      t={t}
      mode={mode}
      compactTier={compactTier}
      tab={tab}
      query={query}
      questionText={questionText}
      density={densityProp ?? densityLocal}
      sources={sources}
      questions={questions}
      titles={titles}
      selected={selectedRow?.id ?? selected}
      peeking={peeking && selectedRow !== undefined}
      surfaceId={surfaceId ?? (preview === "peek" ? libraryPeekSurface : librarySurface)}
      {...(onAdd ? { onAdd } : {})}
      {...(preview === "peek" ? { peekPortal: false } : {})}
      expanded={expanded}
      currentKey={current ? (parseObjectAddress(current)?.id ?? null) : null}
      now={new Date()}
      panelId={panelId}
      inputRef={input}
      onTab={onTab}
      onQuery={setQuery}
      onQuestionText={setQuestionText}
      onDensity={onDensityProp ?? setDensityLocal}
      onSelect={setSelected}
      onPeek={onPeek}
      onClosePeek={() => setPeeking(false)}
      onExpand={setExpanded}
      onOpen={onOpen}
      onKeyDown={onKeyDown}
    />
  );
}
