import { useState } from "react";
import type { Translator } from "@app/i18n";

import { cn } from "../../../../lib/cn";
import { ObjectKindGlyph } from "../../../../components/glyphs";
import { Button } from "../../../../components/ui/button";
import { HealthMark } from "./health-marks";
import { tablePageSize, type TableRow } from "./shape-model";

export interface ShapeTableProps {
  t: Translator;
  rows: readonly TableRow[];
  /** The key of the selected block. */
  selectedKey: string | null;
  onSelect: (key: string) => void;
}

const head = "px-2 py-2 text-xs font-semibold text-secondary-foreground whitespace-nowrap";

/**
 * The same tree as the chart, as a table: one row per topic from the top down, the Unsorted
 * items after the topics of the root. Rows are added a page at a time, so a large tree stays light.
 */
export function ShapeTable({ t, rows, selectedKey, onSelect }: ShapeTableProps) {
  const [limit, setLimit] = useState(tablePageSize);
  const shown = rows.slice(0, limit);
  const number = new Intl.NumberFormat(t.locale);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="overflow-x-auto rounded-lg border border-border">
        <table className="w-full min-w-176 border-collapse text-sm">
          <caption className="sr-only">{t("topics.shape.table.caption")}</caption>
          <thead className="bg-soft">
            <tr>
              <th scope="col" className={cn(head, "w-full min-w-56 text-left")}>
                {t("topics.shape.table.topic")}
              </th>
              <th scope="col" className={cn(head, "text-right")}>
                {t("topics.shape.table.level")}
              </th>
              <th scope="col" className={cn(head, "text-right")}>
                {t("topics.shape.table.items")}
              </th>
              <th scope="col" className={cn(head, "text-right")}>
                {t("topics.shape.table.direct")}
              </th>
              <th scope="col" className={cn(head, "text-right")}>
                {t("topics.shape.table.subtopics")}
              </th>
              <th scope="col" className={cn(head, "text-right")}>
                {t("topics.shape.table.week")}
              </th>
              <th scope="col" className={cn(head, "text-right")}>
                {t("topics.shape.table.coherence")}
              </th>
              <th scope="col" className={cn(head, "text-left")}>
                {t("topics.shape.table.health")}
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => {
              const selected = row.key === selectedKey;
              return (
                <tr
                  key={row.key}
                  className={cn("border-t border-border", selected && "bg-accent-soft")}
                >
                  <th
                    scope="row"
                    className="px-2 py-1.5 text-left font-normal"
                    style={{
                      paddingInlineStart: `calc(var(--space-2) + var(--space-3) * ${row.level})`
                    }}
                  >
                    <button
                      type="button"
                      aria-pressed={selected}
                      onClick={() => onSelect(row.key)}
                      className="flex max-w-full items-center gap-1.5 rounded-sm text-left font-medium text-foreground hover:underline"
                    >
                      {row.kind === "topic" ? (
                        <ObjectKindGlyph kind="topic" className="text-object-topic" />
                      ) : null}
                      <span className="[overflow-wrap:anywhere]">{row.name}</span>
                    </button>
                    {row.mark ? (
                      <span className="block text-xs text-muted-foreground">{row.mark}</span>
                    ) : null}
                  </th>
                  <td className="px-2 py-1.5 text-right whitespace-nowrap tabular-nums">
                    {number.format(row.level)}
                  </td>
                  <td className="px-2 py-1.5 text-right whitespace-nowrap tabular-nums">
                    {number.format(row.items)}
                  </td>
                  <td className="px-2 py-1.5 text-right whitespace-nowrap tabular-nums">
                    {row.direct === null ? "—" : number.format(row.direct)}
                  </td>
                  <td className="px-2 py-1.5 text-right whitespace-nowrap tabular-nums">
                    {row.subtopics === null ? "—" : number.format(row.subtopics)}
                  </td>
                  <td className="px-2 py-1.5 text-right whitespace-nowrap tabular-nums">
                    {row.week}
                  </td>
                  <td className="px-2 py-1.5 text-right whitespace-nowrap tabular-nums">
                    {row.coherence}
                  </td>
                  <td className="px-2 py-1.5 whitespace-nowrap">
                    {row.health ? <HealthMark t={t} health={row.health} /> : "—"}
                  </td>
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
