import type { ComponentPropsWithoutRef } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";
import { cn } from "../../lib/cn";

/**
 * What every floating surface shares (popover, hover card, menus): the raised sheet, the pop
 * shadow, the 12 px radius, an entrance of `--motion-base` on `--ease-out` and an exit of
 * `--motion-fast`. Both animations are zero under reduced motion (`tokens.css`).
 */
export const popIn =
  "data-[state=open]:animate-[ui-pop-in_var(--motion-base)_var(--ease-out)_both]";
export const fadeOut =
  "data-[state=closed]:animate-[ui-fade-out_var(--motion-fast)_var(--ease-in-out)_both]";
export const popSurface = cn(
  "z-50 rounded-xl bg-surface text-foreground shadow-[var(--shadow-pop)] outline-none",
  popIn,
  fadeOut
);

export const Popover = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverAnchor = PopoverPrimitive.Anchor;
export const PopoverClose = PopoverPrimitive.Close;

type PopoverContentProps = ComponentPropsWithoutRef<typeof PopoverPrimitive.Content> & {
  /** Render in place instead of in a portal (tests and screens render the content inline). */
  portal?: boolean;
};

/** A non-modal floating panel: Esc and a click outside close it, focus returns to the trigger. */
export function PopoverContent({
  className,
  sideOffset = 6,
  collisionPadding = 8,
  portal = true,
  ...props
}: PopoverContentProps) {
  const content = (
    <PopoverPrimitive.Content
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      className={cn(
        popSurface,
        "max-h-(--radix-popover-content-available-height) overflow-auto p-3",
        className
      )}
      {...props}
    />
  );
  return portal ? <PopoverPrimitive.Portal>{content}</PopoverPrimitive.Portal> : content;
}
