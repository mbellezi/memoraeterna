import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import {
  ChevronRight,
  CornerDownRight,
  Hourglass,
  LoaderCircle,
  MoreHorizontal,
  Pin,
  RotateCw,
  TriangleAlert,
  UserRound
} from "lucide-react";
import type { TopicHealth, TopicItemLeaf } from "@app/domain";
import type { Translator } from "@app/i18n";
import { cn } from "../../lib/cn";
import { FittedLabel, WrappedLabel } from "../../workspace/destinations/explore/FittedLabel";
import { ObjectKindGlyph, objectKindTextClass } from "../glyphs";
import { InlineTitleEditor } from "./ops/InlineTitleEditor";
import { actionRowOf, actionsLabelKey, itemIdentity, type NavRowOps } from "./ops/nav-ops";
import { isExpandableRow, type NavRow, type PlaceEntry } from "./topic-navigation";

/** Indent per outline level, and the first level's inset (the 4 px grid). */
const levelIndent = 16;
const baseInset = 4;

export interface NavRowProps {
  t: Translator;
  row: NavRow;
  /** Formats a count in the interface language. */
  format: (value: number) => string;
  /** The one row of the tree that is in the tab order. */
  tabStop: boolean;
  /** The topic that is open. */
  selected: boolean;
  /**
   * The row shows its whole name on up to two lines (the open row and its ancestors), and tells the
   * list how many it drew so the list can place the rows below it.
   */
  wrap?: boolean;
  onLines?: ((key: string, lines: number) => void) | undefined;
  /**
   * Compact windows (960-1179 px): a count shows on hover and focus, and on the open row, so the
   * name has the width.
   */
  quietCounts?: boolean;
  /** Absolute placement inside a windowed list. */
  style?: CSSProperties | undefined;
  /** Renaming in place and the actions of a topic (T26); absent, the row is read-only. */
  ops?: NavRowOps | undefined;
  onToggle: (row: NavRow) => void;
  onActivate: (row: NavRow) => void;
  onFocusRow: (key: string) => void;
  onKeyDown: (event: KeyboardEvent<HTMLDivElement>, row: NavRow) => void;
}

/** A glyph beside a title that stands for a state; the words are read, not the picture. */
function Mark({
  label,
  className,
  children
}: {
  label: string;
  className?: string;
  children: ReactNode;
}) {
  return (
    <span title={label} className={cn("inline-flex shrink-0 items-center", className)}>
      {children}
      <span className="sr-only">{label}</span>
    </span>
  );
}

function HealthMark({ t, health }: { t: Translator; health: TopicHealth | null }) {
  if (health === null || health === "good") return null;
  const violation = health === "violation";
  return (
    <Mark
      label={t(violation ? "topics.navigator.marks.violation" : "topics.navigator.marks.attention")}
      className={violation ? "text-danger" : "text-warning"}
    >
      <TriangleAlert aria-hidden="true" className="size-3" />
    </Mark>
  );
}

function PinMark({ t }: { t: Translator }) {
  return (
    <Mark label={t("topics.navigator.marks.pinned")} className="text-muted-foreground">
      <Pin aria-hidden="true" className="size-3" />
    </Mark>
  );
}

function Count({
  value,
  spoken,
  format,
  onDemand = false
}: {
  value: number | null;
  spoken: string;
  format: (value: number) => string;
  /** Drawn over the row's end on hover and focus only, taking no width from the name. */
  onDemand?: boolean;
}) {
  if (value === null) return null;
  return (
    <>
      <span
        aria-hidden="true"
        className={cn(
          "min-w-5 text-right text-xs tabular-nums text-muted-foreground",
          onDemand
            ? "pointer-events-none absolute inset-y-0 right-2 flex items-center bg-soft pl-1 opacity-0 group-hover/row:opacity-100 group-focus-within/row:opacity-100"
            : "shrink-0"
        )}
      >
        {format(value)}
      </span>
      <span className="sr-only">{spoken}</span>
    </>
  );
}

/** The chevron column: a control for the pointer only, the keyboard opens with the arrows. */
function Chevron({ row, onToggle }: { row: NavRow; onToggle: (row: NavRow) => void }) {
  const expandable = isExpandableRow(row);
  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground",
        expandable && "hover:bg-surface-hover"
      )}
      onClick={
        expandable
          ? (event) => {
              event.stopPropagation();
              onToggle(row);
            }
          : undefined
      }
    >
      {expandable ? (
        <ChevronRight className={cn("size-3 transition-transform", row.expanded && "rotate-90")} />
      ) : null}
    </span>
  );
}

function leafLabel(t: Translator, leaf: TopicItemLeaf) {
  return leaf.title === "" ? t("topics.navigator.untitled") : leaf.title;
}

function placeCountLabel(t: Translator, place: PlaceEntry) {
  return place.count === null
    ? ""
    : t("topics.navigator.itemCount", { values: { count: place.count } });
}

/**
 * One row of the outline. Topics, leaves, the Unsorted group, places and the "more" and status rows
 * share the frame (indent, chevron column, focus ring, 28 px height) and differ in their content.
 */
