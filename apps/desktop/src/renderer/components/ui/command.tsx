import type { ComponentPropsWithoutRef } from "react";
import { Command as CommandPrimitive } from "cmdk";
import { cn } from "../../lib/cn";

/**
 * cmdk on the tokens, for the palette (Cmd-K). cmdk owns the listbox semantics (`role=listbox`,
 * `role=option`, `aria-selected`, the active descendant) and the arrow-key movement. The palette
 * passes `shouldFilter={false}` because its rows come from `search.omni`, ranked by the service.
 * The selected row takes the selection tint and a 2 px accent bar: the tint alone is 1.16:1.
 */
export function Command({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof CommandPrimitive>) {
  return (
    <CommandPrimitive
      className={cn(
        "flex min-h-0 w-full flex-col overflow-hidden bg-surface text-foreground",
        className
      )}
      {...props}
    />
  );
}

/** The 56 px input row: lead size, no outline of its own (the palette frame carries the focus). */
export function CommandInput({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof CommandPrimitive.Input>) {
  return (
    <CommandPrimitive.Input
      className={cn(
        "h-14 w-full min-w-0 border-0 bg-transparent px-5 text-lg text-foreground outline-none placeholder:text-muted-foreground",
        className
      )}
      {...props}
    />
  );
}

export function CommandList({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof CommandPrimitive.List>) {
  return (
    <CommandPrimitive.List
      className={cn("min-h-0 overflow-y-auto overscroll-contain p-2", className)}
      {...props}
    />
  );
}

/** What the list says when nothing matches; the palette passes a sentence that teaches the next step. */
export function CommandEmpty({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof CommandPrimitive.Empty>) {
  return (
    <CommandPrimitive.Empty
      className={cn(
        "px-3 py-6 text-center text-sm text-secondary-foreground [text-wrap:pretty]",
        className
      )}
      {...props}
    />
  );
}

export function CommandLoading({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof CommandPrimitive.Loading>) {
  return (
    <CommandPrimitive.Loading
      className={cn("px-3 py-2 text-sm text-secondary-foreground", className)}
      {...props}
    />
  );
}

export function CommandGroup({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof CommandPrimitive.Group>) {
  return (
    <CommandPrimitive.Group
      className={cn(
        "[&_[cmdk-group-heading]]:flex [&_[cmdk-group-heading]]:items-center [&_[cmdk-group-heading]]:justify-between",
        "[&_[cmdk-group-heading]]:gap-2 [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:pb-1 [&_[cmdk-group-heading]]:pt-3",
        "[&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-secondary-foreground",
        className
      )}
      {...props}
    />
  );
}

export function CommandItem({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof CommandPrimitive.Item>) {
  return (
    <CommandPrimitive.Item
      className={cn(
        "relative flex min-h-10 w-full cursor-default select-none items-center gap-3 rounded-md px-3 py-2",
        "text-base text-foreground outline-none [&>svg]:size-4 [&>svg]:shrink-0",
        "data-[disabled=true]:pointer-events-none data-[disabled=true]:text-muted-foreground",
        "data-[selected=true]:bg-surface-selected data-[selected=true]:shadow-[inset_2px_0_0_var(--accent)]",
        className
      )}
      {...props}
    />
  );
}

export function CommandSeparator({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof CommandPrimitive.Separator>) {
  return (
    <CommandPrimitive.Separator className={cn("-mx-2 my-2 h-px bg-border", className)} {...props} />
  );
}

/** The keycap text at the right of a row; plain text, so the row's accessible name stays its label. */
export function CommandShortcut({ className, ...props }: ComponentPropsWithoutRef<"span">) {
  return (
    <span
      className={cn("ml-auto shrink-0 text-xs tabular-nums text-secondary-foreground", className)}
      {...props}
    />
  );
}
