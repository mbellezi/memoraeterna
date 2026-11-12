import { useState } from "react";
import type { Translator } from "@app/i18n";

import { Button } from "../../../../components/ui/button";
import { cn } from "../../../../lib/cn";
import { HealthMark } from "./health-marks";
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
 * (the selected row is the selected block). Columns: Tópico, Notas (52 px), Saúde (124 px) and
 * 7 dias (64 px); a name that does not fit ends in a tail ellipsis and shows whole on hover.
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
  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div
        className={cn(
          "overflow-y-auto rounded-lg border border-border",
          compact ? "max-h-[28rem]" : "max-h-80"
        )}
      >
        <table className="w-full table-fixed border-collapse text-xs">
          <caption className="sr-only">{t("map.table.caption")}</caption>
          <colgroup>
            <col />
            <col style={{ width: 52 }} />
            {compact ? null : <col className="max-[1179px]:hidden" style={{ width: 124 }} />}
            {compact ? null : <col style={{ width: 64 }} />}
          </colgroup>
          <thead className="sticky top-0 bg-soft">
            <tr>
              <th scope="col" className={cn(head, "text-left")}>
                {t("map.table.topic")}
              </th>
              <th scope="col" className={cn(head, "text-right")}>
                {t("map.table.notes")}
              </th>
              {compact ? null : (
                <th scope="col" className={cn(head, "text-left max-[1179px]:hidden")}>
                  {t("map.table.health")}
                </th>
              )}
              {compact ? null : (
                <th scope="col" className={cn(head, "text-right")}>
                  {t("map.table.growth")}
                </th>
              )}
            </tr>
          </thead>
          <tbody>
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
                      aria-pressed={selected}
                      title={row.name}
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
                  <td className="px-2 py-1 text-right whitespace-nowrap tabular-nums">
                    {number.format(row.items)}
                  </td>
                  {compact ? null : (
                    <td className="px-2 py-1 whitespace-nowrap max-[1179px]:hidden">
                      {row.health ? <HealthMark t={t} health={row.health} /> : "—"}
                    </td>
                  )}
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
