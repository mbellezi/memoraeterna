import { cn } from "../../lib/cn";

/**
 * The solid state glyphs of the design record (§4.1): a state is a solid shape plus a word, and a
 * kind or a stance is an outline icon, so roles that share a hue stay apart by form. The cut-out
 * strokes use the raised surface, which is the colour behind a pill or a row.
 */

const cutout = { stroke: "var(--surface-raised)", strokeWidth: 2.2, fill: "none" } as const;

/** A filled circle with a check: done ("Tudo em dia", "Pronta"). */
export function SolidCheck({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={cn("size-4 shrink-0", className)}>
      <circle cx="12" cy="12" r="9.5" fill="currentColor" />
      <path
        d="m7.8 12.4 2.8 2.8 5.6-5.8"
        strokeLinecap="round"
        strokeLinejoin="round"
        {...cutout}
      />
    </svg>
  );
}

/** A filled triangle with a bar: needs you, a warning. */
export function SolidTriangle({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true" className={cn("size-4 shrink-0", className)}>
      <path
        d="M10.3 3.7 2.2 18a2 2 0 0 0 1.7 3h16.2a2 2 0 0 0 1.7-3L13.7 3.7a2 2 0 0 0-3.4 0z"
        fill="currentColor"
      />
      <path d="M12 9v4.5M12 17.2h.01" strokeLinecap="round" {...cutout} />
    </svg>
  );
}

/**
 * The one ring: something is running. A 12 px ring with an accent arc that turns once a second; under
 * reduced motion it stays still and keeps its meaning.
 */
export function RunningRing({ className }: { className?: string }) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-3 shrink-0 rounded-full border-2 border-surface-selected",
        "border-t-accent border-r-accent motion-safe:animate-spin",
        className
      )}
    />
  );
}
