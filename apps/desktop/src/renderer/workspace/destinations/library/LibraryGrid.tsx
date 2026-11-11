import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode
} from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import type { Translator } from "@app/i18n";

import { Button } from "../../../components/ui/button";
import { Skeleton } from "../../../components/ui/skeleton";
import { useRowWindow } from "../../../components/topics/row-window";
import { navRowHeight, windowIndexes } from "../../../components/topics/topic-navigation";
import { cn } from "../../../lib/cn";
import type { Density } from "../../state";
import {
  headerHeight,
  moveCursor,
  needsNextPage,
  rowHeights,
  tableAction,
  titleListRowHeight,
  viewportInRows
} from "./library-model";

/**
 * The Library's rows as a grid (design record §7.3): a sticky header of sort buttons, rows of
 * fixed height that only exist while they are near the window (`RowWindow`, as the navigator's
 * tree), one roving tab stop, and the keys of `tableAction`. The Fontes and Perguntas tables are
 * two column sets of it, and the compact form of the Library (its title list, as the previous
 * panel) is its "list" variant with no header. The grid knows nothing of what a row holds:
 * `renderCell` draws it.
 */

export interface GridColumn {
  id: string;
  label: string;
  /** The CSS grid track: `minmax(0,1.4fr)`, `64px`. */
  track: string;
  align?: "end";
  sortable?: boolean;
}

export interface LibraryGridProps<Item> {
  t: Translator;
  /** The table's accessible name. */
  label: string;
  variant?: "table" | "list";
  columns: readonly GridColumn[];
  density: Density;
  items: readonly Item[];
  itemKey: (item: Item) => string;
  renderCell: (column: GridColumn, item: Item, state: { focused: boolean }) => ReactNode;
  /** The key of the row the cursor is on (the roving tab stop). */
  selectedKey: string | null;
  /** The row whose object is open beside the table (`aria-current`), for the list. */
  currentKey?: string | null;
  onSelect: (key: string) => void;
  /** Enter or a click: open beside; `replace` is Option-Enter. */
  onOpen: (item: Item, options: { replace: boolean }) => void;
  /** Space or Cmd-Y on the row. */
  onPeek: (key: string) => void;
  /** The sorted column; absent for a grid whose order is fixed. */
  sort?: { id: string; dir: "asc" | "desc" } | null;
  onSort?: (columnId: string) => void;
  hasMore: boolean;
  loadingMore: boolean;
  moreFailed: boolean;
  onMore: () => void;
  onRetryMore: () => void;
  /** The rows are the previous query's while the new one is read. */
  stale?: boolean;
  /** Draws a row's skeleton while its page loads (the shape of the real row). */
  skeleton?: ReactNode;
}

const tabStopOf = <Item,>(
  items: readonly Item[],
  itemKey: (item: Item) => string,
  selected: string | null
): number => {
  if (items.length === 0) return -1;
  const at = selected === null ? -1 : items.findIndex((item) => itemKey(item) === selected);
  return at === -1 ? 0 : at;
};

