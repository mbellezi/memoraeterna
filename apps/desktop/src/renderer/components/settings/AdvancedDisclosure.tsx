import type { ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { MessageKey } from "@app/i18n";
import { cn } from "../../lib/cn";

/**
 * An Advanced disclosure of Settings (F4 D33, E7). What sits inside is not counted among the
 * settings that change what the app does by itself, so the registry places it in `advanced`. It is
 * a native `<details>`: closed until opened, operable with Enter or Space, with a visible focus.
 */
export function AdvancedDisclosure({
  t,
  hint,
  nested = false,
  children
}: {
  t: (key: MessageKey) => string;
  hint: string;
  /** Inside a card: a plain disclosure, not a card of its own. */
  nested?: boolean;
  children: ReactNode;
}) {
  return (
    <details
      className={cn(
        "group min-w-0",
        nested
          ? "border-t border-border pt-3"
          : "rounded-2xl border border-border bg-surface p-5 shadow-sm"
      )}
    >
      <summary
        className={cn(
          "flex cursor-pointer list-none items-center gap-2 rounded-md text-sm font-semibold",
          "text-foreground focus-visible:outline-2 focus-visible:outline-offset-2",
          "focus-visible:outline-accent [&::-webkit-details-marker]:hidden"
        )}
      >
        <ChevronRight
          className="size-4 shrink-0 transition-transform group-open:rotate-90 motion-reduce:transition-none"
          aria-hidden="true"
        />
        {t("settings.advanced.title")}
      </summary>
      <p className="mt-2 text-xs leading-5 text-muted-foreground">{hint}</p>
      <div className="mt-4 grid min-w-0 gap-5">{children}</div>
    </details>
  );
}