export function TopicNavRow({
  t,
  row,
  format,
  tabStop,
  selected,
  wrap = false,
  onLines,
  quietCounts = false,
  style,
  ops,
  onToggle,
  onActivate,
  onFocusRow,
  onKeyDown
}: NavRowProps) {
  const expandable = isExpandableRow(row);
  const title = rowTitle(t, row);
  const actionRow = ops ? actionRowOf(row) : null;
  return (
    <div
      role="treeitem"
      data-nav-key={row.key}
      tabIndex={tabStop ? 0 : -1}
      aria-level={row.level}
      aria-posinset={row.posInSet}
      aria-setsize={row.setSize}
      aria-expanded={expandable ? row.expanded : undefined}
      aria-selected={row.type === "topic" || row.type === "place" ? selected : undefined}
      aria-current={selected ? "true" : undefined}
      aria-busy={row.type === "status" && row.state === "loading" ? true : undefined}
      title={title?.tooltip}
      style={{ ...style, paddingLeft: baseInset + (row.level - 1) * levelIndent }}
      className={cn(
        "group/row relative flex items-center gap-1 rounded-md pr-2 text-sm",
        wrap ? "min-h-7 py-1" : "h-7",
        // One declaration for the ring: two utilities for `outline-style` would be decided by the
        // stylesheet's order, and the ring would not show.
        "focus-visible:[outline-offset:-2px] focus-visible:[outline:2px_solid_var(--accent)]",
        // The open row: the soft accent fill and the 2 px accent bar (design record 5.3).
        selected
          ? "bg-accent-soft font-semibold text-foreground before:absolute before:inset-y-1 before:left-0 before:w-0.5 before:rounded-full before:bg-accent before:content-['']"
          : "text-foreground hover:bg-soft"
      )}
      onClick={() => onActivate(row)}
      onFocus={() => onFocusRow(row.key)}
      onKeyDown={(event) => onKeyDown(event, row)}
      onContextMenu={
        ops && actionRow
          ? (event) => {
              event.preventDefault();
              ops.onOpenMenu(actionRow, { x: event.clientX, y: event.clientY });
            }
          : undefined
      }
    >
      <Chevron row={row} onToggle={onToggle} />
      <RowContent
        t={t}
        row={row}
        format={format}
        ops={ops}
        wrap={wrap}
        onLines={onLines}
        quietCount={quietCounts && !selected}
      />
      {ops && actionRow ? (
        <button
          type="button"
          tabIndex={-1}
          aria-label={t(actionsLabelKey(actionRow))}
          title={t(actionsLabelKey(actionRow))}
          aria-haspopup="menu"
          className={cn(
            "flex size-5 shrink-0 items-center justify-center rounded text-muted-foreground opacity-0",
            "hover:bg-surface-hover hover:text-foreground focus-visible:opacity-100",
            "group-focus-within/row:opacity-100 group-hover/row:opacity-100"
          )}
          onClick={(event) => {
            event.stopPropagation();
            const box = event.currentTarget.getBoundingClientRect();
            ops.onOpenMenu(actionRow, { x: box.left, y: box.bottom + 2 });
          }}
        >
          <MoreHorizontal aria-hidden="true" className="size-3.5" />
        </button>
      ) : null}
    </div>
  );
}

/** The name and tooltip a row has apart from its parts (titles can be cut by the width). */
function rowTitle(t: Translator, row: NavRow): { tooltip: string } | null {
  switch (row.type) {
    case "topic":
      return { tooltip: row.node.title ?? t("topics.navigator.unnamed") };
    case "leaf":
      return {
        tooltip:
          row.leaf.kind === "note" && row.leaf.sourceTitle
            ? `${leafLabel(t, row.leaf)} · ${row.leaf.sourceTitle}`
            : leafLabel(t, row.leaf)
      };
    case "place":
      return { tooltip: row.place.title ?? t("topics.navigator.unnamed") };
    default:
      return null;
  }
}

/**
 * A topic's name: cut at word boundaries by its width, or, on the open row and its ancestors,
 * whole on up to two lines. The two never share a node, so a row that becomes open is fitted again
 * in the weight it is drawn in.
 */
function NameLabel({
  text,
  unnamed,
  wrap,
  onLines
}: {
  text: string;
  unnamed: boolean;
  wrap: boolean;
  onLines: ((lines: number) => void) | undefined;
}) {
  const className = unnamed ? "italic text-muted-foreground" : undefined;
  return wrap ? (
    <WrappedLabel text={text} onLines={onLines} {...(className ? { className } : {})} />
  ) : (
    <FittedLabel text={text} {...(className ? { className } : {})} />
  );
}

