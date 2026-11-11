import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { ContextMenu as MenuPrimitive } from "radix-ui";
import { Check } from "lucide-react";
import { cn } from "../../lib/cn";
import {
  MenuItemBody,
  menuContentClass,
  menuItemClass,
  menuLabelClass,
  menuSeparatorClass
} from "./dropdown-menu";

export const ContextMenu = MenuPrimitive.Root;
export const ContextMenuTrigger = MenuPrimitive.Trigger;
export const ContextMenuGroup = MenuPrimitive.Group;

type ContentProps = ComponentPropsWithoutRef<typeof MenuPrimitive.Content> & {
  /** Render in place instead of in a portal (tests and screens render the content inline). */
  portal?: boolean;
};

/**
 * The menu a right click (or the context-menu key) opens on a row or a link. Every entry is also
 * reachable another way: a context menu is a shortcut, never the only door.
 */
export function ContextMenuContent({
  className,
  collisionPadding = 8,
  portal = true,
  ...props
}: ContentProps) {
  const content = (
    <MenuPrimitive.Content
      collisionPadding={collisionPadding}
      className={cn(
        menuContentClass,
        "max-h-(--radix-context-menu-content-available-height)",
        className
      )}
      {...props}
    />
  );
  return portal ? <MenuPrimitive.Portal>{content}</MenuPrimitive.Portal> : content;
}

export function ContextMenuItem({
  className,
  icon,
  description,
  shortcut,
  children,
  ...props
}: ComponentPropsWithoutRef<typeof MenuPrimitive.Item> & {
  icon?: ReactNode;
  description?: ReactNode;
  shortcut?: string;
}) {
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

export function ContextMenuCheckboxItem({
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

export function ContextMenuLabel({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof MenuPrimitive.Label>) {
  return <MenuPrimitive.Label className={cn(menuLabelClass, className)} {...props} />;
}

export function ContextMenuSeparator({
  className,
  ...props
}: ComponentPropsWithoutRef<typeof MenuPrimitive.Separator>) {
  return <MenuPrimitive.Separator className={cn(menuSeparatorClass, className)} {...props} />;
}
