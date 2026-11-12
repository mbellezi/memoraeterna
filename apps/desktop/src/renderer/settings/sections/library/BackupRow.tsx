import { useState, type ReactNode } from "react";

import type { BackupResult } from "../../../../shared/ipc";
import type { SettingEntryV2 } from "../../../../shared/settings-registry";
import { Button } from "../../../components/ui/button";
import { RunningRing, SolidCheck, SolidTriangle } from "../../../components/ui/solid-glyphs";
import { RegistryRow } from "../../SettingRow";
import { useSettings } from "../../settings-context";
import { backupFailureKey } from "./library-model";

type Backup =
  | { state: "idle" }
  | { state: "running" }
  | { state: "done"; result: BackupResult }
  | { state: "failed"; key: ReturnType<typeof backupFailureKey> };

/**
 * A backup, made on request: the button opens main's folder choice, copies the database, checks the
 * copy with a test restore and copies the stored files into a dated folder. Cancelling the folder
 * choice changes nothing. The line under the help says what the last try did, with the word and the
 * glyph (a ring while it runs, a check when it ended, a triangle when it failed), never a pop-up.
 * Nothing records when the last backup ran, so before the first press the row says nothing about one.
 */
export function BackupRow({ entry }: { entry: SettingEntryV2 }) {
  const { t } = useSettings();
  const [backup, setBackup] = useState<Backup>({ state: "idle" });

  const run = async () => {
    setBackup({ state: "running" });
    try {
      const result = await window.app.backup.create();
      setBackup(result ? { state: "done", result } : { state: "idle" });
    } catch (error) {
      setBackup({ state: "failed", key: backupFailureKey(error) });
    }
  };

  const line = (glyph: ReactNode, text: string, tone = "text-foreground") => (
    <p role="status" className={`m-0 flex items-start gap-1.5 ${tone}`}>
      <span className="mt-0.5 flex">{glyph}</span>
      <span className="min-w-0 [overflow-wrap:anywhere]">{text}</span>
    </p>
  );
  const note =
    backup.state === "running" ? (
      line(<RunningRing className="mt-0.5" />, t("settingsLibrary.backup.running"))
    ) : backup.state === "done" ? (
      <div className="grid gap-1">
        {line(
          <SolidCheck className="size-3.5 text-success" />,
          backup.result.verified
            ? `${t("settingsLibrary.backup.done")} ${t("settingsLibrary.backup.verified")}`
            : t("settingsLibrary.backup.done")
        )}
        <p className="m-0 text-muted-foreground [overflow-wrap:anywhere]">
          {t("settingsLibrary.backup.savedIn", { values: { path: backup.result.path } })}
        </p>
      </div>
    ) : backup.state === "failed" ? (
      line(<SolidTriangle className="size-3.5 text-danger" />, t(backup.key))
    ) : undefined;

  return (
    <RegistryRow
      entry={entry}
      note={note}
      control={
        <Button disabled={backup.state === "running"} onClick={() => void run()}>
          {t("settingsLibrary.backup.action")}
        </Button>
      }
    />
  );
}
