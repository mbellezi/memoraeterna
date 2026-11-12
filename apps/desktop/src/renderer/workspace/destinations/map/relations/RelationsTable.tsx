import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode
} from "react";
import type { Translator } from "@app/i18n";

import { cn } from "../../../../lib/cn";
import { RelationStanceLabel } from "../../../../components/RelationStanceLabel";
import { Button } from "../../../../components/ui/button";
import { Kbd } from "../../../../components/ui/kbd";
import type { BranchCursorItem, BranchModel } from "./branch-model";
import { GroupLinks, OutsideTopics, type BranchChoose } from "./lens-controls";
import {
  buildRelationRows,
  moveRow,
  revealWithin,
  selectionFromRow,
  tabStopRow,
  tableSync,
  tablePageSize,
  visibleRowCount,
  type RelationRow
} from "./table-model";

/** The lens with the table alone ("Só tabela"), as the screens tool names it. */
export const tableSurfaceId = "map-relations-table";

/** The height the table shares with the canvas beside it, so the two read as one block. */
export const relationsBlockHeight = "h-[clamp(20rem,58vh,38rem)]";
/** The table never outgrows the canvas beside it, and is no taller than its rows. */
const tableMaxHeight = "max-h-[clamp(20rem,58vh,38rem)]";

const head = "px-3 py-2 text-left text-xs font-semibold text-secondary-foreground";

/** Idle, connected to the selected note, or the selected relation: one class each, never stacked. */
function rowClass(state: "idle" | "connected" | "selected"): string {
  if (state === "selected") return "bg-surface-selected [box-shadow:inset_2px_0_0_0_var(--accent)]";
  if (state === "connected") return "bg-soft [box-shadow:inset_2px_0_0_0_var(--border-strong)]";
  return "hover:bg-soft";
}

export interface RelationsTableProps {
  t: Translator;
  model: BranchModel;
  /** What the canvas has selected (a relation, or a note whose relations the table marks). */
  selected: BranchCursorItem | null;
  onSelect: (item: BranchCursorItem | null) => void;
  onOpenNote: (noteId: string) => void;
  /** The table is the branch's only view: it takes its own height from the page, not the canvas's. */
  alone?: boolean;
}

/**
 * "Mesmas conexões em tabela" (design record 7.5): De, Conexão, Para, one row per relation the canvas
 * draws, wrapping instead of truncating. The selected row is the relation highlighted on the canvas
 * and the other way round: a click or an arrow selects, a note chosen on the canvas marks its rows.
 * One tab stop; arrows, Home, End and the page keys move, Enter opens the first note beside the
 * Map and Shift-Enter the second, Escape clears the choice.
 */
