import { cn } from "../lib/cn";

/**
 * One rail item: an icon over a 12 px word, 60 px wide (56 at the compact rail) with no side
 * padding, as the mockup sizes it, so a long word such as "Biblioteca" fits whole.
 */
export const railItemClass = cn(
  "relative flex w-(--rail-item-w) flex-col items-center gap-1 rounded-lg py-2",
  "text-xs font-medium leading-4 transition-colors",
  "focus-visible:outline-2 focus-visible:outline-offset-0 focus-visible:outline-accent"
);

/**
 * The colours of an item that is not current. `cn` only joins strings, and the generated stylesheet
 * puts `text-secondary-foreground` after `text-accent`, so the idle colours are never on the current
 * item: the two states are exclusive, not layered.
 */
export const railIdleClass = cn(
  "text-secondary-foreground hover:bg-surface-hover hover:text-foreground"
);

/**
 * The current item: the selection tint, the accent icon and word, and a 2 px accent bar at the
 * rail's edge, so a selected item is never shown by tint alone (design record §2 rule 9). The weight
 * stays medium: a semibold "Biblioteca" would be wider than its 56 px item at the compact rail. The
 * bar sits against the rail's edge at every tier: (item - rail) / 2 is -6 px at 72/60 and -4 at 64/56.
 */
export const railCurrentClass = cn(
  "bg-accent-soft text-accent",
  "before:absolute before:left-[calc((var(--rail-item-w)-var(--rail-w))/2)] before:top-3 before:bottom-3 before:w-0.5 before:rounded-sm before:bg-accent"
);
