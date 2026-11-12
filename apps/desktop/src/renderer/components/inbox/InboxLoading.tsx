import type { CSSProperties } from "react";
import type { Translator } from "@app/i18n";

import { Skeleton, skeletonDelayMs, useAfterDelay } from "../ui/skeleton";

/** The widths of the title bars of a row, in turn: a title of one line and of two. */
const titleWidths = ["w-4/5", "w-3/5", "w-11/12", "w-2/3", "w-3/4", "w-1/2"] as const;

/** One row of the list as bars: its kind and age, a title of two lines and what it is about. */
function RowSkeleton({ index }: { index: number }) {
  return (
    <div className="grid gap-2 border-b border-border px-3 py-2.5 last:border-b-0">
      <div className="flex items-center justify-between gap-2">
        <Skeleton className="h-3 w-24" />
        <Skeleton className="h-3 w-12" />
      </div>
      <Skeleton className={`h-3.5 ${titleWidths[index % titleWidths.length]}`} />
      {index % 3 === 1 ? null : <Skeleton className="h-3.5 w-2/5" />}
      <Skeleton className="h-3 w-3/5" />
    </div>
  );
}

/** The list column as bars: a risk header, then rows of the shape of a row. */
function ListSkeleton({ rows }: { rows: number }) {
  return (
    <div className="flex min-w-0 flex-col self-start rounded-lg border border-border-strong bg-surface">
      <div className="border-b border-border bg-soft px-3 py-2">
        <Skeleton className="h-3 w-20" />
      </div>
      {Array.from({ length: rows }, (_, index) => (
        <RowSkeleton key={index} index={index} />
      ))}
    </div>
  );
}

/** The detail sheet as bars: the risk line, the title, three lines of prose and two buttons. */
function DetailSkeleton() {
  return (
    <div className="flex min-w-0 flex-col gap-4 rounded-lg border border-border bg-surface p-5">
      <Skeleton className="h-3 w-48" />
      <Skeleton className="h-7 w-2/3 max-w-md" />
      <div className="grid max-w-(--measure) gap-2.5">
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-full" />
        <Skeleton className="h-4 w-3/5" />
      </div>
      <div className="flex gap-2">
        <Skeleton className="h-[34px] w-28 rounded-lg" />
        <Skeleton className="h-[34px] w-28 rounded-lg" />
      </div>
    </div>
  );
}

/**
 * The Inbox while it is read (design record §7.4: a skeleton list and detail). The bars keep the
 * layout of the loaded screen, a list column and a detail sheet, so nothing jumps when the items
 * arrive; in the previous panel only the list. The status is for screen readers: no sentence is
 * drawn.
 */
export function InboxLoading({
  t,
  compact,
  listWidth
}: {
  t: Translator;
  compact: boolean;
  listWidth: number;
}) {
  const shown = useAfterDelay(skeletonDelayMs);
  return (
    <div
      role="status"
      aria-busy="true"
      className={
        compact
          ? "grid min-w-0 gap-3"
          : "grid min-h-0 min-w-0 flex-1 grid-cols-[var(--inbox-list-w)_minmax(0,1fr)] content-start gap-4"
      }
      style={{ "--inbox-list-w": `${listWidth}px` } as CSSProperties}
    >
      <span className="sr-only">{t("ui.loading")}</span>
      {shown ? (
        <>
          <ListSkeleton rows={compact ? 7 : 6} />
          {compact ? null : <DetailSkeleton />}
        </>
      ) : null}
    </div>
  );
}
