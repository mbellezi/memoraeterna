import { cn } from "../../lib/cn";

/**
 * The When cell of both tables: the time on one line, the day under it, so the column is as wide as
 * the widest time ("12:59 PM") in any language and the day word never runs into the next column. A
 * screen reader gets the one-line reading.
 */
export function WhenCell({
  className,
  row
}: {
  className: string;
  row: { when: string; whenTime: string; whenDay: string | null; whenFull: string };
}) {
  return (
    <td className={cn(className, "overflow-hidden tabular-nums")} title={row.whenFull}>
      <span className="sr-only">{row.when}</span>
      <span aria-hidden="true" className="block whitespace-nowrap">
        {row.whenTime}
      </span>
      {row.whenDay ? (
        <span aria-hidden="true" className="block text-xs text-muted-foreground">
          {row.whenDay}
        </span>
      ) : null}
    </td>
  );
}
