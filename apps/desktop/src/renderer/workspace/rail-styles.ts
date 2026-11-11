import { cn } from "../lib/cn";

/** One rail item: an icon over a 12 px word, as wide as the rail less its 6 px padding each side. */
export const railItemClass = cn(
  "relative flex w-[calc(var(--rail-w)-12px)] flex-col items-center gap-1 rounded-lg px-1 py-2",
  "text-xs font-medium leading-4 text-secondary-foreground transition-colors",
  "hover:bg-surface-hover hover:text-foreground",
  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent"
);

/**
 * The current item: the selection tint, the accent icon and word, and a 2 px accent bar at the
 * rail's edge, so a selected item is never shown by tint alone (design record §2 rule 9).
 */
export const railCurrentClass = cn(
  "bg-accent-soft font-semibold text-accent hover:bg-accent-soft hover:text-accent",
  "before:absolute before:-left-1.5 before:top-3 before:bottom-3 before:w-0.5 before:rounded-sm before:bg-accent"
);
