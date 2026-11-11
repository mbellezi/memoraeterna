import type { ComponentPropsWithoutRef, ReactNode } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { X } from "lucide-react";
import type { Translator } from "@app/i18n";
import { cn } from "../../lib/cn";
import { fadeOut, popSurface } from "./popover";

export const Dialog = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

const widths = { sm: "w-96", md: "w-128", lg: "w-160" } as const;

/** Names the dialog for assistive technology without drawing a heading. */
const hiddenTitle = "sr-only";

type DialogContentProps = Omit<
  ComponentPropsWithoutRef<typeof DialogPrimitive.Content>,
  "title" | "children"
> & {
  t: Translator;
  /** The dialog's accessible name; shown as its heading unless `hideTitle`. */
  title: ReactNode;
  hideTitle?: boolean;
  description?: ReactNode;
  size?: keyof typeof widths;
  /** The corner close control; Esc and a click on the scrim close the dialog either way. */
  showClose?: boolean;
  /** Render in place instead of in a portal (tests and screens render the content inline). */
  portal?: boolean;
  children?: ReactNode;
};

/**
 * A modal dialog on the scrim: focus is trapped and returns to the trigger, Esc closes it and the
 * rest of the window is inert. Use it for a decision that must be made before anything else; a
 * preview or a hover card is never modal (`Sheet`, `HoverCard`).
 */
export function DialogContent({
  t,
  title,
  hideTitle = false,
  description,
  size = "md",
  showClose = true,
  portal = true,
  className,
  children,
  ...props
}: DialogContentProps) {
  const body = (
    <>
      <DialogPrimitive.Overlay
        className={cn(
          "fixed inset-0 z-40 bg-[var(--scrim)]",
          "data-[state=open]:animate-[ui-fade-in_var(--motion-base)_var(--ease-out)_both]",
          fadeOut
        )}
      />
      <DialogPrimitive.Content
        {...(description ? {} : { "aria-describedby": undefined })}
        className={cn(
          "fixed left-1/2 top-1/2 grid max-h-[calc(100vh-var(--space-12))] max-w-[calc(100%-var(--space-8))]",
          "-translate-x-1/2 -translate-y-1/2 gap-3 overflow-auto p-6",
          popSurface,
          widths[size],
          className
        )}
        {...props}
      >
        <DialogPrimitive.Title
          className={cn(
            hideTitle
              ? hiddenTitle
              : "m-0 pr-8 font-reading text-xl font-semibold [text-wrap:balance]"
          )}
        >
          {title}
        </DialogPrimitive.Title>
        {description ? (
          <DialogPrimitive.Description className="m-0 text-sm text-secondary-foreground [text-wrap:pretty]">
            {description}
          </DialogPrimitive.Description>
        ) : null}
        {children}
        {showClose ? (
          <DialogPrimitive.Close
            aria-label={t("ui.close")}
            className={cn(
              "absolute right-3 top-3 inline-flex size-7 items-center justify-center rounded-md",
              "text-secondary-foreground transition-colors hover:bg-surface-hover hover:text-foreground",
              "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent [&>svg]:size-4"
            )}
          >
            <X aria-hidden="true" />
          </DialogPrimitive.Close>
        ) : null}
      </DialogPrimitive.Content>
    </>
  );
  return portal ? <DialogPrimitive.Portal>{body}</DialogPrimitive.Portal> : body;
}
