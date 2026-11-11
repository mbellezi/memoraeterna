import { useId, useState, type ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import type { Translator } from "@app/i18n";
import { cn } from "../../lib/cn";
import { Button } from "./button";
import { SolidTriangle } from "./solid-glyphs";

/**
 * The error state of a view, shown in place (never a modal, never `window.alert`) and never the
 * loudest thing on screen: a solid danger triangle, a plain sentence saying what failed, a muted
 * line saying what is kept, "Try again", and a "Details" disclosure for the technical text. There is
 * no fill and no box (design record 5.12): the glyph carries the state, the words carry the rest.
 * `role="alert"` announces it once; the retry control keeps the failure retryable. It sits at the
 * reading measure unless a caller widens it.
 */
export function ErrorState({
  t,
  message,
  kept,
  onRetry,
  details,
  className
}: {
  t: Translator;
  /** What failed, in the person's words. */
  message: ReactNode;
  /** What is kept ("Your notes are safe"), when it matters. */
  kept?: ReactNode;
  onRetry?: () => void;
  /** Technical text for the disclosure; it never replaces `message`. */
  details?: string;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  return (
    <div
      role="alert"
      className={cn(
        "grid min-w-0 max-w-(--measure) grid-cols-[auto_minmax(0,1fr)] gap-x-2 gap-y-2 text-sm text-foreground",
        className
      )}
    >
      <SolidTriangle className="mt-0.5 text-danger" />
      <div className="grid min-w-0 gap-1 [text-wrap:pretty]">
        <p className="m-0 min-w-0 font-semibold">{message}</p>
        {kept ? <p className="m-0 text-secondary-foreground">{kept}</p> : null}
      </div>
      {onRetry || details ? (
        <div className="col-start-2 flex flex-wrap items-center gap-2">
          {onRetry ? (
            <Button variant="secondary" onClick={onRetry}>
              {t("ui.retry")}
            </Button>
          ) : null}
          {details ? (
            <Button
              variant="ghost"
              aria-expanded={open}
              aria-controls={detailsId}
              onClick={() => setOpen((value) => !value)}
            >
              {t("ui.details")}
              <ChevronDown
                aria-hidden="true"
                className={cn("transition-transform", open && "rotate-180")}
              />
            </Button>
          ) : null}
        </div>
      ) : null}
      {details && open ? (
        <pre
          id={detailsId}
          className="col-start-2 m-0 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface p-3 text-xs text-secondary-foreground [overflow-wrap:anywhere]"
        >
          {details}
        </pre>
      ) : null}
    </div>
  );
}
