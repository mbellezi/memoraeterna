import type { ComponentPropsWithoutRef } from "react";
import { HoverCard as HoverCardPrimitive } from "radix-ui";
import { cn } from "../../lib/cn";
import { popSurface } from "./popover";

/** The card shows after hovering or focusing the anchor for this long (design record 10.1). */
export const hoverCardOpenDelayMs = 300;
export const hoverCardCloseDelayMs = 120;

/**
 * A hover card opens on pointer hover or on keyboard focus held for 300 ms, stays while the pointer
 * is on it, closes with Esc and never traps focus (WCAG 1.4.13). The caller puts it only on object
 * links and rows; a citation chip or a context-panel relation row shows no card.
 */
export function HoverCard({
  openDelay = hoverCardOpenDelayMs,
  closeDelay = hoverCardCloseDelayMs,
  ...props
}: ComponentPropsWithoutRef<typeof HoverCardPrimitive.Root>) {
  return <HoverCardPrimitive.Root openDelay={openDelay} closeDelay={closeDelay} {...props} />;
}

export const HoverCardTrigger = HoverCardPrimitive.Trigger;

type HoverCardContentProps = ComponentPropsWithoutRef<typeof HoverCardPrimitive.Content> & {
  /** Render in place instead of in a portal (tests and screens render the content inline). */
  portal?: boolean;
};

/** The card goes beside its anchor, never over it, and scrolls inside when it is tall. */
export function HoverCardContent({
  className,
  side = "right",
  align = "start",
  sideOffset = 8,
  collisionPadding = 8,
  portal = true,
  ...props
}: HoverCardContentProps) {
  const content = (
    <HoverCardPrimitive.Content
      side={side}
      align={align}
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      avoidCollisions
      className={cn(
        popSurface,
        "w-80 max-h-(--radix-hover-card-content-available-height) overflow-auto p-4",
        className
      )}
      {...props}
    />
  );
  return portal ? <HoverCardPrimitive.Portal>{content}</HoverCardPrimitive.Portal> : content;
}
