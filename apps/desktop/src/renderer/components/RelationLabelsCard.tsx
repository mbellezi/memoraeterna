import { useEffect, useId, useState } from "react";
import { Languages } from "lucide-react";
import type { MessageKey } from "@app/i18n";
import { appLanguageCodes, type AppSettings, type AppSettingsUpdate, type JobRecord } from "../../shared/ipc";
import { Button } from "./ui/button";
import { Label } from "./ui/label";

type Props = { appSettings: AppSettings; onChange: (update: AppSettingsUpdate) => void; t: (key: MessageKey) => string };

export function ContentLanguageSelect({ appSettings, onChange, t }: Props) {
  const id = useId();
  return <div className="grid gap-2">
    <Label htmlFor={id}>{t("settings.language.contentLocale")}</Label>
    <select id={id} value={appSettings.contentLanguage} onChange={(event) => onChange({ contentLanguage: event.target.value as AppSettings["contentLanguage"] })}
      className="h-11 w-full rounded-xl border border-slate-300 bg-white px-3 text-sm dark:border-slate-700 dark:bg-slate-950">
      {appLanguageCodes.map((language) => <option key={language} value={language}>{t(`settings.language.languages.${language}` as MessageKey)}</option>)}
    </select>
    <p className="text-sm text-slate-500">{t("settings.language.contentDescription")}</p>
  </div>;
}

export function RelationLabelsCard(props: Props) {
  const { t } = props;
  const [job, setJob] = useState<JobRecord | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [actionFailed, setActionFailed] = useState(false);
  const [failed, setFailed] = useState(false);
  const [refresh, setRefresh] = useState(0);
  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const latest = await window.app.knowledge.relationLabelsStatus();
        if (active) { setJob(latest); setFailed(false); }
      } catch { if (active) setFailed(true); }
      finally { if (active) setLoading(false); }
    };
    void load();
    const timer = setInterval(() => void load(), 2_000);
    const unsubscribe = window.app.jobs.subscribe(() => void load());
    return () => { active = false; clearInterval(timer); unsubscribe(); };
  }, [refresh]);
  const running = job?.status === "queued" || job?.status === "running";
  async function act(action: () => Promise<unknown>) {
    setBusy(true); setActionFailed(false);
    try { await action(); setJob(await window.app.knowledge.relationLabelsStatus()); }
    catch { setActionFailed(true); }
    finally { setBusy(false); }
  }
  return <section className="grid gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
    <h3 className="flex items-center gap-3 font-semibold"><Languages className="h-5 w-5" aria-hidden="true" />{t("relationLabel.title")}</h3>
    <p className="text-sm text-slate-600 dark:text-slate-300">{t("relationLabel.description")}</p>
    <ContentLanguageSelect {...props} />
    <div className="flex flex-wrap gap-2">
      <Button disabled={loading || busy || running} onClick={() => void act(() => window.app.knowledge.startRelationLabels({ mode: "missing", contentLanguage: props.appSettings.contentLanguage }))}>{t("relationLabel.generateMissing")}</Button>
      <Button disabled={loading || busy || running} onClick={() => void act(() => window.app.knowledge.startRelationLabels({ mode: "all", contentLanguage: props.appSettings.contentLanguage }))}>{t("relationLabel.regenerate")}</Button>
      {running && <Button disabled={busy} onClick={() => void act(() => window.app.jobs.cancel(job.id))}>{t("shell.actions.cancel")}</Button>}
      {job?.canRetry && <Button disabled={busy} onClick={() => void act(() => window.app.jobs.retry(job.id))}>{t("shell.actions.retry")}</Button>}
    </div>
    <p role="status" className="text-sm text-slate-500">
      {loading ? t("shell.states.loading") : job ? t(`jobs.status.${job.status}` as MessageKey) : t("relationLabel.ready")}
      {job?.labelResult ? ` · ${t("relationLabel.updated")}: ${job.labelResult.updated} · ${t(`settings.language.languages.${job.labelResult.contentLanguage}` as MessageKey)}` : ""}
    </p>
    {(failed || actionFailed || job?.status === "failed") && <div role="alert" className="text-sm text-red-600">
      {t("relationLabel.failed")}
      {failed && <Button onClick={() => setRefresh((value) => value + 1)}>{t("shell.actions.retry")}</Button>}
    </div>}
  </section>;
}
