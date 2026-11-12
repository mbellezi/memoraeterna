import type { ComponentPropsWithRef } from "react";

import { cn } from "../lib/cn";

/**
 * An action that reads as a link inside a line of text ("Restore default", "Clear the search"): the
 * accent colour, medium weight, an underline on hover and a focus ring. Settings uses it where a
 * 34 px button would break the rhythm of a help line.
 */
export function InlineAction({
  className,
  type = "button",
  ...props
}: ComponentPropsWithRef<"button">) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex min-w-0 items-center gap-1 rounded-sm border-0 bg-transparent p-0 text-left text-sm font-medium text-accent",
        "hover:text-accent-hover hover:underline hover:underline-offset-[3px]",
        "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent",
        "disabled:cursor-default disabled:text-muted-foreground disabled:no-underline [&>svg]:size-3.5 [&>svg]:shrink-0",
        className
      )}
      {...props}
    />
  );
}
