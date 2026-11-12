import type { Translator } from "@app/i18n";

import { cn } from "../../lib/cn";
import { Kbd } from "../ui/kbd";
import type { InboxKeyRow } from "./inbox-keys";

/**
 * The `?` sheet and the key bar of the Inbox (design record §7.4). Both are built from the rows of
 * `keyRows()`, so each lists only the keys the selected item offers.
 */

const helpButtonClass = cn(
  "inline-flex items-center gap-1.5 rounded-sm border-0 bg-transparent p-0 text-xs",
  "text-secondary-foreground hover:text-foreground",
  "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
);

/** A key as the bar draws it: Enter is "↵". */
const drawn = (key: string): string => (key === "Enter" ? "↵" : key);

/** The sheet over the screen: every offered key, what it does, and the two notes on when keys work. */
export function KeySheet({
  t,
  id,
  rows,
  className
}: {
  t: Translator;
  id: string;
  rows: readonly InboxKeyRow[];
  className?: string;
}) {
  return (
    <section
      id={id}
      aria-label={t("inbox.keys.title")}
      className={cn(
        "absolute z-20 flex w-80 max-w-[calc(100vw-3rem)] flex-col gap-2 rounded-lg border border-border-strong bg-surface p-3 shadow-lg",
        className
      )}
    >
      <h2 className="text-xs font-semibold text-secondary-foreground">{t("inbox.keys.title")}</h2>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs text-foreground">
        {rows.map((row) => (
          <div key={row.label} className="contents">
            <dt className="flex gap-1">
              {row.keys.map((key) => (
                <kbd
                  key={key}
                  className="rounded-sm border border-border-strong bg-soft px-1.5 font-sans font-medium"
                >
                  {key}
                </kbd>
              ))}
            </dt>
            <dd>{t(row.label)}</dd>
          </div>
        ))}
      </dl>
      <p className="text-xs text-muted-foreground">{t("inbox.keys.note")}</p>
      <p className="text-xs text-muted-foreground">{t("inbox.keys.money")}</p>
    </section>
  );
}

/**
 * The 40 px key bar at the foot of the destination: "↑↓ J K navegar · ↵ abrir · A aceitar · …
 * ? atalhos", and at the right the note that one-key shortcuts stay out of text fields (dropped
 * below 1180 px). The `?` entry is the button that opens the sheet.
 */
export function KeyBar({
  t,
  rows,
  helpOpen,
  helpId,
  onToggleHelp,
  className
}: {
  t: Translator;
  rows: readonly InboxKeyRow[];
  helpOpen: boolean;
  helpId: string;
  onToggleHelp: () => void;
  className?: string;
}) {
  const help = rows.find((row) => row.label === "inbox.keys.help");
  const rest = rows.filter((row) => row !== help);
  return (
    <footer
      aria-label={t("inbox.keys.title")}
      className={cn(
        "flex h-10 shrink-0 items-center gap-x-4 overflow-hidden whitespace-nowrap border-t border-border bg-surface px-6 text-xs text-secondary-foreground max-[1179px]:px-4",
        className
      )}
    >
      <ul className="m-0 flex min-w-0 list-none items-center gap-x-4 p-0">
        {rest.map((row) => (
          <li key={row.label} className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="inline-flex gap-1">
              {(row.label === "inbox.keys.move" ? ["↑↓", ...row.keys] : row.keys).map((key) => (
                <Kbd key={key}>{drawn(key)}</Kbd>
              ))}
            </span>
            <span>{t(row.short)}</span>
          </li>
        ))}
        {help ? (
          <li className="inline-flex items-center">
            <button
              type="button"
              aria-expanded={helpOpen}
              aria-controls={helpId}
              aria-keyshortcuts="?"
              onClick={onToggleHelp}
              className={helpButtonClass}
            >
              <Kbd>?</Kbd>
              {t(help.short)}
            </button>
          </li>
        ) : null}
      </ul>
      <span className="ml-auto text-muted-foreground max-[1179px]:hidden">
        {t("inbox.keys.barNote")}
      </span>
    </footer>
  );
}
