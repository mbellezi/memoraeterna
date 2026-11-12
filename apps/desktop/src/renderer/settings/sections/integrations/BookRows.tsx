import { useState } from "react";
import { KeyRound } from "lucide-react";

import type { SettingEntryV2 } from "../../../../shared/settings-registry";
import { bookLookupPatch } from "../../../components/settings/merged-controls";
import { Button } from "../../../components/ui/button";
import { Input } from "../../../components/ui/input";
import { SelectControl, StatusLine } from "../../SettingControls";
import { RegistryRow } from "../../SettingRow";
import { useSettings } from "../../settings-context";
import { labelOf } from "../../settings-model";
import { settingsStoreOf } from "../../settings-store";
import {
  bookLookupModes,
  bookModeLabel,
  bookModeOfValue,
  type BookLookupMode
} from "./integrations-model";

/**
 * The online book lookup: off, or which service is asked. "Off" keeps the service chosen before, so
 * turning it on again asks the same one; nothing is asked of the internet while it is off.
 */
export function BookLookupRow({ entry }: { entry: SettingEntryV2 }) {
  const settings = useSettings();
  const { t } = settings;
  const [choice, setChoice] = useState<BookLookupMode | null>(null);
  const [failed, setFailed] = useState(false);
  const stored = bookModeOfValue(settings.describe(entry.id)?.value);
  const defaultMode = bookModeOfValue(settings.describe(entry.id)?.default);

  const pick = async (mode: BookLookupMode) => {
    setChoice(mode);
    setFailed(false);
    try {
      await window.app.settings.updateApp(bookLookupPatch(mode));
    } catch {
      setFailed(true);
    } finally {
      setChoice(null);
    }
  };

  return (
    <RegistryRow
      entry={entry}
      defaultLabel={t(bookModeLabel[defaultMode])}
      control={
        <SelectControl<BookLookupMode>
          label={labelOf(t, entry)}
          value={choice ?? stored}
          disabled={settings.describe(entry.id) === undefined || choice !== null}
          onChange={(mode) => void pick(mode)}
          options={bookLookupModes.map((value) => ({ value, label: t(bookModeLabel[value]) }))}
        />
      }
      note={
        failed ? (
          <StatusLine tone="warn" role="status">
            {t("settingsIntegrations.books.saveFailed")}
          </StatusLine>
        ) : undefined
      }
    />
  );
}

/**
 * The Google Books key: set or not, never shown again. "Save key…" opens a field in the row; the
 * key goes to main and is kept encrypted on this Mac. Removing it is the row's own "Restore
 * default", which asks first because the person would have to type it again.
 */
export function GoogleBooksKeyRow({ entry }: { entry: SettingEntryV2 }) {
  const settings = useSettings();
  const { t } = settings;
  const description = settings.describe(entry.id);
  const configured = description?.value === true;
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);

  const save = async () => {
    const apiKey = draft.trim();
    if (apiKey === "") return;
    setBusy(true);
    setFailed(false);
    try {
      await window.app.settings.updateGoogleBooksKey({ apiKey });
      // Saving a key announces nothing on the bus, so the marker and the way back are read now.
      settingsStoreOf(window.app).load();
      setDraft("");
      setEditing(false);
    } catch {
      setFailed(true);
    } finally {
      setBusy(false);
    }
  };

  return (
    <RegistryRow
      entry={entry}
      defaultLabel={t("settingsIntegrations.books.keyNone")}
      control={
        <Button
          aria-expanded={editing}
          disabled={description === undefined}
          onClick={() => {
            setEditing(!editing);
            setDraft("");
            setFailed(false);
          }}
        >
          <KeyRound aria-hidden="true" />
          {t(
            configured
              ? "settingsIntegrations.books.keyReplace"
              : "settingsIntegrations.books.keySave"
          )}
        </Button>
      }
      note={
        <div className="grid gap-2">
          <StatusLine tone={configured ? "ok" : "idle"}>
            {t(
              configured
                ? "settingsIntegrations.books.keySaved"
                : "settingsIntegrations.books.keyNone"
            )}
          </StatusLine>
          {editing ? (
            <form
              className="flex max-w-[34rem] flex-wrap items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                void save();
              }}
            >
              <Input
                type="password"
                autoComplete="off"
                spellCheck={false}
                autoFocus
                aria-label={labelOf(t, entry)}
                value={draft}
                onChange={(event) => setDraft(event.target.value)}
                className="max-w-72 flex-1 basis-48"
              />
              <Button type="submit" variant="primary" disabled={busy || draft.trim() === ""}>
                {t("settingsIntegrations.books.keyConfirm")}
              </Button>
              <Button variant="ghost" disabled={busy} onClick={() => setEditing(false)}>
                {t("shell.actions.cancel")}
              </Button>
            </form>
          ) : null}
          {failed ? (
            <StatusLine tone="warn" role="status">
              {t("settingsIntegrations.books.keyFailed")}
            </StatusLine>
          ) : null}
        </div>
      }
    />
  );
}
