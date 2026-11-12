import { useState, type KeyboardEvent } from "react";
import type { Translator } from "@app/i18n";

import { Button } from "../../../../components/ui/button";
import { cn } from "../../../../lib/cn";
import { HealthMark, mapHealthKeys } from "./health-marks";
import { tablePageSize, type TableRow } from "./shape-model";

export interface MapTableProps {
  t: Translator;
  rows: readonly TableRow[];
  /** The key of the selected block: its row is the selected one. */
  selectedKey: string | null;
  /** Keys of the rows that hold where the person came from, marked "aqui". */
  hereKeys: ReadonlySet<string>;
  /** The root is the previous panel: only the names and the notes, the open topic's row marked. */
  compact?: boolean;
  /** The row of the topic the panel beside the table shows (`aria-current`). */
  currentKey?: string | null;
  onSelect: (key: string) => void;
}

/** The indent of a row by level: 20, 28, 36, 44 px, and 44 below (design record §7.5). */
export const rowIndent = (level: number): number => 20 + 8 * Math.min(Math.max(level - 1, 0), 3);

const head = "px-2 py-1.5 text-xs font-semibold text-secondary-foreground whitespace-nowrap";

/**
 * "Mesmos números em tabela": the chart's numbers beside it, always visible and in step with it
 * (the selected row is the selected block). Columns: Tópico, health (a 28 px glyph column
 * beside the name: a topic that needs attention carries its glyph, and every row says its health
 * word to a screen reader and on hover), Notas (52 px) and 7 dias (52 px), so a name keeps as much of the narrow column as it
 * can; a name that does not fit ends in a tail ellipsis and shows whole on hover. The rows are one
 * tab stop (the selected row), and the arrows move between them.
 */
export function MapTable({
  t,
  rows,
  selectedKey,
  hereKeys,
  compact = false,
  currentKey = null,
  onSelect
}: MapTableProps) {
  const [limit, setLimit] = useState(tablePageSize);
  const shown = rows.slice(0, limit);
  const number = new Intl.NumberFormat(t.locale);
  // One tab stop for the whole list: the row the person is on, else the selected, else the open one.
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const has = (key: string | null): key is string =>
    key !== null && shown.some((row) => row.key === key);
  const tabKey = [focusKey, selectedKey, currentKey].find(has) ?? shown[0]?.key ?? null;
  const onArrows = (event: KeyboardEvent<HTMLTableSectionElement>) => {
    if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    const keys = ["ArrowDown", "ArrowUp", "Home", "End"];
    if (!keys.includes(event.key)) return;
    const buttons = [
      ...event.currentTarget.querySelectorAll<HTMLButtonElement>("button[data-row]")
    ];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const next =
      event.key === "ArrowDown"
        ? Math.min(at + 1, buttons.length - 1)
        : event.key === "ArrowUp"
          ? Math.max(at - 1, 0)
          : event.key === "Home"
            ? 0
            : buttons.length - 1;
    event.preventDefault();
    buttons[next]?.focus();
  };
  return (
    <div className={cn("flex min-w-0 flex-col gap-2", compact && "min-h-0 flex-1")}>
      {/* The previous panel's table takes the panel's height and scrolls inside it. */}
      <div
        className={cn(
          "overflow-y-auto rounded-lg border border-border",
          compact ? "min-h-0 flex-1 content-start" : "max-h-80"
        )}
      >
        <table className="w-full table-fixed border-collapse text-xs">
          <caption className="sr-only">{t("map.table.caption")}</caption>
          <colgroup>
            <col />
            {compact ? null : <col style={{ width: 28 }} />}
            <col style={{ width: 52 }} />
            {compact ? null : <col style={{ width: 52 }} />}
          </colgroup>
          <thead className="sticky top-0 bg-soft">
            <tr>
              <th scope="col" className={cn(head, "text-left")}>
                {t("map.table.topic")}
              </th>
              {compact ? null : (
                <th scope="col" className="p-0">
                  <span className="sr-only">{t("map.table.health")}</span>
                </th>
              )}
              <th scope="col" className={cn(head, "text-right")}>
                {t("map.table.notes")}
              </th>
              {compact ? null : (
                <th scope="col" className={cn(head, "text-right")}>
                  {t("map.table.growth")}
                </th>
              )}
            </tr>
          </thead>
          <tbody onKeyDown={onArrows}>
            {shown.map((row) => {
              const selected = row.key === selectedKey;
              const here = hereKeys.has(row.key);
              return (
                <tr
                  key={row.key}
                  aria-current={row.key === currentKey ? "true" : undefined}
                  className={cn(
                    "border-t border-border",
                    (selected || row.key === currentKey) &&
                      "bg-surface-selected [box-shadow:inset_2px_0_0_0_var(--accent)]"
                  )}
                >
                  <th
                    scope="row"
                    className="px-2 py-1 text-left font-normal"
                    style={{ paddingInlineStart: rowIndent(row.level) }}
                  >
                    <button
                      type="button"
                      data-row=""
                      tabIndex={row.key === tabKey ? 0 : -1}
                      aria-pressed={selected}
                      title={row.name}
                      onFocus={() => setFocusKey(row.key)}
                      onBlur={() => setFocusKey(null)}
                      onClick={() => onSelect(row.key)}
                      className="flex w-full min-w-0 rounded-sm text-left font-medium text-foreground hover:underline"
                    >
                      {/* Only the title takes the tail ellipsis; the app's own marker is never cut. */}
                      <span className="min-w-0 truncate">{row.name}</span>
                      {here ? (
                        <span className="shrink-0 whitespace-pre font-semibold text-accent">{` · ${t("map.chart.here")} ↳`}</span>
                      ) : null}
                    </button>
                  </th>
                  {compact ? null : (
                    <td className="py-1 text-center whitespace-nowrap">
                      {row.health === "good" ? (
                        <span className="sr-only">{t(mapHealthKeys.good)}</span>
                      ) : row.health ? (
                        <HealthMark t={t} health={row.health} short glyphOnly />
                      ) : null}
                    </td>
                  )}
                  <td className="px-2 py-1 text-right whitespace-nowrap tabular-nums">
                    {number.format(row.items)}
                  </td>
                  {compact ? null : (
                    <td className="px-2 py-1 text-right whitespace-nowrap tabular-nums">
                      {row.growth}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {rows.length > limit ? (
        <div>
          <Button type="button" onClick={() => setLimit((current) => current + tablePageSize)}>
            {t("topics.navigator.moreTopics")}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
