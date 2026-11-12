import type { Translator } from "@app/i18n";

import { cn } from "../lib/cn";

/**
 * The "changed from default" marker of Settings v2 (docs/f5-decisions.md D18, Q36): a grey dot and
 * the word. Grey, because the row's own 2 px accent bar carries the emphasis and a second loud
 * colour would shout; the word, because a dot alone is colour as the only signal.
 */
export function ChangedMarker({ t, className }: { t: Translator; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 whitespace-nowrap text-xs font-semibold leading-5 text-secondary-foreground",
        className
      )}
    >
      <ChangedDot />
      {t("settingsShell.row.changed")}
    </span>
  );
}

/**
 * The dot alone, for a count in the section column, whose number says the rest. There it is the
 * accent, so a changed section stands out from its grey description; in a row it stays grey.
 */
export function ChangedDot({
  tone = "muted",
  className
}: {
  tone?: "muted" | "accent";
  className?: string;
}) {
  return (
    <span
      aria-hidden="true"
      className={cn(
        "inline-block size-1.5 shrink-0 rounded-full",
        tone === "accent" ? "bg-accent" : "bg-muted-foreground",
        className
      )}
    />
  );
}