export function RelationsTable({
  t,
  model,
  selected,
  onSelect,
  onOpenNote,
  alone = false
}: RelationsTableProps) {
  const rows = useMemo(() => buildRelationRows(model, t), [model, t]);
  const sync = useMemo(() => tableSync(rows, selected), [rows, selected]);
  const [limit, setLimit] = useState(tablePageSize);
  const shown = visibleRowCount(rows, sync.selectedRowId, limit);
  const box = useRef<HTMLDivElement>(null);
  const nodes = useRef(new Map<string, HTMLTableRowElement>());
  const reveal = (node: HTMLTableRowElement | undefined) => {
    if (!node || !box.current) return;
    revealWithin(box.current, node, box.current.querySelector("thead")?.offsetHeight ?? 0);
  };
  const pendingFocus = useRef<string | null>(null);
  const tabStop = tabStopRow(rows.slice(0, shown), sync.selectedRowId);

  // A key that moved past the page grows it; the focus lands on the new row once it is drawn.
  useLayoutEffect(() => {
    const id = pendingFocus.current;
    if (id === null) return;
    const node = nodes.current.get(id);
    if (!node) return;
    pendingFocus.current = null;
    node.focus({ preventScroll: true });
    reveal(node);
  });

  // A choice made on the canvas is brought into view in the table's own box only: neither the
  // focus nor the page's scroll leaves the canvas.
  useEffect(() => {
    if (sync.revealRowId === null) return;
    reveal(nodes.current.get(sync.revealRowId));
  }, [sync.revealRowId]);

  const onKeyDown = (event: KeyboardEvent<HTMLTableSectionElement>) => {
    const row = (event.target as HTMLElement).closest<HTMLElement>("[data-row-id]");
    if (!row || event.target !== row) return;
    const id = row.dataset.rowId!;
    const at = rows.findIndex((entry) => entry.id === id);
    if (event.key === "Escape" && selected) {
      event.preventDefault();
      event.stopPropagation();
      onSelect(null);
      return;
    }
    if (event.key === "Enter") {
      const entry = rows[at];
      if (!entry) return;
      event.preventDefault();
      onOpenNote(event.shiftKey ? entry.second.id : entry.first.id);
      return;
    }
    const next = moveRow(rows.length, at, event.key);
    if (next === null) return;
    event.preventDefault();
    const target = rows[next];
    if (!target) return;
    if (next >= shown) setLimit(Math.ceil((next + 1) / tablePageSize) * tablePageSize);
    pendingFocus.current = target.id;
    onSelect({ type: "edge", id: target.id });
  };

  const count = rows.length;
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div
        ref={box}
        className={cn(
          // Below 1180 px the page scrolls on past the table (it keeps no wheel to itself, so the lists under it are reached).
          "overflow-auto rounded-lg border border-border bg-surface min-[1180px]:overscroll-contain",
          alone ? "max-h-[max(20rem,50vh)] min-[1180px]:max-h-[max(20rem,70vh)]" : tableMaxHeight
        )}
      >
        <table role="grid" className="w-full table-fixed border-collapse text-sm">
          <caption className="sr-only">{t("mapRelationsTable.caption")}</caption>
          <colgroup>
            <col />
            <col style={{ width: "7.5rem" }} />
            <col />
          </colgroup>
          <thead className="sticky top-0 z-10 bg-soft">
            <tr>
              <th scope="col" className={head}>
                {t("mapRelationsTable.from")}
              </th>
              <th scope="col" className={head}>
                {t("mapRelationsTable.link")}
              </th>
              <th scope="col" className={head}>
                {t("mapRelationsTable.to")}
              </th>
            </tr>
          </thead>
          <tbody onKeyDown={onKeyDown}>
            {rows.slice(0, shown).map((row, index) => (
              <TableRow
                key={row.id}
                t={t}
                row={row}
                state={
                  row.id === sync.selectedRowId
                    ? "selected"
                    : sync.connectedRowIds.has(row.id)
                      ? "connected"
                      : "idle"
                }
                tabbable={index === tabStop}
                register={(node) => {
                  if (node) nodes.current.set(row.id, node);
                  else nodes.current.delete(row.id);
                }}
                onClick={() => onSelect(selectionFromRow(row.id, selected))}
                onOpen={onOpenNote}
              />
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs text-secondary-foreground">
        <span className="tabular-nums">
          {count === 1
            ? t("mapRelationsTable.countOne")
            : t("mapRelationsTable.count", { values: { count } })}
        </span>
        {count > shown ? (
          <Button
            type="button"
            variant="secondary"
            onClick={() => setLimit((current) => current + tablePageSize)}
          >
            {t("mapRelationsTable.more", { values: { count: count - shown } })}
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function TableRow({
  t,
  row,
  state,
  tabbable,
  register,
  onClick,
  onOpen
}: {
  t: Translator;
  row: RelationRow;
  state: "idle" | "connected" | "selected";
  tabbable: boolean;
  register: (node: HTMLTableRowElement | null) => void;
  onClick: () => void;
  onOpen: (noteId: string) => void;
}) {
  return (
    <tr
      ref={register}
      data-row-id={row.id}
      aria-label={row.sentence}
      aria-selected={state === "selected"}
      tabIndex={tabbable ? 0 : -1}
      onClick={onClick}
      className={cn(
        "cursor-pointer border-t border-border align-top outline-offset-[-2px] focus-visible:outline-2 focus-visible:outline-accent",
        rowClass(state)
      )}
    >
      <NoteCell title={row.first.title} onOpen={() => onOpen(row.first.id)} />
      <td className="px-3 py-2 align-top">
        <span className="flex flex-wrap items-baseline gap-x-1.5">
          <RelationStanceLabel type={row.stance} t={t} size={12} className="font-semibold" />
          {row.suggested ? (
            <span className="text-xs font-normal text-muted-foreground">
              <span aria-hidden="true">· </span>
              {t("mapRelationsTable.suggested")}
            </span>
          ) : null}
        </span>
      </td>
      <NoteCell title={row.second.title} onOpen={() => onOpen(row.second.id)} />
    </tr>
  );
}

/** A note's title wraps at word boundaries; a double click opens it beside the Map. */
function NoteCell({ title, onOpen }: { title: string; onOpen: () => void }): ReactNode {
  return (
    <td
      className="px-3 py-2 align-top leading-snug text-foreground break-words [text-wrap:pretty]"
      onDoubleClick={onOpen}
    >
      {title}
    </td>
  );
}

/**
 * The column beside the canvas, or the whole view in "Só tabela": the heading, the table, what its
 * keys do, the lines between topic groups and the topics outside the branch.
 */
export function RelationsAside({
  t,
  model,
  selected,
  onSelect,
  onOpenNote,
  onChoose,
  alone = false
}: RelationsTableProps & { onChoose: BranchChoose; alone?: boolean }) {
  return (
    <aside
      aria-label={t("mapRelationsTable.title")}
      className={
        alone
          ? "grid min-w-0 gap-5 min-[1180px]:grid-cols-[minmax(0,1fr)_22rem] min-[1180px]:items-start"
          : "flex min-w-0 flex-col gap-4 min-[1180px]:w-[26rem]"
      }
    >
      <div className="flex min-w-0 flex-col gap-2">
        <h2 className="m-0 text-sm font-semibold text-foreground">
          {t("mapRelationsTable.title")}
        </h2>
        <RelationsTable
          t={t}
          model={model}
          selected={selected}
          onSelect={onSelect}
          onOpenNote={onOpenNote}
          alone={alone}
        />
        <p className="m-0 flex flex-wrap items-center gap-x-1.5 gap-y-1 text-xs text-muted-foreground">
          <Kbd>↑↓</Kbd>
          {t("mapRelationsTable.keyMove")}
          <span aria-hidden="true">·</span>
          <Kbd>↵</Kbd>
          {t("mapRelationsTable.keyOpen")}
          <span aria-hidden="true">·</span>
          <Kbd>⇧↵</Kbd>
          {t("mapRelationsTable.keyOpenSecond")}
        </p>
      </div>
      <div className="flex min-w-0 flex-col gap-4">
        <GroupLinks t={t} model={model} />
        <OutsideTopics t={t} model={model} onChoose={onChoose} />
      </div>
    </aside>
  );
}
