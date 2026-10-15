import type { CSSProperties, KeyboardEvent, ReactNode } from "react";
import {
  ChevronRight,
  CornerDownRight,
  Hourglass,
  LoaderCircle,
  Pin,
  RotateCw,
  TriangleAlert,
  UserRound
} from "lucide-react";
import type { TopicHealth, TopicItemLeaf } from "@app/domain";
import type { Translator } from "@app/i18n";
import { cn } from "../../lib/cn";
import { ObjectKindGlyph, objectKindTextClass } from "../glyphs";
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
  /** Absolute placement inside a windowed list. */
  style?: CSSProperties | undefined;
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
  format
}: {
  value: number | null;
  spoken: string;
  format: (value: number) => string;
}) {
  if (value === null) return null;
  return (
    <>
      <span
        aria-hidden="true"
        className="min-w-5 shrink-0 text-right text-xs tabular-nums text-muted-foreground"
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
  style,
  onToggle,
  onActivate,
  onFocusRow,
  onKeyDown
}: NavRowProps) {
  const expandable = isExpandableRow(row);
  const title = rowTitle(t, row);
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
        "flex h-7 items-center gap-1 rounded-md pr-2 text-sm outline-none",
        "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
        selected ? "bg-accent-soft font-semibold text-foreground" : "text-foreground hover:bg-soft"
      )}
      onClick={() => onActivate(row)}
      onFocus={() => onFocusRow(row.key)}
      onKeyDown={(event) => onKeyDown(event, row)}
    >
      <Chevron row={row} onToggle={onToggle} />
      <RowContent t={t} row={row} format={format} />
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

function RowContent({
  t,
  row,
  format
}: {
  t: Translator;
  row: NavRow;
  format: (value: number) => string;
}) {
  switch (row.type) {
    case "topic": {
      const { node } = row;
      return (
        <>
          <ObjectKindGlyph kind="topic" className={objectKindTextClass.topic} />
          <span className="sr-only">{t("topics.navigator.kinds.topic")}: </span>
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              node.title === null && "italic text-muted-foreground"
            )}
          >
            {node.title ?? t("topics.navigator.unnamed")}
          </span>
          {node.management === "human" ? (
            <Mark
              label={t("topics.navigator.marks.createdByYou")}
              className="text-muted-foreground"
            >
              <UserRound aria-hidden="true" className="size-3" />
            </Mark>
          ) : null}
          {node.management === "pinned" ? <PinMark t={t} /> : null}
          <HealthMark t={t} health={node.health} />
          <Count
            value={node.items}
            spoken={t("topics.navigator.itemCount", { values: { count: node.items } })}
            format={format}
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
          <span className="min-w-0 flex-1 truncate">{leafLabel(t, leaf)}</span>
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
          {leaf.kind === "source" && leaf.noteCount > 0 ? (
            <Count
              value={leaf.noteCount}
              spoken={t("topics.navigator.noteCount", { values: { count: leaf.noteCount } })}
              format={format}
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
          />
        </>
      );
    case "place": {
      const { place } = row;
      return (
        <>
          <ObjectKindGlyph kind={place.kind} className={objectKindTextClass[place.kind]} />
          <span className="sr-only">{t(`topics.navigator.kinds.${place.kind}`)}: </span>
          <span
            className={cn(
              "min-w-0 flex-1 truncate",
              place.title === null && "italic text-muted-foreground"
            )}
          >
            {place.title ?? t("topics.navigator.unnamed")}
          </span>
          {place.pinned || place.management === "pinned" ? <PinMark t={t} /> : null}
          <HealthMark t={t} health={place.health} />
          <Count value={place.count} spoken={placeCountLabel(t, place)} format={format} />
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
