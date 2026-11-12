import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { DropdownMenu as MenuPrimitive } from "radix-ui";
import { Check, Circle } from "lucide-react";
import { cn } from "../../lib/cn";
import { Kbd } from "./kbd";
import { popSurface } from "./popover";

/*
 * The classes below are shared with `context-menu.tsx`: a menu opened by a button and a menu opened
 * by a right click look and sound the same. A highlighted row takes the hover tint; on keyboard
 * focus it shows the inset accent ring instead and no tint (design record 4.8).
 */
export const menuContentClass = cn(popSurface, "min-w-56 max-w-96 overflow-auto p-2");
export const menuItemClass = cn(
  "relative flex w-full cursor-default select-none items-center gap-3 rounded-md px-2 py-2",
  "text-sm text-foreground outline-none",
  "data-[disabled]:pointer-events-none data-[disabled]:text-muted-foreground",
  "data-[highlighted]:not-focus-visible:bg-surface-hover",
  "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-accent",
  "[&>svg]:size-4 [&>svg]:shrink-0 [&>svg]:text-secondary-foreground"
);
export const menuLabelClass = "px-2 pb-1 pt-2 text-xs font-semibold text-secondary-foreground";
export const menuSeparatorClass = "-mx-2 my-2 h-px bg-border";

/** The row's content: an optional icon, the label with an optional second line, an optional keycap. */
export function MenuItemBody({
  icon,
  description,
  shortcut,
  children
}: {
  icon?: ReactNode;
  /** A second, quieter line under the label. */
  description?: ReactNode;
  /** The shortcut as text ("⌘N"); it is drawn as a keycap (`Kbd`), not a variable message part. */
  shortcut?: string;
  children?: ReactNode;
}) {
  return (
    <>
      {icon ? <span aria-hidden="true">{icon}</span> : null}
      <span className="grid min-w-0 flex-1">
        <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
        {description ? (
          <span className="min-w-0 text-xs text-muted-foreground [text-wrap:pretty]">
            {description}
          </span>
        ) : null}
      </span>
      {shortcut ? <Kbd className="shrink-0">{shortcut}</Kbd> : null}
    </>
  );
}

export const DropdownMenu = MenuPrimitive.Root;
export const DropdownMenuTrigger = MenuPrimitive.Trigger;
export const DropdownMenuGroup = MenuPrimitive.Group;
export const DropdownMenuRadioGroup = MenuPrimitive.RadioGroup;

type ContentProps = ComponentPropsWithoutRef<typeof MenuPrimitive.Content> & {
  /** Render in place instead of in a portal (tests and screens render the content inline). */
  portal?: boolean;
};

/** Arrow keys move, type-ahead jumps, Esc closes and focus returns to the trigger. */
export function DropdownMenuContent({
  className,
  sideOffset = 6,
  collisionPadding = 8,
  portal = true,
  ...props
}: ContentProps) {
  const content = (
    <MenuPrimitive.Content
      sideOffset={sideOffset}
      collisionPadding={collisionPadding}
      className={cn(
        menuContentClass,
        "max-h-(--radix-dropdown-menu-content-available-height)",
        className
      )}
      {...props}
    />
  );
  return portal ? <MenuPrimitive.Portal>{content}</MenuPrimitive.Portal> : content;
}

type ItemProps = ComponentPropsWithoutRef<typeof MenuPrimitive.Item> & {
  icon?: ReactNode;
  description?: ReactNode;
  shortcut?: string;
};

export function DropdownMenuItem({
  className,
  icon,
  description,
  shortcut,
  children,
  ...props
}: ItemProps) {
  return (
    <MenuPrimitive.Item className={cn(menuItemClass, className)} {...props}>
      <MenuItemBody
        {...(icon ? { icon } : {})}
        {...(description ? { description } : {})}
        {...(shortcut ? { shortcut } : {})}
      >
        {children}
      </MenuItemBody>
    </MenuPrimitive.Item>
  );
}

export function DropdownMenuCheckboxItem({
  className,
  children,
  ...props
}: ComponentPropsWithoutRef<typeof MenuPrimitive.CheckboxItem>) {
  return (
    <MenuPrimitive.CheckboxItem className={cn(menuItemClass, className)} {...props}>
      <span aria-hidden="true" className="inline-flex size-4 items-center justify-center">
        <MenuPrimitive.ItemIndicator>
          <Check />
        </MenuPrimitive.ItemIndicator>
      </span>
      <span className="min-w-0 flex-1">{children}</span>
    </MenuPrimitive.CheckboxItem>
  );
}

/**
 * A choice among several: a ring that fills with the accent when chosen (the choice is never the
 * colour alone: the dot is a shape), the label, and an optional quieter second line. A chosen row
 * takes the selected tint, so the current choice reads at a glance.
 */
export function DropdownMenuRadioItem({
  className,
  children,
  description,
  ...props
}: ComponentPropsWithoutRef<typeof MenuPrimitive.RadioItem> & {
  /** A second, quieter line under the label. */
  description?: ReactNode;
}) {
  return (
    <MenuPrimitive.RadioItem
      className={cn(
        menuItemClass,
        "items-start data-[state=checked]:bg-surface-selected data-[state=checked]:data-[highlighted]:not-focus-visible:bg-surface-selected",
        className
      )}
      {...props}
    >
      <span
        aria-hidden="true"
        className="relative mt-0.5 inline-flex size-4 shrink-0 rounded-full border border-border-strong"
      >
        <MenuPrimitive.ItemIndicator className="absolute -inset-px flex items-center justify-center rounded-full border border-accent">
          <Circle className="size-2 fill-accent text-accent" />
        </MenuPrimitive.ItemIndicator>
      </span>
      <span className="grid min-w-0 flex-1">
        <span className="min-w-0 [overflow-wrap:anywhere]">{children}</span>
        {description ? (
          <span className="min-w-0 text-xs text-muted-foreground [text-wrap:pretty]">
            {description}
          </span>
        ) : null}
      </span>
    </MenuPrimitive.RadioItem>
  );
}

export function DropdownMenuLabel({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof MenuPrimitive.Label>) {
  return <MenuPrimitive.Label className={cn(menuLabelClass, className)} {...props} />;
}

export function DropdownMenuSeparator({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator className={cn(menuSeparatorClass, className)} {...props} />;
}
