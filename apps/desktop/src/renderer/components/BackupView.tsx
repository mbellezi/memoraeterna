import { useState } from "react";
import { ArchiveRestore, Check } from "lucide-react";

import type { MessageKey } from "@app/i18n";
import { Button } from "./ui/button";

/** The localized reason a backup failed: a main-process error key when it sent one. */
export function backupFailureKey(error: unknown): MessageKey {
  const match =
    error instanceof Error ? error.message.match(/errors\.backup\.[a-zA-Z0-9_]+/) : null;
  return (match?.[0] as MessageKey | undefined) ?? "backup.failed";
}

export function BackupView({ t }: { t: (key: MessageKey) => string }) {
  const [status, setStatus] = useState<MessageKey>("shell.states.ready");
  const [path, setPath] = useState("");
  const [verified, setVerified] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  async function createBackup() {
    setBusy(true);
    setFailed(false);
    setVerified(false);
    setPath("");
    setStatus("shell.states.loading");
    try {
      const result = await window.app.backup.create();
      if (!result) {
        setStatus("shell.actions.cancel");
        return;
      }
      setPath(result.path);
      setVerified(result.verified);
      setStatus("backup.completed");
    } catch (error) {
      setFailed(true);
      setStatus(backupFailureKey(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="grid gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="flex items-center gap-3">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-cyan-100 text-cyan-800 dark:bg-cyan-950 dark:text-cyan-200">
          <ArchiveRestore className="h-5 w-5" aria-hidden="true" />
        </span>
        <h2 className="font-semibold">{t("backup.title")}</h2>
      </div>
      <p className="text-sm text-slate-600 dark:text-slate-300">{t("backup.description")}</p>
      <div className="flex justify-end">
        <Button type="button" disabled={busy} onClick={() => void createBackup()}>
          {t("backup.action")}
        </Button>
      </div>
      <BackupOutcome t={t} status={status} path={path} verified={verified} failed={failed} />
    </section>
  );
}

/** What the last backup attempt did: running, failed, cancelled or finished (verified or not). */
export function BackupOutcome({
  t,
  status,
  path,
  verified,
  failed
}: {
  t: (key: MessageKey) => string;
  status: MessageKey;
  path: string;
  verified: boolean;
  failed: boolean;
}) {
  return (
    <>
      <p
        className={`break-all text-sm ${failed ? "text-danger" : "text-slate-600 dark:text-slate-300"}`}
        role={failed ? "alert" : "status"}
      >
        {t(status)}
        {path ? ` ${path}` : ""}
      </p>
      {verified ? (
        <p className="inline-flex items-center gap-1 text-xs font-medium text-success">
          <Check className="size-3" aria-hidden="true" />
          {t("backup.verified")}
        </p>
      ) : null}
    </>
  );
}
