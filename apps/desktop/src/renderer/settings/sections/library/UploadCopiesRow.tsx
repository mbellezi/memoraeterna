import { useId, useState } from "react";
import { FolderClosed } from "lucide-react";

import type { StorageSettings } from "../../../../shared/ipc";
import type { SettingEntryV2 } from "../../../../shared/settings-registry";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { settingsTouch } from "../../../lib/status-followers";
import { InlineAction } from "../../InlineAction";
import { RegistryRow } from "../../SettingRow";
import { useSettings } from "../../settings-context";
import { labelOf } from "../../settings-model";
import { SettingSwitch } from "../general/setting-controls";
import { useSectionRead } from "../general/use-section-read";
import { copiesUpdate, isAbsolutePath, type CopiesAction } from "./library-model";

type Problem = "path" | "save" | "needsFolder" | null;

/**
 * The copy of every uploaded file in a folder of the person's own, as one control: a switch with its
 * word, the folder it writes to (its path as typed, a path is the person's own text and wraps rather
 * than being cut) and a way to change it. The folder is typed or pasted: main has no picker for it
 * yet, and checks the path again before it saves. Turning the copy on without a folder asks for the
 * folder first; turning it off keeps the folder. A save that fails leaves everything as it was and
 * says so in one line. Restoring the default turns the copy off and forgets the folder (the registry's
 * `upload-copies` reset).
 */
export function UploadCopiesRow({ entry }: { entry: SettingEntryV2 }) {
  const { t } = useSettings();
  const { state, retry, set } = useSectionRead(
    () => window.app.settings.get(),
    [{ type: "settings.changed", when: settingsTouch("storage") }]
  );
  const [editing, setEditing] = useState<{ thenOn: boolean } | null>(null);
  const [draft, setDraft] = useState("");
  const [problem, setProblem] = useState<Problem>(null);
  const [saving, setSaving] = useState(false);
  const inputId = useId();

  const stored: StorageSettings | null = state.status === "ready" ? state.value : null;
  const copies = {
    enabled: stored?.uploadCopiesEnabled ?? false,
    folder: stored?.uploadCopiesFolderPath ?? null
  };

  const apply = async (action: CopiesAction) => {
    const next = copiesUpdate(copies, action);
    if ("needsFolder" in next) {
      setDraft("");
      setEditing({ thenOn: true });
      setProblem("needsFolder");
      return;
    }
    setSaving(true);
    setProblem(null);
    try {
      set(await window.app.settings.update(next.update));
      setEditing(null);
    } catch {
      setProblem("save");
    } finally {
      setSaving(false);
    }
  };

  const startEditing = () => {
    setDraft(copies.folder ?? "");
    setEditing({ thenOn: false });
    setProblem(null);
  };
  const submit = () => {
    if (!isAbsolutePath(draft)) {
      setProblem("path");
      return;
    }
    void apply({ kind: "folder", path: draft, thenOn: editing?.thenOn === true });
  };

  const problemText: Record<Exclude<Problem, null>, string> = {
    path: t("settingsLibrary.uploads.pathRejected"),
    save: t("settingsLibrary.uploads.saveFailed"),
    needsFolder: t("settingsLibrary.uploads.needsFolder")
  };

  const note = (
    <div className="grid gap-2">
      {state.status === "error" ? (
        <p role="status" className="m-0 flex flex-wrap items-baseline gap-x-2">
          <span>{t("settingsLibrary.uploads.readFailed")}</span>
          <InlineAction size="xs" onClick={retry}>
            {t("shell.actions.retry")}
          </InlineAction>
        </p>
      ) : editing !== null ? (
        <div className="grid max-w-[27.5rem] gap-2">
          <label htmlFor={inputId} className="font-medium text-foreground">
            {t("settingsLibrary.uploads.pathLabel")}
          </label>
          <Input
            id={inputId}
            value={draft}
            autoFocus
            spellCheck={false}
            autoComplete="off"
            aria-invalid={problem === "path"}
            aria-describedby={`${inputId}-hint`}
            className="font-mono"
            onChange={(event) => {
              setDraft(event.target.value);
              if (problem === "path") setProblem(null);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                submit();
              } else if (event.key === "Escape") {
                event.stopPropagation();
                setEditing(null);
                setProblem(null);
              }
            }}
          />
          <p id={`${inputId}-hint`} className="m-0 text-muted-foreground">
            {t("settingsLibrary.uploads.pathHint")}
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="primary" disabled={saving} onClick={submit}>
              {t("shell.actions.save")}
            </Button>
            <Button
              variant="ghost"
              disabled={saving}
              onClick={() => {
                setEditing(null);
                setProblem(null);
              }}
            >
              {t("shell.actions.cancel")}
            </Button>
          </div>
        </div>
      ) : (
        <p className="m-0 flex flex-wrap items-baseline gap-x-2 gap-y-1">
          <FolderClosed
            aria-hidden="true"
            className="size-3.5 shrink-0 translate-y-0.5 text-muted-foreground"
          />
          {copies.folder ? (
            <span className="min-w-0 font-mono text-foreground [overflow-wrap:anywhere]">
              {copies.folder}
            </span>
          ) : (
            <span>{t("settingsLibrary.uploads.noFolder")}</span>
          )}
          <InlineAction size="xs" onClick={startEditing}>
            {copies.folder
              ? t("settingsLibrary.uploads.change")
              : t("settingsLibrary.uploads.choose")}
          </InlineAction>
        </p>
      )}
      {problem !== null ? (
        <p role="status" className="m-0 text-foreground">
          {problemText[problem]}
        </p>
      ) : null}
      {editing === null && !copies.enabled && copies.folder ? (
        <p className="m-0 text-muted-foreground">{t("settingsLibrary.uploads.willReceive")}</p>
      ) : null}
    </div>
  );

  return (
    <RegistryRow
      entry={entry}
      defaultLabel={t("settingsLibrary.uploads.off")}
      note={state.status === "loading" ? undefined : note}
      control={
        <SettingSwitch
          label={labelOf(t, entry)}
          checked={copies.enabled}
          onLabel={t("settingsLibrary.uploads.on")}
          offLabel={t("settingsLibrary.uploads.off")}
          disabled={stored === null || saving}
          onChange={(on) => void apply({ kind: "switch", on })}
        />
      }
    />
  );
}
