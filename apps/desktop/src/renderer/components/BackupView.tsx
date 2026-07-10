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
    <section className="grid gap-4 rounded-md border border-slate-200 p-5 dark:border-slate-800">
      <div className="flex items-center gap-2"><ArchiveRestore className="h-5 w-5 text-cyan-700 dark:text-cyan-300" aria-hidden="true" /><h2 className="text-lg font-semibold">{t("backup.title")}</h2></div>
      <p className="text-sm text-slate-600 dark:text-slate-300">{t("backup.description")}</p>
      <div className="flex justify-end"><Button type="button" onClick={() => void createBackup()}>{t("backup.action")}</Button></div>
      <p className="break-all text-sm text-slate-600 dark:text-slate-300" role="status">{t(status)}{path ? ` ${path}` : ""}</p>
    </section>
  );
}
