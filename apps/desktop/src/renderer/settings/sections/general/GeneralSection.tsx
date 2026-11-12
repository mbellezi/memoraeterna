import type { LanguageCode } from "@app/i18n";

import type { AppSettingsUpdate, ThemeMode } from "../../../../shared/ipc";
import type { SettingEntryV2 } from "../../../../shared/settings-registry";
import { ToggleGroup, ToggleGroupItem } from "../../../components/ui/toggle-group";
import { InlineAction } from "../../InlineAction";
import { RegistryRow } from "../../SettingRow";
import { useSettings } from "../../settings-context";
import { labelOf } from "../../settings-model";
import { requestSettingsTarget } from "../../settings-target";
import {
  isLanguageCode,
  isThemeMode,
  languageName,
  languageOptions,
  themeModes
} from "./general-model";
import { RegistrySection, type EntryRow } from "./registry-section";
import { SettingSelect, useSavedChoice } from "./setting-controls";

const saveApp = (update: AppSettingsUpdate) => window.app.settings.updateApp(update);

/** The line a failed save leaves in its row: one plain sentence, nothing was changed. */
export function SaveFailedNote({ failed }: { failed: boolean }) {
  const { t } = useSettings();
  return failed ? (
    <span role="status" className="block text-secondary-foreground">
      {t("settingsGeneral.saveFailed")}
    </span>
  ) : null;
}

function ThemeRow({ entry }: { entry: SettingEntryV2 }) {
  const { t, describe } = useSettings();
  const choice = useSavedChoice<ThemeMode>("themeMode", (themeMode) => saveApp({ themeMode }));
  const label = (mode: ThemeMode) => t(`settingsGeneral.theme.${mode}`);
  const value = isThemeMode(choice.value) ? choice.value : "system";
  const fallback = describe(entry.id)?.default;
  return (
    <RegistryRow
      entry={entry}
      defaultLabel={label(isThemeMode(fallback) ? fallback : "system")}
      note={<SaveFailedNote failed={choice.state === "failed"} />}
      control={
        <ToggleGroup label={labelOf(t, entry)} value={value} onValueChange={choice.save}>
          {themeModes.map((mode) => (
            <ToggleGroupItem key={mode} value={mode}>
              {label(mode)}
            </ToggleGroupItem>
          ))}
        </ToggleGroup>
      }
    />
  );
}

/** A language select: the app's, or the one the notes are written in. Both default to macOS's. */
function LanguageRow({ entry, afterChange }: { entry: SettingEntryV2; afterChange?: boolean }) {
  const { t, describe } = useSettings();
  const key = entry.id === "language" ? "language" : "contentLanguage";
  const choice = useSavedChoice<LanguageCode>(entry.id, (code) => saveApp({ [key]: code }));
  const description = describe(entry.id);
  const value = isLanguageCode(choice.value) ? choice.value : "en";
  const fallback = description?.default;
  const defaultLabel = isLanguageCode(fallback)
    ? t("settingsGeneral.language.defaultOs", { values: { language: languageName(fallback) } })
    : undefined;
  return (
    <RegistryRow
      entry={entry}
      {...(defaultLabel !== undefined ? { defaultLabel } : {})}
      note={
        <>
          <SaveFailedNote failed={choice.state === "failed"} />
          {afterChange && description?.changed ? <ConnectionsNote /> : null}
        </>
      }
      control={
        <SettingSelect
          label={labelOf(t, entry)}
          value={value}
          options={languageOptions()}
          onChange={choice.save}
        />
      }
    />
  );
}

/** Notes already written keep their language: where to have the connection descriptions redone. */
function ConnectionsNote() {
  const { t } = useSettings();
  const where = `${t("settingsShell.sections.knowledge.name")} › ${t("settingsRegistry.groups.knowledge.connections")}`;
  return (
    <span className="block">
      {t("settingsGeneral.language.connectionsNote")}{" "}
      <InlineAction
        size="xs"
        onClick={() => requestSettingsTarget({ section: "knowledge", setting: "relationLabels" })}
      >
        {where}
      </InlineAction>
      .
    </span>
  );
}

const rows: Readonly<Record<string, EntryRow>> = {
  themeMode: ThemeRow,
  contentLanguage: ({ entry }) => <LanguageRow entry={entry} afterChange />,
  language: LanguageRow
};

/**
 * General and appearance (design record 7.6, docs/f5-decisions.md D17): the theme, the notes'
 * language (one control, defaulting to the macOS language) and the app's language, drawn from the
 * registry. There is no density, "open in" or reduced-motion row: they are not settings in F5 (S13).
 */
export function GeneralSection() {
  return <RegistrySection rows={rows} />;
}

export const section = { id: "general", Section: GeneralSection } as const;
