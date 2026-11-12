import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";

import { cn } from "../lib/cn";
import { useSettings } from "./settings-context";

/**
 * A setting that is a page of its own (the call log, the job history, the prompts, the local
 * gateway): its row reads like any other (label, plain help) and opens in place, under the row,
 * with the page's content. A link or a search result that takes the person to the row opens it
 * (`data-setting-id`, focusable by script, lit for 2 s like a setting row). The content is mounted
 * only while the page is open, so a closed page reads nothing.
 *
 * Two optional additions serve a page that shows a summary or decides itself when it is open: `meta`
 * is a summary at the right of the row (it moves the chevron to a third column), and `open` with
 * `onOpenChange` hands the open state to the caller (the row then does not open itself for a link).
 */
export function PageRow({
  id,
  label,
  help,
  defaultOpen = false,
  meta,
  open: openProp,
  onOpenChange,
  bodyClassName,
  children
}: {
  /** The registry id: `data-setting-id`, which a link and the search find the row by. */
  id: string;
  label: string;
  help: ReactNode;
  defaultOpen?: boolean;
  /** A summary at the right of the row (a count, a state), read with the label. */
  meta?: ReactNode;
  /** Controlled: the caller owns the open state and `onOpenChange` reports the person's toggles. */
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  /** The body's own classes, in place of the default bottom padding. */
  bodyClassName?: string;
  /** The page; rendered only while open. */
  children: ReactNode;
}) {
  const { highlighted } = useSettings();
  const controlled = openProp !== undefined;
  const [ownOpen, setOwnOpen] = useState(defaultOpen);
  const open = controlled ? openProp : ownOpen;
  // A link opens the page it names, once per time it is lit; closing it afterwards stays closed.
  // A row whose caller owns the open state is lit but opened by that caller only.
  const lit = highlighted === id;
  const [openedByLink, setOpenedByLink] = useState(false);
  if (lit && !openedByLink) {
    setOpenedByLink(true);
    if (!controlled) setOwnOpen(true);
  } else if (!lit && openedByLink) {
    setOpenedByLink(false);
  }
  const bodyId = useId();
  return (
    <div
      role="group"
      aria-label={label}
      data-setting-id={id}
      tabIndex={-1}
      className={cn(
        "relative border-b border-border transition-colors [transition-duration:var(--motion-slow)]",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        lit ? "-mx-4 bg-surface-selected px-4 [box-shadow:inset_2px_0_0_var(--accent)]" : ""
      )}
    >
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => {
          if (!controlled) setOwnOpen(!open);
          onOpenChange?.(!open);
        }}
        className={cn(
          "group -mx-3 grid w-[calc(100%+1.5rem)] items-center gap-y-1 rounded-md border-0 bg-transparent px-3 py-4 text-left",
          meta
            ? "grid-cols-[minmax(0,1fr)_auto_1rem] gap-x-4"
            : "grid-cols-[minmax(0,1fr)_auto] gap-x-6",
          "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
        )}
      >
        <span
          className={cn(
            "min-w-0 text-base font-medium leading-5 text-foreground [overflow-wrap:anywhere]",
            "group-hover:underline group-hover:decoration-border-strong group-hover:underline-offset-[3px]"
          )}
        >
          {label}
        </span>
        {meta ? (
          <span className="col-start-2 row-span-2 row-start-1 text-right text-sm tabular-nums text-secondary-foreground">
            {meta}
          </span>
        ) : null}
        <ChevronDown
          aria-hidden="true"
          className={cn(
            "row-span-2 size-4 text-secondary-foreground transition-transform [transition-duration:var(--motion-fast)]",
            meta ? "col-start-3 row-start-1" : "",
            open && "rotate-180"
          )}
        />
        <span
          className={cn(
            "min-w-0 max-w-[27.5rem] text-sm text-secondary-foreground [text-wrap:pretty]",
            meta ? "col-start-1" : ""
          )}
        >
          {help}
        </span>
      </button>
      {open ? (
        <div id={bodyId} className={bodyClassName ?? "pb-5 empty:hidden"}>
          {children}
        </div>
      ) : null}
    </div>
  );
}
