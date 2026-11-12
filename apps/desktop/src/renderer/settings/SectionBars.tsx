import { cn } from "../lib/cn";
import { Skeleton } from "../components/ui/skeleton";

/**
 * The pieces a section's loading bars are drawn from, so each section can show the shape of what is
 * coming (design record 5.12) while Settings reads its saved values: a group's name, a row (a label,
 * a line of help and a control at the right), a list line and a table line. The bars are decorative;
 * the surface's `LoadingState` says "Loading".
 */

/** A group's name; the first group of a section sits closer to the title. */
export function BarsGroup({ first = false, width = "w-28" }: { first?: boolean; width?: string }) {
  return <Skeleton className={cn("h-3.5", first ? "mt-8" : "mt-10", width)} />;
}

/** One setting: its label and help at the left, its control at the right (absent: no control). */
export function BarsRow({
  label = "w-44",
  help = "w-72",
  control
}: {
  label?: string;
  help?: string;
  /** The control's width class (a select, a toggle, a button); absent for a row with no control. */
  control?: string;
}) {
  return (
    <div
      className={cn(
        "grid items-center gap-x-6 gap-y-2 border-b border-border py-4",
        control ? "grid-cols-[minmax(0,1fr)_auto]" : "grid-cols-1"
      )}
    >
      <Skeleton className={cn("h-3.5", label)} />
      {control ? <Skeleton className={cn("row-span-2 h-8 rounded-md", control)} /> : null}
      <Skeleton className={cn("h-3 max-w-full", help)} />
    </div>
  );
}

/** A line of a list under a row: a small icon bar, then a text bar. */
export function BarsItem({ width = "w-56" }: { width?: string }) {
  return (
    <div className="flex items-center gap-3 border-b border-border py-3">
      <Skeleton className="size-4 shrink-0 rounded-sm" />
      <Skeleton className={cn("h-3.5", width)} />
    </div>
  );
}

/** A line of a three-column table (a job, where it runs, what leaves). */
export function BarsTableRow({
  columns = ["w-24", "w-28", "w-32"]
}: {
  columns?: readonly [string, string, string];
}) {
  return (
    <div className="grid grid-cols-[30%_36%_1fr] gap-4 border-t border-border py-3">
      {columns.map((width, index) => (
        <Skeleton key={index} className={cn("h-3.5 max-w-full", width)} />
      ))}
    </div>
  );
}
