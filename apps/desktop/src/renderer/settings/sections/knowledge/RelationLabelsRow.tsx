import { useState } from "react";
import type { LanguageCode, Translator } from "@app/i18n";

import type { SettingEntryV2 } from "../../../../shared/settings-registry";
import { Button } from "../../../components/ui/button";
import { InlineAction } from "../../InlineAction";
import { RegistryRow } from "../../SettingRow";
import { ReadProblem, StatusLine } from "../../SettingControls";
import { useContentLanguage } from "../../use-content-language";
import { labelsView } from "./knowledge-model";
import { useRelationLabels } from "./use-knowledge-data";

const languageName = (locale: LanguageCode, code: LanguageCode): string =>
  new Intl.DisplayNames(locale, { type: "language" }).of(code) ?? code;

/**
 * The descriptions of the connections (Settings › Knowledge › Connections): generate the ones that
 * are missing, or write all of them again in the language of the notes. Writing all again replaces
 * what is there, so it asks first, in the row. The job moves by `job.progress` events; a failure
 * says so in one quiet line, what is kept, and the way to try again.
 */
export function RelationLabelsRow({ t, entry }: { t: Translator; entry: SettingEntryV2 }) {
  const labels = useRelationLabels();
  const language = useContentLanguage();
  const [asking, setAsking] = useState(false);
  const view = labelsView(labels.job);
  const working = view.kind === "working";
  const blocked = labels.busy || working || labels.loading || language === null;

  const start = (mode: "missing" | "all") => {
    if (language === null) return;
    setAsking(false);
    void labels.act(() =>
      window.app.knowledge.startRelationLabels({ mode, contentLanguage: language })
    );
  };

  const control = (
    <>
      <Button disabled={blocked} onClick={() => start("missing")}>
        {t("settingsKnowledge.labels.generateMissing")}
      </Button>
      <Button disabled={blocked || asking} onClick={() => setAsking(true)}>
        {t("settingsKnowledge.labels.rewriteAll")}
      </Button>
    </>
  );

  const note = (
    <div className="grid gap-2">
      {asking && language !== null ? (
        <div
          role="group"
          className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-foreground"
        >
          <span className="min-w-0 max-w-[27.5rem] [text-wrap:pretty]">
            {t("settingsKnowledge.labels.rewriteAsk", {
              values: { language: languageName(t.locale, language) }
            })}
          </span>
          <span className="flex gap-2">
            <Button variant="secondary" onClick={() => start("all")}>
              {t("settingsKnowledge.labels.rewriteConfirm")}
            </Button>
            <Button variant="ghost" onClick={() => setAsking(false)}>
              {t("shell.actions.cancel")}
            </Button>
          </span>
        </div>
      ) : null}
      {view.kind === "working" ? (
        <div className="grid gap-1.5">
          <StatusLine tone="working" role="status">
            {t(
              view.queued ? "settingsKnowledge.labels.queued" : "settingsKnowledge.labels.running"
            )}
            {view.canCancel ? (
              <>
                {" "}
                <InlineAction
                  size="xs"
                  disabled={labels.busy}
                  onClick={() => void labels.act(() => window.app.jobs.cancel(view.jobId))}
                >
                  {t("shell.actions.cancel")}
                </InlineAction>
              </>
            ) : null}
          </StatusLine>
          {!view.queued ? (
            <div
              role="progressbar"
              aria-label={t("settingsKnowledge.labels.running")}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={Math.round(view.progress * 100)}
              className="h-1.5 w-56 max-w-full overflow-hidden rounded-full bg-soft [box-shadow:inset_0_0_0_1px_var(--border-strong)]"
            >
              <div
                className="h-full rounded-full bg-muted-foreground"
                style={{ width: `${Math.round(view.progress * 100)}%` }}
              />
            </div>
          ) : null}
        </div>
      ) : null}
      {view.kind === "done" && view.updated !== null ? (
        <StatusLine tone="ok" role="status">
          {t(
            view.updated === 1
              ? "settingsKnowledge.labels.doneOne"
              : "settingsKnowledge.labels.doneMany",
            { values: { count: view.updated } }
          )}
        </StatusLine>
      ) : null}
      {view.kind === "failed" ? (
        <StatusLine tone="warn" role="status">
          {t("settingsKnowledge.labels.failed")}{" "}
          {view.canRetry ? (
            <InlineAction
              size="xs"
              disabled={labels.busy}
              onClick={() => void labels.act(() => window.app.jobs.retry(view.jobId))}
            >
              {t("shell.actions.retry")}
            </InlineAction>
          ) : null}
        </StatusLine>
      ) : null}
      {labels.actionFailed && view.kind !== "failed" ? (
        <StatusLine tone="warn" role="status">
          {t("settingsKnowledge.labels.startFailed")}
        </StatusLine>
      ) : null}
      {labels.readFailed ? (
        <ReadProblem
          t={t}
          message={t("settingsKnowledge.labels.readFailed")}
          onRetry={labels.reload}
        />
      ) : null}
    </div>
  );

  return <RegistryRow entry={entry} stack control={control} note={note} />;
}
