import { useId } from "react";
import { Archive, FileWarning } from "lucide-react";
import type { MessageKey } from "@app/i18n";
import type { obsidianWikiRetiredSchema } from "../../shared/ipc";
import type { z } from "zod";
import { Button } from "./ui/button";

type Retired = z.infer<typeof obsidianWikiRetiredSchema>;

const reasonKey = {
  edited: "obsidianWiki.retiredReasonEdited",
  unverified: "obsidianWiki.retiredReasonUnverified",
  unsafe: "obsidianWiki.retiredReasonUnsafe",
  limit: "obsidianWiki.retiredReasonLimit"
} as const satisfies Record<Retired["kept"][number]["reason"], MessageKey>;

/**
 * What became of the old wiki's vault files: how many moved to recovery, and the edited ones that
 * stayed where they are, each with a "Move to recovery" action. Nothing is shown until a file was retired.
 */
export function ObsidianRetiredReport({
  t,
  retired,
  busy,
  active,
  onMove
}: {
  t: (key: MessageKey) => string;
  retired: Retired;
  busy: boolean;
  active: boolean;
  onMove: (id: string) => void;
}) {
  const prefix = useId();
  if (!retired.archived && !retired.absent && !retired.keptTotal) return null;
  const hidden = retired.keptTotal - retired.kept.length;
  return (
    <section
      aria-labelledby={`${prefix}-title`}
      data-testid="obsidian-retired-report"
      className="grid gap-2 rounded-xl border border-border bg-surface p-3"
    >
      <h4 id={`${prefix}-title`} className="flex items-center gap-2 text-sm font-medium">
        <Archive size={16} aria-hidden="true" />
        {t("obsidianWiki.retiredTitle")}
      </h4>
      <p className="text-xs text-muted-foreground">{t("obsidianWiki.retiredHint")}</p>
      <dl aria-live="polite" className="grid grid-cols-[1fr_auto] gap-x-4 gap-y-1 text-sm">
        <dt>{t("obsidianWiki.retiredArchived")}</dt>
        <dd className="text-right font-medium">{retired.archived}</dd>
        {retired.absent > 0 && (
          <>
            <dt>{t("obsidianWiki.retiredAbsent")}</dt>
            <dd className="text-right font-medium">{retired.absent}</dd>
          </>
        )}
        <dt>{t("obsidianWiki.retiredKept")}</dt>
        <dd className="text-right font-medium">{retired.keptTotal}</dd>
      </dl>
      {retired.kept.length > 0 && (
        <ul className="grid gap-2" aria-label={t("obsidianWiki.retiredKept")}>
          {retired.kept.map((file, index) => (
            <li key={file.id} className="flex min-w-0 items-center gap-3 rounded-lg bg-soft p-3">
              <FileWarning size={16} className="shrink-0 text-warning" aria-hidden="true" />
              <span className="min-w-0 flex-1">
                <span id={`${prefix}-file-${index}`} className="block break-words text-xs">
                  {file.relativePath}
                </span>
                <span className="block text-xs text-muted-foreground">
                  {t(reasonKey[file.reason])}
                </span>
              </span>
              <Button
                disabled={busy || !active}
                aria-describedby={`${prefix}-file-${index}`}
                onClick={() => onMove(file.id)}
              >
                {t("obsidianWiki.retiredMove")}
              </Button>
            </li>
          ))}
        </ul>
      )}
      {hidden > 0 && (
        <p className="text-xs text-muted-foreground">{t("obsidianWiki.retiredMore")}</p>
      )}
    </section>
  );
}
