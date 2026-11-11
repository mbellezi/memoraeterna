import { useId, useState, type ReactNode } from "react";
import { AlertTriangle, ChevronDown } from "lucide-react";
import type { Translator } from "@app/i18n";
import { cn } from "../../lib/cn";
import { Button } from "./button";

/**
 * The error state of a view, shown in place (never a modal, never `window.alert`): a plain sentence
 * saying what failed, what is kept, "Retry", and a "Details" disclosure for the technical text.
 * `role="alert"` announces it once; the retry control keeps the failure retryable.
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
        "grid min-w-0 gap-3 rounded-lg border border-danger bg-danger-soft p-4 text-sm text-foreground",
        className
      )}
    >
      <div className="flex min-w-0 items-start gap-2">
        <AlertTriangle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-danger" />
        <div className="grid min-w-0 gap-1 [text-wrap:pretty]">
          <p className="m-0 font-semibold">{message}</p>
          {kept ? <p className="m-0 text-secondary-foreground">{kept}</p> : null}
        </div>
      </div>
      {onRetry || details ? (
        <div className="flex flex-wrap items-center gap-2">
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
          className="m-0 max-h-40 overflow-auto whitespace-pre-wrap rounded-md border border-border bg-surface p-3 text-xs text-secondary-foreground [overflow-wrap:anywhere]"
        >
          {details}
        </pre>
      ) : null}
    </div>
  );
}
