import type { ReactNode } from "react";
import { cn } from "../../lib/cn";

/**
 * The empty state of a view: a dashed strong outline, a sentence that teaches the next action and
 * the action itself (design record 5.12). Empty never looks like loading: no grey bars, no motion.
 * `variant="page"` is the roomy form with a serif display headline, for a surface that is empty
 * as a whole; `inline` is for a list or a column; `compact` is the narrow-column form (the navigator).
 */
export function EmptyState({
  headline,
  children,
  action,
  icon,
  variant = "inline",
  className
}: {
  headline?: ReactNode;
  /** The teaching copy: what this place is for and what to do first. */
  children?: ReactNode;
  /** The primary action, usually one `Button`. */
  action?: ReactNode;
  icon?: ReactNode;
  variant?: "inline" | "page" | "compact";
  className?: string;
}) {
  const page = variant === "page";
  const compact = variant === "compact";
  return (
    <div
      className={cn(
        "grid min-w-0 justify-items-start gap-3 rounded-lg border-[1.5px] border-dashed border-border-strong text-secondary-foreground",
        page ? "p-8" : compact ? "gap-2 p-3" : "p-4",
        className
      )}
    >
      {icon ? (
        <span aria-hidden="true" className="text-muted-foreground [&>svg]:size-5">
          {icon}
        </span>
      ) : null}
      {headline ? (
        <p
          className={cn(
            "m-0 min-w-0 text-foreground",
            page
              ? "font-reading text-2xl font-semibold [text-wrap:balance]"
              : compact
                ? "text-sm font-semibold [text-wrap:pretty]"
                : "text-base font-semibold [text-wrap:pretty]"
          )}
        >
          {headline}
        </p>
      ) : null}
      {children ? (
        <div className="min-w-0 max-w-(--measure) text-sm [text-wrap:pretty]">{children}</div>
      ) : null}
      {action ? <div className="flex flex-wrap items-center gap-2 pt-1">{action}</div> : null}
    </div>
  );
}
