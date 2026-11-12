import { useId, useState } from "react";
import { ChevronDown } from "lucide-react";
import type { MessageKey } from "@app/i18n";

import { Button } from "../../../components/ui/button";
import { Skeleton } from "../../../components/ui/skeleton";
import { ObsidianEditorialCard } from "../../../components/ObsidianEditorialCard";
import { ObsidianRetiredReport } from "../../../components/ObsidianRetiredReport";
import {
  DeliveryProgress,
  ObsidianFailedFiles,
  ProjectionDiff,
  isFailedFile
} from "../../../components/ObsidianWikiCard";
import { cn } from "../../../lib/cn";
import { StatusLine } from "../../SettingControls";
import { useSettings } from "../../settings-context";
import { useEditorialConflicts, type WikiHandle } from "./use-integrations-data";

type Diff = Awaited<ReturnType<typeof window.app.obsidian.wikiDiff>>;

const errorKeys = ["conflict", "binding", "paused", "limit", "format", "write"] as const;
const errorMessage = (error: string | null): MessageKey =>
  `obsidianWiki.errors.${errorKeys.find((key) => error?.includes(key)) ?? "write"}`;

const failureKey = (cause: unknown): MessageKey => {
  const text = String(cause);
  if (text.includes("conflict")) return "obsidianWiki.errors.conflict";
  if (text.includes("paused")) return "obsidianWiki.errors.paused";
  if (text.includes("unsafe_obsidian")) return "obsidianWiki.errors.retiredMove";
  if (text.includes("binding")) return "obsidianWiki.errors.binding";
  if (text.includes("write")) return "obsidianWiki.errors.write";
  return "obsidianWiki.errors.load";
};

/**
 * What the vault projection leaves for the person to look at (Settings › Integrations › Obsidian):
 * pages edited in Obsidian while Memora changed them too, files that could not be written, the old
 * wiki's files that stayed, and the edits the paired plugin sent. It sits under the Obsidian rows as
 * one quiet line that opens in place; it opens by itself when something waits for review.
 */
export function ObsidianReview({ handle }: { handle: WikiHandle }) {
  const { t } = useSettings();
  const { wiki } = handle;
  const [diff, setDiff] = useState<Diff | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<MessageKey | null>(null);
  const [opened, setOpened] = useState<boolean | null>(null);
  const bodyId = useId();
  const editorial = useEditorialConflicts();

  if (wiki.status === "loading") return <Skeleton className="mt-3 h-4 w-48" />;
  // The Sources row already says the wiki status could not be read and offers the one retry.
  if (wiki.status === "failed") return null;

  const status = wiki.value;
  const failed = status.conflicts.filter(isFailedFile);
  const pending = status.conflicts.filter((row) => !isFailedFile(row));
  const retiredKept = status.retired.keptTotal;
  const waiting = pending.length + failed.length + retiredKept + (editorial.rows?.length ?? 0);
  const open = opened ?? waiting > 0;
  const working = status.job && ["queued", "running", "retrying"].includes(status.job.status);

  const act = async (work: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await work();
    } catch (cause) {
      setError(failureKey(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mt-4 grid gap-3">
      <button
        type="button"
        aria-expanded={open}
        aria-controls={bodyId}
        onClick={() => setOpened(!open)}
        className={cn(
          "flex w-fit max-w-full items-center gap-2 rounded-md border-0 bg-transparent p-0 text-left",
          "text-sm font-medium text-accent hover:text-accent-hover",
          "focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
        )}
      >
        <span>
          {t("settingsIntegrations.review.title")}
          {" · "}
          {waiting === 0
            ? t("settingsIntegrations.review.none")
            : t(
                waiting === 1
                  ? "settingsIntegrations.review.waitingOne"
                  : "settingsIntegrations.review.waitingMany",
                { values: { count: waiting } }
              )}
        </span>
        <ChevronDown
          aria-hidden="true"
          className={cn("size-3.5 shrink-0 transition-transform", open && "rotate-180")}
        />
      </button>
      {open ? (
        <div id={bodyId} className="grid max-w-[34rem] gap-3">
          {waiting === 0 ? (
            <p className="m-0 text-xs text-muted-foreground [text-wrap:pretty]">
              {t("settingsIntegrations.review.hint")}
            </p>
          ) : null}
          {error ? (
            <StatusLine tone="warn" role="status">
              {t(error)}
            </StatusLine>
          ) : null}
          {working ? (
            <StatusLine tone="working" role="status">
              {t("settingsIntegrations.review.working")}
            </StatusLine>
          ) : status.job?.status === "failed" ? (
            <StatusLine tone="warn" role="status">
              {t(errorMessage(status.job.error))}
            </StatusLine>
          ) : null}
          {status.delivery && status.delivery.total > 0 ? (
            <DeliveryProgress t={t} delivery={status.delivery} quiet />
          ) : null}
          <ObsidianFailedFiles t={t} failed={failed} />
          {pending.length > 0 ? (
            <div className="grid gap-2">
              <h4 className="m-0 text-sm font-medium text-foreground">
                {t("settingsIntegrations.review.bothSides")}
              </h4>
              {pending.map((row) => (
                <div
                  key={row.id}
                  className="flex min-w-0 items-center gap-3 rounded-lg bg-soft p-3"
                >
                  <span
                    id={`obsidian-pending-${row.id}`}
                    className="min-w-0 flex-1 text-xs [overflow-wrap:anywhere]"
                  >
                    {row.relative_path}
                  </span>
                  <Button
                    disabled={busy}
                    aria-describedby={`obsidian-pending-${row.id}`}
                    onClick={() =>
                      void act(async () => setDiff(await window.app.obsidian.wikiDiff(row.id)))
                    }
                  >
                    {t("obsidianWiki.review")}
                  </Button>
                </div>
              ))}
            </div>
          ) : null}
          <ObsidianRetiredReport
            t={t}
            retired={status.retired}
            busy={busy}
            active={status.active}
            onMove={(id) =>
              void act(async () => handle.set(await window.app.obsidian.moveRetiredWiki({ id })))
            }
          />
          <ObsidianEditorialCard
            t={t}
            feed={editorial}
            heading={t("settingsIntegrations.review.plugin")}
          />
        </div>
      ) : null}
      {diff ? (
        <ProjectionDiff
          error={error}
          t={t}
          diff={diff}
          busy={busy}
          active={status.active}
          onClose={() => setDiff(null)}
          onRecover={() =>
            void act(async () => {
              handle.set(
                await window.app.obsidian.recoverWiki({ id: diff.id, expectedHash: diff.localHash })
              );
              setDiff(null);
            })
          }
        />
      ) : null}
    </div>
  );
}
