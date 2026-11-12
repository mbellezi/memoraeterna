import type { ComponentPropsWithRef } from "react";
import { cn } from "../../lib/cn";

type KbdProps = ComponentPropsWithRef<"kbd"> & {
  /** On a primary (accent) button the keycap is outlined in the on-solid colour. */
  tone?: "default" | "on-solid";
};

/**
 * A keycap: 12 px, 20 tall, a soft fill and a strong bottom border (design record 5.11). The
 * caller writes the key as text ("⌘K"), never as a variable part of a message key. The face is the
 * system font, not the interface font: the symbols of a keyboard (⌘ ⌥ ⇧ ↵ ↑ ↓) are drawn there at
 * the size of a letter, where Inter's draw at half of it and a key such as ⇧↵ reads as a smudge.
 */
export function Kbd({ className, tone = "default", ...props }: KbdProps) {
  return (
    <kbd
      className={cn(
        "inline-flex h-5 min-w-5 items-center justify-center whitespace-nowrap rounded-sm border px-1 text-xs font-medium leading-none tabular-nums [font-family:system-ui,-apple-system,sans-serif]",
        tone === "on-solid"
          ? "border-accent-foreground bg-transparent text-accent-foreground"
          : "border-border border-b-border-strong bg-soft text-secondary-foreground",
        className
      )}
      {...props}
    />
  );
}
