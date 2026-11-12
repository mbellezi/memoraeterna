import type { ReactNode, Ref } from "react";

import { ScrollArea } from "../../components/ui/scroll-area";
import { Skeleton } from "../../components/ui/skeleton";

/**
 * The wizard's footer is `sticky bottom-0`, which sticks to the edge of its own scroll box. The
 * frame's body pads its end (3 rem) and its top (1.25 rem) and scrolls with that padding inside, so
 * the footer would stop above the panel's bottom edge with the form showing beneath it. This box
 * takes the padding back (and the body's side padding, so the scroll bar is at the panel's edge)
 * and scrolls on its own, so the footer sits on the panel's bottom edge and nothing renders below
 * it. The form keeps a form's width, not the full width of a wide panel.
 */
export function ImportScroller({
  children,
  viewportRef
}: {
  children: ReactNode;
  viewportRef?: Ref<HTMLDivElement>;
}) {
  return (
    <ScrollArea
      data-import-scroller=""
      className="-mx-(--top-pl) -mb-12 -mt-5 h-[calc(100%+4.25rem)]"
      viewportClassName="[&>div]:block!"
      {...(viewportRef ? { viewportRef } : {})}
    >
      <div className="max-w-[48rem] px-(--top-pl) pb-3 pt-5">{children}</div>
    </ScrollArea>
  );
}

/** The wizard's scrolling element inside `root`, or null (the screens tool scrolls it to its end). */
export function importScrollViewport(root: ParentNode): HTMLElement | null {
  return root.querySelector<HTMLElement>(
    "[data-import-scroller] [data-radix-scroll-area-viewport]"
  );
}

/**
 * The first step's shape while the wizard's first read is out: the three steps, the heading with
 * its lead, the two origin cards side by side and the footer bar, so nothing jumps when it settles.
 */
export function ImportSkeleton() {
  return (
    <div className="grid max-w-[48rem] gap-5" aria-hidden="true">
      <div className="flex gap-3">
        {[0, 1, 2].map((step) => (
          <Skeleton key={step} className="h-6 w-24 rounded-full" />
        ))}
      </div>
      <div className="grid gap-2">
        <Skeleton className="h-6 w-2/5" />
        <Skeleton className="w-3/5" />
      </div>
      <div className="grid grid-cols-2 gap-3">
        <Skeleton className="h-28 rounded-xl" />
        <Skeleton className="h-28 rounded-xl" />
      </div>
      <Skeleton className="h-14 rounded-xl" />
    </div>
  );
}