function RowContent({
  t,
  row,
  format,
  ops,
  wrap,
  onLines,
  quietCount
}: {
  t: Translator;
  row: NavRow;
  format: (value: number) => string;
  ops?: NavRowOps | undefined;
  wrap: boolean;
  onLines: ((key: string, lines: number) => void) | undefined;
  quietCount: boolean;
}) {
  const key = row.key;
  const reportLines = onLines ? (lines: number) => onLines(key, lines) : undefined;
  switch (row.type) {
    case "topic": {
      const { node } = row;
      return (
        <>
          <ObjectKindGlyph kind="topic" className={objectKindTextClass.topic} />
          <span className="sr-only">{t("topics.navigator.kinds.topic")}: </span>
          {ops?.renamingKey === row.key ? (
            <InlineTitleEditor
              initial={node.title ?? ""}
              label={t("topics.ops.rename.label")}
              invalid={ops.invalid}
              busy={ops.busy}
              onCommit={(title) => ops.onCommitRename(row, title)}
              onCancel={ops.onCancelRename}
            />
          ) : (
            <NameLabel
              text={node.title ?? t("topics.navigator.unnamed")}
              unnamed={node.title === null}
              wrap={wrap}
              onLines={reportLines}
            />
          )}
          {node.management === "human" ? (
            <Mark
              label={t("topics.navigator.marks.createdByYou")}
              className="text-muted-foreground"
            >
              <UserRound aria-hidden="true" className="size-3" />
            </Mark>
          ) : null}
          {node.management === "pinned" || ops?.pinnedItems.has(itemIdentity("topic", node.id)) ? (
            <PinMark t={t} />
          ) : null}
          <HealthMark t={t} health={node.health} />
          <Count
            value={node.items}
            spoken={t("topics.navigator.itemCount", { values: { count: node.items } })}
            format={format}
            onDemand={quietCount}
          />
        </>
      );
    }
    case "leaf": {
      const { leaf } = row;
      return (
        <>
          <ObjectKindGlyph kind={leaf.kind} className={objectKindTextClass[leaf.kind]} />
          <span className="sr-only">{t(`topics.navigator.kinds.${leaf.kind}`)}: </span>
          <FittedLabel text={leafLabel(t, leaf)} />
          {leaf.role === "secondary" ? (
            <Mark label={t("topics.navigator.marks.alsoHere")} className="text-muted-foreground">
              <CornerDownRight aria-hidden="true" className="size-3" />
            </Mark>
          ) : null}
          {row.waiting ? (
            <Mark label={t("topics.navigator.marks.waiting")} className="text-muted-foreground">
              <Hourglass aria-hidden="true" className="size-3" />
            </Mark>
          ) : null}
          {ops?.pinnedItems.has(itemIdentity(leaf.kind, leaf.id)) ? <PinMark t={t} /> : null}
          {leaf.kind === "source" && leaf.noteCount > 0 ? (
            <Count
              value={leaf.noteCount}
              spoken={t("topics.navigator.noteCount", { values: { count: leaf.noteCount } })}
              format={format}
              onDemand={quietCount}
            />
          ) : null}
        </>
      );
    }
    case "unsorted":
      return (
        <>
          <ObjectKindGlyph kind="topic" className={objectKindTextClass.topic} />
          <span className="min-w-0 flex-1 truncate">{t("topics.navigator.unsorted")}</span>
          <Count
            value={row.count}
            spoken={t("topics.navigator.itemCount", { values: { count: row.count } })}
            format={format}
            onDemand={quietCount}
          />
        </>
      );
    case "place": {
      const { place } = row;
      return (
        <>
          <ObjectKindGlyph kind={place.kind} className={objectKindTextClass[place.kind]} />
          <span className="sr-only">{t(`topics.navigator.kinds.${place.kind}`)}: </span>
          <NameLabel
            text={place.title ?? t("topics.navigator.unnamed")}
            unnamed={place.title === null}
            wrap={wrap}
            onLines={reportLines}
          />
          {place.pinned || place.management === "pinned" ? <PinMark t={t} /> : null}
          <HealthMark t={t} health={place.health} />
          <Count
            value={place.count}
            spoken={placeCountLabel(t, place)}
            format={format}
            onDemand={quietCount}
          />
        </>
      );
    }
    case "more": {
      const failed = row.state === "error";
      const busy = row.state === "loading";
      return (
        <span
          className={cn("min-w-0 flex-1 truncate text-xs", failed ? "text-danger" : "text-accent")}
        >
          {busy
            ? t("topics.navigator.loadingBranch")
            : failed
              ? t("topics.navigator.moreFailed")
              : row.what === "topics"
                ? t("topics.navigator.moreTopics")
                : t("topics.navigator.moreItems", {
                    values: { count: format(row.remaining ?? 0) }
                  })}
        </span>
      );
    }
    case "status":
      return row.state === "loading" ? (
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-muted-foreground">
          <LoaderCircle
            aria-hidden="true"
            className="size-3 animate-spin motion-reduce:animate-none"
          />
          {t("topics.navigator.loadingBranch")}
        </span>
      ) : (
        <span className="flex min-w-0 flex-1 items-center gap-1.5 text-xs text-danger">
          <RotateCw aria-hidden="true" className="size-3 shrink-0" />
          <span className="truncate">{t("topics.navigator.branchError")}</span>
        </span>
      );
  }
}
