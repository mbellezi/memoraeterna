import { useEffect, useState } from "react";
import { RefreshCw } from "lucide-react";
import type { MessageKey } from "@app/i18n";
import type { ObsidianSyncStatus } from "../../shared/ipc";
import { Button } from "./ui/button";

interface ObsidianSyncStatusCardProps {
  available: boolean;
  t: (key: MessageKey) => string;
  showAction?: boolean;
}

export function ObsidianSyncStatusCard({ available, t, showAction = false }: ObsidianSyncStatusCardProps) {
  const [status, setStatus] = useState<ObsidianSyncStatus | null>(null);

  async function refresh() {
    setStatus(await window.app.obsidian.getSyncStatus());
  }

  async function start() {
    setStatus(await window.app.obsidian.startSync());
  }

  useEffect(() => {
    void refresh();
    const interval = window.setInterval(() => void refresh(), 750);
    return () => window.clearInterval(interval);
  }, []);

  const progress = status?.progress ?? 0;
  const stateKey = `obsidianSync.states.${status?.state ?? "idle"}` as MessageKey;
  const stageKey = `obsidianSync.stages.${status?.stage ?? "idle"}` as MessageKey;

  return (
    <section className="grid gap-4 rounded-xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="font-semibold text-slate-950 dark:text-slate-50">{t("obsidianSync.title")}</h2>
          <p className="mt-1 max-w-3xl text-sm text-slate-600 dark:text-slate-300">{t("obsidianSync.description")}</p>
        </div>
        {showAction ? (
          <Button type="button" disabled={!available || status?.state === "running"} onClick={() => void start()}>
            <RefreshCw className={`h-4 w-4 ${status?.state === "running" ? "animate-spin" : ""}`} aria-hidden="true" />
            {t("obsidianSync.action")}
          </Button>
        ) : null}
      </div>

      {!available ? (
        <p className="text-sm text-amber-700 dark:text-amber-300">{t("obsidianSync.unavailable")}</p>
      ) : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span className="font-semibold text-slate-800 dark:text-slate-200">{t(stateKey)} · {t(stageKey)}</span>
            <span className="tabular-nums text-slate-500">{Math.round(progress * 100)}%</span>
          </div>
          <div className="h-2 overflow-hidden rounded-full bg-slate-200 dark:bg-slate-800" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(progress * 100)}>
            <div className="h-full rounded-full bg-cyan-500 transition-[width]" style={{ width: `${progress * 100}%` }} />
          </div>
          <div className="grid gap-2 text-xs text-slate-600 sm:grid-cols-4 dark:text-slate-300">
            <span>{t("obsidianSync.processed")}: {status?.processed ?? 0}/{status?.total ?? 0}</span>
            <span>{t("obsidianSync.synced")}: {status?.synced ?? 0}</span>
            <span>{t("obsidianSync.projected")}: {status?.projected ?? 0}</span>
            <span>{t("obsidianSync.conflicts")}: {status?.conflicts ?? 0}</span>
          </div>
          {status?.error ? <p className="text-sm text-red-700 dark:text-red-300">{status.error}</p> : null}
        </>
      )}
    </section>
  );
}
