import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Translator } from "@app/i18n";
import { TopicNavRow } from "./TopicNavRow";
import { useRowWindow } from "./row-window";
import {
  navRowHeight,
  navigationAction,
  rovingKey,
  windowIndexes,
  type NavRow
} from "./topic-navigation";

/** Rows rendered beyond the ones in view, so a fast scroll does not show blanks. */
const overscan = 10;

export interface NavTreeProps {
  t: Translator;
  rows: readonly NavRow[];
  /** The heading that names the tree. */
  labelledBy: string;
  /** Draw only the rows in view (long trees); short lists draw every row. */
  windowed?: boolean;
  /** The topic that is open. */
  selectedTopicId: string | null;
  /** A row to scroll into view once it exists; the token tells repeated requests apart. */
  scrollTo?: { key: string; token: number } | null;
  /** Opening or closing a branch (the chevron and the arrow keys). */
  onToggle: (row: NavRow) => void;
  /** Opening what a row stands for (Enter, Space, a click). */
  onActivate: (row: NavRow) => void;
}

const isSelected = (row: NavRow, selectedTopicId: string | null) =>
  selectedTopicId !== null &&
  ((row.type === "topic" && row.node.id === selectedTopicId) ||
    (row.type === "place" && row.place.kind === "topic" && row.place.id === selectedTopicId));

/**
 * An ARIA tree with one tab stop: arrows, Home and End move, Right and Left open, close and enter or
 * leave a branch, Enter and Space open the row's object. A windowed tree draws the rows in view; the
 * row that holds focus is always drawn, so the tab stop never leaves the page.
 */
export function TopicNavTree({
  t,
  rows,
  labelledBy,
  windowed = false,
  selectedTopicId,
  scrollTo = null,
  onToggle,
  onActivate
}: NavTreeProps) {
  const [remembered, setRemembered] = useState<string | null>(null);
  const stop = rovingKey(rows, remembered);
  const pendingFocus = useRef<string | null>(null);
  const { rows: rowWindow, viewport, attach } = useRowWindow(windowed);
  const format = useMemo(() => {
    const numbers = new Intl.NumberFormat(t.locale);
    return (value: number) => numbers.format(value);
  }, [t.locale]);

  const indexOfStop = stop === null ? -1 : rows.findIndex((row) => row.key === stop);
  const indexes = useMemo(
    () =>
      windowed
        ? windowIndexes(rows.length, viewport, overscan, [indexOfStop])
        : rows.map((_, index) => index),
    [windowed, rows, viewport, indexOfStop]
  );

  // Focus follows the keyboard once the row it names is drawn (a windowed row may not be yet).
  useEffect(() => {
    const key = pendingFocus.current;
    if (key === null) return;
    const target = rowWindow.find(key);
    if (!target) return;
    pendingFocus.current = null;
    target.focus();
  });

  // A revealed row is scrolled into view; it is drawn by then or the window follows the scroll.
  const scrolled = useRef<number | null>(null);
  useEffect(() => {
    if (!windowed || !scrollTo || scrolled.current === scrollTo.token) return;
    const index = rows.findIndex((row) => row.key === scrollTo.key);
    if (index < 0) return;
    scrolled.current = scrollTo.token;
    rowWindow.scrollToRow(index);
  }, [windowed, scrollTo, rows, rowWindow]);

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>, row: NavRow) => {
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    const index = rows.indexOf(row);
    const action = navigationAction(rows, index, event.key);
    if (action.type === "none") return;
    event.preventDefault();
    if (action.type === "focus") {
      pendingFocus.current = action.key;
      setRemembered(action.key);
    } else if (action.type === "activate") onActivate(row);
    else onToggle(row);
  };

  return (
    <div
      ref={attach}
      role="tree"
      aria-labelledby={labelledBy}
      className={windowed ? "relative min-w-0" : "min-w-0"}
      style={windowed ? { height: rows.length * navRowHeight } : undefined}
    >
      {indexes.map((index) => {
        const row = rows[index]!;
        return (
          <TopicNavRow
            key={row.key}
            t={t}
            row={row}
            format={format}
            tabStop={row.key === stop}
            selected={isSelected(row, selectedTopicId)}
            style={
              windowed
                ? { position: "absolute", insetInline: 0, top: index * navRowHeight }
                : undefined
            }
            onToggle={onToggle}
            onActivate={onActivate}
            onFocusRow={setRemembered}
            onKeyDown={onKeyDown}
          />
        );
      })}
    </div>
  );
}
