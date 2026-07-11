import { useState } from "react";
import { ArchiveRestore } from "lucide-react";

import type { MessageKey } from "@app/i18n";
import { Button } from "./ui/button";

export function BackupView({ t }: { t: (key: MessageKey) => string }) {
  const [status, setStatus] = useState<MessageKey>("shell.states.ready");
  const [path, setPath] = useState("");

  async function createBackup() {
    setStatus("shell.states.loading");
    try {
      const result = await window.app.backup.create();
      if (!result) {
        setStatus("shell.actions.cancel");
        return;
      }
      setPath(result.path);
      setStatus("backup.completed");
    } catch {
      setStatus("backup.failed");
    }
  }

  return (
    <section className="grid gap-4 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm dark:border-slate-800 dark:bg-slate-950">
      <div className="flex items-center gap-3"><span className="grid h-10 w-10 place-items-center rounded-xl bg-cyan-100 text-cyan-800 dark:bg-cyan-950 dark:text-cyan-200"><ArchiveRestore className="h-5 w-5" aria-hidden="true" /></span><h2 className="font-semibold">{t("backup.title")}</h2></div>
      <p className="text-sm text-slate-600 dark:text-slate-300">{t("backup.description")}</p>
      <div className="flex justify-end"><Button type="button" onClick={() => void createBackup()}>{t("backup.action")}</Button></div>
      <p className="break-all text-sm text-slate-600 dark:text-slate-300" role="status">{t(status)}{path ? ` ${path}` : ""}</p>
    </section>
  );
}
