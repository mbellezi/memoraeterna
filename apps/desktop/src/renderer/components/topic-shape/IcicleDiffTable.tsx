import type { Translator } from "@app/i18n";

import { cn } from "../../lib/cn";
import { DiffMark } from "./diff-marks";
import type { DiffRow } from "./icicle-diff-model";

export interface IcicleDiffTableProps {
  t: Translator;
  rows: readonly DiffRow[];
  selectedId: string | null;
  onSelect: (topicId: string) => void;
}

const head = "px-2 py-2 text-xs font-semibold text-secondary-foreground whitespace-nowrap";

/**
 * The table alternative of the icicles: one row per topic the read lists, the shallowest first,
 * with what happened to it, where it stood before and after, and the items moved. It lists every
 * topic, including the ones too narrow to draw. The read is bounded, so there is no paging.
 */
export function IcicleDiffTable({ t, rows, selectedId, onSelect }: IcicleDiffTableProps) {
  const number = new Intl.NumberFormat(t.locale);
  return (
    <div className="overflow-x-auto rounded-lg border border-border">
      <table className="w-full min-w-160 border-collapse text-sm">
        <caption className="sr-only">{t("topics.shape.diff.table.caption")}</caption>
        <thead className="bg-soft">
          <tr>
            <th scope="col" className={cn(head, "w-full min-w-48 text-left")}>
              {t("topics.shape.diff.table.topic")}
            </th>
            <th scope="col" className={cn(head, "text-left")}>
              {t("topics.shape.diff.table.change")}
            </th>
            <th scope="col" className={cn(head, "text-left")}>
              {t("topics.shape.diff.table.parentBefore")}
            </th>
            <th scope="col" className={cn(head, "text-left")}>
              {t("topics.shape.diff.table.parentAfter")}
            </th>
            <th scope="col" className={cn(head, "text-right")}>
              {t("topics.shape.diff.table.itemsIn")}
            </th>
            <th scope="col" className={cn(head, "text-right")}>
              {t("topics.shape.diff.table.itemsOut")}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const selected = row.id === selectedId;
            return (
              <tr
                key={row.id}
                className={cn("border-t border-border", selected && "bg-accent-soft")}
              >
                <th scope="row" className="px-2 py-1.5 text-left font-normal">
                  <button
                    type="button"
                    aria-pressed={selected}
                    onClick={() => onSelect(row.id)}
                    className="max-w-full rounded-sm text-left font-medium text-foreground hover:underline"
                  >
                    <span className="[overflow-wrap:anywhere]">{row.name}</span>
                  </button>
                  {row.was !== null ? (
                    <span className="block text-xs text-muted-foreground [overflow-wrap:anywhere]">
                      {t("topics.shape.diff.table.was", { values: { title: row.was } })}
                    </span>
                  ) : null}
                </th>
                <td className="px-2 py-1.5 whitespace-nowrap">
                  <DiffMark t={t} change={row.change} />
                </td>
                <td className="px-2 py-1.5 [overflow-wrap:anywhere]">
                  <Place
                    t={t}
                    exists={row.existedBefore}
                    parent={row.parentBefore}
                    none={t("topics.shape.diff.table.noneBefore")}
                  />
                </td>
                <td className="px-2 py-1.5 [overflow-wrap:anywhere]">
                  <Place
                    t={t}
                    exists={row.existsAfter}
                    parent={row.parentAfter}
                    none={t("topics.shape.diff.table.noneAfter")}
                  />
                </td>
                <td className="px-2 py-1.5 text-right whitespace-nowrap tabular-nums">
                  {number.format(row.itemsIn)}
                </td>
                <td className="px-2 py-1.5 text-right whitespace-nowrap tabular-nums">
                  {number.format(row.itemsOut)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/** Where a topic stood on a side: under its parent, at the top of the tree, or not there at all. */
export function Place({
  t,
  exists,
  parent,
  none
}: {
  t: Translator;
  exists: boolean;
  parent: string | null;
  none: string;
}) {
  if (!exists) return <span className="text-muted-foreground">{none}</span>;
  return <span>{parent ?? t("topics.shape.diff.table.top")}</span>;
}
