import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { cn } from "../../lib/cn";
import { popSurface } from "./popover";

/**
 * A non-modal sheet, the quick-look surface (decision A4): a centred raised sheet with no scrim,
 * no focus trap and no scroll lock. The keyboard stays on the row underneath (opening and closing
 * do not move focus, and focus moving to another row does not close it), Esc and a click outside close it, and it never answers Cmd-W: the primitive
 * binds no shortcut of its own, the caller's keymap decides what Space, Cmd-Y and the arrows do.
 */
export function Sheet(props: Omit<ComponentPropsWithoutRef<typeof DialogPrimitive.Root>, "modal">) {
  return <DialogPrimitive.Root modal={false} {...props} />;
}

export const SheetClose = DialogPrimitive.Close;

type SheetContentProps = Omit<
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content>,
  "title" | "children"
> & {
  /** The sheet's accessible name (the object being looked at); it is not drawn. */
  title: string;
  /** Render in place instead of in a portal (tests and screens render the content inline). */
  portal?: boolean;
  children?: ReactNode;
};

export function SheetContent({
  title,
  portal = true,
  className,
  children,
  onOpenAutoFocus,
  onCloseAutoFocus,
  onFocusOutside,
  ...props
}: SheetContentProps) {
  const content = (
    <DialogPrimitive.Content
      aria-describedby={undefined}
      // A peek is not a dialog Cmd-W closes: `openDialogs` skips what carries this mark.
      data-non-modal=""
      onOpenAutoFocus={(event) => {
        // Focus stays on the row that was peeked at.
        event.preventDefault();
        onOpenAutoFocus?.(event);
      }}
      onCloseAutoFocus={(event) => {
        event.preventDefault();
        onCloseAutoFocus?.(event);
      }}
      onFocusOutside={(event) => {
        // Arrow keys move the row focus underneath while the sheet stays open to peek at the next
        // row: only Esc, a pointer-down outside and the caller's keys close it, never a focus move.
        event.preventDefault();
        onFocusOutside?.(event);
      }}
      className={cn(
        "fixed left-1/2 top-24 w-160 max-w-[calc(100%-var(--space-16))] -translate-x-1/2 overflow-hidden",
        popSurface,
        className
      )}
      {...props}
    >
      <DialogPrimitive.Title className="sr-only">{title}</DialogPrimitive.Title>
      {children}
    </DialogPrimitive.Content>
  );
  return portal ? <DialogPrimitive.Portal>{content}</DialogPrimitive.Portal> : content;
}

/** The head line: what is happening and which keys act ("Espiando · Espaço fecha"). */
export function SheetHeader({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn(
        "flex items-center gap-2 border-b border-border py-2 pl-5 pr-3 text-xs text-secondary-foreground",
        className
      )}
      {...props}
    />
  );
}

export function SheetBody({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return <div className={cn("grid gap-3 px-6 pb-6 pt-5", className)} {...props} />;
}

/** The foot line: the closing key and what stays ("A Biblioteca continua aqui"). */
export function SheetFooter({ className, ...props }: ComponentPropsWithoutRef<"div">) {
  return (
    <div
      className={cn(
        "flex items-center gap-4 border-t border-border px-5 py-2 text-xs text-secondary-foreground",
        className
      )}
      {...props}
    />
  );
}
