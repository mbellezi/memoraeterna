import type { ComponentPropsWithoutRef, ReactElement, ReactNode } from "react";
import { Tooltip as TooltipPrimitive } from "radix-ui";
import { cn } from "../../lib/cn";

export const tooltipDelayMs = 500;

/**
 * The name and shortcut of an icon-only or non-obvious control. The control keeps its own
 * accessible name (`aria-label`); the tooltip adds the label sighted people see, on hover and on
 * keyboard focus. `children` is the one control that triggers it.
 */
export function Tooltip({
  label,
  shortcut,
  children,
  side = "bottom",
  portal = true,
  className,
  ...rootProps
}: {
  label: ReactNode;
  /** The shortcut written as text ("⌘K"). */
  shortcut?: string;
  children: ReactElement;
  side?: ComponentPropsWithoutRef<typeof TooltipPrimitive.Content>["side"];
  portal?: boolean;
  className?: string;
} & Omit<ComponentPropsWithoutRef<typeof TooltipPrimitive.Root>, "children">) {
  const content = (
    <TooltipPrimitive.Content
      side={side}
      sideOffset={6}
      collisionPadding={8}
      className={cn(
        "z-50 flex max-w-64 items-center gap-2 rounded-md bg-foreground px-2 py-1 text-xs font-medium",
        "text-background shadow-[var(--shadow-pop)]",
        "data-[state=delayed-open]:animate-[ui-pop-in_var(--motion-fast)_var(--ease-out)_both]",
        "data-[state=instant-open]:animate-[ui-pop-in_var(--motion-fast)_var(--ease-out)_both]",
        className
      )}
    >
      <span className="min-w-0 [text-wrap:pretty]">{label}</span>
      {shortcut ? <span className="shrink-0 font-semibold tabular-nums">{shortcut}</span> : null}
    </TooltipPrimitive.Content>
  );
  return (
    <TooltipPrimitive.Provider delayDuration={tooltipDelayMs} skipDelayDuration={200}>
      <TooltipPrimitive.Root {...rootProps}>
        <TooltipPrimitive.Trigger asChild>{children}</TooltipPrimitive.Trigger>
        {portal ? <TooltipPrimitive.Portal>{content}</TooltipPrimitive.Portal> : content}
      </TooltipPrimitive.Root>
    </TooltipPrimitive.Provider>
  );
}