export function LibraryGrid<Item>({
  t,
  label,
  variant = "table",
  columns,
  density,
  items,
  itemKey,
  renderCell,
  selectedKey,
  currentKey = null,
  onSelect,
  onOpen,
  onPeek,
  sort = null,
  onSort,
  hasMore,
  loadingMore,
  moreFailed,
  onMore,
  onRetryMore,
  stale = false,
  skeleton
}: LibraryGridProps<Item>) {
  const list = variant === "list";
  const rowHeight = list ? titleListRowHeight : rowHeights[density];
  const { rows, viewport, attach } = useRowWindow(true);
  const scroller = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const focusAfter = useRef<string | null>(null);
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const count = items.length;
  const tabStop = tabStopOf(items, itemKey, selectedKey);
  const inView = viewportInRows(viewport, navRowHeight, rowHeight, count);
  const indexes = windowIndexes(count, inView, 6, [tabStop]);
  const tracks = columns.map((column) => column.track).join(" ");
  const tail = loadingMore ? 2 : moreFailed ? 1 : 0;
  const gridStyle = { gridTemplateColumns: tracks };

  // The next page, when the window nears the end of the rows that are loaded.
  useEffect(() => {
    if (
      needsNextPage({
        windowEnd: inView.end,
        count,
        hasMore,
        busy: loadingMore,
        failed: moreFailed
      })
    )
      onMore();
  }, [inView.end, count, hasMore, loadingMore, moreFailed, onMore]);

  // A key that moved the cursor leaves the focus on the new row once it is drawn.
  useLayoutEffect(() => {
    const key = focusAfter.current;
    if (key === null) return;
    const node = rows.find(key);
    if (node) {
      focusAfter.current = null;
      node.focus({ preventScroll: true });
    }
  });

  /** Scrolls so the row is in view, clear of the sticky header. */
  const reveal = (index: number) => {
    const box = scroller.current;
    const rowsNode = body.current;
    if (!box || !rowsNode) return;
    const top =
      rowsNode.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop;
    const rowTop = top + index * rowHeight;
    const covered = list ? 0 : headerHeight;
    if (rowTop - covered < box.scrollTop) box.scrollTop = Math.max(0, rowTop - covered);
    else if (rowTop + rowHeight > box.scrollTop + box.clientHeight)
      box.scrollTop = rowTop + rowHeight - box.clientHeight;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target;
    // Only the row itself answers: a button or a field inside it keeps its own keys.
    const onRow = target instanceof HTMLElement && target.hasAttribute("data-nav-key");
    if (!onRow || count === 0) return;
    const action = tableAction(event.nativeEvent);
    if (!action) return;
    const current = tabStopOf(items, itemKey, selectedKey);
    if (action.type === "move") {
      event.preventDefault();
      const next = moveCursor(current, count, action.key);
      const item = items[next];
      if (!item) return;
      const key = itemKey(item);
      focusAfter.current = key;
      onSelect(key);
      reveal(next);
    } else if (action.type === "open") {
      event.preventDefault();
      const item = items[current];
      if (item) onOpen(item, { replace: action.replace });
    } else {
      event.preventDefault();
      const item = items[current];
      if (item) onPeek(itemKey(item));
    }
  };

  const sortFor = (column: GridColumn): "ascending" | "descending" | undefined =>
    sort && sort.id === column.id ? (sort.dir === "asc" ? "ascending" : "descending") : undefined;

  return (
    <div
      ref={scroller}
      role="grid"
      aria-label={label}
      aria-rowcount={count + (list ? 0 : 1)}
      aria-colcount={columns.length}
      aria-busy={stale ? true : undefined}
      data-density={density}
      data-variant={variant}
      onKeyDown={onKeyDown}
      className={cn(
        "relative min-h-0 flex-1 overflow-auto [scrollbar-gutter:stable]",
        list ? "pb-2" : "border-t border-border"
      )}
    >
      {list ? null : (
        <div
          role="row"
          aria-rowindex={1}
          style={{ ...gridStyle, height: headerHeight }}
          className="sticky top-0 z-[1] grid items-center border-b border-border bg-background px-4 text-xs font-semibold text-secondary-foreground"
        >
          {columns.map((column, index) => {
            const sorted = sortFor(column);
            const alignEnd = column.align === "end";
            return (
              <div
                key={column.id}
                role="columnheader"
                aria-colindex={index + 1}
                aria-sort={sorted}
                className={cn(
                  "flex min-w-0",
                  index === 0 ? "pr-4" : "px-4",
                  alignEnd && "justify-end"
                )}
              >
                {column.sortable && onSort ? (
                  <button
                    type="button"
                    onClick={() => onSort(column.id)}
                    className={cn(
                      "-mx-1.5 inline-flex h-6 min-w-0 items-center gap-1 rounded-md px-1.5 whitespace-nowrap",
                      "hover:bg-surface-hover focus-visible:outline-2 focus-visible:outline-offset-[-2px]",
                      "focus-visible:outline-accent",
                      sorted ? "text-foreground" : "text-secondary-foreground"
                    )}
                  >
                    {column.label}
                    {sorted === "ascending" ? (
                      <ArrowUp aria-hidden="true" className="size-3 shrink-0" />
                    ) : sorted === "descending" ? (
                      <ArrowDown aria-hidden="true" className="size-3 shrink-0" />
                    ) : null}
                  </button>
                ) : (
                  <span className="inline-flex h-6 items-center gap-1 whitespace-nowrap">
                    {column.label}
                    {sorted ? (
                      sorted === "ascending" ? (
                        <ArrowUp aria-hidden="true" className="size-3 shrink-0" />
                      ) : (
                        <ArrowDown aria-hidden="true" className="size-3 shrink-0" />
                      )
                    ) : null}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}
      <div
        ref={(node) => {
          body.current = node;
          attach(node);
        }}
        role="rowgroup"
        className={cn("relative", stale && "opacity-60 transition-opacity")}
        style={{ height: (count + tail) * rowHeight }}
      >
        {indexes.map((index) => {
          const item = items[index] as Item;
          const key = itemKey(item);
          const selected = index === tabStop && selectedKey !== null;
          const current = currentKey !== null && key === currentKey;
          const marked = selected || current;
          return (
            <div
              key={key}
              role="row"
              data-nav-key={key}
              aria-rowindex={index + (list ? 1 : 2)}
              aria-selected={selected}
              aria-current={current ? "true" : undefined}
              tabIndex={index === tabStop ? 0 : -1}
              onFocus={() => {
                setFocusedKey(key);
                onSelect(key);
              }}
              onBlur={(event) => {
                // Focus moving to a control inside the row keeps the row focused.
                if (!event.currentTarget.contains(event.relatedTarget as Node | null))
                  setFocusedKey((now) => (now === key ? null : now));
              }}
              onClick={() => onOpen(item, { replace: false })}
              style={{ ...gridStyle, top: index * rowHeight, height: rowHeight }}
              className={cn(
                "absolute inset-x-0 grid cursor-pointer border-b border-border px-4 outline-none",
                "focus-visible:[box-shadow:inset_0_0_0_2px_var(--accent)]",
                list
                  ? "items-center"
                  : density === "compact"
                    ? "items-start pt-2"
                    : "items-start pt-3",
                marked
                  ? "bg-surface-selected [box-shadow:inset_2px_0_0_var(--accent)]"
                  : "hover:bg-surface-hover"
              )}
            >
              {columns.map((column, at) => (
                <div
                  key={column.id}
                  role="gridcell"
                  aria-colindex={at + 1}
                  className={cn(
                    "min-w-0",
                    at === 0 ? "pr-4" : "px-4",
                    column.align === "end" && "text-right tabular-nums"
                  )}
                >
                  {renderCell(column, item, { focused: focusedKey === key })}
                </div>
              ))}
            </div>
          );
        })}
        {loadingMore && skeleton
          ? [0, 1].map((offset) => (
              <div
                key={`more-${offset}`}
                aria-hidden="true"
                style={{ top: (count + offset) * rowHeight, height: rowHeight }}
                className="absolute inset-x-0 border-b border-border px-4 pt-3"
              >
                {skeleton}
              </div>
            ))
          : null}
        {moreFailed ? (
          <div
            style={{ top: count * rowHeight, height: rowHeight }}
            className="absolute inset-x-0 flex items-center gap-3 px-4 text-sm text-secondary-foreground"
          >
            <span className="min-w-0 [text-wrap:pretty]">{t("libraryTable.states.moreError")}</span>
            <Button variant="link" onClick={onRetryMore}>
              {t("shell.actions.retry")}
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

/** A skeleton row in the shape of a source or a question row: a title bar and a shorter meta bar. */
export function RowSkeleton({ wide = false }: { wide?: boolean }) {
  return (
    <div className="grid gap-2">
      <Skeleton className={cn("h-3.5", wide ? "w-3/5" : "w-2/5")} />
      <Skeleton className="h-3 w-1/4" />
    </div>
  );
}
